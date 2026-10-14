/**
 * LIVEP1-USERCONFIRM migration 0045: (1) 0044 까지의 DB 에 기존 결과(모의 MOCK·실제 VERIFIED·UNVERIFIED)가 있어도 적용되고 기존 행은 그대로
 * (새 열 confirmed_by·confirmed_at = null). (2) USER_CONFIRMED ⇔ 확인자 'owner'·확인 시각, 실제 결과·공식 링크·PUBLISHED 만, verified_at 없음(CHECK).
 * (3) publications_guard: 확인자·확인 시각 변경과 USER_CONFIRMED 로/에서의 확인 상태 변경을 거부(기존 규칙 그대로).
 * migration-0044 와 같은 방식(태그별 SQL 직접 적용, 결과·작업은 SQL 로). 외부 호출 없음.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createContent, createDb, createPlan, createVariantDraft, migrationsFolder, seed, setVariantLifecycle, type DbHandle } from '@cs/db';

type PGlite = DbHandle['client'];

const journal = JSON.parse(readFileSync(path.join(migrationsFolder(), 'meta/_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> };
const tags = journal.entries.map((e) => e.tag);
const sqlFor = (tag: string) =>
  readFileSync(path.join(migrationsFolder(), `${tag}.sql`), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
const TAG_0045 = tags.find((t) => t.startsWith('0045'))!;

async function applyTag(client: PGlite, tag: string) {
  await client.transaction(async (tx) => {
    for (const stmt of sqlFor(tag)) await tx.exec(stmt);
  });
}

describe('0045 migration: 사용자 확인(USER_CONFIRMED)', () => {
  it('기존 결과 위에 적용되고, 사용자 확인의 모양·불변을 DB 가 강제한다', async () => {
    expect(TAG_0045).toBe('0045_livep1_user_confirm');
    const handle = createDb({ driver: 'pglite', url: 'memory://' });
    const { client, db } = handle;
    for (const tag of tags.filter((t) => t < '0045')) await applyTag(client, tag);
    const q = async <T>(sql: string, params: unknown[] = []) => (await client.query<T>(sql, params)).rows;

    // ---- 0044 상태: 모의 계정 항목 + 실제 Threads 계정 항목, 작업·결과는 SQL ----
    const owner = (await seed(db, { allowedIdentity: 'm45@example.local' })).ownerId;
    const mockThreads = (await q<{ id: string }>(`select id from channel_accounts where owner_id = $1 and platform = 'threads' and kind = 'mock'`, [owner]))[0]!.id;
    const live = (
      await q<{ id: string }>(
        `insert into channel_accounts (owner_id, platform, kind, external_account_id, display_name, state, credential_state) values ($1, 'threads', 'live', '17841400000000045', '@m45', 'connected', 'linked') returning id`,
        [owner],
      )
    )[0]!.id;
    const reviewVariant = async (body: string) => {
      const { content } = await createContent(db, owner, { title: `m45 ${randomUUID().slice(0, 6)}`, body });
      const { variant } = await createVariantDraft(db, owner, content.id, { channel: 'threads', baseVersion: 1 });
      await setVariantLifecycle(db, owner, variant.id, { lifecycle: 'review', baseVersion: 1 });
      return variant.id;
    };
    const itemFor = async (account: string) => (await createPlan(db, owner, { items: [{ variant_id: await reviewVariant('글.'), channel_account_id: account }] })).items[0]!.id;
    const jobFor = async (item: string, state: string) =>
      (
        await q<{ id: string }>(
          `insert into jobs (owner_id, kind, item_id, payload_ref, state, attempt, next_run_at, idempotency_key) values ($1, 'publish', $2::uuid, $2::text, $3, 1, now(), $4) returning id`,
          [owner, item, state, `publish:${item}:${randomUUID()}`],
        )
      )[0]!.id;
    const mockItem = await itemFor(mockThreads);
    const liveItem = await itemFor(live);
    const liveItem2 = await itemFor(live);
    const mockJob = await jobFor(mockItem, 'CONFIRMED');
    const liveJob = await jobFor(liveItem, 'CONFIRMED');
    const liveJob2 = await jobFor(liveItem2, 'UNKNOWN');
    const link = 'https://www.threads.com/@m45/post/ABC';
    await client.query(
      `insert into publications (owner_id, item_id, job_id, external_id, permalink, result_kind, remote_visibility, verification, is_mock) values ($1, $2, $3, $4, null, 'PUBLISHED', 'unknown', 'MOCK', true)`,
      [owner, mockItem, mockJob, `mock:threads:${randomUUID()}`],
    );
    await client.query(
      `insert into publications (owner_id, item_id, job_id, external_id, permalink, result_kind, remote_visibility, verification, is_mock, verified_at) values ($1, $2, $3, 'threads:45', $4, 'PUBLISHED', 'unknown', 'VERIFIED', false, now())`,
      [owner, liveItem, liveJob, link],
    );
    await client.query(
      `insert into publications (owner_id, item_id, job_id, external_id, permalink, result_kind, remote_visibility, verification, is_mock) values ($1, $2, $3, 'threads:46', null, 'PUBLISHED', 'unknown', 'UNVERIFIED', false)`,
      [owner, liveItem, liveJob],
    );
    const before = await q(`select id, verification, is_mock, verified_at, permalink from publications order by id`);

    // ---- 0045 적용: 기존 행 그대로, 새 열 null ----
    await applyTag(client, TAG_0045);
    expect(await q(`select id, verification, is_mock, verified_at, permalink from publications order by id`)).toEqual(before);
    expect(await q(`select count(*)::int as n from publications where confirmed_by is not null or confirmed_at is not null`)).toEqual([{ n: 0 }]);

    const pub = (o: { item?: string; job?: string; external?: string; permalink?: string | null; kind?: string; verification?: string; isMock?: boolean; verifiedAt?: string | null; by?: string | null; at?: string | null }) =>
      client.query(
        `insert into publications (owner_id, item_id, job_id, external_id, permalink, result_kind, remote_visibility, verification, is_mock, verified_at, confirmed_by, confirmed_at)
         values ($1, $2, $3, $4, $5, $6, 'unknown', $7, $8, $9, $10, $11)`,
        [
          owner,
          o.item ?? liveItem2,
          o.job ?? liveJob2,
          o.external ?? `threads:${Math.floor(Math.random() * 1e9)}`,
          o.permalink === undefined ? link : o.permalink,
          o.kind ?? 'PUBLISHED',
          o.verification ?? 'USER_CONFIRMED',
          o.isMock ?? false,
          o.verifiedAt ?? null,
          o.by === undefined ? 'owner' : o.by,
          o.at === undefined ? new Date().toISOString() : o.at,
        ],
      );
    const now = new Date().toISOString();
    await expect(pub({ by: null, at: null })).rejects.toThrow(/publications_user_confirmed_chk/); // 확인자·시각 없음
    await expect(pub({ at: null })).rejects.toThrow(/publications_user_confirmed_chk/); // 시각 없음
    await expect(pub({ by: 'admin' })).rejects.toThrow(/publications_user_confirmed_chk/); // 'owner' 만
    await expect(pub({ verification: 'UNVERIFIED' })).rejects.toThrow(/publications_user_confirmed_chk/); // 확인자는 USER_CONFIRMED 일 때만
    await expect(pub({ verifiedAt: now })).rejects.toThrow(/publications_user_confirmed_shape_chk/); // VERIFIED 처럼 보이지 않게
    await expect(pub({ permalink: null })).rejects.toThrow(/publications_user_confirmed_shape_chk/); // 사용자가 연 링크 필수
    await expect(pub({ kind: 'MANUAL_REPORTED' })).rejects.toThrow(/publications_user_confirmed_shape_chk/);
    await expect(pub({ isMock: true, external: `mock:threads:${randomUUID()}`, permalink: null, item: mockItem, job: mockJob })).rejects.toThrow(/publications_/); // 모의는 불가
    await expect(pub({ verification: 'SELF_VERIFIED' })).rejects.toThrow(/publications_verification_chk|publications_user_confirmed_chk/);
    await pub({ external: 'threads:4701' });
    const uc = (await q<{ id: string; confirmed_by: string }>(`select id, confirmed_by from publications where external_id = 'threads:4701'`))[0]!;
    expect(uc.confirmed_by).toBe('owner');

    // ---- 불변(publications_guard) ----
    await expect(client.query(`update publications set verification = 'VERIFIED', verified_at = now() where id = $1`, [uc.id])).rejects.toThrow(/publications_guard/);
    await expect(client.query(`update publications set confirmed_at = now() + interval '1 day' where id = $1`, [uc.id])).rejects.toThrow(/publications_guard/);
    await expect(client.query(`update publications set confirmed_by = null where id = $1`, [uc.id])).rejects.toThrow(/publications_guard/);
    const unverified = (await q<{ id: string }>(`select id from publications where external_id = 'threads:46'`))[0]!.id;
    await expect(client.query(`update publications set verification = 'USER_CONFIRMED', confirmed_by = 'owner', confirmed_at = now() where id = $1`, [unverified])).rejects.toThrow(
      /publications_guard/,
    );
    await expect(client.query(`delete from publications where id = $1`, [uc.id])).rejects.toThrow(/publications_guard/);
    // 재확인 열(remote_visibility)은 그대로 바꿀 수 있다 — 기존 규칙
    await client.query(`update publications set remote_visibility = 'public' where id = $1`, [uc.id]);
    await client.query(`update publications set verification = 'VERIFIED', verified_at = now() where id = $1`, [unverified]);
    await handle.close();
  });
});
