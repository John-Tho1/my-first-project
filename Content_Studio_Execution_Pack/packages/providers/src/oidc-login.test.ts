/**
 * T21-P1b: OidcLoginClient(openid-client 6.8.8 감쌈) — 프로세스 안 가짜 IdP(tests/helpers/fake-oidc-idp.ts)만 쓴다. 실제 네트워크 0.
 * 확인: 인증 URL(PKCE S256·state·nonce·scope·redirect), code 교환 + ID token 검증(서명·iss·aud·exp·nonce)은 라이브러리가 거부,
 * 실패 분류(invalid | unavailable), 시간 제한(주입 fetch 가 signal 을 무시해도), https·허용 호스트, discovery 캐시, 오류에 값 없음.
 */
import { describe, expect, it } from 'vitest';
import type { OidcClientSettings } from '@cs/domain';
import { createFakeIdp, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_ISSUER, type FakeIdp } from '../../../tests/helpers/fake-oidc-idp';
import { OidcLoginClient, OidcLoginFailure } from './oidc-login';

const REDIRECT = 'http://localhost:3000/api/auth/oidc/callback';
const settings = (over: Partial<OidcClientSettings> = {}): OidcClientSettings => ({
  issuer: FAKE_ISSUER,
  clientId: FAKE_CLIENT_ID,
  clientSecret: FAKE_CLIENT_SECRET,
  redirectUri: REDIRECT,
  scopes: ['openid', 'email'],
  ...over,
});
const USER = { sub: 'sub-123', email: 'owner@example.local', email_verified: true };

function setup(opts: { timeoutMs?: number } = {}) {
  const idp = createFakeIdp();
  const client = new OidcLoginClient(settings(), { fetch: idp.fetch, timeoutMs: opts.timeoutMs });
  return { idp, client };
}

async function roundTrip(idp: FakeIdp, client: OidcLoginClient, mutate?: (p: URLSearchParams, req: { state: string; nonce: string; codeVerifier: string }) => void) {
  const req = await client.createAuthorizationRequest();
  const cb = new URL(idp.authorize(req.url, USER));
  const params = cb.searchParams;
  mutate?.(params, req);
  return client.completeAuthorization({ callbackParams: params, expectedState: req.state, expectedNonce: req.nonce, codeVerifier: req.codeVerifier });
}

async function failure(p: Promise<unknown>): Promise<OidcLoginFailure> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OidcLoginFailure);
    const f = e as OidcLoginFailure;
    // 값 없는 오류: 시크릿·code·URL 이 메시지·속성에 없고 cause 도 없다
    const text = `${f.message} ${JSON.stringify(f)} ${String((f as Error & { cause?: unknown }).cause ?? '')}`;
    for (const s of [FAKE_CLIENT_SECRET, 'idp.test', 'code=', 'eyJ']) expect(text).not.toContain(s);
    return f;
  }
  throw new Error('expected failure');
}

