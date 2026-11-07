/**
 * FIX-T21P1A round 1(Codex P1·놓친 케이스): 로그인 시도 횟수 제한의 동시성·시각·경계.
 * - 조기 검사 직후(본문 읽기)에서 요청을 멈춰 두었다가 함께 풀어, 잠금 안 재검사·기록이 직렬화되는지 본다.
 *   멈춤 지점 = 본문 스트림의 첫 read(pull) — route 는 조기 검사 → 본문 읽기 → 전역 잠금 안 재검사·판정·기록 순서다.
 * - Date 만 가짜(PGlite·타이머는 실제). 이 파일만의 memory:// DB.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { closeDb, getDb, recordAudit, schema, seed, type Db } from '@cs/db';
import { LOGIN_FAILURE_WINDOW_MS, LOGIN_MAX_FAILURES, loadConfig } from '@cs/domain';
import * as loginRoute from '../../apps/web/app/api/auth/login/route';
import { BASE, jsonPost } from './helpers';

const OWNER = 'owner@example.local';
let db: Db;

beforeAll(async () => {
  db = (await getDb(loadConfig())).db;
  await seed(db, { allowedIdentity: OWNER });
  fakeNow = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(fakeNow);
});
afterAll(async () => {
  vi.useRealTimers();
  await closeDb();
});

let fakeNow = 0;
/** 가짜 시계를 ms 만큼 앞으로. 0 이면 그대로(같은 ms). */
function advance(ms: number): Date {
  fakeNow += ms;
  vi.setSystemTime(fakeNow);
  return new Date(fakeNow);
}
/** 앞 시험의 기록이 모두 창 밖이 되게 충분히 이동(미래 행 없음). */
const freshWindow = () => advance(LOGIN_FAILURE_WINDOW_MS + 60_000);

const loginJson = (identity: string) => loginRoute.POST(jsonPost('/api/auth/login', { identity }));

/** 창 안(지금 기준) 실패로 세는 행 수 — 테스트 쪽 독립 계산(성공 이후 여부와 무관한 원시 합계). */
async function failureRowsSince(since: Date) {
  const rows = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'auth.login_denied'));
  return rows.filter(
    (r) =>
      r.at.getTime() > since.getTime() &&
      ['identity_mismatch', 'invalid_request'].includes(String((r.sanitizedDetails as { reason?: unknown }).reason)),
  );
}

/** 본문 첫 read 에서 멈추는 로그인 요청. reading = 조기 검사를 지나 본문을 읽기 시작함, release() 로 본문을 보낸다. */
function gatedLogin(body: string, contentType = 'application/json') {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let markReading!: () => void;
  const reading = new Promise<void>((r) => (markReading = r));
  const bytes = new TextEncoder().encode(body);
  let sent = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(c) {
        if (sent) {
          c.close();
          return;
        }
        markReading();
        await gate;
        sent = true;
        c.enqueue(bytes);
      },
    },
    { highWaterMark: 0 },
  );
  const res = loginRoute.POST(
    new Request(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { origin: BASE, accept: 'application/json', 'content-type': contentType },
      body: stream,
      duplex: 'half',
    } as RequestInit),
  );
  return { res, reading, release };
}

async function recordFailures(n: number) {
  for (let i = 0; i < n; i++) {
    advance(1000);
    expect((await loginJson(`pre${i}@example.local`)).status).toBe(401);
  }
}

describe('P1 — 조기 검사와 기록 사이 경합', () => {
  it(`실패 ${LOGIN_MAX_FAILURES - 1}회 + 조기 검사를 통과한 틀린 식별자 4건 동시 → 정확히 1건만 401(기록), 나머지 429, 창 안 실패 ≤ ${LOGIN_MAX_FAILURES}`, async () => {
    const start = freshWindow();
    await recordFailures(LOGIN_MAX_FAILURES - 1);
    advance(1000);
    const reqs = [0, 1, 2, 3].map((i) => gatedLogin(JSON.stringify({ identity: `race${i}@example.local` })));
    await Promise.all(reqs.map((r) => r.reading)); // 4건 모두 조기 검사(실패 9 < 10) 통과
    for (const r of reqs) r.release();
    const statuses = (await Promise.all(reqs.map((r) => r.res))).map((r) => r.status).sort();
    expect(statuses).toEqual([401, 429, 429, 429]);
    expect((await failureRowsSince(start)).length).toBe(LOGIN_MAX_FAILURES);
  });

  it('조기 검사 뒤 다른 요청이 상한을 채우면, 기다리던 맞는 식별자도 429(잠금 안 재검사) — 세션 없음', async () => {
    freshWindow();
    await recordFailures(LOGIN_MAX_FAILURES - 1);
    advance(1000);
    const sessionsBefore = (await db.select().from(schema.sessions)).length;
    const owner = gatedLogin(JSON.stringify({ identity: OWNER }));
    await owner.reading; // 실패 9회일 때 조기 검사 통과
    advance(1000);
    expect((await loginJson('tenth@example.local')).status).toBe(401); // 10번째 실패
    advance(1000);
    owner.release();
    const res = await owner.res;
    expect(res.status).toBe(429);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await db.select().from(schema.sessions)).length).toBe(sessionsBefore);
  });

  it('경계에서 맞는 식별자와 틀린 식별자가 경합 → 잠금 순서대로: (틀림 401 → 맞음 429) 또는 (맞음 200 → 틀림 401, 성공 이후 실패라 셈)', async () => {
    freshWindow();
    await recordFailures(LOGIN_MAX_FAILURES - 1);
    advance(1000);
    const wrong = gatedLogin(JSON.stringify({ identity: 'edge@example.local' }));
    const right = gatedLogin(JSON.stringify({ identity: OWNER }));
    await Promise.all([wrong.reading, right.reading]);
    wrong.release();
    right.release();
    const [w, r] = await Promise.all([wrong.res, right.res]);
    const outcome = `${w.status}/${r.status}`;
    expect(['401/429', '401/200']).toContain(outcome);
    // 기록 순서(seq)로 확인: 맞음이 200 이면 그 성공 행이 틀림의 실패 행보다 앞이다.
    const rows = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.entity, 'session'))
      .orderBy(desc(schema.auditEvents.at));
    const authRows = rows.filter((x) => x.action === 'auth.login' || x.action === 'auth.login_denied').slice(0, 2);
    const seqOf = (x: (typeof rows)[number]) => Number(x.versionOrHash);
    if (r.status === 200) {
      const ok = authRows.find((x) => x.action === 'auth.login')!;
      const bad = authRows.find((x) => x.action === 'auth.login_denied')!;
      expect(seqOf(ok)).toBeLessThan(seqOf(bad));
    } else {
      expect(authRows.every((x) => x.action === 'auth.login_denied')).toBe(true);
    }
  });
});

