/**
 * FIX-T10(Codex review-T10) — 지적 사항 재현·회귀 시험:
 * P0 복원이 UNKNOWN 을 BLOCKED 로 덮어씀 / P1 승인 vs 계정 상태 변경 경합 / P1 계획 생성 INSERT 의 FK 잠금 순서 /
 * P1 복원 payload 구조 검증 / D19-b(D20) assets.checksum·variant_assets 트리거(0019).
 * PGlite 는 연결 하나라 트랜잭션이 직렬화된다 — "경합" 시험은 두 순서의 사후 조건과 잠금 흔적(xmax)만 확인한다. 실제 PostgreSQL 동시 실행은 not_run.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, count, eq, sql } from 'drizzle-orm';
import {
  approveItems,
  closeDb,
  commitRestore,
  createContent,
  createPlan,
  createRestorePreview,
  createTestDb,
  createVariantDraft,
  ensureOwner,
  executePlan,
  exportOwner,
  getDb,
  insertAsset,
  listChannelAccounts,
  parseBundleZip,
  retryItem,
  runJobsTick,
  schema,
  seed,
  setChannelAccountState,
  setMockScenario,
  setVariantAssets,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { buildAssetKey, buildBundle, loadConfig, payloadHash, writeZip, type BundleTables, type Channel, type ParsedBundle } from '@cs/domain';
import { createMockAdapterRegistry, LocalStorageAdapter, MockChannelAdapter, MockChannelAdapterRegistry } from '@cs/providers';

const config = loadConfig({});
const BODY = '# 해외 영업 첫 분기\n\n대리점과 재고 기준을 먼저 합의했다.\n\n가격표는 마지막에 확정했다.';

let db: Db;
let tmp: string;
const registry = createMockAdapterRegistry();

interface Owner {
  id: string;
  accounts: Record<Channel, string>;
}

async function newOwner(): Promise<Owner> {
  const identity = `fixt10-${randomUUID().slice(0, 8)}@example.local`;
  const { ownerId } = await seed(db, { allowedIdentity: identity });
  const accounts = Object.fromEntries((await listChannelAccounts(db, ownerId)).map((a) => [a.platform, a.id])) as Record<Channel, string>;
  return { id: ownerId, accounts };
}

async function putAsset(ownerId: string, mime = 'image/png') {
  const id = randomUUID();
  const bytes = new TextEncoder().encode(`${mime}:${id}`);
  const key = buildAssetKey(ownerId, id);
  await new LocalStorageAdapter(path.join(tmp, 'assets')).put(key, bytes);
  await insertAsset(db, { id, ownerId, key, mime, bytes: bytes.byteLength, checksum: createHash('sha256').update(bytes).digest('hex'), rightsStatus: 'owned', verificationState: 'VERIFIED' });
  return id;
}

async function reviewVariant(o: Owner, channel: Channel) {
  const { content } = await createContent(db, o.id, { title: `FIX-T10 ${channel}`, body: BODY });
  const { variant } = await createVariantDraft(db, o.id, content.id, { channel, baseVersion: 1 });
  let base = 1;
  if (channel === 'instagram') {
    // 첨부가 있는 버전을 둘 만든다(v2, v3) — 복원 시 옛 버전(v2)의 첨부도 들어와야 한다(0019 트리거가 복원을 막지 않는지).
    await setVariantAssets(db, o.id, variant.id, { baseVersion: 1, assets: [{ assetId: await putAsset(o.id), position: 1, role: 'image' }] });
    await setVariantAssets(db, o.id, variant.id, { baseVersion: 2, assets: [{ assetId: await putAsset(o.id), position: 1, role: 'image' }] });
    base = 3;
  }
  await setVariantLifecycle(db, o.id, variant.id, { lifecycle: 'review', baseVersion: base });
  return { variantId: variant.id, contentId: content.id };
}

async function planned(o: Owner, channels: Channel[]) {
  const vs = [];
  for (const c of channels) vs.push({ channel: c, ...(await reviewVariant(o, c)) });
  const { plan, items } = await createPlan(db, o.id, { items: vs.map((v) => ({ variant_id: v.variantId, channel_account_id: o.accounts[v.channel] })) });
  const byChannel = Object.fromEntries(vs.map((v) => [v.channel, items.find((i) => i.variantId === v.variantId)!])) as Record<Channel, (typeof items)[number]>;
  return { planId: plan.id, items, byChannel, variants: vs };
}

const approve = (o: Owner, planId: string, items: ReadonlyArray<{ id: string; payloadHash: string }>) =>
  approveItems(db, o.id, planId, {
    item_ids: items.map((i) => i.id),
    expected_hashes: Object.fromEntries(items.map((i) => [i.id, i.payloadHash])),
    confirm: true,
    purpose: 'mock_publish',
  });

function tick(o: Owner, offsetSec = 0, reg: MockChannelAdapterRegistry = registry) {
  return runJobsTick(db, reg, { workerId: 'fixt10-w', config, ownerId: o.id, clock: () => new Date(Date.now() + offsetSec * 1000), random: () => 0.5, submitTimeoutMs: 500, maxJobs: 10 });
}

const activeApprovals = async (d: Db, itemId: string) =>
  (await d.select({ n: count() }).from(schema.approvals).where(and(eq(schema.approvals.distributionItemId, itemId), sql`${schema.approvals.revokedAt} is null`)))[0]!.n;

/** 행 잠금 흔적: FOR SHARE/UPDATE·FK 잠금은 행의 xmax 에 잠근 트랜잭션(또는 multixact)을 남긴다(커밋 뒤에도 다음 잠금 전까지). */
async function xmaxOf(table: 'channel_accounts' | 'contents', id: string): Promise<string> {
  const r = await db.execute(sql`select xmax::text as x from ${sql.identifier(table)} where id = ${id}::uuid`);
  return String((r as unknown as { rows: Array<{ x: string }> }).rows[0]!.x);
}

