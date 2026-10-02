/**
 * T15(결정 D27) YouTube 모의 채널 — 프로세스 안 시뮬레이터 + ChannelAdapter. **네트워크·실제 Google/YouTube 호출 없음.**
 *
 * YouTubeMockApi(시뮬레이터): docs/03 의 YouTube 업로드 흐름(videos.insert 재개 업로드 protocol)을 흉내 낸다.
 * - initResumable(메타데이터·크기·형식) → 세션 URI `mock://youtube/upload/<uuid>`(24시간 모의 만료) · putChunk(offset, bytes) → 308(받은 바이트) 또는
 *   마지막 조각에서 201(영상 ID `mockyt_v_<uuid>`) · queryOffset(끊긴 뒤 이어 올리기, A14) · getVideo(uploadStatus uploaded → processed|failed|rejected,
 *   privacyStatus, publishAt).
 * - **미검증 API 프로젝트**(projectVerified=false, 기본): public·unlisted 요청은 private 로 강제되고 publishAt 은 버려진다(docs/03 — 공개 제한).
 *   영상에는 요청한 공개 범위와 실제 공개 범위를 함께 남긴다(A12).
 * - 할당량(사용자별, 업로드 1회 = 1600 단위 — 잠정): 모자라면 403 quotaExceeded + 초기화 시각.
 * - 오류: 401 auth_invalid_token · 403 forbidden · 403 quota_exceeded · 400 invalid_metadata · 404 not_found(세션·영상 모름) · 404 session_expired ·
 *   409 offset_mismatch · 5xx server_error(side_effect none|unknown) · timeout · network_drop(조각 일부만 받은 뒤 끊김).
 * - 토큰은 T13/T15 모의 OAuth 저장소의 Google 형 access token(`mockyt_at_`, 해제·만료 아님, 같은 사용자)만 받는다. 토큰·세션 URI 는 오류 메시지·
 *   호출 기록에 남기지 않는다.
 *
 * YouTubeMockChannelAdapter(adapter id 'mock_youtube'): 선택 규칙은 @cs/domain adapterIdFor(모의 + youtube + credential_state ≠ none).
 * - VERIFIED 영상 파일을 저장소에서 **조각(기본 8MiB)씩** 읽어 올린다(파일 전체를 메모리에 올리지 않음). 세션 URI 는 첫 조각 전에, 받은 바이트는
 *   조각마다 remote_steps 에 기록한다(작업 처리기의 짧은 트랜잭션 — 원격 호출 동안 DB 잠금 없음). 조각마다 heartbeat·취소 확인.
 * - 끊김·시간 초과 → 결과 불명(RECONCILING) → 조회가 같은 세션의 받은 바이트를 묻고 `resumable` → 다음 시도가 **같은 세션**으로 이어 올린다(A14).
 *   유효한 세션이 있는 동안 새 세션을 만들지 않는다. 만료된 세션(영상 없음이 확실) → 확실히 없음 → 다음 시도가 새 세션. 세션을 모름 → 확인 불가.
 * - 마지막 조각 뒤: 영상 ID 를 단계로 기록 → processing(REMOTE_PROCESSING) → 조회가 처리 끝을 확인하면 CONFIRMED + 결과 종류
 *   UPLOADED_PRIVATE(비공개) / SCHEDULED_REMOTE(비공개 + publishAt) / PUBLISHED(검증된 프로젝트의 public·unlisted 만). failed·rejected → FAILED.
 * - 결과는 모의(MOCK): publication external_id = 'mock:youtube:<영상 ID>', permalink = 'mock://youtube/watch/<영상 ID>'.
 */
import { createHash, randomUUID, type Hash } from 'node:crypto';
import {
  cpLength,
  isYouTubeMockScenario,
  LeaseLostError,
  providerMetadataOf,
  YOUTUBE_DESCRIPTION_MAX,
  YOUTUBE_MAX_TAGS,
  YOUTUBE_TITLE_MAX,
  type AdapterAccount,
  type AdapterCapabilities,
  type AdapterContext,
  type AdapterResult,
  type CancelResult,
  type ChannelAdapter,
  type ChannelRateLimit,
  type MediaFile,
  type MockScenarioValue,
  type PreparedSubmission,
  type PublishSnapshot,
  type ReconcileResult,
  type RemoteReference,
  type RemoteStep,
  type RemoteVisibility,
  type ResultKind,
} from '@cs/domain';
import { mockOAuthStore, type MockOAuthStore } from './oauth';

// ---- 시뮬레이터 ----

export const YOUTUBE_MOCK_SESSION_PREFIX = 'mock://youtube/upload/';
export const YOUTUBE_MOCK_VIDEO_PREFIX = 'mockyt_v_';
/** 모의 세션 만료(실제 값은 live 전에 공식 문서로 확인). */
export const YOUTUBE_MOCK_SESSION_TTL_MS = 24 * 3600_000;
/** 잠정: videos.insert 1회의 할당량 단위·하루 기본 할당량(공식 수치를 사실로 고정하지 않는다 — D19-d, D27). */
export const YOUTUBE_UPLOAD_QUOTA_UNITS = 1600;
export const YOUTUBE_DAILY_QUOTA_UNITS = 10_000;
/** D15: 영상 업로드 한도 2GB(앱 규칙 — YouTube 자체 한도가 아니다). */
export const YOUTUBE_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export const YOUTUBE_ERROR_KINDS = [
  'auth_invalid_token',
  'forbidden',
  'quota_exceeded',
  'invalid_metadata',
  'not_found',
  'session_expired',
  'offset_mismatch',
  'server_error',
  'timeout',
  'network_drop',
] as const;
export type YouTubeErrorKind = (typeof YOUTUBE_ERROR_KINDS)[number];
export const YOUTUBE_ERROR_HTTP: Record<YouTubeErrorKind, number | null> = {
  auth_invalid_token: 401,
  forbidden: 403,
  quota_exceeded: 403,
  invalid_metadata: 400,
  not_found: 404,
  session_expired: 404,
  offset_mismatch: 409,
  server_error: 503,
  timeout: null,
  network_drop: null,
};

export type YouTubeOp = 'initResumable' | 'putChunk' | 'queryOffset' | 'getVideo';
export type YouTubePrivacy = 'private' | 'unlisted' | 'public';
export type YouTubeUploadStatus = 'uploaded' | 'processed' | 'failed' | 'rejected';