describe('놓친 케이스 — 시각·잘못된 본문', () => {
  it('느린 본문: 실패 기록 시각은 본문을 다 읽은 뒤(잠금 안)의 시각이다(조기 검사 시각이 아님)', async () => {
    freshWindow();
    const early = advance(1000);
    const slow = gatedLogin(JSON.stringify({ identity: 'slow@example.local' }));
    await slow.reading;
    const later = advance(20 * 60_000); // 본문이 20분 늦게 도착
    slow.release();
    expect((await slow.res).status).toBe(401);
    const [last] = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, 'auth.login_denied'))
      .orderBy(desc(schema.auditEvents.at))
      .limit(1);
    expect(last!.at.getTime()).toBe(later.getTime());
    expect(last!.at.getTime()).not.toBe(early.getTime());
  });

  it('잘못된 JSON·필드 누락·빈 식별자·지원하지 않는 형식은 invalid_request 실패로 세어 10회 뒤 429', async () => {
    const start = freshWindow();
    const bad: Array<[string, string]> = [
      ['{not json', 'application/json'],
      [JSON.stringify({ nope: 1 }), 'application/json'],
      [JSON.stringify({ identity: '' }), 'application/json'],
      [JSON.stringify({ identity: 42 }), 'application/json'],
      ['identity=a', 'text/plain'],
    ];
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      advance(1000);
      const [body, type] = bad[i % bad.length]!;
      const res = await loginRoute.POST(
        new Request(`${BASE}/api/auth/login`, { method: 'POST', headers: { origin: BASE, 'content-type': type }, body }),
      );
      expect(res.status).toBe(400);
    }
    const rows = await failureRowsSince(start);
    expect(rows).toHaveLength(LOGIN_MAX_FAILURES);
    expect(rows.every((r) => (r.sanitizedDetails as { reason: string }).reason === 'invalid_request')).toBe(true);
    advance(1000);
    expect((await loginJson(OWNER)).status).toBe(429);
  });
});

describe('P2 — 같은 ms·창 경계의 결정적 순서', () => {
  it('시계가 멈춘 상태(모든 요청이 같은 ms): 실패 9 → 성공 → 실패 10 → 다음은 429(성공 뒤 실패를 기록 순서로 셈)', async () => {
    freshWindow();
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) expect((await loginJson(`s${i}@example.local`)).status).toBe(401);
    expect((await loginJson(OWNER)).status).toBe(200);
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) expect((await loginJson(`t${i}@example.local`)).status).toBe(401);
    expect((await loginJson(OWNER)).status).toBe(429);
  });

  it('창 경계(직접 넣은 순번 없는 기록): 정확히 창 시작 = 세지 않음, 정확히 지금 = 셈', async () => {
    const now = freshWindow();
    const fail = (at: Date) =>
      recordAudit(db, { ownerId: null, action: 'auth.login_denied', entity: 'session', details: { reason: 'identity_mismatch' }, at });
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) await fail(new Date(now.getTime() - LOGIN_FAILURE_WINDOW_MS));
    expect((await loginJson('w@example.local')).status).toBe(401); // 창 시작 10행은 밖 → 지금 1회
    for (let i = 0; i < LOGIN_MAX_FAILURES - 2; i++) await fail(now); // 지금 8행 → 1 + 8 = 9
    expect((await loginJson('w2@example.local')).status).toBe(401); // 9 < 10 → 401, 이제 10
    expect((await loginJson(OWNER)).status).toBe(429);
  });

  it('순번 없는 기록끼리 같은 ms(예: 복원된 기록): 성공과 같은 ms 의 실패는 세지 않고(성공 우선), 1ms 뒤 실패는 센다', async () => {
    const now = freshWindow();
    const at = new Date(now.getTime() - 60_000);
    const later = new Date(at.getTime() + 1);
    const fail = (t: Date) =>
      recordAudit(db, { ownerId: null, action: 'auth.login_denied', entity: 'session', details: { reason: 'identity_mismatch' }, at: t });
    const [owner] = await db.select().from(schema.users).limit(1);
    await recordAudit(db, { ownerId: owner!.id, action: 'auth.login', entity: 'session', details: { mode: 'dev' }, at });
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) await fail(at); // 같은 ms → 세지 않음
    expect((await loginJson('u@example.local')).status).toBe(401); // 지금 1회
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++) await fail(later); // 1ms 뒤 9행 → 1 + 9 = 10
    expect((await loginJson(OWNER)).status).toBe(429);
  });
});
