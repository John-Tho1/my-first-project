/** T13(D24): 모의 Threads OAuth 공급자(네트워크 없음)·공급자 선택(live 는 항상 거부). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codeChallengeS256, loadConfig, LiveOAuthNotConfiguredError, newCodeVerifier, newOAuthState, OAuthNotSupportedError, OAuthProviderError } from '@cs/domain';
import { MOCK_CODE_TTL_MS, MOCK_THREADS_CLIENT_ID, MockOAuthStore, MockThreadsOAuthProvider, resolveOAuthProvider } from './oauth';

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
    expect(() => resolveOAuthProvider({ kind: 'mock', platform: 'instagram' }, config, {}, REDIRECT)).toThrow(OAuthNotSupportedError);
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
