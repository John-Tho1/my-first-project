/**
 * FIX-UICLEAN(오래된 "배포 작업(MOCK)" 제목): 운영 화면의 작업 제목 태그는 작업 기록(항목 계정 kind)에서 센다 — opsSnapshot().jobs.byKind.
 * 실제 계정 작업은 실제 어댑터가 없는 블로그 실제 계정 행을 직접 넣어 만든다(외부 호출 없음 — 작업 처리기를 돌리지 않는다, m3-hardening 과 같은 방식).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  approveItems,
  closeDb,
  createContent,
  createPlan,
  createVariantDraft,
  executePlan,
  getDb,
  listChannelAccounts,
  opsSnapshot,
  schema,
  seed,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { loadConfig, type Channel } from '@cs/domain';
import { opsJobsTag } from '../../apps/web/lib/record-labels';

const config = loadConfig({});
let db: Db;
let tmp: string;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-ops-kind-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  db = (await getDb(loadConfig())).db;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

async function reviewVariant(ownerId: string, channel: Channel) {
  const { content } = await createContent(db, ownerId, { title: `작업 종류 ${channel}`, body: '# 제목\n\n본문 한 줄.' });
  const { variant } = await createVariantDraft(db, ownerId, content.id, { channel, baseVersion: 1 });
  await setVariantLifecycle(db, ownerId, variant.id, { lifecycle: 'review', baseVersion: 1 });
  return variant.id;
}

async function executedJob(ownerId: string, channel: Channel, accountId: string) {
  const variantId = await reviewVariant(ownerId, channel);
  const { plan, items } = await createPlan(db, ownerId, { items: [{ variant_id: variantId, channel_account_id: accountId }] });
  await approveItems(db, ownerId, plan.id, { item_ids: [items[0]!.id], expected_hashes: { [items[0]!.id]: items[0]!.payloadHash }, confirm: true, purpose: 'mock_publish' });
  await executePlan(db, ownerId, plan.id, { commandKey: `kind-${randomUUID()}` }, config);
}

describe('opsSnapshot().jobs.byKind — 작업 기록의 계정 종류', () => {
  it('작업 없음 → 0/0(태그 없음) · 모의 작업 → mock 만(MOCK) · 실제 계정 작업이 생기면 live 가 세어져 MOCK 이 아니다', async () => {
    const identity = `ops-kind-${randomUUID().slice(0, 8)}@example.local`;
    const { ownerId } = await seed(db, { allowedIdentity: identity });
    const accounts = Object.fromEntries((await listChannelAccounts(db, ownerId)).map((a) => [a.platform, a.id])) as Record<Channel, string>;

    let s = await opsSnapshot(db, ownerId, config);
    expect(s.jobs.byKind).toEqual({ mock: 0, live: 0 });
    expect(opsJobsTag(s.jobs.byKind)).toBeNull();

    await executedJob(ownerId, 'threads', accounts.threads);
    s = await opsSnapshot(db, ownerId, config);
    expect(s.jobs.byKind).toEqual({ mock: 1, live: 0 });
    expect(opsJobsTag(s.jobs.byKind)).toEqual({ text: 'MOCK', warn: true });

    const [live] = await db
      .insert(schema.channelAccounts)
      .values({ ownerId, platform: 'blog', kind: 'live', externalAccountId: `blog-live-${randomUUID()}`, displayName: '실제 계정(시험 행)', state: 'connected' })
      .returning();
    // 실제 계정 작업: 계획 항목은 실제 흐름(createPlan)으로 만들고, 작업 행은 끝난 상태(CANCELED)로 직접 넣는다 — 실제 계정은 연결 정보 없이 실행되지
    // 않고, 이 시험은 "작업 기록의 계정 종류를 센다"만 본다(작업 처리기를 돌리지 않음 — 외부 호출 없음).
    const liveVariant = await reviewVariant(ownerId, 'blog');
    const { items: liveItems } = await createPlan(db, ownerId, {
      items: [{ variant_id: liveVariant, channel_account_id: live!.id, requested_result: 'upload_private', visibility: 'private' }],
    });
    await db.insert(schema.jobs).values({
      ownerId,
      kind: 'publish',
      itemId: liveItems[0]!.id,
      payloadRef: liveItems[0]!.payloadHash,
      state: 'CANCELED',
      nextRunAt: new Date(),
      idempotencyKey: `ops-kind-live-${randomUUID()}`,
      doneAt: new Date(),
    });
    s = await opsSnapshot(db, ownerId, config);
    expect(s.jobs.byKind).toEqual({ mock: 1, live: 1 });
    expect(s.jobs.total).toBe(2);
    expect(opsJobsTag(s.jobs.byKind)).toEqual({ text: '실제 게시 작업 1개 포함', warn: true });
  });

  it('다른 owner 의 작업은 세지 않는다', async () => {
    const { ownerId } = await seed(db, { allowedIdentity: `ops-kind-other-${randomUUID().slice(0, 8)}@example.local` });
    expect((await opsSnapshot(db, ownerId, config)).jobs.byKind).toEqual({ mock: 0, live: 0 });
  });
});
