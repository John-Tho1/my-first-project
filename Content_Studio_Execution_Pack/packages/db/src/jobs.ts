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
  AppError,
  assertExecutionAllowed,
  CANCEL_PENDING_MESSAGE,
  CHECK_LEASE_STATES,
  classifyOutcome,
  decideRetry,
  DEFAULT_LEASE_TTL_MS,
  isUuid,
  LEASE_HELD_STATES,
  LeaseLostError,
  NotCancellableError,
  NotFoundError,
  NothingToReconcileError,
  NotRetryableError,
  SnapshotStaleError,
  RECONCILE_BASE_MS,
  RECONCILE_MAX_ATTEMPTS,
  reconcileDelay,
  REMOTE_POLL_MAX,
  REMOTE_POLL_MS,
  SEND_LEASE_STATES,
  type AdapterContext,
  type AdapterResult,
  type AppConfig,
  type CancelResult,
  type ChannelAdapter,
  type ChannelAdapterRegistry,
  type JobEvent,
  type JobState,
  type MockScenarioSetting,
  type PublishSnapshot,
  type ReconcileResult,
  type RemoteReference,
} from '@cs/domain';
import {
  activeApprovalsFor,
  lockItemsInOrder,
  recomputePlanStatus,
  requestCancelLocked,
  revokeActiveApprovalsLocked,
  settleApprovedVariants,
  syncItemStatus,
  transitionJob,
  type DistributionItemRow,
  type JobRow,
} from './approval-invalidation';
import type { Db } from './client';
import { invalidationReasonOf, jobView, publicationViewOf, snapshotProblems } from './distribution';
import { mockScenarioFor } from './mock-scenarios';
import { recordAudit, type DbOrTx } from './queries';
import { channelAccounts, distributionItems, distributionPlans, jobEvents, jobs, publications, sendIntents, variants } from './schema';

export type SendIntentRow = typeof sendIntents.$inferSelect;
export type PublicationRow = typeof publications.$inferSelect;

const ITEM_NOT_FOUND = '배포 항목을 찾을 수 없습니다';

export interface JobRunOptions {
  /** lease 소유자 표시(호스트 이름을 넣지 않는다 — 예: 'cli-1a2b3c4d') */
  workerId: string;
  config: Pick<AppConfig, 'PUBLISH_MODE'>;
  /** 시계(테스트 주입). 기본 new Date() */
  clock?: () => Date;
  leaseTtlMs?: number;
  submitTimeoutMs?: number;
  /** jitter 난수(테스트 주입) */
  random?: () => number;
  /** 한 owner 의 작업만(POST /api/worker/tick) */
  ownerId?: string;
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
  return { id: a.id, kind: a.kind === 'mock' ? ('mock' as const) : ('live' as const), platform: a.platform, external_account_id: a.externalAccountId };
}

