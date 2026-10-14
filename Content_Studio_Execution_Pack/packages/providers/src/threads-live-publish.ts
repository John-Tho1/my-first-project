/**
 * LIVE-P1(결정 D38 1단계): 실제 Threads **텍스트** 게시 어댑터(ChannelAdapter, id 'live_threads'). 시험은 주입한 fetch(기록된 응답)로만 —
 * 이 파일을 쓰는 코드·시험 어디에서도 실제 네트워크 호출을 하지 않는다(실제 1건 게시 = D38 2단계, 별도 정확 범위 승인).
 *
 * 공식 문서(2026-10-13 열람, 출처·인용은 .handoffs/LIVEP1_IMPLEMENTATION_HANDOFF.md):
 * - 컨테이너: POST https://graph.threads.net/v1.0/{threads-user-id}/threads (media_type=TEXT, text) → { id }.
 * - 게시: POST https://graph.threads.net/v1.0/{threads-user-id}/threads_publish (creation_id) → { id }(미디어 ID).
 *   게시 전 평균 30초 기다림을 권장 → 기다리는 대신 컨테이너 상태(GET /{container-id}?fields=status,error_message — IN_PROGRESS·FINISHED·
 *   PUBLISHED·ERROR·EXPIRED, 24시간 뒤 EXPIRED)가 FINISHED 일 때만 게시한다. 아직 처리 중이면 processing(REMOTE_PROCESSING) — 나중에 같은 컨테이너로.
 * - 확인: GET /{threads-media-id}?fields=id,permalink,text,timestamp,media_type · 목록 GET /{threads-user-id}/threads?fields=…&limit=.
 *   미디어 객체에 공개 범위 필드가 없다 → remote_visibility 'unknown'("Threads 계정 공개 설정을 따름").
 * - 인증: 문서 예시는 POST 의 access_token 을 **form 본문**에, GET 은 **질의 문자열**에 둔다. Authorization: Bearer 헤더는 Threads 문서에서
 *   확인하지 못했다(제3자 글만 있음) → 문서대로 쓴다(보수적 선택). 그래서 URL 에 토큰이 있을 수 있다 — URL·요청·응답 본문·공급자 메시지는
 *   기록·직렬화·오류에 넣지 않는다(LIVE-T1 threads-live-oauth.ts 와 같은 규칙: https + 허용 호스트, redirect:'error', 시간 제한, 원 오류 버림).
 *
 * 결과 불명 규칙(AGENTS 불변식·docs/03):
 * - 컨테이너 생성은 게시물을 만들지 않는다(auto_publish_text 를 보내지 않음) — 생성 실패는 "보내지 않음"(부작용 없는 일시 오류·확정 실패).
 * - threads_publish 직전에 remote_steps 에 publish_attempt('threads:pa:<컨테이너 ID>', 컨테이너마다 하나 — DB unique)를 남긴다.
 *   이 표식이 있으면 **절대 같은 컨테이너로 다시 게시하지 않는다**: 게시 중·뒤 시간 초과·5xx·전송 실패·429 는 결과 불명(RECONCILING) →
 *   조회는 계정의 최근 글 목록에서 "정확히 같은 본문 + 시도 시각 이후" 글을 찾고, 정확히 하나면 확인(found), 아니면 unknown → UNKNOWN(사용자 확인).
 * - 표식이 없고 컨테이너가 FINISHED 면 게시하지 않았음이 확실하다 → resumable(같은 컨테이너로 이어 게시, 새 컨테이너 없음).
 */
import {
  isAllowedThreadsPermalink,
  isThreadsNumericId,
  LeaseLostError,
  LIVE_PUBLISH_BUDGET_MARGIN_MS,
  LIVE_THREADS_ADAPTER_ID,
  liveThreadsExternalId,
  liveThreadsStepId,
  liveThreadsStepRaw,
  THREADS_LIVE_TEXT_MAX,
  sanitizeThreadsDiag,
  threadsDiagFromBody,
  threadsTextUnits,
  type ThreadsDiag,
  type AdapterAccount,
  type AdapterCapabilities,
  type AdapterContext,
  type AdapterResult,
  type CancelResult,
  type ChannelAdapter,
  type ChannelRateLimit,
  type PreparedSubmission,
  type PublishSnapshot,
  type ReconcileResult,
  type RemoteReference,
  type RemoteStep,
  type RemoteStepKind,
} from '@cs/domain';
import { normalizeThreadsErrorBody, parseRetryAfterSec, THREADS_TRANSIENT_CODES, THREADS_API_HOSTS } from './threads-live-oauth';
import { threadPostsOf } from './threads-mock';

