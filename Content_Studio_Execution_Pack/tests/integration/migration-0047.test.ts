/**
 * FIX1-FULLREV(F9) migration 0047: send_intents 부분 색인 2개 — 실제 게시 사용 수 세기(liveApprovalUsage — 승인 기록별,
 * livePublishDailyUsage — owner 별 최근 24시간)가 beginSend 의 배타 advisory 잠금 아래에서 표 전체를 읽지 않게 한다.
 * (1) 0046 까지의 DB 에 모의·실제 전송 의도가 있어도 적용되고 행·사용 수는 그대로(질의는 바꾸지 않음).
 * (2) 두 색인이 기대한 정의(pg_indexes)로 생긴다. 0046 까지 실제 migrator 로 연 DB 를 지금 앱으로 열면 0047 만 더 적용된다(journal when 순서).
 * (3) 순차 읽기를 끈 트랜잭션에서 두 세기 함수(실제 코드)가 그 색인을 읽는다(pg_stat_get_xact_numscans) — 질의 술어가 부분 색인 술어를 함의한다.
 * (4) 묶음 호환: 형식 버전 그대로, 0046 까지의 목록으로 만든 묶음은 0047 앱에서 복원되고 0047 묶음은 0046 앱에서 기존 규칙대로 거부(schema_incompatible).
 * migration-0045 와 같은 방식(태그별 SQL 직접 적용, 작업·전송 의도는 SQL 로). 외부 호출 없음.
 */
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate as pgliteMigrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  commitRestore,
  createContent,
  createDb,
  createPlan,
  createRestorePreview,
  createTestDb,
  createVariantDraft,
  ensureOwner,
  exportOwner,
  liveApprovalUsage,
  livePublishDailyUsage,
  migrate,
  migrationsFolder,
  parseBundleZip,
  seed,
  setVariantLifecycle,
  type DbHandle,
} from '@cs/db';
import { BUNDLE_FORMAT_VERSION, buildBundle, parseBundle, readZip, writeZip, type BundleTables } from '@cs/domain';
import { LocalStorageAdapter } from '@cs/providers';

type PGlite = DbHandle['client'];

