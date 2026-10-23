/**
 * T11(결정 D18) 배포 작업 처리기 — DB 작업함(transactional outbox)·lease·재시도·원격 재확인·취소.
 *
 * 흐름(tick 한 번): lease 만료 복구 → lease(짧은 트랜잭션, FOR UPDATE SKIP LOCKED) → 작업마다 처리.
 * 전송 처리(processJob, LEASED 작업):
 *   1) 트랜잭션: 항목·승인·작업 잠금 → 취소 요청·활성 승인(hash)·스냅샷·실행 모드·어댑터 검증을 **다시** 검사 →
 *      LEASED → SENDING + 항목 SENDING + 전송 의도(send_intents, key = '<job>:<attempt>') 기록. 여기까지가 한 트랜잭션(docs/03).
 *   2) DB 잠금 없이 adapter.prepare/submit(heartbeat 로 lease 연장, 시간 제한 넘으면 결과 불명).
 *   3) 트랜잭션: 의도에 결과를 한 번 기록하고 도메인 전이 표(transitionJob)로 다음 상태 — CONFIRMED(+publications, MOCK)·REMOTE_PROCESSING·
 *      RETRY_WAIT·FAILED·BLOCKED·RECONCILING. 취소 요청이 그 사이에 왔으면 원격 사실을 따른다(받아들여졌으면 cancel_too_late, A11).
 * 조회 처리(RECONCILING·REMOTE_PROCESSING·CANCEL_REQUESTED): adapter.reconcile(읽기만) → 찾음 CONFIRMED / 확실히 없음 RETRY_WAIT(새 시도 = 새 의도)
 *   / 확인 불가 3회 → UNKNOWN. UNKNOWN 은 lease 하지 않는다 — 자동 재전송 없음(A08), 사용자 재확인(reconcileItem)만.
 * lease 만료: 의도가 있으면 RECONCILING(재전송 금지, A20), 없으면 QUEUED 로 되돌린다.
 *
 * 잠금 순서(T10 과 같음): contents → variants → distribution_plans → distribution_items → approvals → jobs → send_intents/publications.
 * lease 트랜잭션은 jobs 만 잠근다(다른 잠금을 기다리지 않음). 외부 호출(어댑터) 중에는 어떤 DB 트랜잭션도 열어 두지 않는다.
 * 작업 이력(job_events.sanitized_details)에는 코드·시도 번호·재시도 분류·외부 ID 만 넣는다 — 본문·토큰 없음.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  AccountCredentialBlockedError,
  AppError,
  assertExecutionAllowed,
  CANCEL_PENDING_MESSAGE,
  CHECK_LEASE_STATES,
  classifyOutcome,
  countedAttempts,
  decideRetry,
  decideRetryAt,
  DEFAULT_LEASE_TTL_MS,
  FREE_RESUME_MAX,
  isAllowedThreadsPermalink,
  sanitizeThreadsDiag,
  type ThreadsDiag,
  isScheduleStale,
  LIVE_THREADS_EXTERNAL_ID_RE,
  LIVE_SUBMIT_BUDGET_MS,
  LIVE_PUBLISH_PAUSED_STEP_CODE,
  livePublishDailyLockName,
  staleScheduleConfirmedBy,
  LEGACY_SEND_ADAPTER_ID,
  localRateLimitDecision,
  requireSecretKeyring,
  isUuid,
  LEASE_HELD_STATES,
  LeaseLostError,
  PRE_INTENT_EXPIRY_LIMIT,
  NotCancellableError,
  NotFoundError,
  NothingToReconcileError,
  NotRetryableError,
  SnapshotStaleError,
  RECONCILE_BASE_MS,
  RECONCILE_MAX_ATTEMPTS,
  reconcileDelay,
  resumeProvenRetryable,
  restoredCancelNotSentProven,
  REMOTE_POLL_MAX,
  REMOTE_POLL_MS,
  recordedAdapterIdOf,
  RESTORED_ITEM_RETRY_MESSAGE,
  RESTORED_ITEM_RETRY_MOCK_MESSAGE,
  RESTORED_JOB_RETRY_MESSAGE,
  RESTORED_JOB_RETRY_MOCK_MESSAGE,
  RESTORED_UNKNOWN_RETRY_MOCK_MESSAGE,
  SCHEDULE_STALE_RETRY_MESSAGE,
  SEND_LEASE_STATES,
  type AdapterContext,
  type AdapterId,
  type AdapterResult,
  type AppConfig,
  type CancelResult,
  type ChannelAdapter,
  type ChannelAdapterRegistry,
  type JobEvent,
  type JobState,
  type MediaReader,
  type MockScenarioSetting,
  type PublishSnapshot,
  type ReconcileResult,
  type RemoteReference,
  type RemoteStep,
  type RemoteStepKind,
  type UploadSliceBudget,
} from '@cs/domain';
import {
  activeApprovalsFor,
  lockAccountsInOrder,
  lockItemsInOrder,
  partialSendOf,
  recomputePlanStatus,
  requestCancelLocked,
  revokeActiveApprovalsLocked,
  settleApprovedVariants,
  syncItemStatus,
  THREAD_PARTIAL_REVOKED_CODE,
  transitionJob,
  type DistributionItemRow,
  type JobRow,
} from './approval-invalidation';
import type { Db } from './client';
import { invalidationReasonOf, jobView, publicationViewOf, snapshotProblems } from './distribution';
import { getLivePublishPaused, liveApprovalUsage, livePublishDailyUsage } from './live-publish';
import { mediaPortFor } from './media-spec';
import { mockScenarioFor } from './mock-scenarios';
import { credentialGate, readAccessTokenForSend, type KeyringSource } from './oauth';
import { accountRateSnapshot, listRemoteSteps, publishedStepCount, remoteStepsPort, type RateInflightJob } from './remote-steps';
import { recordAudit, type DbOrTx } from './queries';
import { channelAccounts, distributionItems, jobEvents, jobs, publications, sendIntents, variants } from './schema';

export type SendIntentRow = typeof sendIntents.$inferSelect;
export type PublicationRow = typeof publications.$inferSelect;

const ITEM_NOT_FOUND = '배포 항목을 찾을 수 없습니다';

export interface JobRunOptions {
  /** lease 소유자 표시(호스트 이름을 넣지 않는다 — 예: 'cli-1a2b3c4d') */
  workerId: string;
  /** LIVE-P1(D38): 실제 게시 환경 조건(PUBLISH_LIVE_*)도 여기서 읽는다(없으면 실제 게시 차단). */
  config: Pick<AppConfig, 'PUBLISH_MODE' | 'PUBLISH_LIVE_APPROVAL_REF' | 'PUBLISH_LIVE_MAX_POSTS'> & Partial<Pick<AppConfig, 'PUBLISH_LIVE_DAILY_MAX'>>;
  /** 시계(테스트 주입). 기본 new Date() */
  clock?: () => Date;
  leaseTtlMs?: number;
  submitTimeoutMs?: number;
  /** jitter 난수(테스트 주입) */
  random?: () => number;
  /** 한 owner 의 작업만(POST /api/worker/tick) */
  ownerId?: string;
  /**
   * LIVEP1-TIMEOUT: 실제(live) 어댑터 작업의 전송·조회 예산(ms). 실제 작업은 max(submitTimeoutMs, 이 값 — 기본 LIVE_SUBMIT_BUDGET_MS 60초)을 쓴다.
   * 모의 작업은 submitTimeoutMs 그대로(모의 시간 시험 불변). 시험만 이 값을 줄여 "표식 전 예산 부족"을 재현한다.
   */
  liveSubmitTimeoutMs?: number;
  /**
   * FIX-LIVEP1(Codex P1 distribute/[id]/page.tsx): 한 배포 계획의 작업만 lease 한다(계획 화면의 "작업 처리 실행" 버튼). 화면 안내(모의만·실제 게시 포함)가
   * 그 계획의 항목과 맞게 — 다른 계획의 실제 게시 작업을 이 버튼이 처리하지 않는다. lease 만료 복구는 범위와 관계없이 그대로(외부 호출 없음).
   */
  planId?: string;
  /**
   * T14(D26): 연결 정보가 필요한 어댑터(Threads 모의)용. keyring 이 없으면 process.env 의 마스터 키(@cs/domain requireSecretKeyring — 앱과 같은
   * 출처)를 쓰고, 키가 없으면 어댑터가 원격 호출 없이 auth 로 닫는다. check = 401(auth) 뒤 T13 연결 확인 경로(checkCredential)를 한 번 부른다.
   */
  credentials?: {
    keyring?: KeyringSource;
    check?: (ownerId: string, accountId: string, now: Date) => Promise<unknown>;
    /**
     * T15(D27): Google 형(짧은 access token) 연결 정보 — 봉인한 access token 이 만료(또는 곧 만료)면 보내기 전에 T13 갱신 경로(refreshCredential)를
     * 한 번 부르고 다시 읽는다. 없으면 갱신하지 않는다(어댑터는 credential_access_token_stale 로 원격 호출 없이 닫는다).
     */
    refresh?: (ownerId: string, accountId: string, now: Date) => Promise<unknown>;
  };
  /**
   * T15(D27): 업로드할 미디어 파일을 저장소에서 범위로 읽는 함수(web·CLI 는 로컬 저장소). 없으면 미디어가 필요한 어댑터(YouTube 모의)는
   * 원격 호출 없이 media_reader_unavailable 로 닫는다.
   */
  media?: MediaReader;
  /**
   * FIX-T15(Codex review-T15 P1, docs/02 "웹 요청 안에서 전체 영상 처리 금지"): 한 번의 전송 실행이 보낼 조각 예산. web 요청 안의 tick
   * (POST /api/worker/tick·inline worker)은 이 값을 넣는다 — 어댑터는 예산을 쓰면 받은 바이트를 기록하고 양보(upload_yield → RETRY_WAIT 즉시),
   * 다음 tick 이 같은 세션으로 이어 올린다. 없으면(별도 worker 프로세스) 제한 없음.
   */
  uploadSlice?: UploadSliceBudget;
  /**
   * 시험 전용(FIX-T14 round 2, Codex review-FIX-T14 P1): 로컬 요청 제한 검사 안(계정 advisory 잠금을 잡은 같은 트랜잭션)에서 부른다.
   * phase = 'before_snapshot'(잠금 직후·읽기 전) | 'after_usage'(창 안 사용량을 읽은 직후). 다른 작업의 커밋이 끼어드는 순서를 강제하는 데만 쓴다.
   */
  rateCheckHook?: (tx: DbOrTx, at: { phase: 'before_snapshot' | 'after_usage'; jobId: string; accountId: string }) => Promise<void>;
  /**
   * 시험 전용(LIVE-P2): 실제 게시 일일 판정 안(owner 별 일일 잠금을 잡은 같은 트랜잭션)에서 부른다. phase = 'after_daily_lock'(잠금 직후·중지 확인 전) |
   * 'after_daily_usage'(창 안 사용량을 읽은 직후). 두 작업 처리기의 판정 순서를 시험에서 관찰·강제하는 데만 쓴다.
   */
  liveDailyHook?: (tx: DbOrTx, at: { phase: 'after_daily_lock' | 'after_daily_usage'; jobId: string }) => Promise<void>;
}

export function newWorkerId(prefix: string): string {
  const p = prefix.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16) || 'worker';
  return `${p}-${randomUUID().slice(0, 8)}`;
}

const addMs = (d: Date, ms: number) => new Date(d.getTime() + ms);

// ---- 조회 헬퍼 ----

async function jobForUpdate(tx: DbOrTx, ownerId: string, jobId: string): Promise<JobRow | null> {
  const rows = await tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.ownerId, ownerId)))
    .for('update')
    .limit(1);
  return rows[0] ?? null;
}

async function intentFor(tx: DbOrTx, ownerId: string, jobId: string, attempt: number, lock = false): Promise<SendIntentRow | null> {
  const q = tx
    .select()
    .from(sendIntents)
    .where(and(eq(sendIntents.ownerId, ownerId), eq(sendIntents.jobId, jobId), eq(sendIntents.attempt, attempt)))
    .limit(1);
  const rows = lock ? await q.for('update') : await q;
  return rows[0] ?? null;
}

async function latestIntent(tx: DbOrTx, ownerId: string, jobId: string): Promise<SendIntentRow | null> {
  const rows = await tx
    .select()
    .from(sendIntents)
    .where(and(eq(sendIntents.ownerId, ownerId), eq(sendIntents.jobId, jobId)))
    .orderBy(desc(sendIntents.attempt))
    .limit(1);
  return rows[0] ?? null;
}