/** drizzle 가 감싼 PostgreSQL 오류 메시지(원인 사슬 포함). */
function pgMessage(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    parts.push(String((cur as { message?: unknown }).message ?? cur));
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}
async function expectDbError(p: Promise<unknown>, text: string) {
  let err: unknown = null;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, `expected DB error containing ${text}`).not.toBeNull();
  expect(pgMessage(err)).toContain(text);
}

function rebuild(parsed: ParsedBundle, tables: BundleTables): Uint8Array {
  return writeZip(
    buildBundle({
      exportId: randomUUID(),
      exportedAt: new Date().toISOString(),
      appVersion: parsed.manifest.app_version,
      migrations: parsed.manifest.schema_migrations,
      owner: { id: parsed.manifest.owner.id, identityMasked: parsed.manifest.owner.identity_masked },
      tables,
      assetBytes: new Map(parsed.assetBytes),
    }).entries,
  );
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-fix-t10-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  db = (await getDb(loadConfig())).db;
});
beforeEach(() => registry.mock.reset());
afterAll(async () => {
  vi.unstubAllEnvs();
  await closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('P0 — 복원은 UNKNOWN 을 보존한다(BLOCKED·FAILED 로 덮어쓰지 않음)', () => {
  it('UNKNOWN 항목 → UNKNOWN + restored_needs_review, 대기(QUEUED) → BLOCKED + 표시, 계획 attention, 재시도 409(재전송 없음), 옛 버전 첨부도 복원', async () => {
    const o = await newOwner();
    // (1) 결과 불명(UNKNOWN): 응답 유실 뒤 새 원격에서 3회 확인 불가
    const u = await planned(o, ['threads']);
    await approve(o, u.planId, u.items);
    const ux = await executePlan(db, o.id, u.planId, { commandKey: `fixt10-${randomUUID()}` }, config);
    await setMockScenario(db, o.id, u.items[0]!.id, { scenario: 'ambiguous_sent' });
    await tick(o, 0, new MockChannelAdapterRegistry(new MockChannelAdapter({ readEnv: false })));
    const fresh = new MockChannelAdapterRegistry(new MockChannelAdapter({ readEnv: false }));
    await tick(o, 11, fresh);
    await tick(o, 11 + 21, fresh);
    await tick(o, 11 + 21 + 41, fresh);
    const [uj] = await db.select().from(schema.jobs).where(eq(schema.jobs.id, ux.queued[0]!.job_id));
    expect(uj!.state).toBe('UNKNOWN');
    const [up] = await db.select().from(schema.distributionPlans).where(eq(schema.distributionPlans.id, u.planId));
    expect(up!.status).toBe('attention');
    // (2) 보내기 전 대기(QUEUED) — instagram(첨부 있는 버전 둘)
    const q = await planned(o, ['instagram']);
    await approve(o, q.planId, q.items);
    await executePlan(db, o.id, q.planId, { commandKey: `fixt10-${randomUUID()}` }, config);

    const exported = await exportOwner(db, new LocalStorageAdapter(path.join(tmp, 'assets')), o.id, { outDir: path.join(tmp, 'exports') });
    const zip = new Uint8Array(readFileSync(exported.zipPath));
    const parsed = await parseBundleZip(zip);
    expect(parsed.tables.distribution_items.find((i) => i.id === u.items[0]!.id)!.status).toBe('UNKNOWN');
    expect(parsed.tables.distribution_plans.find((p) => p.id === u.planId)!.status).toBe('attention');
    const h = await createTestDb();
    try {
      const target = (await ensureOwner(h.db, 'restore-fixt10@example.local')).id;
      const restoresDir = path.join(tmp, 'restores');
      const p = await createRestorePreview(h.db, target, zip, { restoresDir, source: 'upload' });
      expect(p.preview.unknown_items).toEqual([u.items[0]!.id]);
      expect(p.preview.blocked_items).toEqual([q.items[0]!.id]);
      const r = await commitRestore(h.db, new LocalStorageAdapter(path.join(tmp, 'assets-r')), target, p.restoreId, { mode: 'empty_only', confirm: true, restoresDir });
      expect(r.conflicts_total).toBe(0);
      expect(r.unknown_items).toEqual([u.items[0]!.id]);
      expect(r.blocked_items).toEqual([q.items[0]!.id]);
      // 옛 버전(v2)의 첨부 포함 variant_assets 전부 복원(0019 트리거가 복원을 막지 않음)
      expect(r.restored.variant_assets).toBe(parsed.tables.variant_assets.length);
      expect(parsed.tables.variant_assets.length).toBe(2);
      const items = await h.db.select().from(schema.distributionItems).where(eq(schema.distributionItems.ownerId, target));
      const ui = items.find((i) => i.id === u.items[0]!.id)!;
      const qi = items.find((i) => i.id === q.items[0]!.id)!;
      expect(ui.status).toBe('UNKNOWN');
      expect(ui.restoredNeedsReview).toBe(true);
      expect(qi.status).toBe('BLOCKED');
      expect(qi.restoredNeedsReview).toBe(true);
      const plans = await h.db.select().from(schema.distributionPlans).where(eq(schema.distributionPlans.ownerId, target));
      expect(plans.find((x) => x.id === u.planId)!.status).toBe('attention');
      expect(plans.find((x) => x.id === q.planId)!.status).toBe('attention');
      // 작업은 복원하지 않음 → 자동 실행 없음. 재시도는 명시적으로 거부(결과 불명 → outcome_unknown, 대기 → not_retryable)
      expect((await h.db.select({ n: count() }).from(schema.jobs))[0]!.n).toBe(0);
      await expect(retryItem(h.db, target, ui.id)).rejects.toMatchObject({ kind: 'conflict', code: 'outcome_unknown' });
      await expect(retryItem(h.db, target, qi.id)).rejects.toMatchObject({ kind: 'conflict', code: 'not_retryable' });
      expect((await h.db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, ui.id)))[0]!.status).toBe('UNKNOWN');
    } finally {
      await h.close();
    }
  });
});

