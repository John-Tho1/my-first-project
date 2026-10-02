/**
 * T14(D26) Threads 모의 시뮬레이터·어댑터 단위 시험. 네트워크 없음(fetch 를 막고 0회 확인). 토큰은 시험이 만든 모의 문자열.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspect } from 'node:util';
import {
  adapterIdFor,
  classifyOutcome,
  LiveChannelNotConfiguredError,
  THREADS_MAX,
  THREADS_MAX_PARTS,
  type AdapterContext,
  type MockScenarioValue,
  type PublishSnapshot,
  type RemoteStep,
  type RemoteStepsPort,
} from '@cs/domain';
import {
  classifyThreadsError,
  MockChannelAdapter,
  MockChannelAdapterRegistry,
  MockOAuthStore,
  MockThreadsOAuthProvider,
  mockOAuthTokenCheck,
  THREADS_ERROR_KINDS,
  ThreadsMockApi,
  ThreadsMockApiError,
  ThreadsMockChannelAdapter,
  type ThreadsErrorKind,
} from './index';

const USER = 'mock:threads:user-1';
const TOKEN = 'mockthr_at_TEST_TOKEN_SHOULD_NEVER_LEAK_0123456789';
const tokenCheck = (t: string, u: string) => t === TOKEN && u === USER;

const snapshot = (posts: string[], over: Partial<PublishSnapshot> = {}): PublishSnapshot => ({
  item_id: '00000000-0000-4000-8000-000000000001',
  channel: 'threads',
  account: { id: 'acc-1', kind: 'mock', platform: 'threads', external_account_id: USER, credential_state: 'linked' },
  payload: { channel: 'threads', text: { rendered: posts.join('\n\n'), posts }, assets: [] },
  payload_hash: 'h'.repeat(64),
  visibility: 'private',
  requested_result: 'mock_publish',
  scheduled_at_utc: null,
  ...over,
});

/** 메모리 단계 기록(작업 처리기의 remote_steps 창구와 같은 규칙: remote_id 불변, 상태는 앞으로만). */
function memSteps(): RemoteStepsPort & { rows: RemoteStep[] } {
  const rows: RemoteStep[] = [];
  const rank: Record<string, number> = { created: 0, finished: 1, error: 2, published: 3 };
  return {
    rows,
    list: async () => rows.map((r) => ({ ...r })),
    record: async (s) => {
      const ex = rows.find((r) => r.kind === s.kind && r.post_index === s.post_index);
      const now = new Date().toISOString();
      if (ex) {
        if (ex.remote_id !== s.remote_id) throw new Error('remote_step_conflict');
        if ((rank[s.status] ?? 0) > (rank[ex.status] ?? 0)) ex.status = s.status;
        return { ...ex };
      }
      const r: RemoteStep = { ...s, step_index: rows.length, created_at: now, updated_at: now };
      rows.push(r);
      return { ...r };
    },
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
    credential: { accessToken: async () => ({ ok: true, token: TOKEN }) },
    ...over,
  };
}
const scen = (scenario: MockScenarioValue) => ({ mockScenario: { scenario, delay_ms: 0 } });
const ref = { platform: 'threads', intent_key: 'job:1', external_id: null, provider_request_id: null };

