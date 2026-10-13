/**
 * T21-P1b(T21_DEPLOY_REVIEW G1): OIDC 로그인 — route(start·callback) → DB(auth_oidc_states·세션·감사) → openid-client → 프로세스 안 가짜 IdP.
 * **실제 네트워크 0**: globalThis.fetch 를 가짜 IdP(tests/helpers/fake-oidc-idp.ts)로 바꾸고(vi.stubGlobal), 그 밖의 IdP 도메인·.test 는
 * setupFiles 가드가 막는다. 클라이언트 시크릿·마스터 키·토큰은 모두 가짜. 이 파일만의 getDb 싱글턴(memory://).
 */
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { closeDb, consumeOidcLoginState, countRecentLoginFailures, createOidcLoginState, getDb, schema, seed, type Db } from '@cs/db';
import { LOGIN_FAILURE_REASONS, LOGIN_FAILURE_WINDOW_MS, LOGIN_MAX_FAILURES, loadConfig, requireSecretKeyring } from '@cs/domain';
import * as startRoute from '../../apps/web/app/api/auth/oidc/start/route';
import * as callbackRoute from '../../apps/web/app/api/auth/oidc/callback/route';
import * as loginRoute from '../../apps/web/app/api/auth/login/route';
import { GET as detailsGET } from '../../apps/web/app/api/health/details/route';
import { resetOidcLoginClientForTests } from '../../apps/web/lib/oidc';
import { createFakeIdp, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_ISSUER, type FakeIdp, type FakeUser } from '../helpers/fake-oidc-idp';
import { BASE, cookieHeader, jsonPost, sessionCookieValue } from './helpers';

const OWNER = 'owner@example.local';
const KEY = randomBytes(32).toString('base64');
const REDIRECT = `${BASE}/api/auth/oidc/callback`;
const OIDC_ENV: Record<string, string> = {
  AUTH_MODE: 'oidc',
  OIDC_ISSUER_URL: FAKE_ISSUER,
  OIDC_CLIENT_ID: FAKE_CLIENT_ID,
  OIDC_CLIENT_SECRET: FAKE_CLIENT_SECRET,
  OIDC_REDIRECT_URI: REDIRECT,
  AUTH_ALLOWED_IDENTITY: OWNER,
  SECRETS_MASTER_KEY: KEY,
  SECRETS_KEY_VERSION: '1',
};
const GOOD: FakeUser = { sub: 'owner-sub-1', email: OWNER, email_verified: true };

let db: Db;
let idp: FakeIdp;
const seen: string[] = [];
const logs: string[] = [];