describe('P1 — 승인과 계정 상태 변경은 같은 계정 잠금을 공유한다', () => {
  it('승인은 계정 행을 잠근다(xmax 흔적), 두 순서 모두 끝난 뒤 연결 해제된 계정에 활성 승인이 없다', async () => {
    // 순서 A: 승인 → 연결 해제
    const a = await newOwner();
    const pa = await planned(a, ['threads']);
    const before = await xmaxOf('channel_accounts', a.accounts.threads);
    await approve(a, pa.planId, pa.items);
    const after = await xmaxOf('channel_accounts', a.accounts.threads);
    expect(after).not.toBe('0');
    expect(after).not.toBe(before); // 승인 트랜잭션이 계정 행을 잠갔다(승인은 계정을 참조하는 행을 INSERT 하지 않는다)
    expect(await activeApprovals(db, pa.items[0]!.id)).toBe(1);
    const res = await setChannelAccountState(db, a.id, a.accounts.threads, 'disconnected');
    expect(res.revoked.map((x) => x.itemId)).toEqual([pa.items[0]!.id]);
    expect(await activeApprovals(db, pa.items[0]!.id)).toBe(0);

    // 순서 B: 연결 해제 → 승인(거부)
    const b = await newOwner();
    const pb = await planned(b, ['threads']);
    await setChannelAccountState(db, b.id, b.accounts.threads, 'disconnected');
    await expect(approve(b, pb.planId, pb.items)).rejects.toMatchObject({ code: 'snapshot_stale' });
    expect(await activeApprovals(db, pb.items[0]!.id)).toBe(0);
  });
});

