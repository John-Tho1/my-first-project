/**
 * T21-P1b 시험 전용: 프로세스 안 가짜 OpenID Connect 공급자(IdP). **실제 네트워크 없음** — fetch 함수로만 응답한다
 * (vi.stubGlobal('fetch', idp.fetch) 또는 OidcLoginClient 의 fetch 주입). 호스트는 예약 TLD .test(가드가 실제 연결을 막는다).
 *
 * 제공: discovery 문서, JWKS(생성한 RSA 키), token endpoint(코드·PKCE S256·redirect_uri·클라이언트 인증 확인 → RS256 서명 ID token).
 * 인증 화면은 흉내만: authorize(authUrl, user) 가 인증 URL 의 매개변수를 확인하고 code 를 발급한 뒤 callback URL 을 돌려준다.
 * 시험이 바꿀 수 있는 동작(behavior): ID token 클레임 덮어쓰기(iss·aud·exp·nonce 등), 다른 키로 서명, token 응답 상태·지연·전송 실패, 메타데이터 덮어쓰기.
 * 서명은 node:crypto(RSASSA-PKCS1-v1_5/SHA-256) — 시험 픽스처일 뿐, 앱 코드의 검증은 openid-client 가 한다.
 */
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

export const FAKE_ISSUER = 'https://idp.test';
export const FAKE_CLIENT_ID = 'cs-test-client';
export const FAKE_CLIENT_SECRET = 'FAKE_oidc_client_secret_T21P1B_test_only';

export interface FakeUser {
  sub: string;
  email?: unknown;
  email_verified?: unknown;
}

export interface FakeIdpBehavior {
  /** ID token 클레임 덮어쓰기(undefined 값은 그 클레임을 지운다). */
  claims?: Record<string, unknown>;
  /** 다른 키로 서명(같은 kid — 서명 불일치). */
  signWithOtherKey?: boolean;
  /** token endpoint 응답 상태(기본 200). 500 이면 JSON 오류 본문. */
  tokenStatus?: number;
  /** token endpoint: 응답하지 않음(요청의 signal 이 끊을 때까지). */
  tokenHang?: boolean;
  /** token endpoint: 전송 실패(시간 초과처럼). */
  tokenThrow?: Error;
  /** discovery 실패(상태). */
  discoveryStatus?: number;
  /** discovery 문서 덮어쓰기. */
  metadata?: Record<string, unknown>;
  /** ID token 을 빼고 응답. */
  omitIdToken?: boolean;
  /** FIX-T21P1B: ID token 서명 방식 바꾸기 — none(서명 없음) · HS256(클라이언트 시크릿 HMAC). 기본 RS256. */
  idTokenAlg?: 'none' | 'HS256';
}

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string;
  user: FakeUser;
  used: boolean;
}

const b64u = (v: Buffer | string) => Buffer.from(v).toString('base64url');

export interface FakeIdp {
  issuer: string;
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  behavior: FakeIdpBehavior;
  /** 요청 기록(메서드·경로) — 본문·헤더 값은 남기지 않는다. */
  calls: Array<{ method: string; path: string }>;
  /** token 요청에서 받은 클라이언트 인증 방식(basic | post). */
  authMethods: string[];
  /** 사용자가 IdP 에서 로그인을 마쳤다고 치고 callback URL(redirect_uri?code&state)을 만든다. 인증 URL 매개변수가 틀리면 던진다. */
  authorize(authorizationUrl: string, user: FakeUser): string;
  /** 사용자가 IdP 에서 거부한 callback URL(error=access_denied). */
  deny(authorizationUrl: string): string;
  /** FIX-T21P1B: 서명 키 교체(새 kid·새 키 — JWKS 도 새 키만 알린다). */
  rotateKey(): void;
}

