/**
 * FIX4-FULLREV(S3, 사용자 결정 2026-10-23 "다 권고 사항으로 진행해줘" · FULLREV1 인계 FIX round 3 "남은 것" 3): 배포 항목은 계정 없이 남을 수 없다 —
 * 화면 자료형(PlanItemDetail.account: … | null)의 null 은 방어 기본값일 뿐 저장된 기록으로는 생기지 않는다. 그 사실을 DB 규칙으로 고정한다.
 *  - distribution_items.channel_account_id NOT NULL · 같은 owner FK(distribution_items_account_same_owner_fk) ON DELETE restrict
 *  - 항목의 channel_account_id 는 바꿀 수 없고 항목은 지울 수 없다(distribution_items_snapshot_immutable 트리거)
 *  - 계정 kind 는 mock·live 뿐(channel_accounts_kind_chk) — "모르는 kind" 도 저장되지 않는다
 *  - 다른 owner 의 계정·없는 계정을 가리키는 항목은 들어가지 않는다(같은 owner FK)
 * 그래서 계정이 없는 항목의 모의·실제 문구(apps/web itemRecordLive null → 조심스러운 문구)는 화면 단위 시험(plan-detail-render·distribution·record-labels)만으로
 * 고정하고, 여기서는 그 상태가 저장될 수 없음을 본다. 모의 계정만 — **네트워크 호출 0**(fetch 0 확인).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDb, createContent, createVariantDraft, ensureOwner, getDb, getPlanDetail, listChannelAccounts, schema, seed, setVariantLifecycle, type Db } from '@cs/db';
import { loadConfig } from '@cs/domain';
import { POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { cookieHeader, jsonPost, login } from './helpers';

const A = 'owner@example.local';
const KEY = randomBytes(32).toString('base64');

let db: Db;
let owner: string;
let token: string;
let tmp: string;
let seedThreads: string;
let fetchCalls = 0;

/** 실패한 SQL 의 원래 오류 글(drizzle 이 감싼 cause 포함) — 어느 규칙이 막았는지 본다 */
async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const cause = (e as { cause?: unknown }).cause;
    return `${String(e)} ${cause ? String(cause) : ''} ${(cause as { code?: string } | undefined)?.code ?? ''}`;
  }
  throw new Error('거부되지 않았습니다');
}

/** 원고 → Threads 파생본(review) → 계획(항목 1개, 모의 계정) */
async function planned(accountId: string): Promise<{ planId: string; itemId: string }> {
  const { content } = await createContent(db, owner, { title: `FIX4 S3 ${randomUUID().slice(0, 6)}`, body: '계정이 꼭 있어야 하는 항목.' });
  const { variant } = await createVariantDraft(db, owner, content.id, { channel: 'threads', baseVersion: 1 });
  await setVariantLifecycle(db, owner, variant.id, { lifecycle: 'review', baseVersion: 1 });
  const res = await plansPOST(jsonPost('/api/distribution-plans', { items: [{ variant_id: variant.id, channel_account_id: accountId }] }, cookieHeader(token)));
  expect(res.status, await res.clone().text()).toBe(201);
  const p = (await res.json()) as { plan: { id: string }; items: Array<{ id: string }> };
  return { planId: p.plan.id, itemId: p.items[0]!.id };
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-fix4-s3-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  vi.stubEnv('SECRETS_MASTER_KEY', KEY);
  vi.stubEnv('SECRETS_KEY_VERSION', '1');
  vi.stubGlobal('fetch', async () => {
    fetchCalls++;
    throw new Error('FIX4 S3 시험: 네트워크 호출 금지');
  });
  db = (await getDb(loadConfig())).db;
  owner = (await seed(db, { allowedIdentity: A })).ownerId;
  token = await login(A);
  seedThreads = (await listChannelAccounts(db, owner)).find((a) => a.platform === 'threads' && a.kind === 'mock')!.id;
}, 120_000);
afterAll(async () => {
  expect(fetchCalls).toBe(0);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(tmp, { recursive: true, force: true });
  await closeDb();
});

