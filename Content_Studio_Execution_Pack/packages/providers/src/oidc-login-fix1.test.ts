/**
 * FIX-T21P1B(Codex review-T21P1B): OidcLoginClient 회귀 시험 — 가짜 IdP 만(실제 네트워크 0).
 * P1(:252) 200 헤더 뒤 본문 끊김·멈춤 → unavailable(실패 횟수 제외), 정상 수신한 잘못된 응답만 invalid. token·JWKS 둘 다.
 * P1(:199) discovery 갱신이 진행 중인 callback 의 허용 호스트를 지우지 않음(별도 JWKS 호스트), 동시 discovery 는 한 번.
 * 놓친 경우: iat 미래·없음·타입 오류, exp 허용 오차 경계, 허용 밖 alg(none·HS256), JWKS 키 교체.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OidcClientSettings } from '@cs/domain';
import { createFakeIdp, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_ISSUER, type FakeIdp } from '../../../tests/helpers/fake-oidc-idp';
import { OidcLoginClient, OidcLoginFailure } from './oidc-login';

type FetchFn = FakeIdp['fetch'];
const REDIRECT = 'http://localhost:3000/api/auth/oidc/callback';
const SETTINGS: OidcClientSettings = { issuer: FAKE_ISSUER, clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET, redirectUri: REDIRECT, scopes: ['openid', 'email'] };
const USER = { sub: 'sub-123', email: 'owner@example.local', email_verified: true };

afterEach(() => {
  vi.useRealTimers();
});

async function begin(idp: FakeIdp, client: OidcLoginClient) {
  const req = await client.createAuthorizationRequest();
  const params = new URL(idp.authorize(req.url, USER)).searchParams;
  return () => client.completeAuthorization({ callbackParams: params, expectedState: req.state, expectedNonce: req.nonce, codeVerifier: req.codeVerifier });
}

async function failureOf(p: Promise<unknown>): Promise<OidcLoginFailure> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OidcLoginFailure);
    return e as OidcLoginFailure;
  }
  throw new Error('expected failure');
}

/** 200 헤더를 보낸 뒤 본문 일부만 주고 끊거나(cut) 영원히 멈추는(stall) 응답. stall 은 signal 을 무시한다. */
function brokenBody(mode: 'cut' | 'stall', firstChunk = '{"partial":'): Response {
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(new TextEncoder().encode(firstChunk));
      if (mode === 'cut') ctrl.error(new TypeError('terminated'));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

/** path 가 끝나는 요청만 바꾸는 fetch */
const overriding = (idp: FakeIdp, path: string, make: () => Response): FetchFn => async (input, init) =>
  new URL(String(input)).pathname === path ? make() : idp.fetch(input, init);

describe('P1 :252 — 본문 전송 실패는 unavailable', () => {
  for (const path of ['/token', '/jwks']) {
    it(`${path}: 200 헤더 뒤 본문 끊김 → unavailable`, async () => {
      const idp = createFakeIdp();
      const client = new OidcLoginClient(SETTINGS, { fetch: overriding(idp, path, () => brokenBody('cut')), timeoutMs: 2000 });
      const f = await failureOf((await begin(idp, client))());
      expect(f.kind).toBe('unavailable');
    });

    it(`${path}: 200 헤더 뒤 본문 멈춤(signal 무시) → 시간 제한 안에 unavailable`, async () => {
      const idp = createFakeIdp();
      const client = new OidcLoginClient(SETTINGS, { fetch: overriding(idp, path, () => brokenBody('stall')), timeoutMs: 300 });
      const started = Date.now();
      const f = await failureOf((await begin(idp, client))());
      expect(f.kind).toBe('unavailable');
      expect(Date.now() - started).toBeLessThan(5000);
    }, 10_000);
  }

  it('정상 수신한 잘못된 응답(완전한 본문, JSON 아님)은 invalid', async () => {
    const idp = createFakeIdp();
    const client = new OidcLoginClient(SETTINGS, {
      fetch: overriding(idp, '/token', () => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } })),
    });
    expect((await failureOf((await begin(idp, client))())).kind).toBe('invalid');
  });

  it('너무 큰 본문(1 MiB 초과)은 받지 않고 unavailable', async () => {
    const idp = createFakeIdp();
    const big = 'x'.repeat(1024 * 1024 + 10);
    const client = new OidcLoginClient(SETTINGS, {
      fetch: overriding(idp, '/token', () => new Response(big, { status: 200, headers: { 'content-type': 'application/json' } })),
    });
    expect((await failureOf((await begin(idp, client))())).kind).toBe('unavailable');
  });

  it('같은 Configuration 의 동시 callback: 하나는 본문 끊김(unavailable), 다른 하나는 검증 실패(invalid) — 분류가 섞이지 않는다', async () => {
    const idp = createFakeIdp();
    let n = 0;
    const client = new OidcLoginClient(SETTINGS, {
      fetch: async (input, init) => {
        if (new URL(String(input)).pathname === '/token' && n++ === 0) return brokenBody('cut');
        return idp.fetch(input, init);
      },
      timeoutMs: 2000,
    });
    const a = await begin(idp, client);
    const reqB = await client.createAuthorizationRequest();
    const paramsB = new URL(idp.authorize(reqB.url, USER)).searchParams;
    const [fa, fb] = await Promise.all([
      failureOf(a()),
      failureOf(client.completeAuthorization({ callbackParams: paramsB, expectedState: reqB.state, expectedNonce: 'wrong-nonce', codeVerifier: reqB.codeVerifier })),
    ]);
    expect(fa.kind).toBe('unavailable');
    expect(fb.kind).toBe('invalid');
  });
});

