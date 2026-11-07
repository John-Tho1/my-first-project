import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveChannelNotConfiguredError, loadConfig, type AdapterContext, type PublishSnapshot } from '@cs/domain';
import { createMockAdapterRegistry, createProviders, MockChannelAdapter, resetMockAdapterRegistry, type MockScenario } from './index';

const snapshot = (over: Partial<PublishSnapshot> = {}): PublishSnapshot => ({
  item_id: '00000000-0000-4000-8000-000000000001',
  channel: 'threads',
  account: { id: 'a1', kind: 'mock', platform: 'threads', external_account_id: 'mock:threads:x' },
  payload: {},
  payload_hash: 'h'.repeat(64),
  visibility: 'private',
  requested_result: 'mock_publish',
  scheduled_at_utc: null,
  ...over,
});

let n = 0;
const ctx = (over: Partial<AdapterContext> = {}): AdapterContext => ({
  intentKey: `job-${++n}:1`,
  attempt: 1,
  jobId: 'job',
  itemId: 'item',
  now: new Date(),
  signal: new AbortController().signal,
  heartbeat: async () => undefined,
  ...over,
});

async function submit(a: MockChannelAdapter, c = ctx(), s = snapshot()) {
  return a.submit(await a.prepare(s, c), c);
}
const ref = (c: AdapterContext, external_id: string | null = null) => ({ platform: 'threads', intent_key: c.intentKey, external_id, provider_request_id: null });

afterEach(() => {
  vi.unstubAllEnvs();
  resetMockAdapterRegistry();
});

