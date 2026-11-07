/**
 * FIX2-T21P1B(Codex review-FIX-T21P1B P2 callback/route.ts:178·:172) — callback 은 공유 결합 쿠키(cs_oidc_flow)를 지우지 않는다.
 * 시나리오: A callback 이 결합 확인 뒤 token 응답을 기다리는 동안 B 로그인 시작(쿠키가 B 로 바뀜) → A 가 실패 또는 성공으로 끝남 → B callback 성공.
 * 쿠키는 600초 만료에 맡기고, 재사용 방지는 서버의 1회용 state(auth_oidc_states.used_at)가 한다. 가짜 IdP 만, 이 파일만의 memory:// DB.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';
import { closeDb, getDb, schema, seed, type Db } from '@cs/db';
import { loadConfig } from '@cs/domain';
import * as startRoute from '../../apps/web/app/api/auth/oidc/start/route';
import * as callbackRoute from '../../apps/web/app/api/auth/oidc/callback/route';
import { resetOidcLoginClientForTests } from '../../apps/web/lib/oidc';
import { createFakeIdp, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_ISSUER, type FakeIdp, type FakeUser } from '../helpers/fake-oidc-idp';
import { BASE } from './helpers';

const OWNER = 'owner@example.local';
const ENV: Record<string, string> = {
  AUTH_MODE: 'oidc',
  OIDC_ISSUER_URL: FAKE_ISSUER,
  OIDC_CLIENT_ID: FAKE_CLIENT_ID,
  OIDC_CLIENT_SECRET: FAKE_CLIENT_SECRET,
  OIDC_REDIRECT_URI: `${BASE}/api/auth/oidc/callback`,
  AUTH_ALLOWED_IDENTITY: OWNER,
  SECRETS_MASTER_KEY: randomBytes(32).toString('base64'),
  SECRETS_KEY_VERSION: '1',
};
const GOOD: FakeUser = { sub: 'owner-sub', email: OWNER, email_verified: true };

let db: Db;
let idp: FakeIdp;
/** 다음 token 요청 하나를 붙잡는 게이트 */
let gate: { reached: Promise<void>; release: () => void } | null = null;

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
  gate = null;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const g = gate;
    if (g && new URL(String(input)).pathname === '/token') {
      gate = null;
      (g as unknown as { arrive: () => void }).arrive();
      await new Promise<void>((r) => (g.release = r));
    }
    return idp.fetch(input, init);
  });
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

function holdNextToken() {
  let arrive!: () => void;
  const reached = new Promise<void>((r) => (arrive = r));
  const g = { reached, release: () => {}, arrive };
  gate = g;
  return g;
}

/** 브라우저 하나의 쿠키 저장소(cs_oidc_flow) — Set-Cookie 를 실제처럼 적용 */
class Jar {
  flow: string | null = null;
  apply(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const m = /^cs_oidc_flow=([^;]*)/.exec(c);
      if (m) this.flow = /Max-Age=0/.test(c) || m[1] === '' ? null : m[1]!;
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

const callback = (url: string, cookies: Record<string, string>) =>
  callbackRoute.GET(new Request(url, { headers: { accept: 'application/json', ...cookies } }));

describe('P2 callback:178·:172 — 늦게 끝난 A 가 B 의 결합 쿠키를 지우지 않는다', () => {
  for (const variant of ['실패(허용 신원 불일치)', '성공'] as const) {
    it(`A token 지연 → B 시작 → A ${variant} → B callback 성공`, async () => {
      const jar = new Jar();
      const authA = await start(jar);
      const cbA = idp.authorize(authA, variant === '성공' ? GOOD : { ...GOOD, email: 'other@example.local' });
      const g = holdNextToken();
      const pendingA = callback(cbA, jar.headers()); // 요청 시점 쿠키 = A
      await g.reached; // A: state·결합 확인 끝, token 대기
      const authB = await start(jar); // 쿠키 = B
      const cbB = idp.authorize(authB, GOOD);
      g.release();
      const resA = await pendingA;
      expect(resA.status).toBe(variant === '성공' ? 200 : 403);
      jar.apply(resA); // A 응답의 Set-Cookie 를 브라우저가 적용
      expect(resA.headers.getSetCookie().some((c) => c.startsWith('cs_oidc_flow='))).toBe(false);
      const resB = await callback(cbB, jar.headers());
      expect(resB.status).toBe(200);
    });
  }

  it('쿠키를 지우지 않아도 끝난 흐름은 다시 쓸 수 없다(서버 1회용 state)', async () => {
    const jar = new Jar();
    const auth = await start(jar);
    const cb = idp.authorize(auth, GOOD);
    const first = await callback(cb, jar.headers());
    expect(first.status).toBe(200);
    jar.apply(first);
    expect(jar.flow).not.toBeNull(); // 쿠키는 남아 있다(600초 만료)
    const again = await callback(idp.authorize(auth, GOOD), jar.headers());
    expect(again.status).toBe(400);
    expect((await again.json()).error).toBe('oidc_state_invalid');
  });
});