describe('P1 :199 — discovery 갱신과 진행 중 callback', () => {
  it('별도 JWKS 호스트: callback A 진행 중에 캐시가 만료돼 B 가 discovery 를 시작해도 A 의 JWKS 요청은 허용된다', async () => {
    const idp = createFakeIdp({ jwksUri: 'https://keys.test/jwks' });
    let now = 1_000_000;
    let releaseToken!: () => void;
    const tokenGate = new Promise<void>((r) => (releaseToken = r));
    let releaseDiscovery!: () => void;
    const discoveryGate = new Promise<void>((r) => (releaseDiscovery = r));
    let tokenWaiting!: () => void;
    const tokenReached = new Promise<void>((r) => (tokenWaiting = r));
    let discoveries = 0;
    const fetchFn: FetchFn = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/token') {
        tokenWaiting();
        await tokenGate;
      }
      if (path.endsWith('/openid-configuration') && ++discoveries === 2) await discoveryGate;
      return idp.fetch(input, init);
    };
    const client = new OidcLoginClient(SETTINGS, { fetch: fetchFn, now: () => now, discoveryTtlMs: 1000 });
    const a = await begin(idp, client); // discovery 1회(JWKS 는 아직 안 받음)
    const pa = a();
    await tokenReached; // A 가 token 요청 중
    now += 5000; // 캐시 만료
    const pb = client.createAuthorizationRequest(); // B: 두 번째 discovery(게이트에서 멈춤)
    await new Promise((r) => setTimeout(r, 20));
    releaseToken(); // A 계속 → keys.test 로 JWKS 요청
    const claims = await pa;
    expect(claims.sub).toBe('sub-123');
    releaseDiscovery();
    await pb;
    expect(discoveries).toBe(2);
  });

  it('동시 discovery 는 하나의 진행 중 요청으로 합친다', async () => {
    const idp = createFakeIdp();
    let discoveries = 0;
    const client = new OidcLoginClient(SETTINGS, {
      fetch: async (input, init) => {
        if (new URL(String(input)).pathname.endsWith('/openid-configuration')) discoveries++;
        return idp.fetch(input, init);
      },
    });
    await Promise.all([client.createAuthorizationRequest(), client.createAuthorizationRequest(), client.createAuthorizationRequest()]);
    expect(discoveries).toBe(1);
  });

  it('discovery 실패는 캐시하지 않고 진행 중 요청도 비운다(다음 요청이 다시 시도)', async () => {
    const idp = createFakeIdp();
    idp.behavior.discoveryStatus = 503;
    const client = new OidcLoginClient(SETTINGS, { fetch: idp.fetch });
    expect((await failureOf(client.createAuthorizationRequest())).step).toBe('discovery');
    idp.behavior.discoveryStatus = undefined;
    await client.createAuthorizationRequest();
  });
});

