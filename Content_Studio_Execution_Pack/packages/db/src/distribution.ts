/**
 * T10 배포 계획·승인·철회·실행(결정 D17). 모든 함수는 ownerId 를 WHERE 에 넣는다(A01) — 다른 owner 의 계획·항목·계정·파생본은 404.
 *
 * 불변식
 * - 배포 항목(distribution_items)은 승인 대상 불변 스냅샷: payload_json(canonical publish payload) + payload_hash(SHA-256). DB 트리거가
 *   스냅샷 열의 UPDATE·모든 DELETE 를 막는다. 상태(status)만 바뀐다.
 * - 승인은 approveItems 만 만든다: 화면에 보인 hash(expected_hashes) = 저장된 hash, confirm=true, 그리고 **지금의 실제 행**(파생본 현재 버전·
 *   원고 현재 버전·첨부 checksum·계정 상태·재계산한 payload hash·예약 시각)이 스냅샷과 같을 때만. 클라이언트·LLM 플래그는 승인이 아니다.
 * - 편집(파생본·원고 새 버전, 첨부 변경, 계정 상태 변경)은 같은 트랜잭션에서 관련 승인을 철회한다(approval-invalidation.ts, A06).
 *   실행도 같은 검사를 다시 하고, 어긋나면 전체를 거부한 뒤 그 승인을 철회한다(이중 방어).
 * - 실행 = QUEUED 작업 생성뿐(T11 이 처리). 모의 계정만 있으므로 결과는 항상 MOCK 이고 외부 호출·publisher 호출이 없다.
 *   HTTP 명령 멱등: execute_commands(owner, command_key) — 같은 key 재호출은 저장된 결과. 작업 멱등: jobs.idempotency_key unique
 *   ('publish:<item>:<approval>') + 항목당 진행 중 작업 1개(부분 unique). 동시 실행은 계획 행 잠금으로 직렬화되고, 진 쪽은 409 already_executed.
 * - 잠금 순서: contents → variants → distribution_plans → distribution_items → approvals → jobs(approval-invalidation.ts 와 같음).
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  AccountNotReadyError,
  AlreadyExecutedError,
  AppError,
  ApprovalRequiredForExecuteError,
  assertExecutionAllowed,
  BadRequestError,
  buildCanonicalPayload,
  canVariantTransition,
  CHANNEL_LABEL,
  ChannelMismatchError,
  CHANNELS,
  GoneError,
  HashMismatchError,
  isUuid,
  MOCK_EXECUTE_NOTICE,
  MOCK_EXTERNAL_PREFIX,
  NotFoundError,
  payloadHash,
  scheduleFromMsk,
  SCHEDULE_TIMEZONE,
  SnapshotStaleError,
  type AccountState,
  type AppConfig,
  type ApproveInput,
  type CanonicalPayload,
  type Channel,
  type PlanCreateInput,
  type RequestedResult,
  type SnapshotAsset,
  type Visibility,
} from '@cs/domain';
import {
  activeApprovalsFor,
  invalidateApprovalsForAccount,
  invalidateItems,
  lockItemsInOrder,
  recomputePlanStatus,
  requestCancelLocked,
  revokeActiveApprovalsLocked,
  settleApprovedVariants,
  type ApprovalRow,
  type DistributionItemRow,
  type InvalidationReason,
  type JobRow,
} from './approval-invalidation';
import type { Db } from './client';
import { keysetBefore, microsText, type TimeCursor } from './ideas';
import { recordAudit, type DbOrTx } from './queries';
import {
  approvals,
  assets,
  channelAccounts,
  contents,
  distributionItems,
  distributionPlans,
  executeCommands,
  jobEvents,
  jobs,
  publications,
  variantAssets,
  variants,
  variantVersions,
} from './schema';
import { variantReviewBlockers } from './variants';
import { getCurrentBrandProfile } from './writing';

export type ChannelAccountRow = typeof channelAccounts.$inferSelect;
export type DistributionPlanRow = typeof distributionPlans.$inferSelect;
export type JobEventRow = typeof jobEvents.$inferSelect;
type PublicationRow = typeof publications.$inferSelect;

/** 원격 결과 응답 모양(jobs.ts publicationView 와 같은 모양 — 순환 import 를 피해 여기 둔다). */
export function publicationViewOf(p: PublicationRow) {
  return {
    id: p.id,
    item_id: p.itemId,
    job_id: p.jobId,
    external_id: p.externalId,
    permalink: p.permalink,
    result_kind: p.resultKind,
    remote_visibility: p.remoteVisibility,
    verification: p.verification,
    is_mock: p.isMock,
    verified_at: p.verifiedAt ? p.verifiedAt.toISOString() : null,
    created_at: p.createdAt.toISOString(),
    notice: p.isMock ? 'MOCK — 실제 발행 실적 아님' : null,
  };
}
export type { ApprovalRow, DistributionItemRow, JobRow };

const PLAN_NOT_FOUND = '배포 계획을 찾을 수 없습니다';
const ITEM_NOT_FOUND = '배포 항목을 찾을 수 없습니다';

// ---- 계정(모의) ----

export const MOCK_ACCOUNT_DISPLAY: Record<Channel, string> = {
  threads: 'MOCK Threads 계정',
  instagram: 'MOCK Instagram 계정',
  youtube: 'MOCK YouTube 계정',
  blog: 'MOCK 블로그 계정',
};

/**
 * 플랫폼마다 모의 계정이 없으면 하나 만든다(멱등 — seed). external_account_id = 'mock:<platform>:<uuid>'(행마다 고유 —
 * 다른 환경의 묶음을 복원해도 unique 충돌 없이 그 묶음의 모의 계정이 함께 들어온다, D17). 인증 비밀 없음.
 */