async function accountOf(tx: DbOrTx, ownerId: string, accountId: string) {
  const rows = await tx
    .select()
    .from(channelAccounts)
    .where(and(eq(channelAccounts.id, accountId), eq(channelAccounts.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

async function itemRow(tx: DbOrTx, ownerId: string, itemId: string): Promise<DistributionItemRow | null> {
  const rows = await tx
    .select()
    .from(distributionItems)
    .where(and(eq(distributionItems.id, itemId), eq(distributionItems.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

function adapterAccount(a: typeof channelAccounts.$inferSelect) {
  return {
    id: a.id,
    kind: a.kind === 'mock' ? ('mock' as const) : ('live' as const),
    platform: a.platform,
    external_account_id: a.externalAccountId,
    credential_state: a.credentialState,
  };
}

/** 항목 스냅샷(어댑터가 받는 불변 payload). */
function snapshotOf(item: DistributionItemRow, acc: typeof channelAccounts.$inferSelect, channel: string): PublishSnapshot {
  return {
    item_id: item.id,
    channel,
    account: adapterAccount(acc),
    payload: item.payloadJson,
    payload_hash: item.payloadHash,
    visibility: item.visibility,
    requested_result: item.requestedResult,
    scheduled_at_utc: item.scheduledAtUtc ? item.scheduledAtUtc.toISOString() : null,
  };
}

/**
 * FIX-T13(Codex review-T13 Q3): 항목의 계정을 전역 잠금 순서의 첫 단계로 FOR SHARE 잠근다(항목 잠금보다 먼저).
 * 연결 정보 변경(연결·갱신·확인·해제·교체)은 같은 계정을 FOR UPDATE 로 잡으므로, 차단 상태가 먼저 커밋되면 이 트랜잭션은 그 뒤에 읽고
 * 전송 의도를 만들지 않는다. 항목의 channel_account_id 는 스냅샷 열(트리거로 불변)이라 잠그기 전에 읽어도 바뀌지 않는다.
 */
async function shareLockItemAccount(tx: DbOrTx, ownerId: string, itemId: string): Promise<void> {
  const rows = await tx
    .select({ accountId: distributionItems.channelAccountId })
    .from(distributionItems)
    .where(and(eq(distributionItems.id, itemId), eq(distributionItems.ownerId, ownerId)))
    .limit(1);
  if (rows[0]) await lockAccountsInOrder(tx, ownerId, [rows[0].accountId], 'share');
}

async function lockItem(tx: DbOrTx, ownerId: string, itemId: string): Promise<DistributionItemRow> {
  const [item] = await lockItemsInOrder(tx, ownerId, [itemId]);
  if (!item) throw new NotFoundError(ITEM_NOT_FOUND);
  return item;
}

/**
 * FIX-T11 round 2: 가장 최근 취소 요청이 전송 시작 전(LEASED·QUEUED)에 기록됐는지 — 그렇다면 이번 lease 에서는 보내지 않았다.
 * attempt 는 전송 의도를 쓸 때만 오르므로 "현재 attempt 의 의도 유무"로는 이전 시도의 의도와 구분할 수 없다. 기록이 없으면 false(조회로 확인).
 */
async function cancelRequestedBeforeSend(tx: DbOrTx, jobId: string): Promise<boolean> {
  const rows = await tx
    .select({ before: jobEvents.stateBefore })
    .from(jobEvents)
    .where(and(eq(jobEvents.jobId, jobId), sql`${jobEvents.sanitizedDetails}->>'transition' = 'cancel_requested'`))
    .orderBy(desc(jobEvents.eventSeq))
    .limit(1);
  return rows[0]?.before === 'LEASED' || rows[0]?.before === 'QUEUED';
}

/** 전이 + 항목 상태 동기화 + 계획 재계산(같은 트랜잭션). */
async function settle(
  tx: DbOrTx,
  ownerId: string,
  job: Pick<JobRow, 'id' | 'state'>,
  item: DistributionItemRow,
  event: JobEvent,
  details: Record<string, unknown>,
  now: Date,
  set: Parameters<typeof transitionJob>[6] = {},
  itemOverride?: string,
): Promise<JobState> {
  const to = await transitionJob(tx, ownerId, job, event, details, now, set);
  await syncItemStatus(tx, ownerId, item.id, to, now, itemOverride);
  await recomputePlanStatus(tx, ownerId, item.planId, now);
  return to;
}

const CLEAR_LEASE = { leaseOwner: null, leaseUntil: null } as const;

/** 취소 요청 뒤 스레드 일부가 이미 게시돼 남은 부분을 보내지 않고 UNKNOWN 으로 둔 작업의 사유 코드(조회·보내기 직전·결과·lease 만료 복구 공통). */
const THREAD_PARTIAL_CANCEL_REQUESTED_CODE = 'thread_partial_cancel_requested';
/** 시작 전 작업(QUEUED·RETRY_WAIT·BLOCKED)의 사용자 취소 — 스레드 일부가 이미 게시돼 남은 부분을 보내지 않고 UNKNOWN(cancelItem). */
const THREAD_PARTIAL_CANCELED_CODE = 'thread_partial_canceled';
/**
 * FIX1-FULLREV(F2 후속2): 작업 처리기가 보내기 전에 스스로 멈춤(시도 한도 attempts_exhausted·보내기 전 lease 만료 한도·검증 실패) — 앞선 시도가 스레드 일부를
 * 게시했거나 게시 시도 표식이 있어 FAILED("보내지 않음")가 아니라 UNKNOWN. 남은 부분은 보내지 않는다(새 계획이 처음부터 다시 게시하지 않게).
 */
const THREAD_PARTIAL_STOPPED_CODE = 'thread_partial_stopped';
/**
 * FIX2-FULLREV(Q1): 전송 뒤 최종 실패(영구 거부·일시 오류 재시도 소진 — finishSend, 조회의 not_found 시도 한도·원격 처리 실패 — applyReconcile)인데
 * 이 작업이 이미 게시한 부분(게시 단계 publish·video)이 있어 FAILED("게시되지 않음이 확인된 실패" — 화면은 새 계획을 연다)가 아니라 UNKNOWN.
 * thread_partial_stopped("보내기 전 멈춤")와 나눈 이유: 이 작업은 보낸 뒤 원격이 남은 부분을 거절한 것이라 "보내기 전"이 아니고, 원인도 그 표(시도 한도·
 * 중단 반복·검증 실패)에 없다. 남은 부분은 보내지 않는다(새 계획이 처음부터 다시 게시하지 않게).
 */
const THREAD_PARTIAL_FAILED_CODE = 'thread_partial_failed';
/**
 * FIX2-FULLREV(FX2): 조회 한도(확인 불가 RECONCILE_MAX_ATTEMPTS·원격 처리 REMOTE_POLL_MAX)로 UNKNOWN 이 됐는데 이 작업에 이미 게시된 스레드 게시물
 * (publish 단계)이 있음 — 남은 부분의 결과를 모른다. 일반 UNKNOWN(앞선 어댑터 코드 그대로 — 화면은 "재확인 또는 새 계획 필요")이 아니라 이 코드로
 * 남겨 새 계획(게시된 부분을 처음부터 다시 게시)을 권하지 않게 한다. 다시 보내지 않는다 — 사용자 재확인(조회만)은 그대로 열려 있다.
 */
const THREAD_PARTIAL_UNRESOLVED_CODE = 'thread_partial_unresolved';
/**
 * FIX2-FULLREV(Q3): 복원한 작업(읽기 전용 이력)의 사용자 취소 — 복원된 기록이 "아무것도 보내지 않음"을 증명하지 못해(@cs/domain restoredCancelNotSentProven)
 * CANCELED(not_sent)가 아니라 UNKNOWN. 다시 보내지 않는다 — 실제 계정이면 사용자가 채널에서 직접 확인한다(FIX2-FULLREV(FX4): 모의 계정은 확인할 곳이 없어
 * 그 말을 하지 않는다 — RESTORED_CANCEL_UNVERIFIED_MOCK_MESSAGE).
 */
const RESTORED_CANCEL_UNVERIFIED_CODE = 'restored_cancel_unverified';

type TransitionSet = Parameters<typeof transitionJob>[6];

/**
 * FIX1-FULLREV(F2 후속·후속2): 부분 게시 작업을 보내지 않고 멈출 때의 결과 — 남은 부분은 보내지 않고 UNKNOWN(code, 항목도 UNKNOWN — PLANNED 덮어쓰기 없음).
 * 상태별로 JOB_TRANSITIONS 에 이미 있는 전이만 쓴다(새 전이 없음):
 * - CANCEL_REQUESTED → reconcile_unsupported(UNKNOWN) — 조회의 같은 경우(applyReconcile resumable)와 같은 모양, 사건의 reason 은 code.
 * - LEASED → blocked(BLOCKED — 멈춘 사유 reason 을 이력에 남김) → cancel_partial(UNKNOWN) 두 단계(같은 트랜잭션 — LEASED 에는 cancel_partial 이 없다).
 * - QUEUED·RETRY_WAIT·BLOCKED → cancel_partial(UNKNOWN, cause = reason). 그 밖의 상태는 전이 표가 막는다(IllegalJobTransitionError).
 * set 은 첫 전이에 함께 바꿀 열(lease 만료 횟수 등). 사건에는 not_sent:false 와 게시된 단계·게시 시도 표식 수를 남긴다.
 * FIX1-FULLREV(F2 후속2): cancelRequestedAt 은 정말 취소인 멈춤(사용자 취소 thread_partial_canceled·취소 요청 thread_partial_cancel_requested)에만 쓴다.
 * 승인 철회·무효(thread_partial_revoked)·작업 처리기의 멈춤(thread_partial_stopped)은 아무도 취소를 요청하지 않았다 — 쓰면 나중에 사용자 확인·재확인으로
 * CONFIRMED 가 됐을 때 화면이 "취소 불가(이미 전송됨)"라고 잘못 말한다(page.tsx cancelTooLate).
 * FIX2-FULLREV(Q4): 이미 취소 요청 시각이 있으면(앞선 사용자 취소·철회) 처음 시각을 지킨다 — transitionJob 이 cancelRequestedAt 을 비어 있을 때만 쓴다.
 * FIX2-FULLREV(Q1): 전송 뒤 최종 실패(thread_partial_failed)도 이 함수로 — SENDING 은 LEASED 와 같은 두 단계(blocked → cancel_partial, SENDING 에는
 * UNKNOWN 으로 가는 전이가 없다), 조회 중(RECONCILING·REMOTE_PROCESSING)은 CANCEL_REQUESTED 와 같은 reconcile_unsupported(UNKNOWN). 새 전이 없음.
 */
async function settlePartialStop(
  tx: DbOrTx,
  ownerId: string,
  job: Pick<JobRow, 'id' | 'state'>,
  item: DistributionItemRow,
  reason: string,
  details: Record<string, unknown>,
  partial: { parts: number; attempts: number },
  code: string,
  now: Date,
  set: TransitionSet = {},
): Promise<JobState> {
  const counts = { not_sent: false, published_parts: partial.parts, publish_attempts: partial.attempts };
  // FIX1-FULLREV(F2 후속2): 취소인 멈춤만 cancelRequestedAt(위 설명)
  const cancelMark = code === THREAD_PARTIAL_CANCELED_CODE || code === THREAD_PARTIAL_CANCEL_REQUESTED_CODE ? { cancelRequestedAt: now } : {};
  switch (job.state) {
    // FIX2-FULLREV(Q1): 조회 중 최종 실패(RECONCILING·REMOTE_PROCESSING)도 같은 모양 — 멈춘 원인(reason ≠ code)은 cause 로 남긴다(취소 요청 경로는 reason = code 라 사건 모양 그대로)
    case 'CANCEL_REQUESTED':
    case 'RECONCILING':
    case 'REMOTE_PROCESSING':
      return settle(tx, ownerId, job, item, 'reconcile_unsupported', { ...details, reason: code, ...(reason !== code ? { cause: reason } : {}), ...counts }, now, {
        ...set,
        ...CLEAR_LEASE,
        lastErrorCode: code,
      });
    case 'SENDING': {
      // FIX2-FULLREV(Q1): 전송 결과가 최종 실패 — 첫 사건(BLOCKED)에 결과(error_code 등)·원인(reason), 둘째 사건(UNKNOWN)에도 error_code 를 남긴다.
      const blocked = await settle(tx, ownerId, job, item, 'blocked', { ...details, reason, ...counts }, now, { ...set, ...CLEAR_LEASE, lastErrorCode: reason });
      return settle(tx, ownerId, { id: job.id, state: blocked }, item, 'cancel_partial', { cause: reason, error_code: details.error_code ?? null, ...counts }, now, {
        ...CLEAR_LEASE,
        ...cancelMark,
        lastErrorCode: code,
      });
    }
    case 'LEASED': {
      const blocked = await settle(tx, ownerId, job, item, 'blocked', { ...details, reason, ...counts }, now, { ...set, ...CLEAR_LEASE, lastErrorCode: reason });
      return settle(tx, ownerId, { id: job.id, state: blocked }, item, 'cancel_partial', { cause: reason, ...counts }, now, {
        ...CLEAR_LEASE,
        ...cancelMark,
        lastErrorCode: code,
      });
    }
    default:
      return settle(tx, ownerId, job, item, 'cancel_partial', { ...details, cause: reason, ...counts }, now, {
        ...set,
        ...CLEAR_LEASE,
        ...cancelMark,
        lastErrorCode: code,
      });
  }
}

/**
 * FIX1-FULLREV(F2 후속2): "보내지 않고 멈춤"(취소 요청·승인 철회·무효·시도 한도·보내기 전 lease 만료 한도·검증 실패)의 공용 규칙 — 작업 처리기의
 * 모든 멈춤 결정이 이 함수 하나를 거친다. 작업에 게시된 단계(publish·video)나 게시 시도 표식(publish_attempt)이 있으면(partialSendOf — 조회가 센
 * 게시물 수 reportedParts 도 함께) "보내지 않음"(CANCELED·FAILED not_sent)·실행 전(PLANNED)으로 두지 않고 settlePartialStop 으로 UNKNOWN(stop.code).
 * 없으면 notSent() — 호출자가 지금까지 하던 결정 그대로(게시된 것이 없는 작업은 어디서나 전과 같다).
 */
async function stopUnlessPartial(
  tx: DbOrTx,
  ownerId: string,
  job: Pick<JobRow, 'id' | 'state'>,
  item: DistributionItemRow,
  stop: { reason: string; code: string; details?: Record<string, unknown>; set?: TransitionSet; reportedParts?: number },
  now: Date,
  notSent: () => Promise<JobState>,
): Promise<JobState> {
  const found = await partialSendOf(tx, ownerId, job.id);
  const parts = Math.max(found?.parts ?? 0, stop.reportedParts ?? 0);
  const attempts = found?.attempts ?? 0;
  if (parts === 0 && attempts === 0) return notSent();
  return settlePartialStop(tx, ownerId, job, item, stop.reason, stop.details ?? {}, { parts, attempts }, stop.code, now, stop.set);
}

/** FIX2-FULLREV(Q1): 최종 실패 판정에서 "이미 게시된 부분"으로 세는 단계(게시 시도 표식 publish_attempt 는 세지 않는다 — failUnlessPartial). */
const PUBLISHED_PART_KINDS: readonly RemoteStepKind[] = ['publish', 'video'];

/**
 * FIX2-FULLREV(Q1): 전송 뒤 최종 실패(FAILED)의 공용 규칙 — finishSend 의 영구 거부·일시 오류 재시도 소진, applyReconcile 의 not_found 시도 한도·원격 처리 실패.
 * 이 작업에 이미 게시된 부분(stop.kinds — 기본 publish·video 단계)이 있으면 FAILED("게시되지 않음이 확인된 실패" — 계획이 실패로 보이고 새 계획이
 * 게시된 부분을 처음부터 다시 게시한다)가 아니라 settlePartialStop 으로 UNKNOWN(thread_partial_failed). 남은 부분은 보내지 않는다.
 * 사건에는 not_sent:false·published_parts·publish_attempts(표식 수 — 기록만)·error_code 를 남긴다.
 * 게시 시도 표식(publish_attempt)만 있는 작업은 세지 않는다: 실제 Threads 의 표식 뒤 확정 거부(400·403 등 — 원격이 게시를 받지 않음)는 지금처럼 FAILED
 * (게시되지 않음이 확인됨). 결과를 모르는 표식 뒤 응답은 원래부터 FAILED 가 아니라 조회(RECONCILING → UNKNOWN)다.
 * 게시된 부분이 없으면 failed() — 호출자가 지금까지 하던 결정 그대로(FAILED 모양 불변).
 */
async function failUnlessPartial(
  tx: DbOrTx,
  ownerId: string,
  job: Pick<JobRow, 'id' | 'state'>,
  item: DistributionItemRow,
  stop: { reason: string; details: Record<string, unknown>; set?: TransitionSet; kinds?: readonly RemoteStepKind[] },
  now: Date,
  failed: () => Promise<JobState>,
): Promise<JobState> {
  const parts = await publishedStepCount(tx, ownerId, job.id, stop.kinds ?? PUBLISHED_PART_KINDS);
  if (parts === 0) return failed();
  const attempts = await publishedStepCount(tx, ownerId, job.id, ['publish_attempt']);
  return settlePartialStop(tx, ownerId, job, item, stop.reason, stop.details, { parts, attempts }, THREAD_PARTIAL_FAILED_CODE, now, stop.set);
}

/**
 * FIX2-FULLREV(FX2): 조회 한도로 UNKNOWN(reconcile_unsupported — RECONCILING·REMOTE_PROCESSING·CANCEL_REQUESTED 모두 표에 있는 전이, 새 전이 없음).
 * 이 작업에 게시된 스레드 게시물(publish 단계)이 있으면 사유 코드 thread_partial_unresolved 와 not_sent:false·published_parts·publish_attempts 를 남긴다.
 * publish 만 센다: 게시 시도 표식(publish_attempt)만 있는 실제 Threads 단일 게시물은 지금처럼 앞선 코드·일반 결과 불명 안내(LIVE_UNKNOWN_GUIDANCE),
 * YouTube 의 video 단계는 그 영상 하나의 처리 결과를 모르는 것이라 "부분 게시"가 아니다(T15 그대로). 게시된 게시물이 없으면 지금까지와 같은 모양.
 */
async function settleReconcileLimit(
  tx: DbOrTx,
  ownerId: string,
  job: Pick<JobRow, 'id' | 'state'>,
  item: DistributionItemRow,
  details: Record<string, unknown>,
  now: Date,
  set: TransitionSet,
): Promise<JobState> {
  const parts = await publishedStepCount(tx, ownerId, job.id, ['publish']);
  if (parts === 0) return settle(tx, ownerId, job, item, 'reconcile_unsupported', details, now, set);
  const attempts = await publishedStepCount(tx, ownerId, job.id, ['publish_attempt']);
  return settle(
    tx,
    ownerId,
    job,
    item,
    'reconcile_unsupported',
    { ...details, reason: THREAD_PARTIAL_UNRESOLVED_CODE, not_sent: false, published_parts: parts, publish_attempts: attempts },
    now,
    { ...set, lastErrorCode: THREAD_PARTIAL_UNRESOLVED_CODE },
  );
}

/** LIVEP1-DIAG: 진단을 이력 필드로(허용 목록 통과분만, 없으면 빈 객체). */
function providerDiagDetail(d: unknown): { provider_diag?: ThreadsDiag } {
  const s = sanitizeThreadsDiag(d);
  return s ? { provider_diag: s } : {};
}

/**
 * 원격 결과 기록(추가 전용). 모의 어댑터 결과는 is_mock=true·verification=MOCK — 실제 발행 실적이 아니다(DB CHECK 로도 강제).
 * LIVE-P1(D38): 실제 결과는 원격 읽기로 확인했을 때만(r.verified) VERIFIED + verified_at, 아니면 UNVERIFIED. 형식(threads:<숫자>·공식 링크)은
 * 여기서 한 번 더 보고(DB CHECK 0044 와 같은 규칙) 맞지 않는 링크는 저장하지 않는다(꾸며낸 URL 금지).
 */
async function insertPublication(
  tx: DbOrTx,
  ownerId: string,
  item: DistributionItemRow,
  jobId: string,
  isMock: boolean,
  r: Pick<AdapterResult, 'external_id' | 'permalink' | 'result_kind' | 'remote_visibility' | 'verified'>,
  now: Date,
): Promise<string | null> {
  if (!r.external_id) return null;
  if (isMock && !r.external_id.startsWith('mock:')) throw new AppError('conflict', 'mock_id_invalid', '모의 결과의 외부 ID 는 mock: 로 시작해야 합니다');
  if (!isMock && !LIVE_THREADS_EXTERNAL_ID_RE.test(r.external_id)) throw new AppError('conflict', 'live_id_invalid', '실제 결과의 외부 ID 형식이 올바르지 않습니다');
  const permalink = isMock ? (r.permalink ?? null) : isAllowedThreadsPermalink(r.permalink) ? r.permalink : null;
  const verified = !isMock && r.verified === true && permalink !== null;
  const visibility = r.remote_visibility ?? 'unknown';
  const kind = r.result_kind ?? (visibility === 'private' ? 'UPLOADED_PRIVATE' : 'PUBLISHED');
  const rows = await tx
    .insert(publications)
    .values({
      ownerId,
      itemId: item.id,
      jobId,
      externalId: r.external_id,
      permalink,
      resultKind: kind,
      remoteVisibility: visibility,
      verification: isMock ? 'MOCK' : verified ? 'VERIFIED' : 'UNVERIFIED',
      isMock,
      verifiedAt: verified ? now : null,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: publications.id });
  return rows[0]?.id ?? null;
}

async function fillIntent(
  tx: DbOrTx,
  ownerId: string,
  intent: SendIntentRow | null,
  outcome: 'accepted' | 'rejected' | 'ambiguous',
  r: { provider_request_id?: string; external_id?: string; error_code?: string; status?: string; retry_class?: string; provider_diag?: unknown },
  now: Date,
  source: string,
): Promise<void> {
  if (!intent || intent.outcome !== 'pending') return;
  await tx
    .update(sendIntents)
    .set({
      submittedAt: now,
      outcome,
      providerRequestId: r.provider_request_id ?? null,
      remoteExternalId: r.external_id ?? null,
      // T14(D26): 보낸 어댑터 식별자는 결과를 채운 뒤에도 남긴다(조회는 보낸 어댑터로).
      sanitizedDetails: {
        source,
        status: r.status ?? null,
        error_code: r.error_code ?? null,
        retry_class: r.retry_class ?? null,
        ...providerDiagDetail(r.provider_diag),
        ...(typeof intent.sanitizedDetails?.adapter_id === 'string' ? { adapter_id: intent.sanitizedDetails.adapter_id } : {}),
        // LIVE-P1: 실제 게시 승인 기록·모드도 남긴다(게시 수 상한을 세는 근거 — 결과를 채운 뒤에도 사라지지 않게).
        ...(typeof intent.sanitizedDetails?.live_approval_ref === 'string' ? { live_approval_ref: intent.sanitizedDetails.live_approval_ref } : {}),
        ...(typeof intent.sanitizedDetails?.mode === 'string' ? { mode: intent.sanitizedDetails.mode } : {}),
      },
    })
    .where(and(eq(sendIntents.id, intent.id), eq(sendIntents.ownerId, ownerId), eq(sendIntents.outcome, 'pending')));
}

// ---- lease ----

/**
 * lease 만료 복구(작업마다 짧은 트랜잭션, 전역 잠금 순서). 전송 도중 죽은 worker 의 작업:
 * - LEASED(의도 없음) → QUEUED(lease_expired_before_intent) — 아직 보내지 않았다.
 * - SENDING(의도 있음) → RECONCILING(lease_expired_after_intent) — 보냈을 수도 있으므로 다시 보내지 않고 조회(A20).
 * - CANCEL_REQUESTED: 이번 시도의 의도가 없으면 CANCELED(보내지 않음), 있으면 lease 만 풀고 조회.
 * - REMOTE_PROCESSING·RECONCILING(조회 lease): lease 만 푼다.
 */
export async function recoverExpiredLeases(db: Db, opts: { now: Date; ownerId?: string }): Promise<number> {
  const { now } = opts;
  const expired = await db
    .select({ id: jobs.id, ownerId: jobs.ownerId, itemId: jobs.itemId })
    .from(jobs)
    .where(
      and(
        opts.ownerId ? eq(jobs.ownerId, opts.ownerId) : undefined,
        inArray(jobs.state, [...LEASE_HELD_STATES]),
        isNotNull(jobs.leaseUntil),
        lt(jobs.leaseUntil, now),
      ),
    )
    .orderBy(asc(jobs.id));
  let recovered = 0;
  for (const e of expired) {
    if (!e.itemId) continue;
    const did = await db.transaction(async (tx) => {
      const item = await lockItem(tx, e.ownerId, e.itemId!);
      const job = await jobForUpdate(tx, e.ownerId, e.id);
      if (!job || !job.leaseUntil || job.leaseUntil.getTime() >= now.getTime() || !(LEASE_HELD_STATES as readonly string[]).includes(job.state)) return false;
      const intent = job.attempt > 0 ? await intentFor(tx, e.ownerId, job.id, job.attempt) : null;
      const base = { worker: job.leaseOwner, attempt: job.attempt };
      switch (job.state) {
        case 'LEASED': {
          // FIX-T11 round 2(P1): 시도(attempt)는 전송 의도를 쓸 때만 센다(beginSend) — 의도 없이 만료된 lease 는 시도가 아니므로 attempt 는 그대로다
          // (마지막 남은 시도도 잃지 않는다). 보내기 전에 되풀이해 죽는 작업은 별도 횟수(lease_expired_before_intent)가 한도에 이르면 FAILED.
          const expiries = job.leaseExpiredBeforeIntent + 1;
          if (expiries >= PRE_INTENT_EXPIRY_LIMIT) {
            // FIX1-FULLREV(F2 후속2): 이번 lease 에서는 보내지 않았어도 앞선 시도가 스레드 일부를 게시했거나 게시 시도 표식이 있으면 FAILED("보내지 않음")가
            // 아니라 UNKNOWN(thread_partial_stopped) — 남은 부분은 보내지 않고, 새 계획이 처음부터 다시 게시하지 않게(stopUnlessPartial).
            const stop = { reason: 'lease_expired_before_intent', code: THREAD_PARTIAL_STOPPED_CODE, details: { ...base, expiries }, set: { leaseExpiredBeforeIntent: expiries } };
            await stopUnlessPartial(tx, e.ownerId, job, item, stop, now, () =>
              settle(tx, e.ownerId, job, item, 'permanent_failure', { ...base, reason: 'lease_expired_before_intent', expiries, not_sent: true }, now, {
                ...CLEAR_LEASE,
                lastErrorCode: 'lease_expired_before_intent',
                leaseExpiredBeforeIntent: expiries,
              }),
            );
            return true;
          }
          await settle(tx, e.ownerId, job, item, 'lease_expired_before_intent', { ...base, expiries }, now, {
            ...CLEAR_LEASE,
            nextRunAt: now,
            leaseExpiredBeforeIntent: expiries,
          });
          return true;
        }
        case 'SENDING':
          await settle(tx, e.ownerId, job, item, 'lease_expired_after_intent', { ...base, intent: intent ? 'present' : 'missing' }, now, {
            ...CLEAR_LEASE,
            nextRunAt: now,
            reconcileCount: 0,
          });
          return true;
        case 'CANCEL_REQUESTED':
          // 취소 요청이 전송 시작 전(LEASED·QUEUED)에 들어왔으면 이번 lease 에서는 보내지 않았다(attempt 는 의도를 쓸 때만 오르므로 의도 유무로 판단하지 않는다).
          if (await cancelRequestedBeforeSend(tx, job.id)) {
            // FIX1-FULLREV(F2 후속): 이번 lease 에서는 보내지 않았어도 앞선 시도가 스레드 일부를 게시했으면 "보내지 않음"(CANCELED)이라고 하지 않는다 — UNKNOWN.
            const stop = { reason: THREAD_PARTIAL_CANCEL_REQUESTED_CODE, code: THREAD_PARTIAL_CANCEL_REQUESTED_CODE, details: { ...base, cause: 'lease_expired' } };
            await stopUnlessPartial(tx, e.ownerId, job, item, stop, now, () =>
              settle(tx, e.ownerId, job, item, 'canceled', { ...base, not_sent: true, cause: 'lease_expired' }, now),
            );
          } else {
            await settle(tx, e.ownerId, job, item, 'lease_expired_after_intent', base, now, { ...CLEAR_LEASE, nextRunAt: now });
          }
          return true;
        default:
          await tx
            .update(jobs)
            .set({ ...CLEAR_LEASE, updatedAt: now })
            .where(and(eq(jobs.id, job.id), eq(jobs.ownerId, e.ownerId)));
          return true;
      }
    });
    if (did) recovered++;
  }
  return recovered;
}

/**
 * 짧은 트랜잭션 하나: 실행할 때가 된 작업을 FOR UPDATE SKIP LOCKED 로 골라 lease 한다(다른 worker 가 잡은 행은 건너뛴다, A07).
 * - QUEUED·RETRY_WAIT → LEASED(attempt 는 그대로 — FIX-T11 round 2: 전송 의도를 쓸 때 beginSend 가 올린다)
 * - RECONCILING·REMOTE_PROCESSING·CANCEL_REQUESTED(lease 없음·만료) → 상태 그대로 lease 만(원격 조회). UNKNOWN 은 고르지 않는다.
 */
export async function leaseJobs(
  db: Db,
  opts: { workerId: string; now: Date; limit: number; leaseTtlMs?: number; ownerId?: string; planId?: string; excludeIds?: readonly string[] },
): Promise<JobRow[]> {
  const { workerId, now } = opts;
  const limit = Math.min(Math.max(Math.floor(opts.limit), 1), 20);
  const until = addMs(now, opts.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS);
  return db.transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(jobs)
      .where(
        and(
          opts.ownerId ? eq(jobs.ownerId, opts.ownerId) : undefined,
          opts.planId
            ? sql`${jobs.itemId} in (select di.id from distribution_items di where di.plan_id = ${opts.planId}::uuid and di.owner_id = ${jobs.ownerId})`
            : undefined,
          opts.excludeIds?.length ? sql`${jobs.id} <> all(${sql.param([...opts.excludeIds])}::uuid[])` : undefined,
          lte(jobs.nextRunAt, now),
          or(
            and(inArray(jobs.state, [...SEND_LEASE_STATES]), isNull(jobs.leaseOwner)),
            and(inArray(jobs.state, [...CHECK_LEASE_STATES]), or(isNull(jobs.leaseUntil), lte(jobs.leaseUntil, now))),
          ),
        ),
      )
      .orderBy(asc(jobs.nextRunAt), asc(jobs.id))
      .limit(limit)
      .for('update', { skipLocked: true });
    const out: JobRow[] = [];
    for (const c of candidates) {
      if ((SEND_LEASE_STATES as readonly string[]).includes(c.state)) {
        await transitionJob(tx, c.ownerId, c, 'lease', { worker: workerId, next_attempt: c.attempt + 1 }, now, {
          leaseOwner: workerId,
          leaseUntil: until,
          heartbeatAt: now,
          reconcileCount: 0,
        });
      } else {
        await tx
          .update(jobs)
          .set({ leaseOwner: workerId, leaseUntil: until, heartbeatAt: now, updatedAt: now })
          .where(and(eq(jobs.id, c.id), eq(jobs.ownerId, c.ownerId), eq(jobs.state, c.state)));
      }
      const fresh = await tx.select().from(jobs).where(eq(jobs.id, c.id)).limit(1);
      out.push(fresh[0]!);
    }
    return out;
  });
}

/** lease 연장(작은 트랜잭션 — 한 문장). 이 worker 가 아직 lease 를 가진 경우에만. */
export async function heartbeatJob(db: Db, jobId: string, workerId: string, now: Date, leaseTtlMs: number = DEFAULT_LEASE_TTL_MS): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ heartbeatAt: now, leaseUntil: addMs(now, leaseTtlMs) })
    .where(and(eq(jobs.id, jobId), eq(jobs.leaseOwner, workerId)))
    .returning({ id: jobs.id });
  return rows.length === 1;
}

// ---- 처리 ----

export interface ProcessResult {
  jobId: string;
  state: JobState | 'lease_lost' | 'error';
}

function makeContext(
  db: Db,
  job: JobRow,
  intentKey: string,
  opts: Pick<JobRunOptions, 'workerId' | 'clock' | 'leaseTtlMs' | 'credentials' | 'media' | 'uploadSlice'>,
  signal: AbortSignal,
  mockScenario: MockScenarioSetting | null = null,
  onLeaseLost?: () => void,
  extra?: { snapshot: PublishSnapshot; rateUnitsReserved?: number; deadline?: number; livePauseGate?: boolean },
): AdapterContext {
  const clock = opts.clock ?? (() => new Date());
  const snapshot = extra?.snapshot;
  const keyring: KeyringSource = opts.credentials?.keyring ?? (() => requireSecretKeyring(process.env));
  return {
    intentKey,
    attempt: job.attempt,
    jobId: job.id,
    itemId: job.itemId!,
    now: clock(),
    signal,
    heartbeat: async () => {
      // FIX-T11(P0): lease 를 잃었으면(만료 복구·다른 worker) 호출자에게 알리고 중단한다 — 어댑터가 부작용을 만들지 않게.
      if (!(await heartbeatJob(db, job.id, opts.workerId, clock(), opts.leaseTtlMs))) {
        onLeaseLost?.();
        throw new LeaseLostError();
      }
    },
    mockScenario,
    // T14: 원격 단계 기록(작업 단위, 호출마다 짧은 트랜잭션)과 서버 쪽 토큰 창구(T13). 토큰은 어댑터 메모리에만.
    // FIX-LIVEP2(D): 실제 어댑터 전송 실행이면 새 게시 시도 표식을 쓰기 직전 같은 트랜잭션에서 즉시 중지를 다시 본다(recordRemoteStep).
    steps: remoteStepsPort(db, { ownerId: job.ownerId, jobId: job.id, itemId: job.itemId!, intentKey, clock, livePauseGate: extra?.livePauseGate === true }),
    credential: snapshot
      ? {
          accessToken: async () => {
            const read = () => readAccessTokenForSend(db, { ownerId: job.ownerId, accountId: snapshot.account.id, keyring, now: clock() });
            const r = await read();
            // T15(D27): 짧은 access token(Google 형)이 만료됐으면 T13 갱신 경로를 한 번 부르고 다시 읽는다(실패해도 코드만 — 토큰·오류 내용 없음).
            if (r.ok || r.code !== 'credential_access_token_stale' || !opts.credentials?.refresh) return r;
            try {
              await opts.credentials.refresh(job.ownerId, snapshot.account.id, clock());
            } catch {
              return { ok: false as const, code: 'credential_refresh_failed' };
            }
            return read();
          },
        }
      : undefined,
    snapshot,
    media: mediaPortFor(db, job.ownerId, opts.media),
    cancelRequested: async () => {
      const rows = await db.select({ state: jobs.state }).from(jobs).where(and(eq(jobs.id, job.id), eq(jobs.ownerId, job.ownerId))).limit(1);
      return rows[0]?.state === 'CANCEL_REQUESTED';
    },
    ...(opts.uploadSlice ? { uploadSlice: { ...opts.uploadSlice } } : {}),
    ...(extra?.rateUnitsReserved !== undefined ? { rateUnitsReserved: extra.rateUnitsReserved } : {}),
    ...(extra?.deadline !== undefined ? { deadline: extra.deadline } : {}),
  };
}

/** LIVEP1-TIMEOUT: 어댑터 종류별 전송·조회 예산 — 실제 어댑터는 max(호출자 예산, 실제 예산), 모의는 호출자 예산 그대로. */
function budgetFor(adapter: Pick<ChannelAdapter, 'kind'>, opts: { submitTimeoutMs?: number; liveSubmitTimeoutMs?: number }, base: number = opts.submitTimeoutMs ?? 30_000): number {
  return adapter.kind === 'live' ? Math.max(base, opts.liveSubmitTimeoutMs ?? LIVE_SUBMIT_BUDGET_MS) : base;
}

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: 'timeout' | 'error' }> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      ac.abort();
      resolve('timeout');
    }, ms);
  });
  try {
    const r = await Promise.race([fn(ac.signal).then((value) => ({ value })), timeout]);
    if (r === 'timeout') return { ok: false, reason: 'timeout' };
    return { ok: true, value: r.value };
  } catch {
    return { ok: false, reason: ac.signal.aborted ? 'timeout' : 'error' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface SendPlan {
  adapter: ChannelAdapter;
  snapshot: PublishSnapshot;
  intentKey: string;
  job: JobRow;
  /** T12: 모의 계정 항목의 시나리오(개발·시험 전용, 승인 스냅샷 밖) */
  mockScenario: MockScenarioSetting | null;
  /** FIX-T15: 이 시도에 확인·예약한 요청 제한 단위(rate_limit 이 있을 때만) */
  rateUnitsReserved?: number;
}

/**
 * FIX-T15(Codex review-T15 P1): 이 작업이 이번 시도에 새로 쓸 요청 제한 단위. 어댑터가 단계 기록으로 정하면(rateUnitsRemaining — YouTube:
 * 유효할 수 있는 세션 재개 = 0, 세션 없음·만료·오류 = 1) 그 값, 아니면 rateUnits − 이미 기록된 단계 수(Threads 게시물). 만료 세션은 창 안 사용량
 * 에는 그대로 남고 새 세션 비용을 상계하지 않는다.
 * FIX-T14 round 2: 단계는 호출자가 한 스냅샷(accountRateSnapshot)에서 읽어 넘긴다(순수 계산 — 따로 조회하지 않는다).
 */
function rateUnitsFromSteps(adapter: ChannelAdapter, snapshot: PublishSnapshot, steps: readonly RemoteStep[], kinds: readonly RemoteStepKind[]): number {
  if (!adapter.rateUnits) return 0;
  if (adapter.rateUnitsRemaining) return Math.max(0, adapter.rateUnitsRemaining(snapshot, steps));
  return Math.max(0, adapter.rateUnits(snapshot) - steps.filter((st) => kinds.includes(st.kind)).length);
}

const INFLIGHT_RECHECK_MS = 60_000;
/** 전송 의도를 만든 뒤 아직 끝나지 않은(원격에 더 보낼 수 있는) 상태 — 로컬 요청 제한 예약으로 센다. */
const INFLIGHT_RATE_STATES = ['SENDING', 'REMOTE_PROCESSING', 'RECONCILING', 'CANCEL_REQUESTED'] as const;

/**
 * FIX-T14(Codex review-T14 Q6): 같은 계정에서 진행 중인 다른 작업이 아직 쓰지 않은 요청 제한 단위(= 그 스냅샷의 단위 − 이미 기록된 단계).
 * 같은 어댑터가 보낸 작업만(다른 어댑터는 다른 원격 한도) 센다. 본문·토큰은 읽지 않는다(스냅샷 payload 의 게시물 수만).
 * FIX-T14 round 2: 사용량과 같은 스냅샷(accountRateSnapshot)의 행으로만 계산한다.
 */
function inflightRateUnitsOf(rows: readonly RateInflightJob[], acc: typeof channelAccounts.$inferSelect, adapter: ChannelAdapter, kinds: readonly RemoteStepKind[]): number {
  if (!adapter.rateUnits) return 0;
  let total = 0;
  for (const j of rows) {
    if (!j.intentDetails || recordedAdapterIdOf(j.intentDetails).id !== adapter.id) continue;
    const channel = typeof j.item.payloadJson.channel === 'string' ? j.item.payloadJson.channel : acc.platform;
    const snap: PublishSnapshot = {
      item_id: j.item.id,
      channel,
      account: adapterAccount(acc),
      payload: j.item.payloadJson,
      payload_hash: j.item.payloadHash,
      visibility: j.item.visibility,
      requested_result: j.item.requestedResult,
      scheduled_at_utc: j.item.scheduledAtUtc ? j.item.scheduledAtUtc.toISOString() : null,
    };
    total += rateUnitsFromSteps(adapter, snap, j.steps, kinds);
  }
  return total;
}

/**
 * T21-P2 · FIX1-T21P2(Codex P1 :623): 이 작업에 **오래 지난 예약에 대한 사용자 확인**(schedule_stale 차단 뒤 retryItem 이 남긴 확인 이력)이 있고
 * 그 확인이 지금의 활성 승인·내용 hash·예약 시각과 같은가(staleScheduleConfirmedBy). 일반 재시도 이력은 인정하지 않는다.
 * 복원 표시 작업(restored_needs_review — 복원된 이력)은 인정하지 않는다. 오래 지난 예약 판정에서만 부른다(드묾).
 */
async function staleScheduleConfirmed(
  tx: DbOrTx,
  ownerId: string,
  job: Pick<JobRow, 'id' | 'restoredNeedsReview'>,
  target: { approvalId: string; payloadHash: string; scheduledAtUtc: Date },
): Promise<boolean> {
  if (job.restoredNeedsReview) return false;
  const rows = await tx
    .select({ eventSeq: jobEvents.eventSeq, details: jobEvents.sanitizedDetails })
    .from(jobEvents)
    .where(and(eq(jobEvents.ownerId, ownerId), eq(jobEvents.jobId, job.id)))
    .orderBy(asc(jobEvents.eventSeq));
  return staleScheduleConfirmedBy(rows, { approvalId: target.approvalId, payloadHash: target.payloadHash, scheduledAtUtc: target.scheduledAtUtc.toISOString() });
}

/** 1단계(한 트랜잭션): 재검사 + SENDING + 전송 의도. 보낼 수 없으면 상태를 정하고 null. */
async function beginSend(db: Db, registry: ChannelAdapterRegistry, leased: JobRow, opts: JobRunOptions, now: Date): Promise<SendPlan | JobState | 'lease_lost'> {
  const ownerId = leased.ownerId;
  return db.transaction(async (tx) => {
    await shareLockItemAccount(tx, ownerId, leased.itemId!);
    const item = await lockItem(tx, ownerId, leased.itemId!);
    const active = await activeApprovalsFor(tx, ownerId, [item.id]);
    const job = await jobForUpdate(tx, ownerId, leased.id);
    if (!job || job.leaseOwner !== opts.workerId || job.attempt !== leased.attempt) return 'lease_lost' as const;
    // FIX-T11(P1): lease 가 이미 만료됐으면(시작 전에 오래 기다림) 아무것도 쓰지 않는다 — 만료 복구가 attempt 를 되돌리고 다시 대기시킨다.
    if (!job.leaseUntil || job.leaseUntil.getTime() <= now.getTime()) return 'lease_lost' as const;
    // 취소 요청(lease 뒤, 보내기 전) → 보내지 않고 CANCELED.
    if (job.state === 'CANCEL_REQUESTED' || job.cancelRequestedAt) {
      if (job.state !== 'LEASED' && job.state !== 'CANCEL_REQUESTED') return 'lease_lost' as const;
      // FIX1-FULLREV(F2 후속): 앞선 시도가 스레드 일부를 게시했으면(예: lease 와 이 재검사 사이의 사용자 철회·취소) 취소 성공이라고 하지 않는다 — UNKNOWN.
      const stop = { reason: THREAD_PARTIAL_CANCEL_REQUESTED_CODE, code: THREAD_PARTIAL_CANCEL_REQUESTED_CODE, details: { attempt: job.attempt } };
      return stopUnlessPartial(tx, ownerId, job, item, stop, now, () => settle(tx, ownerId, job, item, 'canceled', { not_sent: true, attempt: job.attempt }, now));
    }
    if (job.state !== 'LEASED') return 'lease_lost' as const;
    const approval = active.get(item.id);
    if (!approval || approval.payloadHash !== item.payloadHash) {
      // A10: 승인이 없거나 바뀌었으면 다음 외부 전송을 막는다. 아직 보내지 않았으므로 항목은 PLANNED(다시 승인 가능, T10 과 같은 규칙).
      // FIX1-FULLREV(F2 후속): 단, 앞선 시도가 스레드 일부를 게시한 작업(재개 대기 뒤 lease — 철회 훅이 lease 된 작업을 보기 전 경합 등)은
      // PLANNED 로 두지 않는다(다시 승인·실행하면 새 작업이 처음부터 다시 게시). 남은 부분은 보내지 않고 UNKNOWN(thread_partial_revoked).
      const stop = { reason: 'approval_missing', code: THREAD_PARTIAL_REVOKED_CODE, details: { attempt: job.attempt } };
      return stopUnlessPartial(tx, ownerId, job, item, stop, now, () =>
        settle(tx, ownerId, job, item, 'blocked', { reason: 'approval_missing', attempt: job.attempt }, now, { ...CLEAR_LEASE, lastErrorCode: 'approval_missing' }, 'PLANNED'),
      );
    }
    // 예약 시각 경과는 예약 작업이 실행될 때 당연하므로 제외한다.
    const problems = (await snapshotProblems(tx, ownerId, item, now)).filter((p) => p !== 'schedule_passed');
    if (problems.length) {
      const reason = invalidationReasonOf(problems);
      await revokeActiveApprovalsLocked(tx, ownerId, [item], () => `invalidated:${reason}`, now, { action: 'approval.invalidate' });
      await settleApprovedVariants(tx, ownerId, [item.variantId], reason === 'account_changed' ? 'review' : 'draft', now);
      // FIX1-FULLREV(F2 후속): 앞선 시도가 스레드 일부를 게시한 작업(조회 중 편집 → 이어 보내기 뒤 lease 등 — 진행 중 항목은 편집 훅이 승인을 두므로
      // 여기서 처음 무효가 된다)은 PLANNED 로 두지 않는다. 승인은 위에서 무효로 하고, 남은 부분은 보내지 않고 UNKNOWN(thread_partial_revoked).
      const stop = { reason: 'snapshot_stale', code: THREAD_PARTIAL_REVOKED_CODE, details: { problems: problems.slice(0, 8), attempt: job.attempt } };
      return stopUnlessPartial(tx, ownerId, job, item, stop, now, () =>
        settle(
          tx,
          ownerId,
          job,
          item,
          'blocked',
          { reason: 'snapshot_stale', problems: problems.slice(0, 8), attempt: job.attempt },
          now,
          { ...CLEAR_LEASE, lastErrorCode: 'snapshot_stale' },
          'PLANNED',
        ),
      );
    }
    // T21-P2(docs/07): 서버·작업 처리기가 오래 멈췄다 돌아온 뒤 오래 지난 예약을 자동으로 보내지 않는다 — 첫 전송(attempt 0)만, 보내지 않은 채 BLOCKED.
    // 승인은 그대로 둔다(내용은 바뀌지 않았다). FIX1-T21P2: schedule_stale 차단 뒤 사용자가 "재시도"로 남긴 확인이 지금의 승인·내용·예약과 같을 때만 통과한다.
    if (
      job.attempt === 0 &&
      isScheduleStale(item.scheduledAtUtc, now) &&
      !(await staleScheduleConfirmed(tx, ownerId, job, { approvalId: approval.id, payloadHash: item.payloadHash, scheduledAtUtc: item.scheduledAtUtc! }))
    ) {
      return settle(
        tx,
        ownerId,
        job,
        item,
        'blocked',
        { reason: 'schedule_stale', not_sent: true, late_minutes: Math.floor((now.getTime() - item.scheduledAtUtc!.getTime()) / 60_000) },
        now,
        { ...CLEAR_LEASE, lastErrorCode: 'schedule_stale' },
      );
    }
    const acc = await accountOf(tx, ownerId, item.channelAccountId);
    if (!acc) return settle(tx, ownerId, job, item, 'blocked', { reason: 'account_missing' }, now, { ...CLEAR_LEASE, lastErrorCode: 'account_missing' });
    // T13(D24): 연결 정보가 만료·해제·다시 연결 필요면 보내지 않고 BLOCKED(보내지 않았음이 확실 — 다시 연결 뒤 재시도 가능). 사유 코드 credential_<상태>.
    const cred = (await credentialGate(tx, ownerId, [acc.id], now)).get(acc.id);
    if (cred && !cred.usable) {
      const code = `credential_${cred.status}`;
      return settle(tx, ownerId, job, item, 'blocked', { reason: 'credential_blocked', credential_status: cred.status, not_sent: true }, now, {
        ...CLEAR_LEASE,
        lastErrorCode: code,
      });
    }
    let mode: 'MOCK' | 'LIVE';
    let adapter: ChannelAdapter;
    try {
      // LIVE-P1(D38): 실제 계정은 PUBLISH_MODE·서버 승인(hash)·플랫폼 threads·승인 기록·게시 수 상한 설정이 모두 있어야 LIVE(아니면 보내지 않고 BLOCKED).
      mode = assertExecutionAllowed(opts.config as AppConfig, {
        accountKind: acc.kind === 'mock' ? 'mock' : 'live',
        payloadHash: item.payloadHash,
        approval: { id: approval.id, payloadHash: approval.payloadHash, revokedAt: approval.revokedAt },
        platform: acc.platform,
      }).mode;
      adapter = registry.getAdapterFor(adapterAccount(acc));
      // 실제 계정에 모의 어댑터(또는 그 반대)가 붙으면 보내지 않는다(레지스트리 잘못 구성 방어).
      if ((mode === 'LIVE') !== (adapter.kind === 'live')) throw new AppError('conflict', 'adapter_kind_mismatch', '계정과 어댑터 종류가 다릅니다');
    } catch (e) {
      const code = e instanceof Error && 'code' in e ? String((e as { code: unknown }).code).toLowerCase() : 'execution_not_allowed';
      return settle(tx, ownerId, job, item, 'blocked', { reason: 'execution_not_allowed', code }, now, { ...CLEAR_LEASE, lastErrorCode: code });
    }
    // FIX-T14(Codex review-T14 P0·Q5): 새 전송 의도에는 반드시 어댑터 ID 를 남긴다(없으면 보내지 않음 — 조회가 다른 어댑터로 대신하지 않게).
    // 이 작업에 원격 단계 기록이 있는데 그 기록을 남긴 어댑터(이전 의도의 adapter_id)와 지금 고른 어댑터가 다르면 이어 보내지 않는다(BLOCKED).
    if (!adapter.id) {
      return settle(tx, ownerId, job, item, 'blocked', { reason: 'adapter_id_missing', not_sent: true }, now, { ...CLEAR_LEASE, lastErrorCode: 'adapter_id_missing' });
    }
    if (job.attempt > 0) {
      const prev = await intentFor(tx, ownerId, job.id, job.attempt);
      const prevAdapter = prev ? recordedAdapterIdOf(prev.sanitizedDetails).id : null;
      if (prev && prevAdapter !== adapter.id && (await listRemoteSteps(tx, ownerId, job.id)).length > 0) {
        return settle(tx, ownerId, job, item, 'blocked', { reason: 'adapter_changed', previous_adapter: prevAdapter, adapter_id: adapter.id, not_sent: true }, now, {
          ...CLEAR_LEASE,
          lastErrorCode: 'adapter_changed',
        });
      }
    }
    const vRows = await tx
      .select({ channel: variants.channel })
      .from(variants)
      .where(and(eq(variants.id, item.variantId), eq(variants.ownerId, ownerId)))
      .limit(1);
    const snapshot = snapshotOf(item, acc, vRows[0]?.channel ?? acc.platform);
    const valid = adapter.validate(snapshot);
    if (!valid.ok) {
      // FIX1-FULLREV(F2 후속2): 앞선 시도가 같은 스냅샷으로 이미 일부를 게시했는데 이제 검증이 실패(어댑터 규칙 변경 등)하면 FAILED 가 아니라
      // UNKNOWN(thread_partial_stopped) — 실제 게시 FAILED 문구는 "게시되지 않음이 확인된 실패"라서 게시 시도 표식이 있는 작업에 맞지 않는다.
      const stop = { reason: 'validate_failed', code: THREAD_PARTIAL_STOPPED_CODE, details: { error_code: valid.error_code, attempt: job.attempt } };
      return stopUnlessPartial(tx, ownerId, job, item, stop, now, () =>
        settle(tx, ownerId, job, item, 'permanent_failure', { reason: 'validate_failed', error_code: valid.error_code }, now, {
          ...CLEAR_LEASE,
          lastErrorCode: valid.error_code,
          lastRetryClass: 'permanent',
        }),
      );
    }
    // FIX-T11 round 2(P1): 시도는 여기서(전송 의도와 같은 트랜잭션) 센다. 한도를 다 쓴 작업은 보내지 않고 FAILED.
    // FIX1-FULLREV(F2 후속2): 단, 앞선 시도가 스레드 일부를 게시했거나 게시 시도 표식이 있으면(예: 마지막 시도로 이어 보내기) FAILED("보내지 않음")가 아니라
    // UNKNOWN(thread_partial_stopped) — 남은 부분은 보내지 않고, "새 배포 계획"이 처음부터 다시 게시하지 않게(stopUnlessPartial).
    if (countedAttempts(job) >= job.maxAttempts) {
      const stop = { reason: 'attempts_exhausted', code: THREAD_PARTIAL_STOPPED_CODE, details: { attempt: job.attempt } };
      return stopUnlessPartial(tx, ownerId, job, item, stop, now, () =>
        settle(tx, ownerId, job, item, 'permanent_failure', { reason: 'attempts_exhausted', not_sent: true, attempt: job.attempt }, now, {
          ...CLEAR_LEASE,
          lastErrorCode: 'attempts_exhausted',
        }),
      );
    }
    const mockScenario = acc.kind === 'mock' ? await mockScenarioFor(tx, ownerId, item.id) : null;
    // T14(D26): 계정별 로컬 요청 제한(잠정값, capabilities.rate_limit). 넘으면 전송 의도를 만들지 않고 창이 풀리는 시각까지 RETRY_WAIT.
    // 사용량은 remote_steps(게시된 단계)에서 센다 — 새 표 없음. 시도(attempt)는 쓰지 않는다(보내지 않았음이 확실).
    const caps = adapter.capabilities(adapterAccount(acc), { mockScenario });
    let rateUnitsReserved: number | undefined;
    if (caps.rate_limit && adapter.rateUnits) {
      // T15(D27): 셀 단계 종류는 어댑터가 정한다(Threads = 게시, YouTube = 업로드 세션 시작). 세션 재개는 새 단위가 아니다.
      // FIX-T15(Codex review-T15 P1): 만료 세션 행 수를 "이미 쓴 단위"로 빼지 않는다 — 어댑터가 단계로 이번 시도의 새 단위를 정한다(rateUnitsFromSteps).
      const kinds = adapter.rateStepKinds ?? ['publish'];
      // FIX-T14(Codex review-T14 Q6): 같은 계정의 검사·의도 기록을 계정별 advisory 잠금(배타, 트랜잭션 끝까지)으로 줄 세운다 — 앞선 검사의 전송 의도는
      // 커밋된 뒤에야 이 잠금이 풀리므로 아래 스냅샷에 보인다.
      // FIX-T14 round 2(Codex review-FIX-T14 P1): 사용량·자기 단계·진행 중 작업의 남은 단위를 잠금 **뒤** 한 SQL 문장(한 스냅샷)으로 읽는다 — 다른 작업이
      // 그 사이에 게시 단계를 기록하고 끝나도 "예약 → 사용"으로 옮겨 갈 뿐 합계에서 빠지지 않는다. 단계 기록(recordRemoteStep)은 같은 잠금을 공유로
      // 잡으므로 이 검사 도중에는 커밋되지 않는다(두 번째 방어선).
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cs_rate:${acc.id}`}))`);
      await opts.rateCheckHook?.(tx, { phase: 'before_snapshot', jobId: job.id, accountId: acc.id });
      const rs = await accountRateSnapshot(tx, {
        ownerId,
        accountId: acc.id,
        jobId: job.id,
        since: new Date(now.getTime() - caps.rate_limit.window_sec * 1000),
        kinds,
        inflightStates: INFLIGHT_RATE_STATES,
      });
      await opts.rateCheckHook?.(tx, { phase: 'after_usage', jobId: job.id, accountId: acc.id });
      const needed = rateUnitsFromSteps(adapter, snapshot, rs.ownSteps, kinds);
      rateUnitsReserved = needed;
      if (needed > 0) {
        const usage = { used: rs.used, oldestAt: rs.oldestAt };
        const inflight = inflightRateUnitsOf(rs.inflight, acc, adapter, kinds);
        let d = localRateLimitDecision({ used: usage.used + inflight, needed, limit: caps.rate_limit, oldestAt: usage.oldestAt, now });
        if (!d.allowed && inflight > 0 && localRateLimitDecision({ used: usage.used, needed, limit: caps.rate_limit, oldestAt: usage.oldestAt, now }).allowed) {
          // 진행 중 예약 때문에만 막힘 — 창이 풀릴 때까지가 아니라 짧게 다시 본다(그 작업이 끝나면 실제 사용량으로 다시 계산).
          d = { allowed: false, resetAt: new Date(now.getTime() + INFLIGHT_RECHECK_MS) };
        }
        if (!d.allowed) {
          return settle(
            tx,
            ownerId,
            job,
            item,
            'local_rate_limited',
            {
              reason: 'local_rate_limited',
              not_sent: true,
              used: usage.used,
              inflight,
              needed,
              max_units: caps.rate_limit.max_units,
              window_sec: caps.rate_limit.window_sec,
              reset_at: d.resetAt.toISOString(),
              limit_source: caps.rate_limit.source,
            },
            now,
            { ...CLEAR_LEASE, nextRunAt: d.resetAt, lastErrorCode: 'local_rate_limited', lastRetryClass: 'transient_no_side_effect' },
          );
        }
      }
    }
    // LIVE-P1(D38): 승인 기록(PUBLISH_LIVE_APPROVAL_REF)별 실제 게시 수 상한(PUBLISH_LIVE_MAX_POSTS). 승인 기록별 advisory 잠금(배타, 트랜잭션 끝까지) 아래에서
    // 이 승인 기록으로 전송 의도를 만든 **다른** 실제 게시 작업 수를 센다 — 이 작업이 이미 그 기록으로 보낸 적 있으면(재시도·이어 게시) 새 게시가 아니다.
    // 잠금 순서: 계정(공유) → 항목 → 작업 → 요청 제한 잠금 → 이 잠금(이 잠금을 잡는 곳은 여기뿐).
    let liveApprovalRef: string | null = null;
    if (mode === 'LIVE') {
      const ref = opts.config.PUBLISH_LIVE_APPROVAL_REF;
      const max = opts.config.PUBLISH_LIVE_MAX_POSTS;
      if (!ref || max === undefined || max === null) {
        // assertExecutionAllowed 가 이미 막는다 — 두 번째 방어선
        return settle(tx, ownerId, job, item, 'blocked', { reason: 'execution_not_allowed', code: 'live_publish_not_ready', not_sent: true }, now, {
          ...CLEAR_LEASE,
          lastErrorCode: 'live_publish_not_ready',
        });
      }
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cs_live_publish:${ref}`}))`);
      const usage = await liveApprovalUsage(tx, ref, job.id);
      if (!usage.thisJobCounted && usage.otherJobs >= max) {
        return settle(tx, ownerId, job, item, 'blocked', { reason: 'live_publish_limit', not_sent: true, used: usage.otherJobs, limit: max }, now, {
          ...CLEAR_LEASE,
          lastErrorCode: 'live_publish_limit',
        });
      }
      liveApprovalRef = ref;
      // LIVE-P2(D39): 즉시 중지 스위치 + 최근 24시간 실제 게시 상한(PUBLISH_LIVE_DAILY_MAX). owner 별 advisory 잠금(배타, 트랜잭션 끝까지) 아래에서 본다.
      // 잠금 순서: 계정(공유) → 항목 → 작업 → 요청 제한 잠금(cs_rate:<계정>) → 승인 기록 잠금(cs_live_publish:<ref>) → 이 잠금(cs_live_publish_daily:<owner>).
      // 이 잠금을 잡는 곳은 여기, setLivePublishPaused(이 잠금 하나만 — 먼저 잡고 다른 잠금 없음), FIX-LIVEP2 게시 시도 표식 기록(recordRemoteStep —
      // cs_rate 공유 → 이 잠금)뿐이라 순서가 엇갈리지 않는다. 승인 기록이 달라도
      // (설정을 바꾼 두 작업 처리기) 같은 owner 의 일일 판정은 이 잠금으로 줄을 선다 — 앞선 판정의 전송 의도는 커밋된 뒤에야 잠금이 풀리므로 다음 판정에 보인다.
      // 일일 상한이 없어도(PUBLISH_LIVE_DAILY_MAX 미설정) 잠금은 잡는다 — 중지 스위치 판정이 setLivePublishPaused 와 줄을 서게.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${livePublishDailyLockName(ownerId)}))`);
      await opts.liveDailyHook?.(tx, { phase: 'after_daily_lock', jobId: job.id });
      // 중지 — 전송 의도를 쓰기 전에, 같은 트랜잭션에서(FOR SHARE). 행이 없으면 중지 아님. 보내지 않았음이 확실(not_sent) → 재개 뒤 '재시도'로 다시 보낼 수 있다.
      if ((await getLivePublishPaused(tx, ownerId, { lock: true })).paused) {
        return settle(tx, ownerId, job, item, 'blocked', { reason: 'live_publish_paused', not_sent: true }, now, {
          ...CLEAR_LEASE,
          lastErrorCode: 'live_publish_paused',
        });
      }
      const dailyMax = opts.config.PUBLISH_LIVE_DAILY_MAX;
      if (dailyMax !== undefined && dailyMax !== null) {
        // 창 안에 이미 실제 전송 의도가 있는 작업(재시도·이어 보내기)은 새 게시가 아니다 — 세지도 막지도 않는다.
        const daily = await livePublishDailyUsage(tx, ownerId, job.id, now, dailyMax);
        await opts.liveDailyHook?.(tx, { phase: 'after_daily_usage', jobId: job.id });
        if (!daily.thisJobCounted && daily.used >= dailyMax) {
          return settle(
            tx,
            ownerId,
            job,
            item,
            'blocked',
            {
              reason: 'live_publish_daily_limit',
              not_sent: true,
              used: daily.used,
              limit: dailyMax,
              available_at: daily.availableAt ? daily.availableAt.toISOString() : null,
            },
            now,
            { ...CLEAR_LEASE, lastErrorCode: 'live_publish_daily_limit' },
          );
        }
      }
    }
    const attempt = job.attempt + 1;
    const intentKey = `${job.id}:${attempt}`;
    await transitionJob(tx, ownerId, job, 'send_start', { attempt, intent_key: intentKey, mode, approval_id: approval.id, adapter_id: adapter.id ?? null }, now, { attempt });
    await syncItemStatus(tx, ownerId, item.id, 'SENDING', now);
    await tx.insert(sendIntents).values({
      ownerId,
      jobId: job.id,
      attempt,
      intentKey,
      createdAt: now,
      outcome: 'pending',
      sanitizedDetails: {
        mode,
        approval_id: approval.id,
        adapter: adapter.kind,
        adapter_id: adapter.id ?? null,
        // LIVE-P1: 이 시도가 쓴 실제 게시 승인 기록(게시 수 상한을 세는 근거). 모의 시도에는 없다.
        ...(liveApprovalRef ? { live_approval_ref: liveApprovalRef } : {}),
      },
    });
    await recomputePlanStatus(tx, ownerId, item.planId, now);
    return { adapter, snapshot, intentKey, job: { ...job, state: 'SENDING', attempt }, mockScenario, rateUnitsReserved } satisfies SendPlan;
  });
}

