/**
 * T21-P1a(G1a): 운영 빌드에서 dev 로그인 거부 + 로그인 시도 횟수 제한(전역 15분 창, 실패 10회).
 * route handler 를 직접 호출한다. 이 파일만의 getDb 싱글턴(memory://)을 쓰므로 다른 파일의 실패 기록과 섞이지 않는다.
 * 시간 창은 Date 만 가짜로 돌려(PGlite·타이머는 실제) 확인한다 — 요청마다 1초씩 앞으로 보낸다.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, recordAudit, schema, seed, type Db } from '@cs/db';
import { LOGIN_FAILURE_WINDOW_MS, LOGIN_MAX_FAILURES, loadConfig } from '@cs/domain';
import * as loginRoute from '../../apps/web/app/api/auth/login/route';
import { GET as healthGET } from '../../apps/web/app/api/health/route';
import { BASE, jsonPost, sessionCookieValue } from './helpers';

const OWNER = 'owner@example.local';
let db: Db;

beforeAll(async () => {
  db = (await getDb(loadConfig())).db;
  await seed(db, { allowedIdentity: OWNER });
});
afterAll(async () => {
  vi.useRealTimers();
  await closeDb();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const sessionCount = async () => (await db.select().from(schema.sessions)).length;
const deniedRows = async () =>
  db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'auth.login_denied'));
const loginJson = (identity: string) => loginRoute.POST(jsonPost('/api/auth/login', { identity }));
const loginForm = (identity: string) =>
  loginRoute.POST(
    new Request(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { origin: BASE, accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ identity }).toString(),
    }),
  );

/** 가짜 시계를 ms 만큼 앞으로(가짜 시계가 아니면 지금 시각에서 시작). */
let fakeNow: number | null = null;
function advance(ms: number): Date {
  if (fakeNow === null) {
    fakeNow = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
  }
  fakeNow += ms;
  vi.setSystemTime(fakeNow);
  return new Date(fakeNow);
}

describe('운영 빌드(NODE_ENV=production) + AUTH_MODE=dev → 로그인 거부', () => {
  it('맞는 식별자라도 503 dev_login_refused_in_production, 쿠키·세션·감사 행 없음', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const sessions = await sessionCount();
    const denied = (await deniedRows()).length;
    const res = await loginJson(OWNER);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'dev_login_refused_in_production',
      message: '운영 빌드에서는 개발용 로그인(AUTH_MODE=dev)을 쓸 수 없습니다. 운영 인증 설정이 필요합니다',
    });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await sessionCount()).toBe(sessions);
    expect((await deniedRows()).length).toBe(denied); // 설정·DB 를 읽기 전에 거부

    // AUTH_MODE 를 명시해도(dev) 같다. 브라우저 폼은 /login?error=production_dev
    vi.stubEnv('AUTH_MODE', 'dev');
    expect((await loginJson(OWNER)).status).toBe(503);
    const form = await loginForm(OWNER);
    expect(form.status).toBe(303);
    expect(form.headers.get('location')).toBe('/login?error=production_dev');
    expect(form.headers.get('set-cookie')).toBeNull();
    expect(await sessionCount()).toBe(sessions);
  });

  it('NODE_ENV=production 이면 설정 읽기(getConfig) 자체가 실패 → 공개 health 는 degraded 503(내용 없이)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await healthGET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'degraded', db_ok: false });
    expect(JSON.stringify(body)).not.toContain('AUTH_MODE');
    err.mockRestore();
  });

  it('NODE_ENV=production + AUTH_MODE=oidc → 기존처럼 503 oidc_not_configured(운영 인증 미구현, T21-P1b)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_MODE', 'oidc');
    const res = await loginJson(OWNER);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('oidc_not_configured');
  });

  it('NODE_ENV=test(현재)·development + dev → 허용(기존 동작)', async () => {
    const ok = await loginJson(OWNER);
    expect(ok.status).toBe(200);
    vi.stubEnv('NODE_ENV', 'development');
    expect((await loginJson(OWNER)).status).toBe(200);
  });
});

