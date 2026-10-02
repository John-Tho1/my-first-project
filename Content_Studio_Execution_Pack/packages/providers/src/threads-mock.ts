/**
 * T14(결정 D26) Threads 모의 채널 — 프로세스 안 시뮬레이터 + ChannelAdapter. **네트워크·실제 Threads/Meta 호출 없음.**
 *
 * ThreadsMockApi(시뮬레이터): docs/03 의 Threads 게시 흐름(컨테이너 생성 → threads_publish)을 흉내 낸다.
 * - createContainer → { id: 'mockthr_ct_<uuid>', status } · getContainer(상태 IN_PROGRESS → FINISHED, 몇 번 조회 뒤 끝날지 프로그램 가능)
 *   · publish(creation_id) → { id: 'mockthr_post_<uuid>' } · getPost → { permalink: 'mock://threads/<id>' } · findPublishedByContainer.
 * - 사용자별 게시 예산(남은 수, 넘으면 rate_limited + retry-after 초), 오류 종류(auth_invalid_token 401, permission_denied 403,
 *   invalid_parameter 400, not_found 404, rate_limited 429, server_error 5xx(side_effect none|unknown), timeout).
 * - 토큰은 T13 모의 OAuth 공급자가 발급한 것만 받는다(같은 프로세스의 mockOAuthStore — 해제·만료·다른 사용자 토큰은 401).
 *   토큰은 오류 메시지·호출 기록 어디에도 남기지 않는다.
 * - 같은 컨테이너를 두 번 게시하면 두 번째는 거절(invalid_parameter container_already_published) — 게시물이 두 개 생기지 않는다(모의 가정, D26 질문).
 *
 * ThreadsMockChannelAdapter(adapter id 'mock_threads'): 선택 규칙은 @cs/domain adapterIdFor(모의 + threads + credential_state ≠ none).
 * - 게시물마다 [컨테이너 생성 → 단계 기록 → FINISHED 까지 조회 → 게시 → 단계 기록]. 스레드는 앞 게시물의 게시 ID 에 답글로 이어 붙인다(순서대로).
 *   **원격 참조는 다음 원격 호출 전에 기록**(ctx.steps — 작업 처리기의 짧은 트랜잭션). 재개·재확인은 기록을 먼저 읽고 이미 만든 컨테이너를
 *   다시 만들지 않으며 이미 게시된 게시물은 다시 게시하지 않는다(A08).
 * - 조회 예산 안에 FINISHED 가 안 되면 processing(→ REMOTE_PROCESSING) — 다음 조회가 같은 컨테이너로 이어 간다(새 컨테이너 없음).
 * - 토큰은 prepare 에서 ctx.credential(T13 봉인 해제, 서버 안)로 받아 WeakMap 에만 둔다 — PreparedSubmission.data·결과·오류에 없다.
 * - 오류 분류: 401 → auth(BLOCKED), 403·400 → permanent, 429 → 부작용 없는 일시 오류(Retry-After), 5xx side_effect none → 일시 오류,
 *   5xx side_effect unknown·timeout → 결과 불명(RECONCILING).
 * - 결과는 모의(MOCK): publication external_id = 'mock:threads:<게시 ID>'(publications CHECK 'mock:%'), permalink = 'mock://threads/<게시 ID>'.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  cpLength,
  isThreadsMockScenario,
  LeaseLostError,
  THREADS_MAX,
  THREADS_MAX_PARTS,
  type AdapterAccount,
  type AdapterCapabilities,
  type AdapterContext,
  type AdapterResult,
  type CancelResult,
  type ChannelAdapter,
  type ChannelRateLimit,
  type MockScenarioValue,
  type PreparedSubmission,
  type PublishSnapshot,
  type ReconcileResult,
  type RemoteReference,
  type RemoteStep,
  type RemoteVisibility,
} from '@cs/domain';
import { mockOAuthStore, type MockOAuthStore } from './oauth';

// ---- 시뮬레이터 ----

export const THREADS_MOCK_CONTAINER_PREFIX = 'mockthr_ct_';
export const THREADS_MOCK_POST_PREFIX = 'mockthr_post_';

export const THREADS_ERROR_KINDS = ['auth_invalid_token', 'permission_denied', 'invalid_parameter', 'not_found', 'rate_limited', 'server_error', 'timeout'] as const;
export type ThreadsErrorKind = (typeof THREADS_ERROR_KINDS)[number];
export const THREADS_ERROR_HTTP: Record<ThreadsErrorKind, number | null> = {
  auth_invalid_token: 401,
  permission_denied: 403,
  invalid_parameter: 400,
  not_found: 404,
  rate_limited: 429,
  server_error: 503,
  timeout: null,
};

export type ThreadsContainerStatus = 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED' | 'PUBLISHED';
export type ThreadsOp = 'createContainer' | 'getContainer' | 'publish' | 'getPost' | 'findPublishedByContainer';

/** 시뮬레이터 오류 — 메시지는 종류·코드만(토큰·본문 없음). */
export class ThreadsMockApiError extends Error {
  readonly httpStatus: number | null;
  constructor(
    readonly kind: ThreadsErrorKind,
    readonly opts: { code?: string; sideEffect?: 'none' | 'unknown'; retryAfterSec?: number } = {},
  ) {
    super(`mock threads api error: ${kind}${opts.code ? ` (${opts.code})` : ''}`);
    this.name = 'ThreadsMockApiError';
    this.httpStatus = THREADS_ERROR_HTTP[kind];
  }
  get code(): string {
    return this.opts.code ?? this.kind;
  }
  /** 호출자에게 알려지는 부작용 여부(timeout 은 항상 unknown) */
  get sideEffect(): 'none' | 'unknown' {
    if (this.kind === 'timeout') return 'unknown';
    return this.opts.sideEffect ?? 'none';
  }
}