/** 3단계(한 트랜잭션): 의도에 결과 기록 + 전이. */
async function finishSend(db: Db, plan: SendPlan, result: AdapterResult, opts: JobRunOptions, now: Date): Promise<JobState | 'lease_lost'> {
  const ownerId = plan.job.ownerId;
  const random = opts.random ?? Math.random;
  const cls = classifyOutcome(result);
  return db.transaction(async (tx) => {
    const item = await lockItem(tx, ownerId, plan.job.itemId!);
    const job = await jobForUpdate(tx, ownerId, plan.job.id);
    const intent = await intentFor(tx, ownerId, plan.job.id, plan.job.attempt, true);
    await fillIntent(tx, ownerId, intent, cls.intentOutcome, result, now, 'submit');
    // lease 를 잃었으면(만료 복구가 RECONCILING 으로 옮김) 결과만 의도에 남기고, 전이는 조회 경로가 원격 사실로 정한다.
    if (!job || job.leaseOwner !== opts.workerId || job.attempt !== plan.job.attempt || (job.state !== 'SENDING' && job.state !== 'CANCEL_REQUESTED')) {
      // FIX-T11(P0): 늦게 온 결과가 부작용이 있을 수 있는데(accepted·processing·ambiguous·쓰기 뒤 5xx) 작업이 이미 새 시도를 기다리면
      // (QUEUED·LEASED·RETRY_WAIT — 다른 경로가 "보내지 않음"으로 판단) 새 의도로 가지 않고 조회(RECONCILING)로 돌린다.
      const sideEffectPossible = result.status !== 'rejected' || cls.retryClass === 'transient_unknown_side_effect';
      if (job && sideEffectPossible && (job.state === 'QUEUED' || job.state === 'LEASED' || job.state === 'RETRY_WAIT')) {
        await settle(
          tx,
          ownerId,
          job,
          item,
          'late_result',
          { late_attempt: plan.job.attempt, status: result.status, error_code: result.error_code ?? null, external_id: result.external_id ?? null },
          now,
          { ...CLEAR_LEASE, nextRunAt: now, reconcileCount: 0 },
        );
      }
      return 'lease_lost' as const;
    }
    const cancel = job.state === 'CANCEL_REQUESTED';
    const base = {
      attempt: job.attempt,
      status: result.status,
      retry_class: cls.retryClass,
      error_code: result.error_code ?? null,
      external_id: result.external_id ?? null,
      // LIVEP1-DIAG: 실제 Threads 오류 진단(허용 목록 — 쓰기 직전 한 번 더 걸러 숫자·짧은 열거만)
      ...providerDiagDetail(result.provider_diag),
    };
    const common = { ...CLEAR_LEASE, lastErrorCode: result.error_code ?? null, lastRetryClass: cls.retryClass };
    // FIX1-FULLREV(F2 후속2): 취소 요청 중 이번 시도가 거절로 끝남 — 어댑터는 게시물 사이에서 취소를 보지 않으므로 이 시도(또는 앞선 시도)가 스레드 일부를
    // 게시했거나 게시 시도 표식을 남겼을 수 있다. 그러면 "보내지 않음"(CANCELED)이라고 하지 않고 남은 부분은 보내지 않은 채 UNKNOWN(stopUnlessPartial).
    const canceledUnlessPartial = () =>
      stopUnlessPartial(
        tx,
        ownerId,
        job,
        item,
        { reason: THREAD_PARTIAL_CANCEL_REQUESTED_CODE, code: THREAD_PARTIAL_CANCEL_REQUESTED_CODE, details: base, set: common },
        now,
        () => settle(tx, ownerId, job, item, 'canceled', { ...base, not_sent: true }, now, common),
      );
    const isMock = plan.adapter.kind === 'mock';
    if (!cancel && !isMock && result.status === 'rejected' && result.error_code === LIVE_PUBLISH_PAUSED_STEP_CODE) {
      // FIX-LIVEP2(D39 즉시 중지 · 리뷰 P2 jobs.ts:900): 전송 시작 뒤·게시 시도 표식 전에 중지가 커밋됨 — 표식 트랜잭션이 거절해 게시 요청을 보내지 않았다
      // (의도는 rejected 로 채움). 자동 재시도(RETRY_WAIT)가 아니라 beginSend 의 중지 보류와 같은 BLOCKED(not_sent) — 재개 뒤 '재시도'만 다시 보낸다.
      // 이미 표식을 쓴 시도는 여기 오지 않는다(표식 뒤는 기존 결과 규칙 그대로).
      // FIX2-LIVEP2(검토 #3): 이 시도는 시도 한도에 세지 않는다(resume_count + 1 — upload_yield 와 같은 방식, resume_count ≤ attempt 유지). 그래야 마지막 시도
      // (max_attempts)에서 멈춰도 화면이 약속한 "재개 뒤 '재시도'"가 409 attempts_exhausted 막다른 길이 되지 않고, 의도 전 중지(beginSend — 시도 없음)와 같아진다.
      // 자동 재시도는 늘지 않는다: 이 보류는 BLOCKED 라 사용자가 중지한 뒤 재개하고 '재시도'를 눌러야만 다음 시도가 생긴다(시도마다 사용자 동작 2개).
      const free = job.resumeCount < job.attempt;
      return settle(
        tx,
        ownerId,
        job,
        item,
        'blocked',
        { ...base, reason: 'live_publish_paused', not_sent: true, stage: 'before_publish_attempt', counted: !free },
        now,
        { ...common, lastErrorCode: 'live_publish_paused', ...(free ? { resumeCount: job.resumeCount + 1 } : {}) },
      );
    }
    if (!cancel && cls.event === 'remote_accepted' && result.upload_yield && !result.external_id) {
      // FIX-T15(Codex review-T15 P1): 조각 예산을 다 쓰고 양보(원격이 받은 바이트를 확인, 세션 유효, 영상 아직 없음). 결과 불명이 아니므로 조회 없이
      // 즉시 다음 시도(같은 세션 재개). 진행이 있어야만 오므로 시도 한도에 넣지 않는다(resume_count + 1 — 받은 바이트 단조 증가가 끝을 보장).
      const free = job.resumeCount < job.attempt;
      return settle(
        tx,
        ownerId,
        job,
        item,
        'upload_yield',
        { ...base, received_bytes: result.upload_yield.received_bytes, total_bytes: result.upload_yield.total_bytes, counted: !free },
        now,
        { ...common, nextRunAt: now, ...(free ? { resumeCount: job.resumeCount + 1 } : {}) },
      );
    }
    switch (cls.event) {
      case 'confirmed': {
        const to = await settle(
          tx,
          ownerId,
          job,
          item,
          cancel ? 'cancel_too_late' : 'confirmed',
          { ...base, result_kind: result.result_kind ?? null, requested_visibility: item.visibility, remote_visibility: result.remote_visibility ?? null },
          now,
          common,
        );
        await insertPublication(tx, ownerId, item, job.id, isMock, result, now);
        return to;
      }
      case 'remote_accepted':
        if (cancel) return settle(tx, ownerId, job, item, 'reconcile_retry', { ...base, remote: 'processing' }, now, { ...common, nextRunAt: addMs(now, REMOTE_POLL_MS) });
        return settle(tx, ownerId, job, item, 'remote_accepted', base, now, { ...common, nextRunAt: addMs(now, REMOTE_POLL_MS), reconcileCount: 0 });
      case 'transient_failure': {
        if (cancel) return canceledUnlessPartial();
        // T15(D27): 원격이 정한 다음 시각(할당량 초기화 등)이 있으면 그 시각까지 기다린다(Retry-After 1시간 상한 대신, 시도 한도는 그대로).
        const retryAt = result.retry_at ? new Date(result.retry_at) : null;
        const d =
          retryAt && Number.isFinite(retryAt.getTime())
            ? decideRetryAt(countedAttempts(job), job.maxAttempts, retryAt, now)
            : decideRetry(countedAttempts(job), job.maxAttempts, result.retry_after_sec, now, random);
        if (d.retry) return settle(tx, ownerId, job, item, 'transient_failure', { ...base, next_run_at: d.nextRunAt.toISOString() }, now, { ...common, nextRunAt: d.nextRunAt });
        // FIX2-FULLREV(Q1): 재시도 소진 — 이미 게시된 부분이 있으면 FAILED 가 아니라 UNKNOWN(thread_partial_failed, failUnlessPartial)
        return failUnlessPartial(tx, ownerId, job, item, { reason: d.reason, details: base, set: common }, now, () =>
          settle(tx, ownerId, job, item, 'permanent_failure', { ...base, reason: d.reason }, now, common),
        );
      }
      case 'permanent_failure':
        if (cancel) return canceledUnlessPartial();
        // FIX2-FULLREV(Q1): 영구 거부 — 이미 게시된 부분이 있으면(앞 게시물 게시 뒤 다음 게시물 거절) FAILED 가 아니라 UNKNOWN(thread_partial_failed)
        return failUnlessPartial(tx, ownerId, job, item, { reason: 'permanent_failure', details: base, set: common }, now, () =>
          settle(tx, ownerId, job, item, 'permanent_failure', base, now, common),
        );
      case 'blocked':
        if (cancel) return canceledUnlessPartial();
        return settle(tx, ownerId, job, item, 'blocked', { ...base, reason: 'auth' }, now, common);
      case 'ambiguous':
      default:
        if (cancel) return settle(tx, ownerId, job, item, 'reconcile_retry', { ...base, remote: 'unknown' }, now, { ...common, nextRunAt: addMs(now, RECONCILE_BASE_MS), reconcileCount: 0 });
        return settle(tx, ownerId, job, item, 'ambiguous', base, now, { ...common, nextRunAt: addMs(now, RECONCILE_BASE_MS), reconcileCount: 0 });
    }
  });
}

