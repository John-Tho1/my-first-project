/**
 * FIX2-T21P1A(Codex review-FIX-T21P1A): 잠금 밖 조기 검사의 읽기 일관성·로그인 순번 자릿수·세션/감사 원자성.
 * Date 만 가짜(시계 정지 = 모든 기록이 같은 ms). 이 파일만의 memory:// DB.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDb, countRecentLoginFailures, getDb, recordAudit, schema, seed, type Db } from '@cs/db';
import { LOGIN_FAILURE_REASONS, LOGIN_FAILURE_WINDOW_MS, LOGIN_MAX_FAILURES, loadConfig } from '@cs/domain';
import * as loginRoute from '../../apps/web/app/api/auth/login/route';
import { jsonPost } from './helpers';

const OWNER = 'owner@example.local';
let db: Db;
let ownerId: string;
let fakeNow = 0;

beforeAll(async () => {
  db = (await getDb(loadConfig())).db;
  ownerId = (await seed(db, { allowedIdentity: OWNER })).ownerId;
  fakeNow = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(fakeNow);
});
afterAll(async () => {
  vi.useRealTimers();
  await closeDb();
});

/** 앞 시험의 기록이 모두 창 밖이 되게 이동(그 뒤 시계는 멈춘 채). */
function freshWindow(): Date {
  fakeNow += LOGIN_FAILURE_WINDOW_MS + 60_000;
  vi.setSystemTime(fakeNow);
  return new Date(fakeNow);
}
const loginJson = (identity: string) => loginRoute.POST(jsonPost('/api/auth/login', { identity }));
const fail = (at: Date, seq: string | null) =>
  recordAudit(db, {
    ownerId: null,
    action: 'auth.login_denied',
    entity: 'session',
    details: { reason: 'identity_mismatch' },
    at,
    ...(seq === null ? {} : { versionOrHash: seq }),
  });

describe('P2 — 조기 검사(잠금 밖)는 한 시점의 상태로만 센다', () => {
  it('첫 읽기 직후 다른 요청의 성공·실패가 커밋돼도 결과는 그 전(9) 또는 그 뒤(1) 상태 중 하나 — 섞인 10 이 아니다', async () => {
    const now = freshWindow();
    for (let i = 1; i <= LOGIN_MAX_FAILURES - 1; i++) await fail(now, String(1_000 + i)); // 순번 1001~1009, 같은 ms
    // PGlite 클라이언트의 첫 질의가 끝난 직후, 다른 요청의 성공(순번 1010)·실패(1011)를 커밋한다.
    const client = (db as unknown as { $client: { query: (...a: unknown[]) => Promise<unknown> } }).$client;
    const orig = client.query.bind(client);
    let calls = 0;
    let inHook = false;
    client.query = async (...a: unknown[]) => {
      const r = await orig(...a);
      if (!inHook && ++calls === 1) {
        inHook = true;
        await recordAudit(db, { ownerId, action: 'auth.login', entity: 'session', versionOrHash: '1010', details: { mode: 'dev' }, at: now });
        await fail(now, '1011');
        inHook = false;
      }
      return r;
    };
    let n: number;
    try {
      n = await countRecentLoginFailures(db, { now, windowMs: LOGIN_FAILURE_WINDOW_MS, reasons: LOGIN_FAILURE_REASONS });
    } finally {
      client.query = orig;
    }
    expect([LOGIN_MAX_FAILURES - 1, 1]).toContain(n);
    // 커밋 뒤 상태로 다시 세면 1(성공 뒤 실패 1건)
    expect(await countRecentLoginFailures(db, { now, windowMs: LOGIN_FAILURE_WINDOW_MS, reasons: LOGIN_FAILURE_REASONS })).toBe(1);
    // 그리고 실제 요청은 429 가 아니다(1 < 10)
    expect((await loginJson('after@example.local')).status).toBe(401);
  });
});

describe('놓친 케이스 — 로그인 순번 자릿수', () => {
  it('최대 순번이 15자리(999999999999999)일 때 다음 순번(16자리)도 순번으로 읽혀 순서·횟수에 쓰인다', async () => {
    const now = freshWindow();
    await recordAudit(db, { ownerId, action: 'auth.login', entity: 'session', versionOrHash: '999999999999999', details: { mode: 'dev' }, at: now });
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) expect((await loginJson(`o${i}@example.local`)).status).toBe(401);
    expect((await loginJson(OWNER)).status).toBe(429); // 같은 ms 지만 순번이 성공보다 커서 10회 모두 셈
    const rows = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'auth.login_denied'));
    const seqs = rows
      .filter((r) => r.at.getTime() === now.getTime() && r.versionOrHash !== null)
      .map((r) => BigInt(r.versionOrHash!))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(seqs).toHaveLength(LOGIN_MAX_FAILURES);
    expect(seqs[0]).toBe(1_000_000_000_000_000n);
    expect(seqs.at(-1)).toBe(1_000_000_000_000_000n + BigInt(LOGIN_MAX_FAILURES - 1));
  });

  it('2^53 을 넘는 순번도 정확히 +1 (부동소수 반올림 없음)', async () => {
    const now = freshWindow();
    await recordAudit(db, { ownerId, action: 'auth.login', entity: 'session', versionOrHash: '9007199254740993', details: { mode: 'dev' }, at: now });
    expect((await loginJson('big@example.local')).status).toBe(401);
    const rows = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'auth.login_denied'));
    expect(rows.some((r) => r.versionOrHash === '9007199254740994')).toBe(true);
  });
});

describe('놓친 케이스 — 성공 기록 실패 시 전체 되돌림', () => {
  it('세션을 만든 뒤 auth.login 감사 기록이 실패하면 세션도 남지 않는다(한 트랜잭션), 이후 정상 로그인 가능', async () => {
    freshWindow();
    await db.execute(
      sql.raw(
        `create or replace function cs_test_fail_login_audit() returns trigger language plpgsql as $$ begin if new.action = 'auth.login' then raise exception 'test: audit write failed'; end if; return new; end $$`,
      ),
    );
    await db.execute(
      sql.raw(`create trigger cs_test_fail_login_audit before insert on audit_events for each row execute function cs_test_fail_login_audit()`),
    );
    const sessions = (await db.select().from(schema.sessions)).length;
    const logins = (await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'auth.login'))).length;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await loginJson(OWNER);
      expect(res.status).toBe(500);
      expect(res.headers.get('set-cookie')).toBeNull();
    } finally {
      err.mockRestore();
      await db.execute(sql.raw(`drop trigger cs_test_fail_login_audit on audit_events`));
      await db.execute(sql.raw(`drop function cs_test_fail_login_audit()`));
    }
    expect((await db.select().from(schema.sessions)).length).toBe(sessions);
    expect((await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'auth.login'))).length).toBe(logins);
    expect((await loginJson(OWNER)).status).toBe(200);
  });
});