/** 시뮬레이터 오류 — 메시지는 종류·코드만(토큰·세션 URI·본문 없음). */
export class YouTubeMockApiError extends Error {
  readonly httpStatus: number | null;
  constructor(
    readonly kind: YouTubeErrorKind,
    readonly opts: { code?: string; sideEffect?: 'none' | 'unknown'; resetAt?: string; received?: number } = {},
  ) {
    super(`mock youtube api error: ${kind}${opts.code ? ` (${opts.code})` : ''}`);
    this.name = 'YouTubeMockApiError';
    this.httpStatus = YOUTUBE_ERROR_HTTP[kind];
  }
  get code(): string {
    return this.opts.code ?? this.kind;
  }
  get sideEffect(): 'none' | 'unknown' {
    if (this.kind === 'timeout' || this.kind === 'network_drop') return 'unknown';
    return this.opts.sideEffect ?? 'none';
  }
}

/**
 * 한 번 일어나는 장애. applied = 원격은 동작을 끝낸 뒤 응답이 실패(응답 유실). network_drop 은 putChunk 에서 받은 조각 중 partialBytes 만 받고 끊긴다.
 * expireSession = 이 putChunk 직전에 세션이 만료된다(만료 시험).
 */
export interface YouTubeFault {
  op: YouTubeOp;
  kind: YouTubeErrorKind;
  applied?: boolean;
  sideEffect?: 'none' | 'unknown';
  code?: string;
  partialBytes?: number;
  resetAt?: string;
  expireSession?: boolean;
}

export interface YouTubeVideoMetadata {
  title: string;
  description: string;
  tags: string[];
  privacyStatus: YouTubePrivacy;
  publishAt?: string | null;
}

interface Session {
  uri: string;
  userId: string;
  size: number;
  mime: string;
  metadata: YouTubeVideoMetadata;
  received: number;
  hash: Hash;
  expiresAt: number;
  state: 'active' | 'complete' | 'expired';
  videoId: string | null;
  projectVerified: boolean;
  processAfterPolls: number;
  outcome: 'processed' | 'failed' | 'rejected';
}

export interface YouTubeMockVideo {
  id: string;
  userId: string;
  sessionUri: string;
  requestedPrivacy: YouTubePrivacy;
  privacyStatus: YouTubePrivacy;
  /** 미검증 프로젝트 때문에 공개 범위가 private 로 강제됨 */
  forcedPrivate: boolean;
  requestedPublishAt: string | null;
  publishAt: string | null;
  uploadStatus: YouTubeUploadStatus;
  pollsLeft: number;
  outcome: 'processed' | 'failed' | 'rejected';
  bytes: number;
  sha256: string;
  title: string;
  createdAt: string;
}

const sha = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');

export type YouTubeTokenCheck = (accessToken: string, userId: string, now: Date) => boolean;

/** Google 형 모의 OAuth 공급자의 발급 access token 인지(해제·만료 아님, 같은 사용자). */
export function mockGoogleTokenCheck(store: MockOAuthStore = mockOAuthStore()): YouTubeTokenCheck {
  return (accessToken, userId, now) => {
    if (typeof accessToken !== 'string' || !accessToken.startsWith('mockyt_at_')) return false;
    const t = store.tokens.get(sha(accessToken));
    return !!t && t.provider === 'mock_google' && t.kind === 'access' && !t.revoked && t.expiresAt > now.getTime() && t.user === userId;
  };
}

export class YouTubeMockApi {
  private readonly sessions = new Map<string, Session>();
  private readonly videos = new Map<string, YouTubeMockVideo>();
  private readonly quotas = new Map<string, { remaining: number; resetAt: Date }>();
  private faults: YouTubeFault[] = [];
  private tokenCheck: YouTubeTokenCheck;
  /** 미검증 API 프로젝트가 기본(docs/03). 시험·개발 시나리오(youtube_project_verified·youtube_scheduled_private)만 세션별로 바꾼다. */
  projectVerified = false;
  sessionTtlMs = YOUTUBE_MOCK_SESSION_TTL_MS;
  /** 호출 수(시험 관찰 — 인수는 남기지 않는다) */
  readonly calls: Record<YouTubeOp, number> = { initResumable: 0, putChunk: 0, queryOffset: 0, getVideo: 0 };
  /** 보낸(요청에 실은) 바이트 합계 — 끊겨서 받지 못한 부분 포함. 받은 바이트 합계. */
  bytesSent = 0;
  bytesReceived = 0;

  constructor(opts: { tokenCheck?: YouTubeTokenCheck } = {}) {
    this.tokenCheck = opts.tokenCheck ?? mockGoogleTokenCheck();
  }

  setTokenCheck(check: YouTubeTokenCheck): void {
    this.tokenCheck = check;
  }

  /** 사용자별 남은 할당량(단위)과 초기화 시각. 없으면 무제한. */
  setQuota(userId: string, remaining: number, resetAt: Date): void {
    this.quotas.set(userId, { remaining, resetAt });
  }

  clearQuota(userId: string): void {
    this.quotas.delete(userId);
  }

  injectFault(f: YouTubeFault): void {
    this.faults.push({ ...f });
  }

  /** 세션을 만료시킨다(시험 — 끝나지 않은 세션만). */
  expireSession(uri: string): void {
    const s = this.sessions.get(uri);
    if (s && s.state === 'active') s.state = 'expired';
  }

  /** 전부 비운다("재시작" 흉내 — 이전 세션·영상을 모른다). 토큰 검사·프로젝트 검증 표시는 유지. */
  reset(): void {
    this.sessions.clear();
    this.videos.clear();
    this.quotas.clear();
    this.faults = [];
    this.bytesSent = 0;
    this.bytesReceived = 0;
    for (const k of Object.keys(this.calls) as YouTubeOp[]) this.calls[k] = 0;
  }

  sessionUris(userId?: string): string[] {
    return [...this.sessions.values()].filter((s) => !userId || s.userId === userId).map((s) => s.uri);
  }

  videosOf(userId?: string): YouTubeMockVideo[] {
    return [...this.videos.values()].filter((v) => !userId || v.userId === userId).map((v) => ({ ...v }));
  }

  private auth(accessToken: string, userId: string, now: Date): void {
    if (!this.tokenCheck(accessToken, userId, now)) throw new YouTubeMockApiError('auth_invalid_token');
  }

