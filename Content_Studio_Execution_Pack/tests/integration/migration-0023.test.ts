/**
 * FIX-T11 round 3(Codex review-FIX2-T11T12 0022:3): 0022 이전 worker 가 lease 때 먼저 올린 attempt(의도 없음)를 0023 이 가장 큰 의도 번호로 되돌리는지.
 * (1) migration 순서 시험: 0021 까지 적용한 DB 에 구버전 모양의 행(LEASED·attempt 2·의도 1개 / LEASED·attempt 5·의도 4개)을 넣고 0022·0023 적용 → 1·4.
 * (2) 앱 시험: 실제 전송으로 의도를 만든 뒤 구버전 lease 상태를 흉내 → 0023 문장 → 복구 + beginSend 가 의도 #2·#5 를 쓰고 CONFIRMED
 *     (실제 전송 4회 작업도 5번째 실제 시도를 받는다). migrator 대신 SQL 파일을 직접 실행한다(migration-0020 과 같은 방식).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import {
  approveItems,
  closeDb,
  createContent,
  createDb,
  createPlan,
  createVariantDraft,
  executePlan,
  getDb,
  listChannelAccounts,
  migrationsFolder,
  runJobsTick,
  schema,
  seed,
  setMockScenario,
  setVariantLifecycle,
  type Db,
  type DbHandle,
} from '@cs/db';
import { loadConfig, type Channel } from '@cs/domain';
import { createMockAdapterRegistry } from '@cs/providers';

type PGlite = DbHandle['client'];

const journal = JSON.parse(readFileSync(path.join(migrationsFolder(), 'meta/_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> };
const tags = journal.entries.map((e) => e.tag);
const sqlFor = (tag: string) =>
  readFileSync(path.join(migrationsFolder(), `${tag}.sql`), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
const TAG_0023 = tags.find((t) => t.startsWith('0023'))!;

async function applyTag(client: PGlite, tag: string) {
  await client.transaction(async (tx) => {
    for (const stmt of sqlFor(tag)) await tx.exec(stmt);
  });
}

describe('0023 migration: 구버전 선증가 attempt 정규화(migration 순서)', () => {
  it('0021 DB 의 LEASED·attempt 2·의도 1 → 1, LEASED·attempt 5·의도 4 → 4, 끝난 작업·의도가 있는 시도 번호는 그대로', async () => {
    const { client } = createDb({ driver: 'pglite', url: 'memory://' });
    for (const tag of tags.filter((t) => t < '0022')) await applyTag(client, tag);
    const one = async <T>(q: string, params: unknown[] = []) => (await client.query<T>(q, params)).rows[0]!;
    const owner = (await one<{ id: string }>(`insert into users (allowed_identity) values ('m23@example.local') returning id`)).id;
    const content = (await one<{ id: string }>(`insert into contents (owner_id, title) values ($1, 't') returning id`, [owner])).id;
    const cv = (await one<{ id: string }>(`insert into content_versions (content_id, version, body, created_by) values ($1, 1, 'b', 'owner') returning id`, [content])).id;
    const variant = (await one<{ id: string }>(`insert into variants (owner_id, content_id, channel) values ($1, $2, 'threads') returning id`, [owner, content])).id;
    const vv = (
      await one<{ id: string }>(
        `insert into variant_versions (owner_id, variant_id, version, content_version_id, body, metadata_json, created_by) values ($1, $2, 1, $3, 'b', '{}'::jsonb, 'owner') returning id`,
        [owner, variant, cv],
      )
    ).id;
    const account = (
      await one<{ id: string }>(
        `insert into channel_accounts (owner_id, platform, kind, external_account_id, display_name, state) values ($1, 'threads', 'mock', 'mock:threads:m23', 'm', 'mock_ready') returning id`,
        [owner],
      )
    ).id;
    const plan = (await one<{ id: string }>(`insert into distribution_plans (owner_id, status) values ($1, 'executing') returning id`, [owner])).id;
    let n = 0;
    const job = async (state: string, attempt: number, intents: number[], itemStatus = 'QUEUED') => {
      const item = (
        await one<{ id: string }>(
          `insert into distribution_items (owner_id, plan_id, channel_account_id, variant_id, variant_version_id, content_version_id, payload_json, payload_hash, requested_result, visibility, status)
           values ($1, $2, $3, $4, $5, $6, '{}'::jsonb, $7, 'mock_publish', 'private', $8) returning id`,
          [owner, plan, account, variant, vv, cv, (++n).toString(16).padStart(64, '0'), itemStatus],
        )
      ).id;
      const leased = state === 'LEASED';
      const j = (
        await one<{ id: string }>(
          `insert into jobs (owner_id, kind, item_id, payload_ref, state, attempt, lease_owner, lease_until, next_run_at, idempotency_key)
           values ($1, 'publish', $2::uuid, $2::text, $3, $4, $5, $6, now(), $7) returning id`,
          [owner, item, state, attempt, leased ? 'old-worker' : null, leased ? new Date(Date.now() - 1000).toISOString() : null, `publish:${item}:${randomUUID()}`],
        )
      ).id;
      for (const a of intents) {
        await client.query(`insert into send_intents (owner_id, job_id, attempt, intent_key, outcome) values ($1, $2, $3, $4, 'rejected')`, [owner, j, a, `${j}:${a}`]);
      }
      return j;
    };
    const j1 = await job('LEASED', 2, [1]);
    const j5 = await job('LEASED', 5, [1, 2, 3, 4]);
    const jGap = await job('LEASED', 3, [2]); // 예전 만료 복구가 번호를 건너뜀 → 최대 번호(2)로
    const jBlocked = await job('BLOCKED', 1, [], 'BLOCKED'); // lease 뒤 전송 전 보류(의도 없음) → 0
    const jSent = await job('RETRY_WAIT', 2, [1, 2], 'RETRY_WAIT'); // 의도가 있는 번호는 그대로
    const jDone = await job('FAILED', 5, [1, 2], 'FAILED'); // 끝난 작업은 그대로

    await applyTag(client, tags.find((t) => t.startsWith('0022'))!);
    await applyTag(client, TAG_0023);

    const attemptOf = async (id: string) => (await one<{ attempt: number }>(`select attempt from jobs where id = $1`, [id])).attempt;
    expect(await attemptOf(j1)).toBe(1);
    expect(await attemptOf(j5)).toBe(4);
    expect(await attemptOf(jGap)).toBe(2);
    expect(await attemptOf(jBlocked)).toBe(0);
    expect(await attemptOf(jSent)).toBe(2);
    expect(await attemptOf(jDone)).toBe(5);
    await client.close();
  });
});

describe('0023 앱 시험: 정규화 뒤 복구 + beginSend 가 다음 의도 번호를 쓴다', () => {
  const config = loadConfig({});
  const BODY = '# 해외 영업 첫 분기\n\n대리점과 재고 기준을 먼저 합의했다.';
  const registry = createMockAdapterRegistry();
  let db: Db;

  beforeAll(async () => {
    db = (await getDb(loadConfig())).db;
  });
  beforeEach(() => registry.mock.reset());
  afterAll(async () => {
    await closeDb();
  });

  const tick = (ownerId: string, offsetSec: number) =>
    runJobsTick(db, registry, { workerId: 'm23-w', config, ownerId, clock: () => new Date(Date.now() + offsetSec * 1000), random: () => 0.5, submitTimeoutMs: 500, maxJobs: 10 });

  it('실제 전송 1회 뒤 구버전 lease(attempt 2) → 0023 → 의도 #2 로 CONFIRMED; 실제 전송 4회 뒤 구버전 lease(attempt 5) → 0023 → 5번째 실제 시도(#5)로 CONFIRMED', async () => {
    const identity = `m23-${randomUUID().slice(0, 8)}@example.local`;
    const { ownerId } = await seed(db, { allowedIdentity: identity });
    const accounts = Object.fromEntries((await listChannelAccounts(db, ownerId)).map((a) => [a.platform, a.id])) as Record<Channel, string>;
    const executed = async () => {
      const { content } = await createContent(db, ownerId, { title: 'm23', body: BODY });
      const { variant } = await createVariantDraft(db, ownerId, content.id, { channel: 'threads', baseVersion: 1 });
      await setVariantLifecycle(db, ownerId, variant.id, { lifecycle: 'review', baseVersion: 1 });
      const { plan, items } = await createPlan(db, ownerId, { items: [{ variant_id: variant.id, channel_account_id: accounts.threads }] });
      await approveItems(db, ownerId, plan.id, { item_ids: [items[0]!.id], expected_hashes: { [items[0]!.id]: items[0]!.payloadHash }, confirm: true, purpose: 'mock_publish' });
      const ex = await executePlan(db, ownerId, plan.id, { commandKey: `m23-${randomUUID()}` }, config);
      return { itemId: items[0]!.id, jobId: ex.queued[0]!.job_id };
    };
    // b: 실제 전송 4회(일시 오류) → RETRY_WAIT, 의도 4개
    const b = await executed();
    await setMockScenario(db, ownerId, b.itemId, { scenario: 'transient' });
    for (const off of [0, 1000, 2000, 3000]) await tick(ownerId, off);
    const intents = (jobId: string) => db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, jobId)).orderBy(asc(schema.sendIntents.attempt));
    expect((await intents(b.jobId)).length).toBe(4);
    // c: 실제 전송 1회(지금 시각 tick — b 는 아직 재시도 시각 전이라 lease 되지 않음)
    const c = await executed();
    await setMockScenario(db, ownerId, c.itemId, { scenario: 'transient' });
    await tick(ownerId, 0);
    expect((await intents(b.jobId)).length).toBe(4);
    expect((await intents(c.jobId)).length).toBe(1);
    // 구버전 lease 흉내: LEASED + attempt 선증가(의도 없음) + 만료된 lease
    const past = new Date(Date.now() + 4500_000);
    for (const [id, attempt] of [
      [c.jobId, 2],
      [b.jobId, 5],
    ] as const) {
      await db.update(schema.jobs).set({ state: 'LEASED', attempt, leaseOwner: 'old-worker', leaseUntil: past }).where(eq(schema.jobs.id, id));
    }
    for (const stmt of sqlFor(TAG_0023)) await db.execute(sql.raw(stmt));
    const attemptOf = async (id: string) => (await db.select().from(schema.jobs).where(eq(schema.jobs.id, id)))[0]!.attempt;
    expect(await attemptOf(c.jobId)).toBe(1);
    expect(await attemptOf(b.jobId)).toBe(4);
    await setMockScenario(db, ownerId, c.itemId, { scenario: 'success' });
    await setMockScenario(db, ownerId, b.itemId, { scenario: 'success' });
    const r = await tick(ownerId, 5000);
    expect(r.recovered).toBe(2);
    for (const [id, n] of [
      [c.jobId, 2],
      [b.jobId, 5],
    ] as const) {
      const j = (await db.select().from(schema.jobs).where(eq(schema.jobs.id, id)))[0]!;
      expect(j, id).toMatchObject({ state: 'CONFIRMED', attempt: n, leaseExpiredBeforeIntent: 1 });
      expect((await intents(id)).map((i) => i.attempt)).toEqual(Array.from({ length: n }, (_, k) => k + 1));
    }
  });
});
