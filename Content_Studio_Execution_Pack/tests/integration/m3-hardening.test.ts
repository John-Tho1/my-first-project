/**
 * T12(결정 D19) — T10·T11 검토 질문을 코드로 닫는 시험:
 * C1 브랜드 프로필 새 버전 → 승인 무효(brand_changed) / C2 첨부 교체·checksum 변조 → 무효·실행 거부 / C3 복원이 승인·결과·의도·시나리오를
 * 잘못 들여오지 않음 / C4 실행 command_key 다른 계획 재사용 409·같은 key 경합 / C6 RETRY_WAIT 철회 두 시점 / C7 RECONCILING 취소 두 결과 /
 * C8 재시작 → UNKNOWN → 옛 원격 재확인 / 모의 시나리오 API 가드(모의 계정만·hash·승인 불변·트리거) / 재시도 거부 사유.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import {
  appendVariantVersion,
  approveItems,
  cancelItem,
  closeDb,
  commitRestore,
  createBrandProfileVersion,
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
  reconcileItem,
  retryItem,
  runJobsTick,
  schema,
  seed,
  setMockScenario,
  setVariantAssets,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { buildAssetKey, buildBundle, loadConfig, writeZip, type BundleTables, type Channel } from '@cs/domain';
import { createMockAdapterRegistry, LocalStorageAdapter, MockChannelAdapter, MockChannelAdapterRegistry } from '@cs/providers';
import { PUT as scenarioPUT } from '../../apps/web/app/api/distribution-items/[id]/mock-scenario/route';
import { POST as retryPOST } from '../../apps/web/app/api/distribution-items/[id]/retry/route';
import { POST as executePOST } from '../../apps/web/app/api/distribution-plans/[id]/execute/route';
import { BASE, cookieHeader, jsonPost, login } from './helpers';

const config = loadConfig({});
const BODY = '# 해외 영업 첫 분기\n\n대리점과 재고 기준을 먼저 합의했다.\n\n가격표는 마지막에 확정했다.';

let db: Db;
let tmp: string;
const registry = createMockAdapterRegistry();
const adapter = registry.mock;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const as = (identity: string) => vi.stubEnv('AUTH_ALLOWED_IDENTITY', identity);

interface Owner {
  id: string;
  identity: string;
  token: string;
  accounts: Record<Channel, string>;
}

async function putAsset(ownerId: string, mime: string) {
  const id = randomUUID();
  const bytes = new TextEncoder().encode(`${mime}:${id}`);
  const key = buildAssetKey(ownerId, id);
  await new LocalStorageAdapter(path.join(tmp, 'assets')).put(key, bytes);
  await insertAsset(db, { id, ownerId, key, mime, bytes: bytes.byteLength, checksum: createHash('sha256').update(bytes).digest('hex'), rightsStatus: 'owned', verificationState: 'VERIFIED' });
  return id;
}

async function newOwner(): Promise<Owner> {
  const identity = `m3hard-${randomUUID().slice(0, 8)}@example.local`;
  const { ownerId } = await seed(db, { allowedIdentity: identity });
  const accounts = Object.fromEntries((await listChannelAccounts(db, ownerId)).map((a) => [a.platform, a.id])) as Record<Channel, string>;
  as(identity);
  return { id: ownerId, identity, token: await login(identity), accounts };
}

async function reviewVariant(o: Owner, channel: Channel, image?: string) {
  const { content } = await createContent(db, o.id, { title: `강화 ${channel}`, body: BODY });
  const { variant } = await createVariantDraft(db, o.id, content.id, { channel, baseVersion: 1 });
  let base = 1;
  if (channel === 'instagram') {
    await setVariantAssets(db, o.id, variant.id, { baseVersion: 1, assets: [{ assetId: image ?? (await putAsset(o.id, 'image/png')), position: 1, role: 'image' }] });
    base = 2;
  }
  await setVariantLifecycle(db, o.id, variant.id, { lifecycle: 'review', baseVersion: base });
  return { variantId: variant.id, contentId: content.id, base };
}

async function approved(o: Owner, channel: Channel = 'threads', image?: string) {
  const v = await reviewVariant(o, channel, image);
  const { plan, items } = await createPlan(db, o.id, { items: [{ variant_id: v.variantId, channel_account_id: o.accounts[channel] }] });
  const a = await approveItems(db, o.id, plan.id, { item_ids: [items[0]!.id], expected_hashes: { [items[0]!.id]: items[0]!.payloadHash }, confirm: true, purpose: 'mock_publish' });
  return { ...v, planId: plan.id, itemId: items[0]!.id, hash: items[0]!.payloadHash, approvalId: a.approvals[0]!.id };
}

async function executed(o: Owner, channel: Channel = 'threads') {
  const x = await approved(o, channel);
  const ex = await executePlan(db, o.id, x.planId, { commandKey: `hard-${randomUUID()}` }, config);
  return { ...x, jobId: ex.queued[0]!.job_id };
}

function tick(o: Owner, offsetSec = 0, reg: MockChannelAdapterRegistry = registry) {
  return runJobsTick(db, reg, { workerId: 'hard-w', config, ownerId: o.id, clock: () => new Date(Date.now() + offsetSec * 1000), random: () => 0.5, submitTimeoutMs: 500, maxJobs: 10 });
}

const itemRow = async (id: string) => (await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, id)))[0]!;
const planRow = async (id: string) => (await db.select().from(schema.distributionPlans).where(eq(schema.distributionPlans.id, id)))[0]!;
const approvalRow = async (id: string) => (await db.select().from(schema.approvals).where(eq(schema.approvals.id, id)))[0]!;
const variantRow = async (id: string) => (await db.select().from(schema.variants).where(eq(schema.variants.id, id)))[0]!;
const jobRow = async (id: string) => (await db.select().from(schema.jobs).where(eq(schema.jobs.id, id)))[0]!;
const intentsOf = (jobId: string) => db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, jobId)).orderBy(asc(schema.sendIntents.attempt));
const pubsOf = (itemId: string) => db.select().from(schema.publications).where(eq(schema.publications.itemId, itemId));
const eventNames = async (jobId: string) =>
  (await db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId)).orderBy(asc(schema.jobEvents.eventSeq))).map(
    (e) => (e.sanitizedDetails as { transition?: string; event?: string }).transition ?? (e.sanitizedDetails as { event?: string }).event,
  );

const BRAND_V2 = { pen_name: '새 필명', audience: '해외 영업 실무자', pillars: ['해외 영업'], style_rules: [], tone: 'formal' as const, avoid_phrases: [], cta_rules: [], sample_texts: [] };

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-t12-hard-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  db = (await getDb(loadConfig())).db;
});
beforeEach(() => adapter.reset());
afterAll(async () => {
  vi.unstubAllEnvs();
  await closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('모의 시나리오 API(개발용) — 승인 스냅샷 밖', () => {
  it('시나리오 저장은 payload hash·승인·계획 상태를 바꾸지 않는다', async () => {
    const o = await newOwner();
    const x = await approved(o);
    const before = { item: await itemRow(x.itemId), plan: await planRow(x.planId), approval: await approvalRow(x.approvalId) };
    for (const scenario of ['auth', 'hang', 'success']) {
      const res = await scenarioPUT(jsonPost(`/api/distribution-items/${x.itemId}/mock-scenario`, { scenario, delay_ms: 100 }, cookieHeader(o.token)), ctx(x.itemId));
      expect(res.status).toBe(200);
    }
    const after = { item: await itemRow(x.itemId), plan: await planRow(x.planId), approval: await approvalRow(x.approvalId) };
    expect(after.item.payloadHash).toBe(before.item.payloadHash);
    expect(after.item.payloadJson).toEqual(before.item.payloadJson);
    expect(after.item.status).toBe('PLANNED');
    expect(after.approval.revokedAt).toBeNull();
    expect(after.plan.status).toBe(before.plan.status);
    expect(JSON.stringify(after.item.payloadJson)).not.toContain('scenario');
    const rows = await db.select().from(schema.mockScenarios).where(eq(schema.mockScenarios.distributionItemId, x.itemId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scenario: 'success', delayMs: 100 });
    // 실행해도 여전히 승인 그대로 — 시나리오는 실행 결과만 바꾼다(MOCK)
    await executePlan(db, o.id, x.planId, { commandKey: `hard-${randomUUID()}` }, config);
    expect((await tick(o)).results).toEqual({ CONFIRMED: 1 });
  });

  it('가드: 입력 검증 400, 같은 출처 403, 다른 owner 404, 끝난 항목 409, 실제(live) 계정 항목 400 not_mock_account + DB 트리거', async () => {
    const o = await newOwner();
    const other = await newOwner();
    as(o.identity);
    const x = await approved(o);
    const put = (id: string, body: unknown, token = o.token, headers: Record<string, string> = {}) =>
      scenarioPUT(new Request(`${BASE}/api/distribution-items/${id}/mock-scenario`, { method: 'PUT', headers: { 'content-type': 'application/json', accept: 'application/json', origin: BASE, ...cookieHeader(token), ...headers }, body: JSON.stringify(body) }), ctx(id));
    expect((await put(x.itemId, { scenario: 'publish_for_real' })).status).toBe(400);
    expect((await put(x.itemId, { scenario: 'success', delay_ms: 6000 })).status).toBe(400);
    expect((await put(x.itemId, { scenario: 'success', approved: true })).status).toBe(400);
    expect((await put(x.itemId, { scenario: 'success' }, o.token, { origin: 'https://evil.example' })).status).toBe(403);
    as(other.identity);
    expect((await put(x.itemId, { scenario: 'success' }, other.token)).status).toBe(404);
    as(o.identity);
    // live 계정 항목(연결된 실제 계정 행을 직접 넣어 흉내 — 외부 호출 없음)
    const [live] = await db
      .insert(schema.channelAccounts)
      .values({ ownerId: o.id, platform: 'threads', kind: 'live', externalAccountId: `threads-live-${randomUUID()}`, displayName: '실제 계정(시험 행)', state: 'connected' })
      .returning();
    const v = await reviewVariant(o, 'threads');
    const { items } = await createPlan(db, o.id, { items: [{ variant_id: v.variantId, channel_account_id: live!.id, requested_result: 'upload_private', visibility: 'private' }] });
    const res = await put(items[0]!.id, { scenario: 'success' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('not_mock_account');
    await expect(db.execute(sql`insert into mock_scenarios (owner_id, distribution_item_id, scenario) values (${o.id}::uuid, ${items[0]!.id}::uuid, 'success')`)).rejects.toThrow();
    await expect(db.execute(sql`insert into mock_scenarios (owner_id, distribution_item_id, scenario) values (${o.id}::uuid, ${x.itemId}::uuid, 'publish_for_real')`)).rejects.toThrow();
    // 끝난 항목
    await executePlan(db, o.id, x.planId, { commandKey: `hard-${randomUUID()}` }, config);
    await tick(o);
    const fin = await put(x.itemId, { scenario: 'auth' });
    expect(fin.status).toBe(409);
    expect((await fin.json()).error).toBe('item_finished');
  });
});

describe('B — 보류 항목 재시도(retry) 규칙', () => {
  it('거부: 보류 아님 not_retryable · 승인 없음 보류(PLANNED) approval_required · 철회된 승인 approval_required · 스냅샷 변경 snapshot_stale · 시도 한도 · 작업 없는 보류(복원) · 다른 owner 404', async () => {
    const o = await newOwner();
    const post = (id: string, token = o.token) => retryPOST(jsonPost(`/api/distribution-items/${id}/retry`, {}, cookieHeader(token)), ctx(id));
    // 보류 아님
    const q = await executed(o);
    expect((await (await post(q.itemId)).json()).error).toBe('not_retryable');
    // 승인 없음 보류: RETRY_WAIT 중 철회 → 즉시 BLOCKED + 항목 PLANNED → 재시도 아닌 다시 승인 후 실행
    const a10 = await executed(o);
    await setMockScenario(db, o.id, a10.itemId, { scenario: 'transient' });
    await tick(o);
    const { revokeApproval } = await import('@cs/db');
    await revokeApproval(db, o.id, a10.approvalId, undefined);
    expect((await itemRow(a10.itemId)).status).toBe('PLANNED');
    const r1 = await post(a10.itemId);
    expect(r1.status).toBe(409);
    expect((await r1.json()).error).toBe('approval_required');
    // 다시 승인 → 새 실행 키로 이 항목만 대기열(새 작업) → CONFIRMED
    await setMockScenario(db, o.id, a10.itemId, { scenario: 'success' });
    await approveItems(db, o.id, a10.planId, { item_ids: [a10.itemId], expected_hashes: { [a10.itemId]: a10.hash }, confirm: true, purpose: 'mock_publish' });
    const ex2 = await executePOST(jsonPost(`/api/distribution-plans/${a10.planId}/execute`, { command_key: `hard-${randomUUID()}` }, cookieHeader(o.token)), ctx(a10.planId));
    expect(ex2.status).toBe(200);
    const ex2Body = await ex2.json();
    expect(ex2Body.queued).toHaveLength(1);
    expect(ex2Body.queued[0].job_id).not.toBe(a10.jobId);
    await tick(o, 3600);
    expect((await itemRow(a10.itemId)).status).toBe('CONFIRMED');
    expect(await intentsOf(a10.jobId)).toHaveLength(1);
    expect(await intentsOf(ex2Body.queued[0].job_id)).toHaveLength(1);
    expect(await pubsOf(a10.itemId)).toHaveLength(1);

    // auth 보류 + 승인 철회 → approval_required(항목은 BLOCKED 그대로)
    const au = await executed(o);
    await setMockScenario(db, o.id, au.itemId, { scenario: 'auth' });
    await tick(o, 7200);
    expect((await itemRow(au.itemId)).status).toBe('BLOCKED');
    await revokeApproval(db, o.id, au.approvalId, undefined);
    expect((await (await post(au.itemId)).json()).error).toBe('approval_required');

    // auth 보류 + 파생본 새 버전(보류 항목은 편집 훅이 철회하지 않는다) → 재시도 때 스냅샷 재검사로 거부, 아무것도 바꾸지 않음
    const st = await executed(o, 'blog');
    await setMockScenario(db, o.id, st.itemId, { scenario: 'auth' });
    await tick(o, 7300);
    await appendVariantVersion(db, o.id, st.variantId, { baseVersion: 1, body: '바뀐 블로그', metadata: { title: '바뀐', markdown: '바뀐 블로그' } });
    const r3 = await post(st.itemId);
    expect(r3.status).toBe(409);
    expect((await r3.json()).error).toBe('snapshot_stale');
    expect((await jobRow(st.jobId)).state).toBe('BLOCKED');

    // 시도 한도
    const ex = await executed(o);
    await setMockScenario(db, o.id, ex.itemId, { scenario: 'auth' });
    await tick(o, 7400);
    await db.update(schema.jobs).set({ attempt: 5 }).where(eq(schema.jobs.id, ex.jobId));
    expect((await (await post(ex.itemId)).json()).error).toBe('attempts_exhausted');

    // 작업 없는 보류(복원된 진행 중 항목 흉내) — 원격 결과를 모르므로 맹목 재전송 금지
    const rs = await approved(o);
    await db.update(schema.distributionItems).set({ status: 'BLOCKED' }).where(eq(schema.distributionItems.id, rs.itemId));
    expect((await (await post(rs.itemId)).json()).error).toBe('not_retryable');

    // 다른 owner
    const other = await newOwner();
    as(other.identity);
    expect((await post(au.itemId, other.token)).status).toBe(404);
    as(o.identity);
  });

  it('결과 불명(ambiguous) 뒤 보류는 없다 — 재시도 함수도 의도가 pending·ambiguous 면 거부(outcome_unknown)', async () => {
    const o = await newOwner();
    const x = await executed(o);
    await setMockScenario(db, o.id, x.itemId, { scenario: 'auth' });
    await tick(o);
    // 마지막 의도를 결과 불명으로 만든 것처럼(DB 트리거는 pending → 값 한 번만 허용하므로 새 시도 의도를 pending 으로 넣는다)
    await db.update(schema.jobs).set({ attempt: 2 }).where(eq(schema.jobs.id, x.jobId));
    await db.insert(schema.sendIntents).values({ ownerId: o.id, jobId: x.jobId, attempt: 2, intentKey: `${x.jobId}:2` });
    await expect(retryItem(db, o.id, x.itemId)).rejects.toMatchObject({ code: 'outcome_unknown' });
  });
});

describe('C1 — 브랜드 프로필 새 버전', () => {
  it('승인된 PLANNED·QUEUED 항목의 승인을 invalidated:brand_changed 로 철회(QUEUED 작업 BLOCKED), 같은 계획 재승인은 snapshot_stale', async () => {
    const o = await newOwner();
    const planned = await approved(o);
    const queued = await executed(o, 'blog');
    const brand = await createBrandProfileVersion(db, o.id, { base_version: 1, ...BRAND_V2 });
    expect(brand.version).toBe(2);
    expect((await approvalRow(planned.approvalId)).revokeReason).toBe('invalidated:brand_changed');
    expect((await approvalRow(queued.approvalId)).revokeReason).toBe('invalidated:brand_changed');
    expect((await jobRow(queued.jobId)).state).toBe('BLOCKED');
    expect((await itemRow(queued.itemId)).status).toBe('PLANNED');
    expect((await variantRow(planned.variantId)).lifecycle).toBe('review');
    expect((await planRow(planned.planId)).status).toBe('draft');
    await expect(
      approveItems(db, o.id, planned.planId, { item_ids: [planned.itemId], expected_hashes: { [planned.itemId]: planned.hash }, confirm: true, purpose: 'mock_publish' }),
    ).rejects.toMatchObject({ code: 'snapshot_stale' });
    expect((await tick(o)).leased).toBe(0);
    // 새 계획은 새 브랜드 버전을 스냅샷에 담는다
    const fresh = await approved(o);
    expect((await itemRow(fresh.itemId)).brandProfileId).toBe(brand.id);
  });

  it('훅을 거치지 않은 브랜드 변경(직접 INSERT)도 실행 재검사(snapshotProblems)가 brand_changed 로 막는다', async () => {
    const o = await newOwner();
    const x = await approved(o);
    await db.insert(schema.brandProfiles).values({ ownerId: o.id, version: 2, penName: '우회', audience: 'x', pillars: ['x'] });
    await expect(executePlan(db, o.id, x.planId, { commandKey: `hard-${randomUUID()}` }, config)).rejects.toMatchObject({ code: 'snapshot_stale' });
    expect((await approvalRow(x.approvalId)).revokeReason).toBe('invalidated:brand_changed');
    expect(await db.select().from(schema.jobs).where(eq(schema.jobs.itemId, x.itemId))).toHaveLength(0);
  });
});

describe('C2 — 첨부 교체·변조', () => {
  it('setVariantAssets 로 다른 checksum 첨부로 바꾸면 invalidated:assets_changed, 원본 checksum 을 제자리에서 바꿔도 실행이 assets_changed 로 거부', async () => {
    const o = await newOwner();
    const img1 = await putAsset(o.id, 'image/png');
    const img2 = await putAsset(o.id, 'image/png');
    const a = await approved(o, 'instagram', img1);
    await setVariantAssets(db, o.id, a.variantId, { baseVersion: a.base, assets: [{ assetId: img2, position: 1, role: 'image' }] });
    expect((await approvalRow(a.approvalId)).revokeReason).toBe('invalidated:assets_changed');

    const img3 = await putAsset(o.id, 'image/png');
    const b = await approved(o, 'instagram', img3);
    // 훅을 거치지 않는 제자리 변조(파일 교체 + checksum 갱신)를 흉내
    await db.execute(sql`update assets set checksum = ${'f'.repeat(64)} where id = ${img3}::uuid`);
    await expect(executePlan(db, o.id, b.planId, { commandKey: `hard-${randomUUID()}` }, config)).rejects.toMatchObject({ code: 'snapshot_stale' });
    expect((await approvalRow(b.approvalId)).revokeReason).toBe('invalidated:assets_changed');
    // 첨부 목록을 직접 늘려도(불변 버전에 행 추가) 실행 재검사가 막는다
    const img4 = await putAsset(o.id, 'image/png');
    const img5 = await putAsset(o.id, 'image/png');
    const c = await approved(o, 'instagram', img4);
    const vv = (await variantRow(c.variantId)).currentVersionId!;
    await db.insert(schema.variantAssets).values({ ownerId: o.id, variantVersionId: vv, assetId: img5, position: 2, role: 'image' });
    await expect(executePlan(db, o.id, c.planId, { commandKey: `hard-${randomUUID()}` }, config)).rejects.toMatchObject({ code: 'snapshot_stale' });
  });
});

describe('C3 — 복원은 승인·결과·의도·시나리오를 믿고 들여오지 않는다', () => {
  it('항목 스냅샷 없는 승인·hash 다른 승인 묶음은 전체 거부, add_missing 은 publications·send_intents·mock_scenarios 를 복원하지 않는다', async () => {
    const o = await newOwner();
    const x = await executed(o);
    await setMockScenario(db, o.id, x.itemId, { scenario: 'success' });
    await tick(o);
    expect(await pubsOf(x.itemId)).toHaveLength(1);
    const exported = await exportOwner(db, new LocalStorageAdapter(path.join(tmp, 'assets')), o.id, { outDir: path.join(tmp, 'exports') });
    for (const t of ['send_intents', 'publications', 'mock_scenarios'] as const) expect(exported.manifest.tables[t]!.rows, t).toBe(1);
    const parsed = await parseBundleZip(new Uint8Array(readFileSync(exported.zipPath)));
    const rebuild = (tables: BundleTables) =>
      writeZip(
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
    // (1) 항목 스냅샷 없이 승인만 — 묶음에 없는 항목을 가리키는 승인
    const orphan = structuredClone(parsed.tables) as BundleTables;
    orphan.approvals.push({ ...orphan.approvals[0]!, id: randomUUID(), distribution_item_id: randomUUID() });
    await expect(parseBundleZip(rebuild(orphan))).rejects.toMatchObject({ code: 'integrity' });
    // (2) 항목 hash 와 다른 승인
    const wrong = structuredClone(parsed.tables) as BundleTables;
    wrong.approvals[0]!.payload_hash = 'a'.repeat(64);
    await expect(parseBundleZip(rebuild(wrong))).rejects.toMatchObject({ code: 'integrity' });
    // (3) 없는 항목을 가리키는 모의 시나리오
    const scen = structuredClone(parsed.tables) as BundleTables;
    scen.mock_scenarios[0]!.distribution_item_id = randomUUID();
    await expect(parseBundleZip(rebuild(scen))).rejects.toMatchObject({ code: 'integrity' });
    // (4) 정상 묶음 → 새 DB 에 add_missing: 계정·계획·항목·승인은 들어오고, 원격 결과·전송 의도·시나리오·작업은 들어오지 않는다
    const h = await createTestDb();
    try {
      const target = (await ensureOwner(h.db, 'restore-t12@example.local')).id;
      const restoresDir = path.join(tmp, 'restores');
      const p = await createRestorePreview(h.db, target, rebuild(structuredClone(parsed.tables) as BundleTables), { restoresDir, source: 'upload' });
      for (const t of ['publications', 'send_intents', 'mock_scenarios', 'jobs'] as const) expect(p.preview.tables[t], t).toMatchObject({ restored: false });
      const r = await commitRestore(h.db, new LocalStorageAdapter(path.join(tmp, 'assets-r')), target, p.restoreId, { mode: 'add_missing', confirm: true, restoresDir });
      expect(r.restored.approvals).toBe(1);
      for (const t of [schema.publications, schema.sendIntents, schema.mockScenarios, schema.jobs] as const) {
        expect((await h.db.select({ n: count() }).from(t))[0]!.n).toBe(0);
      }
      // 복원된 CONFIRMED 항목은 결과 행 없이 CONFIRMED(원격은 복원 환경에서 다시 확인할 사실)
      const [it] = await h.db.select().from(schema.distributionItems).where(and(eq(schema.distributionItems.ownerId, target), eq(schema.distributionItems.id, x.itemId)));
      expect(it!.status).toBe('CONFIRMED');
    } finally {
      await h.close();
    }
  });
});

describe('C4 — 실행 멱등', () => {
  it('같은 command_key 를 다른 계획에 쓰면 409 command_key_reused(다른 계획의 결과를 돌려주지 않음), 같은 key 동시 실행은 하나만 큐잉', async () => {
    const o = await newOwner();
    const p1 = await approved(o);
    const p2 = await approved(o);
    const key = `hard-${randomUUID()}`;
    const first = await executePlan(db, o.id, p1.planId, { commandKey: key }, config);
    expect(first.idempotent_replay).toBe(false);
    await expect(executePlan(db, o.id, p2.planId, { commandKey: key }, config)).rejects.toMatchObject({ code: 'command_key_reused' });
    const res = await executePOST(jsonPost(`/api/distribution-plans/${p2.planId}/execute`, { command_key: key }, cookieHeader(o.token)), ctx(p2.planId));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('command_key_reused');
    expect(await db.select().from(schema.jobs).where(eq(schema.jobs.itemId, p2.itemId))).toHaveLength(0);
    expect((await itemRow(p2.itemId)).status).toBe('PLANNED');
    // 같은 key 동시 실행(경합) — 하나는 새로, 하나는 같은 결과 재생
    const p3 = await approved(o);
    const k3 = `hard-${randomUUID()}`;
    const both = await Promise.all([executePlan(db, o.id, p3.planId, { commandKey: k3 }, config), executePlan(db, o.id, p3.planId, { commandKey: k3 }, config)]);
    expect(both.map((b) => b.idempotent_replay).sort()).toEqual([false, true]);
    expect(both[0]!.queued).toEqual(both[1]!.queued);
    expect(await db.select().from(schema.jobs).where(eq(schema.jobs.itemId, p3.itemId))).toHaveLength(1);
    expect(await db.select().from(schema.executeCommands).where(and(eq(schema.executeCommands.ownerId, o.id), eq(schema.executeCommands.commandKey, k3)))).toHaveLength(1);
  });
});

describe('C6 — A10 두 시점', () => {
  it('(1) 사용자 철회는 RETRY_WAIT 를 즉시 막고 (2) 훅을 거치지 않은 철회(직접 UPDATE)는 다음 전송 직전 재검사가 approval_missing 으로 막는다', async () => {
    const o = await newOwner();
    const a = await executed(o);
    const b = await executed(o, 'blog');
    await setMockScenario(db, o.id, a.itemId, { scenario: 'transient' });
    await setMockScenario(db, o.id, b.itemId, { scenario: 'transient' });
    await tick(o);
    expect((await jobRow(a.jobId)).state).toBe('RETRY_WAIT');
    expect((await jobRow(b.jobId)).state).toBe('RETRY_WAIT');
    const { revokeApproval } = await import('@cs/db');
    const rv = await revokeApproval(db, o.id, a.approvalId, '재시도 중 철회');
    expect(rv.blockedJobIds).toEqual([a.jobId]);
    expect((await jobRow(a.jobId)).state).toBe('BLOCKED');
    expect((await itemRow(a.itemId)).status).toBe('PLANNED');
    expect((await eventNames(a.jobId)).at(-1)).toBe('blocked');
    // (2) 훅 우회
    await db.update(schema.approvals).set({ revokedAt: new Date(), revokeReason: 'direct' }).where(eq(schema.approvals.id, b.approvalId));
    expect((await jobRow(b.jobId)).state).toBe('RETRY_WAIT');
    await setMockScenario(db, o.id, b.itemId, { scenario: 'success' });
    const r = await tick(o, 20 * 60);
    expect(r.results).toEqual({ BLOCKED: 1 });
    expect((await jobRow(b.jobId)).lastErrorCode).toBe('approval_missing');
    expect(await intentsOf(a.jobId)).toHaveLength(1);
    expect(await intentsOf(b.jobId)).toHaveLength(1);
  });
});

describe('C7 — 확인 중(RECONCILING) 취소', () => {
  it('원격이 이미 받았으면 CONFIRMED + cancel_too_late(취소 성공이라 하지 않음), 원격에 없으면 CANCELED — 어느 쪽도 재전송 없음', async () => {
    const o = await newOwner();
    const sent = await executed(o);
    const notSent = await executed(o, 'blog');
    await setMockScenario(db, o.id, sent.itemId, { scenario: 'ambiguous_sent' });
    await setMockScenario(db, o.id, notSent.itemId, { scenario: 'ambiguous_not_sent' });
    await tick(o);
    for (const x of [sent, notSent]) {
      expect((await jobRow(x.jobId)).state).toBe('RECONCILING');
      expect(await cancelItem(db, o.id, x.itemId)).toMatchObject({ cancel_requested: true, message: '취소 확인 중' });
      expect((await itemRow(x.itemId)).status).toBe('CANCEL_REQUESTED');
    }
    const r = await tick(o, 11);
    expect(r.results).toEqual({ CONFIRMED: 1, CANCELED: 1 });
    expect(await eventNames(sent.jobId)).toEqual(['execute', 'lease', 'send_start', 'ambiguous', 'cancel_requested', 'cancel_too_late']);
    expect(await pubsOf(sent.itemId)).toHaveLength(1);
    expect((await eventNames(notSent.jobId)).at(-1)).toBe('canceled');
    expect(await pubsOf(notSent.itemId)).toHaveLength(0);
    expect(adapter.calls.submit).toBe(2);
  });

  it('cancel_supported: 원격 처리 중 취소 → 어댑터 원격 취소 → CANCELED(원격 취소), 결과 없음', async () => {
    const o = await newOwner();
    const x = await executed(o);
    await setMockScenario(db, o.id, x.itemId, { scenario: 'cancel_supported' });
    expect((await tick(o)).results).toEqual({ REMOTE_PROCESSING: 1 });
    expect(await cancelItem(db, o.id, x.itemId)).toMatchObject({ cancel_requested: true });
    expect((await tick(o, 16)).results).toEqual({ CANCELED: 1 });
    expect(adapter.calls.cancel).toBe(1);
    expect(await pubsOf(x.itemId)).toHaveLength(0);
  });
});

describe('C8 — 재시작 뒤 결과 불명', () => {
  it('ambiguous_sent → 새 모의 원격(빈 지도)으로 3회 확인 불가 → UNKNOWN(재전송 없음, 계획 attention) → 옛 원격으로 사용자 재확인 → CONFIRMED(계획 completed)', async () => {
    const o = await newOwner();
    const x = await executed(o);
    await setMockScenario(db, o.id, x.itemId, { scenario: 'ambiguous_sent' });
    const oldRemote = new MockChannelAdapterRegistry(new MockChannelAdapter({ readEnv: false }));
    await tick(o, 0, oldRemote);
    expect((await jobRow(x.jobId)).state).toBe('RECONCILING');
    const fresh = new MockChannelAdapter({ readEnv: false });
    const freshReg = new MockChannelAdapterRegistry(fresh);
    await tick(o, 11, freshReg);
    await tick(o, 11 + 21, freshReg);
    await tick(o, 11 + 21 + 41, freshReg);
    expect((await jobRow(x.jobId)).state).toBe('UNKNOWN');
    expect((await planRow(x.planId)).status).toBe('attention');
    expect(fresh.calls.submit).toBe(0);
    expect((await tick(o, 86_400, freshReg)).leased).toBe(0);
    const r = await reconcileItem(db, freshReg, o.id, x.itemId);
    expect(r).toMatchObject({ state: 'UNKNOWN', found: false });
    const r2 = await reconcileItem(db, oldRemote, o.id, x.itemId);
    expect(r2).toMatchObject({ state_before: 'UNKNOWN', state: 'CONFIRMED', found: true });
    expect(await intentsOf(x.jobId)).toHaveLength(1);
    expect(await pubsOf(x.itemId)).toHaveLength(1);
    expect((await planRow(x.planId)).status).toBe('completed');
  });

  it('reconcile_unsupported: 조회 불가 채널 → 3회 뒤 UNKNOWN, 사용자 재확인도 조회만(상태 그대로), 재전송 0', async () => {
    const o = await newOwner();
    const x = await executed(o);
    await setMockScenario(db, o.id, x.itemId, { scenario: 'reconcile_unsupported' });
    await tick(o);
    await tick(o, 11);
    await tick(o, 11 + 21);
    await tick(o, 11 + 21 + 41);
    expect((await jobRow(x.jobId)).state).toBe('UNKNOWN');
    expect(await reconcileItem(db, registry, o.id, x.itemId)).toMatchObject({ state: 'UNKNOWN', remote: 'unsupported' });
    expect(adapter.calls.submit).toBe(1);
  });
});