const journal = JSON.parse(readFileSync(path.join(migrationsFolder(), 'meta/_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> };
const tags = journal.entries.map((e) => e.tag);
const sqlFor = (tag: string) =>
  readFileSync(path.join(migrationsFolder(), `${tag}.sql`), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
const TAG_0047 = tags.find((t) => t.startsWith('0047'))!;
const REF_IDX = 'send_intents_live_ref_job_idx';
const DAILY_IDX = 'send_intents_live_owner_created_idx';
const HOUR = 3_600_000;

async function applyTag(client: PGlite, tag: string) {
  await client.transaction(async (tx) => {
    for (const stmt of sqlFor(tag)) await tx.exec(stmt);
  });
}

async function liveIndexes(client: PGlite) {
  return (
    await client.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'send_intents' and indexname in ($1, $2) order by indexname`,
      [DAILY_IDX, REF_IDX],
    )
  ).rows;
}

let handle: DbHandle;
let tmp: string;
let ownerA: string;
let ownerB: string;
const now = new Date();
const J: Record<string, string> = {};
type Usage = Awaited<ReturnType<typeof usageSnapshot>>;
let before: Usage;
let after: Usage;
let intentCount: { before: number; after: number };

async function usageSnapshot() {
  const db = handle.db;
  return {
    refA: await liveApprovalUsage(db, 'REF-A', null),
    refAThis: await liveApprovalUsage(db, 'REF-A', J.liveA1!),
    refB: await liveApprovalUsage(db, 'REF-B', J.liveA3!),
    refNone: await liveApprovalUsage(db, 'REF-NONE', null),
    dailyA: await livePublishDailyUsage(db, ownerA, null, now, 2),
    dailyAThis: await livePublishDailyUsage(db, ownerA, J.liveA2!, now),
    dailyB: await livePublishDailyUsage(db, ownerB, null, now),
  };
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-m47-'));
  expect(TAG_0047).toBe('0047_fullrev_fix1_live_intent_idx');
  handle = createDb({ driver: 'pglite', url: 'memory://' });
  const { client, db } = handle;
  for (const tag of tags.filter((t) => t < '0047')) await applyTag(client, tag);
  const q = async <T>(text: string, params: unknown[] = []) => (await client.query<T>(text, params)).rows;

  // ---- 0046 상태: owner 2명, 모의·실제 계정 항목, 끝난 작업과 전송 의도(실제 = live_approval_ref 있음)는 SQL ----
  ownerA = (await seed(db, { allowedIdentity: 'm47-a@example.local' })).ownerId;
  ownerB = (await seed(db, { allowedIdentity: 'm47-b@example.local' })).ownerId;
  const liveAccount = async (owner: string, ext: string) =>
    (
      await q<{ id: string }>(
        `insert into channel_accounts (owner_id, platform, kind, external_account_id, display_name, state, credential_state) values ($1, 'threads', 'live', $2, '@m47', 'connected', 'linked') returning id`,
        [owner, ext],
      )
    )[0]!.id;
  const mockThreadsA = (await q<{ id: string }>(`select id from channel_accounts where owner_id = $1 and platform = 'threads' and kind = 'mock'`, [ownerA]))[0]!.id;
  const itemFor = async (owner: string, account: string) => {
    const { content } = await createContent(db, owner, { title: `m47 ${randomUUID().slice(0, 6)}`, body: '글.' });
    const { variant } = await createVariantDraft(db, owner, content.id, { channel: 'threads', baseVersion: 1 });
    await setVariantLifecycle(db, owner, variant.id, { lifecycle: 'review', baseVersion: 1 });
    return (await createPlan(db, owner, { items: [{ variant_id: variant.id, channel_account_id: account }] })).items[0]!.id;
  };
  const mockItemA = await itemFor(ownerA, mockThreadsA);
  const liveItemA = await itemFor(ownerA, await liveAccount(ownerA, '17841400000000471'));
  const liveItemB = await itemFor(ownerB, await liveAccount(ownerB, '17841400000000472'));
  const job = async (owner: string, item: string) =>
    (
      await q<{ id: string }>(
        `insert into jobs (owner_id, kind, item_id, payload_ref, state, attempt, next_run_at, idempotency_key, done_at) values ($1, 'publish', $2::uuid, $2::text, 'CONFIRMED', 2, now(), $3, now()) returning id`,
        [owner, item, `publish:${item}:${randomUUID()}`],
      )
    )[0]!.id;
  const intent = (owner: string, jobId: string, attempt: number, details: Record<string, unknown>, agoMs: number) =>
    client.query(
      `insert into send_intents (owner_id, job_id, attempt, intent_key, created_at, submitted_at, outcome, sanitized_details) values ($1, $2, $3, $4, $5, $5, 'accepted', $6::jsonb)`,
      [owner, jobId, attempt, `${jobId}:${attempt}`, new Date(now.getTime() - agoMs).toISOString(), JSON.stringify(details)],
    );
  const live = (ref: string | null) => ({ mode: 'LIVE', adapter: 'live', adapter_id: 'live_threads', live_approval_ref: ref });
  J.mockA = await job(ownerA, mockItemA);
  J.liveA1 = await job(ownerA, liveItemA);
  J.liveA2 = await job(ownerA, liveItemA);
  J.liveA3 = await job(ownerA, liveItemA);
  J.liveA4 = await job(ownerA, liveItemA);
  J.liveA5 = await job(ownerA, liveItemA);
  J.liveB1 = await job(ownerB, liveItemB);
  await intent(ownerA, J.mockA, 1, { mode: 'MOCK', adapter: 'mock', adapter_id: 'mock_generic' }, 1 * HOUR); // 모의 — 어디서도 세지 않음
  await intent(ownerA, J.liveA1, 1, live('REF-A'), 3 * HOUR); // 같은 작업의 재시도 — 한 번만 센다
  await intent(ownerA, J.liveA1, 2, live('REF-A'), 2 * HOUR);
  await intent(ownerA, J.liveA2, 1, live('REF-A'), 1 * HOUR);
  await intent(ownerA, J.liveA3, 1, live('REF-B'), HOUR / 2);
  await intent(ownerA, J.liveA4, 1, live('REF-A'), 25 * HOUR); // 24시간 창 밖 — 승인 기록 수에는 들어가고 일일 수에는 빠짐
  await intent(ownerA, J.liveA5, 1, live(null), 1 * HOUR); // JSON null — 두 질의 모두 세지 않음(색인 술어도 같은 뜻)
  await intent(ownerB, J.liveB1, 1, live('REF-A'), 1 * HOUR); // 다른 owner — 승인 기록 수에는 들어가고 A 의 일일 수에는 빠짐
  intentCount = { before: (await q<{ n: number }>(`select count(*)::int as n from send_intents`))[0]!.n, after: -1 };
  before = await usageSnapshot();

  // ---- 0047 적용 ----
  await applyTag(client, TAG_0047);
  intentCount.after = (await q<{ n: number }>(`select count(*)::int as n from send_intents`))[0]!.n;
  after = await usageSnapshot();
});

afterAll(async () => {
  await handle?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('0047 migration: 실제 게시 사용 수 세기용 send_intents 부분 색인', () => {
  it('기존 모의·실제 전송 의도 위에 적용되고 행·사용 수(승인 기록별·owner 별 24시간)는 그대로', () => {
    expect(intentCount).toEqual({ before: 8, after: 8 });
    expect(after).toEqual(before);
    expect(after.refA.otherJobs).toBe(4); // A1(두 시도)·A2·A4(창 밖)·B1(다른 owner) — 모의·JSON null·REF-B 제외
    expect(after.refA.thisJobCounted).toBe(false);
    expect(after.refAThis).toEqual({ otherJobs: 3, thisJobCounted: true });
    expect(after.refB).toEqual({ otherJobs: 0, thisJobCounted: true });
    expect(after.refNone).toEqual({ otherJobs: 0, thisJobCounted: false });
    // owner A 최근 24시간: A1(마지막 시도 2h 전)·A2(1h)·A3(30m, REF-B — 승인 기록 값과 무관) = 3. 상한 2 → [3 − 2] 번째(A2) + 24h
    expect(after.dailyA.used).toBe(3);
    expect(after.dailyA.availableAt).toEqual(new Date(now.getTime() - 1 * HOUR + 24 * HOUR));
    expect(after.dailyAThis).toMatchObject({ used: 2, thisJobCounted: true });
    expect(after.dailyB).toMatchObject({ used: 1, thisJobCounted: false });
  });

  it('두 색인이 기대한 정의로 생긴다(pg_indexes — 부분 술어 = 실제 게시 전송 의도만)', async () => {
    const rows = await liveIndexes(handle.client);
    expect(rows).toEqual([
      {
        indexname: DAILY_IDX,
        indexdef: `CREATE INDEX ${DAILY_IDX} ON public.send_intents USING btree (owner_id, created_at) WHERE ((sanitized_details ->> 'live_approval_ref'::text) IS NOT NULL)`,
      },
      {
        indexname: REF_IDX,
        indexdef: `CREATE INDEX ${REF_IDX} ON public.send_intents USING btree (((sanitized_details ->> 'live_approval_ref'::text)), job_id) WHERE ((sanitized_details ->> 'live_approval_ref'::text) IS NOT NULL)`,
      },
    ]);
    // 전체 migration(openDb)으로 연 DB 에도 같은 정의
    const fresh = await createTestDb();
    try {
      expect(await liveIndexes(fresh.client)).toEqual(rows);
    } finally {
      await fresh.close();
    }
  });

  it('0046 까지 migrator 로 연 DB 를 지금 앱의 migrate(openDb 와 같음)로 다시 열면 0047 만 더 적용된다 — journal 의 when 이 0046 뒤(업그레이드 경로)', async () => {
    // 0046 까지만 있는 migration 폴더(이전 앱) — drizzle 기록(__drizzle_migrations)까지 실제 migrator 로 남긴다
    const old = path.join(tmp, 'drizzle-0046');
    cpSync(migrationsFolder(), old, { recursive: true });
    rmSync(path.join(old, `${TAG_0047}.sql`));
    rmSync(path.join(old, 'meta', '0047_snapshot.json'));
    const j = JSON.parse(readFileSync(path.join(old, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ tag: string; when: number }> };
    const when = (prefix: string) => j.entries.find((e) => e.tag.startsWith(prefix))!.when;
    // drizzle migrator 는 마지막으로 적용한 migration 의 시각보다 when 이 큰 것만 적용한다 — 작으면 0046 DB 에서 0047 을 조용히 건너뛴다
    expect(when('0047')).toBeGreaterThan(when('0046'));
    j.entries = j.entries.filter((e) => e.tag !== TAG_0047);
    writeFileSync(path.join(old, 'meta', '_journal.json'), JSON.stringify(j));
    const h = createDb({ driver: 'pglite', url: 'memory://' });
    try {
      await pgliteMigrate(h.db, { migrationsFolder: old });
      const applied = async () => (await h.client.query<{ n: number }>(`select count(*)::int as n from drizzle.__drizzle_migrations`)).rows[0]!.n;
      expect(await applied()).toBe(tags.length - 1);
      expect(await liveIndexes(h.client)).toEqual([]);
      await migrate(h);
      expect(await applied()).toBe(tags.length);
      expect((await liveIndexes(h.client)).map((r) => r.indexname)).toEqual([DAILY_IDX, REF_IDX]);
    } finally {
      await h.close();
    }
  });

  it('순차 읽기를 끄면 두 세기 함수(실제 질의)가 각자의 부분 색인을 읽는다 — 질의 술어가 색인 술어를 함의', async () => {
    const scans = await handle.db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const n = async (name: string) =>
        ((await tx.execute(sql`select pg_stat_get_xact_numscans(${name}::regclass)::int as n`)).rows as Array<{ n: number }>)[0]!.n;
      const r0 = await n(REF_IDX);
      const ref = await liveApprovalUsage(tx, 'REF-A', null);
      const r1 = await n(REF_IDX);
      const d0 = await n(DAILY_IDX);
      const daily = await livePublishDailyUsage(tx, ownerA, null, now);
      const d1 = await n(DAILY_IDX);
      return { ref, daily, refScans: r1 - r0, dailyScans: d1 - d0 };
    });
    // 색인을 써도 결과는 같다
    expect(scans.ref).toEqual(after.refA);
    expect(scans.daily.used).toBe(3);
    expect(scans.refScans).toBeGreaterThan(0);
    expect(scans.dailyScans).toBeGreaterThan(0);
  });

  it('묶음 호환: 형식 버전 그대로 — 0046 묶음은 0047 앱에서 복원, 0047 묶음은 0046 앱에서 기존 규칙대로 거부(schema_incompatible)', async () => {
    const exported = await exportOwner(handle.db, new LocalStorageAdapter(path.join(tmp, 'assets')), ownerA, { outDir: path.join(tmp, 'exp') });
    const zip47 = new Uint8Array(readFileSync(exported.zipPath));
    const parsed = await parseBundleZip(zip47);
    expect(parsed.manifest.format_version).toBe(BUNDLE_FORMAT_VERSION);
    expect(parsed.manifest.schema_migrations).toEqual(tags);
    expect(parsed.manifest.schema_migrations.at(-1)).toBe(TAG_0047);
    expect(parsed.tables.send_intents).toHaveLength(7); // owner A 의 전송 의도(모의 1 + 실제 6) — 색인은 묶음에 들어가지 않는다

    // 0046 앱(목록 끝이 0046)은 0047 묶음을 거부 — 다른 migration 과 같은 기존 규칙
    expect(() => parseBundle(readZip(zip47), { migrations: tags.filter((t) => t < '0047') })).toThrow(expect.objectContaining({ code: 'schema_incompatible' }));

    // 0046 까지의 목록으로 만든 묶음(같은 표) → 0047 앱에서 미리보기·복원
    const zip46 = writeZip(
      buildBundle({
        exportId: randomUUID(),
        exportedAt: new Date().toISOString(),
        appVersion: parsed.manifest.app_version,
        migrations: parsed.manifest.schema_migrations.filter((m) => m < '0047'),
        owner: { id: parsed.manifest.owner.id, identityMasked: parsed.manifest.owner.identity_masked },
        tables: structuredClone(parsed.tables) as BundleTables,
        assetBytes: new Map(parsed.assetBytes),
      }).entries,
    );
    expect((await parseBundleZip(zip46)).manifest.schema_migrations.at(-1)).toBe(tags.find((t) => t.startsWith('0046')));
    const h = await createTestDb();
    try {
      const target = (await ensureOwner(h.db, 'restore-m47@example.local')).id;
      const restoresDir = path.join(tmp, 'restores');
      const p = await createRestorePreview(h.db, target, zip46, { restoresDir, source: 'upload' });
      const r = await commitRestore(h.db, new LocalStorageAdapter(path.join(tmp, 'assets-restore')), target, p.restoreId, { mode: 'empty_only', confirm: true, restoresDir });
      expect(r.restored.jobs).toBe(6);
      expect(r.restored.distribution_items).toBe(2);
    } finally {
      await h.close();
    }
  });
});
