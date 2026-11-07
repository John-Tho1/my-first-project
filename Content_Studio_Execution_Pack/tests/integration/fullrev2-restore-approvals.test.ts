/**
 * FIX2-FULLREV2(G18·G19): 복원(add_missing)과 활성 승인.
 *  G18(D6 "기존 행 UPDATE 없음"): 승인·작업·전송 의도·원격 결과·원격 단계는 부모(배포 항목·작업·의도)가 **이번 복원에서 넣은** 행일 때만 넣는다.
 *      이미 있던(동일) 항목에 승인을 붙이면 그 계획 상태·파생본 lifecycle 은 다시 계산되지 않아(계획 '초안'인데 활성 승인, 재승인 409 already_approved)
 *      어긋났다 → existing_parent 충돌로 보고하고 넣지 않는다. 미리보기와 커밋이 같다. 새 환경 복원은 그대로 승인을 넣는다.
 *  G19(D19-a): add_missing 으로 더 높은 브랜드 프로필 버전이 들어와 현재 브랜드가 바뀌면, 이 환경에 이미 있던 활성 승인을 브랜드 훅과 같은 규칙으로
 *      invalidated:brand_changed 로 무효로 하고(대기 작업 BLOCKED·항목 PLANNED) 미리보기·결과의 invalidated_approvals 로 보고한다.
 *      더 높은 브랜드 버전이 없으면 아무것도 무효로 하지 않는다.
 *  G9(D40-2) 복원 쪽: 묶음에서 들어온 활성 승인도 같은 재검사(snapshotProblems)로 원고의 아이디어 위험 표시 '확인 필요'면 restore_stale 로 철회되고,
 *      복원 훈련의 독립 기대값(deriveRestoreTransforms)도 같은 승인을 철회 집합에 넣는다.
 * 모의 계정·모의 LLM 만 — 외부 호출 없음. 저장소는 임시 폴더만.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  approveItems,
  commitRestore,
  createBrandProfileVersion,
  createCapture,
  createContent,
  createIdea,
  createPlan,
  createRestorePreview,
  createTestDb,
  createVariantDraft,
  deriveRestoreTransforms,
  ensureOwner,
  executePlan,
  exportOwner,
  linkContentCaptures,
  listChannelAccounts,
  parseBundleZip,
  schema,
  seed,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { loadConfig } from '@cs/domain';
import { LocalStorageAdapter } from '@cs/providers';

type Handle = Awaited<ReturnType<typeof createTestDb>>;
let tmp: string;
const config = loadConfig({});
const BRAND = { pen_name: '복원 필명', audience: '해외 영업 실무자', pillars: ['해외 영업'], style_rules: [], tone: 'formal' as const, avoid_phrases: [], cta_rules: [], sample_texts: [] };

beforeAll(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-fr2-g18-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function exportZip(source: Db, owner: string, tag: string): Promise<Uint8Array> {
  const ex = await exportOwner(source, new LocalStorageAdapter(path.join(tmp, `assets-src-${tag}`)), owner, { outDir: path.join(tmp, `exports-${tag}`) });
  return new Uint8Array(readFileSync(ex.zipPath));
}
const restoresDir = (tag: string) => path.join(tmp, `restores-${tag}`);
const preview = (target: Db, owner: string, zip: Uint8Array, tag: string) => createRestorePreview(target, owner, zip, { restoresDir: restoresDir(tag), source: 'upload' });
const commit = (target: Db, owner: string, restoreId: string, tag: string, mode: 'empty_only' | 'add_missing') =>
  commitRestore(target, new LocalStorageAdapter(path.join(tmp, `assets-dst-${tag}`)), owner, restoreId, { mode, confirm: true, restoresDir: restoresDir(tag) });
const restore = async (target: Db, owner: string, zip: Uint8Array, tag: string, mode: 'empty_only' | 'add_missing') => {
  const p = await preview(target, owner, zip, tag);
  return { preview: p.preview, result: await commit(target, owner, p.restoreId, tag, mode) };
};

const planRow = async (d: Db, id: string) => (await d.select().from(schema.distributionPlans).where(eq(schema.distributionPlans.id, id)))[0]!;
const itemRow = async (d: Db, id: string) => (await d.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, id)))[0]!;
const variantRow = async (d: Db, id: string) => (await d.select().from(schema.variants).where(eq(schema.variants.id, id)))[0]!;
const approvalsOf = (d: Db, itemId: string) => d.select().from(schema.approvals).where(eq(schema.approvals.distributionItemId, itemId));
const jobsOf = (d: Db, itemId: string) => d.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId));

/** 원본: seed → (브랜드 extraBrands 개 새 버전) → 원고·Threads 파생본(review)·계획(항목 PLANNED). */
async function source(extraBrands = 0) {
  const a = await createTestDb();
  const { ownerId } = await seed(a.db, { allowedIdentity: `fr2-g18-src-${randomUUID().slice(0, 6)}@example.local` });
  for (let i = 0; i < extraBrands; i++) await createBrandProfileVersion(a.db, ownerId, { base_version: i + 1, ...BRAND, pen_name: `복원 필명 v${i + 2}` });
  const threads = (await listChannelAccounts(a.db, ownerId)).find((x) => x.platform === 'threads' && x.kind === 'mock')!.id;
  const { content } = await createContent(a.db, ownerId, { title: 'G18 복원', body: `복원 승인 시험 글 ${randomUUID().slice(0, 6)}` });
  const { variant } = await createVariantDraft(a.db, ownerId, content.id, { channel: 'threads', baseVersion: 1 });
  await setVariantLifecycle(a.db, ownerId, variant.id, { lifecycle: 'review', baseVersion: 1 });
  const { plan, items } = await createPlan(a.db, ownerId, { items: [{ variant_id: variant.id, channel_account_id: threads }] });
  return { a, owner: ownerId, planId: plan.id, itemId: items[0]!.id, hash: items[0]!.payloadHash, variantId: variant.id };
}
const approveIn = (d: Db, owner: string, s: { planId: string; itemId: string; hash: string }) =>
  approveItems(d, owner, s.planId, { item_ids: [s.itemId], expected_hashes: { [s.itemId]: s.hash }, confirm: true, purpose: 'mock_publish' });

