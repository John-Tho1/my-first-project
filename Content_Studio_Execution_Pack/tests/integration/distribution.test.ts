/**
 * T10(결정 D17): 배포 계획·불변 스냅샷·계정별 미리보기·승인·철회·A06 무효화·실행 멱등(A07 로컬 절반)·A13 예약·DB 불변 트리거·
 * export → 빈 DB 복원(작업 제외, restore_stale). 모의 계정만 — 외부 호출·publisher 호출 없음.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, count, eq, sql } from 'drizzle-orm';
import {
  appendContentVersion,
  appendVariantVersion,
  closeDb,
  commitRestore,
  createContent,
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
  schema,
  seed,
  setChannelAccountState,
  setVariantAssets,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { buildAssetKey, buildBundle, formatMsk, loadConfig, payloadHash, writeZip, type BundleTables, type Channel } from '@cs/domain';
import { LocalStorageAdapter } from '@cs/providers';
import { POST as revokePOST } from '../../apps/web/app/api/approvals/[id]/revoke/route';
import { GET as accountsGET } from '../../apps/web/app/api/channel-accounts/route';
import { POST as approvePOST } from '../../apps/web/app/api/distribution-plans/[id]/approve/route';
import { POST as executePOST } from '../../apps/web/app/api/distribution-plans/[id]/execute/route';
import { GET as planGET } from '../../apps/web/app/api/distribution-plans/[id]/route';
import { GET as plansGET, POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const A = 'owner@example.local';
const B = 'dist-other@example.local';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 7, 7, 7]);
const PNG2 = new Uint8Array([...PNG, 8]);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

let db: Db;
let ownerA: string;
let ownerB: string;
let tokenA: string;
let tokenB: string;
let tmp: string;
let pngA: string;
let png2A: string;
const acc = {} as Record<string, Record<Channel, string>>;

const as = (identity: string) => vi.stubEnv('AUTH_ALLOWED_IDENTITY', identity);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (p: string, token = tokenA) => new Request(`${BASE}${p}`, { headers: { accept: 'application/json', ...cookieHeader(token) } });
const createPlanApi = (body: unknown, token = tokenA) => plansPOST(jsonPost('/api/distribution-plans', body, cookieHeader(token)));
const approveApi = (planId: string, body: unknown, token = tokenA) => approvePOST(jsonPost(`/api/distribution-plans/${planId}/approve`, body, cookieHeader(token)), ctx(planId));
const executeApi = (planId: string, body: unknown, token = tokenA) => executePOST(jsonPost(`/api/distribution-plans/${planId}/execute`, body, cookieHeader(token)), ctx(planId));
const revokeApi = (approvalId: string, body: unknown, token = tokenA) => revokePOST(jsonPost(`/api/approvals/${approvalId}/revoke`, body, cookieHeader(token)), ctx(approvalId));
const planDetail = async (planId: string, token = tokenA) => planGET(get(`/api/distribution-plans/${planId}`, token), ctx(planId));

const BODY = '# 첫 달 회고\n\n대리점과 첫 회의를 했다.\n\n재고 리스크를 먼저 합의했다.';

async function putAsset(ownerId: string, bytes: Uint8Array, mime: string) {
  const id = randomUUID();
  const key = buildAssetKey(ownerId, id);
  await new LocalStorageAdapter(path.join(tmp, 'assets')).put(key, bytes);
  await insertAsset(db, { id, ownerId, key, mime, bytes: bytes.byteLength, checksum: sha(bytes), rightsStatus: 'owned', verificationState: 'VERIFIED' });
  return id;
}

/** 원고 + 채널 초안(검토 중). instagram 은 이미지 첨부 뒤 검토. */
async function reviewVariant(channel: Channel = 'threads', ownerId = ownerA) {
  const { content } = await createContent(db, ownerId, { title: `배포 ${channel}`, body: BODY });
  const { variant } = await createVariantDraft(db, ownerId, content.id, { channel, baseVersion: 1 });
  let base = 1;
  if (channel === 'instagram') {
    await setVariantAssets(db, ownerId, variant.id, { baseVersion: 1, assets: [{ assetId: pngA, position: 1, role: 'image' }] });
    base = 2;
  }
  await setVariantLifecycle(db, ownerId, variant.id, { lifecycle: 'review', baseVersion: base });
  return { contentId: content.id, variantId: variant.id, base };
}

async function planFor(variantId: string, channel: Channel = 'threads', extra: Record<string, unknown> = {}) {
  const res = await createPlanApi({ items: [{ variant_id: variantId, channel_account_id: acc[ownerA]![channel], ...extra }] });
  expect(res.status).toBe(201);
  return (await res.json()) as { plan: { id: string; status: string }; items: Array<{ id: string; payload_hash: string; payload: Record<string, unknown> }> };
}

