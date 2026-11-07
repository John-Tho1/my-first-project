/**
 * FIX1-FULLREV2(G17): 식별자 로그인의 multipart/form-data 파싱.
 * 브라우저 FormData 요청의 boundary 는 대소문자가 섞인다(Chrome·Safari `----WebKitFormBoundary…`). 예전에는 Content-Type 전체를 소문자로 바꿔
 * 파싱에 넘겨 boundary 가 본문과 맞지 않았고, 맞는 식별자도 400 + 실패 1회(invalid_request)로 셌다.
 * 미디어 유형 판별만 대소문자를 무시하고, 파싱에는 원래 Content-Type 을 그대로 넘긴다. CSRF·식별자 검사·횟수 제한은 그대로다.
 * route handler 를 직접 호출한다. DB 는 getDb 싱글턴(memory://).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, schema, seed, type Db } from '@cs/db';
import { loadConfig } from '@cs/domain';
import * as loginRoute from '../../apps/web/app/api/auth/login/route';
import { BASE, sessionCookieValue } from './helpers';

const OWNER = 'owner@example.local';
// Chrome 이 실제로 보내는 모양의 boundary(대문자 포함)
const BOUNDARY = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
let db: Db;

beforeAll(async () => {
  db = (await getDb(loadConfig())).db;
  await seed(db, { allowedIdentity: OWNER });
});
afterAll(async () => {
  await closeDb();
});

const sessionCount = async () => (await db.select().from(schema.sessions)).length;
const denialsOf = async (reason: string) =>
  (await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'auth.login_denied'))).filter(
    (r) => (r.sanitizedDetails as { reason?: string } | null)?.reason === reason,
  ).length;
const invalidRequestDenials = () => denialsOf('invalid_request');

function multipartBody(boundary: string, fields: Record<string, string>): string {
  const parts = Object.entries(fields).map(
    ([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
  return `${parts.join('')}--${boundary}--\r\n`;
}

function multipartLogin(
  identity: string,
  opts: { contentType?: string; boundary?: string; bodyBoundary?: string; headers?: Record<string, string> } = {},
): Request {
  const boundary = opts.boundary ?? BOUNDARY;
  return new Request(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: {
      origin: BASE,
      'content-type': opts.contentType ?? `multipart/form-data; boundary=${boundary}`,
      ...opts.headers,
    },
    body: multipartBody(opts.bodyBoundary ?? boundary, { identity }),
  });
}

describe('FIX1-FULLREV2(G17): 로그인 multipart boundary 대소문자 보존', () => {
  it('대소문자가 섞인 boundary 의 multipart(JSON 클라이언트) → 200 + 세션, 실패로 세지 않음', async () => {
    const sessions = await sessionCount();
    const denials = await invalidRequestDenials();
    const res = await loginRoute.POST(multipartLogin(OWNER, { headers: { accept: 'application/json' } }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(sessionCookieValue(res)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await sessionCount()).toBe(sessions + 1);
    expect(await invalidRequestDenials()).toBe(denials);
  });

  it('브라우저 폼(Accept text/html) multipart → 303 / + 세션 쿠키', async () => {
    const res = await loginRoute.POST(multipartLogin(OWNER, { headers: { accept: 'text/html' } }));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    expect(sessionCookieValue(res)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('브라우저가 만든 FormData 요청(Request 가 boundary 를 붙임) → 200', async () => {
    const fd = new FormData();
    fd.set('identity', OWNER);
    const res = await loginRoute.POST(
      new Request(`${BASE}/api/auth/login`, { method: 'POST', headers: { origin: BASE, accept: 'application/json' }, body: fd }),
    );
    expect(res.status).toBe(200);
  });

  it('미디어 유형·매개변수 이름은 대소문자 무시(Multipart/Form-Data; Boundary=…) — boundary 값은 그대로 맞춘다', async () => {
    const res = await loginRoute.POST(
      multipartLogin(OWNER, { contentType: `Multipart/Form-Data; Boundary=${BOUNDARY}`, headers: { accept: 'application/json' } }),
    );
    expect(res.status).toBe(200);
  });

  it('식별자 검사는 그대로: 틀린 식별자 multipart → 401, 세션 없음, identity_mismatch 기록', async () => {
    const sessions = await sessionCount();
    const mismatches = await denialsOf('identity_mismatch');
    const res = await loginRoute.POST(multipartLogin('intruder@example.local', { headers: { accept: 'application/json' } }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('login_denied');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await sessionCount()).toBe(sessions);
    expect(await denialsOf('identity_mismatch')).toBe(mismatches + 1);
  });

  it('CSRF 는 그대로: Origin 없음·다른 Origin 의 multipart → 403 csrf, 세션 없음', async () => {
    const sessions = await sessionCount();
    const noOrigin = new Request(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, accept: 'application/json' },
      body: multipartBody(BOUNDARY, { identity: OWNER }),
    });
    const r1 = await loginRoute.POST(noOrigin);
    expect(r1.status).toBe(403);
    expect((await r1.json()).error).toBe('csrf');
    const r2 = await loginRoute.POST(multipartLogin(OWNER, { headers: { origin: 'http://evil.example', accept: 'application/json' } }));
    expect(r2.status).toBe(403);
    expect(await sessionCount()).toBe(sessions);
  });

  it('본문 boundary 가 헤더와 다르면(대소문자만 달라도) 지금처럼 400 + invalid_request 1회', async () => {
    const sessions = await sessionCount();
    const denials = await invalidRequestDenials();
    const res = await loginRoute.POST(
      multipartLogin(OWNER, { bodyBoundary: BOUNDARY.toLowerCase(), headers: { accept: 'application/json' } }),
    );
    expect(res.status).toBe(400);
    expect(await sessionCount()).toBe(sessions);
    expect(await invalidRequestDenials()).toBe(denials + 1);
  });

  it('지원하지 않는 Content-Type 은 지금처럼 400(text/plain)', async () => {
    const res = await loginRoute.POST(multipartLogin(OWNER, { contentType: 'text/plain', headers: { accept: 'application/json' } }));
    expect(res.status).toBe(400);
  });
});
