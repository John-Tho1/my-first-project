/**
 * T10(결정 D17) 승인 무효화·철회의 공용 핵심. variants.ts·contents.ts(편집 경로)와 distribution.ts(승인·철회·실행)가 함께 쓴다.
 * 이 모듈은 schema·queries 만 import 한다(variants/contents/distribution 과 순환 import 없음).
 *
 * 전역 잠금 순서(교착 방지 — 모든 경로가 이 순서의 부분 수열로만 잠근다. FIX-T10: INSERT 의 FK 참조 잠금(KEY SHARE)까지 포함):
 *   channel_accounts(id 순) → contents(id 순) → variants(id 순; variant_versions 는 불변이라 FK KEY SHARE 만) → distribution_plans → distribution_items
 *   → approvals → jobs.
 * - 계정 준비 상태에 기대는 경로(계획 생성·승인·실행)는 계정 행을 FOR SHARE 로, 계정 상태 변경은 FOR UPDATE 로 **가장 먼저** 잠근다
 *   (lockAccountsInOrder). 그래서 승인 INSERT 와 계정 연결 해제가 서로를 놓치지 않는다: 먼저 잠근 쪽이 커밋할 때까지 다른 쪽이 기다리고,
 *   뒤에 온 쪽은 커밋된 결과(새 승인 → 무효화 대상 / disconnected → 승인 거부)를 본다.
 * - 계획 생성은 항목 INSERT 전에 계정 → 원고 → 파생본을 순서대로 FOR SHARE 로 잠근다 — INSERT 가 잡는 FK KEY SHARE 는 이미 가진 잠금보다 약해
 *   새 대기 순서를 만들지 않는다(계정 A·B 두 항목 계획 vs B 상태 변경의 순환 대기 제거).
 * - 편집 경로(원고·파생본 새 버전, 브랜드 새 버전)는 계정을 잠그지 않는다(content → variant 를 잠근 뒤 계정을 잠그면 순서가 뒤집힌다).
 *   그래서 lockItemsInOrder 도 계정을 잠그지 않는다 — 계정이 필요한 호출자는 그 전에 lockAccountsInOrder 를 부른다.
 * 편집 경로는 이미 content → variant 를 잠근 상태에서 이 모듈을 부른다(PostgreSQL 행 잠금은 같은 트랜잭션에서 재진입 가능).
 * 실제 PostgreSQL 동시 실행 검증은 not_run — PGlite 는 연결 하나라 트랜잭션이 직렬화된다(시험은 두 순서의 사후 조건과 잠금 흔적만 확인).
 *
 * A06: 승인 뒤 본문·첨부·원고·계정이 바뀌면 그 항목의 활성 승인을 revoke_reason='invalidated:<이유>' 로 철회하고,
 * QUEUED 작업은 BLOCKED(+ job_event), QUEUED 항목은 PLANNED 로 되돌린다(시작 전이라 외부 전송 없음). 승인 행은 지우지 않는다.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  AppError,
  canVariantTransition,
  computePlanStatus,
  itemStatusForJob,
  TERMINAL_JOB_STATES,
  transitionJobState,
  type JobEvent,
  type JobState,
  type PlanStatus,
  type VariantLifecycle,
} from '@cs/domain';
import { recordAudit, type DbOrTx } from './queries';
import { approvals, channelAccounts, contents, distributionItems, distributionPlans, jobEvents, jobs, variants } from './schema';

export type DistributionItemRow = typeof distributionItems.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;

export type InvalidationReason =
  | 'body_changed'
  | 'assets_changed'
  | 'content_changed'
  | 'account_changed'
  | 'brand_changed'
  | 'schedule_passed'
  | 'snapshot_changed';

/**
 * 승인 무효화·철회가 곧바로 막는 항목 상태: 실행 전(PLANNED)·대기(QUEUED)·재시도 대기(RETRY_WAIT, T12 D19 — 다음 전송 시점이 아니라 즉시)·
 * 보류(BLOCKED — FIX-T12 P0: 편집은 보류 항목의 승인도 무효로 한다. D19(d) "재시도 재검사로만 막음"을 뒤집음, D20 후속).
 * 보류 항목의 작업은 BLOCKED 그대로 둔다(확정되지 않은 전송을 실행 가능한 상태로 되돌리지 않음) — 항목만 PLANNED(다시 승인·새 실행 키).
 * 전송 단계(LEASED 이후)는 철회가 CANCEL_REQUESTED 로 추적한다.
 */
export const REVOCABLE_ITEM_STATUSES = ['PLANNED', 'QUEUED', 'RETRY_WAIT', 'BLOCKED'] as const;
/** 철회 시 BLOCKED 로 막는 작업 상태(아직 보내지 않은 대기 작업). */
const BLOCK_ON_REVOKE_JOB_STATES = ['QUEUED', 'RETRY_WAIT'] as const;
const isRevocable = (status: string) => (REVOCABLE_ITEM_STATUSES as readonly string[]).includes(status);

const sortIds = (ids: Iterable<string>) => [...new Set(ids)].sort();