describe('P1 — 계획 생성은 FK 잠금까지 전역 순서(계정 → 원고 → 파생본 → 계획 → 항목)를 따른다', () => {
  it('계정 2개 계획과 계정 상태 변경을 (직렬로) 교차해도 둘 다 끝나고 상태가 일관된다; 계획 생성은 원고 행도 잠근다', async () => {
    const o = await newOwner();
    const t = await reviewVariant(o, 'threads');
    const bl = await reviewVariant(o, 'blog');
    const contentBefore = await xmaxOf('contents', t.contentId);
    const { plan, items } = await createPlan(db, o.id, {
      items: [
        { variant_id: t.variantId, channel_account_id: o.accounts.threads },
        { variant_id: bl.variantId, channel_account_id: o.accounts.blog },
      ],
    });
    // 항목 INSERT 는 contents 를 참조하지 않는다 — xmax 변화는 계획 생성의 명시적 FOR SHARE(원고 → 파생본 순서) 흔적
    expect(await xmaxOf('contents', t.contentId)).not.toBe(contentBefore);
    await approve(o, plan.id, items);
    // 계획 생성·승인 뒤 blog 계정 연결 해제 → blog 항목 승인만 철회, 계획 partially_approved
    const blogItem = items.find((i) => i.channelAccountId === o.accounts.blog)!;
    const threadsItem = items.find((i) => i.channelAccountId === o.accounts.threads)!;
    const res = await setChannelAccountState(db, o.id, o.accounts.blog, 'disconnected');
    expect(res.revoked.map((x) => x.itemId)).toEqual([blogItem.id]);
    expect(await activeApprovals(db, blogItem.id)).toBe(0);
    expect(await activeApprovals(db, threadsItem.id)).toBe(1);
    const [p1] = await db.select().from(schema.distributionPlans).where(eq(schema.distributionPlans.id, plan.id));
    expect(p1!.status).toBe('partially_approved');
    // 반대 순서: 연결 해제된 계정을 포함한 계정 2개 계획은 만들어지지 않는다(아무 행도 남기지 않음)
    const plansBefore = (await db.select({ n: count() }).from(schema.distributionPlans).where(eq(schema.distributionPlans.ownerId, o.id)))[0]!.n;
    await expect(
      createPlan(db, o.id, {
        items: [
          { variant_id: t.variantId, channel_account_id: o.accounts.threads },
          { variant_id: bl.variantId, channel_account_id: o.accounts.blog },
        ],
      }),
    ).rejects.toMatchObject({ code: 'account_not_ready' });
    expect((await db.select({ n: count() }).from(schema.distributionPlans).where(eq(schema.distributionPlans.ownerId, o.id)))[0]!.n).toBe(plansBefore);
    // 다시 준비 → 계획 생성 성공
    await setChannelAccountState(db, o.id, o.accounts.blog, 'mock_ready');
    const again = await createPlan(db, o.id, {
      items: [
        { variant_id: t.variantId, channel_account_id: o.accounts.threads },
        { variant_id: bl.variantId, channel_account_id: o.accounts.blog },
      ],
    });
    expect(again.items).toHaveLength(2);
  });
});

