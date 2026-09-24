/**
 * T02 인증: dev 로그인(D3)·세션 쿠키·해시 저장·만료·폐기·로그아웃·CSRF·AUTH_MODE 가드.
 * route handler 를 직접 호출한다. DB 는 getDb 싱글턴(memory://).
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, createSession, getDb, schema, seed, type Db } from '@cs/db';
import { generateSessionToken, hashSessionToken, loadConfig } from '@cs/domain';
import * as loginRoute from '../../apps/web/app/api/auth/login/route';
import * as logoutRoute from '../../apps/web/app/api/auth/logout/route';
import { GET as assetGET } from '../../apps/web/app/api/assets/[id]/route';
import { assetGet, BASE, cookieHeader, jsonPost, login, sessionCookieValue } from './helpers';

const OWNER = 'owner@example.local';
let db: Db;
let ownerId: string;

beforeAll(async () => {
  db = (await getDb(loadConfig())).db;
  ownerId = (await seed(db, { allowedIdentity: OWNER })).ownerId;
});
afterAll(async () => {
  await closeDb();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const sessionCount = async () => (await db.select().from(schema.sessions)).length;
/** 보호된 route 로 세션 확인: 인증되면 (없는 asset 이라) 404, 아니면 401 */
const probe = (token: string) => assetGET(...assetGet(randomUUID(), token));

describe('POST /api/auth/login (AUTH_MODE=dev)', () => {
  it('틀린 식별자 → 401, 일반 문구, 세션 행 없음, 감사 기록에 식별자 없음', async () => {
    const before = await sessionCount();
    const res = await loginRoute.POST(jsonPost('/api/auth/login', { identity: 'intruder@example.local' }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'login_denied', message: '로그인할 수 없습니다. 입력한 정보를 확인하세요.' });
    expect(JSON.stringify(body)).not.toContain(OWNER);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await sessionCount()).toBe(before);

    const denied = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'auth.login_denied'));
    expect(denied.length).toBeGreaterThanOrEqual(1);
    const last = denied.at(-1)!;
    expect(last.ownerId).toBeNull();
    expect(last.sanitizedDetails).toEqual({ reason: 'identity_mismatch' });
    expect(JSON.stringify(denied)).not.toContain('intruder');
    expect(JSON.stringify(denied)).not.toContain(OWNER);
  });

  it('빈 식별자·잘못된 본문 → 400', async () => {
    expect((await loginRoute.POST(jsonPost('/api/auth/login', { identity: '' }))).status).toBe(400);
    expect((await loginRoute.POST(jsonPost('/api/auth/login', { nope: 1 }))).status).toBe(400);
    const res = await loginRoute.POST(
      new Request(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { origin: BASE, 'content-type': 'application/json' },
        body: '{not json',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('맞는 식별자 → 200 + HttpOnly·SameSite=Lax 쿠키, DB 에는 sha256 해시만', async () => {
    const res = await loginRoute.POST(jsonPost('/api/auth/login', { identity: OWNER }, { 'user-agent': 'vitest' }));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^cs_session=[A-Za-z0-9_-]{43}; /);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=43200');
    expect(setCookie).not.toContain('Secure'); // auto + http://localhost
    const body = await res.json();
    expect(body.ok).toBe(true);

    const token = sessionCookieValue(res)!;
    const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.tokenHash, hashSessionToken(token)));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(row.ownerId).toBe(ownerId);
    expect(row.revokedAt).toBeNull();
    expect(row.userAgentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(720 * 60 * 1000);
    expect(body.expires_at).toBe(row.expiresAt.toISOString());
    // 원문 토큰은 DB 어디에도 없다
    const dump = JSON.stringify(await db.select().from(schema.sessions));
    expect(dump).not.toContain(token);

    const audit = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'auth.login'));
    expect(audit.at(-1)).toMatchObject({ ownerId, entity: 'session', entityId: row.id, sanitizedDetails: { mode: 'dev' } });

    expect((await probe(token)).status).toBe(404); // 인증 통과(없는 asset)
  });

  it('브라우저 폼: 성공 303 → /, 실패 303 → /login?error=denied', async () => {
    const form = (identity: string) =>
      new Request(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { origin: BASE, accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ identity }).toString(),
      });
    const ok = await loginRoute.POST(form(OWNER));
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/');
    expect(sessionCookieValue(ok)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const bad = await loginRoute.POST(form('nobody@example.local'));
    expect(bad.status).toBe(303);
    expect(bad.headers.get('location')).toBe('/login?error=denied');
    expect(bad.headers.get('set-cookie')).toBeNull();
  });

  it('TTL 설정을 쿠키 Max-Age·expires_at 에 반영, AUTH_COOKIE_SECURE=true 면 Secure', async () => {
    vi.stubEnv('AUTH_SESSION_TTL_MINUTES', '30');
    vi.stubEnv('AUTH_COOKIE_SECURE', 'true');
    const res = await loginRoute.POST(jsonPost('/api/auth/login', { identity: OWNER }));
    expect(res.headers.get('set-cookie')).toContain('Max-Age=1800');
    expect(res.headers.get('set-cookie')).toContain('Secure');
  });
});