async function approvedPlan(channel: Channel = 'threads') {
  const v = await reviewVariant(channel);
  const p = await planFor(v.variantId, channel);
  const item = p.items[0]!;
  const res = await approveApi(p.plan.id, { item_ids: [item.id], expected_hashes: { [item.id]: item.payload_hash }, confirm: true, purpose: 'mock_publish' });
  expect(res.status).toBe(200);
  const body = await res.json();
  return { ...v, planId: p.plan.id, itemId: item.id, hash: item.payload_hash, approvalId: body.approvals[0].id as string };
}

const approvalRow = async (id: string) => (await db.select().from(schema.approvals).where(eq(schema.approvals.id, id)))[0]!;
const variantRow = async (id: string) => (await db.select().from(schema.variants).where(eq(schema.variants.id, id)))[0]!;
const jobsOf = (itemId: string) => db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId));

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-t10-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('EXPORT_LOCAL_DIR', path.join(tmp, 'exports'));
  db = (await getDb(loadConfig())).db;
  ownerA = (await seed(db, { allowedIdentity: A })).ownerId;
  ownerB = (await seed(db, { allowedIdentity: B })).ownerId;
  for (const o of [ownerA, ownerB]) {
    acc[o] = Object.fromEntries((await listChannelAccounts(db, o)).map((a) => [a.platform, a.id])) as Record<Channel, string>;
  }
  pngA = await putAsset(ownerA, PNG, 'image/png');
  png2A = await putAsset(ownerA, PNG2, 'image/png');
  as(A);
  tokenA = await login(A);
  as(B);
  tokenB = await login(B);
  as(A);
});
beforeEach(() => as(A));
afterAll(async () => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
  await closeDb();
});

