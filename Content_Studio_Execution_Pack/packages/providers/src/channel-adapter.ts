/**
 * T11(결정 D18) ChannelAdapter 계약(docs/03) + 모의 어댑터. 계약 타입은 @cs/domain(jobs.ts)에 있고 여기서 다시 내보낸다
 * (@cs/db 작업 처리기가 providers 에 의존하지 않게).
 *
 * MockChannelAdapter
 * - 네트워크 없음. 외부 ID 는 `mock:<platform>:<uuid>`, 링크는 `mock://<platform>/<uuid>` — 실제 URL 을 꾸며내지 않는다.
 * - 프로세스 안 "원격" 지도(intentKey → 보낸 결과)를 둔다. 조회(reconcile)는 이 프로세스가 submit 을 받은 key 에 대해서만 "없음"을 단정하고,
 *   모르는 key(재시작 뒤 등)는 unknown 을 돌려준다 — 재시작한 모의 원격이 "안 보냈다"고 꾸며 재전송을 부추기지 않게.
 * - 프로세스 안 "원격" 지도(intentKey → 보낸 결과)를 둔다. submit 이 원격에는 도착했지만 앱이 응답을 못 받은 경우(ambiguous_sent)를
 *   reconcile 이 찾아낼 수 있다(A08·A20 시험). 같은 intentKey 로 다시 submit 하면 원격은 같은 결과를 돌려준다(멱등 토큰).
 * - 결과는 호출마다 scenarioFor(ctx) 로 정한다: 프로그램 설정(테스트) → 환경변수 MOCK_CHANNEL_SCENARIO(운영 빌드에서는 무시) → success.
 * - createMockAdapterRegistry() 는 프로세스당 하나(globalThis) — web 과 inline worker 가 같은 원격 지도를 본다.
 */
import { randomUUID } from 'node:crypto';
import {
  LiveChannelNotConfiguredError,
  type AdapterAccount,
  type AdapterCapabilities,
  type AdapterContext,
  type AdapterResult,
  type CancelResult,
  type ChannelAdapter,
  type ChannelAdapterRegistry,
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
  PreparedSubmission,
  PublishSnapshot,
  ReconcileResult,
  RemoteReference,
} from '@cs/domain';

export const MOCK_SCENARIOS = [
  'success',
  'transient',
  'permanent',
  'auth',
  'ambiguous_sent',
  'ambiguous_not_sent',
  'processing_then_confirm',
  'hang',
] as const;
export type MockScenario = (typeof MOCK_SCENARIOS)[number];

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
    const s = this.scenario;
    if (typeof s === 'function') return s(ctx, snapshot);
    if (s) return s;
    if (this.readEnv && process.env.NODE_ENV !== 'production') {
      const env = process.env.MOCK_CHANNEL_SCENARIO?.trim();
      if (isMockScenario(env)) return env;
    }
    return 'success';
  }

  capabilities(_account: AdapterAccount): AdapterCapabilities {
    return { ...this.caps };
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

  private makeEntry(intentKey: string, platform: string, visibility: RemoteVisibility, state: MockRemoteEntry['state']): MockRemoteEntry {
    const id = randomUUID();
    return {
      intentKey,
      platform,
      externalId: `mock:${platform}:${id}`,
      permalink: `mock://${platform}/${id}`,
      visibility,
      resultKind: visibility === 'private' ? 'UPLOADED_PRIVATE' : 'PUBLISHED',
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
    if (this.delayMs > 0) await sleep(this.delayMs, ctx.signal);
    await ctx.heartbeat();
    // 같은 멱등 토큰의 재전송 → 원격은 이미 받은 결과를 돌려준다(중복 게시 없음).
    const existing = this.remote.get(ctx.intentKey);
    if (existing) {
      if (this.onSubmit) await this.onSubmit(ctx);
      return this.accepted(existing, requestId);
    }
    const visibility: RemoteVisibility = snap.visibility === 'public' || snap.visibility === 'unlisted' ? snap.visibility : 'private';
    switch (scenario) {
      case 'hang':
        if (this.onSubmit) await this.onSubmit(ctx);
        return waitForAbort(ctx.signal);
      case 'transient':
        if (this.onSubmit) await this.onSubmit(ctx);
        return { status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'mock_503_not_sent', provider_request_id: requestId };
      case 'permanent':
        if (this.onSubmit) await this.onSubmit(ctx);
        return { status: 'rejected', retry_class: 'permanent', error_code: 'mock_invalid_format', provider_request_id: requestId };
      case 'auth':
        if (this.onSubmit) await this.onSubmit(ctx);
        return { status: 'rejected', retry_class: 'auth', error_code: 'mock_401_unauthorized', provider_request_id: requestId };
      case 'ambiguous_sent': {
        this.remote.set(ctx.intentKey, this.makeEntry(ctx.intentKey, platform, visibility, 'done'));
        if (this.onSubmit) await this.onSubmit(ctx);
        return { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'mock_response_lost' };
      }
      case 'ambiguous_not_sent':
        if (this.onSubmit) await this.onSubmit(ctx);
        return { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'mock_connection_reset' };
      case 'processing_then_confirm': {
        const e = this.makeEntry(ctx.intentKey, platform, visibility, 'processing');
        this.remote.set(ctx.intentKey, e);
        if (this.onSubmit) await this.onSubmit(ctx);
        return this.accepted(e, requestId);
      }
      case 'success':
      default: {
        const e = this.makeEntry(ctx.intentKey, platform, visibility, 'done');
        this.remote.set(ctx.intentKey, e);
        if (this.onSubmit) await this.onSubmit(ctx);
        return this.accepted(e, requestId);
      }
    }
  }

  /** 읽기 전용 조회. 처리 중이던 결과는 한 번 조회하면 끝난 것으로 본다(processing_then_confirm). */
  async reconcile(reference: RemoteReference, _ctx: AdapterContext): Promise<ReconcileResult> {
    this.calls.reconcile++;
    if (!this.caps.read) return { status: 'unsupported', error_code: 'mock_read_unsupported' };
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

  /** 모의 어댑터는 기본적으로 원격 취소를 지원하지 않는다(capabilities.cancel=false) — 취소 성공을 꾸며내지 않는다. */
  async cancel(reference: RemoteReference, _ctx: AdapterContext): Promise<CancelResult> {
    this.calls.cancel++;
    if (!this.caps.cancel) return { status: 'unsupported', error_code: 'mock_cancel_unsupported' };
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