export async function ensureMockAccounts(db: DbOrTx, ownerId: string, now: Date = new Date()): Promise<number> {
  let inserted = 0;
  for (const platform of CHANNELS) {
    const found = await db
      .select({ id: channelAccounts.id })
      .from(channelAccounts)
      .where(and(eq(channelAccounts.ownerId, ownerId), eq(channelAccounts.platform, platform), eq(channelAccounts.kind, 'mock')))
      .limit(1);
    if (found.length) continue;
    await db.insert(channelAccounts).values({
      ownerId,
      platform,
      kind: 'mock',
      externalAccountId: `${MOCK_EXTERNAL_PREFIX}${platform}:${randomUUID()}`,
      displayName: MOCK_ACCOUNT_DISPLAY[platform],
      state: 'mock_ready',
      capabilitySnapshot: { mock: true, external_writes: false, note: '모의 계정 — 외부로 아무것도 보내지 않습니다' },
      createdAt: now,
    });
    inserted++;
  }
  return inserted;
}

export async function listChannelAccounts(db: DbOrTx, ownerId: string): Promise<ChannelAccountRow[]> {
  return db.select().from(channelAccounts).where(eq(channelAccounts.ownerId, ownerId)).orderBy(asc(channelAccounts.platform), asc(channelAccounts.createdAt), asc(channelAccounts.id));
}

