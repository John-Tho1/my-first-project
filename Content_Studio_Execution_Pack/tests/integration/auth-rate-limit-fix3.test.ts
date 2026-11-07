/**
 * FIX3-T21P1A(Codex review-FIX2-T21P1A): 로그인 순번 범위 초과 시 닫힘(fail closed)·복원된 범위 밖 순번 무시·실패 감사 기록 실패 시 되돌림.
 * 이 파일만의 memory:// DB. 마지막 시험은 순번을 소진시키므로 맨 끝에 둔다.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDb, getDb, recordAudit, schema, seed, type Db } from '@cs/db';
import { loadConfig } from '@cs/domain';
import * as loginRoute from '../../apps/web/app/api/auth/login/route';
import { jsonPost } from './helpers';

const OWNER = 'owner@example.local';
let db: Db;

beforeAll(async () => {
  db = (await getDb(loadConfig())).db;
  await seed(db, { allowedIdentity: OWNER });
});
afterAll(async () => {
  await closeDb();
});

const loginJson = (identity: string) => loginRoute.POST(jsonPost('/api/auth/login', { identity }));
const auditCount = async () => (await db.select().from(schema.auditEvents)).length;
const sessionCount = async () => (await db.select().from(schema.sessions)).length;
/** 횟수 제한에 세지 않는 사유로 순번만 가진 행을 넣는다(복원된 행 흉내). */
const seqRow = (seq: string) =>
  recordAudit(db, { ownerId: null, action: 'auth.login_denied', entity: 'session', versionOrHash: seq, details: { reason: 'dev_login_not_allowed' } });

describe('복원된 범위 밖(31자리) 순번은 순번이 아닌 것으로 본다', () => {
  it('31자리 행은 최대 순번 계산에서 빠지고 로그인은 정상(유효 최대 + 1)', async () => {
    await seqRow('500');
    await seqRow('1' + '0'.repeat(30)); // 31자리
    expect((await loginJson(OWNER)).status).toBe(200);
    const rows = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'auth.login'));
    expect(rows.at(-1)!.versionOrHash).toBe('501');
  });
});

describe('auth.login_denied 감사 기록 실패 → 전체 되돌림, 401 로 꾸미지 않음', () => {
  it('틀린 식별자 + 실패 기록 insert 실패 → 500, 실패 행 없음, 트리거 제거 뒤 401', async () => {
    await db.execute(
      sql.raw(
        `create or replace function cs_test_fail_denied_audit() returns trigger language plpgsql as $$ begin if new.action = 'auth.login_denied' then raise exception 'test: denied audit write failed'; end if; return new; end $$`,
      ),
    );
    await db.execute(
      sql.raw(`create trigger cs_test_fail_denied_audit before insert on audit_events for each row execute function cs_test_fail_denied_audit()`),
    );
    const before = await auditCount();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await loginJson('intruder@example.local');
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe('internal');
    } finally {
      err.mockRestore();
      await db.execute(sql.raw(`drop trigger cs_test_fail_denied_audit on audit_events`));
      await db.execute(sql.raw(`drop function cs_test_fail_denied_audit()`));
    }
    expect(await auditCount()).toBe(before);
    expect((await loginJson('intruder@example.local')).status).toBe(401);
  });
});

describe('순번 30자리 → 31자리 경계: 닫힘(fail closed)', () => {
  it('최대 순번이 30자리 9 이면 다음 로그인은 503 login_sequence_exhausted, 세션·감사 행 없음(맞는·틀린 식별자 모두)', async () => {
    await seqRow('9'.repeat(30));
    const audits = await auditCount();
    const sessions = await sessionCount();
    for (const id of [OWNER, 'intruder@example.local']) {
      const res = await loginJson(id);
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe('login_sequence_exhausted');
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    expect(await auditCount()).toBe(audits);
    expect(await sessionCount()).toBe(sessions);
  });
});