async function sendJob(db: Db, registry: ChannelAdapterRegistry, leased: JobRow, opts: JobRunOptions): Promise<JobState | 'lease_lost'> {
  const clock = opts.clock ?? (() => new Date());
  const begun = await beginSend(db, registry, leased, opts, clock());
  if (typeof begun === 'string') return begun;
  // 2단계: DB 잠금 없이 외부(모의) 호출. 시간 초과·예외 = 결과 불명(보냈을 수도 있음).
  const timeoutMs = budgetFor(begun.adapter, opts);
  const deadline = Date.now() + timeoutMs;
  const r = await withTimeout(timeoutMs, async (timeoutSignal) => {
    // FIX-T11(P0): 시간 초과 또는 lease 상실(heartbeat 실패) 중 먼저 온 것으로 중단한다.
    const lease = new AbortController();
    const signal = AbortSignal.any([timeoutSignal, lease.signal]);
    const ctx = makeContext(db, begun.job, begun.intentKey, opts, signal, begun.mockScenario, () => lease.abort(), {
      snapshot: begun.snapshot,
      rateUnitsReserved: begun.rateUnitsReserved,
      deadline,
      livePauseGate: begun.adapter.kind === 'live',
    });
    let prepared;
    try {
      prepared = await begun.adapter.prepare(begun.snapshot, ctx);
    } catch {
      // prepare 는 원격에 아무것도 보내지 않는다 — 부작용 없는 영구 오류(자동 반복 없음).
      return { status: 'rejected', retry_class: 'permanent', error_code: 'prepare_failed' } satisfies AdapterResult;
    }
    // prepare 가 시간 초과·중단 뒤에 끝났으면 submit 하지 않는다(결과는 불명으로 기록 — 이번 시도 의도는 이미 있다).
    if (signal.aborted) throw new LeaseLostError();
    return begun.adapter.submit(prepared, ctx);
  });
  const result: AdapterResult = r.ok
    ? r.value
    : { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: r.reason === 'timeout' ? 'submit_timeout' : 'adapter_error' };
  const final = await finishSend(db, begun, result, opts, clock());
  // T14(D26): 연결 정보를 쓰는 계정의 401(auth) → 작업은 BLOCKED(자동 재시도 없음). T13 의 확인 경로(checkCredential — 공급자에 한 번 묻고
  // 무효면 연결 정보 error → 실행 게이트가 막음)를 한 번 부른다. 실패해도 작업 결과는 그대로(오류 이름만 남긴다).
  const credState = begun.snapshot.account.credential_state;
  // LIVE-P1(D38): 실제 계정은 자동 연결 확인(실제 프로필 조회 = 외부 호출)을 하지 않는다 — 게시 승인 범위 밖의 호출을 늘리지 않게.
  // 보류(BLOCKED) 뒤 사용자가 설정 화면의 "연결 확인(프로필 조회)"으로 직접 확인한다.
  if (final === 'BLOCKED' && result.retry_class === 'auth' && begun.adapter.kind === 'mock' && credState && credState !== 'none' && opts.credentials?.check) {
    try {
      await opts.credentials.check(begun.job.ownerId, begun.snapshot.account.id, clock());
    } catch (e) {
      console.error(`[jobs] 401 뒤 연결 확인 실패:${e instanceof Error ? e.name : typeof e}`);
    }
  }
  return final;
}