async function lockItem(tx: DbOrTx, ownerId: string, itemId: string): Promise<DistributionItemRow> {
  const [item] = await lockItemsInOrder(tx, ownerId, [itemId]);
  if (!item) throw new NotFoundError(ITEM_NOT_FOUND);
  return item;
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

/** 원격 결과 기록(추가 전용). 모의 어댑터 결과는 is_mock=true·verification=MOCK — 실제 발행 실적이 아니다(DB CHECK 로도 강제). */
async function insertPublication(
  tx: DbOrTx,
  ownerId: string,
  item: DistributionItemRow,
  jobId: string,
  isMock: boolean,
  r: Pick<AdapterResult, 'external_id' | 'permalink' | 'result_kind' | 'remote_visibility'>,
  now: Date,
): Promise<string | null> {
  if (!r.external_id) return null;
  if (isMock && !r.external_id.startsWith('mock:')) throw new AppError('conflict', 'mock_id_invalid', '모의 결과의 외부 ID 는 mock: 로 시작해야 합니다');
  const visibility = r.remote_visibility ?? 'unknown';
  const kind = r.result_kind ?? (visibility === 'private' ? 'UPLOADED_PRIVATE' : 'PUBLISHED');
  const rows = await tx
    .insert(publications)
    .values({
      ownerId,
      itemId: item.id,
      jobId,
      externalId: r.external_id,
      permalink: r.permalink ?? null,
      resultKind: kind,
      remoteVisibility: visibility,
      verification: isMock ? 'MOCK' : 'UNVERIFIED',
      isMock,
      verifiedAt: null,
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
  r: { provider_request_id?: string; external_id?: string; error_code?: string; status?: string; retry_class?: string },
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
      sanitizedDetails: { source, status: r.status ?? null, error_code: r.error_code ?? null, retry_class: r.retry_class ?? null },
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
          // 보내기 전에 되풀이해 죽는 작업(처리 오류 등)이 끝없이 다시 lease 되지 않게 시도 한도에서 멈춘다.
          // FIX-T11(P1): 시작 전 만료는 시도가 아니다 — attempt 를 lease 전 값으로 되돌리고, 끝없는 재lease 는 만료 횟수(이벤트)로 막는다.
          const expiries = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(jobEvents)
            .where(and(eq(jobEvents.jobId, job.id), sql`${jobEvents.sanitizedDetails}->>'transition' = 'lease_expired_before_intent'`));
          if (job.attempt >= job.maxAttempts || (expiries[0]?.n ?? 0) + 1 >= job.maxAttempts) {
            await settle(tx, e.ownerId, job, item, 'permanent_failure', { ...base, reason: 'lease_expired_max_attempts', not_sent: true }, now, {
              ...CLEAR_LEASE,
              lastErrorCode: 'lease_expired_max_attempts',
            });
            return true;
          }
          await settle(tx, e.ownerId, job, item, 'lease_expired_before_intent', { ...base, attempt_restored: job.attempt - 1 }, now, {
            ...CLEAR_LEASE,
            nextRunAt: now,
            attempt: Math.max(job.attempt - 1, 0),
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
          if (!intent) {
            await settle(tx, e.ownerId, job, item, 'canceled', { ...base, not_sent: true, cause: 'lease_expired' }, now);
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
 * - QUEUED·RETRY_WAIT → LEASED(attempt + 1, 전송 시도)
 * - RECONCILING·REMOTE_PROCESSING·CANCEL_REQUESTED(lease 없음·만료) → 상태 그대로 lease 만(원격 조회). UNKNOWN 은 고르지 않는다.
 */
export async function leaseJobs(
  db: Db,
  opts: { workerId: string; now: Date; limit: number; leaseTtlMs?: number; ownerId?: string; excludeIds?: readonly string[] },
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
        await transitionJob(tx, c.ownerId, c, 'lease', { worker: workerId, attempt: c.attempt + 1 }, now, {
          leaseOwner: workerId,
          leaseUntil: until,
          heartbeatAt: now,
          attempt: c.attempt + 1,
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
  opts: JobRunOptions,
  signal: AbortSignal,
  mockScenario: MockScenarioSetting | null = null,
  onLeaseLost?: () => void,
): AdapterContext {
  const clock = opts.clock ?? (() => new Date());
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
  };
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
}

/** 1단계(한 트랜잭션): 재검사 + SENDING + 전송 의도. 보낼 수 없으면 상태를 정하고 null. */
async function beginSend(db: Db, registry: ChannelAdapterRegistry, leased: JobRow, opts: JobRunOptions, now: Date): Promise<SendPlan | JobState | 'lease_lost'> {
  const ownerId = leased.ownerId;
  return db.transaction(async (tx) => {
    const item = await lockItem(tx, ownerId, leased.itemId!);
    const active = await activeApprovalsFor(tx, ownerId, [item.id]);
    const job = await jobForUpdate(tx, ownerId, leased.id);
    if (!job || job.leaseOwner !== opts.workerId || job.attempt !== leased.attempt) return 'lease_lost' as const;
    // FIX-T11(P1): lease 가 이미 만료됐으면(시작 전에 오래 기다림) 아무것도 쓰지 않는다 — 만료 복구가 attempt 를 되돌리고 다시 대기시킨다.
    if (!job.leaseUntil || job.leaseUntil.getTime() <= now.getTime()) return 'lease_lost' as const;
    // 취소 요청(lease 뒤, 보내기 전) → 보내지 않고 CANCELED.
    if (job.state === 'CANCEL_REQUESTED' || job.cancelRequestedAt) {
      if (job.state !== 'LEASED' && job.state !== 'CANCEL_REQUESTED') return 'lease_lost' as const;
      return settle(tx, ownerId, job, item, 'canceled', { not_sent: true, attempt: job.attempt }, now);
    }
    if (job.state !== 'LEASED') return 'lease_lost' as const;
    const approval = active.get(item.id);
    if (!approval || approval.payloadHash !== item.payloadHash) {
      // A10: 승인이 없거나 바뀌었으면 다음 외부 전송을 막는다. 아직 보내지 않았으므로 항목은 PLANNED(다시 승인 가능, T10 과 같은 규칙).
      return settle(tx, ownerId, job, item, 'blocked', { reason: 'approval_missing', attempt: job.attempt }, now, { ...CLEAR_LEASE, lastErrorCode: 'approval_missing' }, 'PLANNED');
    }
    // 예약 시각 경과는 예약 작업이 실행될 때 당연하므로 제외한다.
    const problems = (await snapshotProblems(tx, ownerId, item, now)).filter((p) => p !== 'schedule_passed');
    if (problems.length) {
      const reason = invalidationReasonOf(problems);
      await revokeActiveApprovalsLocked(tx, ownerId, [item], () => `invalidated:${reason}`, now, { action: 'approval.invalidate' });
      await settleApprovedVariants(tx, ownerId, [item.variantId], reason === 'account_changed' ? 'review' : 'draft', now);
      return settle(
        tx,
        ownerId,
        job,
        item,
        'blocked',
        { reason: 'snapshot_stale', problems: problems.slice(0, 8), attempt: job.attempt },
        now,
        { ...CLEAR_LEASE, lastErrorCode: 'snapshot_stale' },
        'PLANNED',
      );
    }
    const acc = await accountOf(tx, ownerId, item.channelAccountId);
    if (!acc) return settle(tx, ownerId, job, item, 'blocked', { reason: 'account_missing' }, now, { ...CLEAR_LEASE, lastErrorCode: 'account_missing' });
    let mode: 'MOCK';
    let adapter: ChannelAdapter;
    try {
      mode = assertExecutionAllowed(opts.config as AppConfig, {
        accountKind: acc.kind === 'mock' ? 'mock' : 'live',
        payloadHash: item.payloadHash,
        approval: { id: approval.id, payloadHash: approval.payloadHash, revokedAt: approval.revokedAt },
      }).mode;
      adapter = registry.getAdapterFor(adapterAccount(acc));
    } catch (e) {
      const code = e instanceof Error && 'code' in e ? String((e as { code: unknown }).code).toLowerCase() : 'execution_not_allowed';
      return settle(tx, ownerId, job, item, 'blocked', { reason: 'execution_not_allowed', code }, now, { ...CLEAR_LEASE, lastErrorCode: code });
    }
    const vRows = await tx
      .select({ channel: variants.channel })
      .from(variants)
      .where(and(eq(variants.id, item.variantId), eq(variants.ownerId, ownerId)))
      .limit(1);
    const snapshot: PublishSnapshot = {
      item_id: item.id,
      channel: vRows[0]?.channel ?? acc.platform,
      account: adapterAccount(acc),
      payload: item.payloadJson,
      payload_hash: item.payloadHash,
      visibility: item.visibility,
      requested_result: item.requestedResult,
      scheduled_at_utc: item.scheduledAtUtc ? item.scheduledAtUtc.toISOString() : null,
    };
    const valid = adapter.validate(snapshot);
    if (!valid.ok) {
      return settle(tx, ownerId, job, item, 'permanent_failure', { reason: 'validate_failed', error_code: valid.error_code }, now, {
        ...CLEAR_LEASE,
        lastErrorCode: valid.error_code,
        lastRetryClass: 'permanent',
      });
    }
    const intentKey = `${job.id}:${job.attempt}`;
    const mockScenario = acc.kind === 'mock' ? await mockScenarioFor(tx, ownerId, item.id) : null;
    await transitionJob(tx, ownerId, job, 'send_start', { attempt: job.attempt, intent_key: intentKey, mode, approval_id: approval.id }, now);
    await syncItemStatus(tx, ownerId, item.id, 'SENDING', now);
    await tx.insert(sendIntents).values({
      ownerId,
      jobId: job.id,
      attempt: job.attempt,
      intentKey,
      createdAt: now,
      outcome: 'pending',
      sanitizedDetails: { mode, approval_id: approval.id, adapter: adapter.kind },
    });
    await recomputePlanStatus(tx, ownerId, item.planId, now);
    return { adapter, snapshot, intentKey, job: { ...job, state: 'SENDING' }, mockScenario } satisfies SendPlan;
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
    };
    const common = { ...CLEAR_LEASE, lastErrorCode: result.error_code ?? null, lastRetryClass: cls.retryClass };
    const isMock = plan.adapter.kind === 'mock';
    switch (cls.event) {
      case 'confirmed': {
        const to = await settle(tx, ownerId, job, item, cancel ? 'cancel_too_late' : 'confirmed', { ...base, result_kind: result.result_kind ?? null }, now, common);
        await insertPublication(tx, ownerId, item, job.id, isMock, result, now);
        return to;
      }
      case 'remote_accepted':
        if (cancel) return settle(tx, ownerId, job, item, 'reconcile_retry', { ...base, remote: 'processing' }, now, { ...common, nextRunAt: addMs(now, REMOTE_POLL_MS) });
        return settle(tx, ownerId, job, item, 'remote_accepted', base, now, { ...common, nextRunAt: addMs(now, REMOTE_POLL_MS), reconcileCount: 0 });
      case 'transient_failure': {
        if (cancel) return settle(tx, ownerId, job, item, 'canceled', { ...base, not_sent: true }, now, common);
        const d = decideRetry(job.attempt, job.maxAttempts, result.retry_after_sec, now, random);
        if (d.retry) return settle(tx, ownerId, job, item, 'transient_failure', { ...base, next_run_at: d.nextRunAt.toISOString() }, now, { ...common, nextRunAt: d.nextRunAt });
        return settle(tx, ownerId, job, item, 'permanent_failure', { ...base, reason: d.reason }, now, common);
      }
      case 'permanent_failure':
        if (cancel) return settle(tx, ownerId, job, item, 'canceled', { ...base, not_sent: true }, now, common);
        return settle(tx, ownerId, job, item, 'permanent_failure', base, now, common);
      case 'blocked':
        if (cancel) return settle(tx, ownerId, job, item, 'canceled', { ...base, not_sent: true }, now, common);
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
  const timeoutMs = opts.submitTimeoutMs ?? 30_000;
  const r = await withTimeout(timeoutMs, async (timeoutSignal) => {
    // FIX-T11(P0): 시간 초과 또는 lease 상실(heartbeat 실패) 중 먼저 온 것으로 중단한다.
    const lease = new AbortController();
    const signal = AbortSignal.any([timeoutSignal, lease.signal]);
    const ctx = makeContext(db, begun.job, begun.intentKey, opts, signal, begun.mockScenario, () => lease.abort());
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
  return finishSend(db, begun, result, opts, clock());
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
  const base = { attempt: job.attempt, reconcile: r.status, error_code: r.error_code ?? null, manual: opts.manual || undefined };
  const common = { ...CLEAR_LEASE };
  if (cancelResult?.status === 'canceled' && job.state === 'CANCEL_REQUESTED') {
    return settle(tx, ownerId, job, item, 'canceled', { ...base, remote_canceled: true }, now, common);
  }
  if (r.status === 'found') {
    await fillIntent(tx, ownerId, intent, 'accepted', r, now, 'reconcile');
    const event: JobEvent = job.state === 'CANCEL_REQUESTED' ? 'cancel_too_late' : 'reconciled_found';
    const to = await settle(tx, ownerId, job, item, event, { ...base, external_id: r.external_id ?? null, result_kind: r.result_kind ?? null }, now, common);
    await insertPublication(tx, ownerId, item, job.id, caps.mock, r, now);
    return to;
  }
  if (opts.manual) {
    // 사용자 재확인은 조회만: 찾지 못하면 상태를 바꾸지 않는다(재전송 없음).
    return settle(tx, ownerId, job, item, 'reconcile_retry', base, now, {});
  }
  const count = job.reconcileCount + 1;
  if (r.status === 'processing') {
    if (count >= REMOTE_POLL_MAX) return settle(tx, ownerId, job, item, 'reconcile_unsupported', { ...base, polls: count }, now, common);
    const next = { ...common, nextRunAt: addMs(now, REMOTE_POLL_MS), reconcileCount: count };
    if (job.state === 'RECONCILING') return settle(tx, ownerId, job, item, 'remote_accepted', base, now, next);
    if (job.state === 'REMOTE_PROCESSING') return settle(tx, ownerId, job, item, 'remote_processing', base, now, next);
    return settle(tx, ownerId, job, item, 'reconcile_retry', base, now, next);
  }
  if (r.status === 'not_found' && caps.definitive_not_found && job.state !== 'REMOTE_PROCESSING') {
    await fillIntent(tx, ownerId, intent, 'rejected', { error_code: 'not_found_on_remote' }, now, 'reconcile');
    if (job.state === 'CANCEL_REQUESTED') return settle(tx, ownerId, job, item, 'canceled', { ...base, not_sent: true }, now, common);
    // 원격에 확실히 없음 → 다시 보내도 된다(새 시도 = 새 전송 의도). 시도 한도 안에서만.
    const d = decideRetry(job.attempt, job.maxAttempts, null, now, opts.random ?? Math.random);
    if (d.retry) return settle(tx, ownerId, job, item, 'reconciled_not_found', { ...base, next_run_at: d.nextRunAt.toISOString() }, now, { ...common, nextRunAt: d.nextRunAt });
    return settle(tx, ownerId, job, item, 'permanent_failure', { ...base, reason: d.reason }, now, common);
  }
  // 확인 불가(read 권한 없음·판단 불가·확실하지 않은 없음): 한도까지 다시 조회, 넘으면 UNKNOWN(자동 재전송 없음).
  if (count >= RECONCILE_MAX_ATTEMPTS) return settle(tx, ownerId, job, item, 'reconcile_unsupported', { ...base, checks: count }, now, { ...common, reconcileCount: count });
  return settle(tx, ownerId, job, item, 'reconcile_retry', { ...base, checks: count }, now, { ...common, nextRunAt: reconcileDelay(count, now), reconcileCount: count });
}

async function remoteCheck(
  db: DbOrTx,
  registry: ChannelAdapterRegistry,
  job: JobRow,
  item: DistributionItemRow,
  signalMs: number,
  opts: { workerId: string; clock?: () => Date; leaseTtlMs?: number; tryCancel: boolean },
): Promise<{ r: ReconcileResult; caps: { definitive_not_found: boolean; mock: boolean }; cancel: CancelResult | null }> {
  const ownerId = job.ownerId;
  const acc = await accountOf(db, ownerId, item.channelAccountId);
  if (!acc) return { r: { status: 'unknown', error_code: 'account_missing' }, caps: { definitive_not_found: false, mock: false }, cancel: null };
  let adapter: ChannelAdapter;
  try {
    adapter = registry.getAdapterFor(adapterAccount(acc));
  } catch {
    return { r: { status: 'unsupported', error_code: 'adapter_unavailable' }, caps: { definitive_not_found: false, mock: false }, cancel: null };
  }
  const mockScenario = acc.kind === 'mock' ? await mockScenarioFor(db, ownerId, item.id) : null;
  const caps = adapter.capabilities(adapterAccount(acc), { mockScenario });
  const intent = (job.attempt > 0 ? await intentFor(db, ownerId, job.id, job.attempt) : null) ?? (await latestIntent(db, ownerId, job.id));
  if (!intent) return { r: { status: 'not_found', error_code: 'no_intent' }, caps: { definitive_not_found: true, mock: caps.mock }, cancel: null };
  const ref: RemoteReference = {
    platform: acc.platform,
    intent_key: intent.intentKey,
    external_id: intent.remoteExternalId,
    provider_request_id: intent.providerRequestId,
  };
  let cancel: CancelResult | null = null;
  const res = await withTimeout(signalMs, async (signal) => {
    const ctx = makeContext(db as Db, job, intent.intentKey, { ...opts, config: { PUBLISH_MODE: 'disabled' } }, signal, mockScenario);
    if (opts.tryCancel && caps.cancel && ref.external_id) {
      cancel = await adapter.cancel(ref, ctx);
      if (cancel.status === 'canceled') return { status: 'not_found' } satisfies ReconcileResult;
    }
    if (!caps.read) return { status: 'unsupported', error_code: 'read_unsupported' } satisfies ReconcileResult;
    return adapter.reconcile(ref, ctx);
  });
  const r: ReconcileResult = res.ok ? res.value : { status: 'unknown', error_code: res.reason === 'timeout' ? 'reconcile_timeout' : 'adapter_error' };
  return { r, caps: { definitive_not_found: caps.definitive_not_found, mock: caps.mock }, cancel };
}

async function checkJob(db: Db, registry: ChannelAdapterRegistry, leased: JobRow, opts: JobRunOptions): Promise<JobState | 'lease_lost'> {
  const clock = opts.clock ?? (() => new Date());
  const ownerId = leased.ownerId;
  const item = await itemRow(db, ownerId, leased.itemId!);
  if (!item) return 'lease_lost';
  // 취소 요청인데 이번 시도에서 보낸 적이 없으면(lease 뒤 전송 전) 바로 CANCELED.
  if (leased.state === 'CANCEL_REQUESTED' && (leased.attempt === 0 || !(await intentFor(db, ownerId, leased.id, leased.attempt)))) {
    return db.transaction(async (tx) => {
      const it = await lockItem(tx, ownerId, leased.itemId!);
      const job = await jobForUpdate(tx, ownerId, leased.id);
      if (!job || job.leaseOwner !== opts.workerId || job.state !== 'CANCEL_REQUESTED') return 'lease_lost' as const;
      return settle(tx, ownerId, job, it, 'canceled', { not_sent: true, attempt: job.attempt }, clock());
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
    const [j] = await leaseJobs(db, { workerId: opts.workerId, now: clock(), limit: 1, leaseTtlMs: opts.leaseTtlMs, ownerId: opts.ownerId, excludeIds: done });
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
  | { item_id: string; job_id: string; canceled: false; cancel_requested: true; state: 'CANCEL_REQUESTED'; message: string };

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
      case 'BLOCKED':
        await settle(tx, ownerId, job, item, 'canceled', { cause: 'user', not_sent: true }, now, { cancelRequestedAt: now });
        out = { item_id: item.id, job_id: job.id, canceled: true, cancel_requested: false, state: 'CANCELED', message: '취소했습니다(아직 보내지 않은 작업)' };
        break;
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
}

/**
 * 사용자 원격 재확인(docs/04 "기존 결과 조회만"): 확인 중·결과 불명·원격 처리 중 작업만. 어댑터 reconcile(읽기)만 부르고 절대 submit 하지 않는다.
 * 찾으면 CONFIRMED + publications(모의 = MOCK), 못 찾으면 상태 그대로(재확인 기록만).
 */
export async function reconcileItem(
  db: Db,
  registry: ChannelAdapterRegistry,
  ownerId: string,
  itemId: string,
  opts: { now?: Date; timeoutMs?: number } = {},
): Promise<ReconcileOutcome> {
  if (!isUuid(itemId)) throw new NotFoundError(ITEM_NOT_FOUND);
  const item = await itemRow(db, ownerId, itemId);
  if (!item) throw new NotFoundError(ITEM_NOT_FOUND);
  const job = await latestJobForItem(db, ownerId, item.id, false);
  if (!job || !(RECONCILABLE_JOB_STATES as readonly string[]).includes(job.state)) throw new NothingToReconcileError();
  const { r, caps } = await remoteCheck(db, registry, job, item, opts.timeoutMs ?? 30_000, { workerId: 'user-reconcile', tryCancel: false });
  const now = opts.now ?? new Date();
  const state = await db.transaction(async (tx) => {
    const it = await lockItem(tx, ownerId, item.id);
    const locked = await jobForUpdate(tx, ownerId, job.id);
    if (!locked || !(RECONCILABLE_JOB_STATES as readonly string[]).includes(locked.state)) return locked?.state ?? job.state;
    return applyReconcile(tx, locked, it, r, caps, null, now, { manual: true });
  });
  await recordAudit(db, {
    ownerId,
    action: 'item.reconcile',
    entity: 'distribution_item',
    entityId: item.id,
    details: { job_id: job.id, from: job.state, to: state, remote: r.status },
    at: now,
  });
  return { item_id: item.id, job_id: job.id, state_before: job.state, state, found: r.status === 'found', remote: r.status };
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
 * - 최근 전송 의도가 결과 불명(pending·ambiguous)이면 409 outcome_unknown(재확인 먼저).
 * - 활성 승인 hash = 항목 hash(아니면 409 approval_required — 승인 없음 보류는 항목이 PLANNED 로 돌아가 있으므로 다시 승인 후 실행).
 * - 스냅샷 재검사(예약 시각 경과 제외 — 사용자가 지금 다시 보내기로 한 것) 문제 있으면 409 snapshot_stale(아무것도 바꾸지 않음).
 * - 시도 한도(attempt >= max_attempts) 409 attempts_exhausted.
 * worker 는 보내기 직전에 승인·스냅샷을 다시 검사한다(beginSend) — 이 검사는 사용자에게 바로 알려 주기 위한 것이다.
 */
export async function retryItem(db: Db, ownerId: string, itemId: string, now: Date = new Date()): Promise<RetryOutcome> {
  if (!isUuid(itemId)) throw new NotFoundError(ITEM_NOT_FOUND);
  return db.transaction(async (tx) => {
    const item = await lockItem(tx, ownerId, itemId);
    // FIX-T11: 복원한 작업(읽기 전용 이력)은 다시 보내지 않는다 — 항목 표시가 없어도(복원 전부터 BLOCKED 였던 항목) 작업 표시로 거부.
    const restoredJob = await latestJobForItem(tx, ownerId, item.id, false);
    if (restoredJob?.restoredNeedsReview && !item.restoredNeedsReview) {
      throw new NotRetryableError('not_retryable', '복원한 작업은 다시 보내지 않습니다(원격 결과를 이 환경에서 다시 확인하세요). 새 배포 계획을 만드세요.', {
        status: item.status,
        restored: true,
      });
    }
    // FIX-T10(P0): 복원 때 진행 중이던 항목(restored_needs_review)은 원격 결과를 모르므로 재시도(재전송)하지 않는다 — 결과 불명이면 outcome_unknown.
    if (item.restoredNeedsReview) {
      throw item.status === 'UNKNOWN'
        ? new NotRetryableError('outcome_unknown', '복원 전 전송 결과를 알 수 없어 다시 보내지 않습니다. 원격에서 결과를 확인하세요.', { status: item.status, restored: true })
        : new NotRetryableError('not_retryable', '복원 때 진행 중이던 항목은 다시 보내지 않습니다. 새 배포 계획을 만드세요.', { status: item.status, restored: true });
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
    if (last && (last.outcome === 'pending' || last.outcome === 'ambiguous')) {
      throw new NotRetryableError('outcome_unknown', '마지막 전송 결과를 알 수 없어 다시 보내지 않습니다. 재확인을 먼저 하세요.');
    }
    const approval = active.get(item.id);
    if (!approval || approval.payloadHash !== item.payloadHash) {
      throw new NotRetryableError('approval_required', '유효한 승인이 없어 재시도하지 않았습니다(다시 승인하거나 새 계획을 만드세요)');
    }
    if (job.attempt >= job.maxAttempts) {
      throw new NotRetryableError('attempts_exhausted', `시도 한도(${job.maxAttempts}회)에 이르렀습니다. 새 배포 계획을 만드세요.`);
    }
    const problems = (await snapshotProblems(tx, ownerId, item, now)).filter((p) => p !== 'schedule_passed');
    if (problems.length) throw new SnapshotStaleError([{ item_id: item.id, reasons: problems }]);
    await settle(tx, ownerId, job, item, 'unblock', { cause: 'user_retry', previous_error: job.lastErrorCode, approval_id: approval.id }, now, {
      ...CLEAR_LEASE,
      nextRunAt: now,
      lastErrorCode: null,
      lastRetryClass: null,
      reconcileCount: 0,
    });
    await recordAudit(tx, {
      ownerId,
      action: 'item.retry',
      entity: 'distribution_item',
      entityId: item.id,
      details: { job_id: job.id, previous_error: job.lastErrorCode, attempt_next: job.attempt + 1, mode: 'MOCK' },
      at: now,
    });
    return { item_id: item.id, job_id: job.id, state: 'QUEUED' as const, attempt_next: job.attempt + 1, message: '다시 대기열에 넣었습니다(MOCK — 새 시도·새 전송 의도)' };
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
    job: jobView(job),
    events: events.map(jobEventView),
    intents: intents.map(intentView),
    publications: pubs.map(publicationView),
  };
}

/** /api/health 용 집계(owner 구분 없이 개수만). */
export async function jobStateCounts(db: DbOrTx) {
  const rows = await db
    .select({ state: jobs.state, n: sql<number>`count(*)::int` })
    .from(jobs)
    .groupBy(jobs.state);
  const by = new Map(rows.map((r) => [r.state, Number(r.n)]));
  return {
    queued: by.get('QUEUED') ?? 0,
    leased: (by.get('LEASED') ?? 0) + (by.get('SENDING') ?? 0),
    retry_wait: by.get('RETRY_WAIT') ?? 0,
    reconciling: (by.get('RECONCILING') ?? 0) + (by.get('REMOTE_PROCESSING') ?? 0) + (by.get('CANCEL_REQUESTED') ?? 0),
    unknown: by.get('UNKNOWN') ?? 0,
    blocked: by.get('BLOCKED') ?? 0,
    attention_plans: await attentionPlanCount(db),
  };
}

/** T12(D19): 사용자 확인이 필요한 계획(status='attention') 개수. */
export async function attentionPlanCount(db: DbOrTx): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(distributionPlans)
    .where(eq(distributionPlans.status, 'attention'));
  return Number(rows[0]?.n ?? 0);
}