async function withDbs(fn: (s: Awaited<ReturnType<typeof source>>, b: Handle, target: string) => Promise<void>, extraBrands = 0) {
  const s = await source(extraBrands);
  const b = await createTestDb();
  try {
    const target = (await ensureOwner(b.db, `fr2-g18-dst-${randomUUID().slice(0, 6)}@example.local`)).id;
    await fn(s, b, target);
  } finally {
    await b.close();
    await s.a.close();
  }
}

describe('FIX2-FULLREV2(G18): add_missing 은 이미 있던(동일) 배포 항목에 승인을 붙이지 않는다', () => {
  it('empty_only 복원 → 원본에서 승인 → 다시 내보내 add_missing: 승인은 existing_parent 충돌(미리보기·커밋 같음), 대상의 계획·파생본·항목 그대로, 대상에서 다시 승인 200', async () => {
    await withDbs(async (s, b, target) => {
      const tag = randomUUID().slice(0, 6);
      await restore(b.db, target, await exportZip(s.a.db, s.owner, `${tag}-1`), tag, 'empty_only');
      const planBefore = await planRow(b.db, s.planId);
      expect(planBefore.status).toBe('draft');
      expect((await variantRow(b.db, s.variantId)).lifecycle).toBe('review');

      const granted = await approveIn(s.a.db, s.owner, s);
      const approvalId = granted.approvals[0]!.id;
      expect((await planRow(s.a.db, s.planId)).status).toBe('approved');
      const zip2 = await exportZip(s.a.db, s.owner, `${tag}-2`);

      const p = await preview(b.db, target, zip2, tag);
      expect(p.preview.conflicts).toContainEqual({ table: 'approvals', id: approvalId, reason: 'existing_parent' });
      // 항목은 같음(승인은 항목 행을 바꾸지 않는다), 계획·파생본은 다름
      expect(p.preview.tables.distribution_items).toMatchObject({ new: 0, existing_same: 1 });
      expect(p.preview.tables.approvals).toMatchObject({ new: 0, existing_different: 1 });
      expect(p.preview.revoked_approvals).toEqual([]);

      const r = await commit(b.db, target, p.restoreId, tag, 'add_missing');
      expect(r.conflicts).toContainEqual({ table: 'approvals', id: approvalId, reason: 'existing_parent' });
      expect(r.conflicts.filter((c) => c.table === 'approvals')).toEqual(p.preview.conflicts.filter((c) => c.table === 'approvals'));
      expect(r.restored.approvals).toBe(0);
      expect(await approvalsOf(b.db, s.itemId)).toEqual([]);
      // 대상의 계획·파생본·항목은 바뀌지 않았다(어긋난 활성 승인 없음)
      expect(await planRow(b.db, s.planId)).toEqual(planBefore);
      expect((await variantRow(b.db, s.variantId)).lifecycle).toBe('review');
      expect((await itemRow(b.db, s.itemId)).status).toBe('PLANNED');

      // 이 환경에서 다시 승인할 수 있다(전에는 409 already_approved)
      const again = await approveIn(b.db, target, s);
      expect(again.approvals).toHaveLength(1);
      expect((await planRow(b.db, s.planId)).status).toBe('approved');
      expect((await variantRow(b.db, s.variantId)).lifecycle).toBe('approved');
    });
  });

  it('새 환경(빈 대상)에 같은 묶음을 복원하면 승인은 그대로 들어가고 계획 상태가 다시 계산된다(변경 없음)', async () => {
    await withDbs(async (s, b, target) => {
      const tag = randomUUID().slice(0, 6);
      const granted = await approveIn(s.a.db, s.owner, s);
      const { preview: pv, result } = await restore(b.db, target, await exportZip(s.a.db, s.owner, tag), tag, 'empty_only');
      expect(pv.conflicts).toEqual([]);
      expect(result.conflicts).toEqual([]);
      expect(result.restored.approvals).toBe(1);
      const [a] = await approvalsOf(b.db, s.itemId);
      expect(a!.id).toBe(granted.approvals[0]!.id);
      expect(a!.revokedAt).toBeNull();
      expect((await planRow(b.db, s.planId)).status).toBe('approved');
      expect((await variantRow(b.db, s.variantId)).lifecycle).toBe('approved');
    });
  });
});