describe('모의 계정·계획 만들기', () => {
  it('seed: 플랫폼마다 MOCK 계정 1개(mock: 접두어, mock_ready), 재실행해도 늘지 않음', async () => {
    const res = await accountsGET(get('/api/channel-accounts'), undefined);
    const items = (await res.json()).items as Array<{ platform: string; kind: string; external_account_id: string; display_name: string; state: string }>;
    expect(items.map((a) => a.platform).sort()).toEqual(['blog', 'instagram', 'threads', 'youtube']);
    for (const a of items) {
      expect(a.kind).toBe('mock');
      expect(a.external_account_id.startsWith('mock:')).toBe(true);
      expect(a.display_name).toContain('MOCK');
      expect(a.state).toBe('mock_ready');
    }
    expect((await seed(db, { allowedIdentity: A })).mockAccountsInserted).toBe(0);
    expect((await listChannelAccounts(db, ownerA)).length).toBe(4);
  });

  it('검토 중·차단 사유 없음만: draft 409, stale 409, 미디어 부족 409, 채널 불일치 400, 다른 owner 404', async () => {
    const { content } = await createContent(db, ownerA, { title: 'draft', body: BODY });
    const { variant } = await createVariantDraft(db, ownerA, content.id, { channel: 'threads', baseVersion: 1 });
    let res = await createPlanApi({ items: [{ variant_id: variant.id, channel_account_id: acc[ownerA]!.threads }] });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('variant_not_review');

    const stale = await reviewVariant('threads');
    await appendContentVersion(db, ownerA, stale.contentId, { baseVersion: 1, body: `${BODY}\n\n고침` });
    res = await createPlanApi({ items: [{ variant_id: stale.variantId, channel_account_id: acc[ownerA]!.threads }] });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('stale_variant');

    // 이미지 없는 instagram 을 review 로(검토 게이트를 우회한 상태를 흉내) → 계획 단계에서 다시 막힘
    const ig = await createContent(db, ownerA, { title: 'ig', body: BODY });
    const igv = (await createVariantDraft(db, ownerA, ig.content.id, { channel: 'instagram', baseVersion: 1 })).variant;
    await db.execute(sql`update variants set lifecycle = 'review' where id = ${igv.id}::uuid`);
    res = await createPlanApi({ items: [{ variant_id: igv.id, channel_account_id: acc[ownerA]!.instagram }] });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('media_incomplete');

    const t = await reviewVariant('threads');
    res = await createPlanApi({ items: [{ variant_id: t.variantId, channel_account_id: acc[ownerA]!.instagram }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('channel_mismatch');
    res = await createPlanApi({ items: [{ variant_id: t.variantId, channel_account_id: acc[ownerB]!.threads }] });
    expect(res.status).toBe(404);
    as(B);
    res = await createPlanApi({ items: [{ variant_id: t.variantId, channel_account_id: acc[ownerB]!.threads }] }, tokenB);
    expect(res.status).toBe(404); // B 에게 A 의 파생본은 없다
    as(A);
    res = await createPlanApi({ items: [{ variant_id: t.variantId, channel_account_id: acc[ownerA]!.threads, requested_result: 'public_publish' }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('mock_only');
    expect((await db.select({ n: count() }).from(schema.distributionPlans).where(eq(schema.distributionPlans.ownerId, ownerA)))[0]!.n).toBe(0);
  });

  it('계정별 미리보기: payload = 나가는 글·첨부 checksum·계정, hash = 저장 스냅샷 재계산, 다른 owner 404', async () => {
    const v = await reviewVariant('instagram');
    const p = await planFor(v.variantId, 'instagram', { visibility: 'unlisted' });
    const res = await planDetail(p.plan.id);
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.mode).toBe('MOCK');
    const it0 = d.items[0];
    expect(it0.payload_hash).toBe(payloadHash(it0.payload));
    const [row] = await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, it0.id));
    expect(payloadHash(row!.payloadJson)).toBe(row!.payloadHash);
    expect(it0.payload).toMatchObject({
      channel: 'instagram',
      visibility: 'unlisted',
      scheduled_at_utc: null,
      timezone: 'Europe/Moscow',
      provider_metadata: {},
      snapshot_version: 1,
      assets: [{ id: pngA, checksum: sha(PNG), role: 'image', order: 1, mime: 'image/png' }],
    });
    expect(it0.payload.provider_account_id).toMatch(/^mock:instagram:/);
    expect(it0.payload.text.caption).toBe('# 첫 달 회고');
    expect(it0.account).toMatchObject({ mock: true, display_name: 'MOCK Instagram 계정' });
    expect(it0.status).toBe('PLANNED');
    expect(it0.active_approval).toBeNull();
    as(B);
    expect((await planDetail(p.plan.id, tokenB)).status).toBe(404);
    as(A);
    const list = await (await plansGET(get('/api/distribution-plans'), undefined)).json();
    expect(list.items.find((x: { id: string }) => x.id === p.plan.id)).toMatchObject({ mock: true, item_count: 1, status: 'draft' });
  });

  it('{approved:true}·approval·approved_by_ai 는 승인을 만들지 않는다', async () => {
    const v = await reviewVariant('blog');
    const res = await createPlanApi({
      approved: true,
      approved_by_ai: true,
      items: [{ variant_id: v.variantId, channel_account_id: acc[ownerA]!.blog, approved: true, approval: { id: randomUUID() } }],
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.plan.status).toBe('draft');
    const n = await db.select({ n: count() }).from(schema.approvals).where(eq(schema.approvals.distributionItemId, body.items[0].id));
    expect(n[0]!.n).toBe(0);
    expect((await variantRow(v.variantId)).lifecycle).toBe('review');
  });
});

describe('승인', () => {
  it('confirm 없음 400, hash 불일치 409, 다른 owner 404, 성공 → 승인 행·파생본 approved·계획 approved, 다시 승인 409', async () => {
    const v = await reviewVariant('threads');
    const p = await planFor(v.variantId);
    const item = p.items[0]!;
    const good = { item_ids: [item.id], expected_hashes: { [item.id]: item.payload_hash }, confirm: true, purpose: 'mock_publish' };
    let res = await approveApi(p.plan.id, { ...good, confirm: undefined });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('confirm_required');
    res = await approveApi(p.plan.id, { ...good, expected_hashes: { [item.id]: 'f'.repeat(64) } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'hash_mismatch', item_ids: [item.id] });
    as(B);
    res = await approveApi(p.plan.id, good, tokenB);
    expect(res.status).toBe(404);
    as(A);
    expect((await db.select({ n: count() }).from(schema.approvals).where(eq(schema.approvals.distributionItemId, item.id)))[0]!.n).toBe(0);
    res = await approveApi(p.plan.id, { ...good, approved_by_ai: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan.status).toBe('approved');
    expect(body.approvals[0]).toMatchObject({ distribution_item_id: item.id, payload_hash: item.payload_hash, purpose: 'mock_publish', approval_version: 1, active: true });
    expect((await variantRow(v.variantId)).lifecycle).toBe('approved');
    // 승인됨은 사용자 상태 변경으로 바꿀 수 없다
    await expect(setVariantLifecycle(db, ownerA, v.variantId, { lifecycle: 'draft', baseVersion: 1 })).rejects.toMatchObject({ code: 'variant_approved' });
    res = await approveApi(p.plan.id, good);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already_approved');
    const audit = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, 'approval.grant'), eq(schema.auditEvents.entityId, body.approvals[0].id)));
    expect(audit[0]!.sanitizedDetails).toEqual({ item_id: item.id, payload_hash: item.payload_hash });
  });

  it('일부만 승인 → partially_approved', async () => {
    const t = await reviewVariant('threads');
    const b = await reviewVariant('blog');
    const res = await createPlanApi({
      items: [
        { variant_id: t.variantId, channel_account_id: acc[ownerA]!.threads },
        { variant_id: b.variantId, channel_account_id: acc[ownerA]!.blog },
      ],
    });
    const p = await res.json();
    const first = p.items[0];
    const ok = await approveApi(p.plan.id, { item_ids: [first.id], expected_hashes: { [first.id]: first.payload_hash }, confirm: true, purpose: 'mock_publish' });
    expect((await ok.json()).plan.status).toBe('partially_approved');
  });
});

describe('A06: 승인 뒤 변경은 승인을 무효로 한다', () => {
  it('(a) 파생본 수정 → invalidated:body_changed, 파생본 draft, 실행 403, 재승인 409 snapshot_stale', async () => {
    const x = await approvedPlan('threads');
    await appendVariantVersion(db, ownerA, x.variantId, { baseVersion: 1, body: '바꾼 글', metadata: { text: '바꾼 글', thread_parts: ['바꾼 글'] } });
    const a = await approvalRow(x.approvalId);
    expect(a.revokedAt).not.toBeNull();
    expect(a.revokeReason).toBe('invalidated:body_changed');
    expect((await variantRow(x.variantId)).lifecycle).toBe('draft');
    let res = await executeApi(x.planId, { command_key: `a06-a-${randomUUID()}` });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('approval_required');
    expect(await jobsOf(x.itemId)).toHaveLength(0);
    res = await approveApi(x.planId, { item_ids: [x.itemId], expected_hashes: { [x.itemId]: x.hash }, confirm: true, purpose: 'mock_publish' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('snapshot_stale');
    const refused = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, 'approval.refused'), eq(schema.auditEvents.entityId, x.itemId)));
    expect(refused).toHaveLength(1);
  });

  it('(b) 첨부 변경 → invalidated:assets_changed', async () => {
    const x = await approvedPlan('instagram');
    await setVariantAssets(db, ownerA, x.variantId, { baseVersion: 2, assets: [{ assetId: png2A, position: 1, role: 'image' }] });
    expect((await approvalRow(x.approvalId)).revokeReason).toBe('invalidated:assets_changed');
    expect((await variantRow(x.variantId)).lifecycle).toBe('draft');
  });

  it('(c) 원고 수정 → invalidated:content_changed, 승인됨 파생본 draft', async () => {
    const x = await approvedPlan('blog');
    await appendContentVersion(db, ownerA, x.contentId, { baseVersion: 1, body: `${BODY}\n\n추가 문단` });
    expect((await approvalRow(x.approvalId)).revokeReason).toBe('invalidated:content_changed');
    expect((await variantRow(x.variantId)).lifecycle).toBe('draft');
    const [plan] = await db.select().from(schema.distributionPlans).where(eq(schema.distributionPlans.id, x.planId));
    expect(plan!.status).toBe('draft');
  });

  it('(d) 계정 상태 변경 → invalidated:account_changed, 파생본 review, 계정 되돌려도 승인은 되살아나지 않음', async () => {
    const y = await approvedPlan('blog');
    await setChannelAccountState(db, ownerA, acc[ownerA]!.blog, 'disconnected');
    expect((await approvalRow(y.approvalId)).revokeReason).toBe('invalidated:account_changed');
    expect((await variantRow(y.variantId)).lifecycle).toBe('review');
    await setChannelAccountState(db, ownerA, acc[ownerA]!.blog, 'mock_ready');
    expect((await approvalRow(y.approvalId)).revokedAt).not.toBeNull();
    const res = await executeApi(y.planId, { command_key: `a06-d-${randomUUID()}` });
    expect(res.status).toBe(403);
  });
});

describe('실행(MOCK)·멱등·철회', () => {
  it('승인 없음 → 403, 작업 0', async () => {
    const v = await reviewVariant('threads');
    const p = await planFor(v.variantId);
    const res = await executeApi(p.plan.id, { command_key: `noapp-${randomUUID()}` });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('approval_required');
    expect(await jobsOf(p.items[0]!.id)).toHaveLength(0);
    expect((await db.select({ n: count() }).from(schema.executeCommands).where(eq(schema.executeCommands.planId, p.plan.id)))[0]!.n).toBe(0);
  });

  it('성공: QUEUED 작업·job_event 1·항목 QUEUED·계획 executing·MOCK, 같은 key 재호출은 같은 결과, 다른 key 는 409', async () => {
    const x = await approvedPlan('threads');
    const key = `exec-${randomUUID()}`;
    let res = await executeApi(x.planId, { command_key: key });
    expect(res.status).toBe(200);
    const r1 = await res.json();
    expect(r1).toMatchObject({ plan_id: x.planId, mode: 'MOCK', idempotent_replay: false });
    expect(r1.notice).toContain('MOCK');
    expect(r1.queued).toEqual([{ item_id: x.itemId, job_id: expect.any(String), mode: 'MOCK' }]);
    expect(JSON.stringify(r1)).not.toContain('게시 완료');
    const js = await jobsOf(x.itemId);
    expect(js).toHaveLength(1);
    expect(js[0]).toMatchObject({ state: 'QUEUED', kind: 'publish', attempt: 0, payloadRef: x.itemId, idempotencyKey: `publish:${x.itemId}:${x.approvalId}` });
    const ev = await db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, js[0]!.id));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ eventSeq: 1, stateBefore: null, stateAfter: 'QUEUED' });
    expect(ev[0]!.sanitizedDetails).toMatchObject({ mode: 'MOCK', event: 'execute' });
    expect(JSON.stringify(ev[0]!.sanitizedDetails)).not.toContain(key);
    const [item] = await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, x.itemId));
    expect(item!.status).toBe('QUEUED');
    const [plan] = await db.select().from(schema.distributionPlans).where(eq(schema.distributionPlans.id, x.planId));
    expect(plan!.status).toBe('executing');
    const audit = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, 'plan.execute'), eq(schema.auditEvents.entityId, x.planId)));
    expect(JSON.stringify(audit)).not.toContain(key);

    res = await executeApi(x.planId, { command_key: key });
    expect(res.status).toBe(200);
    const r2 = await res.json();
    expect(r2).toEqual({ ...r1, idempotent_replay: true });
    expect(await jobsOf(x.itemId)).toHaveLength(1);

    res = await executeApi(x.planId, { command_key: `other-${randomUUID()}` });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already_executed');
    expect(await jobsOf(x.itemId)).toHaveLength(1);
  });

  it('더블클릭(동시 실행, 다른 key) → 항목당 작업 1개, 하나는 409', async () => {
    const x = await approvedPlan('threads');
    const [r1, r2] = await Promise.all([executeApi(x.planId, { command_key: `dbl-a-${randomUUID()}` }), executeApi(x.planId, { command_key: `dbl-b-${randomUUID()}` })]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(await jobsOf(x.itemId)).toHaveLength(1);
    // DB 함수를 직접 동시에 불러도 같다(같은 key 는 한 결과)
    const y = await approvedPlan('blog');
    const key = `same-${randomUUID()}`;
    const cfg = loadConfig();
    const [s1, s2] = await Promise.all([executePlan(db, ownerA, y.planId, { commandKey: key }, cfg), executePlan(db, ownerA, y.planId, { commandKey: key }, cfg)]);
    expect(s1.queued).toEqual(s2.queued);
    expect([s1.idempotent_replay, s2.idempotent_replay].sort()).toEqual([false, true]);
    expect(await jobsOf(y.itemId)).toHaveLength(1);
  });

  it('실행 뒤 철회 → 작업 BLOCKED(+event), 항목 PLANNED, 파생본 review, 다시 철회 409', async () => {
    const x = await approvedPlan('threads');
    expect((await executeApi(x.planId, { command_key: `rv-${randomUUID()}` })).status).toBe(200);
    let res = await revokeApi(x.approvalId, { reason: '다시 볼게요' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approval).toMatchObject({ active: false, revoke_reason: 'user: 다시 볼게요' });
    const js = await jobsOf(x.itemId);
    expect(js[0]!.state).toBe('BLOCKED');
    expect(body.blocked_job_ids).toEqual([js[0]!.id]);
    const ev = await db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, js[0]!.id)).orderBy(schema.jobEvents.eventSeq);
    expect(ev.map((e) => [e.eventSeq, e.stateBefore, e.stateAfter])).toEqual([
      [1, null, 'QUEUED'],
      [2, 'QUEUED', 'BLOCKED'],
    ]);
    expect(ev[1]!.sanitizedDetails).toMatchObject({ event: 'approval_revoked' });
    const [item] = await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, x.itemId));
    expect(item!.status).toBe('PLANNED');
    expect((await variantRow(x.variantId)).lifecycle).toBe('review');
    res = await revokeApi(x.approvalId, {});
    expect(res.status).toBe(409);
    as(B);
    expect((await revokeApi(x.approvalId, {}, tokenB)).status).toBe(404);
    as(A);
    // 다시 승인·실행하면 새 작업(새 승인 → 새 idempotency key), 막힌 작업은 그대로
    const again = await approveApi(x.planId, { item_ids: [x.itemId], expected_hashes: { [x.itemId]: x.hash }, confirm: true, purpose: 'mock_publish' });
    expect(again.status).toBe(200);
    expect((await executeApi(x.planId, { command_key: `rv2-${randomUUID()}` })).status).toBe(200);
    expect((await jobsOf(x.itemId)).map((j) => j.state).sort()).toEqual(['BLOCKED', 'QUEUED']);
  });
});