let fetchCalls = 0;
beforeEach(() => {
  fetchCalls = 0;
  vi.stubGlobal('fetch', async () => {
    fetchCalls++;
    throw new Error('network forbidden');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(fetchCalls).toBe(0);
});

describe('ThreadsMockApi(시뮬레이터)', () => {
  it('컨테이너 생성 → (조회 k 번 IN_PROGRESS) → FINISHED → 게시 → PUBLISHED, 모의 ID·mock:// 링크', () => {
    const api = new ThreadsMockApi({ tokenCheck });
    const c = api.createContainer({ userId: USER, text: '첫 글', accessToken: TOKEN }, { finishAfterPolls: 2 });
    expect(c.id).toMatch(/^mockthr_ct_[0-9a-f-]{36}$/);
    expect(c.status).toBe('IN_PROGRESS');
    expect(() => api.publish({ userId: USER, creationId: c.id, accessToken: TOKEN })).toThrow(/container_not_ready/);
    expect(api.getContainer({ id: c.id, userId: USER, accessToken: TOKEN }).status).toBe('IN_PROGRESS');
    expect(api.getContainer({ id: c.id, userId: USER, accessToken: TOKEN }).status).toBe('IN_PROGRESS');
    expect(api.getContainer({ id: c.id, userId: USER, accessToken: TOKEN }).status).toBe('FINISHED');
    expect(api.findPublishedByContainer({ creationId: c.id, userId: USER, accessToken: TOKEN })).toBeNull();
    const p = api.publish({ userId: USER, creationId: c.id, accessToken: TOKEN });
    expect(p.id).toMatch(/^mockthr_post_[0-9a-f-]{36}$/);
    expect(api.getContainer({ id: c.id, userId: USER, accessToken: TOKEN }).status).toBe('PUBLISHED');
    const post = api.getPost({ id: p.id, userId: USER, accessToken: TOKEN });
    expect(post.permalink).toBe(`mock://threads/${p.id}`);
    expect(post.permalink).not.toMatch(/^https?:/);
    expect(api.findPublishedByContainer({ creationId: c.id, userId: USER, accessToken: TOKEN })?.id).toBe(p.id);
    // 같은 컨테이너 두 번째 게시는 거절 — 게시물이 두 개 생기지 않는다
    expect(() => api.publish({ userId: USER, creationId: c.id, accessToken: TOKEN })).toThrow(/container_already_published/);
    expect(api.publishCount.get(c.id)).toBe(1);
    expect(api.postsOf(USER)).toHaveLength(1);
  });

  it('답글 대상은 같은 사용자의 게시물만, 모르는 컨테이너는 not_found(없다고 단정하지 않음), 글자 수 초과는 400', () => {
    const api = new ThreadsMockApi({ tokenCheck });
    expect(() => api.createContainer({ userId: USER, text: 'x', replyToId: 'mockthr_post_nope', accessToken: TOKEN })).toThrow(/invalid_reply_to/);
    expect(() => api.getContainer({ id: 'mockthr_ct_unknown', userId: USER, accessToken: TOKEN })).toThrow(/container_not_found/);
    expect(() => api.findPublishedByContainer({ creationId: 'mockthr_ct_unknown', userId: USER, accessToken: TOKEN })).toThrow(ThreadsMockApiError);
    expect(() => api.createContainer({ userId: USER, text: 'a'.repeat(THREADS_MAX + 1), accessToken: TOKEN })).toThrow(/text_too_long/);
    // 코드 포인트로 센다(이모지 500개는 허용)
    expect(api.createContainer({ userId: USER, text: '😀'.repeat(THREADS_MAX), accessToken: TOKEN }).status).toBe('FINISHED');
  });

  it('토큰: 다른 토큰·다른 사용자 → 401, 오류 메시지·호출 기록에 토큰이 없다', () => {
    const api = new ThreadsMockApi({ tokenCheck });
    let err: unknown;
    try {
      api.createContainer({ userId: USER, text: 'x', accessToken: 'mockthr_at_OTHER' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ThreadsMockApiError);
    expect((err as ThreadsMockApiError).httpStatus).toBe(401);
    expect(() => api.createContainer({ userId: 'mock:threads:someone-else', text: 'x', accessToken: TOKEN })).toThrow(/auth_invalid_token/);
    try {
      api.publish({ userId: USER, creationId: 'mockthr_ct_x', accessToken: TOKEN });
    } catch (e) {
      err = e;
    }
    expect(inspect(err, { depth: Infinity })).not.toContain(TOKEN);
    expect(JSON.stringify(api.calls)).not.toContain(TOKEN);
  });

  it('T13 모의 OAuth 공급자가 발급한 토큰만 통과(해제하면 401)', async () => {
    const store = new MockOAuthStore();
    const provider = new MockThreadsOAuthProvider({ registeredRedirectUri: 'http://localhost:3000/api/oauth/callback', appBaseUrl: 'http://localhost:3000', store });
    const verifier = 'v'.repeat(43);
    const { createHash } = await import('node:crypto');
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    const a = provider.authorize(
      {
        client_id: 'mock-threads-client',
        redirect_uri: 'http://localhost:3000/api/oauth/callback',
        response_type: 'code',
        scope: 'threads_basic,threads_content_publish',
        state: 's'.repeat(43),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        login_hint: USER,
      },
      new Date(),
    );
    expect(a.ok).toBe(true);
    const code = new URL((a as { redirect: string }).redirect).searchParams.get('code')!;
    const tokens = await provider.exchangeCode({ code, codeVerifier: verifier, redirectUri: 'http://localhost:3000/api/oauth/callback', now: new Date() });
    const api = new ThreadsMockApi({ tokenCheck: mockOAuthTokenCheck(store) });
    expect(api.createContainer({ userId: USER, text: 'ok', accessToken: tokens.accessToken }).status).toBe('FINISHED');
    expect(() => api.createContainer({ userId: 'mock:threads:other', text: 'x', accessToken: tokens.accessToken })).toThrow(/auth_invalid_token/);
    await provider.revoke({ tokens: { accessToken: tokens.accessToken, refreshToken: null }, now: new Date() });
    expect(() => api.createContainer({ userId: USER, text: 'x', accessToken: tokens.accessToken })).toThrow(/auth_invalid_token/);
  });

  it('게시 예산: 0 이면 429(rate_limited, retry-after), 장애 주입: applied 면 동작 뒤 실패', () => {
    const api = new ThreadsMockApi({ tokenCheck });
    api.setRateBudget(USER, 1, 42);
    const c1 = api.createContainer({ userId: USER, text: 'a', accessToken: TOKEN });
    api.publish({ userId: USER, creationId: c1.id, accessToken: TOKEN });
    const c2 = api.createContainer({ userId: USER, text: 'b', accessToken: TOKEN });
    let e: ThreadsMockApiError | null = null;
    try {
      api.publish({ userId: USER, creationId: c2.id, accessToken: TOKEN });
    } catch (x) {
      e = x as ThreadsMockApiError;
    }
    expect(e?.kind).toBe('rate_limited');
    expect(e?.httpStatus).toBe(429);
    expect(e?.opts.retryAfterSec).toBe(42);
    api.clearRateBudget(USER);
    api.injectFault({ op: 'publish', kind: 'timeout', applied: true });
    expect(() => api.publish({ userId: USER, creationId: c2.id, accessToken: TOKEN })).toThrow(/timeout/);
    expect(api.findPublishedByContainer({ creationId: c2.id, userId: USER, accessToken: TOKEN })).not.toBeNull();
    const c3 = api.createContainer({ userId: USER, text: 'c', accessToken: TOKEN });
    api.injectFault({ op: 'publish', kind: 'server_error', sideEffect: 'unknown', applied: false });
    expect(() => api.publish({ userId: USER, creationId: c3.id, accessToken: TOKEN })).toThrow(/server_error/);
    expect(api.findPublishedByContainer({ creationId: c3.id, userId: USER, accessToken: TOKEN })).toBeNull();
  });
});

describe('오류 분류(classifyThreadsError → classifyOutcome)', () => {
  const table: Array<[ThreadsErrorKind, 'none' | 'unknown', string, string]> = [
    ['auth_invalid_token', 'none', 'auth', 'blocked'],
    ['permission_denied', 'none', 'permanent', 'permanent_failure'],
    ['invalid_parameter', 'none', 'permanent', 'permanent_failure'],
    ['rate_limited', 'none', 'transient_no_side_effect', 'transient_failure'],
    ['server_error', 'none', 'transient_no_side_effect', 'transient_failure'],
    ['server_error', 'unknown', 'transient_unknown_side_effect', 'ambiguous'],
    ['timeout', 'none', 'transient_unknown_side_effect', 'ambiguous'],
    ['not_found', 'none', 'transient_unknown_side_effect', 'ambiguous'],
  ];
  it.each(table)('%s (side_effect %s) → %s → %s', (kind, sideEffect, retryClass, event) => {
    const r = classifyThreadsError(new ThreadsMockApiError(kind, { sideEffect, retryAfterSec: 7 }), 'publish');
    expect(r.retry_class).toBe(retryClass);
    expect(classifyOutcome(r).event).toBe(event);
    if (kind === 'rate_limited') expect(r.retry_after_sec).toBe(7);
  });
  it('모든 오류 종류가 표에 있다, 읽기의 5xx 는 부작용 없음, 이미 게시된 컨테이너는 조회로', () => {
    expect(new Set(table.map((t) => t[0]))).toEqual(new Set(THREADS_ERROR_KINDS));
    expect(classifyThreadsError(new ThreadsMockApiError('server_error', { sideEffect: 'unknown' }), 'getContainer').retry_class).toBe('transient_no_side_effect');
    expect(classifyOutcome(classifyThreadsError(new ThreadsMockApiError('invalid_parameter', { code: 'container_already_published' }), 'publish')).event).toBe('ambiguous');
    expect(classifyThreadsError(new Error('boom'), 'publish')).toMatchObject({ status: 'ambiguous', error_code: 'adapter_error' });
  });
});

describe('ThreadsMockChannelAdapter', () => {
  it('capabilities: 텍스트만·조회 가능·취소 불가·잠정 요청 제한(확인일 없음, 출처 provisional)', () => {
    const a = new ThreadsMockChannelAdapter({ api: new ThreadsMockApi({ tokenCheck }) });
    const caps = a.capabilities(snapshot(['x']).account);
    expect(caps).toMatchObject({ read: true, cancel: false, mock: true, media: false, adapter: 'mock_threads', definitive_not_found: true });
    expect(caps.text).toMatchObject({ max_post_chars: THREADS_MAX, max_posts: THREADS_MAX_PARTS, checked_at: null });
    expect(caps.rate_limit?.checked_at).toBeNull();
    expect(caps.rate_limit?.source).toMatch(/provisional/);
    expect(a.rateUnits(snapshot(['a', 'b', 'c']))).toBe(3);
  });

  it('validate: 첨부 → media_not_supported_t14, 글자 수·게시물 수 → invalid_parameter, 모의 계정·mock_publish·threads 만', () => {
    const a = new ThreadsMockChannelAdapter({ api: new ThreadsMockApi({ tokenCheck }) });
    expect(a.validate(snapshot(['ok']))).toEqual({ ok: true });
    expect(a.validate(snapshot(['ok'], { payload: { text: { posts: ['ok'] }, assets: [{ id: 'x' }] } }))).toEqual({ ok: false, error_code: 'media_not_supported_t14' });
    expect(a.validate(snapshot(['a'.repeat(THREADS_MAX + 1)]))).toEqual({ ok: false, error_code: 'invalid_parameter' });
    expect(a.validate(snapshot([]))).toEqual({ ok: false, error_code: 'invalid_parameter' });
    expect(a.validate(snapshot(Array.from({ length: THREADS_MAX_PARTS + 1 }, () => 'p')))).toEqual({ ok: false, error_code: 'invalid_parameter' });
    expect(a.validate(snapshot(['ok'], { requested_result: 'public_publish' }))).toEqual({ ok: false, error_code: 'mock_only' });
    expect(a.validate(snapshot(['ok'], { channel: 'instagram' }))).toEqual({ ok: false, error_code: 'channel_not_supported' });
    expect(a.validate(snapshot(['ok'], { account: { id: 'x', kind: 'live', platform: 'threads', external_account_id: 'real' } }))).toEqual({ ok: false, error_code: 'not_mock_account' });
  });

  it('스레드 3개: 컨테이너 → 게시 순서, 다음 게시물은 앞 게시 ID 에 답글, 단계는 원격 호출 전에 기록, 결과 MOCK 링크', async () => {
    const api = new ThreadsMockApi({ tokenCheck });
    const a = new ThreadsMockChannelAdapter({ api });
    const steps = memSteps();
    const order: string[] = [];
    const record = steps.record;
    steps.record = async (s) => {
      order.push(`${s.kind}:${s.post_index}:${s.status}`);
      return record(s);
    };
    const c = ctxOf(steps);
    const r = await a.submit(await a.prepare(snapshot(['하나', '둘', '셋']), c), c);
    expect(r.status).toBe('accepted');
    expect(order).toEqual(['container:0:finished', 'publish:0:published', 'container:1:finished', 'publish:1:published', 'container:2:finished', 'publish:2:published']);
    const posts = api.postsOf(USER);
    expect(posts.map((p) => p.text)).toEqual(['하나', '둘', '셋']);
    expect(posts[0]!.replyToId).toBeNull();
    expect(posts[1]!.replyToId).toBe(posts[0]!.id);
    expect(posts[2]!.replyToId).toBe(posts[1]!.id);
    expect(r.external_id).toBe(`mock:threads:${posts[0]!.id}`);
    expect(r.permalink).toBe(`mock://threads/${posts[0]!.id}`);
    expect(r).toMatchObject({ result_kind: 'UPLOADED_PRIVATE', remote_visibility: 'private' });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    // 다시 submit(재개) 해도 이미 게시된 게시물은 다시 게시하지 않는다
    const again = await a.submit(await a.prepare(snapshot(['하나', '둘', '셋']), c), c);
    expect(again.status).toBe('accepted');
    expect(api.postsOf(USER)).toHaveLength(3);
    expect(api.calls.createContainer).toBe(3);
    expect(api.calls.publish).toBe(3);
    expect([...api.publishCount.values()]).toEqual([1, 1, 1]);
  });

  it('연결 정보를 쓸 수 없으면 prepare 가 막고 submit 은 원격 호출 없이 auth(코드만, 토큰 없음)', async () => {
    const api = new ThreadsMockApi({ tokenCheck });
    const a = new ThreadsMockChannelAdapter({ api });
    const c = ctxOf(memSteps(), { credential: { accessToken: async () => ({ ok: false, code: 'credential_expired' }) } });
    const prepared = await a.prepare(snapshot(['x']), c);
    expect(JSON.stringify(prepared.data)).not.toContain('mockthr_at_');
    const r = await a.submit(prepared, c);
    expect(r).toMatchObject({ status: 'rejected', retry_class: 'auth', error_code: 'credential_expired' });
    const none = ctxOf(memSteps(), { credential: undefined });
    expect(await a.submit(await a.prepare(snapshot(['x']), none), none)).toMatchObject({ retry_class: 'auth', error_code: 'credential_unavailable' });
    expect(Object.values(api.calls).reduce((x, y) => x + y, 0)).toBe(0);
    // prepare 결과(data)에는 토큰이 없다
    const ok = await a.prepare(snapshot(['x']), ctxOf(memSteps()));
    expect(inspect(ok, { depth: Infinity })).not.toContain(TOKEN);
  });

  it('A08 응답 유실(원격은 게시) → ambiguous → 조회가 컨테이너로 게시물을 찾아 found(재게시 없음)', async () => {
    const api = new ThreadsMockApi({ tokenCheck });
    const a = new ThreadsMockChannelAdapter({ api });
    const steps = memSteps();
    const snap = snapshot(['한 줄']);
    const c = ctxOf(steps, scen('threads_publish_timeout_sent'));
    const r = await a.submit(await a.prepare(snap, c), c);
    expect(classifyOutcome(r).event).toBe('ambiguous');
    expect(steps.rows.map((s) => `${s.kind}:${s.status}`)).toEqual(['container:finished']);
    const rc = await a.reconcile(ref, ctxOf(steps, { snapshot: snap }));
    expect(rc.status).toBe('found');
    expect(rc.external_id).toMatch(/^mock:threads:mockthr_post_/);
    expect(steps.rows.map((s) => `${s.kind}:${s.status}`)).toEqual(['container:finished', 'publish:published']);
    expect(api.calls.publish).toBe(1);
    expect(api.calls.createContainer).toBe(1);
  });

  it('A08 시간 초과(원격 게시 안 됨) → 조회 resumable → 다음 시도는 같은 컨테이너로 게시(새 컨테이너 없음)', async () => {
    const api = new ThreadsMockApi({ tokenCheck });
    const a = new ThreadsMockChannelAdapter({ api });
    const steps = memSteps();
    const snap = snapshot(['한 줄']);
    const c1 = ctxOf(steps, scen('threads_publish_timeout_not_sent'));
    expect(classifyOutcome(await a.submit(await a.prepare(snap, c1), c1)).event).toBe('ambiguous');
    const rc = await a.reconcile(ref, ctxOf(steps, { snapshot: snap }));
    expect(rc).toMatchObject({ status: 'resumable', published_parts: 0 });
    const container = steps.rows[0]!.remote_id;
    const c2 = ctxOf(steps, { ...scen('threads_publish_timeout_not_sent'), attempt: 2 });
    const r2 = await a.submit(await a.prepare(snap, c2), c2);
    expect(r2.status).toBe('accepted');
    expect(api.containerIds(USER)).toEqual([container]);
    expect(api.publishCount.get(container)).toBe(1);
  });

  it('컨테이너 처리 지연 → processing(조회 예산), 조회 → FINISHED·resumable, 같은 컨테이너로 게시', async () => {
    const api = new ThreadsMockApi({ tokenCheck });
    const a = new ThreadsMockChannelAdapter({ api, pollBudget: 3 });
    const steps = memSteps();
    const snap = snapshot(['느린 글']);
    const c1 = ctxOf(steps, scen('threads_container_slow'));
    const r = await a.submit(await a.prepare(snap, c1), c1);
    expect(r.status).toBe('processing');
    expect(classifyOutcome(r).event).toBe('remote_accepted');
    expect(api.calls.getContainer).toBe(3);
    expect(await a.reconcile(ref, ctxOf(steps, { snapshot: snap }))).toMatchObject({ status: 'resumable', published_parts: 0 });
    const c2 = ctxOf(steps, { ...scen('threads_container_slow'), attempt: 2 });
    expect((await a.submit(await a.prepare(snap, c2), c2)).status).toBe('accepted');
    expect(api.containerIds(USER)).toHaveLength(1);
  });

  it('부분 스레드: 3번째 게시물 5xx(결과 불명) → 조회 resumable(2) → 3번째부터만 이어서(1·2 재게시 없음)', async () => {
    const api = new ThreadsMockApi({ tokenCheck });
    const a = new ThreadsMockChannelAdapter({ api });
    const steps = memSteps();
    const snap = snapshot(['1', '2', '3']);
    const c1 = ctxOf(steps, scen('threads_thread_partial'));
    const r1 = await a.submit(await a.prepare(snap, c1), c1);
    expect(classifyOutcome(r1).event).toBe('ambiguous');
    expect(await a.reconcile(ref, ctxOf(steps, { snapshot: snap }))).toMatchObject({ status: 'resumable', published_parts: 2 });
    const c2 = ctxOf(steps, { ...scen('threads_thread_partial'), attempt: 2 });
    expect((await a.submit(await a.prepare(snap, c2), c2)).status).toBe('accepted');
    expect(api.calls.createContainer).toBe(3);
    expect([...api.publishCount.values()]).toEqual([1, 1, 1]);
    const posts = api.postsOf(USER);
    expect(posts[2]!.replyToId).toBe(posts[1]!.id);
  });

  it('조회: 단계 없음 → not_found(게시는 기록된 컨테이너로만), 모르는 컨테이너(재시작)·만료 → unknown, 토큰 없음 → unknown', async () => {
    const api = new ThreadsMockApi({ tokenCheck });
    const a = new ThreadsMockChannelAdapter({ api });
    const snap = snapshot(['x']);
    expect((await a.reconcile(ref, ctxOf(memSteps(), { snapshot: snap }))).status).toBe('not_found');
    const steps = memSteps();
    const c = ctxOf(steps, scen('threads_publish_timeout_not_sent'));
    await a.submit(await a.prepare(snap, c), c);
    api.expireContainer(steps.rows[0]!.remote_id);
    expect(await a.reconcile(ref, ctxOf(steps, { snapshot: snap }))).toMatchObject({ status: 'unknown', error_code: 'container_expired' });
    api.reset();
    expect(await a.reconcile(ref, ctxOf(steps, { snapshot: snap }))).toMatchObject({ status: 'unknown' });
    expect(await a.reconcile(ref, ctxOf(steps, { snapshot: snap, credential: { accessToken: async () => ({ ok: false, code: 'credential_revoked' }) } }))).toMatchObject({
      status: 'unknown',
      error_code: 'credential_revoked',
    });
  });

  it.each<[MockScenarioValue, string, string]>([
    ['threads_rate_limited', 'transient_failure', 'rate_limited'],
    ['threads_token_invalid', 'blocked', 'auth_invalid_token'],
    ['threads_text_too_long', 'permanent_failure', 'invalid_parameter:text_too_long'],
  ])('시나리오 %s → %s(%s), 첫 시도에서만(400 제외)', async (scenario, event, code) => {
    const api = new ThreadsMockApi({ tokenCheck });
    const a = new ThreadsMockChannelAdapter({ api });
    const snap = snapshot(['x']);
    const c = ctxOf(memSteps(), scen(scenario));
    const r = await a.submit(await a.prepare(snap, c), c);
    expect(classifyOutcome(r).event).toBe(event);
    expect(r.error_code).toBe(code);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    const c2 = ctxOf(memSteps(), { ...scen(scenario), attempt: 2 });
    const r2 = await a.submit(await a.prepare(snap, c2), c2);
    expect(r2.status).toBe(scenario === 'threads_text_too_long' ? 'rejected' : 'accepted');
  });

  it('원격 취소는 지원하지 않는다(성공을 꾸며내지 않음)', async () => {
    const a = new ThreadsMockChannelAdapter({ api: new ThreadsMockApi({ tokenCheck }) });
    expect(await a.cancel(ref, ctxOf(memSteps()))).toMatchObject({ status: 'unsupported' });
  });
});

describe('어댑터 선택 규칙(D26)', () => {
  it('모의 + threads + 연결 정보 사용(linked·needs_reconnect) → mock_threads, 연결한 적 없음 → mock_generic, live → 없음', () => {
    expect(adapterIdFor({ kind: 'mock', platform: 'threads', credential_state: 'linked' })).toBe('mock_threads');
    expect(adapterIdFor({ kind: 'mock', platform: 'threads', credential_state: 'needs_reconnect' })).toBe('mock_threads');
    expect(adapterIdFor({ kind: 'mock', platform: 'threads', credential_state: 'none' })).toBe('mock_generic');
    expect(adapterIdFor({ kind: 'mock', platform: 'threads' })).toBe('mock_generic');
    expect(adapterIdFor({ kind: 'mock', platform: 'instagram', credential_state: 'linked' })).toBe('mock_generic');
    expect(adapterIdFor({ kind: 'live', platform: 'threads', credential_state: 'linked' })).toBeNull();
    const reg = new MockChannelAdapterRegistry(new MockChannelAdapter({ readEnv: false }), new ThreadsMockChannelAdapter({ api: new ThreadsMockApi({ tokenCheck }) }));
    expect(reg.getAdapterFor({ kind: 'mock', platform: 'threads', credential_state: 'linked' })).toBe(reg.threads);
    expect(reg.getAdapterFor({ kind: 'mock', platform: 'threads', credential_state: 'none' })).toBe(reg.mock);
    expect(() => reg.getAdapterFor({ kind: 'live', platform: 'threads', credential_state: 'linked' })).toThrow(LiveChannelNotConfiguredError);
    expect(reg.getAdapterById('mock_threads')).toBe(reg.threads);
    expect(reg.getAdapterById('mock_generic')).toBe(reg.mock);
    expect(reg.getAdapterById('live')).toBeNull();
  });
});