/**
 * FIX-T10(P1): 전역 잠금 순서의 첫 단계 — 계정 행을 id 순으로 잠근다. 계정 상태에 기대는 읽기 경로는 'share'(서로 막지 않음),
 * 상태 변경은 'update'. 같은 트랜잭션에서 share → update 로 올리는 경로는 없다(올리면 교착 가능). owner 가 다른 ID 는 무시된다.
 */
export async function lockAccountsInOrder(tx: DbOrTx, ownerId: string, accountIds: Iterable<string>, mode: 'share' | 'update'): Promise<void> {
  const ids = sortIds(accountIds);
  if (ids.length === 0) return;
  await tx
    .select({ id: channelAccounts.id })
    .from(channelAccounts)
    .where(and(eq(channelAccounts.ownerId, ownerId), inArray(channelAccounts.id, ids)))
    .orderBy(asc(channelAccounts.id))
    .for(mode);
}

/**
 * FIX-T10(P1): 원고·파생본을 전역 순서(원고 → 파생본, 각각 id 순)로 FOR SHARE 잠근다 — 계획 생성이 항목 INSERT(FK KEY SHARE) 전에 부른다.
 * 편집 경로(FOR UPDATE)와는 직렬화되고, 다른 계획 생성과는 서로 막지 않는다.
 */
export async function shareLockVariantsInOrder(tx: DbOrTx, ownerId: string, variantIds: Iterable<string>): Promise<void> {
  const ids = sortIds(variantIds);
  if (ids.length === 0) return;
  const peek = await tx
    .select({ contentId: variants.contentId })
    .from(variants)
    .where(and(eq(variants.ownerId, ownerId), inArray(variants.id, ids)));
  const contentIds = sortIds(peek.map((p) => p.contentId));
  if (contentIds.length) {
    await tx.select({ id: contents.id }).from(contents).where(and(eq(contents.ownerId, ownerId), inArray(contents.id, contentIds))).orderBy(asc(contents.id)).for('share');
  }
  await tx.select({ id: variants.id }).from(variants).where(and(eq(variants.ownerId, ownerId), inArray(variants.id, ids))).orderBy(asc(variants.id)).for('share');
}

/**
 * 항목 ID 들을 전역 잠금 순서대로 잠근다: 원고 → 파생본 → 계획 → 항목(id 순, FOR UPDATE). 계정은 잠그지 않는다(호출자가 먼저 — 위 주석). 잠근 항목 행(최신 값)을 id 순으로 돌려준다.
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

/**
 * 작업 상태 전이 + job_event(작업마다 seq = 최대+1). 다음 상태는 @cs/domain transitionJobState(전이 표 한 곳)로만 정한다 —
 * 표에 없는 전이는 IllegalJobTransitionError. 호출자가 작업 행을 잠근(항목 잠금 아래) 상태여야 한다.
 * details 는 비밀·본문 없는 코드 값만(sanitized). details.event 가 없으면 사건 이름을 넣는다. set 은 함께 바꿀 열(lease 해제 등).
 */
export async function transitionJob(
  tx: DbOrTx,
  ownerId: string,
  job: Pick<JobRow, 'id' | 'state'>,
  event: JobEvent,
  details: Record<string, unknown>,
  now: Date,
  set: Partial<Pick<typeof jobs.$inferInsert, 'leaseOwner' | 'leaseUntil' | 'heartbeatAt' | 'nextRunAt' | 'lastErrorCode' | 'lastRetryClass' | 'reconcileCount' | 'cancelRequestedAt' | 'attempt'>> = {},
): Promise<JobState> {
  const to = transitionJobState(job.state, event);
  const terminal = (TERMINAL_JOB_STATES as readonly string[]).includes(to);
  const updated = await tx
    .update(jobs)
    .set({ ...set, state: to, updatedAt: now, ...(terminal ? { doneAt: now, leaseOwner: null, leaseUntil: null } : {}) })
    .where(and(eq(jobs.id, job.id), eq(jobs.ownerId, ownerId), eq(jobs.state, job.state)))
    .returning({ id: jobs.id });
  if (!updated[0]) throw new AppError('conflict', 'job_state_changed', '작업 상태가 다른 곳에서 먼저 바뀌었습니다');
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
    sanitizedDetails: { event, ...details, transition: event },
  });
  return to;
}

/** 항목 상태를 작업 상태에 맞춘다(itemStatusForJob). override 가 있으면 그 값(예: 보내기 전 승인 문제 → PLANNED). */
export async function syncItemStatus(tx: DbOrTx, ownerId: string, itemId: string, jobState: JobState, now: Date, override?: string): Promise<void> {
  await tx
    .update(distributionItems)
    .set({ status: override ?? itemStatusForJob(jobState), updatedAt: now })
    .where(and(eq(distributionItems.id, itemId), eq(distributionItems.ownerId, ownerId)));
}

/** 이미 보냈을 수 있는(전송 중·조회 중) 작업 상태 — 취소는 CANCEL_REQUESTED 로만 기록한다(원격 되돌림을 주장하지 않음). */
export const CANCEL_REQUEST_JOB_STATES: readonly JobState[] = ['LEASED', 'SENDING', 'REMOTE_PROCESSING', 'RECONCILING'];