async function getChannelAccount(db: DbOrTx, ownerId: string, id: string): Promise<ChannelAccountRow | null> {
  if (!isUuid(id)) return null;
  const rows = await db
    .select()
    .from(channelAccounts)
    .where(and(eq(channelAccounts.id, id), eq(channelAccounts.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

export function accountReady(a: Pick<ChannelAccountRow, 'kind' | 'state'>): boolean {
  return a.kind === 'mock' ? a.state === 'mock_ready' : a.state === 'connected';
}

/**
 * 계정 상태 변경(연결 해제·철회·다시 준비). 바뀌면 그 계정을 쓰는 항목의 활성 승인을 철회한다(A06 account_changed).
 * 모의 계정은 mock_ready|disconnected|revoked 만, live 는 mock_ready 불가(CHECK).
 */
export async function setChannelAccountState(db: Db, ownerId: string, accountId: string, state: AccountState, now: Date = new Date()) {
  if (!isUuid(accountId)) throw new NotFoundError('배포 계정을 찾을 수 없습니다');
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(channelAccounts)
      .where(and(eq(channelAccounts.id, accountId), eq(channelAccounts.ownerId, ownerId)))
      .for('update')
      .limit(1);
    const acc = rows[0];
    if (!acc) throw new NotFoundError('배포 계정을 찾을 수 없습니다');
    if (acc.kind === 'mock' && state === 'connected') throw new BadRequestError('모의 계정은 연결(connected) 상태가 될 수 없습니다');
    if (acc.kind === 'live' && state === 'mock_ready') throw new BadRequestError('실제 계정은 mock_ready 상태가 될 수 없습니다');
    if (acc.state === state) return { account: acc, revoked: [] };
    const updated = await tx
      .update(channelAccounts)
      .set({ state })
      .where(and(eq(channelAccounts.id, acc.id), eq(channelAccounts.ownerId, ownerId)))
      .returning();
    const revoked = await invalidateApprovalsForAccount(tx, ownerId, acc.id, now);
    await recordAudit(tx, {
      ownerId,
      action: 'channel_account.state',
      entity: 'channel_account',
      entityId: acc.id,
      details: { platform: acc.platform, kind: acc.kind, from: acc.state, to: state, revoked_approvals: revoked.length },
      at: now,
    });
    return { account: updated[0]!, revoked };
  });
}

// ---- 스냅샷 ----

interface AttachedForSnapshot extends SnapshotAsset {
  deletedAt: Date | null;
}

async function attachedForSnapshot(tx: DbOrTx, ownerId: string, variantVersionId: string): Promise<AttachedForSnapshot[]> {
  return tx
    .select({
      id: assets.id,
      checksum: assets.checksum,
      role: variantAssets.role,
      position: variantAssets.position,
      mime: assets.mime,
      deletedAt: assets.deletedAt,
    })
    .from(variantAssets)
    .innerJoin(assets, and(eq(assets.id, variantAssets.assetId), eq(assets.ownerId, variantAssets.ownerId)))
    .where(and(eq(variantAssets.variantVersionId, variantVersionId), eq(variantAssets.ownerId, ownerId)))
    .orderBy(asc(variantAssets.position));
}

const BLOCKER_CODE: Array<[string, string, string]> = [
  ['no_current_version', 'no_current_version', '먼저 채널 초안을 만드세요'],
  ['stale', 'stale_variant', '원문이 바뀌었습니다. 현재 원문으로 다시 초안을 만들고 검토한 뒤 배포 계획을 만드세요.'],
  ['media_incomplete', 'media_incomplete', '채널에 필요한 미디어가 부족합니다(Instagram: 이미지 1개 이상, YouTube: 완성 영상 1개)'],
  ['unresolved_claims', 'unconfirmed_experience_claims', '확인하지 않은 1인칭 경험 주장이 있습니다(A03)'],
];

function blockerError(blockers: string[]): AppError {
  for (const [prefix, code, message] of BLOCKER_CODE) {
    if (blockers.some((b) => b === prefix || b.startsWith(`${prefix}:`))) return new AppError('conflict', code, message, { blockers });
  }
  return new AppError('conflict', 'variant_blocked', '채널 초안이 배포 조건을 채우지 못했습니다', { blockers });
}

/**
 * 항목의 스냅샷이 지금의 실제 행과 같은지 다시 검사한다. 문제 코드 목록(없으면 []):
 * variant_changed(현재 버전이 다름) · variant_not_review · content_changed · assets_changed(첨부 checksum·순서·삭제) ·
 * account_changed(없음·준비 안 됨·외부 ID/플랫폼 변경) · payload_changed(재계산 hash 불일치) · schedule_passed · blocked:<검토 차단 사유>.
 */
export async function snapshotProblems(tx: DbOrTx, ownerId: string, item: DistributionItemRow, now: Date): Promise<string[]> {
  const problems: string[] = [];
  const vRows = await tx
    .select()
    .from(variants)
    .where(and(eq(variants.id, item.variantId), eq(variants.ownerId, ownerId)))
    .limit(1);
  const variant = vRows[0];
  if (!variant || variant.currentVersionId !== item.variantVersionId) problems.push('variant_changed');
  if (variant && variant.lifecycle !== 'review' && variant.lifecycle !== 'approved') problems.push('variant_not_review');
  const cRows = variant
    ? await tx
        .select({ currentVersionId: contents.currentVersionId })
        .from(contents)
        .where(and(eq(contents.id, variant.contentId), eq(contents.ownerId, ownerId)))
        .limit(1)
    : [];
  if (cRows[0]?.currentVersionId !== item.contentVersionId) problems.push('content_changed');
  const attached = await attachedForSnapshot(tx, ownerId, item.variantVersionId);
  const payload = item.payloadJson as unknown as CanonicalPayload;
  const snapAssets = Array.isArray(payload.assets) ? payload.assets : [];
  const liveAssets = attached.map((a) => ({ id: a.id, checksum: a.checksum, role: a.role, order: a.position, mime: a.mime }));
  if (attached.some((a) => a.deletedAt !== null) || JSON.stringify(liveAssets) !== JSON.stringify(snapAssets.map((a) => ({ id: a.id, checksum: a.checksum, role: a.role, order: a.order, mime: a.mime })))) {
    problems.push('assets_changed');
  }
  const acc = await getChannelAccount(tx, ownerId, item.channelAccountId);
  if (!acc || !accountReady(acc) || acc.externalAccountId !== payload.provider_account_id || (variant && acc.platform !== variant.channel)) {
    problems.push('account_changed');
  }
  if (variant && acc) {
    const vv = await tx
      .select()
      .from(variantVersions)
      .where(and(eq(variantVersions.id, item.variantVersionId), eq(variantVersions.ownerId, ownerId)))
      .limit(1);
    if (vv[0]) {
      const recomputed = buildCanonicalPayload({
        contentVersionId: item.contentVersionId,
        variantVersionId: item.variantVersionId,
        brandProfileVersionId: item.brandProfileId,
        channelAccountId: item.channelAccountId,
        providerAccountId: acc.externalAccountId,
        channel: variant.channel as Channel,
        body: vv[0].body,
        metadata: vv[0].metadataJson,
        assets: attached,
        visibility: item.visibility as Visibility,
        scheduledAtUtc: item.scheduledAtUtc,
        timezone: item.scheduleTimezone,
      });
      if (payloadHash(recomputed) !== item.payloadHash) problems.push('payload_changed');
    } else {
      problems.push('variant_changed');
    }
  }
  if (payloadHash(item.payloadJson) !== item.payloadHash) problems.push('payload_changed');
  if (item.scheduledAtUtc && item.scheduledAtUtc.getTime() <= now.getTime()) problems.push('schedule_passed');
  if (variant) {
    const blockers = await variantReviewBlockers(tx, ownerId, variant.id);
    for (const b of blockers) problems.push(`blocked:${b}`);
  }
  return [...new Set(problems)];
}

/** 문제 코드 → 무효화 사유(revoke_reason 'invalidated:<사유>'). */
export function invalidationReasonOf(problems: readonly string[]): InvalidationReason {
  if (problems.includes('content_changed') || problems.some((p) => p === 'blocked:stale')) return 'content_changed';
  if (problems.includes('assets_changed') || problems.some((p) => p.startsWith('blocked:media_incomplete'))) return 'assets_changed';
  if (problems.includes('variant_changed')) return 'body_changed';
  if (problems.includes('account_changed')) return 'account_changed';
  if (problems.includes('schedule_passed')) return 'schedule_passed';
  return 'snapshot_changed';
}

// ---- 계획 만들기 ----

export interface CreatedPlan {
  plan: DistributionPlanRow;
  items: DistributionItemRow[];
}

/**
 * 배포 계획(한 트랜잭션). 항목마다: 파생본(owner) review|approved · 검토 차단 사유 없음(stale·미디어·A03) · 계정(owner) 플랫폼 = 채널 ·
 * 계정 준비됨 · 모의 계정은 mock_publish 만. 스냅샷 = 파생본 **현재** 버전 + 첨부(owner) + 원고 현재 버전 + 현재 브랜드 프로필.
 * 입력의 approved·approval 같은 플래그는 스키마가 버리므로 여기서 승인은 생기지 않는다.
 */
export async function createPlan(db: Db, ownerId: string, input: PlanCreateInput, now: Date = new Date()): Promise<CreatedPlan> {
  return db.transaction(async (tx) => {
    const brand = await getCurrentBrandProfile(tx, ownerId);
    const seen = new Set<string>();
    const prepared: Array<Omit<typeof distributionItems.$inferInsert, 'planId'>> = [];
    const channels: string[] = [];
    for (const it of input.items) {
      const key = `${it.variant_id}|${it.channel_account_id}`;
      if (seen.has(key)) throw new AppError('bad_request', 'duplicate_item', '같은 채널 초안·계정 조합을 두 번 넣을 수 없습니다');
      seen.add(key);
      const vRows = await tx
        .select()
        .from(variants)
        .where(and(eq(variants.id, it.variant_id), eq(variants.ownerId, ownerId)))
        .limit(1);
      const variant = vRows[0];
      if (!variant) throw new NotFoundError('채널 초안을 찾을 수 없습니다');
      if (variant.lifecycle !== 'review' && variant.lifecycle !== 'approved') {
        throw new AppError('conflict', 'variant_not_review', '검토 중인 채널 초안만 배포 계획에 넣을 수 있습니다. 먼저 "검토로"를 누르세요.');
      }
      const blockers = await variantReviewBlockers(tx, ownerId, variant.id);
      if (blockers.length) throw blockerError(blockers);
      const acc = await getChannelAccount(tx, ownerId, it.channel_account_id);
      if (!acc) throw new NotFoundError('배포 계정을 찾을 수 없습니다');
      if (acc.platform !== variant.channel) throw new ChannelMismatchError();
      if (!accountReady(acc)) throw new AccountNotReadyError();
      let requested: RequestedResult;
      if (acc.kind === 'mock') {
        requested = it.requested_result ?? 'mock_publish';
        if (requested !== 'mock_publish') throw new AppError('bad_request', 'mock_only', '모의(MOCK) 계정은 모의 실행(mock_publish)만 할 수 있습니다');
      } else {
        if (!it.requested_result || it.requested_result === 'mock_publish') throw new AppError('bad_request', 'requested_result_required', '실제 계정은 upload_private 또는 public_publish 를 지정해야 합니다');
        requested = it.requested_result;
      }
      const visibility: Visibility = it.visibility ?? 'private';
      if (requested === 'upload_private' && visibility !== 'private') throw new AppError('bad_request', 'visibility_mismatch', '비공개 업로드는 공개 범위가 private 이어야 합니다');
      const scheduledAtUtc = it.schedule ? scheduleFromMsk(it.schedule.date, it.schedule.time, now) : null;
      const vv = await tx
        .select()
        .from(variantVersions)
        .where(and(eq(variantVersions.id, variant.currentVersionId!), eq(variantVersions.ownerId, ownerId)))
        .limit(1);
      const version = vv[0];
      if (!version) throw blockerError(['no_current_version']);
      const attached = await attachedForSnapshot(tx, ownerId, version.id);
      if (attached.some((a) => a.deletedAt !== null)) throw new GoneError('첨부 파일 중 원본을 지운 파일이 있어 배포할 수 없습니다');
      const payload = buildCanonicalPayload({
        contentVersionId: version.contentVersionId,
        variantVersionId: version.id,
        brandProfileVersionId: brand?.id ?? null,
        channelAccountId: acc.id,
        providerAccountId: acc.externalAccountId,
        channel: variant.channel as Channel,
        body: version.body,
        metadata: version.metadataJson,
        assets: attached,
        visibility,
        scheduledAtUtc,
        timezone: SCHEDULE_TIMEZONE,
      });
      channels.push(variant.channel);
      prepared.push({
        ownerId,
        channelAccountId: acc.id,
        variantId: variant.id,
        variantVersionId: version.id,
        contentVersionId: version.contentVersionId,
        brandProfileId: brand?.id ?? null,
        brandProfileVersion: brand?.version ?? null,
        payloadJson: payload as unknown as Record<string, unknown>,
        payloadHash: payloadHash(payload),
        requestedResult: requested,
        visibility,
        scheduledAtUtc,
        scheduleTimezone: SCHEDULE_TIMEZONE,
        status: 'PLANNED',
        createdAt: now,
        updatedAt: now,
      });
    }
    const summary =
      input.target_summary?.trim() ||
      [...new Set(channels)].map((c) => `${CHANNEL_LABEL[c as Channel]} ${channels.filter((x) => x === c).length}`).join(' · ');
    const planRows = await tx.insert(distributionPlans).values({ ownerId, targetSummary: summary, status: 'draft', createdAt: now, updatedAt: now }).returning();
    const plan = planRows[0]!;
    const items = await tx
      .insert(distributionItems)
      .values(prepared.map((p) => ({ ...p, planId: plan.id })))
      .returning();
    await recordAudit(tx, {
      ownerId,
      action: 'plan.create',
      entity: 'distribution_plan',
      entityId: plan.id,
      details: { items: items.length, channels: [...new Set(channels)].sort().join(','), scheduled: items.filter((i) => i.scheduledAtUtc !== null).length },
      at: now,
    });
    return { plan, items: [...items].sort((a, b) => (a.id < b.id ? -1 : 1)) };
  });
}

// ---- 조회 ----

async function getPlanRow(db: DbOrTx, ownerId: string, planId: string): Promise<DistributionPlanRow | null> {
  if (!isUuid(planId)) return null;
  const rows = await db
    .select()
    .from(distributionPlans)
    .where(and(eq(distributionPlans.id, planId), eq(distributionPlans.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

export interface PlanItemDetail {
  item: DistributionItemRow;
  payload: CanonicalPayload;
  account: ChannelAccountRow | null;
  variant: { id: string; channel: string; contentId: string; lifecycle: string } | null;
  activeApproval: ApprovalRow | null;
  approvals: ApprovalRow[];
  jobs: JobRow[];
  /** T11: 원격 결과(모의 = MOCK, 실제 발행 실적 아님) */
  publications: PublicationRow[];
  /** T11: 가장 최근 작업의 이력(최근 10개, 새 것부터) */
  events: JobEventRow[];
  /** 지금 다시 검사한 스냅샷 문제(없으면 []) — 승인·실행 전 화면 안내용(서버는 승인·실행 때 다시 검사한다). */
  problems: string[];
}

export interface PlanDetail {
  plan: DistributionPlanRow;
  items: PlanItemDetail[];
}

export async function getPlanDetail(db: DbOrTx, ownerId: string, planId: string, now: Date = new Date()): Promise<PlanDetail | null> {
  const plan = await getPlanRow(db, ownerId, planId);
  if (!plan) return null;
  const items = await db
    .select()
    .from(distributionItems)
    .where(and(eq(distributionItems.ownerId, ownerId), eq(distributionItems.planId, plan.id)))
    .orderBy(asc(distributionItems.createdAt), asc(distributionItems.id));
  const ids = items.map((i) => i.id);
  const allApprovals = ids.length
    ? await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.ownerId, ownerId), inArray(approvals.distributionItemId, ids)))
        .orderBy(desc(approvals.approvedAt), desc(approvals.id))
    : [];
  const allJobs = ids.length
    ? await db
        .select()
        .from(jobs)
        .where(and(eq(jobs.ownerId, ownerId), inArray(jobs.itemId, ids)))
        .orderBy(asc(jobs.createdAt), asc(jobs.id))
    : [];
  const allPubs = ids.length
    ? await db
        .select()
        .from(publications)
        .where(and(eq(publications.ownerId, ownerId), inArray(publications.itemId, ids)))
        .orderBy(asc(publications.createdAt), asc(publications.id))
    : [];
  const out: PlanItemDetail[] = [];
  for (const item of items) {
    const mineJobs = allJobs.filter((j) => j.itemId === item.id);
    const latestJob = mineJobs.at(-1);
    const events = latestJob
      ? await db
          .select()
          .from(jobEvents)
          .where(and(eq(jobEvents.ownerId, ownerId), eq(jobEvents.jobId, latestJob.id)))
          .orderBy(desc(jobEvents.eventSeq))
          .limit(10)
      : [];
    const account = await getChannelAccount(db, ownerId, item.channelAccountId);
    const vRows = await db
      .select({ id: variants.id, channel: variants.channel, contentId: variants.contentId, lifecycle: variants.lifecycle })
      .from(variants)
      .where(and(eq(variants.id, item.variantId), eq(variants.ownerId, ownerId)))
      .limit(1);
    const mine = allApprovals.filter((a) => a.distributionItemId === item.id);
    out.push({
      item,
      payload: item.payloadJson as unknown as CanonicalPayload,
      account,
      variant: vRows[0] ?? null,
      activeApproval: mine.find((a) => a.revokedAt === null) ?? null,
      approvals: mine,
      jobs: mineJobs,
      publications: allPubs.filter((p) => p.itemId === item.id),
      events,
      problems: item.status === 'PLANNED' ? await snapshotProblems(db, ownerId, item, now) : [],
    });
  }
  return { plan, items: out };
}

export interface PlanListEntry {
  plan: DistributionPlanRow;
  itemCount: number;
  channels: string[];
  mock: boolean;
}

export async function listPlans(
  db: DbOrTx,
  ownerId: string,
  opts: { cursor?: TimeCursor | null; limit?: number } = {},
): Promise<{ items: PlanListEntry[]; next: TimeCursor | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const rows = await db
    .select({ plan: distributionPlans, at: microsText(distributionPlans.createdAt) })
    .from(distributionPlans)
    .where(and(eq(distributionPlans.ownerId, ownerId), keysetBefore(distributionPlans.createdAt, distributionPlans.id, opts.cursor)))
    .orderBy(desc(distributionPlans.createdAt), desc(distributionPlans.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const ids = page.map((r) => r.plan.id);
  const stats = ids.length
    ? await db
        .select({ planId: distributionItems.planId, channel: variants.channel, kind: channelAccounts.kind })
        .from(distributionItems)
        .innerJoin(variants, and(eq(variants.id, distributionItems.variantId), eq(variants.ownerId, distributionItems.ownerId)))
        .innerJoin(channelAccounts, and(eq(channelAccounts.id, distributionItems.channelAccountId), eq(channelAccounts.ownerId, distributionItems.ownerId)))
        .where(and(eq(distributionItems.ownerId, ownerId), inArray(distributionItems.planId, ids)))
    : [];
  const last = page.at(-1);
  return {
    items: page.map((r) => {
      const mine = stats.filter((s) => s.planId === r.plan.id);
      return { plan: r.plan, itemCount: mine.length, channels: [...new Set(mine.map((s) => s.channel))].sort(), mock: mine.every((s) => s.kind === 'mock') };
    }),
    next: rows.length > limit && last ? { at: last.at, id: last.plan.id } : null,
  };
}

// ---- 승인 ----

export interface ApproveResult {
  plan: DistributionPlanRow;
  approvals: ApprovalRow[];
}

/**
 * 선택 승인(한 트랜잭션, 전역 잠금 순서). 항목: 이 계획의 것(404) · PLANNED(409 item_not_planned) · expected hash = 저장 hash(409 hash_mismatch) ·
 * purpose = requested_result(400) · 활성 승인 없음(409 already_approved) · 스냅샷 = 지금의 실제 행(409 snapshot_stale — 감사 approval.refused 만 남기고
 * 항목은 PLANNED 그대로, 새 계획 필요). 통과하면 승인 행 + 파생본 review → approved + 계획 상태.
 */
export async function approveItems(db: Db, ownerId: string, planId: string, input: ApproveInput, now: Date = new Date()): Promise<ApproveResult> {
  if (!isUuid(planId)) throw new NotFoundError(PLAN_NOT_FOUND);
  const out = await db.transaction(async (tx) => {
    const plan = await getPlanRow(tx, ownerId, planId);
    if (!plan) throw new NotFoundError(PLAN_NOT_FOUND);
    const ids = [...new Set(input.item_ids)];
    const owned = await tx
      .select({ id: distributionItems.id })
      .from(distributionItems)
      .where(and(eq(distributionItems.ownerId, ownerId), eq(distributionItems.planId, plan.id), inArray(distributionItems.id, ids)));
    if (owned.length !== ids.length) throw new NotFoundError(ITEM_NOT_FOUND);
    const items = await lockItemsInOrder(tx, ownerId, ids);
    const notPlanned = items.filter((i) => i.status !== 'PLANNED');
    if (notPlanned.length) {
      throw new AppError('conflict', 'item_not_planned', '대기(PLANNED) 상태의 항목만 승인할 수 있습니다', { item_ids: notPlanned.map((i) => i.id) });
    }
    const mismatched = items.filter((i) => input.expected_hashes[i.id] !== i.payloadHash).map((i) => i.id);
    if (mismatched.length) throw new HashMismatchError(mismatched);
    const wrongPurpose = items.filter((i) => i.requestedResult !== input.purpose).map((i) => i.id);
    if (wrongPurpose.length) throw new AppError('bad_request', 'purpose_mismatch', '승인 목적(purpose)이 항목의 요청 결과와 다릅니다', { item_ids: wrongPurpose });
    const active = await activeApprovalsFor(tx, ownerId, ids);
    if (active.size) throw new AppError('conflict', 'already_approved', '이미 승인한 항목이 있습니다', { item_ids: [...active.keys()] });
    const refused: Array<{ item_id: string; reasons: string[] }> = [];
    for (const item of items) {
      const problems = await snapshotProblems(tx, ownerId, item, now);
      if (problems.length) refused.push({ item_id: item.id, reasons: problems });
    }
    if (refused.length) {
      for (const r of refused) {
        await recordAudit(tx, {
          ownerId,
          action: 'approval.refused',
          entity: 'distribution_item',
          entityId: r.item_id,
          details: { reasons: r.reasons.join(',') },
          at: now,
        });
      }
      return { refused };
    }
    const created: ApprovalRow[] = [];
    for (const item of items) {
      const rows = await tx
        .insert(approvals)
        .values({
          ownerId,
          distributionItemId: item.id,
          payloadHash: item.payloadHash,
          purpose: item.requestedResult,
          approvalVersion: 1,
          approvedAt: now,
          createdAt: now,
        })
        .returning();
      created.push(rows[0]!);
      await recordAudit(tx, {
        ownerId,
        action: 'approval.grant',
        entity: 'approval',
        entityId: rows[0]!.id,
        versionOrHash: item.payloadHash,
        details: { item_id: item.id, payload_hash: item.payloadHash },
        at: now,
      });
    }
    for (const vid of [...new Set(items.map((i) => i.variantId))].sort()) {
      const v = await tx
        .select({ lifecycle: variants.lifecycle, channel: variants.channel })
        .from(variants)
        .where(and(eq(variants.id, vid), eq(variants.ownerId, ownerId)))
        .limit(1);
      if (v[0]?.lifecycle === 'review' && canVariantTransition('review', 'approved', 'approval')) {
        await tx.update(variants).set({ lifecycle: 'approved', updatedAt: now }).where(and(eq(variants.id, vid), eq(variants.ownerId, ownerId)));
        await recordAudit(tx, {
          ownerId,
          action: 'variant.lifecycle',
          entity: 'variant',
          entityId: vid,
          details: { channel: v[0].channel, from: 'review', to: 'approved', cause: 'approval' },
          at: now,
        });
      }
    }
    await recomputePlanStatus(tx, ownerId, plan.id, now);
    return { plan: (await getPlanRow(tx, ownerId, plan.id))!, approvals: created };
  });
  if ('refused' in out && out.refused) throw new SnapshotStaleError(out.refused);
  return out as ApproveResult;
}

// ---- 철회 ----

export async function revokeApproval(db: Db, ownerId: string, approvalId: string, reason: string | undefined, now: Date = new Date()) {
  if (!isUuid(approvalId)) throw new NotFoundError('승인을 찾을 수 없습니다');
  return db.transaction(async (tx) => {
    const peek = await tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, approvalId), eq(approvals.ownerId, ownerId)))
      .limit(1);
    if (!peek[0]) throw new NotFoundError('승인을 찾을 수 없습니다');
    const [item] = await lockItemsInOrder(tx, ownerId, [peek[0].distributionItemId]);
    if (!item) throw new NotFoundError(ITEM_NOT_FOUND);
    const locked = await tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, approvalId), eq(approvals.ownerId, ownerId)))
      .for('update')
      .limit(1);
    if (locked[0]!.revokedAt !== null) throw new AppError('conflict', 'already_revoked', '이미 철회했거나 무효가 된 승인입니다');
    const text = reason?.trim();
    const revoked = await revokeActiveApprovalsLocked(tx, ownerId, [item], () => (text ? `user: ${text}` : 'user'), now, { action: 'approval.revoke' });
    // T11(D18, docs/03): 이미 전송 단계에 들어간 작업은 되돌렸다고 주장하지 않고 CANCEL_REQUESTED 로 추적한다.
    const cancelRequestedJobIds = await requestCancelLocked(tx, ownerId, item.id, 'approval_revoked', now);
    await settleApprovedVariants(tx, ownerId, [item.variantId], 'review', now);
    await recomputePlanStatus(tx, ownerId, item.planId, now);
    const after = await tx.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1);
    return { approval: after[0]!, planId: item.planId, blockedJobIds: revoked[0]?.blockedJobIds ?? [], cancelRequestedJobIds };
  });
}

