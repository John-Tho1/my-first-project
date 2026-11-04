/**
 * FIX2-FULLREV2(G16, D40-3): 세션 인증 정책 지문 — 세션을 만들 때 AUTH_MODE·OIDC issuer·허용 sub·허용 email·owner 키의 지문을 저장하고,
 * 요청마다 현재 정책의 지문과 다르면 그 세션을 거부한다(401 + 쿠키 삭제, 다른 무효 세션과 같음). 지문이 없는 옛 세션(migration 0048 전)도 거부.
 * 실제 진입점: POST /api/auth/login(dev)·GET /api/auth/oidc/callback(가짜 IdP — 실제 네트워크 0) → 보호된 route(GET /api/assets/:id).
 * 이 파일만의 getDb 싱글턴(memory://). migration 시험은 별도 PGlite(memory://)에 태그별 SQL 을 직접 적용한다.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { closeDb, createDb, getDb, migrationsFolder, schema, seed, type Db } from '@cs/db';
import { generateSessionToken, hashSessionToken, loadConfig, sessionPolicyFingerprint } from '@cs/domain';
import * as startRoute from '../../apps/web/app/api/auth/oidc/start/route';
import * as callbackRoute from '../../apps/web/app/api/auth/oidc/callback/route';
import { GET as assetGET } from '../../apps/web/app/api/assets/[id]/route';
import { resetOidcLoginClientForTests } from '../../apps/web/lib/oidc';
import { validateSessionToken } from '../../apps/web/lib/session';
import { createFakeIdp, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_ISSUER, type FakeIdp, type FakeUser } from '../helpers/fake-oidc-idp';
import { assetGet, BASE, login, sessionCookieValue } from './helpers';

const OWNER = 'owner@example.local';
const KEY = randomBytes(32).toString('base64');
const OIDC_ENV: Record<string, string> = {
  AUTH_MODE: 'oidc',
  OIDC_ISSUER_URL: FAKE_ISSUER,
  OIDC_CLIENT_ID: FAKE_CLIENT_ID,
  OIDC_CLIENT_SECRET: FAKE_CLIENT_SECRET,
  OIDC_REDIRECT_URI: `${BASE}/api/auth/oidc/callback`,
  AUTH_ALLOWED_IDENTITY: OWNER,
  SECRETS_MASTER_KEY: KEY,
  SECRETS_KEY_VERSION: '1',
};
const SUB_A: FakeUser = { sub: 'owner-sub-A', email: OWNER, email_verified: true };

let db: Db;
let ownerId: string;
let idp: FakeIdp;

beforeAll(async () => {
  db = (await getDb(loadConfig())).db;
  ownerId = (await seed(db, { allowedIdentity: OWNER })).ownerId;
});
afterAll(async () => {
  await closeDb();
});
beforeEach(async () => {
  idp = createFakeIdp();
  vi.stubGlobal('fetch', idp.fetch);
  resetOidcLoginClientForTests();
  // 시험끼리 전역 실패 횟수가 섞이지 않게(이 파일 전용 DB)
  await db.delete(schema.auditEvents).where(inArray(schema.auditEvents.action, ['auth.login', 'auth.login_denied']));
  await db.delete(schema.authOidcStates);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 보호된 route 로 세션 확인: 인증되면 (없는 asset 이라) 404, 아니면 401 */
const probe = (token: string) => assetGET(...assetGet(randomUUID(), token));

async function expectRejected(token: string) {
  const res = await probe(token);
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: 'unauthorized', message: '로그인이 필요합니다' });
  // 다른 무효 세션(만료·폐기)과 같게 쿠키를 지운다
  expect(res.headers.get('set-cookie')).toMatch(/^cs_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0/);
}

const useOidc = (over: Record<string, string> = {}) => {
  for (const [k, v] of Object.entries({ ...OIDC_ENV, ...over })) vi.stubEnv(k, v);
};