describe('AUTH_MODE 가드', () => {
  it('AUTH_MODE=oidc → 503 + 한국어 안내(T13), 세션 없음', async () => {
    vi.stubEnv('AUTH_MODE', 'oidc');
    const before = await sessionCount();
    const res = await loginRoute.POST(jsonPost('/api/auth/login', { identity: OWNER }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'oidc_not_configured',
      message: '운영 인증 공급자는 아직 설정되지 않았습니다(T13)',
    });
    expect(await sessionCount()).toBe(before);
  });

  it('dev + APP_BASE_URL=https://example.com → 403 거부(맞는 식별자라도)', async () => {
    vi.stubEnv('APP_BASE_URL', 'https://example.com');
    const before = await sessionCount();
    const res = await loginRoute.POST(
      new Request('https://example.com/api/auth/login', {
        method: 'POST',
        headers: { origin: 'https://example.com', 'content-type': 'application/json' },
        body: JSON.stringify({ identity: OWNER }),
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('dev_login_not_allowed');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await sessionCount()).toBe(before);
  });
});

describe('세션 만료·폐기', () => {
  const insertSession = async (over: { expiresAt: Date; revokedAt?: Date | null; lastSeenAt?: Date }) => {
    const token = generateSessionToken();
    const now = new Date();
    const row = await createSession(db, {
      ownerId,
      tokenHash: hashSessionToken(token),
      expiresAt: over.expiresAt,
      userAgentHash: null,
      now: over.lastSeenAt ?? now,
    });
    if (over.revokedAt) {
      await db.update(schema.sessions).set({ revokedAt: over.revokedAt }).where(eq(schema.sessions.id, row.id));
    }
    return { token, id: row.id };
  };

  it('expires_at 이 지난 세션 → 401 + 쿠키 삭제', async () => {
    const { token } = await insertSession({ expiresAt: new Date(Date.now() - 1000) });
    const res = await probe(token);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized', message: '로그인이 필요합니다' });
    expect(res.headers.get('set-cookie')).toMatch(/^cs_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0/);
  });

  it('revoked 세션 → 401', async () => {
    const { token } = await insertSession({ expiresAt: new Date(Date.now() + 3600_000), revokedAt: new Date() });
    expect((await probe(token)).status).toBe(401);
  });

  it('쿠키 없음·위조 토큰 → 401 (쿠키 없으면 Set-Cookie 도 없음)', async () => {
    const [req, ctx] = assetGet(randomUUID());
    const res = await assetGET(req, ctx);
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await probe(generateSessionToken())).status).toBe(401);
    expect((await probe('../../etc/passwd')).status).toBe(401);
  });

  it('AUTH_ALLOWED_IDENTITY 가 바뀌면 기존 세션도 무효', async () => {
    const token = await login(OWNER);
    expect((await probe(token)).status).toBe(404);
    vi.stubEnv('AUTH_ALLOWED_IDENTITY', 'someone-else@example.local');
    expect((await probe(token)).status).toBe(401);
  });

  it('last_seen_at 은 5분 이상 지났을 때만 갱신', async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    const s = await insertSession({ expiresAt: new Date(Date.now() + 3600_000), lastSeenAt: old });
    await probe(s.token);
    const [after] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, s.id));
    expect(after!.lastSeenAt.getTime()).toBeGreaterThan(old.getTime());
    const firstTouch = after!.lastSeenAt.getTime();
    await probe(s.token);
    const [again] = await db.select().from(schema.sessions).where(eq(schema.sessions.id, s.id));
    expect(again!.lastSeenAt.getTime()).toBe(firstTouch);
  });
});

