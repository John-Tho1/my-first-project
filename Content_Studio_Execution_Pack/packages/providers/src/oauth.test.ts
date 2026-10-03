/** T13(D24): 모의 Threads OAuth 공급자(네트워크 없음)·공급자 선택(live 는 항상 거부). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codeChallengeS256, loadConfig, LiveOAuthNotConfiguredError, newCodeVerifier, newOAuthState, OAuthNotSupportedError, OAuthProviderError } from '@cs/domain';
import {
  ensureMockOAuthRehydrated,
  mockCredentialWorkAllowed,
  MOCK_CODE_TTL_MS,
  MOCK_THREADS_CLIENT_ID,
  MockGoogleOAuthProvider,
  MockOAuthStore,
  MockThreadsOAuthProvider,
  resetMockOAuthRehydration,
  resolveOAuthProvider,
  type MockRehydrateEntry,
} from './oauth';

const REDIRECT = 'http://localhost:3000/api/oauth/callback';
const NOW = new Date('2026-10-02T12:00:00Z');
const USER = 'mock:threads:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function setup() {
  const store = new MockOAuthStore();
  const p = new MockThreadsOAuthProvider({ registeredRedirectUri: REDIRECT, appBaseUrl: 'http://localhost:3000', store });
  return { store, p };
}

function authorizeParams(url: string, extra: Record<string, string> = {}) {
  const q = new URL(url).searchParams;
  const get = (k: string) => (k in extra ? extra[k]! : q.get(k));
  return {
    client_id: get('client_id'),
    redirect_uri: get('redirect_uri'),
    response_type: get('response_type'),
    scope: get('scope'),
    state: get('state'),
    code_challenge: get('code_challenge'),
    code_challenge_method: get('code_challenge_method'),
    login_hint: get('login_hint'),
    mock_user: extra.mock_user ?? null,
    mock_grant: extra.mock_grant ?? null,
    mock_deny: extra.mock_deny ?? null,
  };
}

async function errCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof OAuthProviderError) return e.code;
    throw e;
  }
  return 'none';
}

function flow(p: MockThreadsOAuthProvider, extra: Record<string, string> = {}) {
  const verifier = newCodeVerifier();
  const state = newOAuthState();
  const url = p.buildAuthorizeUrl({ state, codeChallenge: codeChallengeS256(verifier), redirectUri: REDIRECT, scopes: p.requiredScopes(), loginHint: USER });
  const r = p.authorize(authorizeParams(url, extra), NOW);
  return { verifier, state, url, r };
}

afterEach(() => vi.restoreAllMocks());

describe('MockThreadsOAuthProvider', () => {
  it('authorize URL: 최소 scope 만(답글·통계 없음), S256, client_id·redirect_uri·state 포함, verifier 는 없음', () => {
    const { p } = setup();
    const { url, verifier } = flow(p);
    const q = new URL(url).searchParams;
    expect(q.get('scope')).toBe('threads_basic,threads_content_publish');
    expect(url).not.toMatch(/replies|insights/);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('client_id')).toBe(MOCK_THREADS_CLIENT_ID);
    expect(url).not.toContain(verifier);
  });

  it('전체 흐름: code → 토큰(60일, refresh token 없음) → 계정 정보 → 갱신(옛 토큰 무효) → 철회', async () => {
    const { p } = setup();
    const { r, verifier, state } = flow(p);
    expect(r.ok).toBe(true);
    const back = new URL((r as { redirect: string }).redirect);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe(state);
    const code = back.searchParams.get('code')!;
    const t = await p.exchangeCode({ code, codeVerifier: verifier, redirectUri: REDIRECT, now: NOW });
    expect(t.refreshToken).toBeNull();
    expect(t.scopes).toEqual(['threads_basic', 'threads_content_publish']);
    expect(t.expiresAt.getTime() - NOW.getTime()).toBe(60 * 24 * 3600_000);
    expect(t.accessToken.startsWith('mockthr_at_')).toBe(true);
    expect(await p.accountInfo({ accessToken: t.accessToken, now: NOW })).toMatchObject({ externalAccountId: USER });
    const t2 = await p.refresh({ tokens: { accessToken: t.accessToken, refreshToken: null }, now: NOW });
    expect(t2.accessToken).not.toBe(t.accessToken);
    expect(await errCode(p.accountInfo({ accessToken: t.accessToken, now: NOW }))).toBe('token_revoked');
    await p.revoke({ tokens: { accessToken: t2.accessToken, refreshToken: null }, now: NOW });
    expect(await errCode(p.accountInfo({ accessToken: t2.accessToken, now: NOW }))).toBe('token_revoked');
    expect(await errCode(p.refresh({ tokens: { accessToken: t2.accessToken, refreshToken: null }, now: NOW }))).toBe('token_revoked');
  });

  it('code: PKCE 불일치·redirect 불일치·만료·재사용·모르는 code 는 거부', async () => {
    const { p } = setup();
    const codeOf = (x: ReturnType<typeof flow>) => new URL((x.r as { redirect: string }).redirect).searchParams.get('code')!;
    const a = flow(p);
    expect(await errCode(p.exchangeCode({ code: codeOf(a), codeVerifier: newCodeVerifier(), redirectUri: REDIRECT, now: NOW }))).toBe('pkce_mismatch');
    // 실패한 code 도 다시 쓸 수 없다
    expect(await errCode(p.exchangeCode({ code: codeOf(a), codeVerifier: a.verifier, redirectUri: REDIRECT, now: NOW }))).toBe('code_reused');
    const b = flow(p);
    expect(await errCode(p.exchangeCode({ code: codeOf(b), codeVerifier: b.verifier, redirectUri: 'http://localhost:3000/other', now: NOW }))).toBe('redirect_mismatch');
    const c = flow(p);
    expect(await errCode(p.exchangeCode({ code: codeOf(c), codeVerifier: c.verifier, redirectUri: REDIRECT, now: new Date(NOW.getTime() + MOCK_CODE_TTL_MS) }))).toBe('code_expired');
    expect(await errCode(p.exchangeCode({ code: 'mockthr_code_unknown', codeVerifier: c.verifier, redirectUri: REDIRECT, now: NOW }))).toBe('invalid_grant');
  });

  it('authorize 거부: 등록되지 않은 redirect URI·plain PKCE·허용 밖 scope·client 다름. 사용자 거부는 error=access_denied 로 돌려보냄', () => {
    const { p } = setup();
    const { url } = flow(p);
    expect(p.authorize(authorizeParams(url, { redirect_uri: 'http://evil.example.test/cb' }), NOW)).toEqual({ ok: false, error: 'redirect_mismatch' });
    expect(p.authorize(authorizeParams(url, { redirect_uri: `${REDIRECT}/` }), NOW)).toEqual({ ok: false, error: 'redirect_mismatch' });
    expect(p.authorize(authorizeParams(url, { code_challenge_method: 'plain' }), NOW)).toEqual({ ok: false, error: 'invalid_request' });
    expect(p.authorize(authorizeParams(url, { scope: 'threads_basic,admin' }), NOW)).toEqual({ ok: false, error: 'scope_not_allowed' });
    expect(p.authorize(authorizeParams(url, { client_id: 'other' }), NOW)).toEqual({ ok: false, error: 'invalid_client' });
    const denied = p.authorize(authorizeParams(url, { mock_deny: '1' }), NOW);
    expect(denied.ok && new URL(denied.redirect).searchParams.get('error')).toBe('access_denied');
    expect(denied.ok && new URL(denied.redirect).searchParams.get('code')).toBeNull();
  });

  it('네트워크를 쓰지 않는다(fetch 호출 0)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const { p } = setup();
    const a = flow(p);
    const code = new URL((a.r as { redirect: string }).redirect).searchParams.get('code')!;
    const t = await p.exchangeCode({ code, codeVerifier: a.verifier, redirectUri: REDIRECT, now: NOW });
    await p.refresh({ tokens: { accessToken: t.accessToken, refreshToken: null }, now: NOW });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('resolveOAuthProvider', () => {
  const config = loadConfig({});
  it('모의 Threads 계정 → 모의 공급자, 다른 채널 → oauth_not_supported', () => {
    const p = resolveOAuthProvider({ kind: 'mock', platform: 'threads' }, config, {}, REDIRECT);
    expect(p.mock).toBe(true);
    expect(p.id).toBe('mock_threads');
    // T16: Instagram 은 Meta 형 모의 공급자가 생겼다 — 지원하지 않는 채널 예시는 블로그(같은 단언)
    expect(() => resolveOAuthProvider({ kind: 'mock', platform: 'blog' }, config, {}, REDIRECT)).toThrow(OAuthNotSupportedError);
  });
  it('실제 계정은 조건이 모두 있어도 거부(LIVE_OAUTH_ADAPTER(T14 미구현)) — 비밀 값은 메시지에 없다', () => {
    const live = loadConfig({
      OAUTH_MODE: 'live',
      THREADS_APP_ID: 'placeholder-app-id',
      OAUTH_REDIRECT_URI: 'https://studio.example.test/api/oauth/callback',
      OAUTH_LIVE_APPROVAL_REF: 'D99',
      PUBLISH_MODE: 'enabled',
    });
    const env = { THREADS_APP_SECRET: 'placeholder-secret-value', SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SECRETS_KEY_VERSION: '1' };
    try {
      resolveOAuthProvider({ kind: 'live', platform: 'threads' }, live, env, REDIRECT);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LiveOAuthNotConfiguredError);
      expect((e as LiveOAuthNotConfiguredError).missing).toEqual(['LIVE_OAUTH_ADAPTER(T14 미구현)']);
      expect((e as Error).message).not.toContain('placeholder-secret-value');
    }
    expect(() => resolveOAuthProvider({ kind: 'live', platform: 'threads' }, config, {}, REDIRECT)).toThrow(LiveOAuthNotConfiguredError);
  });
});

describe('M4-DEV1: 재시작 뒤 모의 공급자 메모리 다시 채우기', () => {
  const later = new Date(NOW.getTime() + 30 * 86_400_000);
  const thr = (over: Partial<MockRehydrateEntry> = {}): MockRehydrateEntry => ({
    provider: 'mock_threads',
    externalAccountId: USER,
    accessToken: `mockthr_at_${'a'.repeat(43)}`,
    refreshToken: null,
    expiresAt: later,
    accessExpiresAt: null,
    scopes: ['threads_basic', 'threads_content_publish'],
    ...over,
  });

  it('등록한 Threads 토큰은 공급자 규칙(계정 조회·갱신 = 이전 토큰 무효)대로 쓰인다', async () => {
    const { store, p } = setup();
    expect(store.registerRehydrated(thr())).toBe('registered');
    const tokens = { accessToken: thr().accessToken, refreshToken: null };
    expect(await p.accountInfo({ accessToken: tokens.accessToken, now: NOW })).toMatchObject({ externalAccountId: USER });
    const next = await p.refresh({ tokens, now: NOW });
    expect(next.accessToken).not.toBe(tokens.accessToken);
    expect(await errCode(p.accountInfo({ accessToken: tokens.accessToken, now: NOW }))).toBe('token_revoked');
  });

  it('Google 형: access·refresh 를 같은 동의 묶음으로 — refresh 로 갱신하면 둘 다 무효, 짧은 access 만료는 저장값 그대로', async () => {
    const store = new MockOAuthStore();
    const g = new MockGoogleOAuthProvider({ registeredRedirectUri: REDIRECT, appBaseUrl: 'http://localhost:3000', store });
    const e: MockRehydrateEntry = {
      provider: 'mock_google',
      externalAccountId: 'mock:youtube:x',
      accessToken: `mockyt_at_${'b'.repeat(43)}`,
      refreshToken: `mockyt_rt_${'c'.repeat(43)}`,
      expiresAt: later,
      accessExpiresAt: new Date(NOW.getTime() - 1000),
      scopes: ['youtube.upload(mock)'],
    };
    expect(store.registerRehydrated(e)).toBe('registered');
    expect(await errCode(g.accountInfo({ accessToken: e.accessToken, now: NOW }))).toBe('token_expired');
    const next = await g.refresh({ tokens: { accessToken: e.accessToken, refreshToken: e.refreshToken }, now: NOW });
    expect(await g.accountInfo({ accessToken: next.accessToken, now: NOW })).toMatchObject({ externalAccountId: 'mock:youtube:x' });
    expect(await errCode(g.refresh({ tokens: { accessToken: e.accessToken, refreshToken: e.refreshToken }, now: NOW }))).toBe('invalid_grant');
  });

  it('모의 아닌 공급자·접두 불일치·refresh 모양 불일치·빈 계정·이미 아는 토큰은 등록하지 않는다(철회 상태 유지)', () => {
    const store = new MockOAuthStore();
    expect(store.registerRehydrated(thr({ provider: 'threads' }))).toBe('rejected');
    expect(store.registerRehydrated(thr({ accessToken: `mockyt_at_${'a'.repeat(43)}` }))).toBe('rejected');
    expect(store.registerRehydrated(thr({ refreshToken: `mockyt_rt_${'a'.repeat(43)}` }))).toBe('rejected');
    expect(store.registerRehydrated(thr({ provider: 'mock_google', accessToken: `mockyt_at_${'d'.repeat(43)}`, refreshToken: null }))).toBe('rejected');
    expect(store.registerRehydrated(thr({ externalAccountId: '' }))).toBe('rejected');
    // FIX1-M4DEV1: 접두만 있고 본문이 빈 토큰·만료 시각이 Date 가 아닌 값도 거부(복호화는 됐지만 내용이 잘못된 행)
    expect(store.registerRehydrated(thr({ accessToken: 'mockthr_at_' }))).toBe('rejected');
    expect(store.registerRehydrated(thr({ accessToken: 'not-a-mock-token' }))).toBe('rejected');
    expect(store.registerRehydrated(thr({ expiresAt: new Date(Number.NaN) }))).toBe('rejected');
    expect(store.tokens.size).toBe(0);
    expect(store.registerRehydrated(thr())).toBe('registered');
    [...store.tokens.values()][0]!.revoked = true;
    expect(store.registerRehydrated(thr())).toBe('already_known');
    expect([...store.tokens.values()][0]!.revoked).toBe(true);
  });

  it('ensure: live 모드면 load 를 부르지 않고, 한 번만 읽고(동시 호출 공유), 실패하면 표식을 지워 다시 시도한다, reset 은 표식도 지운다', async () => {
    const store = new MockOAuthStore();
    const live = vi.fn(async () => ({ entries: [thr()], skipped: 0 }));
    expect(await ensureMockOAuthRehydrated({ oauthMode: 'live', load: live, store })).toEqual({ status: 'skipped_live_mode' });
    expect(live).not.toHaveBeenCalled();
    expect(store.rehydration).toBeNull();

    const failing = vi.fn(async (): Promise<{ entries: MockRehydrateEntry[]; skipped: number }> => {
      throw new Error('db down');
    });
    expect(await ensureMockOAuthRehydrated({ oauthMode: 'mock', load: failing, store })).toEqual({ status: 'failed' });
    expect(store.rehydration).toBeNull();

    const load = vi.fn(async () => ({ entries: [thr(), { ...thr(), provider: 'threads' }], skipped: 2 }));
    const [a, b] = await Promise.all([ensureMockOAuthRehydrated({ oauthMode: 'mock', load, store }), ensureMockOAuthRehydrated({ oauthMode: 'mock', load, store })]);
    expect(a).toBe(b);
    expect(a).toEqual({ status: 'done', registered: 1, alreadyKnown: 0, skipped: 3 });
    expect(await ensureMockOAuthRehydrated({ oauthMode: 'mock', load, store })).toBe(a);
    expect(load).toHaveBeenCalledTimes(1);
    resetMockOAuthRehydration(store);
    expect(await ensureMockOAuthRehydrated({ oauthMode: 'mock', load, store })).toEqual({ status: 'done', registered: 0, alreadyKnown: 1, skipped: 3 });
    store.reset();
    expect(store.rehydration).toBeNull();
    expect(store.tokens.size).toBe(0);
  });

  it('FIX1-M4DEV1: 내용이 잘못된 항목은 이미 아는 토큰이 아니라 건너뜀으로 센다, 실패 결과만 연결 정보 작업을 막는다', async () => {
    const store = new MockOAuthStore();
    const load = vi.fn(async () => ({ entries: [thr(), thr({ accessToken: 'garbage' })], skipped: 0 }));
    expect(await ensureMockOAuthRehydrated({ oauthMode: 'mock', load, store })).toEqual({ status: 'done', registered: 1, alreadyKnown: 0, skipped: 1 });
    expect(mockCredentialWorkAllowed({ status: 'failed' })).toBe(false);
    expect(mockCredentialWorkAllowed({ status: 'done', registered: 0, alreadyKnown: 0, skipped: 0 })).toBe(true);
    expect(mockCredentialWorkAllowed({ status: 'skipped_live_mode' })).toBe(true);
    expect(mockCredentialWorkAllowed(null)).toBe(true);
    // 실패 → 표식 지움 → 다음 호출이 다시 읽어 성공(회복)
    const store2 = new MockOAuthStore();
    let fail = true;
    const flaky = vi.fn(async () => {
      if (fail) throw new Error('db down');
      return { entries: [thr()], skipped: 0 };
    });
    expect(mockCredentialWorkAllowed(await ensureMockOAuthRehydrated({ oauthMode: 'mock', load: flaky, store: store2 }))).toBe(false);
    expect(store2.rehydration).toBeNull();
    fail = false;
    expect(await ensureMockOAuthRehydrated({ oauthMode: 'mock', load: flaky, store: store2 })).toEqual({ status: 'done', registered: 1, alreadyKnown: 0, skipped: 0 });
    expect(flaky).toHaveBeenCalledTimes(2);
  });
});