  private takeFault(op: YouTubeOp, given?: YouTubeFault | null): YouTubeFault | null {
    if (given && given.op === op) return given;
    const i = this.faults.findIndex((f) => f.op === op);
    if (i < 0) return null;
    return this.faults.splice(i, 1)[0]!;
  }

  private fail(f: YouTubeFault): never {
    throw new YouTubeMockApiError(f.kind, { code: f.code, sideEffect: f.sideEffect, resetAt: f.resetAt });
  }

  private ownSession(uri: string, userId: string, now: Date): Session {
    const s = this.sessions.get(uri);
    if (!s || s.userId !== userId) throw new YouTubeMockApiError('not_found', { code: 'session_not_found' });
    if (s.state === 'active' && s.expiresAt <= now.getTime()) s.state = 'expired';
    return s;
  }

  initResumable(
    req: { userId: string; accessToken: string; metadata: YouTubeVideoMetadata; size: number; mime: string; now?: Date },
    opts: { fault?: YouTubeFault | null; projectVerified?: boolean; processAfterPolls?: number; outcome?: 'processed' | 'failed' | 'rejected' } = {},
  ): { sessionUri: string; expiresAt: string } {
    this.calls.initResumable++;
    const now = req.now ?? new Date();
    this.auth(req.accessToken, req.userId, now);
    const f = this.takeFault('initResumable', opts.fault);
    if (f && !f.applied) this.fail(f);
    const m = req.metadata;
    if (typeof m.title !== 'string' || m.title.trim() === '' || cpLength(m.title) > YOUTUBE_TITLE_MAX) throw new YouTubeMockApiError('invalid_metadata', { code: 'invalid_title' });
    if (typeof m.description !== 'string' || cpLength(m.description) > YOUTUBE_DESCRIPTION_MAX) throw new YouTubeMockApiError('invalid_metadata', { code: 'invalid_description' });
    if (!Array.isArray(m.tags) || m.tags.length > YOUTUBE_MAX_TAGS) throw new YouTubeMockApiError('invalid_metadata', { code: 'invalid_tags' });
    if (!['private', 'unlisted', 'public'].includes(m.privacyStatus)) throw new YouTubeMockApiError('invalid_metadata', { code: 'invalid_privacy_status' });
    if (m.publishAt) {
      // publishAt 은 private 이면서 아직 공개된 적 없는 영상만, 과거 시각은 거부(docs/03 — 과거는 즉시 공개 효과).
      if (m.privacyStatus !== 'private') throw new YouTubeMockApiError('invalid_metadata', { code: 'publish_at_requires_private' });
      const at = Date.parse(m.publishAt);
      if (!Number.isFinite(at) || at <= now.getTime()) throw new YouTubeMockApiError('invalid_metadata', { code: 'publish_at_in_past' });
    }
    if (!Number.isSafeInteger(req.size) || req.size <= 0 || req.size > YOUTUBE_MAX_UPLOAD_BYTES) throw new YouTubeMockApiError('invalid_metadata', { code: 'invalid_size' });
    if (typeof req.mime !== 'string' || !req.mime.startsWith('video/')) throw new YouTubeMockApiError('invalid_metadata', { code: 'invalid_mime' });
    const q = this.quotas.get(req.userId);
    if (q && q.resetAt.getTime() <= now.getTime()) this.quotas.delete(req.userId);
    const quota = this.quotas.get(req.userId);
    if (quota && quota.remaining < YOUTUBE_UPLOAD_QUOTA_UNITS) {
      throw new YouTubeMockApiError('quota_exceeded', { code: 'quotaExceeded', resetAt: quota.resetAt.toISOString() });
    }
    if (quota) quota.remaining -= YOUTUBE_UPLOAD_QUOTA_UNITS;
    const s: Session = {
      uri: `${YOUTUBE_MOCK_SESSION_PREFIX}${randomUUID()}`,
      userId: req.userId,
      size: req.size,
      mime: req.mime,
      metadata: { title: m.title, description: m.description, tags: [...m.tags], privacyStatus: m.privacyStatus, publishAt: m.publishAt ?? null },
      received: 0,
      hash: createHash('sha256'),
      expiresAt: now.getTime() + this.sessionTtlMs,
      state: 'active',
      videoId: null,
      projectVerified: opts.projectVerified ?? this.projectVerified,
      processAfterPolls: Math.max(0, Math.floor(opts.processAfterPolls ?? 0)),
      outcome: opts.outcome ?? 'processed',
    };
    this.sessions.set(s.uri, s);
    const out = { sessionUri: s.uri, expiresAt: new Date(s.expiresAt).toISOString() };
    if (f) this.fail(f); // applied — 세션은 원격에 생겼지만 응답 유실
    return out;
  }

  private complete(s: Session, now: Date): string {
    const id = `${YOUTUBE_MOCK_VIDEO_PREFIX}${randomUUID()}`;
    const requested = s.metadata.privacyStatus;
    // 미검증 프로젝트: public·unlisted 는 private 로 강제, publishAt 은 버린다(공개 제한 — docs/03, A12)
    const forced = !s.projectVerified && requested !== 'private';
    const publishAt = s.projectVerified ? (s.metadata.publishAt ?? null) : null;
    this.videos.set(id, {
      id,
      userId: s.userId,
      sessionUri: s.uri,
      requestedPrivacy: requested,
      privacyStatus: forced ? 'private' : requested,
      forcedPrivate: forced || (!s.projectVerified && !!s.metadata.publishAt),
      requestedPublishAt: s.metadata.publishAt ?? null,
      publishAt,
      uploadStatus: 'uploaded',
      pollsLeft: s.processAfterPolls,
      outcome: s.outcome,
      bytes: s.received,
      sha256: s.hash.copy().digest('hex'),
      title: s.metadata.title,
      createdAt: now.toISOString(),
    });
    s.state = 'complete';
    s.videoId = id;
    return id;
  }