describe('FIX2-FULLREV2(G19): add_missing 으로 현재 브랜드가 바뀌면 기존 활성 승인을 무효로 하고 보고한다', () => {
  /** 원본(브랜드 v1~v3) → 대상 empty_only → 대상에서 승인·실행(QUEUED, 브랜드 v3). */
  async function queuedInTarget(s: Awaited<ReturnType<typeof source>>, b: Handle, target: string, tag: string) {
    await restore(b.db, target, await exportZip(s.a.db, s.owner, `${tag}-1`), `${tag}-1`, 'empty_only');
    const granted = await approveIn(b.db, target, s);
    const ex = await executePlan(b.db, target, s.planId, { commandKey: `g19-${randomUUID()}` }, config);
    expect((await itemRow(b.db, s.itemId)).status).toBe('QUEUED');
    const brands = await b.db.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.ownerId, target));
    expect(Math.max(...brands.map((x) => x.version))).toBe(3);
    return { approvalId: granted.approvals[0]!.id, jobId: ex.queued[0]!.job_id };
  }

  it('묶음에 브랜드 v4·v5 → 승인 invalidated:brand_changed·항목 PLANNED·작업 BLOCKED, 미리보기와 결과에 보고', async () => {
    await withDbs(async (s, b, target) => {
      const tag = randomUUID().slice(0, 6);
      const q = await queuedInTarget(s, b, target, tag);
      await createBrandProfileVersion(s.a.db, s.owner, { base_version: 3, ...BRAND, pen_name: '복원 필명 v4' });
      await createBrandProfileVersion(s.a.db, s.owner, { base_version: 4, ...BRAND, pen_name: '복원 필명 v5' });
      const zip2 = await exportZip(s.a.db, s.owner, `${tag}-2`);
      const expected = [{ approval_id: q.approvalId, item_id: s.itemId, reasons: ['brand_changed'], blocked_job_ids: [q.jobId], partial_job_ids: [], leased_partial_job_ids: [], in_flight: false, restored_review: false }]; // FIX1-FULLREV3(H3): 부분 게시 없음·진행 중 아님도 정확히(H3 후속: lease 된 부분 게시 작업도 없음) · FIX2-FULLREV3(K2): 복원 표시 보류 항목 아님도 정확히

      const p = await preview(b.db, target, zip2, `${tag}-2`);
      expect(p.preview.tables.brand_profiles).toMatchObject({ new: 2 });
      expect(p.preview.invalidated_approvals).toEqual(expected);
      expect(p.preview.revoked_approvals).toEqual([]);
      // 미리보기는 아무것도 바꾸지 않는다
      expect((await approvalsOf(b.db, s.itemId))[0]!.revokedAt).toBeNull();
      expect((await itemRow(b.db, s.itemId)).status).toBe('QUEUED');

      const r = await commit(b.db, target, p.restoreId, `${tag}-2`, 'add_missing');
      expect(r.invalidated_approvals).toEqual(expected);
      const [a] = await approvalsOf(b.db, s.itemId);
      expect(a!.revokeReason).toBe('invalidated:brand_changed');
      expect((await itemRow(b.db, s.itemId)).status).toBe('PLANNED');
      const [j] = await jobsOf(b.db, s.itemId);
      expect(j!.state).toBe('BLOCKED');
      expect(j!.lastErrorCode).toBe('approval_invalidated');
      expect((await planRow(b.db, s.planId)).status).not.toBe('executing');
      expect((await variantRow(b.db, s.variantId)).lifecycle).toBe('review');
    }, 2);
  });

  it('묶음에 더 높은 브랜드 버전이 없으면 아무것도 무효로 하지 않는다(승인·대기 그대로, 보고 빈 목록)', async () => {
    await withDbs(async (s, b, target) => {
      const tag = randomUUID().slice(0, 6);
      await queuedInTarget(s, b, target, tag);
      const { preview: pv, result } = await restore(b.db, target, await exportZip(s.a.db, s.owner, `${tag}-2`), `${tag}-2`, 'add_missing');
      expect(pv.invalidated_approvals).toEqual([]);
      expect(result.invalidated_approvals).toEqual([]);
      expect((await approvalsOf(b.db, s.itemId)).filter((a) => a.revokedAt === null)).toHaveLength(1);
      expect((await itemRow(b.db, s.itemId)).status).toBe('QUEUED');
      expect((await jobsOf(b.db, s.itemId)).map((j) => j.state)).toEqual(['QUEUED']);
    }, 2);
  });
});