/** OIDC 로그인(시작 → 가짜 IdP → callback) — 세션 토큰 */
async function oidcLogin(user: FakeUser = SUB_A): Promise<string> {
  const s = await startRoute.GET(new Request(`${BASE}/api/auth/oidc/start`, { headers: { accept: 'application/json', 'sec-fetch-site': 'same-origin' } }));
  expect(s.status).toBe(303);
  const flow = /^cs_oidc_flow=([^;]*)/.exec(s.headers.getSetCookie().find((c) => c.startsWith('cs_oidc_flow='))!)![1]!;
  const cb = await callbackRoute.GET(
    new Request(idp.authorize(s.headers.get('location')!, user), { headers: { accept: 'application/json', cookie: `cs_oidc_flow=${flow}` } }),
  );
  expect(cb.status, await cb.clone().text()).toBe(200);
  return sessionCookieValue(cb)!;
}

const storedFingerprint = async (token: string) =>
  (await db.select({ f: schema.sessions.policyFingerprint }).from(schema.sessions).where(eq(schema.sessions.tokenHash, hashSessionToken(token))))[0]?.f;

describe('OIDC 세션 — 정책이 바뀌면 기존 세션 401', () => {
  it('sub A 로 로그인(AUTH_ALLOWED_SUBJECT=A) → AUTH_ALLOWED_SUBJECT=B 로 바꾸면 401 + 쿠키 삭제', async () => {
    useOidc({ AUTH_ALLOWED_SUBJECT: 'owner-sub-A' });
    const token = await oidcLogin();
    expect((await probe(token)).status).toBe(404);
    // 세션 행에 지문이 저장된다(값은 지금 정책의 지문 — 원문 sub·email 은 행에 없다)
    const f = await storedFingerprint(token);
    expect(f).toMatch(/^[0-9a-f]{64}$/);
    expect(f).toBe(sessionPolicyFingerprint(loadConfig(), process.env));
    const row = JSON.stringify((await db.select().from(schema.sessions).where(eq(schema.sessions.tokenHash, hashSessionToken(token))))[0]);
    expect(row).not.toContain('owner-sub-A');

    vi.stubEnv('AUTH_ALLOWED_SUBJECT', 'owner-sub-B');
    await expectRejected(token);
  });

  it('sub 고정을 처음 추가해도(이메일만 허용 → AUTH_ALLOWED_SUBJECT 설정) 기존 세션 401 — 이메일 재할당 대응', async () => {
    useOidc();
    const token = await oidcLogin();
    expect((await probe(token)).status).toBe(404);
    vi.stubEnv('AUTH_ALLOWED_SUBJECT', 'owner-sub-A');
    await expectRejected(token);
  });

  it('issuer 가 바뀌면 401', async () => {
    useOidc();
    const token = await oidcLogin();
    expect((await probe(token)).status).toBe(404);
    vi.stubEnv('OIDC_ISSUER_URL', 'https://other-idp.test');
    await expectRejected(token);
  });

  it('허용 email 명시를 빼면(sub 만 허용, owner 키는 같은 기본값) 401 — 같은 owner 라도 정책이 다르다', async () => {
    useOidc({ AUTH_ALLOWED_SUBJECT: 'owner-sub-A' });
    const token = await oidcLogin();
    expect((await probe(token)).status).toBe(404);
    vi.stubEnv('AUTH_ALLOWED_IDENTITY', ''); // 기본값 owner@example.local = OWNER — owner 대조(identityMatches)는 통과하는 상태
    await expectRejected(token);
  });

  it('AUTH_MODE 가 바뀌면(oidc → dev) 401', async () => {
    useOidc();
    const token = await oidcLogin();
    expect((await probe(token)).status).toBe(404);
    vi.stubEnv('AUTH_MODE', 'dev');
    await expectRejected(token);
  });

  it('정책이 그대로면 계속 통과 — 정책과 무관한 설정(scope·client) 변경도 통과', async () => {
    useOidc({ AUTH_ALLOWED_SUBJECT: 'owner-sub-A' });
    const token = await oidcLogin();
    expect((await probe(token)).status).toBe(404);
    expect((await probe(token)).status).toBe(404);
    vi.stubEnv('OIDC_SCOPES', 'openid email profile');
    vi.stubEnv('OIDC_CLIENT_ID', 'another-client');
    expect((await probe(token)).status).toBe(404);
  });

  // Codex 검증(2026-11-03) F1 / FIX4-FULLREV2: issuer 는 정확한 문자열로 비교한다 — 끝의 '/' 만 달라도 다른 issuer(OIDC Discovery §4.3).
  it('issuer 끝의 / 만 바뀌어도 401(이전 issuer 의 세션 거부)', async () => {
    useOidc({ AUTH_ALLOWED_SUBJECT: 'owner-sub-A' });
    const token = await oidcLogin();
    expect((await probe(token)).status).toBe(404);
    vi.stubEnv('OIDC_ISSUER_URL', `${FAKE_ISSUER}/`);
    await expectRejected(token);
  });
});

