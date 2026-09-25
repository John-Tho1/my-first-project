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