describe("FIX2-FULLREV2(G9): 묶음 승인의 원고 아이디어가 '확인 필요'면 복원 재검사가 restore_stale 로 철회하고, 훈련 기대값도 같다", () => {
  it('원본에서 승인 뒤 아이디어 위험 표시를 직접 바꿔 내보냄 → 새 환경 복원: revoked_approvals 에 risk_needs_check, 기대 철회 집합에도 포함', async () => {
    const a = await createTestDb();
    const b = await createTestDb();
    try {
      const { ownerId: src } = await seed(a.db, { allowedIdentity: `fr2-g9-src-${randomUUID().slice(0, 6)}@example.local` });
      const threads = (await listChannelAccounts(a.db, src)).find((x) => x.platform === 'threads' && x.kind === 'mock')!.id;
      const idea = await createIdea(a.db, src, { idea: '복원 위험 표시 아이디어' });
      const { content } = await createContent(a.db, src, { title: 'G9 복원', body: `복원 위험 표시 글 ${randomUUID().slice(0, 6)}`, ideaId: idea.id });
      const { variant } = await createVariantDraft(a.db, src, content.id, { channel: 'threads', baseVersion: 1 });
      await setVariantLifecycle(a.db, src, variant.id, { lifecycle: 'review', baseVersion: 1 });
      const { plan, items } = await createPlan(a.db, src, { items: [{ variant_id: variant.id, channel_account_id: threads }] });
      const s = { planId: plan.id, itemId: items[0]!.id, hash: items[0]!.payloadHash };
      const approvalId = (await approveIn(a.db, src, s)).approvals[0]!.id;
      await a.db.update(schema.ideas).set({ risk: 'needs_check' }).where(eq(schema.ideas.id, idea.id)); // 훅을 거치지 않음 — 묶음에 활성 승인 + '확인 필요'
      const tag = randomUUID().slice(0, 6);
      const zip = await exportZip(a.db, src, tag);
      const target = (await ensureOwner(b.db, `fr2-g9-dst-${tag}@example.local`)).id;
      const { preview: pv, result } = await restore(b.db, target, zip, tag, 'empty_only');
      const expected = [{ approval_id: approvalId, item_id: s.itemId, reasons: ['risk_needs_check'] }];
      expect(pv.revoked_approvals).toEqual(expected);
      expect(result.revoked_approvals).toEqual(expected);
      expect((await approvalsOf(b.db, s.itemId))[0]!.revokeReason).toBe('restore_stale');
      expect([...deriveRestoreTransforms((await parseBundleZip(zip)).tables, new Date()).revokedApprovals]).toEqual([approvalId]);
    } finally {
      await b.close();
      await a.close();
    }
  });
});