describe('dev 세션', () => {
  it('dev 로그인 세션: 정책이 그대로면 통과, OIDC 설정(issuer·sub)을 바꿔도 dev 에는 영향 없음', async () => {
    const token = await login(OWNER);
    expect(await storedFingerprint(token)).toBe(sessionPolicyFingerprint(loadConfig(), process.env));
    expect((await probe(token)).status).toBe(404);
    vi.stubEnv('AUTH_ALLOWED_SUBJECT', 'someone');
    vi.stubEnv('OIDC_ISSUER_URL', 'https://other-idp.test');
    expect((await probe(token)).status).toBe(404);
  });

  it('dev 로그인 세션 → AUTH_MODE=oidc 로 바꾸면 401 + 쿠키 삭제', async () => {
    const token = await login(OWNER);
    expect((await probe(token)).status).toBe(404);
    useOidc();
    await expectRejected(token);
  });
});

describe('지문 없는 옛 세션(migration 0048 전)', () => {
  it('policy_fingerprint 가 null 인 유효 세션(만료·폐기 아님, owner 일치) → 401 + 쿠키 삭제', async () => {
    const token = generateSessionToken();
    const now = new Date();
    await db.insert(schema.sessions).values({ ownerId, tokenHash: hashSessionToken(token), createdAt: now, lastSeenAt: now, expiresAt: new Date(now.getTime() + 3_600_000) });
    expect(await storedFingerprint(token)).toBeNull();
    await expectRejected(token);
    // 같은 세션에 지금 정책의 지문을 넣으면 통과한다(거부 이유가 지문뿐임을 확인)
    await db.update(schema.sessions).set({ policyFingerprint: sessionPolicyFingerprint(loadConfig(), process.env) }).where(eq(schema.sessions.tokenHash, hashSessionToken(token)));
    expect((await probe(token)).status).toBe(404);
  });

  it('0047 까지의 DB 에 있던 세션은 0048 적용 뒤 policy_fingerprint=null 로 남고 validateSessionToken 이 거부한다(1회 재로그인)', async () => {
    const journal = JSON.parse(readFileSync(path.join(migrationsFolder(), 'meta/_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> };
    const tags = journal.entries.map((e) => e.tag);
    const tag48 = tags.find((t) => t.startsWith('0048'))!;
    expect(tag48).toBe('0048_fullrev2_fix2_session_policy_audit_idx');
    const apply = async (client: ReturnType<typeof createDb>['client'], tag: string) => {
      const stmts = readFileSync(path.join(migrationsFolder(), `${tag}.sql`), 'utf8').split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);
      await client.transaction(async (tx) => {
        for (const s of stmts) await tx.exec(s);
      });
    };
    const h = createDb({ driver: 'pglite', url: 'memory://' });
    try {
      for (const t of tags.filter((t) => t < '0048')) await apply(h.client, t);
      const token = generateSessionToken();
      const uid = randomUUID();
      await h.client.query(`insert into users (id, allowed_identity) values ($1, $2)`, [uid, OWNER]);
      await h.client.query(`insert into sessions (owner_id, token_hash, expires_at) values ($1, $2, now() + interval '1 hour')`, [uid, hashSessionToken(token)]);
      await apply(h.client, tag48);
      const rows = (await h.client.query<{ policy_fingerprint: string | null }>(`select policy_fingerprint from sessions`)).rows;
      expect(rows).toEqual([{ policy_fingerprint: null }]);
      const cfg = loadConfig();
      expect(await validateSessionToken(h.db, token, cfg)).toBeNull();
      // 지문만 채우면 같은 세션이 통과한다(나머지 조건은 유효)
      await h.client.query(`update sessions set policy_fingerprint = $1`, [sessionPolicyFingerprint(cfg, process.env)]);
      expect(await validateSessionToken(h.db, token, cfg)).toMatchObject({ ownerId: uid, identity: OWNER });
    } finally {
      await h.close();
    }
  });
});