describe('MockChannelAdapter', () => {
  it('success: mock: 외부 ID, mock:// 링크(실제 URL 아님), 비공개면 UPLOADED_PRIVATE', async () => {
    const a = new MockChannelAdapter({ readEnv: false });
    const r = await submit(a);
    expect(r.status).toBe('accepted');
    expect(r.external_id).toMatch(/^mock:threads:[0-9a-f-]{36}$/);
    expect(r.permalink).toMatch(/^mock:\/\/threads\/[0-9a-f-]{36}$/);
    expect(r.permalink).not.toMatch(/^https?:/);
    expect(r.result_kind).toBe('UPLOADED_PRIVATE');
    expect(r.remote_visibility).toBe('private');
    const pub = await submit(a, ctx(), snapshot({ visibility: 'public' }));
    expect(pub.result_kind).toBe('PUBLISHED');
    expect(a.capabilities(snapshot().account)).toMatchObject({ mock: true, read: true, cancel: false });
  });

  it.each<[MockScenario, string, string | undefined]>([
    ['transient', 'rejected', 'transient_no_side_effect'],
    ['permanent', 'rejected', 'permanent'],
    ['auth', 'rejected', 'auth'],
    ['ambiguous_sent', 'ambiguous', 'transient_unknown_side_effect'],
    ['ambiguous_not_sent', 'ambiguous', 'transient_unknown_side_effect'],
    ['processing_then_confirm', 'processing', undefined],
  ])('시나리오 %s → %s', async (scenario, status, retryClass) => {
    const a = new MockChannelAdapter({ scenario, readEnv: false });
    const r = await submit(a);
    expect(r.status).toBe(status);
    expect(r.retry_class).toBe(retryClass);
  });

  it('reconcile 지도: ambiguous_sent 는 찾고, ambiguous_not_sent 는 확실히 없음, 처리 중은 한 번 조회 뒤 끝남', async () => {
    const a = new MockChannelAdapter({ readEnv: false });
    a.setScenario('ambiguous_sent');
    const c1 = ctx();
    await submit(a, c1);
    const found = await a.reconcile(ref(c1), c1);
    expect(found.status).toBe('found');
    expect(found.external_id).toMatch(/^mock:threads:/);
    a.setScenario('ambiguous_not_sent');
    const c2 = ctx();
    await submit(a, c2);
    expect((await a.reconcile(ref(c2), c2)).status).toBe('not_found');
    a.setScenario('processing_then_confirm');
    const c3 = ctx();
    const p = await submit(a, c3);
    expect(p.status).toBe('processing');
    expect((await a.reconcile(ref(c3, p.external_id ?? null), c3)).status).toBe('found');
  });

  it('처음 보는 intentKey(재시작 뒤)는 "없음"이라고 단정하지 않는다 → unknown', async () => {
    const a = new MockChannelAdapter({ readEnv: false });
    const c = ctx();
    expect((await a.reconcile(ref(c), c)).status).toBe('unknown');
  });

  it('read 권한 끔 → reconcile unsupported, cancel 은 기본 unsupported(취소 성공을 꾸며내지 않음)', async () => {
    const a = new MockChannelAdapter({ readEnv: false, capabilities: { read: false } });
    const c = ctx();
    await submit(a, c);
    expect((await a.reconcile(ref(c), c)).status).toBe('unsupported');
    expect((await a.cancel(ref(c), c)).status).toBe('unsupported');
  });

  it('같은 intentKey 재전송 → 원격은 같은 결과(중복 없음)', async () => {
    const a = new MockChannelAdapter({ readEnv: false });
    const c = ctx();
    const r1 = await submit(a, c);
    const r2 = await submit(a, c);
    expect(r2.external_id).toBe(r1.external_id);
    expect(a.remoteEntries()).toHaveLength(1);
  });

  it('hang: 중단 신호가 올 때까지 끝나지 않는다', async () => {
    const a = new MockChannelAdapter({ scenario: 'hang', readEnv: false });
    const ac = new AbortController();
    const c = ctx({ signal: ac.signal });
    const p = submit(a, c);
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toThrow(/aborted/);
  });

  it('시나리오 함수(시도 번호별)와 validate(모의 계정·mock_publish 만)', async () => {
    const a = new MockChannelAdapter({ readEnv: false, scenario: (c) => (c.attempt === 1 ? 'transient' : 'success') });
    expect((await submit(a, ctx({ attempt: 1 }))).status).toBe('rejected');
    expect((await submit(a, ctx({ attempt: 2 }))).status).toBe('accepted');
    expect(a.validate(snapshot())).toEqual({ ok: true });
    expect(a.validate(snapshot({ requested_result: 'public_publish' }))).toEqual({ ok: false, error_code: 'mock_only' });
    expect(a.validate(snapshot({ account: { id: 'x', kind: 'live', platform: 'threads', external_account_id: 'real' } })).ok).toBe(false);
  });

  it('MOCK_CHANNEL_SCENARIO 는 개발·테스트에서만, 운영 빌드에서는 무시', async () => {
    vi.stubEnv('MOCK_CHANNEL_SCENARIO', 'permanent');
    const a = new MockChannelAdapter();
    expect((await submit(a)).status).toBe('rejected');
    vi.stubEnv('NODE_ENV', 'production');
    expect((await submit(a)).status).toBe('accepted');
  });

  it('네트워크를 쓰지 않는다(fetch 호출 0)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const a = new MockChannelAdapter({ readEnv: false });
    const c = ctx();
    await submit(a, c);
    await a.reconcile(ref(c), c);
    await a.cancel(ref(c), c);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('T12 항목별 시나리오(ctx.mockScenario)', () => {
  const yt = (over: Partial<PublishSnapshot> = {}) =>
    snapshot({ channel: 'youtube', account: { id: 'y', kind: 'mock', platform: 'youtube', external_account_id: 'mock:youtube:x' }, ...over });
  const withS = (scenario: MockScenario, over: Partial<AdapterContext> = {}) => ctx({ mockScenario: { scenario, delay_ms: 0 }, ...over });

  it('항목별 시나리오가 프로그램 설정·환경변수보다 먼저', async () => {
    vi.stubEnv('MOCK_CHANNEL_SCENARIO', 'permanent');
    const a = new MockChannelAdapter({ scenario: 'transient' });
    expect((await submit(a, withS('auth'))).error_code).toBe('mock_401_unauthorized');
    expect((await submit(a)).error_code).toBe('mock_503_not_sent');
  });

  it('A12: YouTube success → 처리 중(UPLOADED_PRIVATE·private) → 조회에서 확인, 여전히 private(공개 게시 아님)', async () => {
    const a = new MockChannelAdapter({ readEnv: false });
    const c = withS('success');
    const r = await submit(a, c, yt({ visibility: 'public' }));
    expect(r).toMatchObject({ status: 'processing', result_kind: 'UPLOADED_PRIVATE', remote_visibility: 'private' });
    const f = await a.reconcile({ ...ref(c), platform: 'youtube' }, c);
    expect(f).toMatchObject({ status: 'found', result_kind: 'UPLOADED_PRIVATE', remote_visibility: 'private' });
  });

  it('success_public: payload 가 public 일 때만 PUBLISHED, 비공개 승인이면 visibility_not_approved(영구 거절)', async () => {
    const a = new MockChannelAdapter({ readEnv: false });
    expect(await submit(a, withS('success_public'), snapshot({ visibility: 'public' }))).toMatchObject({ status: 'accepted', result_kind: 'PUBLISHED', remote_visibility: 'public' });
    expect(await submit(a, withS('success_public'), snapshot({ visibility: 'private' }))).toMatchObject({
      status: 'rejected',
      retry_class: 'permanent',
      error_code: 'visibility_not_approved',
    });
    expect(a.remoteEntries().filter((e) => e.visibility === 'public')).toHaveLength(1);
  });

  it.each<[MockScenario, Record<string, unknown>]>([
    ['rate_limited', { status: 'rejected', retry_class: 'transient_no_side_effect', retry_after_sec: 5, error_code: 'mock_429_rate_limited' }],
    ['server_error_no_side_effect', { status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'mock_503_no_side_effect' }],
    ['server_error_side_effect_unknown', { status: 'rejected', retry_class: 'transient_unknown_side_effect', error_code: 'mock_502_after_write' }],
    ['permanent', { status: 'rejected', retry_class: 'permanent' }],
    ['auth', { status: 'rejected', retry_class: 'auth' }],
    ['reconcile_unsupported', { status: 'ambiguous' }],
    ['cancel_supported', { status: 'processing' }],
  ])('%s → %o', async (scenario, want) => {
    const a = new MockChannelAdapter({ readEnv: false });
    expect(await submit(a, withS(scenario))).toMatchObject(want);
  });

  it('5xx 뒤 부작용 불명: 원격에는 썼다 → 조회로 찾는다(재전송 대상이 아님)', async () => {
    const a = new MockChannelAdapter({ readEnv: false });
    const c = withS('server_error_side_effect_unknown');
    await submit(a, c);
    expect((await a.reconcile(ref(c), c)).status).toBe('found');
  });

  it('transient_then_success: 첫 시도만 일시 오류', async () => {
    const a = new MockChannelAdapter({ readEnv: false });
    expect((await submit(a, withS('transient_then_success', { attempt: 1 }))).status).toBe('rejected');
    expect((await submit(a, withS('transient_then_success', { attempt: 2 }))).status).toBe('accepted');
  });

  it('reconcile_unsupported: 조회는 unsupported(원격에 있어도) / cancel_supported 만 capabilities.cancel 과 원격 취소', async () => {
    const a = new MockChannelAdapter({ readEnv: false });
    const c = withS('reconcile_unsupported');
    await submit(a, c);
    expect((await a.reconcile(ref(c), c)).status).toBe('unsupported');
    expect(a.capabilities(snapshot().account, c).cancel).toBe(false);
    const k = withS('cancel_supported');
    const r = await submit(a, k);
    expect(a.capabilities(snapshot().account, k).cancel).toBe(true);
    expect(a.capabilities(snapshot().account).cancel).toBe(false);
    expect((await a.cancel(ref(k, r.external_id ?? null), k)).status).toBe('canceled');
    expect((await a.cancel(ref(c), c)).status).toBe('unsupported');
  });

  it('delay_ms: 항목별 지연, 중단 신호로 멈춘다', async () => {
    const a = new MockChannelAdapter({ readEnv: false });
    const ac = new AbortController();
    const c = ctx({ signal: ac.signal, mockScenario: { scenario: 'success', delay_ms: 5000 } });
    const p = submit(a, c);
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toThrow(/aborted/);
  });
});

describe('레지스트리', () => {
  it('프로세스 싱글턴, live 계정은 LiveChannelNotConfiguredError, createProviders 에 모의만', () => {
    const r1 = createMockAdapterRegistry();
    expect(createMockAdapterRegistry()).toBe(r1);
    expect(r1.getAdapterFor({ kind: 'mock', platform: 'youtube' })).toBe(r1.mock);
    expect(() => r1.getAdapterFor({ kind: 'live', platform: 'threads' })).toThrow(LiveChannelNotConfiguredError);
    expect(createProviders(loadConfig({})).channelAdapters).toBe(r1);
    resetMockAdapterRegistry();
    expect(createMockAdapterRegistry()).not.toBe(r1);
  });
});

describe('FIX-T11(P0) 진행 중 전송', () => {
  it('submit 이 진행 중인 key 는 조회가 not_found 가 아니라 unknown(mock_in_flight), 끝난 뒤(부작용 없음)에만 not_found', async () => {
    const a = new MockChannelAdapter({ readEnv: false, scenario: 'ambiguous_not_sent', delayMs: 50 });
    const c = ctx();
    const p = submit(a, c);
    await new Promise((r) => setTimeout(r, 10));
    expect(await a.reconcile({ platform: 'threads', intent_key: c.intentKey, external_id: null, provider_request_id: null }, c)).toEqual({ status: 'unknown', error_code: 'mock_in_flight' });
    await p;
    expect((await a.reconcile({ platform: 'threads', intent_key: c.intentKey, external_id: null, provider_request_id: null }, c)).status).toBe('not_found');
  });
  it('heartbeat 가 lease 상실로 던지거나 신호가 중단되면 원격에 쓰지 않는다', async () => {
    const a = new MockChannelAdapter({ readEnv: false, scenario: 'success' });
    await expect(submit(a, ctx({ heartbeat: async () => { throw new Error('lease lost'); } }))).rejects.toThrow('lease lost');
    const ac = new AbortController();
    const c = ctx({ signal: ac.signal, heartbeat: async () => { ac.abort(); } });
    await expect(submit(a, c)).rejects.toMatchObject({ name: 'AbortError' });
    expect(a.remoteEntries()).toHaveLength(0);
  });
});