describe('로그인 시도 횟수 제한(전역, 15분 창, 실패 10회)', () => {
  it(`실패 ${LOGIN_MAX_FAILURES}회 뒤에는 맞는 식별자도 같은 429, 세션·감사 행이 늘지 않는다`, async () => {
    advance(LOGIN_FAILURE_WINDOW_MS + 1000); // 앞 describe 의 성공·실패와 분리
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      advance(1000);
      const res = await loginJson(`intruder${i}@example.local`);
      expect(res.status).toBe(401);
    }
    const sessions = await sessionCount();
    const denied = (await deniedRows()).length;

    advance(1000);
    const wrong = await loginJson('intruder-next@example.local');
    advance(1000);
    const right = await loginJson(OWNER);
    expect(wrong.status).toBe(429);
    expect(right.status).toBe(429);
    const wrongBody = await wrong.json();
    expect(await right.json()).toEqual(wrongBody); // 식별자 존재 여부를 드러내지 않음
    expect(wrongBody).toEqual({ error: 'login_rate_limited', message: '로그인 시도가 너무 많습니다. 잠시 뒤(최대 15분) 다시 시도하세요.' });
    expect(right.headers.get('set-cookie')).toBeNull();

    advance(1000);
    const form = await loginForm(OWNER);
    expect(form.status).toBe(303);
    expect(form.headers.get('location')).toBe('/login?error=rate_limited');

    // 잘못된 본문도 막힌 동안은 429(본문을 읽기 전에 판정)
    advance(1000);
    expect((await loginRoute.POST(jsonPost('/api/auth/login', { nope: 1 }))).status).toBe(429);

    expect(await sessionCount()).toBe(sessions);
    expect((await deniedRows()).length).toBe(denied); // 429 는 감사 행을 남기지 않는다
  });

  it('창(15분)이 지나면 다시 로그인할 수 있다', async () => {
    // 앞 시험: 실패 10회가 1초 간격(첫 실패 = 마지막 요청 13초 전). 미끄러지는 창이라 첫 실패가 창 안에 있는 동안은 막힌다.
    advance(LOGIN_FAILURE_WINDOW_MS - 20_000);
    expect((await loginJson(OWNER)).status).toBe(429);
    advance(30_000); // 실패 10회 모두 15분보다 오래됨
    const ok = await loginJson(OWNER);
    expect(ok.status).toBe(200);
    expect(sessionCookieValue(ok)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('성공 로그인 이전의 실패는 세지 않는다(성공 뒤 다시 10회까지 401)', async () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) {
      advance(1000);
      expect((await loginJson(`x${i}@example.local`)).status).toBe(401);
    }
    advance(1000);
    expect((await loginJson(OWNER)).status).toBe(200);
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      advance(1000);
      expect((await loginJson(`y${i}@example.local`)).status).toBe(401);
    }
    advance(1000);
    expect((await loginJson(OWNER)).status).toBe(429);
  });

  it('창 밖(16분 전) 실패·세지 않는 사유는 무시, 창 안(14분 전) 실패는 센다', async () => {
    const now = advance(LOGIN_FAILURE_WINDOW_MS + 60_000); // 앞 시험의 실패를 창 밖으로
    const fail = (at: Date, reason = 'identity_mismatch') =>
      recordAudit(db, { ownerId: null, action: 'auth.login_denied', entity: 'session', details: { reason }, at });
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) await fail(new Date(now.getTime() - 16 * 60_000));
    for (let i = 0; i < LOGIN_MAX_FAILURES * 2; i++) await fail(new Date(now.getTime() - 60_000), 'dev_login_not_allowed');
    // 미래 시각(시계 되돌림 등)의 행도 세지 않는다
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) await fail(new Date(now.getTime() + 60 * 60_000));
    advance(1000);
    expect((await loginJson('z@example.local')).status).toBe(401); // 창 안 실패 1회

    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) await fail(new Date(now.getTime() - 14 * 60_000), 'invalid_request');
    advance(1000);
    expect((await loginJson(OWNER)).status).toBe(429); // 1 + 9 = 10
  });
});