export const THREADS_GRAPH_BASE = 'https://graph.threads.net/v1.0';
export const LIVE_PUBLISH_HTTP_TIMEOUT_MS = 10_000;
/** 한 번의 submit 안에서 컨테이너 상태를 묻는 횟수(넘으면 processing — 다음 조회가 같은 컨테이너로) */
export const LIVE_PUBLISH_POLL_BUDGET = 3;
export const LIVE_PUBLISH_POLL_INTERVAL_MS = 1500;
/** 결과 불명 대조: 목록에서 볼 최근 글 수(문서 예시 limit 매개변수) */
export const LIVE_PUBLISH_LIST_LIMIT = 25;
/**
 * 결과 불명 확인 후보: 게시 시도 기록 시각 앞뒤 허용(시계 차이). FIX-LIVEP1(Codex P0): 후보일 뿐 확인이 아니다 — 시도 전에 손으로 올린 같은 글을
 * 덜 고르도록 좁게(2분) 둔다. FIX2-LIVEP1: 창 = [시도 −2분, 시도 +2분](재확인 시각과 무관).
 */
export const LIVE_PUBLISH_MATCH_SKEW_MS = 2 * 60_000;
/** FIX-LIVEP1(Codex 놓친 케이스 "큰 스트리밍 응답"): 응답 본문 상한(바이트) — 읽는 도중에 넘으면 읽기를 취소한다(전부 메모리에 올린 뒤 검사하지 않음) */
export const MAX_RESPONSE_BYTES = 512 * 1024;