describe('인증 요청', () => {
  it('인증 URL: response_type=code · PKCE S256 · state · nonce · scope · redirect_uri(설정값)', async () => {
    const { client } = setup();
    const req = await client.createAuthorizationRequest();
    const u = new URL(req.url);
    expect(`${u.origin}${u.pathname}`).toBe(`${FAKE_ISSUER}/authorize`);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe(FAKE_CLIENT_ID);
    expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(u.searchParams.get('scope')).toBe('openid email');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toBe(req.state);
    expect(u.searchParams.get('nonce')).toBe(req.nonce);
    expect(u.searchParams.get('code_challenge')).not.toBe(req.codeVerifier);
    expect(req.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(req.url).not.toContain(FAKE_CLIENT_SECRET);
  });

  it('discovery 는 캐시한다(두 번째 시작은 discovery·JWKS 요청 없음)', async () => {
    const { idp, client } = setup();
    await roundTrip(idp, client);
    const before = idp.calls.filter((c) => c.path.includes('.well-known') || c.path === '/jwks').length;
    await roundTrip(idp, client);
    expect(idp.calls.filter((c) => c.path.includes('.well-known') || c.path === '/jwks').length).toBe(before);
  });

  it('discovery 실패(500)·issuer 불일치·http 엔드포인트·지원하지 않는 클라이언트 인증 → unavailable/discovery', async () => {
    for (const change of [
      (b: FakeIdp['behavior']) => (b.discoveryStatus = 500),
      (b: FakeIdp['behavior']) => (b.metadata = { issuer: 'https://other.test' }),
      (b: FakeIdp['behavior']) => (b.metadata = { token_endpoint: 'http://idp.test/token' }),
      (b: FakeIdp['behavior']) => (b.metadata = { token_endpoint_auth_methods_supported: ['private_key_jwt'] }),
    ]) {
      const { idp, client } = setup();
      change(idp.behavior);
      const f = await failure(client.createAuthorizationRequest());
      expect([f.kind, f.step]).toEqual(['unavailable', 'discovery']);
    }
  });
});

describe('callback — 성공', () => {
  it('검증된 클레임(sub·email·email_verified), 클라이언트 인증은 client_secret_basic', async () => {
    const { idp, client } = setup();
    const claims = await roundTrip(idp, client);
    expect(claims).toEqual({ sub: 'sub-123', email: 'owner@example.local', email_verified: true });
    expect(idp.authMethods).toEqual(['basic']);
  });

  it('IdP 가 client_secret_post 만 알리면 post', async () => {
    const { idp, client } = setup();
    idp.behavior.metadata = { token_endpoint_auth_methods_supported: ['client_secret_post'] };
    await roundTrip(idp, client);
    expect(idp.authMethods).toEqual(['post']);
  });
});

describe('callback — 라이브러리 검증 실패는 invalid', () => {
  it.each([
    ['nonce 불일치', { claims: { nonce: 'other-nonce' } }],
    ['iss 불일치', { claims: { iss: 'https://evil.test' } }],
    ['aud 불일치', { claims: { aud: 'someone-else' } }],
    ['만료된 ID token', { claims: { exp: Math.floor(Date.now() / 1000) - 600, iat: Math.floor(Date.now() / 1000) - 900 } }],
    ['다른 키 서명', { signWithOtherKey: true }],
    ['ID token 없음', { omitIdToken: true }],
    ['token 400(invalid_request)', { tokenStatus: 400 }],
  ] as const)('%s', async (_name, behavior) => {
    const { idp, client } = setup();
    Object.assign(idp.behavior, behavior);
    const f = await failure(roundTrip(idp, client));
    expect(f.kind).toBe('invalid');
  });

  it('state 불일치·code 재사용·PKCE verifier 불일치', async () => {
    const { idp, client } = setup();
    expect((await failure(roundTrip(idp, client, (p) => p.set('state', 'x'.repeat(43))))).kind).toBe('invalid');
    // code 재사용
    const req = await client.createAuthorizationRequest();
    const params = new URL(idp.authorize(req.url, USER)).searchParams;
    const input = { callbackParams: params, expectedState: req.state, expectedNonce: req.nonce, codeVerifier: req.codeVerifier };
    await client.completeAuthorization(input);
    expect((await failure(client.completeAuthorization(input))).kind).toBe('invalid');
    // 다른 verifier
    const req2 = await client.createAuthorizationRequest();
    const params2 = new URL(idp.authorize(req2.url, USER)).searchParams;
    const f = await failure(client.completeAuthorization({ callbackParams: params2, expectedState: req2.state, expectedNonce: req2.nonce, codeVerifier: req.codeVerifier }));
    expect(f.kind).toBe('invalid');
  });
});

describe('callback — IdP 장애는 unavailable', () => {
  it('token 500', async () => {
    const { idp, client } = setup();
    idp.behavior.tokenStatus = 500;
    expect((await failure(roundTrip(idp, client))).kind).toBe('unavailable');
  });

  it('전송 실패(시간 초과 오류)', async () => {
    const { idp, client } = setup();
    idp.behavior.tokenThrow = new DOMException('timed out', 'TimeoutError');
    expect((await failure(roundTrip(idp, client))).kind).toBe('unavailable');
  });

  it('응답 없음 → 시간 제한(주입 fetch 가 signal 을 무시해도 경쟁으로 끊음)', async () => {
    const idp = createFakeIdp();
    let hung = false;
    const ignoringFetch: typeof idp.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/token')) {
        hung = true;
        return new Promise<Response>(() => {}); // signal 무시, 영원히 대기
      }
      return idp.fetch(input, init);
    };
    const client = new OidcLoginClient(settings(), { fetch: ignoringFetch, timeoutMs: 300 });
    const started = Date.now();
    const f = await failure(roundTrip(idp, client));
    expect(hung).toBe(true);
    expect(f.kind).toBe('unavailable');
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('네트워크 가드', () => {
  it('discovery 문서가 알린 호스트 밖·http 로는 요청하지 않는다', async () => {
    const idp = createFakeIdp();
    const seen: string[] = [];
    const client = new OidcLoginClient(settings(), {
      fetch: (input, init) => {
        seen.push(new URL(String(input)).host);
        return idp.fetch(input, init);
      },
    });
    await roundTrip(idp, client);
    expect([...new Set(seen)]).toEqual(['idp.test']);
  });
});