describe('POST /api/auth/logout', () => {
  it('세션 폐기 + 쿠키 삭제, 같은 쿠키로 다시 → 401', async () => {
    const token = await login(OWNER);
    const res = await logoutRoute.POST(jsonPost('/api/auth/logout', {}, cookieHeader(token)));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    const [row] = await db.select().from(schema.sessions).where(eq(schema.sessions.tokenHash, hashSessionToken(token)));
    expect(row!.revokedAt).toBeInstanceOf(Date);
    const audit = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'auth.logout'));
    expect(audit.at(-1)).toMatchObject({ ownerId, entityId: row!.id });

    const again = await logoutRoute.POST(jsonPost('/api/auth/logout', {}, cookieHeader(token)));
    expect(again.status).toBe(401);
    expect((await probe(token)).status).toBe(401);
  });

  it('브라우저 폼 로그아웃 → 303 /login', async () => {
    const token = await login(OWNER);
    const res = await logoutRoute.POST(
      new Request(`${BASE}/api/auth/logout`, {
        method: 'POST',
        headers: { origin: BASE, accept: 'text/html', ...cookieHeader(token) },
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/login');
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('GET 핸들러가 없다 → Next 가 405 로 응답(상태 변경 없음). login 도 POST 만', () => {
    expect(Object.keys(logoutRoute)).not.toContain('GET');
    expect(Object.keys(loginRoute)).not.toContain('GET');
    expect(typeof logoutRoute.POST).toBe('function');
  });
});

describe('CSRF (상태 변경 POST)', () => {
  it('Origin 없음 → 403 csrf (로그인·로그아웃)', async () => {
    const noOrigin = new Request(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identity: OWNER }),
    });
    const res = await loginRoute.POST(noOrigin);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('csrf');

    const token = await login(OWNER);
    const out = await logoutRoute.POST(
      new Request(`${BASE}/api/auth/logout`, { method: 'POST', headers: cookieHeader(token) }),
    );
    expect(out.status).toBe(403);
    expect((await probe(token)).status).toBe(404); // 세션은 그대로
  });

  it('다른 Origin → 403, Sec-Fetch-Site: cross-site → 403, 같은 출처 Referer 만 있으면 허용', async () => {
    const before = await sessionCount();
    expect((await loginRoute.POST(jsonPost('/api/auth/login', { identity: OWNER }, { origin: 'http://evil.example' }))).status).toBe(403);
    expect(
      (await loginRoute.POST(jsonPost('/api/auth/login', { identity: OWNER }, { 'sec-fetch-site': 'cross-site' }))).status,
    ).toBe(403);
    expect(await sessionCount()).toBe(before);
    const viaReferer = new Request(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', referer: `${BASE}/login` },
      body: JSON.stringify({ identity: OWNER }),
    });
    expect((await loginRoute.POST(viaReferer)).status).toBe(200);
  });
});