/** 공식 게시 한도(문서: 24시간 이동 창 250 게시물, threads_publishing_limit 예시 quota_total 250·quota_duration 86400). */
export const THREADS_LIVE_RATE_LIMIT: ChannelRateLimit = {
  max_units: 250,
  window_sec: 24 * 3600,
  checked_at: '2026-10-13',
  api_version: 'v1.0',
  source: 'https://developers.facebook.com/docs/threads/overview (Publishing limits — 250 API-published posts / 24h)',
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Op = 'create' | 'status' | 'publish' | 'read' | 'list';

/** 게이트(실제 게시 환경 조건) — 호출 시점에 다시 본다. 레지스트리가 livePublishReadiness(config) 로 넣는다. */
export type LivePublishGate = () => { ready: boolean; missing: string[] };

export interface LiveThreadsPublishOptions {
  gate: LivePublishGate;
  fetch?: FetchLike;
  timeoutMs?: number;
  pollBudget?: number;
  pollIntervalMs?: number;
  listLimit?: number;
}

/**
 * 공급자 호출 오류 — 메시지는 단계·이유만(URL·토큰·본문·공급자 문구 없음). 원 오류(cause)는 붙이지 않는다.
 */
export class LiveThreadsApiError extends Error {
  readonly op: Op;
  readonly httpStatus: number | null;
  /** 전송 실패(응답 없음) */
  readonly transport: 'network' | 'timeout' | null;
  readonly codes: number[];
  readonly transient: boolean;
  readonly rateLimited: boolean;
  readonly retryAfterSec: number | undefined;
  readonly malformed: boolean;
  /** LIVEP1-DIAG: 허용 목록 진단(숫자·짧은 열거만 — 문구·URL·토큰 없음). 결과·작업 이력으로 나간다. */
  readonly diag: ThreadsDiag | null;
  constructor(init: {
    op: Op;
    diag?: ThreadsDiag | null;
    httpStatus?: number | null;
    transport?: 'network' | 'timeout' | null;
    codes?: number[];
    transient?: boolean;
    rateLimited?: boolean;
    retryAfterSec?: number;
    malformed?: boolean;
    reason: string;
  }) {
    super(`live threads api error: ${init.op}/${init.reason}`);
    this.name = 'LiveThreadsApiError';
    this.op = init.op;
    this.httpStatus = init.httpStatus ?? null;
    this.transport = init.transport ?? null;
    this.codes = init.codes ?? [];
    this.transient = init.transient ?? false;
    this.rateLimited = init.rateLimited ?? false;
    this.retryAfterSec = init.retryAfterSec;
    this.malformed = init.malformed ?? false;
    this.diag =
      init.diag !== undefined
        ? sanitizeThreadsDiag(init.diag)
        : sanitizeThreadsDiag({ op: init.op, http_status: init.httpStatus ?? undefined, transport: init.transport ?? undefined, code: init.codes?.length === 1 ? init.codes[0] : undefined });
  }
  /** 직렬화해도 숫자·열거만 */
  toJSON(): Record<string, unknown> {
    return { name: this.name, op: this.op, httpStatus: this.httpStatus, transport: this.transport, codes: this.codes, transient: this.transient, diag: this.diag };
  }
}

/** 오류 판정(공급자 문구는 보지 않는다 — 숫자 코드·상태·is_transient 만). */
export type LiveErrorVerdict = 'transient' | 'rate_limited' | 'auth' | 'permission' | 'invalid' | 'unknown';
export function liveErrorVerdict(e: LiveThreadsApiError): LiveErrorVerdict {
  if (e.transport) return 'transient';
  if (e.rateLimited) return 'rate_limited';
  if (e.transient) return 'transient';
  if (e.malformed) return 'unknown';
  const s = e.httpStatus ?? 0;
  if (s >= 500 || s === 408) return 'transient';
  if (e.codes.includes(190) || e.codes.includes(102) || s === 401) return 'auth';
  if (e.codes.some((c) => c === 10 || (c >= 200 && c <= 299)) || s === 403) return 'permission';
  if (s === 400 && e.codes.length === 1 && e.codes[0] === 100) return 'invalid';
  return 'unknown';
}

/**
 * 오류 → 어댑터 결과.
 * - create(컨테이너 생성 — 게시물 없음): 일시·제한·알 수 없음 → 부작용 없는 일시 오류(재시도), 인증 → auth(BLOCKED), 권한·형식 → permanent.
 * - publish(게시 시도 표식 뒤): 인증 → auth, 권한·형식(확정 거절) → permanent, 그 밖(시간 초과·전송·5xx·429·알 수 없음) → 결과 불명(조회, 재게시 없음).
 */
export function classifyLivePublishError(e: unknown, op: 'create' | 'publish'): AdapterResult {
  if (!(e instanceof LiveThreadsApiError)) {
    return op === 'create'
      ? { status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'container_adapter_error' }
      : { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'publish_adapter_error' };
  }
  const v = liveErrorVerdict(e);
  const prefix = op === 'create' ? 'container' : 'publish';
  // LIVEP1-DIAG: 판정만 남기면 원인을 알 수 없다(D38 2단계 container_permission_denied) — 허용 목록 진단을 결과에 함께 싣는다.
  const d = e.diag ? { provider_diag: e.diag } : {};
  if (v === 'auth') return { status: 'rejected', retry_class: 'auth', error_code: `${prefix}_auth_invalid_token`, ...d };
  if (v === 'permission') return { status: 'rejected', retry_class: 'permanent', error_code: `${prefix}_permission_denied`, ...d };
  if (v === 'invalid') return { status: 'rejected', retry_class: 'permanent', error_code: `${prefix}_invalid_parameter`, ...d };
  if (op === 'create') {
    if (v === 'unknown' && e.httpStatus !== null && e.httpStatus >= 400 && e.httpStatus < 500) {
      return { status: 'rejected', retry_class: 'permanent', error_code: 'container_rejected', ...d };
    }
    return {
      status: 'rejected',
      retry_class: 'transient_no_side_effect',
      error_code: v === 'rate_limited' ? 'container_rate_limited' : e.transport ? `container_${e.transport}` : 'container_server_error',
      ...(v === 'rate_limited' ? { retry_after_sec: e.retryAfterSec ?? 60 } : {}),
      ...d,
    };
  }
  return {
    status: 'ambiguous',
    retry_class: 'transient_unknown_side_effect',
    error_code: e.transport ? `publish_${e.transport}` : v === 'rate_limited' ? 'publish_rate_limited' : v === 'transient' ? 'publish_server_error' : 'publish_unknown_error',
    ...d,
  };
}

/** LIVEP1-DIAG: 오류에서 진단만 꺼낸다(우리 오류가 아니면 없음). */
const diagOf = (e: unknown): { provider_diag?: ThreadsDiag } => (e instanceof LiveThreadsApiError && e.diag ? { provider_diag: e.diag } : {});

const isAbort = (e: unknown): boolean =>
  !!e && typeof e === 'object' && ((e as { name?: unknown }).name === 'TimeoutError' || (e as { name?: unknown }).name === 'AbortError');

function abortError(): Error {
  const e = new Error('live threads submit aborted');
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

/** 본문 대조용 정규화: NFC, 줄바꿈 \r\n → \n, 앞뒤 공백 제거(그 밖은 그대로 — 정확히 같은 글만). */
export function normalizeThreadsText(s: string): string {
  return s.normalize('NFC').replace(/\r\n?/g, '\n').trim();
}

/** Threads 시각 "2023-10-17T05:42:03+0000"(문서 예시) → ms. 형식이 다르면 null. */
export function parseThreadsTimestamp(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/.exec(v);
  if (!m) return null;
  const off = m[3] === 'Z' ? 'Z' : `${m[3]!.slice(0, 3)}:${m[3]!.slice(-2)}`;
  const t = Date.parse(`${m[1]}${m[2] ?? ''}${off}`);
  return Number.isFinite(t) ? t : null;
}

/**
 * FIX-LIVEP1: 응답 본문을 조각으로 읽으며 바이트 상한을 지킨다 — 넘으면 읽기를 취소(reader.cancel)하고 body_too_large. 전체를 먼저 메모리에 올리지 않는다.
 * 읽는 도중 끊김·중단은 전송 실패(timeout·network)로 본다.
 */
async function readCapped(res: Response, op: Op): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw new LiveThreadsApiError({ op, httpStatus: res.status, malformed: true, reason: 'body_too_large' });
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new LiveThreadsApiError({ op, httpStatus: res.status, malformed: true, reason: 'body_too_large' });
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof LiveThreadsApiError) throw e;
    throw new LiveThreadsApiError({ op, httpStatus: res.status, transport: isAbort(e) ? 'timeout' : 'network', reason: 'body_unreadable' });
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder('utf-8').decode(all);
}