/** 한 번 일어나는 장애. applied = 원격은 동작을 끝낸 뒤 응답이 실패(응답 유실·쓰기 뒤 5xx). */
export interface ThreadsFault {
  op: ThreadsOp;
  kind: ThreadsErrorKind;
  applied?: boolean;
  sideEffect?: 'none' | 'unknown';
  retryAfterSec?: number;
  code?: string;
  /** 이 사용자 호출에만(없으면 누구든) */
  userId?: string;
}

interface Container {
  id: string;
  userId: string;
  text: string;
  replyToId: string | null;
  status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED';
  pollsLeft: number;
  publishedPostId: string | null;
  createdAt: string;
}

export interface ThreadsMockPost {
  id: string;
  userId: string;
  containerId: string;
  text: string;
  replyToId: string | null;
  permalink: string;
  timestamp: string;
}

const sha = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');

export type ThreadsTokenCheck = (accessToken: string, userId: string, now: Date) => boolean;

/** T13 모의 OAuth 공급자의 발급 토큰인지(해제·만료 아님, 같은 사용자). */
export function mockOAuthTokenCheck(store: MockOAuthStore = mockOAuthStore()): ThreadsTokenCheck {
  return (accessToken, userId, now) => {
    if (typeof accessToken !== 'string' || !accessToken.startsWith('mockthr_at_')) return false;
    const t = store.tokens.get(sha(accessToken));
    return !!t && !t.revoked && t.expiresAt > now.getTime() && t.user === userId;
  };
}

export class ThreadsMockApi {
  private readonly containers = new Map<string, Container>();
  private readonly posts = new Map<string, ThreadsMockPost>();
  private readonly budgets = new Map<string, { remaining: number; retryAfterSec: number }>();
  private faults: ThreadsFault[] = [];
  private tokenCheck: ThreadsTokenCheck;
  /** 호출 수(시험 관찰 — 인수는 남기지 않는다) */
  readonly calls: Record<ThreadsOp, number> = { createContainer: 0, getContainer: 0, publish: 0, getPost: 0, findPublishedByContainer: 0 };
  /** 컨테이너별로 게시물을 만든 게시 수(설계상 항상 ≤ 1) */
  readonly publishCount = new Map<string, number>();

  constructor(opts: { tokenCheck?: ThreadsTokenCheck } = {}) {
    this.tokenCheck = opts.tokenCheck ?? mockOAuthTokenCheck();
  }

  setTokenCheck(check: ThreadsTokenCheck): void {
    this.tokenCheck = check;
  }

  /** 사용자별 남은 게시 예산(0 이면 다음 게시는 rate_limited). 없으면 무제한. */
  setRateBudget(userId: string, remaining: number, retryAfterSec = 60): void {
    this.budgets.set(userId, { remaining, retryAfterSec });
  }

  clearRateBudget(userId: string): void {
    this.budgets.delete(userId);
  }

  /** 한 번 일어나는 장애를 큐에 넣는다(시험). */
  injectFault(f: ThreadsFault): void {
    this.faults.push({ ...f });
  }

  /** 컨테이너를 만료시킨다(시험 — 게시되지 않은 것만). */
  expireContainer(id: string): void {
    const c = this.containers.get(id);
    if (c && !c.publishedPostId) c.status = 'EXPIRED';
  }

