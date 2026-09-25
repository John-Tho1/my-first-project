/**
 * T10(결정 D17) 승인 무효화·철회의 공용 핵심. variants.ts·contents.ts(편집 경로)와 distribution.ts(승인·철회·실행)가 함께 쓴다.
 * 이 모듈은 schema·queries 만 import 한다(variants/contents/distribution 과 순환 import 없음).
 *
 * 잠금 순서(교착 방지 — 모든 경로가 같은 순서): contents → variants → distribution_plans → distribution_items → approvals → jobs.
 * 편집 경로(원고·파생본 새 버전)는 이미 content → variant 를 잠근 상태에서 이 모듈을 부른다(PostgreSQL 행 잠금은 같은 트랜잭션에서 재진입 가능).
 *
 * A06: 승인 뒤 본문·첨부·원고·계정이 바뀌면 그 항목의 활성 승인을 revoke_reason='invalidated:<이유>' 로 철회하고,
 * QUEUED 작업은 BLOCKED(+ job_event), QUEUED 항목은 PLANNED 로 되돌린다(시작 전이라 외부 전송 없음). 승인 행은 지우지 않는다.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { canVariantTransition, computePlanStatus, type PlanStatus, type VariantLifecycle } from '@cs/domain';
import { recordAudit, type DbOrTx } from './queries';
import { approvals, contents, distributionItems, distributionPlans, jobEvents, jobs, variants } from './schema';

export type DistributionItemRow = typeof distributionItems.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;

export type InvalidationReason = 'body_changed' | 'assets_changed' | 'content_changed' | 'account_changed' | 'schedule_passed' | 'snapshot_changed';

const sortIds = (ids: Iterable<string>) => [...new Set(ids)].sort();

/**
 * 항목 ID 들을 전역 잠금 순서대로 잠근다: 원고 → 파생본 → 계획 → 항목(id 순, FOR UPDATE). 잠근 항목 행(최신 값)을 id 순으로 돌려준다.
 * owner 가 다른 ID 는 결과에서 빠진다.
 */
export async function lockItemsInOrder(tx: DbOrTx, ownerId: string, itemIds: readonly string[]): Promise<DistributionItemRow[]> {
  const ids = sortIds(itemIds);
  if (ids.length === 0) return [];
  const peek = await tx
    .select({ id: distributionItems.id, planId: distributionItems.planId, variantId: distributionItems.variantId, contentId: variants.contentId })
    .from(distributionItems)
    .innerJoin(variants, and(eq(variants.id, distributionItems.variantId), eq(variants.ownerId, distributionItems.ownerId)))
    .where(and(eq(distributionItems.ownerId, ownerId), inArray(distributionItems.id, ids)));
  const contentIds = sortIds(peek.map((p) => p.contentId));
  const variantIds = sortIds(peek.map((p) => p.variantId));
  const planIds = sortIds(peek.map((p) => p.planId));
  if (contentIds.length) {
    await tx.select({ id: contents.id }).from(contents).where(and(eq(contents.ownerId, ownerId), inArray(contents.id, contentIds))).orderBy(asc(contents.id)).for('update');
  }
  if (variantIds.length) {
    await tx.select({ id: variants.id }).from(variants).where(and(eq(variants.ownerId, ownerId), inArray(variants.id, variantIds))).orderBy(asc(variants.id)).for('update');
  }
  if (planIds.length) {
    await tx
      .select({ id: distributionPlans.id })
      .from(distributionPlans)
      .where(and(eq(distributionPlans.ownerId, ownerId), inArray(distributionPlans.id, planIds)))
      .orderBy(asc(distributionPlans.id))
      .for('update');
  }
  return tx
    .select()
    .from(distributionItems)
    .where(and(eq(distributionItems.ownerId, ownerId), inArray(distributionItems.id, ids)))
    .orderBy(asc(distributionItems.id))
    .for('update');
}