describe('놓친 경우 — 시간 클레임·알고리즘·키 교체', () => {
  const nowSec = () => Math.floor(Date.now() / 1000);

  it.each([
    ['iat 가 1시간 미래', () => ({ iat: nowSec() + 3600 })],
    ['iat 없음', () => ({ iat: undefined })],
    ['iat 문자열', () => ({ iat: String(nowSec()) })],
    ['exp 문자열', () => ({ exp: String(nowSec() + 300) })],
    ['exp 가 허용 오차(30초)를 넘겨 지남(-31초)', () => ({ exp: nowSec() - 31, iat: nowSec() - 600 })],
  ] as const)('%s → invalid', async (_n, claims) => {
    const idp = createFakeIdp();
    const client = new OidcLoginClient(SETTINGS, { fetch: idp.fetch });
    const run = await begin(idp, client);
    idp.behavior.claims = claims();
    expect((await failureOf(run())).kind).toBe('invalid');
  });

  it('exp 가 허용 오차 안에서 지남(-25초) → 통과(경계)', async () => {
    const idp = createFakeIdp();
    const client = new OidcLoginClient(SETTINGS, { fetch: idp.fetch });
    const run = await begin(idp, client);
    idp.behavior.claims = { exp: nowSec() - 25, iat: nowSec() - 600 };
    expect((await run()).sub).toBe('sub-123');
  });

  it.each(['none', 'HS256'] as const)('허용 밖 알고리즘 %s → invalid', async (alg) => {
    const idp = createFakeIdp();
    const client = new OidcLoginClient(SETTINGS, { fetch: idp.fetch });
    const run = await begin(idp, client);
    idp.behavior.idTokenAlg = alg;
    expect((await failureOf(run())).kind).toBe('invalid');
  });

  it('메타데이터가 none·HS256 을 알려도 ID token 은 비대칭 서명만 받는다', async () => {
    for (const alg of ['none', 'HS256'] as const) {
      const idp = createFakeIdp();
      idp.behavior.metadata = { id_token_signing_alg_values_supported: ['RS256', 'HS256', 'none'] };
      const client = new OidcLoginClient(SETTINGS, { fetch: idp.fetch });
      const run = await begin(idp, client);
      idp.behavior.idTokenAlg = alg;
      expect((await failureOf(run())).kind).toBe('invalid');
    }
  });

  it('JWKS 키 교체(kid 를 모름): 캐시가 60초 미만이면 다시 받지 않아 invalid, 60초 지나면 다시 받아 통과(라이브러리의 재요청 제한)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let t = Date.now();
    vi.setSystemTime(t);
    const idp = createFakeIdp();
    let jwksCalls = 0;
    const client = new OidcLoginClient(SETTINGS, {
      fetch: async (input, init) => {
        if (new URL(String(input)).pathname === '/jwks') jwksCalls++;
        return idp.fetch(input, init);
      },
    });
    expect((await (await begin(idp, client))()).sub).toBe('sub-123');
    expect(jwksCalls).toBe(1);
    idp.rotateKey();
    t += 10_000;
    vi.setSystemTime(t);
    expect((await failureOf((await begin(idp, client))())).kind).toBe('invalid');
    expect(jwksCalls).toBe(1);
    t += 61_000;
    vi.setSystemTime(t);
    expect((await (await begin(idp, client))()).sub).toBe('sub-123');
    expect(jwksCalls).toBe(2);
  });
});