describe('FIX4-FULLREV(S3): 배포 항목은 계정 없이 남을 수 없다(DB 규칙) — 계획 상세의 account 는 언제나 있다', () => {
  it('항목이 가리키는 계정은 지울 수 없다(같은 owner FK ON DELETE restrict) — 계정·항목 그대로, 계획 상세의 account 도 그대로', async () => {
    const [acc] = await db
      .insert(schema.channelAccounts)
      .values({ ownerId: owner, platform: 'threads', kind: 'mock', externalAccountId: `mock:threads:${randomUUID()}`, displayName: 'MOCK Threads FIX4 S3', state: 'mock_ready' })
      .returning();
    const x = await planned(acc!.id);
    const err = await rejection(db.delete(schema.channelAccounts).where(eq(schema.channelAccounts.id, acc!.id)));
    expect(err).toContain('violates RESTRICT setting of foreign key constraint "distribution_items_account_same_owner_fk"');
    expect(err).toContain('23001');
    expect(await db.select().from(schema.channelAccounts).where(eq(schema.channelAccounts.id, acc!.id))).toHaveLength(1);
    const d = (await getPlanDetail(db, owner, x.planId))!;
    expect(d.items.map((i) => i.account?.id)).toEqual([acc!.id]);
    expect(d.items.every((i) => i.account !== null && ['mock', 'live'].includes(i.account.kind))).toBe(true);
    // 계정 없는 계정 행만 지우는 것은 지금처럼 된다(규칙이 계정 삭제 자체를 막는 것은 아님)
    const [free] = await db
      .insert(schema.channelAccounts)
      .values({ ownerId: owner, platform: 'threads', kind: 'mock', externalAccountId: `mock:threads:${randomUUID()}`, displayName: 'MOCK Threads FIX4 S3 free', state: 'mock_ready' })
      .returning();
    await db.delete(schema.channelAccounts).where(eq(schema.channelAccounts.id, free!.id));
    expect(await db.select().from(schema.channelAccounts).where(eq(schema.channelAccounts.id, free!.id))).toHaveLength(0);
  });

  it('항목의 계정을 바꾸거나 비우거나 항목을 지울 수 없다(스냅샷 트리거·NOT NULL)', async () => {
    const x = await planned(seedThreads);
    const [other] = await db
      .insert(schema.channelAccounts)
      .values({ ownerId: owner, platform: 'threads', kind: 'mock', externalAccountId: `mock:threads:${randomUUID()}`, displayName: 'MOCK Threads FIX4 S3 other', state: 'mock_ready' })
      .returning();
    const moved = await rejection(db.execute(sql`update distribution_items set channel_account_id = ${other!.id}::uuid where id = ${x.itemId}::uuid`));
    expect(moved).toContain('distribution_items_snapshot_immutable');
    const nulled = await rejection(db.execute(sql`update distribution_items set channel_account_id = null where id = ${x.itemId}::uuid`));
    expect(nulled).toMatch(/distribution_items_snapshot_immutable|23502/);
    const deleted = await rejection(db.execute(sql`delete from distribution_items where id = ${x.itemId}::uuid`));
    expect(deleted).toContain('distribution_items_snapshot_immutable');
    const [row] = await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, x.itemId));
    expect(row!.channelAccountId).toBe(seedThreads);
  });

  it('없는 계정·다른 owner 의 계정·계정 없음(NULL)을 가리키는 항목은 들어가지 않는다', async () => {
    const x = await planned(seedThreads);
    const [src] = await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, x.itemId));
    const copy = (channelAccountId: string | null) => ({ ...src!, id: randomUUID(), payloadHash: randomBytes(32).toString('hex'), channelAccountId: channelAccountId as string });
    const missing = await rejection(db.insert(schema.distributionItems).values(copy(randomUUID())));
    expect(missing).toContain('distribution_items_account_same_owner_fk');
    expect(missing).toContain('23503');
    const nulled = await rejection(db.insert(schema.distributionItems).values(copy(null)));
    expect(nulled).toContain('23502');
    // 다른 owner 의 계정(같은 owner FK — id 만 맞아도 owner 가 다르면 거부)
    const otherOwner = await ensureOwner(db, `fix4-s3-other-${randomUUID().slice(0, 6)}@example.local`);
    const [foreign] = await db
      .insert(schema.channelAccounts)
      .values({ ownerId: otherOwner.id, platform: 'threads', kind: 'mock', externalAccountId: `mock:threads:${randomUUID()}`, displayName: 'MOCK 다른 owner', state: 'mock_ready' })
      .returning();
    const cross = await rejection(db.insert(schema.distributionItems).values(copy(foreign!.id)));
    expect(cross).toContain('distribution_items_account_same_owner_fk');
    expect((await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.planId, x.planId))).map((i) => i.id)).toEqual([x.itemId]);
  });

  it('계정 kind 는 mock·live 뿐 — 모르는 kind 는 저장되지 않는다(channel_accounts_kind_chk)', async () => {
    const bad = await rejection(
      db.insert(schema.channelAccounts).values({ ownerId: owner, platform: 'threads', kind: 'unknown', externalAccountId: `x:${randomUUID()}`, displayName: '모르는 kind', state: 'disconnected' }),
    );
    expect(bad).toContain('channel_accounts_kind_chk');
    const changed = await rejection(db.execute(sql`update channel_accounts set kind = 'other' where id = ${seedThreads}::uuid`));
    expect(changed).toContain('channel_accounts_kind_chk');
    expect((await listChannelAccounts(db, owner)).find((a) => a.id === seedThreads)!.kind).toBe('mock');
  });
});