describe('A13 예약(MSK → UTC)', () => {
  it('과거 예약 400, 미래 예약은 UTC 로 저장·작업 next_run_at = 예약 시각, 화면 표시는 MSK', async () => {
    const v = await reviewVariant('threads');
    let res = await createPlanApi({ items: [{ variant_id: v.variantId, channel_account_id: acc[ownerA]!.threads, schedule: { date: '2020-01-01', time: '10:00' } }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('schedule_in_past');
    res = await createPlanApi({ items: [{ variant_id: v.variantId, channel_account_id: acc[ownerA]!.threads, schedule: { date: '2099-10-01', time: '12:00' } }] });
    expect(res.status).toBe(201);
    const p = await res.json();
    expect(p.items[0].scheduled_at_utc).toBe('2099-10-01T09:00:00.000Z');
    expect(p.items[0].payload.scheduled_at_utc).toBe('2099-10-01T09:00:00.000Z');
    expect(formatMsk(p.items[0].scheduled_at_utc)).toBe('2099-10-01 12:00 (MSK)');
    const item = p.items[0];
    expect((await approveApi(p.plan.id, { item_ids: [item.id], expected_hashes: { [item.id]: item.payload_hash }, confirm: true, purpose: 'mock_publish' })).status).toBe(200);
    expect((await executeApi(p.plan.id, { command_key: `sch-${randomUUID()}` })).status).toBe(200);
    expect((await jobsOf(item.id))[0]!.nextRunAt.toISOString()).toBe('2099-10-01T09:00:00.000Z');
  });

  it('승인 뒤 예약 시각이 지나면 실행 거부(409 snapshot_stale) + 승인 철회(schedule_passed)', async () => {
    const v = await reviewVariant('threads');
    const p = await planFor(v.variantId, 'threads', { schedule: { date: '2099-10-01', time: '12:00' } });
    const item = p.items[0]!;
    expect((await approveApi(p.plan.id, { item_ids: [item.id], expected_hashes: { [item.id]: item.payload_hash }, confirm: true, purpose: 'mock_publish' })).status).toBe(200);
    await expect(executePlan(db, ownerA, p.plan.id, { commandKey: `late-${randomUUID()}` }, loadConfig(), new Date('2099-10-01T09:00:00.000Z'))).rejects.toMatchObject({
      code: 'snapshot_stale',
    });
    expect(await jobsOf(item.id)).toHaveLength(0);
    const [a] = await db.select().from(schema.approvals).where(eq(schema.approvals.distributionItemId, item.id));
    expect(a!.revokeReason).toBe('invalidated:schedule_passed');
  });
});

describe('DB 불변 트리거', () => {
  it('항목 스냅샷 UPDATE·DELETE 거부(status 만 변경 가능), 승인 DELETE·목적 변경·두 번째 철회 거부', async () => {
    const x = await approvedPlan('threads');
    await expect(db.execute(sql`update distribution_items set payload_hash = ${'0'.repeat(64)} where id = ${x.itemId}::uuid`)).rejects.toThrow();
    await expect(db.execute(sql`update distribution_items set payload_json = '{}'::jsonb where id = ${x.itemId}::uuid`)).rejects.toThrow();
    await expect(db.execute(sql`update distribution_items set scheduled_at_utc = now() where id = ${x.itemId}::uuid`)).rejects.toThrow();
    await expect(db.execute(sql`delete from distribution_items where id = ${x.itemId}::uuid`)).rejects.toThrow();
    await db.execute(sql`update distribution_items set updated_at = now() where id = ${x.itemId}::uuid`);
    await expect(db.execute(sql`delete from approvals where id = ${x.approvalId}::uuid`)).rejects.toThrow();
    await expect(db.execute(sql`update approvals set purpose = 'public_publish' where id = ${x.approvalId}::uuid`)).rejects.toThrow();
    await expect(db.execute(sql`update approvals set payload_hash = ${'1'.repeat(64)}, revoked_at = now(), revoke_reason = 'x' where id = ${x.approvalId}::uuid`)).rejects.toThrow();
    await db.execute(sql`update approvals set revoked_at = now(), revoke_reason = 'test' where id = ${x.approvalId}::uuid`);
    await expect(db.execute(sql`update approvals set revoked_at = now(), revoke_reason = 'again' where id = ${x.approvalId}::uuid`)).rejects.toThrow();
    await expect(db.execute(sql`update approvals set revoked_at = null, revoke_reason = null where id = ${x.approvalId}::uuid`)).rejects.toThrow();
    // 항목과 다른 hash 의 승인은 넣을 수 없다
    await expect(
      db.execute(
        sql`insert into approvals (owner_id, distribution_item_id, payload_hash, purpose, approved_at) values (${ownerA}::uuid, ${x.itemId}::uuid, ${'2'.repeat(64)}, 'mock_publish', now())`,
      ),
    ).rejects.toThrow();
    // job_events·execute_commands 는 추가 전용
    await expect(db.execute(sql`delete from job_events`)).rejects.toThrow();
    await expect(db.execute(sql`update execute_commands set command_key = 'x'`)).rejects.toThrow();
  });
});

describe('export → 빈 DB 복원', () => {
  it('계정·계획·항목·승인은 hash 그대로 복원, 작업은 읽기 전용 이력(FIX-T11 — 진행 중 항목·작업은 BLOCKED+표시, 이벤트·실행 명령은 복원 안 함), 파생본이 바뀐 활성 승인은 restore_stale', async () => {
    // (1) 실행까지 간 계획(작업 있음) (2) 승인 뒤 파생본이 바뀐 계획 — 묶음에서 그 승인을 "활성"으로 조작해 복원 사후 검사를 확인
    const queued = await approvedPlan('threads');
    expect((await executeApi(queued.planId, { command_key: `exp-${randomUUID()}` })).status).toBe(200);
    const moved = await approvedPlan('blog');
    await appendVariantVersion(db, ownerA, moved.variantId, { baseVersion: 1, body: '바뀐 블로그', metadata: { title: '바뀐', markdown: '바뀐 블로그' } });
    const kept = await approvedPlan('threads');

    const exported = await exportOwner(db, new LocalStorageAdapter(path.join(tmp, 'assets')), ownerA, { outDir: path.join(tmp, 'dist-exports') });
    for (const t of ['channel_accounts', 'distribution_plans', 'distribution_items', 'approvals', 'jobs', 'job_events', 'execute_commands'] as const) {
      expect(exported.manifest.tables[t]!.rows, t).toBeGreaterThan(0);
    }
    const parsed = await parseBundleZip(new Uint8Array(readFileSync(exported.zipPath)));
    const tables = structuredClone(parsed.tables) as BundleTables;
    const tampered = tables.approvals.find((a) => a.id === moved.approvalId)!;
    expect(tampered.revoke_reason).toBe('invalidated:body_changed');
    tampered.revoked_at = null;
    tampered.revoke_reason = null;
    const zip = writeZip(
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
    const h = await createTestDb();
    try {
      const target = (await ensureOwner(h.db, 'restore-t10@example.local')).id;
      const restoresDir = path.join(tmp, 'dist-restores');
      const p = await createRestorePreview(h.db, target, zip, { restoresDir, source: 'upload' });
      expect(p.preview.conflicts_total).toBe(0);
      expect(p.preview.tables.jobs).toMatchObject({ restored: true });
      expect(p.preview.tables.job_events).toMatchObject({ restored: false });
      expect(p.preview.tables.execute_commands).toMatchObject({ restored: false });
      const r = await commitRestore(h.db, new LocalStorageAdapter(path.join(tmp, 'assets-r')), target, p.restoreId, { mode: 'empty_only', confirm: true, restoresDir });
      expect(r.conflicts_total).toBe(0);
      for (const t of ['channel_accounts', 'distribution_plans', 'distribution_items', 'approvals'] as const) expect(r.restored[t], t).toBe(tables[t].length);
      // FIX-T11: 작업은 읽기 전용 이력 — 들어오되 lease 없음·복원 표시, QUEUED 작업은 BLOCKED(자동 재개 없음)
      expect(r.restored.jobs).toBe(tables.jobs.length);
      const rjobs = await h.db.select().from(schema.jobs);
      expect(rjobs.length).toBe(tables.jobs.length);
      for (const j of rjobs) {
        expect(j.restoredNeedsReview).toBe(true);
        expect(j.leaseOwner).toBeNull();
        expect(['CONFIRMED', 'FAILED', 'CANCELED', 'BLOCKED', 'UNKNOWN']).toContain(j.state);
      }
      expect(rjobs.find((j) => j.itemId === queued.itemId)!.state).toBe('BLOCKED');
      expect((await h.db.select({ n: count() }).from(schema.jobEvents))[0]!.n).toBe(0);
      expect((await h.db.select({ n: count() }).from(schema.executeCommands))[0]!.n).toBe(0);
      // hash·스냅샷 그대로
      const items = await h.db.select().from(schema.distributionItems).where(eq(schema.distributionItems.ownerId, target));
      expect(items.map((i) => [i.id, i.payloadHash]).sort()).toEqual(tables.distribution_items.map((i) => [i.id, i.payload_hash]).sort());
      for (const i of items) expect(payloadHash(i.payloadJson)).toBe(i.payloadHash);
      // 진행 중(QUEUED)이던 항목은 BLOCKED
      expect(r.blocked_items).toContain(queued.itemId);
      expect(items.find((i) => i.id === queued.itemId)!.status).toBe('BLOCKED');
      // 파생본이 바뀐 활성 승인은 restore_stale, 그대로인 승인은 활성
      expect(r.revoked_approvals.map((x) => x.approval_id)).toContain(moved.approvalId);
      const [stale] = await h.db.select().from(schema.approvals).where(eq(schema.approvals.id, moved.approvalId));
      expect(stale!.revokeReason).toBe('restore_stale');
      expect(stale!.payloadHash).toBe(moved.hash);
      const [ok] = await h.db.select().from(schema.approvals).where(eq(schema.approvals.id, kept.approvalId));
      expect(ok!.revokedAt).toBeNull();
      const [kv] = await h.db.select().from(schema.variants).where(eq(schema.variants.id, kept.variantId));
      expect(kv!.lifecycle).toBe('approved');
      expect(p.preview.revoked_approvals).toEqual(r.revoked_approvals);
      const [kp] = await h.db.select().from(schema.distributionPlans).where(eq(schema.distributionPlans.id, kept.planId));
      expect(kp!.status).toBe('approved');
    } finally {
      await h.close();
    }
  });

  it('묶음의 payload 를 바꾸면(hash 불일치) 묶음 전체 거부', async () => {
    const exported = await exportOwner(db, new LocalStorageAdapter(path.join(tmp, 'assets')), ownerA, { outDir: path.join(tmp, 'dist-exports2') });
    const parsed = await parseBundleZip(new Uint8Array(readFileSync(exported.zipPath)));
    const tables = structuredClone(parsed.tables) as BundleTables;
    tables.distribution_items[0]!.payload_json = { ...tables.distribution_items[0]!.payload_json, visibility: 'public' };
    const zip = writeZip(
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
    await expect(parseBundleZip(zip)).rejects.toMatchObject({ code: 'integrity' });
  });
});

describe('HTML 폼', () => {
  it('승인 폼: 항목 체크 없음 → no_items, 확인 체크 없음 → confirm_required(리다이렉트)', async () => {
    const v = await reviewVariant('threads');
    const p = await planFor(v.variantId);
    const item = p.items[0]!;
    const form = (fields: Record<string, string>) =>
      approvePOST(
        new Request(`${BASE}/api/distribution-plans/${p.plan.id}/approve`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', ...ORIGIN_HEADERS, ...cookieHeader(tokenA) },
          body: new URLSearchParams(fields).toString(),
        }),
        ctx(p.plan.id),
      );
    let res = await form({ [`hash_${item.id}`]: item.payload_hash, purpose: 'mock_publish', confirm: 'yes' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/distribute/${p.plan.id}?error=no_items`);
    res = await form({ [`hash_${item.id}`]: item.payload_hash, [`item_${item.id}`]: 'on', purpose: 'mock_publish' });
    expect(res.headers.get('location')).toBe(`/distribute/${p.plan.id}?error=confirm_required`);
    res = await form({ [`hash_${item.id}`]: item.payload_hash, [`item_${item.id}`]: 'on', purpose: 'mock_publish', confirm: 'yes' });
    expect(res.headers.get('location')).toBe(`/distribute/${p.plan.id}?approved=1`);
  });
});