beforeAll(async () => {
  db = (await getDb(loadConfig())).db;
  await seed(db, { allowedIdentity: OWNER });
});
afterAll(async () => {
  vi.useRealTimers();
  await closeDb();
});
beforeEach(async () => {
  for (const [k, v] of Object.entries(OIDC_ENV)) vi.stubEnv(k, v);
  idp = createFakeIdp();
  vi.stubGlobal('fetch', idp.fetch);
  resetOidcLoginClientForTests();
  // 시험끼리 전역 실패 횟수가 섞이지 않게 로그인 감사 기록을 비운다(이 파일 전용 DB)
  await db.delete(schema.auditEvents).where(inArray(schema.auditEvents.action, ['auth.login', 'auth.login_denied']));
  await db.delete(schema.authOidcStates);
  for (const level of ['warn', 'error', 'log', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** 모든 응답(헤더·본문)을 모은다 — 마지막에 비밀이 없는지 확인 */
async function rec(res: Response): Promise<Response> {
  seen.push(`${res.status}\n${[...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${await res.clone().text()}`);
  return res;
}

const flowCookieOf = (res: Response): string | null => {
  for (const c of res.headers.getSetCookie()) {
    const m = /^cs_oidc_flow=([^;]*)/.exec(c);
    if (m) return m[1]!;
  }
  return null;
};

async function start(headers: Record<string, string> = {}): Promise<Response> {
  return rec(await startRoute.GET(new Request(`${BASE}/api/auth/oidc/start`, { headers: { accept: 'application/json', 'sec-fetch-site': 'same-origin', ...headers } })));
}

/** 시작 → (가짜) IdP 로그인 → callback URL 과 결합 쿠키 */
async function begin(user: FakeUser = GOOD): Promise<{ callbackUrl: string; flow: string; authUrl: string }> {
  const res = await start();
  expect(res.status).toBe(303);
  const authUrl = res.headers.get('location')!;
  const flow = flowCookieOf(res)!;
  expect(flow).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return { callbackUrl: idp.authorize(authUrl, user), flow, authUrl };
}

async function callback(url: string, flow: string | null, accept = 'application/json'): Promise<Response> {
  const headers: Record<string, string> = { accept, 'user-agent': 'vitest' };
  if (flow !== null) headers.cookie = `cs_oidc_flow=${flow}`;
  return rec(await callbackRoute.GET(new Request(url, { headers })));
}

const sessionCount = async () => (await db.select().from(schema.sessions)).length;
const audits = async (action: string) => db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, action));
const failures = () => countRecentLoginFailures(db, { now: new Date(), windowMs: LOGIN_FAILURE_WINDOW_MS, reasons: LOGIN_FAILURE_REASONS });

async function expectDenied(res: Response, status: number, error: string, reason: string, check: string) {
  expect(res.status).toBe(status);
  expect((await res.json()).error).toBe(error);
  expect(res.headers.get('set-cookie') ?? '').not.toContain('cs_session=');
  // FIX-T21P1B(P2 :172): 이 브라우저의 흐름으로 확인되지 않은 요청(state 없음·모름·다른 브라우저·redirect 불일치)은 결합 쿠키를 보존한다
  const unbound = ['state_missing', 'state_unknown', 'state_browser_mismatch', 'redirect_mismatch'].includes(check);
  const cleared = res.headers.getSetCookie().includes('cs_oidc_flow=; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=0');
  expect(cleared).toBe(!unbound);
  const rows = await audits('auth.login_denied');
  expect(rows.at(-1)?.sanitizedDetails).toEqual({ reason, check, mode: 'oidc' });
  expect(rows.at(-1)?.ownerId).toBeNull();
}

describe('성공', () => {
  it('시작 303(IdP 인증 URL·결합 쿠키) → callback 200 세션, 감사 auth.login(mode oidc), 세션으로 owner API 사용', async () => {
    const res = await start();
    expect(res.status).toBe(303);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const auth = new URL(res.headers.get('location')!);
    expect(`${auth.origin}${auth.pathname}`).toBe(`${FAKE_ISSUER}/authorize`);
    expect(auth.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('scope')).toBe('openid email');
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('cs_oidc_flow='))!;
    expect(cookie).toMatch(/^cs_oidc_flow=[A-Za-z0-9_-]{43}; Path=\/api\/auth\/oidc; HttpOnly; SameSite=Lax; Max-Age=600$/);
    // DB 에는 해시·봉인만
    const [row] = await db.select().from(schema.authOidcStates);
    expect(row!.encryptedPayload.startsWith('csk1:')).toBe(true);
    const state = auth.searchParams.get('state')!;
    const rowText = JSON.stringify(row);
    for (const v of [state, auth.searchParams.get('nonce')!, flowCookieOf(res)!]) expect(rowText).not.toContain(v);

    const before = await sessionCount();
    const cb = await callback(idp.authorize(auth.href, GOOD), flowCookieOf(res));
    expect(cb.status).toBe(200);
    expect(cb.headers.get('referrer-policy')).toBe('no-referrer');
    const body = await cb.json();
    expect(body.ok).toBe(true);
    const token = sessionCookieValue(cb)!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(cb.headers.getSetCookie()).toContain('cs_oidc_flow=; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=0');
    expect(await sessionCount()).toBe(before + 1);
    const ok = await audits('auth.login');
    expect(ok.at(-1)?.sanitizedDetails).toEqual({ mode: 'oidc' });
    expect(idp.authMethods).toEqual(['basic']);
    // 세션으로 owner 경로 사용 + health details 의 auth 준비 상태(이름만)
    const details = await detailsGET(new Request(`${BASE}/api/health/details`, { headers: cookieHeader(token) }), undefined);
    expect(details.status).toBe(200);
    expect((await details.json()).auth).toEqual({ mode: 'oidc', oidc_ready: true, missing: [] });
    // 같은 callback 을 다시 보내면(재사용) state_used
    await expectDenied(await callback(idp.authorize(auth.href, GOOD).replace(/code=[^&]+/, 'code=x'), flowCookieOf(res)), 400, 'oidc_state_invalid', 'oidc_invalid', 'state_used');
  });

  it('브라우저(Accept: text/html): 성공은 303 /, 실패는 303 /login?error=<코드>', async () => {
    const a = await begin();
    const ok = await callback(a.callbackUrl, a.flow, 'text/html');
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/');
    expect(sessionCookieValue(ok)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const b = await begin({ ...GOOD, email: 'other@example.local' });
    const no = await callback(b.callbackUrl, b.flow, 'text/html');
    expect(no.status).toBe(303);
    expect(no.headers.get('location')).toBe('/login?error=oidc_identity_denied');
    // 시작 실패(준비 안 됨)도 화면으로
    vi.stubEnv('OIDC_CLIENT_SECRET', '');
    const s = await start({ accept: 'text/html' });
    expect(s.status).toBe(303);
    expect(s.headers.get('location')).toBe('/login?error=oidc_not_configured');
  });

  it('이메일 대소문자 무시, sub 고정(AUTH_ALLOWED_SUBJECT) 일치면 성공', async () => {
    const a = await begin({ ...GOOD, email: 'OWNER@Example.Local' });
    expect((await callback(a.callbackUrl, a.flow)).status).toBe(200);
    vi.stubEnv('AUTH_ALLOWED_SUBJECT', 'owner-sub-1');
    resetOidcLoginClientForTests();
    const b = await begin();
    expect((await callback(b.callbackUrl, b.flow)).status).toBe(200);
  });

  it('sub 만 고정(AUTH_ALLOWED_IDENTITY 미설정, scope openid): email 클레임 없이 성공 — owner 는 기본 식별자', async () => {
    vi.stubEnv('AUTH_ALLOWED_IDENTITY', '');
    vi.stubEnv('AUTH_ALLOWED_SUBJECT', 'owner-sub-1');
    vi.stubEnv('OIDC_SCOPES', 'openid');
    const a = await begin({ sub: 'owner-sub-1' });
    expect((await callback(a.callbackUrl, a.flow)).status).toBe(200);
    const b = await begin({ sub: 'someone-else' });
    await expectDenied(await callback(b.callbackUrl, b.flow), 403, 'oidc_identity_denied', 'oidc_identity_mismatch', 'subject');
  });
});

describe('허용 신원 불일치 → 403 + 감사 + 실패 횟수', () => {
  it.each([
    ['다른 이메일', { ...GOOD, email: 'other@example.local' }, 'email'],
    ['email_verified=false', { ...GOOD, email_verified: false }, 'email_unverified'],
    ['email_verified 없음', { sub: 'owner-sub-1', email: OWNER }, 'email_unverified'],
    ['email_verified="true"(문자열)', { ...GOOD, email_verified: 'true' }, 'email_unverified'],
    ['email 없음', { sub: 'owner-sub-1' }, 'email'],
  ] as const)('%s', async (_n, user, check) => {
    const sessions = await sessionCount();
    const a = await begin(user);
    await expectDenied(await callback(a.callbackUrl, a.flow), 403, 'oidc_identity_denied', 'oidc_identity_mismatch', check);
    expect(await sessionCount()).toBe(sessions);
    expect(await failures()).toBe(1);
  });

  it('sub 고정과 다른 sub → subject', async () => {
    vi.stubEnv('AUTH_ALLOWED_SUBJECT', 'owner-sub-1');
    const a = await begin({ ...GOOD, sub: 'attacker-sub' });
    await expectDenied(await callback(a.callbackUrl, a.flow), 403, 'oidc_identity_denied', 'oidc_identity_mismatch', 'subject');
    expect(await failures()).toBe(1);
  });
});

describe('state(1회용·10분·같은 브라우저)', () => {
  it('state 없음·형식 오류·모르는 state → 400 oidc_state_invalid, 실패로 센다', async () => {
    await expectDenied(await callback(`${REDIRECT}?code=abc`, 'x'), 400, 'oidc_state_invalid', 'oidc_invalid', 'state_missing');
    await expectDenied(await callback(`${REDIRECT}?code=abc&state=short`, 'x'), 400, 'oidc_state_invalid', 'oidc_invalid', 'state_missing');
    await expectDenied(await callback(`${REDIRECT}?code=abc&state=${'A'.repeat(43)}`, 'x'), 400, 'oidc_state_invalid', 'oidc_invalid', 'state_unknown');
    expect(await failures()).toBe(3);
  });

  it('다른 브라우저(결합 쿠키 없음·다름) → 거부하되 state 를 태우지 않는다(원래 브라우저는 계속 성공)', async () => {
    const a = await begin();
    await expectDenied(await callback(a.callbackUrl, null), 400, 'oidc_state_invalid', 'oidc_invalid', 'state_browser_mismatch');
    await expectDenied(await callback(a.callbackUrl, 'B'.repeat(43)), 400, 'oidc_state_invalid', 'oidc_invalid', 'state_browser_mismatch');
    expect((await callback(a.callbackUrl, a.flow)).status).toBe(200);
  });

  it('재사용 → state_used', async () => {
    const a = await begin();
    expect((await callback(a.callbackUrl, a.flow)).status).toBe(200);
    await expectDenied(await callback(a.callbackUrl, a.flow), 400, 'oidc_state_invalid', 'oidc_invalid', 'state_used');
  });

  it('10분 지남 → state_expired(사용 처리), IdP 에 code 를 보내지 않는다', async () => {
    const a = await begin();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1000);
    const tokenCalls = idp.calls.filter((c) => c.path === '/token').length;
    await expectDenied(await callback(a.callbackUrl, a.flow), 400, 'oidc_state_invalid', 'oidc_invalid', 'state_expired');
    expect(idp.calls.filter((c) => c.path === '/token').length).toBe(tokenCalls);
    vi.useRealTimers();
    await expectDenied(await callback(a.callbackUrl, a.flow), 400, 'oidc_state_invalid', 'oidc_invalid', 'state_used');
  });

  it('시작 뒤 설정(scope·client)이 바뀌면 → state_settings_changed', async () => {
    const a = await begin();
    vi.stubEnv('OIDC_SCOPES', 'openid email profile');
    await expectDenied(await callback(a.callbackUrl, a.flow), 400, 'oidc_state_invalid', 'oidc_invalid', 'state_settings_changed');
  });

  it('callback 주소가 OIDC_REDIRECT_URI 와 다르면(다른 origin) → redirect_mismatch, state 를 보지 않는다', async () => {
    const a = await begin();
    const other = a.callbackUrl.replace(BASE, 'http://127.0.0.1:3000');
    await expectDenied(await callback(other, a.flow), 400, 'oidc_state_invalid', 'oidc_invalid', 'redirect_mismatch');
    expect((await callback(a.callbackUrl, a.flow)).status).toBe(200);
  });
});

describe('ID token·code 교환 검증 실패(라이브러리) → 401 oidc_login_invalid, 실패로 센다', () => {
  it.each([
    ['nonce 불일치', { claims: { nonce: 'not-the-nonce' } }],
    ['iss 불일치', { claims: { iss: 'https://evil.test' } }],
    ['aud 불일치', { claims: { aud: 'other-client' } }],
    ['만료된 ID token', { claims: { exp: Math.floor(Date.now() / 1000) - 600, iat: Math.floor(Date.now() / 1000) - 900 } }],
    ['서명 불일치(다른 키)', { signWithOtherKey: true }],
    ['ID token 없음', { omitIdToken: true }],
    ['token endpoint 400', { tokenStatus: 400 }],
  ] as const)('%s', async (_n, behavior) => {
    const a = await begin();
    Object.assign(idp.behavior, behavior);
    const sessions = await sessionCount();
    await expectDenied(await callback(a.callbackUrl, a.flow), 401, 'oidc_login_invalid', 'oidc_invalid', 'token');
    expect(await sessionCount()).toBe(sessions);
    expect(await failures()).toBe(1);
  });

  it('code 를 바꿔치기(다른 code) → invalid', async () => {
    const a = await begin();
    await expectDenied(await callback(a.callbackUrl.replace(/code=[^&]+/, 'code=forged'), a.flow), 401, 'oidc_login_invalid', 'oidc_invalid', 'token');
  });
});

describe('IdP 장애·취소 → 고정 오류, 실패로 세지 않음', () => {
  it('token endpoint 500 → 502 oidc_provider_unavailable', async () => {
    const a = await begin();
    idp.behavior.tokenStatus = 500;
    await expectDenied(await callback(a.callbackUrl, a.flow), 502, 'oidc_provider_unavailable', 'oidc_provider_error', 'token');
    expect(await failures()).toBe(0);
  });

  it('token endpoint 시간 초과(전송 오류) → 502', async () => {
    const a = await begin();
    idp.behavior.tokenThrow = new DOMException('The operation timed out.', 'TimeoutError');
    await expectDenied(await callback(a.callbackUrl, a.flow), 502, 'oidc_provider_unavailable', 'oidc_provider_error', 'token');
    expect(await failures()).toBe(0);
  });

  it('IdP 에서 거부(error=access_denied) → 401 oidc_cancelled, state 는 사용 처리', async () => {
    const res = await start();
    const authUrl = res.headers.get('location')!;
    const denied = idp.deny(authUrl);
    await expectDenied(await callback(denied, flowCookieOf(res)), 401, 'oidc_cancelled', 'oidc_cancelled', 'provider_error_param');
    expect(await failures()).toBe(0);
    expect(idp.calls.filter((c) => c.path === '/token')).toHaveLength(0);
  });

  it('discovery 실패 → 시작 502, 로그인 요청 행 없음', async () => {
    idp.behavior.discoveryStatus = 503;
    const res = await start();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('oidc_provider_unavailable');
    expect(await db.select().from(schema.authOidcStates)).toHaveLength(0);
    expect(flowCookieOf(res)).toBeNull();
  });
});

describe('전역 로그인 시도 제한(T21-P1a 와 같은 판정 경로)', () => {
  it('실패 10회 → 맞는 callback 도 429(state 를 소비하지 않음·감사 없음), 시작도 429, dev 식별자 실패와 같은 창', async () => {
    const good = await begin(); // 제한 전에 시작해 둔 정상 흐름
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      const res = await callback(`${REDIRECT}?code=x&state=${randomBytes(32).toString('base64url')}`, 'x');
      expect(res.status).toBe(400);
    }
    expect(await failures()).toBe(LOGIN_MAX_FAILURES);
    const denied = (await audits('auth.login_denied')).length;
    const sessions = await sessionCount();
    const res = await callback(good.callbackUrl, good.flow);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe('login_rate_limited');
    expect(await sessionCount()).toBe(sessions);
    expect((await audits('auth.login_denied')).length).toBe(denied);
    const rows = await db.select().from(schema.authOidcStates);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.usedAt).toBeNull();
    expect(idp.calls.filter((c) => c.path === '/token')).toHaveLength(0);
    // 시작도 막힌다(IdP 로 보내지 않음), 브라우저는 /login?error=rate_limited
    const s = await start();
    expect(s.status).toBe(429);
    const sh = await start({ accept: 'text/html' });
    expect(sh.headers.get('location')).toBe('/login?error=rate_limited');
    const ch = await callback(good.callbackUrl, good.flow, 'text/html');
    expect(ch.headers.get('location')).toBe('/login?error=rate_limited');
  });

  it('OIDC 실패와 식별자(dev) 실패는 같은 창에서 합산된다', async () => {
    const a = await begin({ ...GOOD, email: 'x@example.local' });
    await callback(a.callbackUrl, a.flow);
    // dev 모드로 바꿔 틀린 식별자 1회
    vi.stubEnv('AUTH_MODE', 'dev');
    expect((await loginRoute.POST(jsonPost('/api/auth/login', { identity: 'nobody@example.local' }))).status).toBe(401);
    expect(await failures()).toBe(2);
  });
});

