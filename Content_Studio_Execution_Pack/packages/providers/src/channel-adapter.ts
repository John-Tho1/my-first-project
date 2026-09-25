/**
 * T11(결정 D18) ChannelAdapter 계약(docs/03) + 모의 어댑터. 계약 타입은 @cs/domain(jobs.ts)에 있고 여기서 다시 내보낸다
 * (@cs/db 작업 처리기가 providers 에 의존하지 않게).
 *
 * MockChannelAdapter
 * - 네트워크 없음. 외부 ID 는 `mock:<platform>:<uuid>`, 링크는 `mock://<platform>/<uuid>` — 실제 URL 을 꾸며내지 않는다.
 * - 프로세스 안 "원격" 지도(intentKey → 보낸 결과)를 둔다. submit 이 원격에는 도착했지만 앱이 응답을 못 받은 경우(ambiguous_sent)를
 *   reconcile 이 찾아낼 수 있다(A08·A20 시험). 같은 intentKey 로 다시 submit 하면 원격은 같은 결과를 돌려준다(멱등 토큰).
 * - 조회(reconcile)는 이 프로세스가 submit 을 받은 key 에 대해서만 "없음"을 단정하고, 모르는 key(재시작 뒤 등)는 unknown 을 돌려준다
 *   — 재시작한 모의 원격이 "안 보냈다"고 꾸며 재전송을 부추기지 않게.
 * - T12(D19) 결과는 호출마다 scenarioFor(ctx) 로 정한다: **항목별 시나리오(ctx.mockScenario — 작업 처리기가 mock_scenarios 표에서 읽어
 *   넣는다)** → 프로그램 설정(테스트) → 환경변수 MOCK_CHANNEL_SCENARIO(운영 빌드에서는 무시) → success.
 * - YouTube 의 success 는 A12 대로 비공개 업로드(UPLOADED_PRIVATE·private)를 "처리 중"으로 먼저 돌려주고 조회에서 확인된다(여전히 private).
 *   공개 결과(PUBLISHED·public)는 success_public 이고 payload 공개 범위가 public 일 때만 — 아니면 visibility_not_approved 로 거절한다
 *   (비공개 업로드만 승인했으면 공개 전환 금지, docs/03).
 * - createMockAdapterRegistry() 는 프로세스당 하나(globalThis) — web 과 inline worker 가 같은 원격 지도를 본다.
 */
import { randomUUID } from 'node:crypto';
import {
  LiveChannelNotConfiguredError,
  MOCK_SCENARIO_VALUES,
  type AdapterAccount,
  type AdapterCapabilities,
  type AdapterContext,
  type AdapterResult,
  type CancelResult,
  type ChannelAdapter,
  type ChannelAdapterRegistry,
  type MockScenarioValue,
  type PreparedSubmission,
  type PublishSnapshot,
  type ReconcileResult,
  type RemoteReference,
  type RemoteVisibility,
  type ResultKind,
} from '@cs/domain';

export type {
  AdapterAccount,
  AdapterCapabilities,
  AdapterContext,
  AdapterResult,
  CancelResult,
  ChannelAdapter,
  ChannelAdapterRegistry,
  MockScenarioSetting,
  PreparedSubmission,
  PublishSnapshot,
  ReconcileResult,
  RemoteReference,
} from '@cs/domain';

/** 모의 시나리오 목록(@cs/domain MOCK_SCENARIO_VALUES — DB CHECK 와 같은 목록). */
export const MOCK_SCENARIOS = MOCK_SCENARIO_VALUES;
export type MockScenario = MockScenarioValue;

export const isMockScenario = (v: unknown): v is MockScenario => typeof v === 'string' && (MOCK_SCENARIOS as readonly string[]).includes(v);

export interface MockRemoteEntry {
  intentKey: string;
  platform: string;
  externalId: string;
  permalink: string;
  visibility: RemoteVisibility;
  resultKind: ResultKind;
  state: 'processing' | 'done';
  submittedAt: string;
}

export type ScenarioSource = MockScenario | ((ctx: AdapterContext, snapshot: PublishSnapshot) => MockScenario);

export interface MockAdapterOptions {
  scenario?: ScenarioSource;
  /** submit 응답 전 지연(ms). signal 이 중단되면 멈춘다. */
  delayMs?: number;
  capabilities?: Partial<AdapterCapabilities>;
  /** 환경변수(MOCK_CHANNEL_SCENARIO)를 읽을지(기본 true, 운영 빌드에서는 항상 무시) */
  readEnv?: boolean;
}