  /**
   * 조각 올리기. offset 은 원격이 받은 바이트와 같아야 한다(아니면 409 offset_mismatch — 받은 값을 함께 돌려준다).
   * 마지막 조각을 받으면 영상이 생기고 201. 끝난 세션에 다시 보내면 같은 영상(201, 새 영상 없음).
   */
  putChunk(
    req: { userId: string; accessToken: string; sessionUri: string; offset: number; bytes: Uint8Array; now?: Date },
    opts: { fault?: YouTubeFault | null } = {},
  ): { status: 308; received: number } | { status: 201; videoId: string; received: number } {
    this.calls.putChunk++;
    const now = req.now ?? new Date();
    this.auth(req.accessToken, req.userId, now);
    const f = this.takeFault('putChunk', opts.fault);
    const s = this.ownSession(req.sessionUri, req.userId, now);
    this.bytesSent += req.bytes.byteLength;
    if (f?.expireSession && s.state === 'active') s.state = 'expired';
    if (s.state === 'complete') return { status: 201, videoId: s.videoId!, received: s.received };
    if (s.state === 'expired') throw new YouTubeMockApiError('session_expired', { code: 'session_expired' });
    if (f && !f.applied && f.kind !== 'network_drop') this.fail(f);
    if (req.offset !== s.received) throw new YouTubeMockApiError('offset_mismatch', { received: s.received });
    if (req.bytes.byteLength === 0 || s.received + req.bytes.byteLength > s.size) throw new YouTubeMockApiError('invalid_metadata', { code: 'invalid_range' });
    if (f && f.kind === 'network_drop') {
      // 조각 앞부분만 받고 연결이 끊긴다(받은 만큼은 세션에 남는다 — 이어 올리기는 받은 바이트부터).
      const part = Math.max(0, Math.min(req.bytes.byteLength - 1, Math.floor(f.partialBytes ?? req.bytes.byteLength / 2)));
      if (part > 0) {
        s.hash.update(req.bytes.subarray(0, part));
        s.received += part;
        this.bytesReceived += part;
      }
      throw new YouTubeMockApiError('network_drop');
    }
    s.hash.update(req.bytes);
    s.received += req.bytes.byteLength;
    this.bytesReceived += req.bytes.byteLength;
    let out: { status: 308; received: number } | { status: 201; videoId: string; received: number };
    if (s.received === s.size) out = { status: 201, videoId: this.complete(s, now), received: s.received };
    else out = { status: 308, received: s.received };
    if (f) this.fail(f); // applied — 받았지만 응답 유실
    return out;
  }

  /** 끊긴 뒤 상태 묻기: 받은 바이트(끝났으면 영상 ID). 만료된 세션(영상 없음) → 404 session_expired, 모르는 세션 → 404 not_found. */
  queryOffset(req: { userId: string; accessToken: string; sessionUri: string; now?: Date }, opts: { fault?: YouTubeFault | null } = {}): { received: number; size: number; videoId: string | null } {
    this.calls.queryOffset++;
    const now = req.now ?? new Date();
    this.auth(req.accessToken, req.userId, now);
    const f = this.takeFault('queryOffset', opts.fault);
    if (f) this.fail(f);
    const s = this.ownSession(req.sessionUri, req.userId, now);
    if (s.state === 'expired') throw new YouTubeMockApiError('session_expired', { code: 'session_expired' });
    return { received: s.received, size: s.size, videoId: s.videoId };
  }

  /** 영상 상태. uploaded 는 남은 조회 수만큼 계속되고 그다음 processed(또는 failed·rejected). */
  getVideo(
    req: { userId: string; accessToken: string; videoId: string; now?: Date },
    opts: { fault?: YouTubeFault | null } = {},
  ): { id: string; uploadStatus: YouTubeUploadStatus; privacyStatus: YouTubePrivacy; publishAt: string | null; processingProgress: { partsTotal: number; partsProcessed: number }; rejectionReason: string | null } {
    this.calls.getVideo++;
    const now = req.now ?? new Date();
    this.auth(req.accessToken, req.userId, now);
    const f = this.takeFault('getVideo', opts.fault);
    if (f) this.fail(f);
    const v = this.videos.get(req.videoId);
    if (!v || v.userId !== req.userId) throw new YouTubeMockApiError('not_found', { code: 'video_not_found' });
    if (v.uploadStatus === 'uploaded') {
      if (v.pollsLeft > 0) v.pollsLeft--;
      else v.uploadStatus = v.outcome;
    }
    const total = 4;
    return {
      id: v.id,
      uploadStatus: v.uploadStatus,
      privacyStatus: v.privacyStatus,
      publishAt: v.publishAt,
      processingProgress: { partsTotal: total, partsProcessed: v.uploadStatus === 'uploaded' ? Math.max(0, total - 1 - v.pollsLeft) : total },
      rejectionReason: v.uploadStatus === 'rejected' ? 'mock_rejected' : null,
    };
  }
}

const globalForYouTube = globalThis as typeof globalThis & { __contentStudioYouTubeMockApi?: YouTubeMockApi };

/** 프로세스당 하나(web 과 inline worker 가 같은 모의 YouTube 를 본다). */
export function youtubeMockApi(): YouTubeMockApi {
  if (!globalForYouTube.__contentStudioYouTubeMockApi) globalForYouTube.__contentStudioYouTubeMockApi = new YouTubeMockApi();
  return globalForYouTube.__contentStudioYouTubeMockApi;
}

export function resetYouTubeMockApi(): void {
  globalForYouTube.__contentStudioYouTubeMockApi = undefined;
}

// ---- 어댑터 ----

export const YOUTUBE_ADAPTER_ID = 'mock_youtube' as const;
/** 기본 조각 크기 8MiB(D15 업로드와 같은 값, 256KiB 배수 — 실제 protocol 의 조각 단위 규칙은 live 전에 확인). 시험은 작게 바꾼다. */
export const YOUTUBE_DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * 잠정 로컬 할당량: 24시간에 업로드 시작 6회(= 10,000 ÷ 1,600 단위, 잠정). 확인일·API 버전 없음. 실제 할당량은 프로젝트마다 다르고
 * 하루 단위로 초기화된다 — 공식 자료로 재확인 전까지 사실로 고정하지 않는다(D19-d, D27).
 */
export const YOUTUBE_PROVISIONAL_RATE_LIMIT: ChannelRateLimit = {
  max_units: Math.floor(YOUTUBE_DAILY_QUOTA_UNITS / YOUTUBE_UPLOAD_QUOTA_UNITS),
  window_sec: 24 * 3600,
  checked_at: null,
  api_version: null,
  source: 'provisional — videos.insert 할당량(10,000 단위/일 ÷ 1,600 단위/업로드) 추정, 공식 자료 재확인 필요(D19-d, D27)',
};

export interface YouTubeAdapterOptions {
  api?: YouTubeMockApi;
  chunkBytes?: number;
  rateLimit?: ChannelRateLimit;
}