export async function activeApprovalsFor(tx: DbOrTx, ownerId: string, itemIds: readonly string[]): Promise<Map<string, ApprovalRow>> {
  if (itemIds.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(approvals)
    .where(and(eq(approvals.ownerId, ownerId), inArray(approvals.distributionItemId, [...itemIds]), isNull(approvals.revokedAt)))
    .orderBy(asc(approvals.distributionItemId))
    .for('update');
  return new Map(rows.map((a) => [a.distributionItemId, a]));
}

/** 작업 상태 전이 + job_event(작업마다 seq = 최대+1). 호출자가 작업 행을 잠근(항목 잠금 아래) 상태여야 한다. */
export async function transitionJob(
  tx: DbOrTx,
  ownerId: string,
  job: Pick<JobRow, 'id' | 'state'>,
  to: string,
  details: Record<string, unknown>,
  now: Date,
): Promise<void> {
  await tx.update(jobs).set({ state: to, updatedAt: now }).where(and(eq(jobs.id, job.id), eq(jobs.ownerId, ownerId), eq(jobs.state, job.state)));
  const seq = await tx
    .select({ max: sql<number>`coalesce(max(${jobEvents.eventSeq}), 0)::int` })
    .from(jobEvents)
    .where(eq(jobEvents.jobId, job.id));
  await tx.insert(jobEvents).values({
    ownerId,
    jobId: job.id,
    eventSeq: (seq[0]?.max ?? 0) + 1,
    stateBefore: job.state,
    stateAfter: to,
    at: now,
    sanitizedDetails: details,
  });
}

export interface RevokedApproval {
  approvalId: string;
  itemId: string;
  planId: string;
  variantId: string;
  reason: string;
  blockedJobIds: string[];
}

/**
 * 잠근 항목들의 활성 승인을 철회한다(없으면 건너뜀). QUEUED 작업 → BLOCKED(+event), QUEUED 항목 → PLANNED.
 * T11 이후의 진행 상태(LEASED·SENDING…)는 T11 이 CANCEL_REQUESTED 등으로 다룬다 — 여기서는 QUEUED 만.
 */
export async function revokeActiveApprovalsLocked(
  tx: DbOrTx,
  ownerId: string,
  items: readonly DistributionItemRow[],
  reasonOf: (item: DistributionItemRow) => string,
  now: Date,
  audit: { action: 'approval.revoke' | 'approval.invalidate' },
): Promise<RevokedApproval[]> {
  const active = await activeApprovalsFor(
    tx,
    ownerId,
    items.map((i) => i.id),
  );
  const out: RevokedApproval[] = [];
  for (const item of items) {
    const a = active.get(item.id);
    if (!a) continue;
    const reason = reasonOf(item);
    const updated = await tx
      .update(approvals)
      .set({ revokedAt: now, revokeReason: reason })
      .where(and(eq(approvals.id, a.id), eq(approvals.ownerId, ownerId), isNull(approvals.revokedAt)))
      .returning({ id: approvals.id });
    if (!updated[0]) continue;
    const queued = await tx
      .select({ id: jobs.id, state: jobs.state })
      .from(jobs)
      .where(and(eq(jobs.ownerId, ownerId), eq(jobs.itemId, item.id), eq(jobs.state, 'QUEUED')))
      .orderBy(asc(jobs.id))
      .for('update');
    for (const j of queued) {
      await transitionJob(tx, ownerId, j, 'BLOCKED', { event: audit.action === 'approval.revoke' ? 'approval_revoked' : 'approval_invalidated', reason, approval_id: a.id }, now);
    }
    if (item.status === 'QUEUED') {
      await tx
        .update(distributionItems)
        .set({ status: 'PLANNED', updatedAt: now })
        .where(and(eq(distributionItems.id, item.id), eq(distributionItems.ownerId, ownerId), eq(distributionItems.status, 'QUEUED')));
    }
    await recordAudit(tx, {
      ownerId,
      action: audit.action,
      entity: 'approval',
      entityId: a.id,
      versionOrHash: a.payloadHash,
      details: { item_id: item.id, reason, blocked_jobs: queued.length, item_status_before: item.status },
      at: now,
    });
    out.push({ approvalId: a.id, itemId: item.id, planId: item.planId, variantId: item.variantId, reason, blockedJobIds: queued.map((j) => j.id) });
  }
  return out;
}

/** 저장된 계획 상태를 항목·활성 승인으로 다시 계산한다(바뀌면 revision +1). 호출자가 계획을 잠근 상태여야 한다. */
export async function recomputePlanStatus(tx: DbOrTx, ownerId: string, planId: string, now: Date): Promise<PlanStatus> {
  const rows = await tx
    .select({
      status: distributionItems.status,
      // 열 참조를 표 이름으로 한정한다(drizzle 은 단일 표 select 에서 열 이름만 쓰므로 하위 질의 안에서 approvals.id 로 잘못 풀릴 수 있다).
      active: sql<boolean>`exists (select 1 from approvals a where a.distribution_item_id = "distribution_items"."id" and a.revoked_at is null)`,
    })
    .from(distributionItems)
    .where(and(eq(distributionItems.ownerId, ownerId), eq(distributionItems.planId, planId)));
  const status = computePlanStatus(rows.map((r) => ({ status: r.status, activeApproval: Boolean(r.active) })));
  await tx
    .update(distributionPlans)
    .set({ status, revision: sql`${distributionPlans.revision} + 1`, updatedAt: now })
    .where(and(eq(distributionPlans.id, planId), eq(distributionPlans.ownerId, ownerId), sql`${distributionPlans.status} <> ${status}`));
  return status;
}

/**
 * 'approved' 파생본 중 현재 버전을 가리키는 활성 승인이 더는 없는 것을 target 으로 낮춘다(철회 → review, 새 버전·원고 변경 → draft).
 * 호출자가 파생본을 잠근 상태여야 한다.
 */
export async function settleApprovedVariants(
  tx: DbOrTx,
  ownerId: string,
  variantIds: readonly string[],
  target: Extract<VariantLifecycle, 'review' | 'draft'>,
  now: Date,
): Promise<string[]> {
  const changed: string[] = [];
  for (const vid of sortIds(variantIds)) {
    const rows = await tx
      .select({ lifecycle: variants.lifecycle, currentVersionId: variants.currentVersionId, channel: variants.channel })
      .from(variants)
      .where(and(eq(variants.id, vid), eq(variants.ownerId, ownerId)))
      .limit(1);
    const v = rows[0];
    if (!v || v.lifecycle !== 'approved') continue;
    const still = v.currentVersionId
      ? await tx
          .select({ id: approvals.id })
          .from(approvals)
          .innerJoin(distributionItems, and(eq(distributionItems.id, approvals.distributionItemId), eq(distributionItems.ownerId, approvals.ownerId)))
          .where(and(eq(approvals.ownerId, ownerId), isNull(approvals.revokedAt), eq(distributionItems.variantId, vid), eq(distributionItems.variantVersionId, v.currentVersionId)))
          .limit(1)
      : [];
    if (still.length > 0) continue;
    if (!canVariantTransition('approved', target, target === 'review' ? 'revoke' : 'new_version')) continue;
    await tx.update(variants).set({ lifecycle: target, updatedAt: now }).where(and(eq(variants.id, vid), eq(variants.ownerId, ownerId)));
    await recordAudit(tx, {
      ownerId,
      action: 'variant.lifecycle',
      entity: 'variant',
      entityId: vid,
      details: { channel: v.channel, from: 'approved', to: target, cause: target === 'review' ? 'approval_revoked' : 'approval_invalidated' },
      at: now,
    });
    changed.push(vid);
  }
  return changed;
}

/** 공통: 조건에 맞는 항목(활성 승인 있음, PLANNED·QUEUED)을 잠그고 철회 → 계획 재계산 → 파생본 정리. */
async function invalidateWhere(
  tx: DbOrTx,
  ownerId: string,
  itemIds: string[],
  reason: InvalidationReason,
  variantTarget: 'review' | 'draft',
  now: Date,
): Promise<RevokedApproval[]> {
  if (itemIds.length === 0) return [];
  const items = await lockItemsInOrder(tx, ownerId, itemIds);
  const revoked = await revokeActiveApprovalsLocked(
    tx,
    ownerId,
    items.filter((i) => i.status === 'PLANNED' || i.status === 'QUEUED'),
    () => `invalidated:${reason}`,
    now,
    { action: 'approval.invalidate' },
  );
  for (const planId of sortIds(revoked.map((r) => r.planId))) await recomputePlanStatus(tx, ownerId, planId, now);
  await settleApprovedVariants(
    tx,
    ownerId,
    revoked.map((r) => r.variantId),
    variantTarget,
    now,
  );
  return revoked;
}

async function itemsWithActiveApproval(tx: DbOrTx, ownerId: string, where: ReturnType<typeof and>): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ id: distributionItems.id })
    .from(distributionItems)
    .innerJoin(approvals, and(eq(approvals.distributionItemId, distributionItems.id), eq(approvals.ownerId, distributionItems.ownerId), isNull(approvals.revokedAt)))
    .innerJoin(variants, and(eq(variants.id, distributionItems.variantId), eq(variants.ownerId, distributionItems.ownerId)))
    .where(and(eq(distributionItems.ownerId, ownerId), inArray(distributionItems.status, ['PLANNED', 'QUEUED']), where));
  return rows.map((r) => r.id);
}