describe('P1 — 복원 payload 구조 검증', () => {
  it('승인 없는 항목의 payload_json 에서 text·assets 를 지우고 hash 를 다시 계산해도 묶음 전체 거부(항목 ID 명시)', async () => {
    const o = await newOwner();
    const pl = await planned(o, ['threads']);
    const exported = await exportOwner(db, new LocalStorageAdapter(path.join(tmp, 'assets')), o.id, { outDir: path.join(tmp, 'exports-shape') });
    const parsed = await parseBundleZip(new Uint8Array(readFileSync(exported.zipPath)));
    const tables = structuredClone(parsed.tables) as BundleTables;
    const item = tables.distribution_items.find((i) => i.id === pl.items[0]!.id)!;
    expect(tables.approvals.filter((a) => a.distribution_item_id === item.id)).toHaveLength(0);
    const { text: _t, assets: _a, ...rest } = item.payload_json as Record<string, unknown>;
    item.payload_json = rest;
    item.payload_hash = payloadHash(rest);
    let err: unknown = null;
    try {
      await parseBundleZip(rebuild(parsed, tables));
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: 'integrity' });
    const problems = JSON.stringify(err);
    expect(problems).toContain(item.id);
    expect(problems).toContain('payload_json 구조');
    // 손대지 않은 묶음은 통과
    await expect(parseBundleZip(rebuild(parsed, structuredClone(parsed.tables) as BundleTables))).resolves.toBeTruthy();
  });
});

describe('D19-b(D20) — 0019 트리거', () => {
  it('assets.checksum·bytes 제자리 UPDATE 거부, 다른 열은 그대로 가능', async () => {
    const o = await newOwner();
    const id = await putAsset(o.id);
    await expectDbError(db.execute(sql`update assets set checksum = ${'f'.repeat(64)} where id = ${id}::uuid`), 'assets_content_immutable');
    await expectDbError(db.execute(sql`update assets set bytes = bytes + 1 where id = ${id}::uuid`), 'assets_content_immutable');
    await db.execute(sql`update assets set rights_status = rights_status where id = ${id}::uuid`);
  });

  it('variant_assets: 지나간 옛 버전·배포 스냅샷이 참조하는 버전에는 INSERT 거부, 정상 첨부 경로(setVariantAssets)는 통과', async () => {
    const o = await newOwner();
    const { content } = await createContent(db, o.id, { title: 'FIX-T10 트리거', body: BODY });
    const { variant } = await createVariantDraft(db, o.id, content.id, { channel: 'instagram', baseVersion: 1 });
    const img1 = await putAsset(o.id);
    await setVariantAssets(db, o.id, variant.id, { baseVersion: 1, assets: [{ assetId: img1, position: 1, role: 'image' }] });
    const versions = await db.select().from(schema.variantVersions).where(eq(schema.variantVersions.variantId, variant.id));
    const v1 = versions.find((v) => v.version === 1)!;
    const v2 = versions.find((v) => v.version === 2)!;
    // 옛 버전(v1 — 현재는 v2)
    await expectDbError(
      db.insert(schema.variantAssets).values({ ownerId: o.id, variantVersionId: v1.id, assetId: await putAsset(o.id), position: 1, role: 'image' }),
      'variant_assets_version_open',
    );
    // 배포 스냅샷이 참조하는 현재 버전(v2)
    await setVariantLifecycle(db, o.id, variant.id, { lifecycle: 'review', baseVersion: 2 });
    await createPlan(db, o.id, { items: [{ variant_id: variant.id, channel_account_id: o.accounts.instagram }] });
    await expectDbError(
      db.insert(schema.variantAssets).values({ ownerId: o.id, variantVersionId: v2.id, assetId: await putAsset(o.id), position: 2, role: 'image' }),
      'variant_assets_version_open',
    );
    // 정상 경로: 새 버전을 만들며 첨부(현재·참조 없는 버전)
    const img3 = await putAsset(o.id);
    const r = await setVariantAssets(db, o.id, variant.id, { baseVersion: 2, assets: [{ assetId: img1, position: 1, role: 'image' }, { assetId: img3, position: 2, role: 'image' }] });
    expect(r).toBeTruthy();
    const [cur] = await db.select().from(schema.variants).where(eq(schema.variants.id, variant.id));
    const attached = await db.select().from(schema.variantAssets).where(eq(schema.variantAssets.variantVersionId, cur!.currentVersionId!));
    expect(attached).toHaveLength(2);
  });
});