/**
 * 원격 조회 결과 적용(worker·사용자 재확인 공용, 한 트랜잭션 안에서 호출). manual = 사용자 재확인: 찾음 → CONFIRMED, 그 밖은 상태 그대로(기록만).
 */
async function applyReconcile(
  tx: DbOrTx,
  job: JobRow,
  item: DistributionItemRow,
  r: ReconcileResult,
  caps: { definitive_not_found: boolean; mock: boolean },
  cancelResult: CancelResult | null,
  now: Date,
  opts: { manual: boolean; random?: () => number },
): Promise<JobState> {
  const ownerId = job.ownerId;
  const intent = job.attempt > 0 ? await intentFor(tx, ownerId, job.id, job.attempt, true) : null;
  // FIX-LIVEP1(Codex P0): 확인 후보(미확인)는 작업 이력에만 남긴다 — 결과(publication)·게시 단계·VERIFIED 를 만들지 않는다. 형식이 맞는 값만(외부 ID threads:<숫자>, 공식 링크).
  const candidate =
    r.status === 'unknown' && r.candidate && LIVE_THREADS_EXTERNAL_ID_RE.test(r.candidate.external_id)
      ? { candidate_external_id: r.candidate.external_id, ...(isAllowedThreadsPermalink(r.candidate.permalink) ? { candidate_permalink: r.candidate.permalink } : {}) }
      : {};
  const base = { attempt: job.attempt, reconcile: r.status, error_code: r.error_code ?? null, manual: opts.manual || undefined, ...candidate, ...providerDiagDetail(r.provider_diag) };
  const common = { ...CLEAR_LEASE };
  if (cancelResult?.status === 'canceled' && job.state === 'CANCEL_REQUESTED') {
    return settle(tx, ownerId, job, item, 'canceled', { ...base, remote_canceled: true }, now, common);
  }
  if (r.status === 'found') {
    await fillIntent(tx, ownerId, intent, 'accepted', r, now, 'reconcile');
    const event: JobEvent = job.state === 'CANCEL_REQUESTED' ? 'cancel_too_late' : 'reconciled_found';
    // T15(D27): 요청한 공개 범위(승인 스냅샷)와 원격이 실제로 보고한 공개 범위를 함께 남긴다(미검증 프로젝트의 강제 비공개 등, A12).
    const to = await settle(
      tx,
      ownerId,
      job,
      item,
      event,
      {
        ...base,
        external_id: r.external_id ?? null,
        result_kind: r.result_kind ?? null,
        requested_visibility: item.visibility,
        remote_visibility: r.remote_visibility ?? null,
      },
      now,
      common,
    );
    await insertPublication(tx, ownerId, item, job.id, caps.mock, r, now);
    return to;
  }
  if (r.status === 'failed' && !opts.manual) {
    // T15(D27): 원격이 받은 결과를 스스로 거부·처리 실패로 끝냄(YouTube uploadStatus failed/rejected) — 영구 실패, 다시 보내지 않는다.
    await fillIntent(tx, ownerId, intent, 'accepted', r, now, 'reconcile');
    const failedSet = { ...common, lastErrorCode: r.error_code ?? 'remote_failed', lastRetryClass: 'permanent' };
    // FIX2-FULLREV(Q1): 스레드 게시물(publish 단계)이 이미 게시된 작업이면 FAILED 가 아니라 UNKNOWN(thread_partial_failed). 지금 어댑터에서는 일어나지 않는
    // 모양이다(Threads 모의·실제는 게시가 있으면 failed 를 돌려주지 않음) — 조회 보고보다 단계 기록을 믿는 방어선. YouTube 의 video 단계는 세지 않는다:
    // 이 결과(처리 실패·거부)가 바로 그 영상에 대한 원격의 확정 판정이다(T15 D27 — FAILED 그대로).
    return failUnlessPartial(tx, ownerId, job, item, { reason: 'remote_failed', details: base, set: failedSet, kinds: ['publish'] }, now, () =>
      settle(tx, ownerId, job, item, 'permanent_failure', { ...base, reason: 'remote_failed' }, now, failedSet),
    );
  }
  if (opts.manual) {
    // 사용자 재확인은 조회만: 찾지 못하면 상태를 바꾸지 않는다(재전송 없음). resumable 이어도 여기서 이어 보내지 않는다.
    return settle(tx, ownerId, job, item, 'reconcile_retry', { ...base, published_parts: r.published_parts ?? undefined }, now, {});
  }
  if (r.status === 'resumable') {
    // T14(D26): 남은 단계가 원격에 아직 게시되지 않았음이 단계 기록으로 확인됨 — 새 시도(새 전송 의도)가 같은 원격 참조(컨테이너)를
    // 재사용해 이어 보낸다(새 컨테이너·재게시 없음). 이미 게시된 앞부분은 다시 보내지 않는다.
    const parts = r.published_parts ?? 0;
    if (job.state === 'CANCEL_REQUESTED') {
      // 스레드 일부가 이미 게시됨 — 취소 성공이라고 하지 않고(A11) 남은 부분도 보내지 않는다. UNKNOWN(사유 thread_partial_cancel_requested) — 사용자 확인.
      // FIX1-FULLREV(F2 후속2): 조회가 센 게시물 수(parts)와 단계 기록(게시·게시 시도 표식)을 함께 본다(stopUnlessPartial) — 어느 쪽이든 있으면 UNKNOWN.
      const stop = { reason: THREAD_PARTIAL_CANCEL_REQUESTED_CODE, code: THREAD_PARTIAL_CANCEL_REQUESTED_CODE, details: base, set: common, reportedParts: parts };
      return stopUnlessPartial(tx, ownerId, job, item, stop, now, () =>
        settle(tx, ownerId, job, item, 'canceled', { ...base, not_sent: true, published_parts: 0 }, now, common),
      );
    }
    if (job.state === 'RECONCILING' || job.state === 'REMOTE_PROCESSING') {
      // FIX-T14(Codex review-T14 missed case): 원격 처리 지연(REMOTE_PROCESSING) 뒤의 재개는 장애가 아니다 — 시도 한도에서 뺀다(resume_count + 1,
      // 상한 FREE_RESUME_MAX). 장애(결과 불명 → RECONCILING) 뒤의 재개는 시도로 센다(끝없는 재개 반복 방지).
      const free = job.state === 'REMOTE_PROCESSING' && job.resumeCount < FREE_RESUME_MAX && job.resumeCount < job.attempt;
      return settle(tx, ownerId, job, item, 'resume', { ...base, published_parts: parts, counted: !free }, now, {
        ...common,
        nextRunAt: now,
        reconcileCount: 0,
        ...(free ? { resumeCount: job.resumeCount + 1 } : {}),
      });
    }
  }
  const count = job.reconcileCount + 1;
  if (r.status === 'processing') {
    // FIX2-FULLREV(FX2): 한도 — 게시된 스레드 게시물이 있으면 사유 thread_partial_unresolved(settleReconcileLimit, "새 계획 필요"라고 하지 않게)
    if (count >= REMOTE_POLL_MAX) return settleReconcileLimit(tx, ownerId, job, item, { ...base, polls: count }, now, common);
    const next = { ...common, nextRunAt: addMs(now, REMOTE_POLL_MS), reconcileCount: count };
    if (job.state === 'RECONCILING') return settle(tx, ownerId, job, item, 'remote_accepted', base, now, next);
    if (job.state === 'REMOTE_PROCESSING') return settle(tx, ownerId, job, item, 'remote_processing', base, now, next);
    return settle(tx, ownerId, job, item, 'reconcile_retry', base, now, next);
  }
  if (r.status === 'not_found' && caps.definitive_not_found && job.state !== 'REMOTE_PROCESSING') {
    await fillIntent(tx, ownerId, intent, 'rejected', { error_code: 'not_found_on_remote' }, now, 'reconcile');
    if (job.state === 'CANCEL_REQUESTED') {
      // FIX1-FULLREV(F2 후속2): 이번 시도의 원격 객체가 확실히 없어도 단계 기록에 게시된 단계·게시 시도 표식이 있으면 "보내지 않음"(CANCELED)이 아니라 UNKNOWN.
      const stop = { reason: THREAD_PARTIAL_CANCEL_REQUESTED_CODE, code: THREAD_PARTIAL_CANCEL_REQUESTED_CODE, details: base, set: common };
      return stopUnlessPartial(tx, ownerId, job, item, stop, now, () => settle(tx, ownerId, job, item, 'canceled', { ...base, not_sent: true }, now, common));
    }
    // 원격에 확실히 없음 → 다시 보내도 된다(새 시도 = 새 전송 의도). 시도 한도 안에서만.
    const d = decideRetry(countedAttempts(job), job.maxAttempts, null, now, opts.random ?? Math.random);
    if (d.retry) return settle(tx, ownerId, job, item, 'reconciled_not_found', { ...base, next_run_at: d.nextRunAt.toISOString() }, now, { ...common, nextRunAt: d.nextRunAt });
    // FIX2-FULLREV(Q1): 시도 한도 — 단계 기록에 게시된 부분이 있으면(조회 보고와 단계 기록이 어긋남 — 지금 어댑터는 단계가 있으면 not_found 를 돌려주지 않는다)
    // FAILED 가 아니라 UNKNOWN(thread_partial_failed). 조회 보고보다 단계 기록(취소 요청 경로와 같은 판단).
    return failUnlessPartial(tx, ownerId, job, item, { reason: d.reason, details: base, set: common }, now, () =>
      settle(tx, ownerId, job, item, 'permanent_failure', { ...base, reason: d.reason }, now, common),
    );
  }
  // 확인 불가(read 권한 없음·판단 불가·확실하지 않은 없음): 한도까지 다시 조회, 넘으면 UNKNOWN(자동 재전송 없음).
  // FIX2-FULLREV(FX2): 게시된 스레드 게시물이 있으면 사유 thread_partial_unresolved(재시작·컨테이너 만료 뒤 3번째 게시물을 모름 — D26) — settleReconcileLimit
  if (count >= RECONCILE_MAX_ATTEMPTS) return settleReconcileLimit(tx, ownerId, job, item, { ...base, checks: count }, now, { ...common, reconcileCount: count });
  return settle(tx, ownerId, job, item, 'reconcile_retry', { ...base, checks: count }, now, { ...common, nextRunAt: reconcileDelay(count, now), reconcileCount: count });
}