describe("FIX2-FULLREV2(G9 fixup): add_missing 이 이미 있던 원고에 '확인 필요' 소재 연결을 넣으면 그 원고의 기존 활성 승인을 무효로 하고 보고한다", () => {
  /** 원본 → 대상 empty_only → 대상에서 승인·실행(QUEUED). 그 뒤 원본에서 같은 원고에 새 소재(위험 표시 risk)를 연결해 다시 내보낸다. */
  async function linkedBundle(s: Awaited<ReturnType<typeof source>>, b: Handle, target: string, tag: string, risk: 'none' | 'needs_check') {
    await restore(b.db, target, await exportZip(s.a.db, s.owner, `${tag}-1`), `${tag}-1`, 'empty_only');
    const granted = await approveIn(b.db, target, s);
    const ex = await executePlan(b.db, target, s.planId, { commandKey: `g9r-${randomUUID()}` }, config);
    expect((await itemRow(b.db, s.itemId)).status).toBe('QUEUED');
    const contentId = (await variantRow(s.a.db, s.variantId)).contentId;
    const { capture } = await createCapture(s.a.db, s.owner, { input_type: 'text', raw_text: `복원 위험 소재 ${tag}`, command_key: `g9r-${tag}` });
    if (risk === 'needs_check') await s.a.db.update(schema.captures).set({ risk: 'needs_check' }).where(eq(schema.captures.id, capture.id));
    await linkContentCaptures(s.a.db, s.owner, contentId, [capture.id]);
    return { approvalId: granted.approvals[0]!.id, jobId: ex.queued[0]!.job_id, zip: await exportZip(s.a.db, s.owner, `${tag}-2`) };
  }

  it("새 소재(확인 필요)를 기존 원고에 잇는 연결 → 미리보기 보고만(변경 없음), 커밋: 승인 invalidated:risk_needs_check·항목 PLANNED·작업 BLOCKED·파생본 review", async () => {
    await withDbs(async (s, b, target) => {
      const tag = randomUUID().slice(0, 6);
      const q = await linkedBundle(s, b, target, tag, 'needs_check');
      const expected = [{ approval_id: q.approvalId, item_id: s.itemId, reasons: ['risk_needs_check'], blocked_job_ids: [q.jobId], partial_job_ids: [], leased_partial_job_ids: [], in_flight: false, restored_review: false }]; // FIX1-FULLREV3(H3): 부분 게시 없음·진행 중 아님도 정확히(H3 후속: lease 된 부분 게시 작업도 없음) · FIX2-FULLREV3(K2): 복원 표시 보류 항목 아님도 정확히

      const p = await preview(b.db, target, q.zip, `${tag}-2`);
      expect(p.preview.tables.contents).toMatchObject({ new: 0, existing_same: 1 });
      expect(p.preview.tables.content_captures).toMatchObject({ new: 1 });
      expect(p.preview.invalidated_approvals).toEqual(expected);
      expect(p.preview.revoked_approvals).toEqual([]);
      // 미리보기는 아무것도 바꾸지 않는다
      expect((await approvalsOf(b.db, s.itemId))[0]!.revokedAt).toBeNull();
      expect((await itemRow(b.db, s.itemId)).status).toBe('QUEUED');
      expect((await jobsOf(b.db, s.itemId)).map((j) => j.state)).toEqual(['QUEUED']);
      expect(await b.db.select().from(schema.contentCaptures).where(eq(schema.contentCaptures.ownerId, target))).toEqual([]);

      const r = await commit(b.db, target, p.restoreId, `${tag}-2`, 'add_missing');
      expect(r.invalidated_approvals).toEqual(expected);
      const [a] = await approvalsOf(b.db, s.itemId);
      expect(a!.revokeReason).toBe('invalidated:risk_needs_check');
      expect((await itemRow(b.db, s.itemId)).status).toBe('PLANNED');
      const [j] = await jobsOf(b.db, s.itemId);
      expect(j!.state).toBe('BLOCKED');
      expect(j!.lastErrorCode).toBe('approval_invalidated');
      expect((await planRow(b.db, s.planId)).status).not.toBe('executing');
      expect((await variantRow(b.db, s.variantId)).lifecycle).toBe('review');
      // 다시 승인하려 해도 위험 표시가 막는다
      await expect(approveIn(b.db, target, s)).rejects.toMatchObject({ code: 'snapshot_stale' });
    });
  });

  it("대조: 연결한 새 소재의 위험 표시가 없음('none')이면 아무것도 무효로 하지 않는다", async () => {
    await withDbs(async (s, b, target) => {
      const tag = randomUUID().slice(0, 6);
      const q = await linkedBundle(s, b, target, tag, 'none');
      const { preview: pv, result } = await restore(b.db, target, q.zip, `${tag}-2`, 'add_missing');
      expect(pv.invalidated_approvals).toEqual([]);
      expect(result.invalidated_approvals).toEqual([]);
      expect(result.restored.content_captures).toBe(1);
      expect((await approvalsOf(b.db, s.itemId)).filter((a) => a.revokedAt === null)).toHaveLength(1);
      expect((await itemRow(b.db, s.itemId)).status).toBe('QUEUED');
      expect((await jobsOf(b.db, s.itemId)).map((j) => j.state)).toEqual(['QUEUED']);
    });
  });
});