export function createFakeIdp(opts: { issuer?: string; clientId?: string; clientSecret?: string; jwksUri?: string } = {}): FakeIdp {
  const issuer = opts.issuer ?? FAKE_ISSUER;
  // FIX-T21P1B: JWKS 를 issuer 와 다른 호스트에 둘 수 있다(예: https://keys.test/jwks)
  const jwksUri = opts.jwksUri ?? `${issuer}/jwks`;
  const clientId = opts.clientId ?? FAKE_CLIENT_ID;
  const clientSecret = opts.clientSecret ?? FAKE_CLIENT_SECRET;
  let kid = 'fake-key-1';
  let keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const toJwk = () => ({ ...(keyPair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>), kid, alg: 'RS256', use: 'sig' });
  let jwk = toJwk();
  const codes = new Map<string, IssuedCode>();
  const behavior: FakeIdpBehavior = {};
  const calls: FakeIdp['calls'] = [];
  const authMethods: string[] = [];

  const metadata = () => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: jwksUri,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    scopes_supported: ['openid', 'email'],
    ...(behavior.metadata ?? {}),
  });

  const signJwt = (payload: Record<string, unknown>, key: KeyObject) => {
    const alg = behavior.idTokenAlg ?? 'RS256';
    const header = b64u(JSON.stringify(alg === 'RS256' ? { alg, kid, typ: 'JWT' } : { alg, typ: 'JWT' }));
    const body = b64u(JSON.stringify(payload));
    if (alg === 'none') return `${header}.${body}.`;
    if (alg === 'HS256') return `${header}.${body}.${b64u(createHmac('sha256', clientSecret).update(`${header}.${body}`).digest())}`;
    const sig = sign('sha256', Buffer.from(`${header}.${body}`), key);
    return `${header}.${body}.${b64u(sig)}`;
  };

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const parseAuthUrl = (authorizationUrl: string) => {
    const u = new URL(authorizationUrl);
    if (`${u.origin}${u.pathname}` !== `${issuer}/authorize`) throw new Error('fake idp: wrong authorization endpoint');
    const p = u.searchParams;
    if (p.get('response_type') !== 'code') throw new Error('fake idp: response_type');
    if (p.get('client_id') !== clientId) throw new Error('fake idp: client_id');
    if (p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) throw new Error('fake idp: pkce');
    if (!(p.get('scope') ?? '').split(' ').includes('openid')) throw new Error('fake idp: scope');
    if (!p.get('state') || !p.get('nonce')) throw new Error('fake idp: state/nonce');
    return p;
  };

  async function token(init: RequestInit | undefined): Promise<Response> {
    if (behavior.tokenThrow) throw behavior.tokenThrow;
    if (behavior.tokenHang) {
      await new Promise<never>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }
    if (behavior.tokenStatus && behavior.tokenStatus >= 500) return json(behavior.tokenStatus, { error: 'server_error' });
    const headers = new Headers(init?.headers);
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : '');
    // 클라이언트 인증(basic 또는 post)
    let id: string | null = null;
    let secret: string | null = null;
    const authz = headers.get('authorization');
    if (authz?.startsWith('Basic ')) {
      const [a, b] = Buffer.from(authz.slice(6), 'base64').toString('utf8').split(':');
      id = decodeURIComponent(a ?? '');
      secret = decodeURIComponent(b ?? '');
      authMethods.push('basic');
    } else if (form.get('client_secret')) {
      id = form.get('client_id');
      secret = form.get('client_secret');
      authMethods.push('post');
    }
    if (id !== clientId || secret !== clientSecret) return json(401, { error: 'invalid_client' });
    if (form.get('grant_type') !== 'authorization_code') return json(400, { error: 'unsupported_grant_type' });
    const code = form.get('code') ?? '';
    const issued = codes.get(code);
    if (!issued || issued.used) return json(400, { error: 'invalid_grant' });
    issued.used = true;
    if (form.get('redirect_uri') !== issued.redirectUri) return json(400, { error: 'invalid_grant' });
    const verifier = form.get('code_verifier') ?? '';
    if (createHash('sha256').update(verifier, 'ascii').digest('base64url') !== issued.codeChallenge) return json(400, { error: 'invalid_grant' });
    if (behavior.tokenStatus && behavior.tokenStatus !== 200) return json(behavior.tokenStatus, { error: 'invalid_request' });
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: issuer,
      aud: clientId,
      sub: issued.user.sub,
      iat: now,
      exp: now + 300,
      nonce: issued.nonce,
      ...(issued.user.email !== undefined ? { email: issued.user.email } : {}),
      ...(issued.user.email_verified !== undefined ? { email_verified: issued.user.email_verified } : {}),
    };
    for (const [k, v] of Object.entries(behavior.claims ?? {})) {
      if (v === undefined) delete claims[k];
      else claims[k] = v;
    }
    const idToken = signJwt(claims, behavior.signWithOtherKey ? otherKey : keyPair.privateKey);
    return json(200, {
      access_token: `FAKE_access_${randomBytes(8).toString('hex')}`,
      token_type: 'Bearer',
      expires_in: 300,
      ...(behavior.omitIdToken ? {} : { id_token: idToken }),
    });
  }

  const fetchImpl: FakeIdp['fetch'] = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, path: url.pathname });
    if (method === 'GET' && url.href === jwksUri) return json(200, { keys: [jwk] });
    if (url.origin !== new URL(issuer).origin) throw new TypeError('fake idp: unknown host');
    if (method === 'GET' && url.pathname === `${new URL(issuer).pathname.replace(/\/$/, '')}/.well-known/openid-configuration`) {
      if (behavior.discoveryStatus) return json(behavior.discoveryStatus, { error: 'unavailable' });
      return json(200, metadata());
    }
    if (method === 'POST' && url.href === `${issuer}/token`) return token(init);
    return json(404, { error: 'not_found' });
  };

  return {
    issuer,
    fetch: fetchImpl,
    behavior,
    calls,
    authMethods,
    authorize(authorizationUrl, user) {
      const p = parseAuthUrl(authorizationUrl);
      const code = randomBytes(24).toString('base64url');
      codes.set(code, {
        clientId,
        redirectUri: p.get('redirect_uri')!,
        codeChallenge: p.get('code_challenge')!,
        nonce: p.get('nonce')!,
        user,
        used: false,
      });
      const cb = new URL(p.get('redirect_uri')!);
      cb.searchParams.set('code', code);
      cb.searchParams.set('state', p.get('state')!);
      return cb.href;
    },
    rotateKey() {
      keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      kid = `fake-key-${randomBytes(4).toString('hex')}`;
      jwk = toJwk();
    },
    deny(authorizationUrl) {
      const p = parseAuthUrl(authorizationUrl);
      const cb = new URL(p.get('redirect_uri')!);
      cb.searchParams.set('error', 'access_denied');
      cb.searchParams.set('state', p.get('state')!);
      return cb.href;
    },
  };
}