async function remoteCheck(
  db: DbOrTx,
  registry: ChannelAdapterRegistry,
  job: JobRow,
  item: DistributionItemRow,
  signalMs: number,
  opts: { workerId: string; clock?: () => Date; leaseTtlMs?: number; tryCancel: boolean; credentials?: JobRunOptions['credentials']; liveSubmitTimeoutMs?: number },
): Promise<{ r: ReconcileResult; caps: { definitive_not_found: boolean; mock: boolean }; cancel: CancelResult | null }> {
  const ownerId = job.ownerId;
  const acc = await accountOf(db, ownerId, item.channelAccountId);
  if (!acc) return { r: { status: 'unknown', error_code: 'account_missing' }, caps: { definitive_not_found: false, mock: false }, cancel: null };
  const intent = (job.attempt > 0 ? await intentFor(db, ownerId, job.id, job.attempt) : null) ?? (await latestIntent(db, ownerId, job.id));
  const unresolved = (code: string) => ({
    r: { status: 'unknown', error_code: code } satisfies ReconcileResult,
    caps: { definitive_not_found: false, mock: acc.kind === 'mock' },
    cancel: null,
  });
  let adapter: ChannelAdapter;
  if (!intent) {
    // 전송 의도가 없으면 보낸 적이 없다 — 어떤 어댑터인지는 판정에 쓰이지 않는다(not_found no_intent, M3 그대로).
    try {
      adapter = registry.getAdapterFor(adapterAccount(acc));
    } catch {
      return { r: { status: 'unsupported', error_code: 'adapter_unavailable' }, caps: { definitive_not_found: false, mock: false }, cancel: null };
    }
  } else {
    // T14(D26)·FIX-T14(Codex review-T14 P0 :848): **보낸 어댑터**(전송 의도의 adapter_id)로만 조회한다. 현재 계정 상태로 고른 어댑터로 대신하지 않는다.
    // adapter_id 가 없는 의도(T14 이전에 만든 것)는 그때 유일했던 일반 모의 어댑터(LEGACY_SEND_ADAPTER_ID)로 명시적으로 읽는다.
    // 기록된 어댑터를 찾을 수 없으면 not_found 가 아니라 unknown(확인 불가 → 한도 뒤 UNKNOWN, 자동 재전송 없음).
    const rec = recordedAdapterIdOf(intent.sanitizedDetails);
    if (rec.id === null) return unresolved('adapter_unresolved');
    const resolved = resolveAdapterById(registry, rec.id, acc);
    if (!resolved) return unresolved('adapter_unresolved');
    adapter = resolved;
  }
  const mockScenario = acc.kind === 'mock' ? await mockScenarioFor(db, ownerId, item.id) : null;
  const caps = adapter.capabilities(adapterAccount(acc), { mockScenario });
  if (!intent) return { r: { status: 'not_found', error_code: 'no_intent' }, caps: { definitive_not_found: true, mock: caps.mock }, cancel: null };
  const snapshot = snapshotOf(item, acc, typeof item.payloadJson.channel === 'string' ? item.payloadJson.channel : acc.platform);
  const ref: RemoteReference = {
    platform: acc.platform,
    intent_key: intent.intentKey,
    external_id: intent.remoteExternalId,
    provider_request_id: intent.providerRequestId,
  };
  let cancel: CancelResult | null = null;
  // LIVEP1-TIMEOUT: 실제 어댑터 조회도 실제 지연에 맞는 예산(목록·상태 읽기)
  const res = await withTimeout(budgetFor(adapter, opts, signalMs), async (signal) => {
    const ctx = makeContext(db as Db, job, intent.intentKey, opts, signal, mockScenario, undefined, { snapshot });
    if (opts.tryCancel && caps.cancel && ref.external_id) {
      cancel = await adapter.cancel(ref, ctx);
      if (cancel.status === 'canceled') return { status: 'not_found' } satisfies ReconcileResult;
    }
    if (!caps.read) return { status: 'unsupported', error_code: 'read_unsupported' } satisfies ReconcileResult;
    return adapter.reconcile(ref, ctx);
  });
  let r: ReconcileResult = res.ok ? res.value : { status: 'unknown', error_code: res.reason === 'timeout' ? 'reconcile_timeout' : 'adapter_error' };
  // FIX-T14(Codex review-T14 P1 bundle.ts:123): 복원한 작업은 단계 기록이 묶음과 함께 왔는지(이전 묶음·제외) 이 환경이 확정할 수 없다.
  // 단계 기록에 기대는 어댑터의 not_found(“기록 없음 → 보내지 않음”)를 믿지 않고 unknown 으로 둔다(복원 작업은 재전송 경로도 없다).
  if (r.status === 'not_found' && job.restoredNeedsReview && adapter.usesRemoteSteps) {
    const steps = await listRemoteSteps(db, ownerId, job.id);
    r = { status: 'unknown', error_code: steps.length === 0 ? 'restored_steps_missing' : 'restored_not_found_unverified' };
  }
  return { r, caps: { definitive_not_found: caps.definitive_not_found && !job.restoredNeedsReview, mock: caps.mock }, cancel };
}

/**
 * FIX-T14(P0): 기록된 어댑터 ID → 레지스트리의 그 어댑터. getAdapterById 가 없는 레지스트리는 현재 선택 결과가 **같은 ID 일 때만** 쓴다(다르면 null).
 */
function resolveAdapterById(registry: ChannelAdapterRegistry, id: AdapterId, acc: typeof channelAccounts.$inferSelect): ChannelAdapter | null {
  if (registry.getAdapterById) return registry.getAdapterById(id);
  try {
    const current = registry.getAdapterFor(adapterAccount(acc));
    return (current.id ?? LEGACY_SEND_ADAPTER_ID) === id ? current : null;
  } catch {
    return null;
  }
}

async function checkJob(db: Db, registry: ChannelAdapterRegistry, leased: JobRow, opts: JobRunOptions): Promise<JobState | 'lease_lost'> {
  const clock = opts.clock ?? (() => new Date());
  const ownerId = leased.ownerId;
  const item = await itemRow(db, ownerId, leased.itemId!);
  if (!item) return 'lease_lost';
  // 취소 요청인데 이번 시도에서 보낸 적이 없으면(lease 뒤 전송 전) 바로 CANCELED.
  // FIX1-FULLREV(F2 후속2): 조회 lease(CANCEL_REQUESTED 는 CHECK_LEASE_STATES — 만료 복구보다 먼저 이 경로로 올 수 있다)도 앞선 시도가 스레드 일부를
  // 게시했거나 게시 시도 표식이 있으면 CANCELED("보내지 않음")가 아니라 UNKNOWN(thread_partial_cancel_requested, stopUnlessPartial).
  if (leased.state === 'CANCEL_REQUESTED' && (await cancelRequestedBeforeSend(db, leased.id))) {
    return db.transaction(async (tx) => {
      const it = await lockItem(tx, ownerId, leased.itemId!);
      const job = await jobForUpdate(tx, ownerId, leased.id);
      if (!job || job.leaseOwner !== opts.workerId || job.state !== 'CANCEL_REQUESTED') return 'lease_lost' as const;
      const now = clock();
      const stop = { reason: THREAD_PARTIAL_CANCEL_REQUESTED_CODE, code: THREAD_PARTIAL_CANCEL_REQUESTED_CODE, details: { attempt: job.attempt, cause: 'check_lease' } };
      return stopUnlessPartial(tx, ownerId, job, it, stop, now, () => settle(tx, ownerId, job, it, 'canceled', { not_sent: true, attempt: job.attempt }, now));
    });
  }
  const { r, caps, cancel } = await remoteCheck(db, registry, leased, item, opts.submitTimeoutMs ?? 30_000, { ...opts, tryCancel: leased.state === 'CANCEL_REQUESTED' });
  return db.transaction(async (tx) => {
    const it = await lockItem(tx, ownerId, leased.itemId!);
    const job = await jobForUpdate(tx, ownerId, leased.id);
    if (!job || job.leaseOwner !== opts.workerId || job.state !== leased.state || job.attempt !== leased.attempt) return 'lease_lost' as const;
    return applyReconcile(tx, job, it, r, caps, cancel, clock(), { manual: false, random: opts.random });
  });
}