function abortError(): Error {
  const e = new Error('mock submit aborted');
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

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(abortError());
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

const DEFAULT_CAPS: AdapterCapabilities = { read: true, cancel: false, definitive_not_found: true, mock: true };

export class MockChannelAdapter implements ChannelAdapter {
  readonly kind = 'mock' as const;
  private readonly remote = new Map<string, MockRemoteEntry>();
  /** 이 프로세스에서 submit 요청을 받은 intentKey. 모르는 key 는 "없음"이라고 단정하지 않는다(재시작 뒤 맹목 재전송 방지). */
  private readonly seen = new Set<string>();
  private scenario: ScenarioSource | null;
  private delayMs: number;
  private caps: AdapterCapabilities;
  private readonly readEnv: boolean;
  /** 테스트 훅: submit 이 결과를 돌려주기 직전(외부 전송 "도중")에 부른다. */
  onSubmit: ((ctx: AdapterContext) => Promise<void> | void) | null = null;
  /** 호출 횟수(테스트 관찰용) */
  readonly calls = { submit: 0, reconcile: 0, cancel: 0 };

  constructor(opts: MockAdapterOptions = {}) {
    this.scenario = opts.scenario ?? null;
    this.delayMs = opts.delayMs ?? 0;
    this.caps = { ...DEFAULT_CAPS, ...opts.capabilities, mock: true };
    this.readEnv = opts.readEnv ?? true;
  }

  /** 프로그램 설정(테스트·T12). null 이면 환경변수 → success. */
  setScenario(s: ScenarioSource | null): void {
    this.scenario = s;
  }

  setDelayMs(ms: number): void {
    this.delayMs = Math.max(0, ms);
  }

  setCapabilities(c: Partial<AdapterCapabilities>): void {
    this.caps = { ...this.caps, ...c, mock: true };
  }

  /** 상태 초기화(테스트). 원격 지도·설정·호출 수를 비운다. */
  reset(): void {
    this.remote.clear();
    this.seen.clear();
    this.scenario = null;
    this.delayMs = 0;
    this.caps = { ...DEFAULT_CAPS };
    this.onSubmit = null;
    this.calls.submit = 0;
    this.calls.reconcile = 0;
    this.calls.cancel = 0;
  }

  /** 원격 지도 사본(테스트 관찰용). */
  remoteEntries(): MockRemoteEntry[] {
    return [...this.remote.values()].map((e) => ({ ...e }));
  }

  /** 원격에 결과를 직접 넣는다(테스트: "원격은 받았는데 앱은 모름"). */
  plantRemote(intentKey: string, platform: string, visibility: RemoteVisibility = 'private'): MockRemoteEntry {
    const entry = this.makeEntry(intentKey, platform, visibility, 'done');
    this.remote.set(intentKey, entry);
    this.seen.add(intentKey);
    return entry;
  }

  scenarioFor(ctx: AdapterContext, snapshot: PublishSnapshot): MockScenario {
    const perItem = ctx.mockScenario?.scenario;
    if (isMockScenario(perItem)) return perItem;
    const s = this.scenario;
    if (typeof s === 'function') return s(ctx, snapshot);
    if (s) return s;
    if (this.readEnv && process.env.NODE_ENV !== 'production') {
      const env = process.env.MOCK_CHANNEL_SCENARIO?.trim();
      if (isMockScenario(env)) return env;
    }
    return 'success';
  }

  /** 조회·취소처럼 snapshot 없이 시나리오가 필요할 때: 항목별 → 고정 문자열 설정 → 환경변수 → null. */
  private staticScenario(ctx?: Pick<AdapterContext, 'mockScenario'>): MockScenario | null {
    const perItem = ctx?.mockScenario?.scenario;
    if (isMockScenario(perItem)) return perItem;
    if (typeof this.scenario === 'string') return this.scenario;
    if (this.scenario === null && this.readEnv && process.env.NODE_ENV !== 'production') {
      const env = process.env.MOCK_CHANNEL_SCENARIO?.trim();
      if (isMockScenario(env)) return env;
    }
    return null;
  }

  /** 원격 취소는 cancel_supported 시나리오에서만 지원한다(그 밖은 설정값 — 기본 false). */
  capabilities(_account: AdapterAccount, ctx?: Pick<AdapterContext, 'mockScenario'>): AdapterCapabilities {
    return this.effectiveCaps(ctx);
  }

  private effectiveCaps(ctx?: Pick<AdapterContext, 'mockScenario'>): AdapterCapabilities {
    const caps = { ...this.caps };
    if (this.staticScenario(ctx) === 'cancel_supported') caps.cancel = true;
    return caps;
  }

  validate(snapshot: PublishSnapshot): { ok: true } | { ok: false; error_code: string } {
    if (snapshot.account.kind !== 'mock') return { ok: false, error_code: 'not_mock_account' };
    if (!snapshot.account.external_account_id.startsWith('mock:')) return { ok: false, error_code: 'not_mock_account' };
    if (snapshot.requested_result !== 'mock_publish') return { ok: false, error_code: 'mock_only' };
    return { ok: true };
  }

  async prepare(snapshot: PublishSnapshot, _ctx: AdapterContext): Promise<PreparedSubmission> {
    return { snapshot, data: { mock: true, platform: snapshot.account.platform } };
  }

  private makeEntry(intentKey: string, platform: string, visibility: RemoteVisibility, state: MockRemoteEntry['state'], kind?: ResultKind): MockRemoteEntry {
    const id = randomUUID();
    return {
      intentKey,
      platform,
      externalId: `mock:${platform}:${id}`,
      permalink: `mock://${platform}/${id}`,
      visibility,
      resultKind: kind ?? (visibility === 'private' ? 'UPLOADED_PRIVATE' : 'PUBLISHED'),
      state,
      submittedAt: new Date().toISOString(),
    };
  }

  private accepted(e: MockRemoteEntry, requestId: string): AdapterResult {
    return {
      status: e.state === 'done' ? 'accepted' : 'processing',
      result_kind: e.resultKind,
      external_id: e.externalId,
      permalink: e.permalink,
      remote_visibility: e.visibility,
      provider_request_id: requestId,
    };
  }

  async submit(prepared: PreparedSubmission, ctx: AdapterContext): Promise<AdapterResult> {
    this.calls.submit++;
    this.seen.add(ctx.intentKey);
    const snap = prepared.snapshot;
    const platform = snap.account.platform;
    const scenario = this.scenarioFor(ctx, snap);
    const requestId = `mock-req:${randomUUID()}`;
    const delay = ctx.mockScenario && ctx.mockScenario.delay_ms > 0 ? ctx.mockScenario.delay_ms : this.delayMs;
    if (delay > 0) await sleep(delay, ctx.signal);
    await ctx.heartbeat();
    // 같은 멱등 토큰의 재전송 → 원격은 이미 받은 결과를 돌려준다(중복 게시 없음).
    const existing = this.remote.get(ctx.intentKey);
    if (existing) {
      if (this.onSubmit) await this.onSubmit(ctx);
      return this.accepted(existing, requestId);
    }
    const approved: RemoteVisibility = snap.visibility === 'public' || snap.visibility === 'unlisted' ? snap.visibility : 'private';
    const reply = async (r: AdapterResult): Promise<AdapterResult> => {
      if (this.onSubmit) await this.onSubmit(ctx);
      return r;
    };
    const write = (visibility: RemoteVisibility, state: MockRemoteEntry['state'], kind?: ResultKind): MockRemoteEntry => {
      const e = this.makeEntry(ctx.intentKey, platform, visibility, state, kind);
      this.remote.set(ctx.intentKey, e);
      return e;
    };
    const success = () =>
      // A12: YouTube 업로드 성공은 비공개 업로드(처리 중 → 조회에서 확인, 여전히 private) — 공개 게시 성공이 아니다.
      platform === 'youtube' ? write('private', 'processing', 'UPLOADED_PRIVATE') : write(approved, 'done');
    switch (scenario) {
      case 'hang':
        if (this.onSubmit) await this.onSubmit(ctx);
        return waitForAbort(ctx.signal);
      case 'transient':
        return reply({ status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'mock_503_not_sent', provider_request_id: requestId });
      case 'transient_then_success':
        if (ctx.attempt <= 1) {
          return reply({ status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'mock_503_not_sent', provider_request_id: requestId });
        }
        return reply(this.accepted(success(), requestId));
      case 'rate_limited':
        return reply({ status: 'rejected', retry_class: 'transient_no_side_effect', retry_after_sec: 5, error_code: 'mock_429_rate_limited', provider_request_id: requestId });
      case 'server_error_no_side_effect':
        return reply({ status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'mock_503_no_side_effect', provider_request_id: requestId });
      case 'server_error_side_effect_unknown':
        // 5xx 이지만 원격은 이미 썼다(부작용 불명) — 재시도가 아니라 조회 대상이다(docs/03 "모든 5xx 무조건 retry 금지").
        write(approved, 'done');
        return reply({ status: 'rejected', retry_class: 'transient_unknown_side_effect', error_code: 'mock_502_after_write', provider_request_id: requestId });
      case 'permanent':
        return reply({ status: 'rejected', retry_class: 'permanent', error_code: 'mock_400_invalid_format', provider_request_id: requestId });
      case 'auth':
        return reply({ status: 'rejected', retry_class: 'auth', error_code: 'mock_401_unauthorized', provider_request_id: requestId });
      case 'ambiguous_sent':
      case 'reconcile_unsupported':
        write(approved, 'done');
        return reply({ status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'mock_response_lost' });
      case 'ambiguous_not_sent':
        return reply({ status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'mock_connection_reset' });
      case 'processing_then_confirm':
      case 'cancel_supported':
        return reply(this.accepted(write(platform === 'youtube' ? 'private' : approved, 'processing', platform === 'youtube' ? 'UPLOADED_PRIVATE' : undefined), requestId));
      case 'success_public':
        // 공개 결과는 payload 가 공개(public)로 승인된 경우에만. 비공개 업로드만 승인했으면 공개 전환하지 않는다(docs/03).
        if (snap.visibility !== 'public') {
          return reply({ status: 'rejected', retry_class: 'permanent', error_code: 'visibility_not_approved', provider_request_id: requestId });
        }
        return reply(this.accepted(write('public', 'done', 'PUBLISHED'), requestId));
      case 'success':
      default:
        return reply(this.accepted(success(), requestId));
    }
  }

  /** 읽기 전용 조회. 처리 중이던 결과는 한 번 조회하면 끝난 것으로 본다(processing_then_confirm). */
  async reconcile(reference: RemoteReference, ctx: AdapterContext): Promise<ReconcileResult> {
    this.calls.reconcile++;
    if (!this.caps.read) return { status: 'unsupported', error_code: 'mock_read_unsupported' };
    // T12: 원격 조회를 지원하지 않는 채널 흉내(submit 은 결과 불명) → 확인 불가 3회 뒤 UNKNOWN(재전송 없음).
    if (this.staticScenario(ctx) === 'reconcile_unsupported') return { status: 'unsupported', error_code: 'mock_reconcile_unsupported' };
    const e =
      this.remote.get(reference.intent_key) ??
      (reference.external_id ? [...this.remote.values()].find((x) => x.externalId === reference.external_id) : undefined);
    if (!e) {
      // 이 프로세스가 받은 적 없는 요청이면(재시작 등) 보내지 않았다고 단정할 수 없다 → 확인 불가.
      if (!this.seen.has(reference.intent_key)) return { status: 'unknown', error_code: 'mock_no_record' };
      return { status: 'not_found' };
    }
    if (e.state === 'processing') e.state = 'done';
    return {
      status: 'found',
      result_kind: e.resultKind,
      external_id: e.externalId,
      permalink: e.permalink,
      remote_visibility: e.visibility,
    };
  }

  /** 모의 어댑터는 기본적으로 원격 취소를 지원하지 않는다(capabilities.cancel=false, cancel_supported 시나리오만 true) — 취소 성공을 꾸며내지 않는다. */
  async cancel(reference: RemoteReference, ctx: AdapterContext): Promise<CancelResult> {
    this.calls.cancel++;
    if (!this.effectiveCaps(ctx).cancel) return { status: 'unsupported', error_code: 'mock_cancel_unsupported' };
    const had = this.remote.delete(reference.intent_key);
    return had ? { status: 'canceled' } : { status: 'not_canceled', error_code: 'mock_not_found' };
  }
}

export class MockChannelAdapterRegistry implements ChannelAdapterRegistry {
  constructor(readonly mock: MockChannelAdapter) {}
  getAdapterFor(account: Pick<AdapterAccount, 'kind' | 'platform'>): ChannelAdapter {
    if (account.kind === 'mock') return this.mock;
    throw new LiveChannelNotConfiguredError();
  }
}

const globalForAdapters = globalThis as typeof globalThis & { __contentStudioMockAdapters?: MockChannelAdapterRegistry };

/** 프로세스당 하나(globalThis). web 과 inline worker 가 같은 모의 "원격"을 공유한다. */
export function createMockAdapterRegistry(): MockChannelAdapterRegistry {
  if (!globalForAdapters.__contentStudioMockAdapters) {
    globalForAdapters.__contentStudioMockAdapters = new MockChannelAdapterRegistry(new MockChannelAdapter());
  }
  return globalForAdapters.__contentStudioMockAdapters;
}

/** 테스트용: 프로세스 싱글턴을 버린다("재시작" 흉내 — 모의 원격 지도도 사라진다). */
export function resetMockAdapterRegistry(): void {
  globalForAdapters.__contentStudioMockAdapters = undefined;
}