// ---- 실행 ----

export interface ExecuteResult {
  plan_id: string;
  queued: Array<{ item_id: string; job_id: string; mode: 'MOCK' }>;
  mode: 'MOCK';
  notice: string;
  idempotent_replay: boolean;
}

type StoredExecute = Omit<ExecuteResult, 'idempotent_replay'>;

const commandHash = (key: string) => createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);

async function findCommand(db: DbOrTx, ownerId: string, commandKey: string) {
  const rows = await db
    .select()
    .from(executeCommands)
    .where(and(eq(executeCommands.ownerId, ownerId), eq(executeCommands.commandKey, commandKey)))
    .limit(1);
  return rows[0] ?? null;
}

function replayOf(row: typeof executeCommands.$inferSelect, planId: string): ExecuteResult {
  if (row.planId !== planId) throw new AppError('conflict', 'command_key_reused', '이 실행 키(command_key)는 다른 배포 계획에 이미 쓰였습니다');
  return { ...(row.resultJson as unknown as StoredExecute), idempotent_replay: true };
}

function pgConstraint(e: unknown): string | null {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur; i++) {
    const c = cur as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (c.code === '23505' && typeof c.constraint === 'string') return c.constraint;
    cur = c.cause;
  }
  return null;
}

/**
 * 실행(한 트랜잭션). (1) 같은 command_key → 저장된 결과(idempotent_replay, 변경 없음) (2) 계획·항목 잠금 (3) 항목마다 PLANNED ·
 * 활성 승인(hash = 항목 hash, 아니면 403 approval_required — 전체 거부, 아무것도 넣지 않음) · 스냅샷 재검사(어긋나면 409 snapshot_stale —
 * 전체 거부 후 별도 트랜잭션에서 그 승인을 철회) · assertExecutionAllowed(모의 → MOCK) (4) QUEUED 작업 + job_event 1 + 항목 QUEUED + 계획 executing
 * (5) execute_commands 기록. item_ids 가 없으면 이 계획의 "승인된 PLANNED 항목" 전부.
 */