/** lease 한 작업 하나를 처리한다(LEASED → 전송, 그 밖 → 원격 조회). */
export async function processJob(db: Db, registry: ChannelAdapterRegistry, job: JobRow, opts: JobRunOptions): Promise<ProcessResult> {
  try {
    const state = job.state === 'LEASED' ? await sendJob(db, registry, job, opts) : await checkJob(db, registry, job, opts);
    return { jobId: job.id, state };
  } catch (e) {
    // 처리 중 예외: lease 를 그대로 두면 만료 복구가 안전하게 정리한다(의도가 있으면 RECONCILING). 로그에는 오류 이름만.
    console.error(`[jobs] 작업 처리 오류:${e instanceof Error ? e.name : typeof e}`);
    return { jobId: job.id, state: 'error' };
  }
}

export interface JobsTickResult {
  worker_id: string;
  recovered: number;
  leased: number;
  results: Record<string, number>;
}

/** 복구 → lease → 처리(순서대로). 결과 상태별 개수를 돌려준다. */
export async function runJobsTick(db: Db, registry: ChannelAdapterRegistry, opts: JobRunOptions & { maxJobs?: number }): Promise<JobsTickResult> {
  const clock = opts.clock ?? (() => new Date());
  const recovered = await recoverExpiredLeases(db, { now: clock(), ownerId: opts.ownerId });
  const results: Record<string, number> = {};
  // FIX-T11(P1): 지금 처리할 작업 하나만 lease 한다(한꺼번에 lease 하면 뒤 작업의 lease 가 처리 전에 만료돼 시도를 잃는다).
  // 이번 tick 에서 이미 처리한 작업은 다시 고르지 않는다(tick 당 최대 maxJobs 개 — 이전 일괄 lease 와 같은 범위).
  const max = Math.min(Math.max(Math.floor(opts.maxJobs ?? 5), 1), 20);
  const done: string[] = [];
  for (let i = 0; i < max; i++) {
    const [j] = await leaseJobs(db, { workerId: opts.workerId, now: clock(), limit: 1, leaseTtlMs: opts.leaseTtlMs, ownerId: opts.ownerId, planId: opts.planId, excludeIds: done });
    if (!j) break;
    done.push(j.id);
    const r = await processJob(db, registry, j, opts);
    results[r.state] = (results[r.state] ?? 0) + 1;
  }
  return { worker_id: opts.workerId, recovered, leased: done.length, results };
}

// ---- 사용자 동작: 취소·재확인 ----

export type CancelOutcome =
  | { item_id: string; job_id: string; canceled: true; cancel_requested: false; state: 'CANCELED'; message: string }
  | { item_id: string; job_id: string; canceled: false; cancel_requested: true; state: 'CANCEL_REQUESTED'; message: string }
  /**
   * FIX-T14: 스레드 일부가 이미 게시된 작업의 취소 — 남은 부분은 보내지 않지만 취소 성공이라고 하지 않는다(UNKNOWN).
   * FIX2-FULLREV(Q3): 복원한 작업인데 기록이 "보내지 않음"을 증명하지 못한 취소도 UNKNOWN(reason restored_cancel_unverified, published_parts 0 — 모름).
   * reason = 작업에 남긴 사유 코드(thread_partial_canceled · restored_cancel_unverified).
   */
  | { item_id: string; job_id: string; canceled: false; cancel_requested: false; state: 'UNKNOWN'; published_parts: number; reason: string; message: string };

/** FIX2-FULLREV(Q3): 복원한 작업 취소를 확정하지 못했을 때의 응답 문구(다시 보내지 않음 — 채널에서 직접 확인). */
const RESTORED_CANCEL_UNVERIFIED_MESSAGE =
  '더 보내지 않습니다. 복원한 작업이라 보냈는지 이 환경에서 확인할 수 없어 취소를 확정하지 않았습니다(결과 불명 — 다시 보내지 않음). 채널에서 직접 확인하세요.';
/**
 * FIX2-FULLREV(FX4): 모의 계정 항목의 같은 응답 — 모의 항목은 실제 채널로 보낸 적이 없고 모의 시뮬레이터는 복원되지 않아 확인할 곳이 없다
 * ("채널에서 직접 확인"을 시키지 않는다). 계정 kind 를 모르면(계정 없음) 위의 조심스러운 문구.
 */
const RESTORED_CANCEL_UNVERIFIED_MOCK_MESSAGE =
  'MOCK — 더 보내지 않습니다. 복원한 모의 작업이라 모의 전송 여부를 복원된 기록으로 확인할 수 없어 취소를 확정하지 않았습니다(결과 불명 — 자동 재전송 안 함). 실제 채널로 보낸 것은 없습니다.';

async function latestJobForItem(tx: DbOrTx, ownerId: string, itemId: string, lock: boolean): Promise<JobRow | null> {
  const q = tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.ownerId, ownerId), eq(jobs.itemId, itemId)))
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(1);
  const rows = lock ? await q.for('update') : await q;
  return rows[0] ?? null;
}

/**
 * 배포 취소(한 트랜잭션, 항목·작업 잠금). 아직 시작하지 않은 작업(QUEUED·RETRY_WAIT·BLOCKED)만 즉시 CANCELED.
 * 이미 전송 단계(LEASED·SENDING·REMOTE_PROCESSING·RECONCILING)면 CANCEL_REQUESTED("취소 확인 중") — 원격 취소를 주장하지 않는다(A11).
 * UNKNOWN·끝난 작업·실행 전 항목은 409. 승인 기록은 그대로 남는다.
 */
export async function cancelItem(db: Db, ownerId: string, itemId: string, now: Date = new Date()): Promise<CancelOutcome> {
  if (!isUuid(itemId)) throw new NotFoundError(ITEM_NOT_FOUND);
  return db.transaction(async (tx) => {
    const item = await lockItem(tx, ownerId, itemId);
    await activeApprovalsFor(tx, ownerId, [item.id]);
    const job = await latestJobForItem(tx, ownerId, item.id, true);
    // 실행 전(PLANNED — 이전 작업이 승인 철회로 보류된 경우 포함)은 취소 대상이 아니다: 승인 철회를 쓴다.
    if (!job || item.status === 'PLANNED') throw new NotCancellableError(item.status);
    let out: CancelOutcome;
    switch (job.state) {
      case 'QUEUED':
      case 'RETRY_WAIT':
      case 'BLOCKED': {
        // FIX-T14(Codex review-T14 missed case): 스레드 일부가 이미 원격에 게시됐으면(이전 시도 — 2번째 이후 게시물에서 401·429·재개 대기 등)
        // "보내지 않음"·취소 성공이라고 하지 않는다(A11). 남은 게시물은 보내지 않고 UNKNOWN(thread_partial_canceled) — 단계 목록이 게시된 범위를 보여 준다.
        // LIVE-P1(D38): 실제 Threads 의 게시 시도 표식(publish_attempt) — 결과를 모르는 게시 시도가 있으면 "보내지 않음"이라고 하지 않는다.
        // FIX1-FULLREV(F2 후속2): 판정·결과는 작업 처리기의 멈춤 결정과 같은 공용 규칙(partialSendOf · settlePartialStop — cancel_partial → UNKNOWN).
        const partial = await partialSendOf(tx, ownerId, job.id);
        if (partial) {
          const live = partial.attempts > 0;
          await settlePartialStop(tx, ownerId, job, item, 'user', {}, partial, THREAD_PARTIAL_CANCELED_CODE, now);
          out = {
            item_id: item.id,
            job_id: job.id,
            canceled: false,
            cancel_requested: false,
            state: 'UNKNOWN',
            published_parts: partial.parts,
            reason: THREAD_PARTIAL_CANCELED_CODE,
            message: live
              ? '더 보내지 않습니다. 이 글은 실제 Threads 에 이미 게시됐거나 게시됐을 수 있습니다(취소로 되돌리지 않음 — Threads 에서 직접 확인하세요).'
              : `남은 부분은 보내지 않습니다. 이미 게시된 ${partial.parts}개는 원격에 남아 있습니다(MOCK — 취소로 되돌리지 않음).`,
          };
          break;
        }
        // FIX2-FULLREV(Q3, D18·FIX-T10·FIX-T14 후속): 복원한 작업(읽기 전용 이력)은 복원된 기록이 "아무것도 보내지 않음"을 증명할 때만 CANCELED(not_sent).
        // 단계 기록은 0031 이후 묶음에만 있으므로(이전 묶음은 단계 없이 복원) 단계가 없다는 것만으로는 증명이 아니다 — 증명이 없으면 UNKNOWN
        // (restored_cancel_unverified, 다시 보내지 않음 — 사용자가 채널에서 직접 확인). 부분 게시 근거가 있는 복원 작업은 위 규칙(thread_partial_canceled) 그대로.
        if (job.restoredNeedsReview || item.restoredNeedsReview) {
          const intents = await listIntents(tx, ownerId, [job.id]);
          const steps = await listRemoteSteps(tx, ownerId, job.id);
          if (!restoredCancelNotSentProven({ intents, stepKinds: steps.map((s) => s.kind) })) {
            // FIX2-FULLREV(FX4): 응답 문구는 항목 계정 kind 로(모의 = 실제 채널로 보낸 것 없음)
            const mockAccount = (await accountOf(tx, ownerId, item.channelAccountId))?.kind === 'mock';
            await settle(
              tx,
              ownerId,
              job,
              item,
              'cancel_partial',
              {
                cause: 'user',
                reason: RESTORED_CANCEL_UNVERIFIED_CODE,
                restored: true,
                not_sent: false,
                intents: intents.length,
                unresolved_intents: intents.filter((i) => i.outcome !== 'rejected').length,
                remote_steps: steps.length,
              },
              now,
              { ...CLEAR_LEASE, cancelRequestedAt: now, lastErrorCode: RESTORED_CANCEL_UNVERIFIED_CODE },
            );
            out = {
              item_id: item.id,
              job_id: job.id,
              canceled: false,
              cancel_requested: false,
              state: 'UNKNOWN',
              published_parts: 0,
              reason: RESTORED_CANCEL_UNVERIFIED_CODE,
              message: mockAccount ? RESTORED_CANCEL_UNVERIFIED_MOCK_MESSAGE : RESTORED_CANCEL_UNVERIFIED_MESSAGE,
            };
            break;
          }
        }
        await settle(tx, ownerId, job, item, 'canceled', { cause: 'user', not_sent: true }, now, { cancelRequestedAt: now });
        out = { item_id: item.id, job_id: job.id, canceled: true, cancel_requested: false, state: 'CANCELED', message: '취소했습니다(아직 보내지 않은 작업)' };
        break;
      }
      case 'LEASED':
      case 'SENDING':
      case 'REMOTE_PROCESSING':
      case 'RECONCILING':
        await requestCancelLocked(tx, ownerId, item.id, 'user', now);
        await recomputePlanStatus(tx, ownerId, item.planId, now);
        out = { item_id: item.id, job_id: job.id, canceled: false, cancel_requested: true, state: 'CANCEL_REQUESTED', message: CANCEL_PENDING_MESSAGE };
        break;
      case 'CANCEL_REQUESTED':
        out = { item_id: item.id, job_id: job.id, canceled: false, cancel_requested: true, state: 'CANCEL_REQUESTED', message: CANCEL_PENDING_MESSAGE };
        break;
      default:
        throw new NotCancellableError(job.state);
    }
    await recordAudit(tx, {
      ownerId,
      action: 'item.cancel',
      entity: 'distribution_item',
      entityId: item.id,
      details: { job_id: job.id, from: job.state, result: out.state },
      at: now,
    });
    return out;
  });
}

export const RECONCILABLE_JOB_STATES: readonly JobState[] = ['RECONCILING', 'UNKNOWN', 'REMOTE_PROCESSING'];

export interface ReconcileOutcome {
  item_id: string;
  job_id: string;
  state_before: string;
  state: string;
  found: boolean;
  remote: ReconcileResult['status'];
  /**
   * applied: 조회 결과를 적용함(찾음 → CONFIRMED, 못 찾음 → 상태 그대로 기록).
   * stale_lookup: 조회한 뒤 잠금 안에서 보니 작업의 시도(attempt)나 상태가 바뀌어 있어 아무것도 적용하지 않음(옛 시도 조회 결과로 새 시도를 확정하지 않는다).
   */
  outcome: 'applied' | 'stale_lookup';
}

/**
 * 사용자 원격 재확인(docs/04 "기존 결과 조회만"): 확인 중·결과 불명·원격 처리 중 작업만. 어댑터 reconcile(읽기)만 부르고 절대 submit 하지 않는다.
 * 찾으면 CONFIRMED + publications(모의 = MOCK), 못 찾으면 상태 그대로(재확인 기록만).
 * T11 missed case: 조회는 잠금 밖에서 하므로, 적용 직전 잠금 안에서 작업의 attempt·state 가 조회 때와 같은지 다시 본다 — 다르면 stale_lookup(적용 없음).
 */
export async function reconcileItem(
  db: Db,
  registry: ChannelAdapterRegistry,
  ownerId: string,
  itemId: string,
  opts: { now?: Date; timeoutMs?: number; credentials?: JobRunOptions['credentials'] } = {},
): Promise<ReconcileOutcome> {
  if (!isUuid(itemId)) throw new NotFoundError(ITEM_NOT_FOUND);
  const item = await itemRow(db, ownerId, itemId);
  if (!item) throw new NotFoundError(ITEM_NOT_FOUND);
  const job = await latestJobForItem(db, ownerId, item.id, false);
  if (!job || !(RECONCILABLE_JOB_STATES as readonly string[]).includes(job.state)) throw new NothingToReconcileError();
  const { r, caps } = await remoteCheck(db, registry, job, item, opts.timeoutMs ?? 30_000, { workerId: 'user-reconcile', tryCancel: false, credentials: opts.credentials });
  const now = opts.now ?? new Date();
  const { state, outcome } = await db.transaction(async (tx) => {
    const it = await lockItem(tx, ownerId, item.id);
    const locked = await jobForUpdate(tx, ownerId, job.id);
    if (!locked) return { state: job.state, outcome: 'stale_lookup' as const };
    if (locked.attempt !== job.attempt || locked.state !== job.state || !(RECONCILABLE_JOB_STATES as readonly string[]).includes(locked.state)) {
      return { state: locked.state, outcome: 'stale_lookup' as const };
    }
    return { state: await applyReconcile(tx, locked, it, r, caps, null, now, { manual: true }), outcome: 'applied' as const };
  });
  await recordAudit(db, {
    ownerId,
    action: 'item.reconcile',
    entity: 'distribution_item',
    entityId: item.id,
    details: { job_id: job.id, from: job.state, to: state, remote: r.status, outcome },
    at: now,
  });
  return { item_id: item.id, job_id: job.id, state_before: job.state, state, found: outcome === 'applied' && r.status === 'found', remote: r.status, outcome };
}

// ---- 사용자 동작: 보류 항목 재시도(T12 D19) ----

export interface RetryOutcome {
  item_id: string;
  job_id: string;
  state: 'QUEUED';
  attempt_next: number;
  message: string;
}

/**
 * 보류(BLOCKED) 항목 재시도 — 명시적 사용자 동작(감사 기록). 같은 작업을 BLOCKED → QUEUED(unblock)로 되돌린다: 다음 lease 가 새 시도
 * (attempt + 1) = 새 전송 의도. 조건(한 트랜잭션, 항목·승인·작업 잠금):
 * - 항목·최근 작업이 모두 BLOCKED(보내지 않았음이 확실한 보류: 401 거절·실행 모드·계정). 작업이 없는 보류(복원된 진행 중 항목)는 409 not_retryable —
 *   원격 결과를 모르므로 맹목 재전송 금지.
 * - 최근 전송 의도가 결과 불명(pending·ambiguous)이면 409 outcome_unknown(재확인 먼저). FIX-LIVEP2 예외: 조회가 남은 단계 미게시를 증명(resume)한 뒤
 *   전송 의도 없이 중지·일일 상한·연결 정보로 막힌 작업(resumeProvenRetryable)은 재시도할 수 있다(unblock 이력에 unresolved_intent_cleared_by).
 * - FIX-LIVEP2(D36): 첫 전송 전(attempt 0) 예약이 60분 넘게 지났고 그 예약에 대한 확인이 아직 없으면 대기열에 넣지 않고 바로 schedule_stale 로 보류하고
 *   409 schedule_stale — 다음 재시도가 기존 D36 확인이다(첫 재시도가 tick 에서야 막히는 헛된 한 바퀴 없음).
 * - 활성 승인 hash = 항목 hash(아니면 409 approval_required — 승인 없음 보류는 항목이 PLANNED 로 돌아가 있으므로 다시 승인 후 실행).
 * - 스냅샷 재검사(예약 시각 경과 제외 — 사용자가 지금 다시 보내기로 한 것) 문제 있으면 409 snapshot_stale(아무것도 바꾸지 않음).
 * - 시도 한도(attempt >= max_attempts) 409 attempts_exhausted.
 * worker 는 보내기 직전에 승인·스냅샷을 다시 검사한다(beginSend) — 이 검사는 사용자에게 바로 알려 주기 위한 것이다.
 */