  /** 전부 비운다("재시작" 흉내 — 이전 컨테이너·게시물을 모른다). 토큰 검사는 유지. */
  reset(): void {
    this.containers.clear();
    this.posts.clear();
    this.budgets.clear();
    this.faults = [];
    this.publishCount.clear();
    for (const k of Object.keys(this.calls) as ThreadsOp[]) this.calls[k] = 0;
  }

  containerIds(userId?: string): string[] {
    return [...this.containers.values()].filter((c) => !userId || c.userId === userId).map((c) => c.id);
  }

  postsOf(userId?: string): ThreadsMockPost[] {
    return [...this.posts.values()].filter((p) => !userId || p.userId === userId).map((p) => ({ ...p }));
  }

  private auth(accessToken: string, userId: string, now: Date): void {
    if (!this.tokenCheck(accessToken, userId, now)) throw new ThreadsMockApiError('auth_invalid_token');
  }

  private takeFault(op: ThreadsOp, userId: string, given?: ThreadsFault | null): ThreadsFault | null {
    if (given && given.op === op) return given;
    const i = this.faults.findIndex((f) => f.op === op && (!f.userId || f.userId === userId));
    if (i < 0) return null;
    return this.faults.splice(i, 1)[0]!;
  }

  private fail(f: ThreadsFault): never {
    throw new ThreadsMockApiError(f.kind, { code: f.code, sideEffect: f.sideEffect, retryAfterSec: f.retryAfterSec });
  }

  /** 장애가 있으면: applied 가 아니면 동작 전에 실패, applied 면 동작 뒤 실패. */
  private run<T>(f: ThreadsFault | null, action: () => T): T {
    if (f && !f.applied) this.fail(f);
    const out = action();
    if (f) this.fail(f);
    return out;
  }

  createContainer(
    req: { userId: string; text: string; replyToId?: string | null; accessToken: string; now?: Date },
    opts: { fault?: ThreadsFault | null; finishAfterPolls?: number } = {},
  ): { id: string; status: ThreadsContainerStatus } {
    this.calls.createContainer++;
    const now = req.now ?? new Date();
    this.auth(req.accessToken, req.userId, now);
    const f = this.takeFault('createContainer', req.userId, opts.fault);
    return this.run(f, () => {
      if (typeof req.text !== 'string' || req.text.length === 0 || cpLength(req.text) > THREADS_MAX) {
        throw new ThreadsMockApiError('invalid_parameter', { code: 'text_too_long' });
      }
      const replyTo = req.replyToId ?? null;
      if (replyTo) {
        const p = this.posts.get(replyTo);
        if (!p || p.userId !== req.userId) throw new ThreadsMockApiError('invalid_parameter', { code: 'invalid_reply_to' });
      }
      const polls = Math.max(0, Math.floor(opts.finishAfterPolls ?? 0));
      const c: Container = {
        id: `${THREADS_MOCK_CONTAINER_PREFIX}${randomUUID()}`,
        userId: req.userId,
        text: req.text,
        replyToId: replyTo,
        status: polls > 0 ? 'IN_PROGRESS' : 'FINISHED',
        pollsLeft: polls,
        publishedPostId: null,
        createdAt: now.toISOString(),
      };
      this.containers.set(c.id, c);
      return { id: c.id, status: c.status };
    });
  }

  private ownContainer(id: string, userId: string): Container {
    const c = this.containers.get(id);
    if (!c || c.userId !== userId) throw new ThreadsMockApiError('not_found', { code: 'container_not_found' });
    return c;
  }

  /** 상태 조회. IN_PROGRESS 는 남은 조회 수만큼 계속되고 그다음 FINISHED. 게시된 컨테이너는 PUBLISHED. */
  getContainer(req: { id: string; userId: string; accessToken: string; now?: Date }, opts: { fault?: ThreadsFault | null } = {}): { id: string; status: ThreadsContainerStatus } {
    this.calls.getContainer++;
    this.auth(req.accessToken, req.userId, req.now ?? new Date());
    const f = this.takeFault('getContainer', req.userId, opts.fault);
    return this.run(f, () => {
      const c = this.ownContainer(req.id, req.userId);
      if (c.publishedPostId) return { id: c.id, status: 'PUBLISHED' as const };
      if (c.status === 'IN_PROGRESS') {
        if (c.pollsLeft > 0) {
          c.pollsLeft--;
          return { id: c.id, status: 'IN_PROGRESS' as const };
        }
        c.status = 'FINISHED';
      }
      return { id: c.id, status: c.status };
    });
  }

