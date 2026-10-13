/**
 * FIX-T21P1B(Codex review-T21P1B) 통합 회귀 — 가짜 IdP 만(실제 네트워크 0), 이 파일만의 memory:// DB.
 * P2 callback/route.ts:172 — 결합 쿠키는 state 와 브라우저 결합이 확인된 흐름을 끝낼 때만 지운다(두 탭·관계없는 callback·조기 429 는 보존).
 * P2 auth-oidc.ts:54 — 로그인 요청 생성(정리·개수·삭제·삽입)을 전용 advisory 잠금으로 직렬화.
 *   PGlite 는 연결 하나에서 트랜잭션을 하나씩만 돌려 경합 자체는 재현되지 않는다 — 잠금을 실제로 거는지(실행 SQL)와 동시 생성 결과만 확인. Postgres 다중 연결은 미검증(G2).
 */
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { closeDb, createOidcLoginState, getDb, OIDC_STATE_LOCK_KEY, schema, seed, type Db } from '@cs/db';
import { LOGIN_MAX_FAILURES, loadConfig, requireSecretKeyring } from '@cs/domain';
import * as startRoute from '../../apps/web/app/api/auth/oidc/start/route';
import * as callbackRoute from '../../apps/web/app/api/auth/oidc/callback/route';
import { resetOidcLoginClientForTests } from '../../apps/web/lib/oidc';
import { createFakeIdp, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_ISSUER, type FakeIdp } from '../helpers/fake-oidc-idp';
import { BASE } from './helpers';

const OWNER = 'owner@example.local';
const KEY = randomBytes(32).toString('base64');
const REDIRECT = `${BASE}/api/auth/oidc/callback`;
const ENV: Record<string, string> = {
  AUTH_MODE: 'oidc',
  OIDC_ISSUER_URL: FAKE_ISSUER,
  OIDC_CLIENT_ID: FAKE_CLIENT_ID,
  OIDC_CLIENT_SECRET: FAKE_CLIENT_SECRET,
  OIDC_REDIRECT_URI: REDIRECT,
  AUTH_ALLOWED_IDENTITY: OWNER,
  SECRETS_MASTER_KEY: KEY,
  SECRETS_KEY_VERSION: '1',
};
const USER = { sub: 'owner-sub', email: OWNER, email_verified: true };

let db: Db;
let idp: FakeIdp;

beforeAll(async () => {
  db = (await getDb(loadConfig())).db;
  await seed(db, { allowedIdentity: OWNER });
});
afterAll(async () => {
  await closeDb();
});
beforeEach(async () => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  idp = createFakeIdp();
  vi.stubGlobal('fetch', idp.fetch);
  resetOidcLoginClientForTests();
  await db.delete(schema.auditEvents).where(inArray(schema.auditEvents.action, ['auth.login', 'auth.login_denied']));
  await db.delete(schema.authOidcStates);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 브라우저 하나의 쿠키 저장소(cs_oidc_flow 만) — Set-Cookie 를 실제처럼 적용한다. */
class Jar {
  flow: string | null = null;
  apply(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const m = /^cs_oidc_flow=([^;]*)/.exec(c);
      if (!m) continue;
      this.flow = /Max-Age=0/.test(c) || m[1] === '' ? null : m[1]!;
    }
  }
  headers(): Record<string, string> {
    return this.flow ? { cookie: `cs_oidc_flow=${this.flow}` } : {};
  }
}

async function start(jar: Jar): Promise<string> {
  const res = await startRoute.GET(new Request(`${BASE}/api/auth/oidc/start`, { headers: { accept: 'text/html', 'sec-fetch-site': 'same-origin', ...jar.headers() } }));
  expect(res.status).toBe(303);
  jar.apply(res);
  return res.headers.get('location')!;
}

async function callback(url: string, jar: Jar): Promise<Response> {
  const res = await callbackRoute.GET(new Request(url, { headers: { accept: 'application/json', ...jar.headers() } }));
  jar.apply(res);
  return res;
}

const flowCleared = (res: Response) => res.headers.getSetCookie().some((c) => c.startsWith('cs_oidc_flow=;'));

