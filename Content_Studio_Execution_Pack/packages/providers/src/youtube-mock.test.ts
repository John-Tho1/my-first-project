/**
 * T15(결정 D27) YouTube 모의 — 시뮬레이터(조각 offset·세션 만료·미검증 프로젝트 강제 비공개·할당량·끊김), 오류 분류, 결과 종류,
 * 어댑터 validate(목적·공개 범위·publishAt 조합), submit/reconcile(같은 세션 재개·응답 유실·만료 → 새 세션·취소·조각 읽기 크기),
 * Google 형 모의 OAuth 공급자(PKCE·회전·철회·scope 자리 표시). 네트워크 없음.
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  adapterIdFor,
  codeChallengeS256,
  LeaseLostError,
  scenarioApplies,
  YOUTUBE_REQUIRED_SCOPES,
  type AdapterContext,
  type MediaPort,
  type PublishSnapshot,
  type RemoteStep,
  type RemoteStepsPort,
} from '@cs/domain';
import { MockGoogleOAuthProvider, MockOAuthStore, MockThreadsOAuthProvider } from './oauth';
import {
  classifyYouTubeError,
  mockGoogleTokenCheck,
  YOUTUBE_UPLOAD_QUOTA_UNITS,
  YouTubeMockApi,
  YouTubeMockApiError,
  YouTubeMockChannelAdapter,
  youtubeResultOf,
} from './youtube-mock';

const KIB = 1024;
const USER = 'mock:youtube:user-1';
const TOKEN = 'mockyt_at_test';
const meta = (over: Partial<{ privacyStatus: 'private' | 'public' | 'unlisted'; publishAt: string | null }> = {}) => ({
  title: '제목',
  description: '설명',
  tags: ['a'],
  privacyStatus: 'private' as const,
  ...over,
});

function bytesOf(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function api(): YouTubeMockApi {
  return new YouTubeMockApi({ tokenCheck: (t, u) => t === TOKEN && u === USER });
}

describe('YouTubeMockApi(시뮬레이터)', () => {
  it('조각 offset: 308(받은 바이트) → 마지막 조각 201(영상 ID), 받은 바이트 sha256 = 파일, 끝난 세션에 다시 보내도 같은 영상', () => {
    const a = api();
    const file = bytesOf(300 * KIB);
    const { sessionUri } = a.initResumable({ userId: USER, accessToken: TOKEN, metadata: meta(), size: file.byteLength, mime: 'video/mp4' });
    expect(sessionUri).toMatch(/^mock:\/\/youtube\/upload\//);
    let off = 0;
    let videoId = '';
    while (off < file.byteLength) {
      const end = Math.min(file.byteLength, off + 64 * KIB);
      const r = a.putChunk({ userId: USER, accessToken: TOKEN, sessionUri, offset: off, bytes: file.subarray(off, end) });
      if (r.status === 201) videoId = r.videoId;
      else expect(r.received).toBe(end);
      off = end;
    }
    expect(videoId).toMatch(/^mockyt_v_/);
    expect(a.videosOf(USER)[0]!.sha256).toBe(sha(file));
    const again = a.putChunk({ userId: USER, accessToken: TOKEN, sessionUri, offset: 0, bytes: file.subarray(0, 10) });
    expect(again).toMatchObject({ status: 201, videoId });
    expect(a.videosOf(USER)).toHaveLength(1);
  });

  it('offset 이 받은 바이트와 다르면 409 offset_mismatch(받지 않음), queryOffset 은 받은 바이트를 알려 준다', () => {
    const a = api();
    const { sessionUri } = a.initResumable({ userId: USER, accessToken: TOKEN, metadata: meta(), size: 100, mime: 'video/mp4' });
    a.putChunk({ userId: USER, accessToken: TOKEN, sessionUri, offset: 0, bytes: bytesOf(40) });
    expect(() => a.putChunk({ userId: USER, accessToken: TOKEN, sessionUri, offset: 10, bytes: bytesOf(10) })).toThrow(YouTubeMockApiError);
    expect(a.queryOffset({ userId: USER, accessToken: TOKEN, sessionUri })).toEqual({ received: 40, size: 100, videoId: null });
  });

  it('network_drop: 조각 앞부분만 받고 끊긴다 — 보낸 바이트에는 조각 전체, 받은 바이트는 일부', () => {
    const a = api();
    const { sessionUri } = a.initResumable({ userId: USER, accessToken: TOKEN, metadata: meta(), size: 1000, mime: 'video/mp4' });
    expect(() =>
      a.putChunk({ userId: USER, accessToken: TOKEN, sessionUri, offset: 0, bytes: bytesOf(400) }, { fault: { op: 'putChunk', kind: 'network_drop', partialBytes: 150 } }),
    ).toThrow(/network_drop/);
    expect(a.queryOffset({ userId: USER, accessToken: TOKEN, sessionUri }).received).toBe(150);
    expect(a.bytesSent).toBe(400);
    expect(a.bytesReceived).toBe(150);
  });

  it('세션 만료(TTL 지남·명시 만료): 영상이 없으면 404 session_expired(조각·조회 모두), 모르는 세션은 not_found', () => {
    const a = api();
    a.sessionTtlMs = 1000;
    const t0 = new Date('2026-10-02T10:00:00Z');
    const { sessionUri } = a.initResumable({ userId: USER, accessToken: TOKEN, metadata: meta(), size: 100, mime: 'video/mp4', now: t0 });
    const later = new Date(t0.getTime() + 2000);
    expect(() => a.queryOffset({ userId: USER, accessToken: TOKEN, sessionUri, now: later })).toThrow(expect.objectContaining({ kind: 'session_expired' }));
    expect(() => a.putChunk({ userId: USER, accessToken: TOKEN, sessionUri, offset: 0, bytes: bytesOf(10), now: later })).toThrow(expect.objectContaining({ kind: 'session_expired' }));
    expect(() => a.queryOffset({ userId: USER, accessToken: TOKEN, sessionUri: 'mock://youtube/upload/x' })).toThrow(expect.objectContaining({ kind: 'not_found' }));
  });

  it('미검증 프로젝트(기본): public·unlisted 는 private 로 강제·publishAt 버림(요청값은 기록), 검증된 프로젝트는 그대로', () => {
    const a = api();
    const up = (m: ReturnType<typeof meta>, projectVerified?: boolean) => {
      const { sessionUri } = a.initResumable({ userId: USER, accessToken: TOKEN, metadata: m, size: 10, mime: 'video/mp4' }, { projectVerified });
      const r = a.putChunk({ userId: USER, accessToken: TOKEN, sessionUri, offset: 0, bytes: bytesOf(10) });
      return a.videosOf(USER).find((v) => v.id === (r as { videoId: string }).videoId)!;
    };
    const forced = up(meta({ privacyStatus: 'public' }));
    expect(forced).toMatchObject({ requestedPrivacy: 'public', privacyStatus: 'private', forcedPrivate: true });
    const at = new Date(Date.now() + 86400_000).toISOString();
    expect(up(meta({ publishAt: at }))).toMatchObject({ privacyStatus: 'private', publishAt: null, requestedPublishAt: at, forcedPrivate: true });
    expect(up(meta({ privacyStatus: 'public' }), true)).toMatchObject({ privacyStatus: 'public', forcedPrivate: false });
    expect(up(meta({ publishAt: at }), true)).toMatchObject({ privacyStatus: 'private', publishAt: at });
  });

  it('메타데이터 거부: publishAt + public, 과거 publishAt, 빈 제목, video/* 아님, 2GB 초과', () => {
    const a = api();
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 86400_000).toISOString();
    const bad = (m: ReturnType<typeof meta> | Record<string, unknown>, size = 10, mime = 'video/mp4') =>
      expect(() => a.initResumable({ userId: USER, accessToken: TOKEN, metadata: m as ReturnType<typeof meta>, size, mime })).toThrow(expect.objectContaining({ kind: 'invalid_metadata' }));
    bad(meta({ privacyStatus: 'public', publishAt: future }));
    bad(meta({ publishAt: past }));
    bad({ ...meta(), title: ' ' });
    bad(meta(), 10, 'audio/mpeg');
    bad(meta(), 2 * 1024 * 1024 * 1024 + 1);
    expect(a.sessionUris()).toHaveLength(0);
  });

  it('할당량: 남은 단위 < 1600 이면 403 quotaExceeded(초기화 시각), 초기화 뒤 허용·세션 없음', () => {
    const a = api();
    const reset = new Date(Date.now() + 3600_000);
    a.setQuota(USER, YOUTUBE_UPLOAD_QUOTA_UNITS + 10, reset);
    a.initResumable({ userId: USER, accessToken: TOKEN, metadata: meta(), size: 10, mime: 'video/mp4' });
    let err: unknown;
    try {
      a.initResumable({ userId: USER, accessToken: TOKEN, metadata: meta(), size: 10, mime: 'video/mp4' });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ kind: 'quota_exceeded', httpStatus: 403, opts: { resetAt: reset.toISOString() } });
    expect(a.sessionUris()).toHaveLength(1);
    a.initResumable({ userId: USER, accessToken: TOKEN, metadata: meta(), size: 10, mime: 'video/mp4', now: new Date(reset.getTime() + 1) });
    expect(a.sessionUris()).toHaveLength(2);
  });

  it('토큰: 다른 사용자·모르는 토큰은 401, 오류 메시지에 토큰·세션 URI 없음', () => {
    const a = api();
    let e: unknown;
    try {
      a.initResumable({ userId: 'other', accessToken: TOKEN, metadata: meta(), size: 10, mime: 'video/mp4' });
    } catch (x) {
      e = x;
    }
    expect(e).toMatchObject({ kind: 'auth_invalid_token', httpStatus: 401 });
    expect(String((e as Error).message)).not.toContain(TOKEN);
  });
});

describe('분류·결과 종류', () => {
  it('오류 분류 표(docs/03): 401 auth · 403 permanent · quota 부작용 없음(초기화 시각) · 400 permanent · 끊김·시간 초과·만료·offset → 조회', () => {
    const c = (kind: ConstructorParameters<typeof YouTubeMockApiError>[0], op: Parameters<typeof classifyYouTubeError>[1] = 'putChunk', opts = {}) =>
      classifyYouTubeError(new YouTubeMockApiError(kind, opts), op);
    expect(c('auth_invalid_token')).toMatchObject({ status: 'rejected', retry_class: 'auth' });
    expect(c('forbidden')).toMatchObject({ status: 'rejected', retry_class: 'permanent' });
    expect(c('quota_exceeded', 'initResumable', { resetAt: '2026-10-03T07:00:00.000Z' })).toMatchObject({
      status: 'rejected',
      retry_class: 'transient_no_side_effect',
      error_code: 'quota_exceeded',
      retry_at: '2026-10-03T07:00:00.000Z',
    });
    expect(c('invalid_metadata', 'initResumable', { code: 'invalid_title' })).toMatchObject({ retry_class: 'permanent', error_code: 'invalid_metadata:invalid_title' });
    expect(c('server_error', 'initResumable')).toMatchObject({ retry_class: 'transient_no_side_effect' });
    expect(c('server_error', 'initResumable', { sideEffect: 'unknown' })).toMatchObject({ status: 'ambiguous' });
    expect(c('server_error', 'putChunk')).toMatchObject({ status: 'ambiguous' });
    for (const k of ['network_drop', 'timeout', 'session_expired', 'offset_mismatch', 'not_found'] as const) expect(c(k).status).toBe('ambiguous');
    expect(classifyYouTubeError(new Error('x'), 'putChunk')).toMatchObject({ status: 'ambiguous', error_code: 'adapter_error' });
  });

  it('결과 종류: private → UPLOADED_PRIVATE, private + publishAt → SCHEDULED_REMOTE, public·unlisted → PUBLISHED', () => {
    expect(youtubeResultOf({ privacyStatus: 'private', publishAt: null })).toEqual({ result_kind: 'UPLOADED_PRIVATE', remote_visibility: 'private' });
    expect(youtubeResultOf({ privacyStatus: 'private', publishAt: '2026-10-09T09:00:00Z' })).toEqual({ result_kind: 'SCHEDULED_REMOTE', remote_visibility: 'private' });
    expect(youtubeResultOf({ privacyStatus: 'public', publishAt: null })).toEqual({ result_kind: 'PUBLISHED', remote_visibility: 'public' });
    expect(youtubeResultOf({ privacyStatus: 'unlisted', publishAt: null })).toEqual({ result_kind: 'PUBLISHED', remote_visibility: 'unlisted' });
  });

  it('어댑터 선택: 연결한 적 있는 모의 YouTube → mock_youtube, seed(연결 없음) → mock_generic, live → null; youtube_* 시나리오는 mock_youtube 만', () => {
    expect(adapterIdFor({ kind: 'mock', platform: 'youtube', credential_state: 'linked' })).toBe('mock_youtube');
    expect(adapterIdFor({ kind: 'mock', platform: 'youtube', credential_state: 'needs_reconnect' })).toBe('mock_youtube');
    expect(adapterIdFor({ kind: 'mock', platform: 'youtube', credential_state: 'none' })).toBe('mock_generic');
    expect(adapterIdFor({ kind: 'live', platform: 'youtube', credential_state: 'linked' })).toBeNull();
    expect(scenarioApplies('mock_youtube', 'youtube_network_drop')).toBe(true);
    expect(scenarioApplies('mock_youtube', 'success')).toBe(true);
    expect(scenarioApplies('mock_youtube', 'threads_success')).toBe(false);
    expect(scenarioApplies('mock_generic', 'youtube_network_drop')).toBe(false);
    expect(scenarioApplies('mock_threads', 'youtube_network_drop')).toBe(false);
  });
});

// ---- 어댑터(메모리 단계 기록·메모리 미디어) ----

function memSteps(): RemoteStepsPort & { rows: RemoteStep[] } {
  const rows: RemoteStep[] = [];
  return {
    rows,
    list: async () => rows.map((r) => ({ ...r })),
    record: async (s) => {
      const ex = rows.find((r) => r.kind === s.kind && r.post_index === s.post_index);
      const now = new Date().toISOString();
      if (ex) {
        if (ex.remote_id !== s.remote_id) throw new Error('remote_step_conflict');
        if (s.received_bytes !== undefined && ex.received_bytes !== null && s.received_bytes < ex.received_bytes) throw new Error('remote_step_regress');
        if (!['processed', 'expired', 'error', 'published'].includes(ex.status)) ex.status = s.status;
        if (s.received_bytes !== undefined) ex.received_bytes = Math.max(ex.received_bytes ?? 0, s.received_bytes);
        if (s.total_bytes !== undefined && ex.total_bytes === null) ex.total_bytes = s.total_bytes;
        if (s.resumed) ex.resume_count++;
        return { ...ex };
      }
      const r: RemoteStep = {
        kind: s.kind,
        post_index: s.post_index,
        remote_id: s.remote_id,
        status: s.status,
        received_bytes: s.received_bytes ?? null,
        total_bytes: s.total_bytes ?? null,
        resume_count: 0,
        step_index: rows.length,
        created_at: now,
        updated_at: now,
      };
      rows.push(r);
      return { ...r };
    },
  };
}

const VIDEO = bytesOf(300 * KIB, 11);
const ASSET = { id: '00000000-0000-4000-8000-0000000000aa', checksum: sha(VIDEO), role: 'video', order: 1, mime: 'video/mp4' };

function memMedia(file: Uint8Array = VIDEO, reads: number[] = []): MediaPort {
  return {
    open: async (want) =>
      want.checksum === sha(file)
        ? { ok: true, file: { bytes: file.byteLength, mime: 'video/mp4', checksum: sha(file), read: async (s, e) => (reads.push(e - s), file.slice(s, e)) } }
        : { ok: false, code: 'media_changed' },
  };
}

function snapshot(over: Partial<PublishSnapshot> & { publishAt?: string; assets?: unknown[] } = {}): PublishSnapshot {
  const { publishAt, assets, ...rest } = over;
  return {
    item_id: 'item',
    channel: 'youtube',
    account: { id: 'acc', kind: 'mock', platform: 'youtube', external_account_id: USER, credential_state: 'linked' },
    payload: {
      text: { rendered: '', title: '해외 영업 회고', description: '설명', tags: ['영업'] },
      assets: assets ?? [ASSET],
      provider_metadata: publishAt ? { publish_at: publishAt } : {},
    },
    payload_hash: 'h',
    visibility: 'private',
    requested_result: 'upload_private',
    scheduled_at_utc: null,
    ...rest,
  };
}

let n = 0;
function ctxOf(steps: RemoteStepsPort, over: Partial<AdapterContext> = {}): AdapterContext {
  return {
    intentKey: `job-${++n}:1`,
    attempt: 1,
    jobId: 'job',
    itemId: 'item',
    now: new Date(),
    signal: new AbortController().signal,
    heartbeat: async () => undefined,
    steps,
    credential: { accessToken: async () => ({ ok: true as const, token: TOKEN }) },
    media: memMedia(),
    snapshot: snapshot(),
    ...over,
  };
}

function adapter(): YouTubeMockChannelAdapter {
  return new YouTubeMockChannelAdapter({ api: api(), chunkBytes: 64 * KIB });
}

async function send(a: YouTubeMockChannelAdapter, snap: PublishSnapshot, ctx: AdapterContext) {
  return a.submit(await a.prepare(snap, ctx), ctx);
}

describe('YouTubeMockChannelAdapter.validate — 목적·공개 범위·publishAt(docs/03 승인 스냅샷)', () => {
  const a = adapter();
  const future = new Date(Date.now() + 86400_000).toISOString();
  it.each([
    ['upload_private + private', snapshot(), true, ''],
    ['upload_private + publishAt → approval_mismatch', snapshot({ publishAt: future }), false, 'approval_mismatch'],
    ['upload_private + public → approval_mismatch', snapshot({ visibility: 'public' }), false, 'approval_mismatch'],
    ['public_publish + public', snapshot({ requested_result: 'public_publish', visibility: 'public' }), true, ''],
    ['public_publish + unlisted', snapshot({ requested_result: 'public_publish', visibility: 'unlisted' }), true, ''],
    ['public_publish + private + publishAt(예약 공개)', snapshot({ requested_result: 'public_publish', publishAt: future }), true, ''],
    ['public_publish + private(publishAt 없음) → approval_mismatch', snapshot({ requested_result: 'public_publish' }), false, 'approval_mismatch'],
    ['public_publish + public + publishAt → publish_at_requires_private', snapshot({ requested_result: 'public_publish', visibility: 'public', publishAt: future }), false, 'publish_at_requires_private'],
    ['mock_publish → requested_result_not_supported', snapshot({ requested_result: 'mock_publish' }), false, 'requested_result_not_supported'],
    ['영상 없음 → video_asset_required', snapshot({ assets: [] }), false, 'video_asset_required'],
    ['image 만 → video_asset_required', snapshot({ assets: [{ ...ASSET, role: 'image', mime: 'image/png' }] }), false, 'video_asset_required'],
    ['영상 + 썸네일 → thumbnail_not_supported_t15', snapshot({ assets: [ASSET, { ...ASSET, id: 'x', role: 'thumbnail', order: 2, mime: 'image/png' }] }), false, 'thumbnail_not_supported_t15'],
  ])('%s', (_label, snap, ok, code) => {
    const r = a.validate(snap);
    expect(r.ok).toBe(ok);
    if (!ok) expect((r as { error_code: string }).error_code).toBe(code);
  });
  it('제목 101자·설명 5001자 거부, 실제 계정 거부', () => {
    expect(a.validate(snapshot({ payload: { ...snapshot().payload, text: { rendered: '', title: 'ㄱ'.repeat(101), description: '', tags: [] } } }))).toMatchObject({ ok: false, error_code: 'invalid_title' });
    expect(a.validate(snapshot({ payload: { ...snapshot().payload, text: { rendered: '', title: 't', description: 'x'.repeat(5001), tags: [] } } }))).toMatchObject({ ok: false, error_code: 'invalid_description' });
    expect(a.validate(snapshot({ account: { id: 'acc', kind: 'live', platform: 'youtube', external_account_id: 'UC1' } }))).toMatchObject({ ok: false, error_code: 'not_mock_account' });
  });
});

describe('YouTubeMockChannelAdapter submit/reconcile', () => {
  it('성공: 세션 1개·조각마다 받은 바이트 기록 → processing(영상 ID) → 조회 found UPLOADED_PRIVATE, 조각 읽기 ≤ 조각 크기', async () => {
    const a = adapter();
    const steps = memSteps();
    const reads: number[] = [];
    const ctx = ctxOf(steps, { media: memMedia(VIDEO, reads) });
    const r = await send(a, snapshot(), ctx);
    expect(r).toMatchObject({ status: 'processing', external_id: expect.stringMatching(/^mock:youtube:mockyt_v_/) });
    expect(r.result_kind).toBeUndefined();
    expect(a.api.sessionUris(USER)).toHaveLength(1);
    expect(Math.max(...reads)).toBeLessThanOrEqual(64 * KIB);
    expect(reads.reduce((s, x) => s + x, 0)).toBe(VIDEO.byteLength);
    expect(steps.rows.find((s) => s.kind === 'upload_session')).toMatchObject({ status: 'finished', received_bytes: VIDEO.byteLength, total_bytes: VIDEO.byteLength });
    const f = await a.reconcile({ platform: 'youtube', intent_key: ctx.intentKey, external_id: r.external_id!, provider_request_id: null }, ctx);
    expect(f).toMatchObject({ status: 'found', result_kind: 'UPLOADED_PRIVATE', remote_visibility: 'private', permalink: expect.stringMatching(/^mock:\/\/youtube\/watch\//) });
    expect(a.api.videosOf(USER)[0]!.sha256).toBe(sha(VIDEO));
  });

  it('A14: 50% 끊김 → ambiguous → 조회 resumable(같은 세션) → 다음 시도가 받은 바이트부터 이어 올림(보낸 바이트 = 파일 + 조각 일부)', async () => {
    const a = adapter();
    const steps = memSteps();
    const ctx1 = ctxOf(steps, { mockScenario: { scenario: 'youtube_network_drop', delay_ms: 0 } });
    const r1 = await send(a, snapshot(), ctx1);
    expect(r1).toMatchObject({ status: 'ambiguous', error_code: 'upload_interrupted' });
    const rec = await a.reconcile({ platform: 'youtube', intent_key: ctx1.intentKey, external_id: null, provider_request_id: null }, ctx1);
    expect(rec).toMatchObject({ status: 'resumable', error_code: 'upload_incomplete' });
    const ctx2 = ctxOf(steps, { attempt: 2, mockScenario: { scenario: 'youtube_network_drop', delay_ms: 0 } });
    const r2 = await send(a, snapshot(), ctx2);
    expect(r2.status).toBe('processing');
    expect(a.api.sessionUris(USER)).toHaveLength(1);
    expect(a.api.calls.initResumable).toBe(1);
    expect(a.api.bytesSent).toBe(VIDEO.byteLength + 32 * KIB);
    expect(a.api.videosOf(USER)).toHaveLength(1);
    expect(a.api.videosOf(USER)[0]!.sha256).toBe(sha(VIDEO));
    expect(steps.rows.find((s) => s.kind === 'upload_session')!.resume_count).toBe(1);
  });

  it('A08: 마지막 조각 응답 유실 → ambiguous → 조회가 영상 ID 를 찾아 기록(새 업로드 없음)', async () => {
    const a = adapter();
    const steps = memSteps();
    const ctx = ctxOf(steps, { mockScenario: { scenario: 'youtube_response_lost_after_complete', delay_ms: 0 } });
    const r = await send(a, snapshot(), ctx);
    expect(r.status).toBe('ambiguous');
    const chunks = a.api.calls.putChunk;
    const f = await a.reconcile({ platform: 'youtube', intent_key: ctx.intentKey, external_id: null, provider_request_id: null }, ctx);
    expect(f.status).toBe('found');
    expect(a.api.calls.putChunk).toBe(chunks);
    expect(steps.rows.filter((s) => s.kind === 'video')).toHaveLength(1);
  });

  it('세션 만료(영상 없음) → 조회 not_found(확실) → 다음 시도는 새 세션(post_index 1)', async () => {
    const a = adapter();
    const steps = memSteps();
    const ctx1 = ctxOf(steps, { mockScenario: { scenario: 'youtube_session_expired_before_complete', delay_ms: 0 } });
    expect((await send(a, snapshot(), ctx1)).status).toBe('ambiguous');
    expect(await a.reconcile({ platform: 'youtube', intent_key: ctx1.intentKey, external_id: null, provider_request_id: null }, ctx1)).toMatchObject({
      status: 'not_found',
      error_code: 'session_expired_not_uploaded',
    });
    const r2 = await send(a, snapshot(), ctxOf(steps, { attempt: 2 }));
    expect(r2.status).toBe('processing');
    expect(steps.rows.filter((s) => s.kind === 'upload_session').map((s) => `${s.post_index}:${s.status}`)).toEqual(['0:expired', '1:finished']);
    expect(a.api.videosOf(USER)).toHaveLength(1);
  });

  it('원격 세션을 모름(재시작) → 조회 unknown(맹목 재업로드 없음), 단계 기록 없음 → not_found', async () => {
    const a = adapter();
    const steps = memSteps();
    const ctx = ctxOf(steps, { mockScenario: { scenario: 'youtube_network_drop', delay_ms: 0 } });
    await send(a, snapshot(), ctx);
    a.api.reset();
    expect((await a.reconcile({ platform: 'youtube', intent_key: ctx.intentKey, external_id: null, provider_request_id: null }, ctx)).status).toBe('unknown');
    expect((await a.reconcile({ platform: 'youtube', intent_key: 'x', external_id: null, provider_request_id: null }, ctxOf(memSteps()))).status).toBe('not_found');
  });

  it('처리 지연 → processing, 거부 → failed(코드), 미검증 프로젝트의 public 요청 → found UPLOADED_PRIVATE/private', async () => {
    for (const [scenario, expected] of [
      ['youtube_processing_slow', 'processing'],
      ['youtube_rejected', 'failed'],
    ] as const) {
      const a = adapter();
      const steps = memSteps();
      const ctx = ctxOf(steps, { mockScenario: { scenario, delay_ms: 0 } });
      await send(a, snapshot(), ctx);
      const r = await a.reconcile({ platform: 'youtube', intent_key: ctx.intentKey, external_id: null, provider_request_id: null }, ctx);
      expect(r.status).toBe(expected);
      if (expected === 'failed') expect(r.error_code).toBe('youtube_rejected:mock_rejected');
    }
    const a = adapter();
    const steps = memSteps();
    const snap = snapshot({ requested_result: 'public_publish', visibility: 'public' });
    const ctx = ctxOf(steps, { snapshot: snap });
    await send(a, snap, ctx);
    expect(await a.reconcile({ platform: 'youtube', intent_key: ctx.intentKey, external_id: null, provider_request_id: null }, ctx)).toMatchObject({
      status: 'found',
      result_kind: 'UPLOADED_PRIVATE',
      remote_visibility: 'private',
    });
  });

  it('원격 호출 없이 닫힘: 연결 정보 없음(auth) · 미디어 checksum 다름 · 과거 publishAt · 할당량 시나리오는 세션 없이 retry_at', async () => {
    const a = adapter();
    const blocked = await send(a, snapshot(), ctxOf(memSteps(), { credential: { accessToken: async () => ({ ok: false as const, code: 'credential_revoked' }) } }));
    expect(blocked).toMatchObject({ status: 'rejected', retry_class: 'auth', error_code: 'credential_revoked' });
    const media = await send(a, snapshot(), ctxOf(memSteps(), { media: memMedia(bytesOf(10)) }));
    expect(media).toMatchObject({ status: 'rejected', retry_class: 'permanent', error_code: 'media_changed' });
    const past = snapshot({ requested_result: 'public_publish', publishAt: new Date(Date.now() + 30_000).toISOString() });
    expect(await send(a, past, ctxOf(memSteps(), { snapshot: past }))).toMatchObject({ status: 'rejected', error_code: 'publish_at_in_past' });
    expect(a.api.calls.initResumable).toBe(0);
    const q = await send(a, snapshot(), ctxOf(memSteps(), { mockScenario: { scenario: 'youtube_quota_exceeded', delay_ms: 0 } }));
    expect(q).toMatchObject({ status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'quota_exceeded', retry_at: expect.any(String) });
    expect(a.api.sessionUris(USER)).toHaveLength(0);
  });

  it('취소 요청: 영상이 생기기 전이면 조각 사이에서 멈춘다(영상 없음), cancel 은 unsupported(삭제는 범위 밖)', async () => {
    const a = adapter();
    let calls = 0;
    const r = await send(a, snapshot(), ctxOf(memSteps(), { cancelRequested: async () => ++calls > 2 }));
    expect(r).toMatchObject({ status: 'rejected', error_code: 'canceled_before_upload_complete' });
    expect(a.api.videosOf(USER)).toHaveLength(0);
    expect(await a.cancel({ platform: 'youtube', intent_key: 'k', external_id: 'mock:youtube:x', provider_request_id: null }, ctxOf(memSteps()))).toEqual({
      status: 'unsupported',
      error_code: 'youtube_delete_out_of_scope',
    });
    expect(a.capabilities({ id: 'acc', kind: 'mock', platform: 'youtube', external_account_id: USER })).toMatchObject({ cancel: false, read: true, mock: true, media: true });
  });
});

// FIX-T15(Codex review-T15 on 427dc71): 읽기 도중 중단·lease 상실·취소, 요청 제한 단위(만료 세션), 조각 예산(web tick), 조회 장애 주입이 완료를 가리지 않음
describe('FIX-T15 — 읽기 도중 중단·요청 제한 단위·조각 예산·조회 장애', () => {
  /** read(start) 가 at 이면 release() 까지 기다리는 미디어(그 사이에 중단·취소를 일으킨다). */
  function gatedMedia(at: number) {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const reached = new Promise<void>((r) => (entered = r));
    const media: MediaPort = {
      open: async () => ({
        ok: true,
        file: {
          bytes: VIDEO.byteLength,
          mime: 'video/mp4',
          checksum: sha(VIDEO),
          read: async (s, e) => {
            if (s === at) {
              entered();
              await gate;
            }
            return VIDEO.slice(s, e);
          },
        },
      }),
    };
    return { media, release, reached };
  }
  const ref = (k: string) => ({ platform: 'youtube', intent_key: k, external_id: null, provider_request_id: null });

  it.each([
    ['중간 조각', 2 * 64 * KIB],
    ['마지막 조각', 4 * 64 * KIB],
  ])('읽기 도중 abort(%s) → 그 조각을 보내지 않음(putChunk 추가 0, 영상 없음), 세션은 resumable, 다음 시도가 받은 바이트부터', async (_l, at) => {
    const a = adapter();
    const steps = memSteps();
    const ac = new AbortController();
    const g = gatedMedia(at);
    const ctx1 = ctxOf(steps, { signal: ac.signal, media: g.media });
    const p = send(a, snapshot(), ctx1);
    await g.reached;
    const putsAtAbort = a.api.calls.putChunk;
    ac.abort();
    g.release();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(a.api.calls.putChunk).toBe(putsAtAbort);
    expect(a.api.videosOf(USER)).toHaveLength(0);
    expect(steps.rows.find((s) => s.kind === 'upload_session')).toMatchObject({ status: 'created', received_bytes: at });
    expect(await a.reconcile(ref(ctx1.intentKey), ctx1)).toMatchObject({ status: 'resumable' });
    const r2 = await send(a, snapshot(), ctxOf(steps, { attempt: 2 }));
    expect(r2.status).toBe('processing');
    expect(a.api.calls.initResumable).toBe(1);
    expect(a.api.bytesSent).toBe(VIDEO.byteLength);
    expect(a.api.videosOf(USER)).toHaveLength(1);
    expect(a.api.videosOf(USER)[0]!.sha256).toBe(sha(VIDEO));
  });

  it('읽기 도중 lease 상실(heartbeat 실패) → LeaseLostError, 그 조각을 보내지 않음', async () => {
    const a = adapter();
    const steps = memSteps();
    const g = gatedMedia(64 * KIB);
    let lost = false;
    const ctx = ctxOf(steps, {
      media: g.media,
      heartbeat: async () => {
        if (lost) throw new LeaseLostError();
      },
    });
    const p = send(a, snapshot(), ctx);
    await g.reached;
    const puts = a.api.calls.putChunk;
    lost = true;
    g.release();
    await expect(p).rejects.toBeInstanceOf(LeaseLostError);
    expect(a.api.calls.putChunk).toBe(puts);
    expect(steps.rows.find((s) => s.kind === 'upload_session')!.received_bytes).toBe(64 * KIB);
  });

  it('읽기 도중 취소 요청 → 그 조각을 보내지 않고 canceled_before_upload_complete(영상 없음)', async () => {
    const a = adapter();
    const g = gatedMedia(3 * 64 * KIB);
    let canceled = false;
    const p = send(a, snapshot(), ctxOf(memSteps(), { media: g.media, cancelRequested: async () => canceled }));
    await g.reached;
    const puts = a.api.calls.putChunk;
    canceled = true;
    g.release();
    expect(await p).toMatchObject({ status: 'rejected', error_code: 'canceled_before_upload_complete' });
    expect(a.api.calls.putChunk).toBe(puts);
    expect(a.api.videosOf(USER)).toHaveLength(0);
  });

  it('rateUnitsRemaining: 단계 없음·마지막 세션 만료/오류 → 1, 유효할 수 있는 세션(created·finished)·영상 있음 → 0', () => {
    const a = adapter();
    const step = (kind: RemoteStep['kind'], post_index: number, status: RemoteStep['status']): RemoteStep => ({
      kind,
      post_index,
      status,
      remote_id: 'mock',
      step_index: 0,
      received_bytes: null,
      total_bytes: null,
      resume_count: 0,
      created_at: '',
      updated_at: '',
    });
    expect(a.rateUnitsRemaining(snapshot(), [])).toBe(1);
    expect(a.rateUnitsRemaining(snapshot(), [step('upload_session', 0, 'created')])).toBe(0);
    expect(a.rateUnitsRemaining(snapshot(), [step('upload_session', 0, 'finished')])).toBe(0);
    expect(a.rateUnitsRemaining(snapshot(), [step('upload_session', 0, 'expired')])).toBe(1);
    expect(a.rateUnitsRemaining(snapshot(), [step('upload_session', 0, 'error')])).toBe(1);
    expect(a.rateUnitsRemaining(snapshot(), [step('upload_session', 0, 'created'), step('upload_session', 1, 'expired')])).toBe(1);
    expect(a.rateUnitsRemaining(snapshot(), [step('upload_session', 0, 'expired'), step('video', 0, 'uploaded')])).toBe(0);
  });

  it('사전 검사 때 유효하던 세션이 보낼 때 만료 → 예약 단위 0 이면 새 세션을 만들지 않고 부작용 없이 닫음(다음 시도가 할당량 재검사)', async () => {
    const a = adapter();
    const steps = memSteps();
    const ctx1 = ctxOf(steps, { mockScenario: { scenario: 'youtube_network_drop', delay_ms: 0 } });
    expect((await send(a, snapshot(), ctx1)).status).toBe('ambiguous');
    a.api.expireSession(a.api.sessionUris(USER)[0]!);
    const r = await send(a, snapshot(), ctxOf(steps, { attempt: 2, rateUnitsReserved: 0 }));
    expect(r).toMatchObject({ status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'upload_session_requires_quota_check' });
    expect(a.api.calls.initResumable).toBe(1);
    expect(steps.rows.find((s) => s.kind === 'upload_session')!.status).toBe('expired');
    expect(a.rateUnitsRemaining(snapshot(), await steps.list())).toBe(1);
    const r3 = await send(a, snapshot(), ctxOf(steps, { attempt: 3, rateUnitsReserved: 1 }));
    expect(r3.status).toBe('processing');
    expect(a.api.calls.initResumable).toBe(2);
    expect(a.api.videosOf(USER)).toHaveLength(1);
  });

  it('조각 예산(web tick): 실행마다 조각 1개만 보내고 upload_yield(받은 바이트) → 같은 세션으로 이어 올려 끝까지, 합계 = 파일', async () => {
    const a = adapter();
    const steps = memSteps();
    const chunks = Math.ceil(VIDEO.byteLength / (64 * KIB));
    let last: Awaited<ReturnType<typeof send>> | null = null;
    for (let i = 1; i <= chunks; i++) {
      const before = a.api.calls.putChunk;
      last = await send(a, snapshot(), ctxOf(steps, { attempt: i, uploadSlice: { max_bytes: 1, max_ms: 60_000 } }));
      expect(a.api.calls.putChunk - before).toBe(1);
      if (i < chunks) {
        expect(last).toMatchObject({ status: 'processing', error_code: 'upload_slice_yield', upload_yield: { received_bytes: i * 64 * KIB, total_bytes: VIDEO.byteLength } });
        expect(last.external_id).toBeUndefined();
      }
    }
    expect(last).toMatchObject({ status: 'processing', external_id: expect.stringMatching(/^mock:youtube:mockyt_v_/) });
    expect(last!.upload_yield).toBeUndefined();
    expect(a.api.calls.initResumable).toBe(1);
    expect(a.api.bytesSent).toBe(VIDEO.byteLength);
    expect(a.api.videosOf(USER)[0]!.sha256).toBe(sha(VIDEO));
    // 시간 예산 0 이어도 최소 한 조각은 보낸다(진행 보장)
    const b = adapter();
    const r = await send(b, snapshot(), ctxOf(memSteps(), { uploadSlice: { max_bytes: Number.MAX_SAFE_INTEGER, max_ms: 0 } }));
    expect(r).toMatchObject({ status: 'processing', upload_yield: { received_bytes: 64 * KIB } });
    expect(b.api.calls.putChunk).toBe(1);
  });

  it('Q1 복합 장애: 마지막 조각 응답 유실 + 조회의 "만료" 장애 주입 → 완료 세션은 만료로 답하지 않음(영상 확인, 두 번째 영상 없음)', async () => {
    const a = adapter();
    const steps = memSteps();
    const ctx = ctxOf(steps, { mockScenario: { scenario: 'youtube_response_lost_after_complete', delay_ms: 0 } });
    expect((await send(a, snapshot(), ctx)).status).toBe('ambiguous');
    a.api.injectFault({ op: 'queryOffset', kind: 'session_expired', code: 'session_expired' });
    expect(await a.reconcile(ref(ctx.intentKey), ctx)).toMatchObject({ status: 'found' });
    const r2 = await send(a, snapshot(), ctxOf(steps, { attempt: 2 }));
    expect(r2.status).toBe('processing');
    expect(a.api.calls.initResumable).toBe(1);
    expect(a.api.videosOf(USER)).toHaveLength(1);
    // 끝나지 않은 세션에는 주입한 만료가 그대로(시험용 장애 경로 유지)
    const b = adapter();
    const s2 = memSteps();
    const c2 = ctxOf(s2, { mockScenario: { scenario: 'youtube_network_drop', delay_ms: 0 } });
    await send(b, snapshot(), c2);
    b.api.injectFault({ op: 'queryOffset', kind: 'session_expired', code: 'session_expired' });
    expect(await b.reconcile(ref(c2.intentKey), c2)).toMatchObject({ status: 'not_found' });
  });
});