  publish(req: { userId: string; creationId: string; accessToken: string; now?: Date }, opts: { fault?: ThreadsFault | null } = {}): { id: string } {
    this.calls.publish++;
    const now = req.now ?? new Date();
    this.auth(req.accessToken, req.userId, now);
    const f = this.takeFault('publish', req.userId, opts.fault);
    return this.run(f, () => {
      const c = this.ownContainer(req.creationId, req.userId);
      if (c.publishedPostId) throw new ThreadsMockApiError('invalid_parameter', { code: 'container_already_published' });
      if (c.status === 'IN_PROGRESS' && c.pollsLeft > 0) throw new ThreadsMockApiError('invalid_parameter', { code: 'container_not_ready' });
      if (c.status === 'ERROR' || c.status === 'EXPIRED') throw new ThreadsMockApiError('invalid_parameter', { code: `container_${c.status.toLowerCase()}` });
      const budget = this.budgets.get(req.userId);
      if (budget && budget.remaining <= 0) throw new ThreadsMockApiError('rate_limited', { retryAfterSec: budget.retryAfterSec });
      if (budget) budget.remaining--;
      c.status = 'FINISHED';
      const id = `${THREADS_MOCK_POST_PREFIX}${randomUUID()}`;
      const post: ThreadsMockPost = {
        id,
        userId: req.userId,
        containerId: c.id,
        text: c.text,
        replyToId: c.replyToId,
        permalink: `mock://threads/${id}`,
        timestamp: now.toISOString(),
      };
      this.posts.set(id, post);
      c.publishedPostId = id;
      this.publishCount.set(c.id, (this.publishCount.get(c.id) ?? 0) + 1);
      return { id };
    });
  }

  getPost(req: { id: string; userId: string; accessToken: string; now?: Date }, opts: { fault?: ThreadsFault | null } = {}): { id: string; permalink: string; timestamp: string } {
    this.calls.getPost++;
    this.auth(req.accessToken, req.userId, req.now ?? new Date());
    const f = this.takeFault('getPost', req.userId, opts.fault);
    return this.run(f, () => {
      const p = this.posts.get(req.id);
      if (!p || p.userId !== req.userId) throw new ThreadsMockApiError('not_found', { code: 'post_not_found' });
      return { id: p.id, permalink: p.permalink, timestamp: p.timestamp };
    });
  }

  /** 조회(재확인): 이 컨테이너로 만든 게시물. 컨테이너를 모르면 not_found 오류(재시작 등 — "없음"이라고 단정하지 않는다). */
  findPublishedByContainer(
    req: { creationId: string; userId: string; accessToken: string; now?: Date },
    opts: { fault?: ThreadsFault | null } = {},
  ): { id: string; permalink: string; timestamp: string } | null {
    this.calls.findPublishedByContainer++;
    this.auth(req.accessToken, req.userId, req.now ?? new Date());
    const f = this.takeFault('findPublishedByContainer', req.userId, opts.fault);
    return this.run(f, () => {
      const c = this.ownContainer(req.creationId, req.userId);
      if (!c.publishedPostId) return null;
      const p = this.posts.get(c.publishedPostId)!;
      return { id: p.id, permalink: p.permalink, timestamp: p.timestamp };
    });
  }
}

const globalForThreads = globalThis as typeof globalThis & { __contentStudioThreadsMockApi?: ThreadsMockApi };

/** 프로세스당 하나(web 과 inline worker 가 같은 모의 Threads 를 본다). */
export function threadsMockApi(): ThreadsMockApi {
  if (!globalForThreads.__contentStudioThreadsMockApi) globalForThreads.__contentStudioThreadsMockApi = new ThreadsMockApi();
  return globalForThreads.__contentStudioThreadsMockApi;
}

/** 시험용: 프로세스 싱글턴을 버린다(재시작 흉내). */
export function resetThreadsMockApi(): void {
  globalForThreads.__contentStudioThreadsMockApi = undefined;
}

// ---- 어댑터 ----

export const THREADS_ADAPTER_ID = 'mock_threads' as const;

/** 잠정 요청 제한(공식 한도를 사실로 고정하지 않는다 — docs/03, D19-d, D24). 확인일·API 버전 없음. */
export const THREADS_PROVISIONAL_RATE_LIMIT: ChannelRateLimit = {
  max_units: 250,
  window_sec: 24 * 3600,
  checked_at: null,
  api_version: null,
  source: 'provisional — 공식 자료 재확인 필요(D19-d, D24)',
};

/** 조회 예산(한 번의 submit 안에서 컨테이너 상태를 묻는 횟수). 넘으면 processing(REMOTE_PROCESSING). */
export const THREADS_POLL_BUDGET = 3;