type ContainerStatus = 'IN_PROGRESS' | 'FINISHED' | 'PUBLISHED' | 'ERROR' | 'EXPIRED';
const CONTAINER_STATUSES: ReadonlySet<string> = new Set(['IN_PROGRESS', 'FINISHED', 'PUBLISHED', 'ERROR', 'EXPIRED']);

export class LiveThreadsPublishAdapter implements ChannelAdapter {
  readonly kind = 'live' as const;
  readonly id = LIVE_THREADS_ADAPTER_ID;
  /** 조회 판정이 remote_steps 에 기댄다 — 복원한 작업의 not_found 는 믿지 않는다(작업 처리기가 unknown 으로). */
  readonly usesRemoteSteps = true;
  /** 요청 제한 사용량 = 게시 시도 표식 수(결과 불명 시도도 원격 한도를 썼을 수 있으므로 센다) */
  readonly rateStepKinds: readonly RemoteStepKind[] = ['publish_attempt'];
  readonly #gate: LivePublishGate;
  readonly #fetch: FetchLike | null;
  readonly #timeoutMs: number;
  readonly #pollBudget: number;
  readonly #pollIntervalMs: number;
  readonly #listLimit: number;
  readonly #tokens = new WeakMap<PreparedSubmission, string>();
  /** 호출 수(시험 관찰) — 토큰·URL 없음 */
  readonly calls = { prepare: 0, submit: 0, reconcile: 0, cancel: 0, http: 0 };

  constructor(opts: LiveThreadsPublishOptions) {
    this.#gate = opts.gate;
    this.#fetch = opts.fetch ?? null;
    this.#timeoutMs = opts.timeoutMs ?? LIVE_PUBLISH_HTTP_TIMEOUT_MS;
    this.#pollBudget = Math.max(1, opts.pollBudget ?? LIVE_PUBLISH_POLL_BUDGET);
    this.#pollIntervalMs = Math.max(0, opts.pollIntervalMs ?? LIVE_PUBLISH_POLL_INTERVAL_MS);
    this.#listLimit = Math.min(Math.max(1, opts.listLimit ?? LIVE_PUBLISH_LIST_LIMIT), 100);
  }

  toJSON(): Record<string, unknown> {
    return { id: this.id, kind: this.kind };
  }

  capabilities(_account: AdapterAccount): AdapterCapabilities {
    return {
      read: true,
      cancel: false,
      definitive_not_found: true,
      mock: false,
      adapter: LIVE_THREADS_ADAPTER_ID,
      media: false,
      text: {
        max_post_chars: THREADS_LIVE_TEXT_MAX,
        max_posts: 1,
        unit: 'threads_text_unit',
        checked_at: '2026-10-13',
        api_version: 'v1.0',
        source: 'https://developers.facebook.com/docs/threads/posts (500 characters, emoji = UTF-8 bytes)',
      },
      rate_limit: { ...THREADS_LIVE_RATE_LIMIT },
    };
  }

  rateUnits(_snapshot: PublishSnapshot): number {
    return 1;
  }

  /** 게시 시도 표식이 있으면 이 작업은 원격 한도 단위를 이미 썼다(다시 게시하지 않으므로 새 단위 없음). */
  rateUnitsRemaining(_snapshot: PublishSnapshot, steps: readonly RemoteStep[]): number {
    return steps.some((s) => s.kind === 'publish_attempt') ? 0 : 1;
  }

  validate(snapshot: PublishSnapshot): { ok: true } | { ok: false; error_code: string } {
    const acc = snapshot.account;
    if (acc.kind !== 'live') return { ok: false, error_code: 'not_live_account' };
    if (snapshot.channel !== 'threads' || acc.platform !== 'threads') return { ok: false, error_code: 'channel_not_supported' };
    if (!isThreadsNumericId(acc.external_account_id)) return { ok: false, error_code: 'account_not_bound' };
    if ((snapshot.payload as { provider_account_id?: unknown }).provider_account_id !== acc.external_account_id) return { ok: false, error_code: 'account_mismatch' };
    if (snapshot.requested_result !== 'public_publish') return { ok: false, error_code: 'requested_result_not_supported' };
    if (snapshot.visibility !== 'public') return { ok: false, error_code: 'visibility_not_supported' };
    const assets = (snapshot.payload as { assets?: unknown }).assets;
    if (!Array.isArray(assets) || assets.length > 0) return { ok: false, error_code: 'media_not_supported_live' };
    const posts = threadPostsOf(snapshot);
    if (posts.length !== 1) return { ok: false, error_code: 'thread_not_supported_live' };
    const text = posts[0]!;
    if (text.trim() === '') return { ok: false, error_code: 'text_empty' };
    if (threadsTextUnits(text) > THREADS_LIVE_TEXT_MAX) return { ok: false, error_code: 'text_too_long' };
    return { ok: true };
  }