export async function executePlan(
  db: Db,
  ownerId: string,
  planId: string,
  input: { commandKey: string; itemIds?: readonly string[] },
  config: Pick<AppConfig, 'PUBLISH_MODE'>,
  now: Date = new Date(),
): Promise<ExecuteResult> {
  if (!isUuid(planId)) throw new NotFoundError(PLAN_NOT_FOUND);
  const prior = await findCommand(db, ownerId, input.commandKey);
  if (prior) return replayOf(prior, planId);
  let outcome: { replay: ExecuteResult } | { stale: Array<{ item_id: string; reasons: string[] }> } | { result: ExecuteResult };
  try {
    outcome = await db.transaction(async (tx) => {
      const planRows = await tx
        .select()
        .from(distributionPlans)
        .where(and(eq(distributionPlans.id, planId), eq(distributionPlans.ownerId, ownerId)))
        .for('update')
        .limit(1);
      const plan = planRows[0];
      if (!plan) throw new NotFoundError(PLAN_NOT_FOUND);
      const again = await findCommand(tx, ownerId, input.commandKey);
      if (again) return { replay: replayOf(again, plan.id) };
      const all = await tx
        .select()
        .from(distributionItems)
        .where(and(eq(distributionItems.ownerId, ownerId), eq(distributionItems.planId, plan.id)))
        .orderBy(asc(distributionItems.id))
        .for('update');
      const active = await activeApprovalsFor(
        tx,
        ownerId,
        all.map((i) => i.id),
      );
      let selected: DistributionItemRow[];
      if (input.itemIds) {
        const want = new Set(input.itemIds);
        selected = all.filter((i) => want.has(i.id));
        if (selected.length !== want.size) throw new NotFoundError(ITEM_NOT_FOUND);
        if (selected.some((i) => i.status !== 'PLANNED')) throw new AlreadyExecutedError();
        const missing = selected.filter((i) => active.get(i.id)?.payloadHash !== i.payloadHash).map((i) => i.id);
        if (missing.length) throw new ApprovalRequiredForExecuteError(missing);
      } else {
        selected = all.filter((i) => i.status === 'PLANNED' && active.get(i.id)?.payloadHash === i.payloadHash);
        if (selected.length === 0) {
          if (all.some((i) => i.status !== 'PLANNED')) throw new AlreadyExecutedError();
          throw new ApprovalRequiredForExecuteError(all.map((i) => i.id));
        }
      }
      const stale: Array<{ item_id: string; reasons: string[] }> = [];
      for (const item of selected) {
        const problems = await snapshotProblems(tx, ownerId, item, now);
        if (problems.length) stale.push({ item_id: item.id, reasons: problems });
      }
      if (stale.length) return { stale };
      const queued: ExecuteResult['queued'] = [];
      for (const item of selected) {
        const approval = active.get(item.id)!;
        const accRows = await tx
          .select({ kind: channelAccounts.kind })
          .from(channelAccounts)
          .where(and(eq(channelAccounts.id, item.channelAccountId), eq(channelAccounts.ownerId, ownerId)))
          .limit(1);
        const { mode } = assertExecutionAllowed(config as AppConfig, {
          accountKind: accRows[0]?.kind === 'mock' ? 'mock' : 'live',
          payloadHash: item.payloadHash,
          approval: { id: approval.id, payloadHash: approval.payloadHash, revokedAt: approval.revokedAt },
        });
        const jobRows = await tx
          .insert(jobs)
          .values({
            ownerId,
            kind: 'publish',
            itemId: item.id,
            payloadRef: item.id,
            state: 'QUEUED',
            attempt: 0,
            nextRunAt: item.scheduledAtUtc ?? now,
            idempotencyKey: `publish:${item.id}:${approval.id}`,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        const job = jobRows[0]!;
        await tx.insert(jobEvents).values({
          ownerId,
          jobId: job.id,
          eventSeq: 1,
          stateBefore: null,
          stateAfter: 'QUEUED',
          at: now,
          sanitizedDetails: { event: 'execute', mode, approval_id: approval.id, command_key_sha256: commandHash(input.commandKey) },
        });
        const upd = await tx
          .update(distributionItems)
          .set({ status: 'QUEUED', updatedAt: now })
          .where(and(eq(distributionItems.id, item.id), eq(distributionItems.ownerId, ownerId), eq(distributionItems.status, 'PLANNED')))
          .returning({ id: distributionItems.id });
        if (!upd[0]) throw new AlreadyExecutedError();
        queued.push({ item_id: item.id, job_id: job.id, mode });
      }
      await recomputePlanStatus(tx, ownerId, plan.id, now);
      const stored: StoredExecute = { plan_id: plan.id, queued, mode: 'MOCK', notice: MOCK_EXECUTE_NOTICE };
      await tx.insert(executeCommands).values({
        ownerId,
        planId: plan.id,
        commandKey: input.commandKey,
        createdAt: now,
        resultJson: stored as unknown as Record<string, unknown>,
      });
      await recordAudit(tx, {
        ownerId,
        action: 'plan.execute',
        entity: 'distribution_plan',
        entityId: plan.id,
        versionOrHash: commandHash(input.commandKey),
        details: { command_key_sha256: commandHash(input.commandKey), queued: queued.length, mode: 'MOCK' },
        at: now,
      });
      return { result: { ...stored, idempotent_replay: false } };
    });
  } catch (e) {
    const c = pgConstraint(e);
    if (c === 'execute_commands_owner_key_uq') {
      const row = await findCommand(db, ownerId, input.commandKey);
      if (row) return replayOf(row, planId);
    }
    if (c === 'jobs_idempotency_key_uq' || c === 'jobs_active_item_uq') throw new AlreadyExecutedError();
    throw e;
  }
  if ('replay' in outcome) return outcome.replay;
  if ('stale' in outcome) {
    const stale = outcome.stale;
    // 이중 방어: 편집 훅이 놓친 변경(예: 예약 시각 경과)도 여기서 승인을 철회한다. 실행은 전체 거부(아무것도 대기열에 넣지 않음).
    await db.transaction(async (tx) => {
      const locked = await lockItemsInOrder(
        tx,
        ownerId,
        stale.map((s) => s.item_id),
      );
      const recheck: Array<{ itemId: string; reason: InvalidationReason }> = [];
      for (const item of locked) {
        const problems = await snapshotProblems(tx, ownerId, item, now);
        if (problems.length) recheck.push({ itemId: item.id, reason: invalidationReasonOf(problems) });
      }
      await invalidateItems(tx, ownerId, recheck, now);
    });
    throw new SnapshotStaleError(stale);
  }
  return outcome.result;
}

// ---- 응답 모양 ----

export function channelAccountView(a: ChannelAccountRow) {
  return {
    id: a.id,
    platform: a.platform,
    kind: a.kind,
    mock: a.kind === 'mock',
    external_account_id: a.externalAccountId,
    display_name: a.displayName,
    state: a.state,
    ready: accountReady(a),
    capability_snapshot: a.capabilitySnapshot,
    created_at: a.createdAt.toISOString(),
  };
}

export function approvalView(a: ApprovalRow) {
  return {
    id: a.id,
    distribution_item_id: a.distributionItemId,
    payload_hash: a.payloadHash,
    purpose: a.purpose,
    approval_version: a.approvalVersion,
    approved_at: a.approvedAt.toISOString(),
    revoked_at: a.revokedAt ? a.revokedAt.toISOString() : null,
    revoke_reason: a.revokeReason,
    active: a.revokedAt === null,
  };
}

/** 작업 응답 모양(비밀·본문 없음). lease_owner 는 worker 표시 이름(호스트 이름을 넣지 않는다). */
export function jobView(j: JobRow) {
  return {
    id: j.id,
    kind: j.kind,
    item_id: j.itemId,
    state: j.state,
    attempt: j.attempt,
    max_attempts: j.maxAttempts,
    next_run_at: j.nextRunAt.toISOString(),
    leased: j.leaseOwner !== null,
    lease_owner: j.leaseOwner,
    lease_until: j.leaseUntil ? j.leaseUntil.toISOString() : null,
    heartbeat_at: j.heartbeatAt ? j.heartbeatAt.toISOString() : null,
    last_error_code: j.lastErrorCode,
    last_retry_class: j.lastRetryClass,
    reconcile_count: j.reconcileCount,
    cancel_requested_at: j.cancelRequestedAt ? j.cancelRequestedAt.toISOString() : null,
    done_at: j.doneAt ? j.doneAt.toISOString() : null,
    idempotency_key: j.idempotencyKey,
    mode: 'MOCK' as const,
    created_at: j.createdAt.toISOString(),
    updated_at: j.updatedAt.toISOString(),
  };
}

export function planView(p: DistributionPlanRow) {
  return {
    id: p.id,
    target_summary: p.targetSummary,
    status: p.status,
    revision: p.revision,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}

export function itemView(i: DistributionItemRow) {
  return {
    id: i.id,
    plan_id: i.planId,
    channel_account_id: i.channelAccountId,
    variant_id: i.variantId,
    variant_version_id: i.variantVersionId,
    content_version_id: i.contentVersionId,
    requested_result: i.requestedResult,
    visibility: i.visibility,
    scheduled_at_utc: i.scheduledAtUtc ? i.scheduledAtUtc.toISOString() : null,
    schedule_timezone: i.scheduleTimezone,
    status: i.status,
    payload_hash: i.payloadHash,
    payload: i.payloadJson,
  };
}

export function planDetailView(d: PlanDetail) {
  return {
    plan: planView(d.plan),
    mode: 'MOCK' as const,
    items: d.items.map((x) => ({
      ...itemView(x.item),
      account: x.account ? channelAccountView(x.account) : null,
      variant: x.variant,
      active_approval: x.activeApproval ? approvalView(x.activeApproval) : null,
      approvals: x.approvals.map(approvalView),
      jobs: x.jobs.map(jobView),
      publications: x.publications.map(publicationViewOf),
      problems: x.problems,
    })),
  };
}

/** 원고 화면용: 파생본별 가장 최근 계획(승인됨 파생본에서 계획 링크). */
export async function latestPlanForVariants(db: DbOrTx, ownerId: string, variantIds: readonly string[]): Promise<Map<string, string>> {
  if (variantIds.length === 0) return new Map();
  const rows = await db
    .select({ variantId: distributionItems.variantId, planId: distributionItems.planId })
    .from(distributionItems)
    .where(and(eq(distributionItems.ownerId, ownerId), inArray(distributionItems.variantId, [...variantIds])))
    .orderBy(desc(distributionItems.createdAt), desc(distributionItems.id));
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.variantId)) out.set(r.variantId, r.planId);
  return out;
}

/** 원고의 review|approved 파생본(배포 계획 만들기 화면). */
export async function reviewVariantsOfContent(db: DbOrTx, ownerId: string, contentId: string) {
  if (!isUuid(contentId)) return [];
  return db
    .select()
    .from(variants)
    .where(and(eq(variants.ownerId, ownerId), eq(variants.contentId, contentId), inArray(variants.lifecycle, ['review', 'approved'])))
    .orderBy(asc(variants.channel));
}