/**
 * A06 훅(파생본): 새 현재 버전(수정·AI 채택·다시 초안 = body_changed, 첨부 변경 = assets_changed)을 만든 트랜잭션 안에서 부른다.
 * 그 파생본을 담은 항목의 활성 승인을 철회한다. 파생본 lifecycle 은 새 버전 경로가 이미 draft 로 바꾼다(D14).
 */
export async function invalidateApprovalsForVariant(
  tx: DbOrTx,
  ownerId: string,
  variantId: string,
  reason: Extract<InvalidationReason, 'body_changed' | 'assets_changed'>,
  now: Date,
): Promise<RevokedApproval[]> {
  const ids = await itemsWithActiveApproval(tx, ownerId, eq(distributionItems.variantId, variantId));
  return invalidateWhere(tx, ownerId, ids, reason, 'draft', now);
}

/**
 * A06 훅(원고): 원고 새 현재 버전(사용자 저장·AI 제안 채택)을 만든 트랜잭션 안에서 부른다. 원고가 바뀌면 파생본이 stale 이 되므로
 * 그 원고의 파생본을 담은 항목의 활성 승인을 철회하고, 승인됨이던 파생본은 draft 로 낮춘다(재검토 필요).
 */
export async function invalidateApprovalsForContent(tx: DbOrTx, ownerId: string, contentId: string, now: Date): Promise<RevokedApproval[]> {
  const ids = await itemsWithActiveApproval(tx, ownerId, eq(variants.contentId, contentId));
  return invalidateWhere(tx, ownerId, ids, 'content_changed', 'draft', now);
}