describe('MockGoogleOAuthProvider(Google 형 모의 OAuth)', () => {
  const REDIRECT = 'http://localhost:3000/api/oauth/callback';
  const verifier = randomBytes(32).toString('base64url');
  function connect(store: MockOAuthStore) {
    const p = new MockGoogleOAuthProvider({ registeredRedirectUri: REDIRECT, appBaseUrl: 'http://localhost:3000', store });
    const u = new URL(p.buildAuthorizeUrl({ state: 's'.repeat(43), codeChallenge: codeChallengeS256(verifier), redirectUri: REDIRECT, scopes: YOUTUBE_REQUIRED_SCOPES, loginHint: USER }));
    const q = (k: string) => u.searchParams.get(k);
    const a = p.authorize(
      {
        client_id: q('client_id'),
        redirect_uri: q('redirect_uri'),
        response_type: q('response_type'),
        scope: q('scope'),
        state: q('state'),
        code_challenge: q('code_challenge'),
        code_challenge_method: q('code_challenge_method'),
        login_hint: q('login_hint'),
      },
      new Date(),
    );
    return { p, u, a };
  }

  it('동의 URL: 자리 표시 scope(youtube.upload(mock)) 만·S256·offline, 허용 밖 scope 거부', async () => {
    const store = new MockOAuthStore();
    const { u, a, p } = connect(store);
    expect(u.pathname).toBe('/api/oauth/mock-google/authorize');
    expect(u.searchParams.get('scope')).toBe('youtube.upload(mock)');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(a.ok).toBe(true);
    expect(p.authorize({ client_id: 'mock-google-client', redirect_uri: REDIRECT, response_type: 'code', scope: 'https://www.googleapis.com/auth/youtube', state: 'x', code_challenge: codeChallengeS256(verifier), code_challenge_method: 'S256', login_hint: USER }, new Date())).toEqual({
      ok: false,
      error: 'scope_not_allowed',
    });
  });

  it('교환: access(1시간, mockyt_at_) + refresh(180일, mockyt_rt_), PKCE 불일치 거부, 갱신은 회전(이전 묶음 무효), 철회는 묶음 전체', async () => {
    const store = new MockOAuthStore();
    const { p, a } = connect(store);
    const code = new URL((a as { redirect: string }).redirect).searchParams.get('code')!;
    const now = new Date();
    await expect(p.exchangeCode({ code, codeVerifier: randomBytes(32).toString('base64url'), redirectUri: REDIRECT, now })).rejects.toMatchObject({ code: 'pkce_mismatch' });
    const { a: a2, p: p2 } = connect(store);
    const code2 = new URL((a2 as { redirect: string }).redirect).searchParams.get('code')!;
    const t = await p2.exchangeCode({ code: code2, codeVerifier: verifier, redirectUri: REDIRECT, now });
    expect(t.accessToken).toMatch(/^mockyt_at_/);
    expect(t.refreshToken).toMatch(/^mockyt_rt_/);
    expect(t.accessExpiresAt!.getTime() - now.getTime()).toBe(3600_000);
    expect(t.expiresAt.getTime() - now.getTime()).toBe(180 * 24 * 3600_000);
    const check = mockGoogleTokenCheck(store);
    expect(check(t.accessToken, USER, now)).toBe(true);
    expect(check(t.accessToken, USER, new Date(now.getTime() + 3600_001))).toBe(false);
    // Threads 공급자는 Google 형 토큰을 모른다
    await expect(new MockThreadsOAuthProvider({ registeredRedirectUri: REDIRECT, appBaseUrl: 'http://localhost:3000', store }).accountInfo({ accessToken: t.accessToken, now })).rejects.toMatchObject({
      code: 'invalid_token',
    });
    const t2 = await p2.refresh({ tokens: { accessToken: t.accessToken, refreshToken: t.refreshToken }, now });
    expect(check(t.accessToken, USER, now)).toBe(false);
    await expect(p2.refresh({ tokens: { accessToken: t.accessToken, refreshToken: t.refreshToken }, now })).rejects.toMatchObject({ code: 'invalid_grant' });
    expect(check(t2.accessToken, USER, now)).toBe(true);
    await p2.revoke({ tokens: { accessToken: t2.accessToken, refreshToken: t2.refreshToken }, now });
    expect(check(t2.accessToken, USER, now)).toBe(false);
    await expect(p2.refresh({ tokens: { accessToken: t2.accessToken, refreshToken: t2.refreshToken }, now })).rejects.toMatchObject({ code: 'invalid_grant' });
  });
});