/**
 * 잠근 항목의 진행 중 작업에 취소 요청을 기록한다(LEASED·SENDING·REMOTE_PROCESSING·RECONCILING → CANCEL_REQUESTED, 항목도 CANCEL_REQUESTED).
 * worker 가 결과를 확인한 뒤 CANCELED(보내지 않았음) 또는 CONFIRMED(cancel_too_late)로 정한다. 요청이 기록되면 작업 ID 를 돌려준다.
 */
export async function requestCancelLocked(tx: DbOrTx, ownerId: string, itemId: string, cause: string, now: Date): Promise<string[]> {
  const rows = await tx
    .select({ id: jobs.id, state: jobs.state })
    .from(jobs)
    .where(and(eq(jobs.ownerId, ownerId), eq(jobs.itemId, itemId), inArray(jobs.state, [...CANCEL_REQUEST_JOB_STATES])))
    .orderBy(asc(jobs.id))
    .for('update');
  for (const j of rows) {
    await transitionJob(tx, ownerId, j, 'cancel_requested', { cause }, now, { cancelRequestedAt: now });
    await syncItemStatus(tx, ownerId, itemId, 'CANCEL_REQUESTED', now);
  }
  return rows.map((r) => r.id);
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
 * 잠근 항목들의 활성 승인을 철회한다(없으면 건너뜀). QUEUED·RETRY_WAIT 작업 → BLOCKED(+event), QUEUED·RETRY_WAIT 항목 → PLANNED
 * (아직 보내지 않았거나 보내지 않았음이 확인된 작업 — 다시 승인하거나 새 계획). T12(D19): RETRY_WAIT 도 다음 전송을 기다리지 않고 즉시 막는다(A10).
 * 진행 상태(LEASED·SENDING…)는 여기서 건드리지 않는다: 사용자 철회는 revokeApproval 이 requestCancelLocked 로 CANCEL_REQUESTED 를 기록한다.
 * worker 의 전송 직전 재검사(beginSend)는 그대로 최종 방어선이다.
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
      .where(and(eq(jobs.ownerId, ownerId), eq(jobs.itemId, item.id), inArray(jobs.state, [...BLOCK_ON_REVOKE_JOB_STATES])))
      .orderBy(asc(jobs.id))
      .for('update');
    for (const j of queued) {
      await transitionJob(
        tx,
        ownerId,
        j,
        'blocked',
        { event: audit.action === 'approval.revoke' ? 'approval_revoked' : 'approval_invalidated', reason, approval_id: a.id, from: j.state },
        now,
        { leaseOwner: null, leaseUntil: null, lastErrorCode: audit.action === 'approval.revoke' ? 'approval_revoked' : 'approval_invalidated' },
      );
    }
    // FIX-T12(P0): 보류(BLOCKED) 항목도 PLANNED 로(작업은 BLOCKED 그대로 — retryItem 은 approval_required). 복원 표시가 있는 항목은 그대로 둔다
    // (복원 전 결과를 이 환경에서 확인하기 전에는 다시 승인·실행하지 않는다).
    const toPlanned = item.status === 'QUEUED' || item.status === 'RETRY_WAIT' || (item.status === 'BLOCKED' && !item.restoredNeedsReview);
    if (toPlanned) {
      await tx
        .update(distributionItems)
        .set({ status: 'PLANNED', updatedAt: now })
        .where(and(eq(distributionItems.id, item.id), eq(distributionItems.ownerId, ownerId), inArray(distributionItems.status, ['QUEUED', 'RETRY_WAIT', 'BLOCKED'])));
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

/** 공통: 조건에 맞는 항목(활성 승인 있음, PLANNED·QUEUED·RETRY_WAIT)을 잠그고 철회 → 계획 재계산 → 파생본 정리. */
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
    items.filter((i) => isRevocable(i.status)),
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
    .where(and(eq(distributionItems.ownerId, ownerId), inArray(distributionItems.status, [...REVOCABLE_ITEM_STATUSES]), where));
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

/**
 * T12(D19) A06 훅(브랜드 프로필): 새 브랜드 프로필 버전을 만든 트랜잭션 안에서 부른다. 승인 스냅샷의 brand_profile_version_id 는
 * payload hash 에 들어가므로, 활성 승인이 가리키는 브랜드가 새 현재 브랜드와 다르면 그 승인을 `invalidated:brand_changed` 로 철회한다.
 * 파생본 본문은 그대로라 승인됨 → review(다시 승인하려면 새 계획 — 스냅샷이 옛 브랜드를 가리킨다).
 */
export async function invalidateApprovalsForBrandProfile(tx: DbOrTx, ownerId: string, currentBrandProfileId: string, now: Date): Promise<RevokedApproval[]> {
  const ids = await itemsWithActiveApproval(
    tx,
    ownerId,
    sql`${distributionItems.brandProfileId} is distinct from ${currentBrandProfileId}::uuid`,
  );
  return invalidateWhere(tx, ownerId, ids, 'brand_changed', 'review', now);
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
    items.filter((i) => isRevocable(i.status)),
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