export async function retryItem(db: Db, ownerId: string, itemId: string, now: Date = new Date()): Promise<RetryOutcome> {
  if (!isUuid(itemId)) throw new NotFoundError(ITEM_NOT_FOUND);
  const r = await retryItemTx(db, ownerId, itemId, now);
  // FIX-LIVEP2(D36): schedule_stale 보류는 커밋한 뒤 거절로 알린다(다음 재시도가 확인이 되도록 보류 이력은 남아야 한다).
  if ('staleBlocked' in r) throw new NotRetryableError('schedule_stale', SCHEDULE_STALE_RETRY_MESSAGE, { item_id: itemId, late_minutes: r.lateMinutes });
  return r;
}

async function retryItemTx(db: Db, ownerId: string, itemId: string, now: Date): Promise<RetryOutcome | { staleBlocked: true; lateMinutes: number }> {
  return db.transaction(async (tx) => {
    await shareLockItemAccount(tx, ownerId, itemId);
    const item = await lockItem(tx, ownerId, itemId);
    // FIX-T11: 복원한 작업(읽기 전용 이력)은 다시 보내지 않는다 — 항목 표시가 없어도(복원 전부터 BLOCKED 였던 항목) 작업 표시로 거부.
    const restoredJob = await latestJobForItem(tx, ownerId, item.id, false);
    // FIX5-FULLREV(T2, 사용자 결정 2026-10-23): 거절 문구의 복구 길은 무조건 "새 배포 계획을 만드세요"가 아니라 채널에서 직접 확인해 게시물이 없을 때만
    // (USER_CONFIRM_RESTORED_MESSAGE 와 같은 조건 — @cs/domain RESTORED_RETRY_RECOVERY). 코드는 그대로.
    // FIX5-FULLREV(T2 후속 — 리뷰 확정 :1857): 문구는 항목 계정 kind 로 고른다(FX4 cancelItem 과 같은 규칙). 모의 = 실제 채널로 보낸 것 없음 — 채널 확인·두 번 게시
    // 경고 없이 *_MOCK_MESSAGE + details mock: true(폼 경로가 같은 모의 화면 문구를 고름). 실제·계정 kind 를 모름(계정 없음)은 조건부 문구, details 그대로.
    // 계정 조회는 복원 이력이 있을 때만 한다.
    const restoredMock =
      (restoredJob?.restoredNeedsReview || item.restoredNeedsReview) && (await accountOf(tx, ownerId, item.channelAccountId))?.kind === 'mock';
    const restoredMockDetail = restoredMock ? { mock: true } : {};
    if (restoredJob?.restoredNeedsReview && !item.restoredNeedsReview) {
      throw new NotRetryableError('not_retryable', restoredMock ? RESTORED_JOB_RETRY_MOCK_MESSAGE : RESTORED_JOB_RETRY_MESSAGE, {
        status: item.status,
        restored: true,
        ...restoredMockDetail,
      });
    }
    // FIX-T10(P0): 복원 때 진행 중이던 항목(restored_needs_review)은 원격 결과를 모르므로 재시도(재전송)하지 않는다 — 결과 불명이면 outcome_unknown.
    if (item.restoredNeedsReview) {
      throw item.status === 'UNKNOWN'
        ? // FIX2-CODEX(U4): 모의 계정은 모의 문구 + mock: true(실제 채널로 보낸 것 없음 — 원격 확인을 시키지 않음, 옆 not_retryable 모의 분기와 같은 규칙).
          // 실제 계정·계정 kind 를 모름은 지금 문구·details 그대로. 코드는 그대로(outcome_unknown · restored: true).
          new NotRetryableError(
            'outcome_unknown',
            restoredMock ? RESTORED_UNKNOWN_RETRY_MOCK_MESSAGE : '복원 전 전송 결과를 알 수 없어 다시 보내지 않습니다. 원격에서 결과를 확인하세요.',
            { status: item.status, restored: true, ...restoredMockDetail },
          )
        : // FIX5-FULLREV(T2): 조건부 복구 길 · (T2 후속) 모의 계정은 모의 문구 + mock: true
          new NotRetryableError('not_retryable', restoredMock ? RESTORED_ITEM_RETRY_MOCK_MESSAGE : RESTORED_ITEM_RETRY_MESSAGE, {
            status: item.status,
            restored: true,
            ...restoredMockDetail,
          });
    }
    const active = await activeApprovalsFor(tx, ownerId, [item.id]);
    const job = await latestJobForItem(tx, ownerId, item.id, true);
    if (item.status === 'PLANNED' && job?.state === 'BLOCKED') {
      throw new NotRetryableError('approval_required', '승인 없음 — 다시 승인한 뒤 실행하세요(새 실행 키로 이 항목만 대기열에 들어갑니다)');
    }
    if (!job || item.status !== 'BLOCKED' || job.state !== 'BLOCKED') {
      throw new NotRetryableError('not_retryable', '보류(BLOCKED)된 작업이 있는 항목만 재시도할 수 있습니다', { status: item.status, job_state: job?.state ?? null });
    }
    const last = job.attempt > 0 ? await intentFor(tx, ownerId, job.id, job.attempt) : null;
    let unresolvedClearedBy: 'reconcile_resume' | null = null;
    if (last && (last.outcome === 'pending' || last.outcome === 'ambiguous')) {
      // FIX-LIVEP2(리뷰 확정 jobs.ts:1543 · Codex Q3): 마지막 의도가 결과 불명이어도, 조회가 남은 원격 단계가 게시되지 않았음을 증명(resume — 자동 이어 보내기와
      // 같은 근거)했고 그 뒤 전송 의도 없이 중지·일일 상한·연결 정보로 보류된 작업이면 다시 보낼 수 있다(막다른 길 해소). 재시도는 여전히 beginSend 의
      // 중지·상한·승인·스냅샷 재검사를 거치고, 어댑터는 기록된 컨테이너로 남은 게시만 한다(게시 시도 표식이 있으면 다시 게시하지 않음).
      // 증명이 없으면(결과가 정말 불명) 지금처럼 거부한다. 방어선: 결과 기록 없는 게시 시도 표식이 있으면 증명이 있어도 거부.
      const evs = await tx
        .select({ eventSeq: jobEvents.eventSeq, details: jobEvents.sanitizedDetails })
        .from(jobEvents)
        .where(and(eq(jobEvents.ownerId, ownerId), eq(jobEvents.jobId, job.id)))
        .orderBy(asc(jobEvents.eventSeq));
      const unresolvedAttempts =
        (await publishedStepCount(tx, ownerId, job.id, ['publish_attempt'])) - (await publishedStepCount(tx, ownerId, job.id, ['publish']));
      if (!resumeProvenRetryable(evs, job.attempt) || unresolvedAttempts > 0) {
        throw new NotRetryableError('outcome_unknown', '마지막 전송 결과를 알 수 없어 다시 보내지 않습니다. 재확인을 먼저 하세요.');
      }
      unresolvedClearedBy = 'reconcile_resume';
    }
    const approval = active.get(item.id);
    if (!approval || approval.payloadHash !== item.payloadHash) {
      throw new NotRetryableError('approval_required', '유효한 승인이 없어 재시도하지 않았습니다(다시 승인하거나 새 계획을 만드세요)');
    }
    if (countedAttempts(job) >= job.maxAttempts) {
      throw new NotRetryableError('attempts_exhausted', `시도 한도(${job.maxAttempts}회)에 이르렀습니다. 새 배포 계획을 만드세요.`);
    }
    const problems = (await snapshotProblems(tx, ownerId, item, now)).filter((p) => p !== 'schedule_passed');
    if (problems.length) throw new SnapshotStaleError([{ item_id: item.id, reasons: problems }]);
    // T13: 연결 정보가 아직 쓸 수 없으면(만료·해제·다시 연결 필요) 다시 대기열에 넣지 않는다 — 먼저 다시 연결.
    const cred = (await credentialGate(tx, ownerId, [item.channelAccountId], now)).get(item.channelAccountId);
    if (cred && !cred.usable) throw new AccountCredentialBlockedError([{ item_id: item.id, account_id: item.channelAccountId, status: cred.status }]);
    // FIX-LIVEP2(D36 · 리뷰 확정 jobs.ts:730): 첫 전송 전(attempt 0) 다른 사유(일일 상한·즉시 중지 등)로 보류된 예약 항목인데 지금 예약이 60분 넘게 지났고 그 예약에 대한
    // 확인도 없으면, beginSend 가 어차피 schedule_stale 로 막는다 — 대기열에 넣었다가 tick 에서야 막히는 헛된 한 바퀴 대신 지금 같은 판정으로 보류하고 바로 알린다.
    // 보류 이력(blocked schedule_stale)이 남으므로 다음 재시도가 기존 D36 확인(stale_schedule_confirmed)이 된다. 60분 기준·확인 규칙은 그대로.
    if (
      job.attempt === 0 &&
      job.lastErrorCode !== 'schedule_stale' &&
      isScheduleStale(item.scheduledAtUtc, now) &&
      !(await staleScheduleConfirmed(tx, ownerId, job, { approvalId: approval.id, payloadHash: item.payloadHash, scheduledAtUtc: item.scheduledAtUtc! }))
    ) {
      const lateMinutes = Math.floor((now.getTime() - item.scheduledAtUtc!.getTime()) / 60_000);
      const queued = await settle(tx, ownerId, job, item, 'unblock', { cause: 'user_retry', previous_error: job.lastErrorCode, approval_id: approval.id, outcome: 'schedule_stale' }, now, {
        ...CLEAR_LEASE,
        lastErrorCode: null,
        lastRetryClass: null,
        reconcileCount: 0,
      });
      await settle(tx, ownerId, { id: job.id, state: queued }, item, 'blocked', { reason: 'schedule_stale', not_sent: true, late_minutes: lateMinutes, cause: 'retry_precheck' }, now, {
        ...CLEAR_LEASE,
        lastErrorCode: 'schedule_stale',
      });
      await recordAudit(tx, {
        ownerId,
        action: 'item.retry',
        entity: 'distribution_item',
        entityId: item.id,
        details: { job_id: job.id, previous_error: job.lastErrorCode, result: 'schedule_stale', late_minutes: lateMinutes },
        at: now,
      });
      return { staleBlocked: true as const, lateMinutes };
    }
    // FIX1-T21P2(Codex P1 :623): 오래 지난 예약(schedule_stale)으로 막힌 작업의 재시도 = 그 예약을 지금 보내겠다는 명시적 확인. 승인 ID·내용 hash·예약 시각을
    // 함께 기록한다 — 보내기 직전(beginSend) 이 값이 지금과 모두 같을 때만 통과(승인·내용·예약이 바뀌면 확인은 효력이 없다). 다른 사유 재시도는 확인이 아니다.
    const staleConfirm =
      job.lastErrorCode === 'schedule_stale'
        ? { stale_schedule_confirmed: true, confirmed_payload_hash: item.payloadHash, confirmed_scheduled_at_utc: item.scheduledAtUtc ? item.scheduledAtUtc.toISOString() : null }
        : {};
    const cleared: Record<string, string> = unresolvedClearedBy ? { unresolved_intent_cleared_by: unresolvedClearedBy } : {};
    await settle(tx, ownerId, job, item, 'unblock', { cause: 'user_retry', previous_error: job.lastErrorCode, approval_id: approval.id, ...staleConfirm, ...cleared }, now, {
      ...CLEAR_LEASE,
      nextRunAt: now,
      lastErrorCode: null,
      lastRetryClass: null,
      reconcileCount: 0,
    });
    const live = (await accountOf(tx, ownerId, item.channelAccountId))?.kind === 'live';
    await recordAudit(tx, {
      ownerId,
      action: 'item.retry',
      entity: 'distribution_item',
      entityId: item.id,
      details: {
        job_id: job.id,
        previous_error: job.lastErrorCode,
        attempt_next: job.attempt + 1,
        mode: live ? 'LIVE' : 'MOCK',
        ...(job.lastErrorCode === 'schedule_stale' ? { stale_schedule_confirmed: true } : {}),
        ...cleared,
      },
      at: now,
    });
    return {
      item_id: item.id,
      job_id: job.id,
      state: 'QUEUED' as const,
      attempt_next: job.attempt + 1,
      // LIVE-P1: 실제 계정 재시도도 이미 게시 시도한 컨테이너는 다시 게시하지 않는다(어댑터 규칙) — 결과 불명이면 조회만.
      message: live ? '다시 대기열에 넣었습니다(실제 게시 — 새 시도. 이미 게시를 시도한 글은 다시 게시하지 않고 확인만 합니다)' : '다시 대기열에 넣었습니다(MOCK — 새 시도·새 전송 의도)',
    };
  });
}

// ---- 조회 ----

export async function getJobRow(db: DbOrTx, ownerId: string, jobId: string): Promise<JobRow | null> {
  if (!isUuid(jobId)) return null;
  const rows = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listJobEvents(db: DbOrTx, ownerId: string, jobId: string, limit = 50) {
  return db
    .select()
    .from(jobEvents)
    .where(and(eq(jobEvents.ownerId, ownerId), eq(jobEvents.jobId, jobId)))
    .orderBy(desc(jobEvents.eventSeq))
    .limit(Math.min(Math.max(limit, 1), 200));
}

export async function listIntents(db: DbOrTx, ownerId: string, jobIds: readonly string[]): Promise<SendIntentRow[]> {
  if (jobIds.length === 0) return [];
  return db
    .select()
    .from(sendIntents)
    .where(and(eq(sendIntents.ownerId, ownerId), inArray(sendIntents.jobId, [...jobIds])))
    .orderBy(asc(sendIntents.jobId), asc(sendIntents.attempt));
}

export async function listPublications(db: DbOrTx, ownerId: string, itemIds: readonly string[]): Promise<PublicationRow[]> {
  if (itemIds.length === 0) return [];
  return db
    .select()
    .from(publications)
    .where(and(eq(publications.ownerId, ownerId), inArray(publications.itemId, [...itemIds])))
    .orderBy(asc(publications.createdAt), asc(publications.id));
}

export function jobEventView(e: typeof jobEvents.$inferSelect) {
  return { seq: e.eventSeq, state_before: e.stateBefore, state_after: e.stateAfter, at: e.at.toISOString(), details: e.sanitizedDetails };
}

export function intentView(i: SendIntentRow) {
  return {
    attempt: i.attempt,
    intent_key: i.intentKey,
    created_at: i.createdAt.toISOString(),
    submitted_at: i.submittedAt ? i.submittedAt.toISOString() : null,
    outcome: i.outcome,
    provider_request_id: i.providerRequestId,
    remote_external_id: i.remoteExternalId,
  };
}

export const MOCK_PUBLICATION_NOTICE = '실제 발행 실적 아님';
export const publicationView = publicationViewOf;

async function accountKindOfItem(db: DbOrTx, ownerId: string, itemId: string): Promise<string | null> {
  const rows = await db
    .select({ kind: channelAccounts.kind })
    .from(distributionItems)
    .innerJoin(channelAccounts, and(eq(channelAccounts.id, distributionItems.channelAccountId), eq(channelAccounts.ownerId, distributionItems.ownerId)))
    .where(and(eq(distributionItems.id, itemId), eq(distributionItems.ownerId, ownerId)))
    .limit(1);
  return rows[0]?.kind ?? null;
}

/** GET /api/jobs/{id}: 비밀·본문 없는 작업 상태 + 이력(최근 50) + 전송 의도 + 원격 결과. */
export async function getJobDetail(db: DbOrTx, ownerId: string, jobId: string) {
  const job = await getJobRow(db, ownerId, jobId);
  if (!job) return null;
  const [events, intents, pubs] = await Promise.all([
    listJobEvents(db, ownerId, job.id, 50),
    listIntents(db, ownerId, [job.id]),
    db
      .select()
      .from(publications)
      .where(and(eq(publications.ownerId, ownerId), eq(publications.jobId, job.id)))
      .orderBy(asc(publications.createdAt)),
  ]);
  return {
    // LIVEP1-DIAG: 항목 계정이 실제 계정이면 mode LIVE(표시용)
    job: jobView(job, job.itemId ? await accountKindOfItem(db, ownerId, job.itemId) : null),
    events: events.map(jobEventView),
    intents: intents.map(intentView),
    publications: pubs.map(publicationView),
  };
}

/**
 * 배포 작업 상태별 개수(owner 범위, 개수만 — ID·내용 없음). D30-3: 공개 /api/health 에서 빼고 GET /api/ops/summary 로 옮겼다.
 * 확인 필요 계획 수는 summary 의 attention_plans(owner 범위)로 따로 낸다.
 */
export async function jobStateCounts(db: DbOrTx, ownerId: string) {
  const rows = await db
    .select({ state: jobs.state, n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(eq(jobs.ownerId, ownerId))
    .groupBy(jobs.state);
  const by = new Map(rows.map((r) => [r.state, Number(r.n)]));
  return {
    queued: by.get('QUEUED') ?? 0,
    leased: (by.get('LEASED') ?? 0) + (by.get('SENDING') ?? 0),
    retry_wait: by.get('RETRY_WAIT') ?? 0,
    reconciling: (by.get('RECONCILING') ?? 0) + (by.get('REMOTE_PROCESSING') ?? 0) + (by.get('CANCEL_REQUESTED') ?? 0),
    unknown: by.get('UNKNOWN') ?? 0,
    blocked: by.get('BLOCKED') ?? 0,
  };
}