describe('P2 callback:172 — 결합 쿠키는 확인된 흐름을 끝낼 때만 지운다', () => {
  it('같은 브라우저 두 탭: A 시작 → B 시작 → A callback(불일치, 쿠키 보존) → B callback 성공', async () => {
    const jar = new Jar();
    const authA = await start(jar);
    const authB = await start(jar);
    const cbA = idp.authorize(authA, USER);
    const cbB = idp.authorize(authB, USER);
    const resA = await callback(cbA, jar);
    expect(resA.status).toBe(400);
    expect((await resA.json()).error).toBe('oidc_state_invalid');
    expect(flowCleared(resA)).toBe(false);
    expect(jar.flow).not.toBeNull();
    const resB = await callback(cbB, jar);
    expect(resB.status).toBe(200);
    // FIX2-T21P1B: 성공도 지우지 않는다(600초 만료) — 재사용은 서버 1회용 state 가 막는다
    expect(flowCleared(resB)).toBe(false);
  });

  it('관계없는 callback(state 없음·모르는 state·redirect 불일치)은 진행 중 흐름의 쿠키를 지우지 않는다', async () => {
    const jar = new Jar();
    const auth = await start(jar);
    for (const url of [`${REDIRECT}?code=x`, `${REDIRECT}?code=x&state=${'A'.repeat(43)}`, idp.authorize(auth, USER).replace(BASE, 'http://127.0.0.1:3000')]) {
      const res = await callback(url, jar);
      expect(res.status).toBe(400);
      expect(flowCleared(res)).toBe(false);
    }
    expect((await callback(idp.authorize(auth, USER), jar)).status).toBe(200);
  });

  it('조기 429 는 쿠키를 지우지 않는다', async () => {
    const jar = new Jar();
    const auth = await start(jar);
    const cb = idp.authorize(auth, USER);
    const other = new Jar();
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) await callback(`${REDIRECT}?code=x&state=${randomBytes(32).toString('base64url')}`, other);
    const res = await callback(cb, jar);
    expect(res.status).toBe(429);
    expect(flowCleared(res)).toBe(false);
    expect(jar.flow).not.toBeNull();
  });

  it('FIX2-T21P1B: 확인된 흐름의 실패(허용 신원 불일치)도 쿠키를 지우지 않는다', async () => {
    const jar = new Jar();
    const auth = await start(jar);
    const res = await callback(idp.authorize(auth, { ...USER, email: 'x@example.local' }), jar);
    expect(res.status).toBe(403);
    expect(flowCleared(res)).toBe(false);
  });
});

describe('P2 auth-oidc:54 — 로그인 요청 생성 직렬화', () => {
  const keyring = () => requireSecretKeyring({ SECRETS_MASTER_KEY: KEY, SECRETS_KEY_VERSION: '1' });
  const create = (state: string, maxPending = 100) =>
    createOidcLoginState(db, { state, browserToken: 'b', secrets: { codeVerifier: 'v', nonce: 'n' }, settingsHash: 'h', keyring: keyring(), maxPending });

  it('생성 트랜잭션은 맨 먼저 전용 advisory 잠금(pg_advisory_xact_lock(hashtext(cs.auth.oidc_state)))을 건다', async () => {
    const dialect = new PgDialect();
    const seen: string[] = [];
    const original = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementation(((fn: (tx: unknown) => Promise<unknown>, cfg?: unknown) =>
      original(
        (tx) =>
          fn(
            new Proxy(tx, {
              get(target, key, recv) {
                if (key === 'execute') {
                  return (q: Parameters<typeof tx.execute>[0]) => {
                    seen.push(dialect.sqlToQuery(q as never).sql + ' ' + JSON.stringify(dialect.sqlToQuery(q as never).params));
                    return target.execute(q);
                  };
                }
                const v = Reflect.get(target, key, recv) as unknown;
                return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
              },
            }),
          ),
        cfg as never,
      )) as typeof db.transaction);
    await create(randomBytes(32).toString('base64url'));
    expect(OIDC_STATE_LOCK_KEY).toBe('cs.auth.oidc_state');
    expect(seen[0]).toContain('pg_advisory_xact_lock(hashtext(');
    expect(seen[0]).toContain('cs.auth.oidc_state');
  });

  it('진행 중 99개에서 동시 생성 5건 → 상한 100 을 넘지 않는다(PGlite 단일 연결 — Postgres 다중 연결 미검증)', async () => {
    const t0 = Date.now();
    for (let i = 0; i < 99; i++) {
      await createOidcLoginState(db, {
        state: randomBytes(32).toString('base64url'),
        browserToken: 'b',
        secrets: { codeVerifier: 'v', nonce: 'n' },
        settingsHash: 'h',
        keyring: keyring(),
        now: new Date(t0 + i),
      });
    }
    expect(await db.select().from(schema.authOidcStates)).toHaveLength(99);
    await Promise.all(Array.from({ length: 5 }, () => create(randomBytes(32).toString('base64url'))));
    expect(await db.select().from(schema.authOidcStates)).toHaveLength(100);
  });
});