  async prepare(snapshot: PublishSnapshot, ctx: AdapterContext): Promise<PreparedSubmission> {
    this.calls.prepare++;
    const data: Record<string, unknown> = { live: true, platform: 'threads', adapter: LIVE_THREADS_ADAPTER_ID, posts: 1 };
    const prepared: PreparedSubmission = { snapshot, data };
    // 토큰은 서버(작업 처리기)에서 T13 연결 정보(봉인 해제)로만 받는다 — PreparedSubmission.data·결과·오류에 넣지 않는다(WeakMap).
    let r: { ok: true; token: string } | { ok: false; code: string };
    try {
      r = ctx.credential ? await ctx.credential.accessToken() : { ok: false, code: 'credential_unavailable' };
    } catch {
      r = { ok: false, code: 'credential_unavailable' };
    }
    if (r.ok) this.#tokens.set(prepared, r.token);
    else data.blocked = r.code;
    return prepared;
  }

  /** 부작용(원격 쓰기) 직전: lease·중단 확인 */
  async #beforeWrite(ctx: AdapterContext): Promise<void> {
    await ctx.heartbeat();
    if (ctx.signal.aborted) throw abortError();
  }

  async submit(prepared: PreparedSubmission, ctx: AdapterContext): Promise<AdapterResult> {
    this.calls.submit++;
    const gate = this.#gate();
    // 두 번째 방어선(전송 의도 전에 작업 처리기가 이미 검사) — 보내지 않고 보류(BLOCKED), 사용자가 조건을 갖춘 뒤 재시도.
    if (!gate.ready) return { status: 'rejected', retry_class: 'auth', error_code: 'live_publish_not_ready' };
    const blocked = prepared.data.blocked;
    if (typeof blocked === 'string') return { status: 'rejected', retry_class: 'auth', error_code: blocked };
    const token = this.#tokens.get(prepared);
    if (!token) return { status: 'rejected', retry_class: 'auth', error_code: 'credential_unavailable' };
    if (!ctx.steps) return { status: 'rejected', retry_class: 'permanent', error_code: 'steps_unavailable' };
    const snap = prepared.snapshot;
    const valid = this.validate(snap);
    if (!valid.ok) return { status: 'rejected', retry_class: 'permanent', error_code: valid.error_code };
    const steps = ctx.steps;
    const userId = snap.account.external_account_id;
    const text = threadPostsOf(snap)[0]!;
    const recorded = await steps.list();
    const find = (kind: RemoteStepKind) => recorded.find((s) => s.kind === kind && s.post_index === 0) ?? null;

    const pub = find('publish');
    if (pub) {
      // 이미 게시됨(앞 시도) — 다시 게시하지 않고 확인만
      const mediaId = liveThreadsStepRaw(pub.remote_id);
      if (!mediaId) return { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'publish_step_malformed' };
      return this.#confirmed(mediaId, text, token, ctx);
    }
    if (find('publish_attempt')) {
      // 결과를 모르는 게시 시도가 있다 — 같은 컨테이너로 다시 게시하지 않는다(조회·사용자 확인만).
      return { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'publish_attempt_unresolved' };
    }
    let ct = find('container');
    if (ct && ct.status === 'error') return { status: 'rejected', retry_class: 'permanent', error_code: 'container_error' };
    if (!ct) {
      await this.#beforeWrite(ctx);
      let containerId: string;
      try {
        const body = await this.#call('create', 'POST', `${THREADS_GRAPH_BASE}/${userId}/threads`, token, ctx.signal, { media_type: 'TEXT', text });
        const id = body.id;
        if (!isThreadsNumericId(id)) throw new LiveThreadsApiError({ op: 'create', malformed: true, reason: 'malformed_response', transient: true });
        containerId = id;
      } catch (e) {
        if (e instanceof LeaseLostError) throw e;
        return classifyLivePublishError(e, 'create');
      }
      // 다음 원격 호출 전에 참조를 남긴다(짧은 트랜잭션).
      ct = await steps.record({ kind: 'container', post_index: 0, remote_id: liveThreadsStepId.container(containerId), status: 'created' });
    }
    const containerId = liveThreadsStepRaw(ct.remote_id);
    if (!containerId) return { status: 'rejected', retry_class: 'permanent', error_code: 'container_step_malformed' };
    if (ct.status !== 'finished') {
      let status: ContainerStatus = 'IN_PROGRESS';
      for (let polls = 0; polls < this.#pollBudget; polls++) {
        if (polls > 0 && this.#pollIntervalMs > 0) await sleep(this.#pollIntervalMs, ctx.signal);
        await ctx.heartbeat();
        try {
          status = await this.#containerStatus(containerId, token, ctx.signal);
        } catch (e) {
          if (e instanceof LeaseLostError) throw e;
          // 읽기 실패는 부작용이 없다 — 인증만 그대로(BLOCKED), 나머지는 조회로(컨테이너 참조는 남아 있고 게시 시도 표식은 없다).
          const d = diagOf(e);
          if (e instanceof LiveThreadsApiError && liveErrorVerdict(e) === 'auth') return { status: 'rejected', retry_class: 'auth', error_code: 'status_auth_invalid_token', ...d };
          return { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'container_status_unreadable', ...d };
        }
        if (status !== 'IN_PROGRESS') break;
      }
      if (status === 'IN_PROGRESS') return { status: 'processing', error_code: 'container_in_progress' };
      if (status === 'PUBLISHED') {
        // 게시 시도 표식 없이 원격이 게시됐다고 한다(있을 수 없는 상태) — 다시 게시하지 않고 조회로(UNKNOWN 가능)
        return { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'container_published_without_attempt' };
      }
      if (status === 'ERROR' || status === 'EXPIRED') {
        // 게시하지 않은 컨테이너가 실패·만료됨 — 게시물은 없다(게시 시도 없음). 새 컨테이너는 만들지 않는다(게시물당 컨테이너 1개) → 확정 실패.
        await steps.record({ kind: 'container', post_index: 0, remote_id: ct.remote_id, status: 'error' });
        return { status: 'rejected', retry_class: 'permanent', error_code: status === 'ERROR' ? 'container_error' : 'container_expired' };
      }
      await steps.record({ kind: 'container', post_index: 0, remote_id: ct.remote_id, status: 'finished' });
    }
    // LIVEP1-TIMEOUT: 표식을 쓰기 전에 남은 시간 확인 — 게시 호출 시간 제한 + 여유보다 적으면 표식·게시 없이 멈춘다(보내지 않음 → 재시도 시
    // 같은 컨테이너로 이어 게시). 마감이 표식과 threads_publish 사이에서 터져 결과 불명이 되는 것을 앞 단계 지연 때문에 만들지 않는다.
    if (ctx.deadline !== undefined && ctx.deadline - Date.now() < this.#timeoutMs + LIVE_PUBLISH_BUDGET_MARGIN_MS) {
      return { status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'publish_budget_insufficient' };
    }
    // 게시: lease 확인 → 시도 표식(컨테이너마다 하나 — DB unique) → 바로 threads_publish. 표식 기록이 실패하면 게시하지 않는다(예외 → 조회).
    await this.#beforeWrite(ctx);
    try {
      // FIX-LIVEP1(Codex 놓친 케이스 "기존 표식 반환 뒤 재전송"): 새 표식을 만든 실행만 게시한다(createOnly — 이미 있으면 409, 기존 행을 돌려주지 않음).
      await steps.record({ kind: 'publish_attempt', post_index: 0, remote_id: liveThreadsStepId.publishAttempt(containerId), status: 'created', createOnly: true });
    } catch (e) {
      if (e && typeof e === 'object' && (e as { code?: unknown }).code === 'remote_step_exists') {
        return { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'publish_attempt_exists' };
      }
      throw e;
    }
    let mediaId: string;
    try {
      const body = await this.#call('publish', 'POST', `${THREADS_GRAPH_BASE}/${userId}/threads_publish`, token, ctx.signal, { creation_id: containerId });
      const id = body.id;
      if (!isThreadsNumericId(id)) throw new LiveThreadsApiError({ op: 'publish', malformed: true, reason: 'malformed_response' });
      mediaId = id;
    } catch (e) {
      if (e instanceof LeaseLostError) throw e;
      return classifyLivePublishError(e, 'publish');
    }
    // 게시됨 — 기록(실패하면 예외 → 결과 불명 → 조회가 목록 대조로 찾는다)
    await steps.record({ kind: 'publish', post_index: 0, remote_id: liveThreadsStepId.publish(mediaId), status: 'published' });
    return this.#confirmed(mediaId, text, token, ctx);
  }

  /** 게시된 미디어를 읽어 확인(ID·본문·링크). 읽기 실패는 게시 사실을 바꾸지 않는다 — 미검증(UNVERIFIED)으로 남긴다. */
  async #confirmed(mediaId: string, text: string, token: string, ctx: AdapterContext): Promise<AdapterResult> {
    const base: AdapterResult = { status: 'accepted', result_kind: 'PUBLISHED', remote_visibility: 'unknown', external_id: liveThreadsExternalId(mediaId), verified: false };
    try {
      const body = await this.#call('read', 'GET', `${THREADS_GRAPH_BASE}/${mediaId}`, token, ctx.signal, { fields: 'id,permalink,text,timestamp,media_type' });
      const permalink = isAllowedThreadsPermalink(body.permalink) ? body.permalink : undefined;
      const sameText = typeof body.text === 'string' && normalizeThreadsText(body.text) === normalizeThreadsText(text);
      return { ...base, ...(permalink ? { permalink } : {}), verified: body.id === mediaId && sameText && !!permalink };
    } catch (e) {
      if (e instanceof LeaseLostError) throw e;
      return { ...base, error_code: 'readback_failed', ...diagOf(e) };
    }
  }

  /**
   * 읽기 전용 조회(원격에 쓰지 않는다 — 찾은 게시 ID 를 단계 기록에 남기는 것만). 실제 게시 환경 조건이 없으면 네트워크 없이 unknown.
   * - 단계 없음 → not_found(게시는 기록된 컨테이너 + 시도 표식 뒤에만 한다 — 확실히 게시물 없음)
   * - 게시 기록 → found(읽어서 확인되면 verified)
   * - 시도 표식 없음: 컨테이너 FINISHED → resumable · IN_PROGRESS → processing · ERROR/EXPIRED → failed(게시물 없음) · PUBLISHED·읽기 실패 → unknown
   * - 시도 표식 있음·게시 기록 없음: FIX-LIVEP1(Codex P0) — 컨테이너·시도와 미디어를 잇는 확정 증거가 없으므로 **항상 unknown**(게시 단계·결과·VERIFIED 를
   *   만들지 않음, 재게시 없음). 최근 글 목록에서 같은 본문·시도 시각 ±2분 글이 정확히 하나이고 목록이 끝까지 왔을 때만(받은 수 < limit) 그 글을
   *   **확인 후보**(candidate — 미확인)로 돌려준다. 사용자가 Threads 에서 직접 확인한다.
   */
  async reconcile(_reference: RemoteReference, ctx: AdapterContext): Promise<ReconcileResult> {
    this.calls.reconcile++;
    if (!this.#gate().ready) return { status: 'unknown', error_code: 'live_publish_not_ready' };
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
    if (!isThreadsNumericId(userId)) return { status: 'unknown', error_code: 'account_not_bound' };
    const text = threadPostsOf(snap)[0] ?? '';
    const find = (kind: RemoteStepKind) => recorded.find((s) => s.kind === kind && s.post_index === 0) ?? null;
    const pub = find('publish');
    if (pub) {
      const mediaId = liveThreadsStepRaw(pub.remote_id);
      if (!mediaId) return { status: 'unknown', error_code: 'publish_step_malformed' };
      const r = await this.#confirmed(mediaId, text, token, ctx);
      return { status: 'found', result_kind: 'PUBLISHED', remote_visibility: 'unknown', external_id: r.external_id, verified: r.verified === true, ...(r.permalink ? { permalink: r.permalink } : {}), published_parts: 1 };
    }
    const ct = find('container');
    if (!ct) return { status: 'unknown', error_code: 'container_step_missing' };
    const containerId = liveThreadsStepRaw(ct.remote_id);
    if (!containerId) return { status: 'unknown', error_code: 'container_step_malformed' };
    const attempt = find('publish_attempt');
    if (!attempt) {
      if (ct.status === 'error') return { status: 'failed', error_code: 'container_error' };
      let status: ContainerStatus;
      try {
        status = await this.#containerStatus(containerId, token, ctx.signal);
      } catch (e) {
        return { status: 'unknown', error_code: 'container_status_unreadable', ...diagOf(e) };
      }
      if (status === 'FINISHED') {
        if (ct.status === 'created') await ctx.steps.record({ kind: 'container', post_index: 0, remote_id: ct.remote_id, status: 'finished' });
        return { status: 'resumable', published_parts: 0, error_code: 'container_not_published' };
      }
      if (status === 'IN_PROGRESS') return { status: 'processing', published_parts: 0, error_code: 'container_in_progress' };
      if (status === 'ERROR' || status === 'EXPIRED') {
        await ctx.steps.record({ kind: 'container', post_index: 0, remote_id: ct.remote_id, status: 'error' });
        return { status: 'failed', error_code: status === 'ERROR' ? 'container_error' : 'container_expired' };
      }
      return { status: 'unknown', error_code: 'container_published_without_attempt' };
    }
    // 결과 불명 게시 시도 — 목록은 확인 후보만 찾는다(확정 아님)
    // FIX2-LIVEP1(Codex P2 :536): 창의 두 끝 모두 게시 시도 표식 시각에 고정한다 — [시도 −2분, 시도 +2분](경계 포함). 재확인이 늦어져도 넓어지지 않는다.
    const attemptAt = Date.parse(attempt.created_at);
    if (!Number.isFinite(attemptAt)) return { status: 'unknown', error_code: 'publish_attempt_time_unreadable' };
    const since = attemptAt - LIVE_PUBLISH_MATCH_SKEW_MS;
    const until = attemptAt + LIVE_PUBLISH_MATCH_SKEW_MS;
    let list: Record<string, unknown>;
    try {
      list = await this.#call('list', 'GET', `${THREADS_GRAPH_BASE}/${userId}/threads`, token, ctx.signal, {
        fields: 'id,permalink,text,timestamp,media_type',
        limit: String(this.#listLimit),
      });
    } catch (e) {
      return { status: 'unknown', error_code: 'list_unreadable', ...diagOf(e) };
    }
    const data = Array.isArray(list.data) ? (list.data as unknown[]) : null;
    if (!data) return { status: 'unknown', error_code: 'list_malformed' };
    const want = normalizeThreadsText(text);
    const matches = data.filter((d): d is Record<string, unknown> => {
      if (!d || typeof d !== 'object') return false;
      const o = d as Record<string, unknown>;
      const at = parseThreadsTimestamp(o.timestamp);
      return isThreadsNumericId(o.id) && typeof o.text === 'string' && normalizeThreadsText(o.text) === want && at !== null && at >= since && at <= until;
    });
    if (matches.length === 0) return { status: 'unknown', error_code: 'publish_unconfirmed_no_candidate' };
    if (matches.length > 1) return { status: 'unknown', error_code: 'publish_unconfirmed_candidates_ambiguous' };
    // 목록이 한 쪽에 다 들어오지 않았으면(받은 수 = limit) 다음 쪽에 같은 글이 더 있을 수 있다 — 후보 하나라고 말하지 않는다.
    // FIX2-LIVEP1(Codex 놓친 케이스): 받은 수 < limit 이어도 paging.next 가 있으면 다음 쪽이 있다 — 불완전.
    const paging = list.paging && typeof list.paging === 'object' ? (list.paging as Record<string, unknown>) : null;
    const hasNext = !!paging && paging.next !== undefined && paging.next !== null && paging.next !== '';
    if (data.length >= this.#listLimit || hasNext) return { status: 'unknown', error_code: 'publish_unconfirmed_list_incomplete' };
    const m = matches[0]!;
    const permalink = isAllowedThreadsPermalink(m.permalink) ? m.permalink : undefined;
    return {
      status: 'unknown',
      error_code: 'publish_unconfirmed_candidate',
      candidate: { external_id: liveThreadsExternalId(m.id as string), ...(permalink ? { permalink } : {}) },
    };
  }

  /** 이 흐름으로는 게시를 되돌리지 않는다(삭제는 별도 명령·승인 — docs/03). */
  async cancel(_reference: RemoteReference, _ctx: AdapterContext): Promise<CancelResult> {
    this.calls.cancel++;
    return { status: 'unsupported', error_code: 'threads_cancel_unsupported' };
  }

  async #containerStatus(containerId: string, token: string, signal: AbortSignal): Promise<ContainerStatus> {
    const body = await this.#call('status', 'GET', `${THREADS_GRAPH_BASE}/${containerId}`, token, signal, { fields: 'status,error_message' });
    const s = body.status;
    if (typeof s !== 'string' || !CONTAINER_STATUSES.has(s)) throw new LiveThreadsApiError({ op: 'status', malformed: true, reason: 'malformed_response' });
    return s as ContainerStatus;
  }

  /**
   * 공급자 호출 하나. POST 는 access_token 을 form 본문에(문서 예시), GET 은 질의에. URL·토큰·본문은 어디에도 남기지 않는다.
   * 실패는 새 LiveThreadsApiError(숫자·열거만) — 원 오류·공급자 문구는 버린다.
   */
  async #call(op: Op, method: 'GET' | 'POST', base: string, token: string, signal: AbortSignal, params: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(base);
    if (url.protocol !== 'https:' || !THREADS_API_HOSTS.has(url.hostname) || url.username || url.password || url.port) {
      throw new LiveThreadsApiError({ op, reason: 'host_not_allowed', malformed: true });
    }
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) (method === 'GET' ? url.searchParams : form).set(k, v);
    (method === 'GET' ? url.searchParams : form).set('access_token', token);
    const init: RequestInit = {
      method,
      headers: method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } : { accept: 'application/json' },
      ...(method === 'POST' ? { body: form.toString() } : {}),
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(this.#timeoutMs), signal]),
    };
    const f: FetchLike = this.#fetch ?? ((i, o) => globalThis.fetch(i, o));
    this.calls.http++;
    let res: Response;
    try {
      res = await f(url.toString(), init);
    } catch (e) {
      // 원 오류는 버린다(cause 에 URL — 질의의 토큰 — 이 있을 수 있다)
      throw new LiveThreadsApiError({ op, transport: isAbort(e) ? 'timeout' : 'network', reason: isAbort(e) ? 'timeout' : 'network' });
    }
    const text = await readCapped(res, op);
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const n = normalizeThreadsErrorBody(body);
    const isObj = !!body && typeof body === 'object' && !Array.isArray(body);
    const hasSuccess = isObj && ('id' in (body as object) || 'data' in (body as object) || 'status' in (body as object));
    if (!res.ok || (n !== null && !hasSuccess)) {
      const codes = n?.codes ?? [];
      const transientCodes = codes.map((c) => THREADS_TRANSIENT_CODES.get(c)).filter((x) => x !== undefined);
      const rateLimited = res.status === 429 || transientCodes.includes('rate_limited');
      const retryAfterSec = rateLimited ? parseRetryAfterSec({ retryAfter: res.headers.get('retry-after'), businessUseCaseUsage: res.headers.get('x-business-use-case-usage') }) : undefined;
      throw new LiveThreadsApiError({
        op,
        httpStatus: res.status,
        // LIVEP1-DIAG: 본문에서 허용 목록 필드만(문구 필드는 읽지 않음)
        diag: threadsDiagFromBody(op, res.status, body),
        codes,
        transient: transientCodes.length > 0 || n?.isTransientFlag === true,
        rateLimited,
        retryAfterSec,
        malformed: !!n?.malformedCode || (!res.ok && res.status < 400),
        reason: rateLimited ? 'rate_limited' : `http_${res.status}`,
      });
    }
    if (!isObj) throw new LiveThreadsApiError({ op, httpStatus: res.status, malformed: true, reason: 'malformed_response' });
    return body as Record<string, unknown>;
  }
}