describe('설정·모드', () => {
  it('준비 안 됨(시크릿 없음) → 시작·callback 503 oidc_not_configured, 응답에 설정 이름 없음, 서버 로그에는 이름만', async () => {
    vi.stubEnv('OIDC_CLIENT_SECRET', '');
    logs.length = 0;
    const res = await start();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text).error).toBe('oidc_not_configured');
    expect(text).not.toContain('OIDC_CLIENT_SECRET');
    expect(logs.join('\n')).toContain('[auth] oidc_not_configured: OIDC_CLIENT_SECRET');
    const cb = await callback(`${REDIRECT}?code=x&state=${'A'.repeat(43)}`, 'x');
    expect(cb.status).toBe(503);
    expect(idp.calls).toHaveLength(0);
  });

  it('다른 사이트에서 연 시작(Sec-Fetch-Site: cross-site) → 403 csrf, IdP 호출 없음', async () => {
    const res = await start({ 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('csrf');
    expect(idp.calls).toHaveLength(0);
  });

  it('AUTH_MODE=oidc 이면 식별자 입력 로그인(POST /api/auth/login)은 403 identity_login_disabled — 실패로 세지 않음', async () => {
    const res = await loginRoute.POST(jsonPost('/api/auth/login', { identity: OWNER }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('identity_login_disabled');
    expect(await failures()).toBe(0);
  });

  it('NODE_ENV=production: oidc 로그인은 동작하고(Secure 쿠키는 https 기준 — 여기선 localhost http), dev 는 계속 거부', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const a = await begin();
    const ok = await callback(a.callbackUrl, a.flow);
    expect(ok.status).toBe(200);
    vi.stubEnv('AUTH_MODE', 'dev');
    const dev = await loginRoute.POST(jsonPost('/api/auth/login', { identity: OWNER }));
    expect(dev.status).toBe(503);
    expect((await dev.json()).error).toBe('dev_login_refused_in_production');
  });
});

describe('로그인 요청 표(직접)', () => {
  it('진행 중 요청 상한: 넘으면 가장 오래된 것부터 지운다', async () => {
    const keyring = requireSecretKeyring({ SECRETS_MASTER_KEY: KEY, SECRETS_KEY_VERSION: '1' });
    const states: string[] = [];
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      const state = randomBytes(32).toString('base64url');
      states.push(state);
      await createOidcLoginState(db, { state, browserToken: 'b', secrets: { codeVerifier: 'v', nonce: 'n' }, settingsHash: 'h', keyring, now: new Date(t0 + i), maxPending: 3 });
    }
    expect(await db.select().from(schema.authOidcStates)).toHaveLength(3);
    expect((await consumeOidcLoginState(db, { state: states[0]!, browserToken: 'b', settingsHash: 'h', keyring, now: new Date(t0 + 10) })).status).toBe('unknown');
    const ok = await consumeOidcLoginState(db, { state: states[4]!, browserToken: 'b', settingsHash: 'h', keyring, now: new Date(t0 + 10) });
    expect(ok).toMatchObject({ status: 'ok', secrets: { codeVerifier: 'v', nonce: 'n' } });
    // 다른 키(키 교체 후 이전 키 없음) → unreadable(사용 처리됨)
    const other = requireSecretKeyring({ SECRETS_MASTER_KEY: randomBytes(32).toString('base64'), SECRETS_KEY_VERSION: '1' });
    expect((await consumeOidcLoginState(db, { state: states[3]!, browserToken: 'b', settingsHash: 'h', keyring: other, now: new Date(t0 + 10) })).status).toBe('unreadable');
    expect((await consumeOidcLoginState(db, { state: states[3]!, browserToken: 'b', settingsHash: 'h', keyring, now: new Date(t0 + 10) })).status).toBe('used');
  });
});

describe('비밀 위생', () => {
  it('응답·감사·로그 어디에도 시크릿·마스터 키·code·state·토큰·이메일 값이 없다', async () => {
    const a = await begin();
    const cb = new URL(a.callbackUrl);
    expect((await callback(a.callbackUrl, a.flow)).status).toBe(200);
    const b = await begin({ ...GOOD, email: 'leak-check@example.local' });
    await callback(b.callbackUrl, b.flow);
    const auditText = JSON.stringify(await db.select().from(schema.auditEvents));
    // 시작 응답의 Location(IdP 인증 URL)에는 state·nonce 가 들어가는 것이 정상이므로 그 응답은 뺀다
    const responses = seen.filter((r) => !r.includes(`location: ${FAKE_ISSUER}/authorize`));
    expect(responses.length).toBeGreaterThan(10);
    const all = `${responses.join('\n')}\n${auditText}\n${logs.join('\n')}`;
    for (const s of [FAKE_CLIENT_SECRET, KEY, cb.searchParams.get('code')!, cb.searchParams.get('state')!, 'leak-check@example.local', 'eyJ', 'FAKE_access_']) {
      expect(all).not.toContain(s);
    }
  });
});