/** A06 훅(계정): 계정 상태·연결이 바뀌면 그 계정을 쓰는 항목의 활성 승인을 철회한다. 파생본 내용은 그대로라 승인됨 → review. */
export async function invalidateApprovalsForAccount(tx: DbOrTx, ownerId: string, accountId: string, now: Date): Promise<RevokedApproval[]> {
  const ids = await itemsWithActiveApproval(tx, ownerId, eq(distributionItems.channelAccountId, accountId));
  return invalidateWhere(tx, ownerId, ids, 'account_changed', 'review', now);
}

/** 실행 시점 재검사에서 stale 로 판정된 항목(별도 트랜잭션): 사유별로 철회한다. */
export async function invalidateItems(
  tx: DbOrTx,
  ownerId: string,
  byReason: ReadonlyArray<{ itemId: string; reason: InvalidationReason }>,
  now: Date,
): Promise<RevokedApproval[]> {
  const reasonOf = new Map(byReason.map((r) => [r.itemId, r.reason]));
  const items = await lockItemsInOrder(tx, ownerId, [...reasonOf.keys()]);
  const revoked = await revokeActiveApprovalsLocked(
    tx,
    ownerId,
    items.filter((i) => i.status === 'PLANNED' || i.status === 'QUEUED'),
    (i) => `invalidated:${reasonOf.get(i.id) ?? 'snapshot_changed'}`,
    now,
    { action: 'approval.invalidate' },
  );
  for (const planId of sortIds(revoked.map((r) => r.planId))) await recomputePlanStatus(tx, ownerId, planId, now);
  const contentish = new Set<InvalidationReason>(['body_changed', 'assets_changed', 'content_changed', 'snapshot_changed']);
  const toDraft = revoked.filter((r) => contentish.has(reasonOf.get(r.itemId) ?? 'snapshot_changed')).map((r) => r.variantId);
  const toReview = revoked.filter((r) => !toDraft.includes(r.variantId)).map((r) => r.variantId);
  await settleApprovedVariants(tx, ownerId, toDraft, 'draft', now);
  await settleApprovedVariants(tx, ownerId, toReview, 'review', now);
  return revoked;
}