export interface ThreadsAdapterOptions {
  api?: ThreadsMockApi;
  pollBudget?: number;
  pollIntervalMs?: number;
  rateLimit?: ChannelRateLimit;
}

function abortError(): Error {
  const e = new Error('mock threads submit aborted');
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

/** payload.text.posts(승인 스냅샷의 스레드 게시물) */
export function threadPostsOf(snapshot: Pick<PublishSnapshot, 'payload'>): string[] {
  const text = (snapshot.payload as { text?: { posts?: unknown } }).text;
  const posts = text?.posts;
  return Array.isArray(posts) ? posts.map((p) => (typeof p === 'string' ? p : '')) : [];
}

const publicationId = (postId: string) => `mock:threads:${postId}`;

/** 시뮬레이터 오류 → 어댑터 결과(docs/03 분류). 토큰은 어디에도 넣지 않는다. */
export function classifyThreadsError(e: unknown, op: ThreadsOp): AdapterResult {
  if (!(e instanceof ThreadsMockApiError)) {
    return { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'adapter_error' };
  }
  switch (e.kind) {
    case 'auth_invalid_token':
      return { status: 'rejected', retry_class: 'auth', error_code: 'auth_invalid_token' };
    case 'permission_denied':
      return { status: 'rejected', retry_class: 'permanent', error_code: 'permission_denied' };
    case 'invalid_parameter':
      // 이미 게시된 컨테이너 — 게시는 원격에 있다. 조회로 확인한다(다시 보내지 않음).
      if (e.code === 'container_already_published') return { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: e.code };
      return { status: 'rejected', retry_class: 'permanent', error_code: e.code === 'invalid_parameter' ? 'invalid_parameter' : `invalid_parameter:${e.code}` };
    case 'not_found':
      // 게시할 컨테이너를 원격이 모른다(재시작 등) — 원격 사실을 단정하지 않고 조회로.
      return { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: e.code };
    case 'rate_limited':
      return { status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'rate_limited', retry_after_sec: e.opts.retryAfterSec ?? 60 };
    case 'server_error':
      // "모든 5xx 무조건 재시도 금지"(docs/03): 부작용 불명이면 조회, 부작용 없음이 확실할 때만 재시도. 읽기(op)는 부작용이 없다.
      return e.sideEffect === 'unknown' && (op === 'createContainer' || op === 'publish')
        ? { status: 'rejected', retry_class: 'transient_unknown_side_effect', error_code: 'server_error_side_effect_unknown' }
        : { status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'server_error' };
    case 'timeout':
    default:
      return { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'timeout' };
  }
}

export class ThreadsMockChannelAdapter implements ChannelAdapter {
  readonly kind = 'mock' as const;
  readonly id = THREADS_ADAPTER_ID;
  readonly api: ThreadsMockApi;
  pollBudget: number;
  pollIntervalMs: number;
  rateLimit: ChannelRateLimit;
  /** 호출 수(시험 관찰) */
  readonly calls = { prepare: 0, submit: 0, reconcile: 0, cancel: 0 };
  private readonly tokens = new WeakMap<PreparedSubmission, string>();

  constructor(opts: ThreadsAdapterOptions = {}) {
    this.api = opts.api ?? threadsMockApi();
    this.pollBudget = opts.pollBudget ?? THREADS_POLL_BUDGET;
    this.pollIntervalMs = opts.pollIntervalMs ?? 0;
    this.rateLimit = opts.rateLimit ?? { ...THREADS_PROVISIONAL_RATE_LIMIT };
  }

  capabilities(_account: AdapterAccount): AdapterCapabilities {
    return {
      read: true,
      cancel: false,
      definitive_not_found: true,
      mock: true,
      adapter: THREADS_ADAPTER_ID,
      media: false,
      text: {
        max_post_chars: THREADS_MAX,
        max_posts: THREADS_MAX_PARTS,
        unit: 'code_point',
        checked_at: null,
        api_version: null,
        source: 'provisional — channel.ts 잠정값, 공식 자료 재확인 필요(D14, D24)',
      },
      rate_limit: { ...this.rateLimit },
    };
  }

  rateUnits(snapshot: PublishSnapshot): number {
    return threadPostsOf(snapshot).length;
  }

  validate(snapshot: PublishSnapshot): { ok: true } | { ok: false; error_code: string } {
    if (snapshot.account.kind !== 'mock' || !snapshot.account.external_account_id.startsWith('mock:')) return { ok: false, error_code: 'not_mock_account' };
    if (snapshot.requested_result !== 'mock_publish') return { ok: false, error_code: 'mock_only' };
    if (snapshot.channel !== 'threads' || snapshot.account.platform !== 'threads') return { ok: false, error_code: 'channel_not_supported' };
    const assets = (snapshot.payload as { assets?: unknown }).assets;
    if (Array.isArray(assets) && assets.length > 0) return { ok: false, error_code: 'media_not_supported_t14' };
    const posts = threadPostsOf(snapshot);
    if (posts.length === 0 || posts.length > THREADS_MAX_PARTS) return { ok: false, error_code: 'invalid_parameter' };
    if (posts.some((p) => p.length === 0 || cpLength(p) > THREADS_MAX)) return { ok: false, error_code: 'invalid_parameter' };
    return { ok: true };
  }

  async prepare(snapshot: PublishSnapshot, ctx: AdapterContext): Promise<PreparedSubmission> {
    this.calls.prepare++;
    const data: Record<string, unknown> = { mock: true, platform: 'threads', adapter: THREADS_ADAPTER_ID, posts: threadPostsOf(snapshot).length };
    const prepared: PreparedSubmission = { snapshot, data };
    // 토큰은 서버(작업 처리기)에서 T13 연결 정보로만 얻는다. 쓸 수 없으면 원격 호출 없이 auth 로 닫는다(fail closed).
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
    return s && isThreadsMockScenario(s) ? s : 'threads_success';
  }

  /** 시나리오 → 이번 호출의 장애(첫 시도에서만 — 재개·재시도는 정상 동작; 400 은 매번). 시나리오는 시뮬레이터만 바꾼다. */
  private faultFor(
    scenario: MockScenarioValue,
    op: ThreadsOp,
    postIndex: number,
    total: number,
    attempt: number,
  ): { fault?: ThreadsFault; finishAfterPolls?: number } {
    if (scenario === 'threads_text_too_long') {
      return op === 'createContainer' && postIndex === 0 ? { fault: { op, kind: 'invalid_parameter', code: 'text_too_long' } } : {};
    }
    if (attempt !== 1) return {};
    switch (scenario) {
      case 'threads_container_slow':
        return op === 'createContainer' && postIndex === 0 ? { finishAfterPolls: this.pollBudget } : {};
      case 'threads_publish_timeout_sent':
        return op === 'publish' && postIndex === 0 ? { fault: { op, kind: 'timeout', applied: true } } : {};
      case 'threads_publish_timeout_not_sent':
        return op === 'publish' && postIndex === 0 ? { fault: { op, kind: 'timeout', applied: false } } : {};
      case 'threads_thread_partial':
        return op === 'publish' && postIndex === Math.min(2, total - 1) ? { fault: { op, kind: 'server_error', sideEffect: 'unknown', applied: false } } : {};
      case 'threads_rate_limited':
        return op === 'createContainer' && postIndex === 0 ? { fault: { op, kind: 'rate_limited', retryAfterSec: 5 } } : {};
      case 'threads_token_invalid':
        return op === 'createContainer' && postIndex === 0 ? { fault: { op, kind: 'auth_invalid_token' } } : {};
      default:
        return {};
    }
  }

  /** 부작용(원격 쓰기) 직전: lease·중단 확인(FIX-T11 P0 와 같은 규칙). */
  private async beforeWrite(ctx: AdapterContext): Promise<void> {
    await ctx.heartbeat();
    if (ctx.signal.aborted) throw abortError();
  }

  private visibilityOf(snapshot: PublishSnapshot): { remote_visibility: RemoteVisibility; result_kind: 'PUBLISHED' | 'UPLOADED_PRIVATE' } {
    // 모의 가정(D26): 원격 공개 범위 = 승인한 공개 범위. 실제 Threads 의 공개 범위(프로필 설정)는 live 전에 확인한다.
    return snapshot.visibility === 'public'
      ? { remote_visibility: 'public', result_kind: 'PUBLISHED' }
      : { remote_visibility: snapshot.visibility === 'unlisted' ? 'unlisted' : 'private', result_kind: snapshot.visibility === 'unlisted' ? 'PUBLISHED' : 'UPLOADED_PRIVATE' };
  }

  async submit(prepared: PreparedSubmission, ctx: AdapterContext): Promise<AdapterResult> {
    this.calls.submit++;
    const snap = prepared.snapshot;
    const blocked = prepared.data.blocked;
    if (typeof blocked === 'string') return { status: 'rejected', retry_class: 'auth', error_code: blocked };
    const token = this.tokens.get(prepared);
    if (!token) return { status: 'rejected', retry_class: 'auth', error_code: 'credential_unavailable' };
    if (!ctx.steps) return { status: 'rejected', retry_class: 'permanent', error_code: 'steps_unavailable' };
    const steps = ctx.steps;
    const userId = snap.account.external_account_id;
    const posts = threadPostsOf(snap);
    const scenario = this.scenario(ctx);
    const requestId = `mock-thr-req:${randomUUID()}`;
    const delay = ctx.mockScenario?.delay_ms ?? 0;
    if (delay > 0) await sleep(delay, ctx.signal);
    const recorded = await steps.list();
    const find = (kind: RemoteStep['kind'], i: number) => recorded.find((s) => s.kind === kind && s.post_index === i) ?? null;
    let prevPostId: string | null = null;
    for (let i = 0; i < posts.length; i++) {
      const pub = find('publish', i);
      if (pub) {
        prevPostId = pub.remote_id; // 이미 게시됨 — 다시 게시하지 않는다
        continue;
      }
      let ct = find('container', i);
      if (ct && ct.status === 'error') return { status: 'rejected', retry_class: 'permanent', error_code: 'container_error', provider_request_id: requestId };
      if (!ct) {
        await this.beforeWrite(ctx);
        let created: { id: string; status: ThreadsContainerStatus };
        try {
          const f = this.faultFor(scenario, 'createContainer', i, posts.length, ctx.attempt);
          created = this.api.createContainer({ userId, text: posts[i]!, replyToId: prevPostId, accessToken: token, now: ctx.now }, f);
        } catch (e) {
          if (e instanceof LeaseLostError) throw e;
          return { ...classifyThreadsError(e, 'createContainer'), provider_request_id: requestId };
        }
        // 다음 원격 호출 전에 참조를 남긴다(짧은 트랜잭션).
        ct = await steps.record({ kind: 'container', post_index: i, remote_id: created.id, status: created.status === 'FINISHED' ? 'finished' : 'created' });
      }
      if (ct.status !== 'finished') {
        let polls = 0;
        let status: ThreadsContainerStatus = 'IN_PROGRESS';
        while (polls < this.pollBudget) {
          if (polls > 0 && this.pollIntervalMs > 0) await sleep(this.pollIntervalMs, ctx.signal);
          await ctx.heartbeat();
          polls++;
          try {
            status = this.api.getContainer({ id: ct.remote_id, userId, accessToken: token, now: ctx.now }).status;
          } catch (e) {
            if (e instanceof LeaseLostError) throw e;
            const r = classifyThreadsError(e, 'getContainer');
            // 읽기 실패는 부작용이 없다 — 인증만 그대로, 나머지는 조회로 넘긴다(컨테이너 참조는 남아 있다).
            return r.retry_class === 'auth' ? { ...r, provider_request_id: requestId } : { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: `poll_${r.error_code}`, provider_request_id: requestId };
          }
          if (status !== 'IN_PROGRESS') break;
        }
        if (status === 'IN_PROGRESS') {
          // 원격이 아직 처리 중 — 같은 컨테이너로 나중에 이어 간다(REMOTE_PROCESSING, 새 컨테이너 없음).
          return { status: 'processing', provider_request_id: requestId, error_code: 'container_in_progress', ...this.visibilityOf(snap) };
        }
        if (status === 'PUBLISHED') {
          // 이전 시도의 게시가 원격에 있다 — 다시 게시하지 않고 조회로 확인한다.
          return { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'container_already_published', provider_request_id: requestId };
        }
        if (status !== 'FINISHED') {
          await steps.record({ kind: 'container', post_index: i, remote_id: ct.remote_id, status: 'error' });
          return { status: 'rejected', retry_class: 'permanent', error_code: `container_${status.toLowerCase()}`, provider_request_id: requestId };
        }
        ct = await steps.record({ kind: 'container', post_index: i, remote_id: ct.remote_id, status: 'finished' });
      }
      await this.beforeWrite(ctx);
      let published: { id: string };
      try {
        const f = this.faultFor(scenario, 'publish', i, posts.length, ctx.attempt);
        published = this.api.publish({ userId, creationId: ct.remote_id, accessToken: token, now: ctx.now }, f);
      } catch (e) {
        if (e instanceof LeaseLostError) throw e;
        return { ...classifyThreadsError(e, 'publish'), provider_request_id: requestId };
      }
      await steps.record({ kind: 'publish', post_index: i, remote_id: published.id, status: 'published' });
      prevPostId = published.id;
    }
    const firstId = (await steps.list()).find((s) => s.kind === 'publish' && s.post_index === 0)?.remote_id;
    if (!firstId) return { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'first_post_missing', provider_request_id: requestId };
    let permalink: string;
    try {
      permalink = this.api.getPost({ id: firstId, userId, accessToken: token, now: ctx.now }).permalink;
    } catch {
      // 모두 게시됐고 단계가 기록됐다 — 링크만 못 읽음. 조회가 링크와 함께 확인한다.
      return { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'permalink_unavailable', provider_request_id: requestId };
    }
    return { status: 'accepted', external_id: publicationId(firstId), permalink, provider_request_id: requestId, ...this.visibilityOf(snap) };
  }

  /**
   * 읽기 전용 조회(원격에 쓰지 않는다 — 찾은 게시 ID 를 단계 기록에 남기는 것만). 판정:
   * - 단계 기록 없음 → not_found(게시는 기록된 컨테이너로만 하므로 게시되지 않았음이 확실; 기록 전 응답 유실로 생긴 컨테이너는 게시되지 않은 채 남는다).
   * - 게시물마다: 게시 기록 있음 → 게시됨 / 컨테이너가 PUBLISHED → 게시 ID 를 찾아 기록 / FINISHED·게시 없음 → resumable(같은 컨테이너로 이어서)
   *   / IN_PROGRESS → processing / 컨테이너 기록 없음 → resumable(그 게시물부터 새 컨테이너) / 모름·만료·오류·읽기 실패 → unknown(맹목 재게시 없음).
   * - 모두 게시됨 → found(첫 게시물 링크).
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
    const posts = threadPostsOf(snap);
    const find = (kind: RemoteStep['kind'], i: number) => recorded.find((s) => s.kind === kind && s.post_index === i) ?? null;
    let published = 0;
    let firstId: string | null = null;
    for (let i = 0; i < posts.length; i++) {
      const pub = find('publish', i);
      if (pub) {
        published++;
        if (i === 0) firstId = pub.remote_id;
        continue;
      }
      const ct = find('container', i);
      if (!ct) return { status: 'resumable', published_parts: published, error_code: 'container_not_created' };
      let status: ThreadsContainerStatus;
      try {
        status = this.api.getContainer({ id: ct.remote_id, userId, accessToken: token, now: ctx.now }).status;
      } catch (e) {
        return { status: 'unknown', error_code: e instanceof ThreadsMockApiError ? `container_${e.code}` : 'adapter_error' };
      }
      if (status === 'IN_PROGRESS') return { status: 'processing', published_parts: published, error_code: 'container_in_progress' };
      if (status === 'PUBLISHED' || status === 'FINISHED') {
        let post: { id: string } | null;
        try {
          post = this.api.findPublishedByContainer({ creationId: ct.remote_id, userId, accessToken: token, now: ctx.now });
        } catch (e) {
          return { status: 'unknown', error_code: e instanceof ThreadsMockApiError ? `find_${e.code}` : 'adapter_error' };
        }
        if (post) {
          await ctx.steps.record({ kind: 'publish', post_index: i, remote_id: post.id, status: 'published' });
          published++;
          if (i === 0) firstId = post.id;
          continue;
        }
        if (status === 'PUBLISHED') return { status: 'unknown', error_code: 'published_post_missing' };
        if (ct.status === 'created') await ctx.steps.record({ kind: 'container', post_index: i, remote_id: ct.remote_id, status: 'finished' });
        // 컨테이너는 끝났고 게시되지 않았다 — 같은 컨테이너로 이어 보낼 수 있다(새 컨테이너 없음).
        return { status: 'resumable', published_parts: published, error_code: 'container_not_published' };
      }
      // 만료·오류 컨테이너: 이 컨테이너로는 게시할 수 없고 새 컨테이너도 만들지 않는다(게시물당 컨테이너 1개) → 확인 불가.
      return { status: 'unknown', published_parts: published, error_code: `container_${status.toLowerCase()}` };
    }
    if (!firstId) return { status: 'unknown', error_code: 'first_post_missing' };
    let permalink: string;
    try {
      permalink = this.api.getPost({ id: firstId, userId, accessToken: token, now: ctx.now }).permalink;
    } catch (e) {
      return { status: 'unknown', error_code: e instanceof ThreadsMockApiError ? `post_${e.code}` : 'adapter_error' };
    }
    return { status: 'found', external_id: publicationId(firstId), permalink, published_parts: published, ...this.visibilityOf(snap) };
  }

  /** 이 흐름으로는 게시를 되돌릴 수 없다(삭제는 별도 명령·승인 — docs/03). 취소 성공을 꾸며내지 않는다. */
  async cancel(_reference: RemoteReference, _ctx: AdapterContext): Promise<CancelResult> {
    this.calls.cancel++;
    return { status: 'unsupported', error_code: 'threads_cancel_unsupported' };
  }
}