function abortError(): Error {
  const e = new Error('mock youtube submit aborted');
  e.name = 'AbortError';
  return e;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface YouTubeText {
  title: string;
  description: string;
  tags: string[];
}

/** payload.text(승인 스냅샷의 제목·설명·태그). */
export function youtubeTextOf(snapshot: Pick<PublishSnapshot, 'payload'>): YouTubeText {
  const t = (snapshot.payload as { text?: { title?: unknown; description?: unknown; tags?: unknown } }).text ?? {};
  return {
    title: typeof t.title === 'string' ? t.title : '',
    description: typeof t.description === 'string' ? t.description : '',
    tags: Array.isArray(t.tags) ? t.tags.map((x) => (typeof x === 'string' ? x : '')) : [],
  };
}

interface SnapshotAssetRef {
  id: string;
  checksum: string;
  role: string;
  mime: string;
}

function assetsOf(snapshot: Pick<PublishSnapshot, 'payload'>): SnapshotAssetRef[] {
  const a = (snapshot.payload as { assets?: unknown }).assets;
  return Array.isArray(a) ? (a as SnapshotAssetRef[]) : [];
}

const publicationId = (videoId: string) => `mock:youtube:${videoId}`;
const permalinkOf = (videoId: string) => `mock://youtube/watch/${videoId}`;

/** 원격이 보고한 공개 범위·예약 → 결과 종류(CONFIRMED ≠ 공개 — docs/03). */
export function youtubeResultOf(video: { privacyStatus: YouTubePrivacy; publishAt: string | null }): { result_kind: ResultKind; remote_visibility: RemoteVisibility } {
  if (video.privacyStatus === 'public' || video.privacyStatus === 'unlisted') return { result_kind: 'PUBLISHED', remote_visibility: video.privacyStatus };
  if (video.publishAt) return { result_kind: 'SCHEDULED_REMOTE', remote_visibility: 'private' };
  return { result_kind: 'UPLOADED_PRIVATE', remote_visibility: 'private' };
}

/** 시뮬레이터 오류 → 어댑터 결과(docs/03 분류). 토큰·세션 URI 는 넣지 않는다. */
export function classifyYouTubeError(e: unknown, op: YouTubeOp): AdapterResult {
  if (!(e instanceof YouTubeMockApiError)) return { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'adapter_error' };
  switch (e.kind) {
    case 'auth_invalid_token':
      return { status: 'rejected', retry_class: 'auth', error_code: 'auth_invalid_token' };
    case 'forbidden':
      return { status: 'rejected', retry_class: 'permanent', error_code: 'forbidden' };
    case 'quota_exceeded':
      // 할당량은 초기화 시각까지 다시 보내도 같은 거절 — 세션은 만들어지지 않았다(부작용 없음). 그 시각까지 RETRY_WAIT.
      return { status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'quota_exceeded', ...(e.opts.resetAt ? { retry_at: e.opts.resetAt } : { retry_after_sec: 3600 }) };
    case 'invalid_metadata':
      return { status: 'rejected', retry_class: 'permanent', error_code: e.code === 'invalid_metadata' ? 'invalid_metadata' : `invalid_metadata:${e.code}` };
    case 'server_error':
      // 세션 만들기 5xx 는 부작용 여부로(불명 → 조회). 조각·조회 5xx 는 받은 바이트가 불명 → 조회로 받은 바이트를 묻는다.
      if (op === 'initResumable' && e.sideEffect === 'none') return { status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'server_error' };
      return { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: `server_error_${op}` };
    case 'not_found':
    case 'session_expired':
    case 'offset_mismatch':
    case 'network_drop':
    case 'timeout':
    default:
      // 원격 사실(받은 바이트·영상 유무)을 단정하지 않고 조회로(같은 세션을 이어 가거나 만료를 확인).
      return { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: e.kind === 'network_drop' ? 'upload_interrupted' : e.code };
  }
}

export class YouTubeMockChannelAdapter implements ChannelAdapter {
  readonly kind = 'mock' as const;
  readonly id = YOUTUBE_ADAPTER_ID;
  /** FIX-T14(P1): 조회 판정이 remote_steps 에 기댄다 — 복원한 작업의 not_found 는 믿지 않는다(작업 처리기가 unknown 으로). */
  readonly usesRemoteSteps = true;
  readonly rateStepKinds = ['upload_session'] as const;
  readonly api: YouTubeMockApi;
  chunkBytes: number;
  rateLimit: ChannelRateLimit;
  /** 호출 수(시험 관찰) */
  readonly calls = { prepare: 0, submit: 0, reconcile: 0, cancel: 0 };
  private readonly tokens = new WeakMap<PreparedSubmission, string>();

  constructor(opts: YouTubeAdapterOptions = {}) {
    this.api = opts.api ?? youtubeMockApi();
    this.chunkBytes = opts.chunkBytes ?? YOUTUBE_DEFAULT_CHUNK_BYTES;
    this.rateLimit = opts.rateLimit ?? { ...YOUTUBE_PROVISIONAL_RATE_LIMIT };
  }

  capabilities(_account: AdapterAccount): AdapterCapabilities {
    return {
      read: true,
      // 업로드한 영상의 삭제는 별도 명령·승인(범위 밖) — 원격 취소 없음. 취소 성공을 꾸며내지 않는다.
      cancel: false,
      definitive_not_found: true,
      mock: true,
      adapter: YOUTUBE_ADAPTER_ID,
      media: true,
      text: {
        max_post_chars: YOUTUBE_DESCRIPTION_MAX,
        max_posts: 1,
        unit: 'code_point',
        checked_at: null,
        api_version: null,
        source: `provisional — 제목 ≤${YOUTUBE_TITLE_MAX}·설명 ≤${YOUTUBE_DESCRIPTION_MAX}·태그 ≤${YOUTUBE_MAX_TAGS}(channel.ts 잠정값), 공식 자료 재확인 필요(D14, D27)`,
      },
      rate_limit: { ...this.rateLimit },
    };
  }

  /** 업로드 시작 1회 = 1 단위(재개는 새 단위가 아니다 — 작업 처리기가 이 작업의 세션 단계 수를 뺀다). */
  rateUnits(_snapshot: PublishSnapshot): number {
    return 1;
  }

  /**
   * 승인 스냅샷만으로 검사(원격 호출 없음). 영상 1개(video/*)·제목·설명·태그 한도, 목적·공개 범위·publishAt 일관성(docs/03 승인 스냅샷):
   * upload_private → private + publishAt 없음 / public_publish → public·unlisted(publishAt 없음) 또는 private + publishAt(원격 예약 공개).
   */
  validate(snapshot: PublishSnapshot): { ok: true } | { ok: false; error_code: string } {
    if (snapshot.account.kind !== 'mock' || !snapshot.account.external_account_id.startsWith('mock:')) return { ok: false, error_code: 'not_mock_account' };
    if (snapshot.channel !== 'youtube' || snapshot.account.platform !== 'youtube') return { ok: false, error_code: 'channel_not_supported' };
    if (snapshot.requested_result !== 'upload_private' && snapshot.requested_result !== 'public_publish') return { ok: false, error_code: 'requested_result_not_supported' };
    const assets = assetsOf(snapshot);
    const videos = assets.filter((a) => a.role === 'video');
    if (videos.length !== 1 || !String(videos[0]!.mime).startsWith('video/')) return { ok: false, error_code: 'video_asset_required' };
    if (assets.length !== 1) return { ok: false, error_code: 'thumbnail_not_supported_t15' };
    const t = youtubeTextOf(snapshot);
    if (t.title.trim() === '' || cpLength(t.title) > YOUTUBE_TITLE_MAX) return { ok: false, error_code: 'invalid_title' };
    if (cpLength(t.description) > YOUTUBE_DESCRIPTION_MAX) return { ok: false, error_code: 'invalid_description' };
    if (t.tags.length > YOUTUBE_MAX_TAGS || t.tags.some((x) => x.length === 0 || x.length > 50)) return { ok: false, error_code: 'invalid_tags' };
    const publishAt = providerMetadataOf(snapshot.payload).publish_at ?? null;
    if (publishAt !== null && !Number.isFinite(Date.parse(publishAt))) return { ok: false, error_code: 'invalid_publish_at' };
    if (snapshot.requested_result === 'upload_private') {
      // 비공개 업로드만 승인 — publishAt·public 전환 금지(docs/03)
      if (snapshot.visibility !== 'private' || publishAt !== null) return { ok: false, error_code: 'approval_mismatch' };
    } else if (publishAt !== null) {
      if (snapshot.visibility !== 'private') return { ok: false, error_code: 'publish_at_requires_private' };
    } else if (snapshot.visibility !== 'public' && snapshot.visibility !== 'unlisted') {
      return { ok: false, error_code: 'approval_mismatch' };
    }
    return { ok: true };
  }

  async prepare(snapshot: PublishSnapshot, ctx: AdapterContext): Promise<PreparedSubmission> {
    this.calls.prepare++;
    const data: Record<string, unknown> = { mock: true, platform: 'youtube', adapter: YOUTUBE_ADAPTER_ID };
    const prepared: PreparedSubmission = { snapshot, data };
    let r: Awaited<ReturnType<NonNullable<AdapterContext['credential']>['accessToken']>>;
    try {
      r = ctx.credential ? await ctx.credential.accessToken() : { ok: false, code: 'credential_unavailable' };
    } catch {
      r = { ok: false, code: 'credential_unavailable' };
    }
    if (r.ok) this.tokens.set(prepared, r.token);
    else data.blocked = r.code;
    return prepared;
  }

  private scenario(ctx: Pick<AdapterContext, 'mockScenario'>): MockScenarioValue {
    const s = ctx.mockScenario?.scenario;
    return s && isYouTubeMockScenario(s) ? s : 'youtube_success_private';
  }

  /** 시나리오 → 세션 옵션(프로젝트 검증·처리 지연·거부). 시나리오는 시뮬레이터만 바꾼다(payload·hash 그대로). */
  private sessionOptions(scenario: MockScenarioValue): { projectVerified?: boolean; processAfterPolls?: number; outcome?: 'processed' | 'rejected' } {
    switch (scenario) {
      case 'youtube_processing_slow':
        return { processAfterPolls: 3 };
      case 'youtube_rejected':
        return { outcome: 'rejected' };
      case 'youtube_public_unverified_forced_private':
        return { projectVerified: false };
      case 'youtube_scheduled_private':
      case 'youtube_project_verified':
        return { projectVerified: true };
      default:
        return {};
    }
  }

  /** 시나리오 → 이번 호출의 장애(첫 시도에서만 — 재개·재시도는 정상 동작). */
  private faultFor(scenario: MockScenarioValue, op: YouTubeOp, attempt: number, chunk: { offset: number; len: number; size: number } | null, now: Date): YouTubeFault | null {
    if (attempt !== 1) return null;
    const mid = chunk ? chunk.offset <= Math.floor(chunk.size / 2) && Math.floor(chunk.size / 2) < chunk.offset + chunk.len : false;
    const last = chunk ? chunk.offset + chunk.len === chunk.size : false;
    switch (scenario) {
      case 'youtube_network_drop':
        return op === 'putChunk' && mid ? { op, kind: 'network_drop', partialBytes: Math.floor(chunk!.len / 2) } : null;
      case 'youtube_response_lost_after_complete':
        return op === 'putChunk' && last ? { op, kind: 'timeout', applied: true } : null;
      case 'youtube_session_expired_before_complete':
        return op === 'putChunk' && mid ? { op, kind: 'session_expired', expireSession: true } : null;
      case 'youtube_quota_exceeded':
        return op === 'initResumable' ? { op, kind: 'quota_exceeded', code: 'quotaExceeded', resetAt: new Date(now.getTime() + 3600_000).toISOString() } : null;
      case 'youtube_token_invalid':
        return op === 'initResumable' ? { op, kind: 'auth_invalid_token' } : null;
      default:
        return null;
    }
  }

  private async beforeWrite(ctx: AdapterContext): Promise<void> {
    await ctx.heartbeat();
    if (ctx.signal.aborted) throw abortError();
  }

  async submit(prepared: PreparedSubmission, ctx: AdapterContext): Promise<AdapterResult> {
    this.calls.submit++;
    const snap = prepared.snapshot;
    const blocked = prepared.data.blocked;
    if (typeof blocked === 'string') return { status: 'rejected', retry_class: 'auth', error_code: blocked };
    const token = this.tokens.get(prepared);
    if (!token) return { status: 'rejected', retry_class: 'auth', error_code: 'credential_unavailable' };
    if (!ctx.steps) return { status: 'rejected', retry_class: 'permanent', error_code: 'steps_unavailable' };
    if (!ctx.media) return { status: 'rejected', retry_class: 'permanent', error_code: 'media_reader_unavailable' };
    const steps = ctx.steps;
    const requestId = `mock-yt-req:${randomUUID()}`;
    const res = (r: AdapterResult): AdapterResult => ({ ...r, provider_request_id: requestId });
    const userId = snap.account.external_account_id;
    const scenario = this.scenario(ctx);
    const now = ctx.now;
    // 원격 호출 전에 검사: 승인한 파일(VERIFIED·같은 checksum)·예약 공개 시각(과거면 즉시 공개 효과 — 거부)
    const asset = assetsOf(snap).find((a) => a.role === 'video');
    if (!asset) return res({ status: 'rejected', retry_class: 'permanent', error_code: 'video_asset_required' });
    const opened = await ctx.media.open({ id: asset.id, checksum: asset.checksum, mime: asset.mime });
    if (!opened.ok) return res({ status: 'rejected', retry_class: 'permanent', error_code: opened.code });
    const file: MediaFile = opened.file;
    if (file.bytes <= 0 || file.bytes > YOUTUBE_MAX_UPLOAD_BYTES) return res({ status: 'rejected', retry_class: 'permanent', error_code: 'media_size_out_of_range' });
    const publishAt = providerMetadataOf(snap.payload).publish_at ?? null;
    if (publishAt && Date.parse(publishAt) <= now.getTime() + 60_000) return res({ status: 'rejected', retry_class: 'permanent', error_code: 'publish_at_in_past' });
    const delay = ctx.mockScenario?.delay_ms ?? 0;
    if (delay > 0) await sleep(delay, ctx.signal);

    const recorded = await steps.list();
    const video = recorded.find((s) => s.kind === 'video') ?? null;
    if (video) {
      // 이미 영상이 있다 — 다시 올리지 않고 처리 상태 확인으로 넘긴다.
      return res({ status: 'processing', external_id: publicationId(video.remote_id), error_code: 'video_processing' });
    }
    const sessions = recorded.filter((s) => s.kind === 'upload_session').sort((a, b) => a.post_index - b.post_index);
    let session: RemoteStep | null = sessions.at(-1) ?? null;
    let offset = 0;
    let videoId: string | null = null;
    if (session && (session.status === 'created' || session.status === 'finished')) {
      // 유효할 수 있는 세션 — 새 세션을 만들지 않고 받은 바이트를 묻는다(A14).
      let q: { received: number; size: number; videoId: string | null };
      try {
        await ctx.heartbeat();
        q = this.api.queryOffset({ userId, accessToken: token, sessionUri: session.remote_id, now });
      } catch (e) {
        if (e instanceof LeaseLostError) throw e;
        if (e instanceof YouTubeMockApiError && e.kind === 'session_expired') {
          // 만료된 세션(영상 없음이 원격으로 확인됨) — 기록하고 새 세션으로.
          await steps.record({ kind: 'upload_session', post_index: session.post_index, remote_id: session.remote_id, status: 'expired' });
          session = null;
          q = { received: 0, size: file.bytes, videoId: null };
        } else {
          const r = classifyYouTubeError(e, 'queryOffset');
          return res(r.retry_class === 'auth' ? r : { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: `query_${r.error_code}` });
        }
      }
      if (session) {
        if (q.size !== file.bytes) return res({ status: 'rejected', retry_class: 'permanent', error_code: 'session_size_mismatch' });
        if (q.videoId) {
          videoId = q.videoId;
          await steps.record({ kind: 'upload_session', post_index: session.post_index, remote_id: session.remote_id, status: 'finished', received_bytes: q.received, total_bytes: file.bytes });
        } else {
          offset = q.received;
          session = await steps.record({
            kind: 'upload_session',
            post_index: session.post_index,
            remote_id: session.remote_id,
            status: 'created',
            received_bytes: q.received,
            total_bytes: file.bytes,
            resumed: true,
          });
        }
      }
    } else {
      session = null;
    }
    if (!videoId && !session) {
      // 새 세션(처음이거나 앞 세션이 만료·오류). 할당량은 작업 처리기가 의도 전에 로컬로 먼저 셌다.
      const t = youtubeTextOf(snap);
      const nextIndex = sessions.length ? sessions.at(-1)!.post_index + 1 : 0;
      await this.beforeWrite(ctx);
      let created: { sessionUri: string };
      try {
        created = this.api.initResumable(
          {
            userId,
            accessToken: token,
            metadata: { title: t.title, description: t.description, tags: t.tags, privacyStatus: snap.visibility as 'private' | 'unlisted' | 'public', publishAt },
            size: file.bytes,
            mime: file.mime,
            now,
          },
          { fault: this.faultFor(scenario, 'initResumable', ctx.attempt, null, now), ...this.sessionOptions(scenario) },
        );
      } catch (e) {
        if (e instanceof LeaseLostError) throw e;
        return res(classifyYouTubeError(e, 'initResumable'));
      }
      // 첫 조각 전에 세션 URI 를 남긴다(짧은 트랜잭션) — 끊기면 다음 시도·조회가 같은 세션을 이어 간다.
      session = await steps.record({ kind: 'upload_session', post_index: nextIndex, remote_id: created.sessionUri, status: 'created', received_bytes: 0, total_bytes: file.bytes });
      offset = 0;
    }
    if (!videoId) {
      const chunk = Math.max(1, Math.floor(this.chunkBytes));
      while (offset < file.bytes) {
        // 영상이 생기기 전 취소 요청 → 멈춘다(받은 조각은 세션에 남지만 영상은 없다). 그 뒤 취소는 "업로드됨 — 삭제는 범위 밖".
        if (ctx.cancelRequested && (await ctx.cancelRequested())) return res({ status: 'rejected', retry_class: 'permanent', error_code: 'canceled_before_upload_complete' });
        await this.beforeWrite(ctx);
        const end = Math.min(file.bytes, offset + chunk);
        const bytes = await file.read(offset, end);
        let r: { status: 308; received: number } | { status: 201; videoId: string; received: number };
        try {
          r = this.api.putChunk(
            { userId, accessToken: token, sessionUri: session!.remote_id, offset, bytes, now },
            { fault: this.faultFor(scenario, 'putChunk', ctx.attempt, { offset, len: end - offset, size: file.bytes }, now) },
          );
        } catch (e) {
          if (e instanceof LeaseLostError) throw e;
          return res(classifyYouTubeError(e, 'putChunk'));
        }
        if (r.status === 201) {
          videoId = r.videoId;
          await steps.record({ kind: 'upload_session', post_index: session!.post_index, remote_id: session!.remote_id, status: 'finished', received_bytes: r.received, total_bytes: file.bytes });
          break;
        }
        if (r.received <= offset) return res({ status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'upload_no_progress' });
        offset = r.received;
        await steps.record({ kind: 'upload_session', post_index: session!.post_index, remote_id: session!.remote_id, status: 'created', received_bytes: offset, total_bytes: file.bytes });
      }
    }
    if (!videoId) return res({ status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'video_id_missing' });
    // 영상 ID 를 남긴 뒤 처리 상태는 조회가 확인한다(업로드 성공 ≠ 공개 게시 성공 — 처리 전에는 결과를 기록하지 않는다).
    await steps.record({ kind: 'video', post_index: 0, remote_id: videoId, status: 'uploaded' });
    return res({ status: 'processing', external_id: publicationId(videoId), error_code: 'video_processing' });
  }

  /** 영상 상태 조회 → 결과. 단계 기록(처리됨·오류)만 남긴다(원격에 쓰지 않음). */
  private async videoResult(ctx: AdapterContext, token: string, userId: string, videoId: string): Promise<ReconcileResult> {
    let v: ReturnType<YouTubeMockApi['getVideo']>;
    try {
      v = this.api.getVideo({ userId, accessToken: token, videoId, now: ctx.now });
    } catch (e) {
      return { status: 'unknown', error_code: e instanceof YouTubeMockApiError ? `video_${e.code}` : 'adapter_error' };
    }
    if (v.uploadStatus === 'uploaded') return { status: 'processing', error_code: 'video_processing', external_id: publicationId(videoId) };
    if (v.uploadStatus === 'failed' || v.uploadStatus === 'rejected') {
      await ctx.steps!.record({ kind: 'video', post_index: 0, remote_id: videoId, status: 'error' });
      return { status: 'failed', error_code: v.uploadStatus === 'rejected' ? `youtube_rejected:${v.rejectionReason ?? 'unknown'}` : 'youtube_processing_failed', external_id: publicationId(videoId) };
    }
    await ctx.steps!.record({ kind: 'video', post_index: 0, remote_id: videoId, status: 'processed' });
    return { status: 'found', external_id: publicationId(videoId), permalink: permalinkOf(videoId), ...youtubeResultOf(v) };
  }

  /**
   * 읽기 전용 조회. 판정:
   * - 단계 기록 없음 → not_found(영상은 기록된 세션으로만 올리므로 올라가지 않았음이 확실; 기록 전 응답을 잃은 세션은 바이트 없이 만료된다).
   * - 영상 기록 있음 → 처리 상태(uploaded → processing, processed → found, failed·rejected → failed).
   * - 마지막 세션이 진행 중 → 받은 바이트를 묻는다: 끝났으면 영상 ID 를 기록하고 처리 상태로, 덜 받았으면 resumable(같은 세션으로 이어서),
   *   만료(영상 없음) → not_found(새 세션으로 다시 보내도 됨), 모름·읽기 실패 → unknown(맹목 재전송 없음).
   * - 마지막 세션이 만료·오류로 기록됨 → not_found.
   */
  async reconcile(_reference: RemoteReference, ctx: AdapterContext): Promise<ReconcileResult> {
    this.calls.reconcile++;
    if (!ctx.steps) return { status: 'unknown', error_code: 'steps_unavailable' };
    const snap = ctx.snapshot;
    if (!snap) return { status: 'unknown', error_code: 'snapshot_unavailable' };
    const recorded = await ctx.steps.list();
    if (recorded.length === 0) return { status: 'not_found', error_code: 'no_remote_steps' };
    let tok: { ok: true; token: string } | { ok: false; code: string };
    try {
      tok = ctx.credential ? await ctx.credential.accessToken() : { ok: false, code: 'credential_unavailable' };
    } catch {
      tok = { ok: false, code: 'credential_unavailable' };
    }
    if (!tok.ok) return { status: 'unknown', error_code: tok.code };
    const token = tok.token;
    const userId = snap.account.external_account_id;
    const video = recorded.find((s) => s.kind === 'video');
    if (video) return this.videoResult(ctx, token, userId, video.remote_id);
    const session = recorded
      .filter((s) => s.kind === 'upload_session')
      .sort((a, b) => a.post_index - b.post_index)
      .at(-1);
    if (!session) return { status: 'not_found', error_code: 'no_upload_session' };
    if (session.status === 'expired' || session.status === 'error') return { status: 'not_found', error_code: 'session_expired_not_uploaded' };
    let q: { received: number; size: number; videoId: string | null };
    try {
      q = this.api.queryOffset({ userId, accessToken: token, sessionUri: session.remote_id, now: ctx.now });
    } catch (e) {
      if (e instanceof YouTubeMockApiError && e.kind === 'session_expired') {
        await ctx.steps.record({ kind: 'upload_session', post_index: session.post_index, remote_id: session.remote_id, status: 'expired' });
        return { status: 'not_found', error_code: 'session_expired_not_uploaded' };
      }
      return { status: 'unknown', error_code: e instanceof YouTubeMockApiError ? `session_${e.code}` : 'adapter_error' };
    }
    if (q.videoId) {
      await ctx.steps.record({ kind: 'upload_session', post_index: session.post_index, remote_id: session.remote_id, status: 'finished', received_bytes: q.received, total_bytes: q.size });
      await ctx.steps.record({ kind: 'video', post_index: 0, remote_id: q.videoId, status: 'uploaded' });
      return this.videoResult(ctx, token, userId, q.videoId);
    }
    await ctx.steps.record({ kind: 'upload_session', post_index: session.post_index, remote_id: session.remote_id, status: 'created', received_bytes: q.received, total_bytes: q.size });
    // 덜 받았다 — 같은 세션으로 이어 올릴 수 있다(새 세션·처음부터 다시 없음, A14).
    return { status: 'resumable', published_parts: 0, error_code: 'upload_incomplete' };
  }

  /** 올린 영상의 삭제는 별도 명령·승인(범위 밖) — 취소 성공을 꾸며내지 않는다. */
  async cancel(_reference: RemoteReference, _ctx: AdapterContext): Promise<CancelResult> {
    this.calls.cancel++;
    return { status: 'unsupported', error_code: 'youtube_delete_out_of_scope' };
  }
}
