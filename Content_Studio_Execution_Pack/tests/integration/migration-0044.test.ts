/**
 * LIVE-P1(결정 D38 1단계) migration 0044: (1) 0043 까지의 DB 에 기존 모양의 모의 결과·모의 단계가 있어도 0044 가 적용된다(기존 행 그대로).
 * (2) 실제 Threads 단계 ID·publish_attempt·실제 결과 형식 CHECK, (3) INSERT 트리거 remote_steps_account_guard·publications_account_guard
 * (모의 ⇔ 모의 계정, 실제 ⇔ 실제 Threads 계정). migration-0033 과 같은 방식(태그별 SQL 직접 적용). 외부 호출 없음, 실제 토큰 없음.
 * LIVEP1-USERCONFIRM: 0043 상태의 모의 결과는 작업 처리기 대신 SQL 로 넣는다(현재 처리기는 0045 열을 쓴다).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  approveItems,
  createContent,
  createDb,
  createPlan,
  createVariantDraft,
  executePlan,
  migrationsFolder,
  seed,
  setVariantLifecycle,
  type DbHandle,
} from '@cs/db';
import { loadConfig } from '@cs/domain';

type PGlite = DbHandle['client'];

const journal = JSON.parse(readFileSync(path.join(migrationsFolder(), 'meta/_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> };
const tags = journal.entries.map((e) => e.tag);
const sqlFor = (tag: string) =>
  readFileSync(path.join(migrationsFolder(), `${tag}.sql`), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
const TAG_0044 = tags.find((t) => t.startsWith('0044'))!;

async function applyTag(client: PGlite, tag: string) {
  await client.transaction(async (tx) => {
    for (const stmt of sqlFor(tag)) await tx.exec(stmt);
  });
}

describe('0044 migration: 실제 Threads 게시 결과·단계', () => {
  it('기존 모의 결과·단계 위에 적용되고, 실제/모의 ID·결과 형식·계정 kind 규칙을 DB 가 강제한다', async () => {
    expect(TAG_0044).toBe('0044_livep1_threads_live');
    const handle = createDb({ driver: 'pglite', url: 'memory://' });
    const { client, db } = handle;
    for (const tag of tags.filter((t) => t < '0044')) await applyTag(client, tag);
    const q = async <T>(sql: string, params: unknown[] = []) => (await client.query<T>(sql, params)).rows;

    // ---- 0043 상태: 모의 계정으로 끝까지(모의 결과·전송 의도) + 모의 단계 행 ----
    const owner = (await seed(db, { allowedIdentity: 'm44@example.local' })).ownerId;
    const mockThreads = (await q<{ id: string }>(`select id from channel_accounts where owner_id = $1 and platform = 'threads' and kind = 'mock'`, [owner]))[0]!.id;
    const reviewVariant = async (body: string) => {
      const { content } = await createContent(db, owner, { title: `m44 ${randomUUID().slice(0, 6)}`, body });
      const { variant } = await createVariantDraft(db, owner, content.id, { channel: 'threads', baseVersion: 1 });
      await setVariantLifecycle(db, owner, variant.id, { lifecycle: 'review', baseVersion: 1 });
      return variant.id;
    };
    const mockPlan = await createPlan(db, owner, { items: [{ variant_id: await reviewVariant('모의 글.'), channel_account_id: mockThreads }] });
    const mockItem = mockPlan.items[0]!;
    await approveItems(db, owner, mockPlan.plan.id, { item_ids: [mockItem.id], expected_hashes: { [mockItem.id]: mockItem.payloadHash }, confirm: true, purpose: 'mock_publish' });
    await executePlan(db, owner, mockPlan.plan.id, { commandKey: `m44-${randomUUID()}` }, loadConfig({}));
    // LIVEP1-USERCONFIRM(0045): 작업 처리기(현재 코드)는 0045 의 publications 열(confirmed_by·confirmed_at)을 쓰므로 0043 상태 DB 에서는 돌릴 수 없다 —
    // 처리기가 남기던 것과 같은 모양의 모의 결과(CONFIRMED 작업·accepted 전송 의도·MOCK 결과)를 SQL 로 직접 넣는다(0033 시험과 같은 방식).
    const mockJob = (await q<{ id: string }>(`select id from jobs where item_id = $1`, [mockItem.id]))[0]!.id;
    await client.query(`update jobs set state = 'CONFIRMED', attempt = 1, done_at = now() where id = $1`, [mockJob]);
    const mockIntent = (
      await q<{ id: string }>(
        `insert into send_intents (owner_id, job_id, attempt, intent_key, outcome, submitted_at, remote_external_id, sanitized_details) values ($1, $2, 1, $3, 'accepted', now(), $4, '{"adapter_id":"mock_generic"}'::jsonb) returning id`,
        [owner, mockJob, `${mockJob}:1`, `mock:threads:${randomUUID()}`],
      )
    )[0]!.id;
    await client.query(
      `insert into publications (owner_id, item_id, job_id, external_id, permalink, result_kind, remote_visibility, verification, is_mock) values ($1, $2, $3, $4, null, 'PUBLISHED', 'unknown', 'MOCK', true)`,
      [owner, mockItem.id, mockJob, `mock:threads:${randomUUID()}`],
    );
    expect((await q<{ state: string }>(`select state from jobs where id = $1`, [mockJob]))[0]!.state).toBe('CONFIRMED');
    const step = (kind: string, idx: number, remoteId: string, status: string, job = mockJob, intent = mockIntent, item = mockItem.id, postIndex = 0) =>
      client.query(
        `insert into remote_steps (owner_id, job_id, intent_id, item_id, step_index, kind, post_index, remote_id, status) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [owner, job, intent, item, idx, kind, postIndex, remoteId, status],
      );
    await step('container', 0, `mockthr_ct_${randomUUID()}`, 'finished');
    await step('publish', 1, `mockthr_post_${randomUUID()}`, 'published');
    const before = await q<{ n: number }>(`select (select count(*) from publications)::int + (select count(*) from remote_steps)::int as n`);

    // ---- 0044 적용: 기존 행 그대로 ----
    await applyTag(client, TAG_0044);
    expect(await q<{ n: number }>(`select (select count(*) from publications)::int + (select count(*) from remote_steps)::int as n`)).toEqual(before);
    expect((await q<{ is_mock: boolean; verification: string }>(`select is_mock, verification from publications where item_id = $1`, [mockItem.id]))[0]).toEqual({ is_mock: true, verification: 'MOCK' });

    // ---- 실제 Threads 계정 항목(작업·의도는 직접 넣는다 — 실행 게이트·연결 정보는 다른 시험이 본다) ----
    const live = (
      await q<{ id: string }>(
        `insert into channel_accounts (owner_id, platform, kind, external_account_id, display_name, state, credential_state) values ($1, 'threads', 'live', '17841400000000044', '@m44', 'connected', 'linked') returning id`,
        [owner],
      )
    )[0]!.id;
    const livePlan = await createPlan(db, owner, { items: [{ variant_id: await reviewVariant('실제 글.'), channel_account_id: live }] });
    const liveItem = livePlan.items[0]!;
    expect(liveItem).toMatchObject({ requestedResult: 'public_publish', visibility: 'public' });
    const liveJob = (
      await q<{ id: string }>(
        `insert into jobs (owner_id, kind, item_id, payload_ref, state, attempt, next_run_at, idempotency_key) values ($1, 'publish', $2::uuid, $2::text, 'SENDING', 1, now(), $3) returning id`,
        [owner, liveItem.id, `publish:${liveItem.id}:m44`],
      )
    )[0]!.id;
    const liveIntent = (
      await q<{ id: string }>(`insert into send_intents (owner_id, job_id, attempt, intent_key, outcome, sanitized_details) values ($1, $2, 1, $3, 'pending', '{}'::jsonb) returning id`, [
        owner,
        liveJob,
        `${liveJob}:1`,
      ])
    )[0]!.id;
    const liveStep = (kind: string, idx: number, remoteId: string, status: string, postIndex = 0) => step(kind, idx, remoteId, status, liveJob, liveIntent, liveItem.id, postIndex);

    // 실제 단계: 종류별 접두 + 숫자만, 실제 Threads 계정 작업에만
    await liveStep('container', 0, 'threads:ct:44', 'finished');
    await liveStep('publish_attempt', 1, 'threads:pa:44', 'created');
    await liveStep('publish', 2, 'threads:post:45', 'published');
    await expect(liveStep('publish_attempt', 3, 'threads:pa:44', 'created', 1)).rejects.toThrow(/remote_steps_remote_id_uq/); // 같은 컨테이너로 두 번 게시 시도 불가
    await expect(liveStep('container', 4, 'threads:post:46', 'created', 1)).rejects.toThrow(/remote_steps_remote_id_chk/); // 종류와 접두가 다름
    await expect(liveStep('container', 4, 'threads:ct:abc', 'created', 1)).rejects.toThrow(/remote_steps_remote_id_chk/); // 숫자 아님
    await expect(liveStep('publish_attempt', 4, 'threads:pa:47', 'finished', 1)).rejects.toThrow(/remote_steps_kind_status_chk/);
    await expect(liveStep('container', 4, `mockthr_ct_${randomUUID()}`, 'created', 1)).rejects.toThrow(/remote_steps_account_guard/); // 모의 ID → 실제 계정
    await expect(step('container', 9, 'threads:ct:48', 'created', mockJob, mockIntent, mockItem.id, 1)).rejects.toThrow(/remote_steps_account_guard/); // 실제 ID → 모의 계정
    await expect(step('publish_attempt', 9, `mockthr_pa_${randomUUID()}`, 'created', mockJob, mockIntent, mockItem.id, 1)).rejects.toThrow(/remote_steps_remote_id_chk/); // 시도 표식은 실제만

    // 결과: 실제 결과는 threads:<숫자>·공식 링크·VERIFIED 는 verified_at, 계정 kind 와 맞아야
    const pub = (item: string, job: string, external: string, permalink: string | null, verification: string, isMock: boolean, verifiedAt: string | null) =>
      client.query(
        `insert into publications (owner_id, item_id, job_id, external_id, permalink, result_kind, remote_visibility, verification, is_mock, verified_at) values ($1, $2, $3, $4, $5, 'PUBLISHED', 'unknown', $6, $7, $8)`,
        [owner, item, job, external, permalink, verification, isMock, verifiedAt],
      );
    await expect(pub(liveItem.id, liveJob, 'threads:abc', null, 'UNVERIFIED', false, null)).rejects.toThrow(/publications_real_external_chk/);
    await expect(pub(liveItem.id, liveJob, 'threads:45', 'https://evil.example/post/1', 'UNVERIFIED', false, null)).rejects.toThrow(/publications_real_permalink_chk/);
    await expect(pub(liveItem.id, liveJob, 'threads:45', 'http://www.threads.com/@x/post/1', 'UNVERIFIED', false, null)).rejects.toThrow(/publications_real_permalink_chk/);
    await expect(pub(liveItem.id, liveJob, 'threads:45', null, 'VERIFIED', false, null)).rejects.toThrow(/publications_verified_at_chk/);
    await expect(pub(liveItem.id, liveJob, `mock:threads:${randomUUID()}`, null, 'MOCK', true, null)).rejects.toThrow(/publications_account_guard/); // 모의 결과 → 실제 계정
    await expect(pub(mockItem.id, mockJob, 'threads:45', null, 'UNVERIFIED', false, null)).rejects.toThrow(/publications_account_guard/); // 실제 결과 → 모의 계정
    await pub(liveItem.id, liveJob, 'threads:45', 'https://www.threads.com/@m44/post/ABC', 'VERIFIED', false, new Date().toISOString());
    await pub(liveItem.id, liveJob, 'threads:46', null, 'UNVERIFIED', false, null);
    expect((await q<{ n: number }>(`select count(*)::int as n from publications where item_id = $1 and not is_mock`, [liveItem.id]))[0]!.n).toBe(2);
    await handle.close();
  });
});
