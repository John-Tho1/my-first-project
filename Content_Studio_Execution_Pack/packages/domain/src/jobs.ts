/**
 * T11(결정 D18) 배포 작업(job) 상태 기계·재시도·결과 분류·계획 상태 — 순수 함수. DB·네트워크 없음.
 *
 * - 작업 상태 전이는 이 파일의 JOB_TRANSITIONS 한 곳에서만 정의한다(docs/03 "세부 상태 전이는 domain 함수 한 곳").
 *   DB 계층(@cs/db jobs.ts)은 transitionJobState 로만 다음 상태를 얻고, 표에 없는 전이는 IllegalJobTransitionError 로 막힌다.
 * - 원격 결과가 불명확하면 RECONCILING → (확인 불가) UNKNOWN 으로 남기고 자동 재전송하지 않는다(A08). UNKNOWN 에서 나가는 전이는
 *   "원격에서 찾음"(reconciled_found/remote_accepted)과 확인 기록(reconcile_retry)뿐이다 — 재전송(lease) 전이는 없다.
 * - 재시도 숫자(30초 기준 지수, 15분 상한, ±20% jitter, 5회, Retry-After 1시간 상한)는 잠정값이다(D18). 실제 채널 한도는 M4 에서 확인.
 */
import { z } from 'zod';
import { AppError } from './errors';

// ---- 상태 ----

export const JOB_STATES = [
  'QUEUED',
  'LEASED',
  'SENDING',
  'REMOTE_PROCESSING',
  'RETRY_WAIT',
  'BLOCKED',
  'RECONCILING',
  'UNKNOWN',
  'CANCEL_REQUESTED',
  'CANCELED',
  'CONFIRMED',
  'FAILED',
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** 항목당 하나만 있을 수 있는 "진행 중" 작업 상태(DB 부분 unique jobs_active_item_uq 와 같아야 한다). */
export const ACTIVE_JOB_STATES: readonly JobState[] = ['QUEUED', 'LEASED', 'SENDING', 'REMOTE_PROCESSING', 'RETRY_WAIT', 'RECONCILING', 'UNKNOWN', 'CANCEL_REQUESTED'];
/** 더는 자동으로 움직이지 않는 상태. */
export const TERMINAL_JOB_STATES: readonly JobState[] = ['CONFIRMED', 'FAILED', 'CANCELED'];
/** 전송 lease 대상(새 시도 = attempt + 1). */
export const SEND_LEASE_STATES: readonly JobState[] = ['QUEUED', 'RETRY_WAIT'];
/** 원격 조회(reconcile) lease 대상 — 상태는 그대로 두고 lease 만 잡는다. UNKNOWN 은 들어가지 않는다(사용자 재확인만). */
export const CHECK_LEASE_STATES: readonly JobState[] = ['RECONCILING', 'REMOTE_PROCESSING', 'CANCEL_REQUESTED'];
/** lease 가 만료되면 복구가 필요한 상태(전송 도중 worker 가 죽었을 수 있다). */
export const LEASE_HELD_STATES: readonly JobState[] = ['LEASED', 'SENDING', 'REMOTE_PROCESSING', 'RECONCILING', 'CANCEL_REQUESTED'];

export const JOB_EVENTS = [
  'lease',
  'send_start',
  'remote_accepted',
  'remote_processing',
  'confirmed',
  'transient_failure',
  'permanent_failure',
  'ambiguous',
  'reconciled_found',
  'reconciled_not_found',
  'reconcile_unsupported',
  'reconcile_retry',
  'blocked',
  'cancel_requested',
  'canceled',
  'cancel_too_late',
  'lease_expired_before_intent',
  'lease_expired_after_intent',
  'unblock',
] as const;
export type JobEvent = (typeof JOB_EVENTS)[number];

/**
 * 허용 전이 표(상태 → 사건 → 다음 상태). 여기에 없는 조합은 모두 불법.
 * - lease: 전송 lease(QUEUED·RETRY_WAIT → LEASED). 조회 lease 는 상태 전이가 아니다(lease 열만 바뀐다).
 * - send_start: 승인 재검사·SENDING·전송 의도 기록이 한 트랜잭션(LEASED → SENDING).
 * - remote_accepted: 원격 ID 확보, 아직 목표 상태 아님(→ REMOTE_PROCESSING). confirmed/reconciled_found: 목표 상태 확인(→ CONFIRMED).
 * - cancel_too_late: 취소 요청 뒤 원격이 이미 받아들인 것을 확인(CANCEL_REQUESTED → CONFIRMED, 취소 성공이라고 하지 않는다 A11).
 * - lease_expired_*: lease 만료 복구 — 의도 기록 전이면 다시 대기, 뒤면 RECONCILING(재전송 금지 A20).
 */
export const JOB_TRANSITIONS: Readonly<Record<JobState, Readonly<Partial<Record<JobEvent, JobState>>>>> = {
  QUEUED: { lease: 'LEASED', blocked: 'BLOCKED', canceled: 'CANCELED' },
  LEASED: {
    send_start: 'SENDING',
    blocked: 'BLOCKED',
    canceled: 'CANCELED',
    cancel_requested: 'CANCEL_REQUESTED',
    permanent_failure: 'FAILED',
    lease_expired_before_intent: 'QUEUED',
  },
  SENDING: {
    remote_accepted: 'REMOTE_PROCESSING',
    confirmed: 'CONFIRMED',
    transient_failure: 'RETRY_WAIT',
    permanent_failure: 'FAILED',
    blocked: 'BLOCKED',
    ambiguous: 'RECONCILING',
    cancel_requested: 'CANCEL_REQUESTED',
    lease_expired_after_intent: 'RECONCILING',
  },
  REMOTE_PROCESSING: {
    remote_processing: 'REMOTE_PROCESSING',
    confirmed: 'CONFIRMED',
    reconciled_found: 'CONFIRMED',
    permanent_failure: 'FAILED',
    ambiguous: 'RECONCILING',
    reconcile_retry: 'REMOTE_PROCESSING',
    reconcile_unsupported: 'UNKNOWN',
    cancel_requested: 'CANCEL_REQUESTED',
    lease_expired_after_intent: 'RECONCILING',
  },
  RETRY_WAIT: { lease: 'LEASED', blocked: 'BLOCKED', canceled: 'CANCELED' },
  RECONCILING: {
    reconciled_found: 'CONFIRMED',
    remote_accepted: 'REMOTE_PROCESSING',
    reconciled_not_found: 'RETRY_WAIT',
    reconcile_unsupported: 'UNKNOWN',
    reconcile_retry: 'RECONCILING',
    permanent_failure: 'FAILED',
    cancel_requested: 'CANCEL_REQUESTED',
  },
  UNKNOWN: { reconciled_found: 'CONFIRMED', remote_accepted: 'REMOTE_PROCESSING', reconcile_retry: 'UNKNOWN' },
  CANCEL_REQUESTED: {
    cancel_too_late: 'CONFIRMED',
    canceled: 'CANCELED',
    reconcile_retry: 'CANCEL_REQUESTED',
    reconcile_unsupported: 'UNKNOWN',
    lease_expired_after_intent: 'CANCEL_REQUESTED',
  },
  BLOCKED: { unblock: 'QUEUED', canceled: 'CANCELED' },
  CANCELED: {},
  CONFIRMED: {},
  FAILED: {},
};

export class IllegalJobTransitionError extends AppError {
  constructor(from: string, event: string) {
    super('conflict', 'illegal_job_transition', `작업 상태 ${from} 에서 ${event} 전이는 허용되지 않습니다`, { from, event });
  }
}

export const isJobState = (s: string): s is JobState => (JOB_STATES as readonly string[]).includes(s);

/** 다음 상태. 표에 없으면 IllegalJobTransitionError. */
export function transitionJobState(state: string, event: JobEvent): JobState {
  if (!isJobState(state)) throw new IllegalJobTransitionError(state, event);
  const next = JOB_TRANSITIONS[state][event];
  if (!next) throw new IllegalJobTransitionError(state, event);
  return next;
}

export function canTransitionJob(state: string, event: JobEvent): boolean {
  return isJobState(state) && JOB_TRANSITIONS[state][event] !== undefined;
}

// ---- 재시도 ----

export const RETRY_BASE_MS = 30_000;
export const RETRY_CAP_MS = 15 * 60_000;
export const RETRY_JITTER = 0.2;
export const DEFAULT_MAX_ATTEMPTS = 5;
/** Retry-After 가 이보다 길면 자동 재시도하지 않고 FAILED(시간 한도). */
export const RETRY_AFTER_MAX_SEC = 3600;
/** 조회(reconcile) 확인 불가가 이 횟수에 이르면 UNKNOWN. */
export const RECONCILE_MAX_ATTEMPTS = 3;
/** 원격 처리 중(REMOTE_PROCESSING) 조회 횟수 한도 — 넘으면 UNKNOWN. */
export const REMOTE_POLL_MAX = 20;
export const RECONCILE_BASE_MS = 10_000;
export const REMOTE_POLL_MS = 15_000;
export const DEFAULT_LEASE_TTL_MS = 60_000;

/**
 * 다음 시도 시각. 지연 = min(30초 × 2^(attempt-1), 15분) × (1 ± 20%) 이고 Retry-After(초)보다 짧지 않다.
 * attempt 는 방금 실패한 시도 번호(1부터). random 은 [0,1) (테스트 주입).
 */
export function retryDelay(attempt: number, retryAfterSec: number | undefined | null, now: Date, random: () => number = Math.random): Date {
  const n = Math.max(1, Math.floor(attempt));
  const base = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(n - 1, 30));
  const r = Math.min(Math.max(random(), 0), 1);
  let delay = Math.round(base * (1 - RETRY_JITTER + 2 * RETRY_JITTER * r));
  if (retryAfterSec !== undefined && retryAfterSec !== null && Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    delay = Math.max(delay, Math.ceil(retryAfterSec) * 1000);
  }
  return new Date(now.getTime() + delay);
}

export type RetryDecision = { retry: true; nextRunAt: Date } | { retry: false; reason: 'max_attempts' | 'retry_after_too_long' };

/** 부작용 없는 일시 오류 뒤: 한도 안이면 RETRY_WAIT(다음 시각), 아니면 FAILED. */
export function decideRetry(
  attempt: number,
  maxAttempts: number,
  retryAfterSec: number | undefined | null,
  now: Date,
  random: () => number = Math.random,
): RetryDecision {
  if (attempt >= maxAttempts) return { retry: false, reason: 'max_attempts' };
  if (retryAfterSec && retryAfterSec > RETRY_AFTER_MAX_SEC) return { retry: false, reason: 'retry_after_too_long' };
  return { retry: true, nextRunAt: retryDelay(attempt, retryAfterSec, now, random) };
}

/** 조회 재시도 간격: 10초 × 2^(n-1), 15분 상한. n = 지금까지 확인 불가 횟수(1부터). */
export function reconcileDelay(count: number, now: Date): Date {
  const n = Math.max(1, Math.floor(count));
  return new Date(now.getTime() + Math.min(RETRY_CAP_MS, RECONCILE_BASE_MS * 2 ** Math.min(n - 1, 30)));
}

// ---- ChannelAdapter 계약(docs/03) — 타입만. 구현은 @cs/providers(모의만). ----

export const RETRY_CLASSES = ['transient_no_side_effect', 'transient_unknown_side_effect', 'permanent', 'auth'] as const;
export type RetryClass = (typeof RETRY_CLASSES)[number];
export const RESULT_KINDS = ['UPLOADED_PRIVATE', 'SCHEDULED_REMOTE', 'PUBLISHED', 'MANUAL_REPORTED'] as const;
export type ResultKind = (typeof RESULT_KINDS)[number];
export const REMOTE_VISIBILITIES = ['private', 'unlisted', 'public', 'unknown'] as const;
export type RemoteVisibility = (typeof REMOTE_VISIBILITIES)[number];
export const PUBLICATION_VERIFICATIONS = ['MOCK', 'VERIFIED', 'UNVERIFIED', 'MANUAL_REPORTED'] as const;
export type PublicationVerification = (typeof PUBLICATION_VERIFICATIONS)[number];
export const INTENT_OUTCOMES = ['pending', 'accepted', 'rejected', 'ambiguous'] as const;
export type IntentOutcome = (typeof INTENT_OUTCOMES)[number];

/** submit 결과. accepted = 목표 상태 도달, processing = 원격 ID 는 있으나 처리 중, rejected = 받아들이지 않음, ambiguous = 모름. */
export interface AdapterResult {
  status: 'accepted' | 'processing' | 'rejected' | 'ambiguous';
  result_kind?: ResultKind;
  external_id?: string;
  permalink?: string;
  remote_visibility?: RemoteVisibility;
  retry_class?: RetryClass;
  retry_after_sec?: number;
  provider_request_id?: string;
  error_code?: string;
}

/** reconcile 결과. read 권한이 없으면 unsupported, 조회했지만 판단 불가면 unknown. not_found 는 capabilities.definitive_not_found 일 때만 "보내지 않았음"으로 믿는다. */
export interface ReconcileResult {
  status: 'found' | 'processing' | 'not_found' | 'unsupported' | 'unknown';
  result_kind?: ResultKind;
  external_id?: string;
  permalink?: string;
  remote_visibility?: RemoteVisibility;
  provider_request_id?: string;
  error_code?: string;
}

export interface CancelResult {
  status: 'canceled' | 'not_canceled' | 'unsupported';
  error_code?: string;
}

export interface AdapterCapabilities {
  /** 원격 상태 조회 가능(reconcile) */
  read: boolean;
  /** 원격 취소 가능 */
  cancel: boolean;
  /** 조회에서 "없음"이 "보내지 않았음"을 뜻한다(아니면 not_found 도 확인 불가로 본다) */
  definitive_not_found: boolean;
  /** 모의 어댑터(결과는 MOCK — 실제 발행 실적이 아님) */
  mock: boolean;
}

export interface AdapterAccount {
  id: string;
  kind: 'mock' | 'live';
  platform: string;
  external_account_id: string;
}

/** 어댑터가 받는 승인 스냅샷(항목의 불변 canonical payload). */
export interface PublishSnapshot {
  item_id: string;
  channel: string;
  account: AdapterAccount;
  payload: Record<string, unknown>;
  payload_hash: string;
  visibility: string;
  requested_result: string;
  scheduled_at_utc: string | null;
}

export interface PreparedSubmission {
  snapshot: PublishSnapshot;
  data: Record<string, unknown>;
}

export interface RemoteReference {
  platform: string;
  intent_key: string;
  external_id: string | null;
  provider_request_id: string | null;
}

export interface AdapterContext {
  /** 멱등 토큰(= 전송 의도 key `<job_id>:<attempt>`) */
  intentKey: string;
  attempt: number;
  jobId: string;
  itemId: string;
  now: Date;
  /** 시간 초과·중단 신호 */
  signal: AbortSignal;
  /** lease 연장(작은 별도 트랜잭션) */
  heartbeat(): Promise<void>;
}

export interface ChannelAdapter {
  readonly kind: 'mock' | 'live';
  capabilities(account: AdapterAccount): AdapterCapabilities;
  validate(snapshot: PublishSnapshot): { ok: true } | { ok: false; error_code: string };
  prepare(snapshot: PublishSnapshot, ctx: AdapterContext): Promise<PreparedSubmission>;
  submit(prepared: PreparedSubmission, ctx: AdapterContext): Promise<AdapterResult>;
  reconcile(reference: RemoteReference, ctx: AdapterContext): Promise<ReconcileResult>;
  cancel(reference: RemoteReference, ctx: AdapterContext): Promise<CancelResult>;
}

export interface ChannelAdapterRegistry {
  /** live 계정은 LiveChannelNotConfiguredError(M3 에는 live 어댑터 없음). */
  getAdapterFor(account: Pick<AdapterAccount, 'kind' | 'platform'>): ChannelAdapter;
}

// ---- 결과 분류 ----

export interface OutcomeClass {
  event: Extract<JobEvent, 'confirmed' | 'remote_accepted' | 'transient_failure' | 'permanent_failure' | 'ambiguous' | 'blocked'>;
  retryClass: RetryClass | null;
  intentOutcome: Exclude<IntentOutcome, 'pending'>;
}

/**
 * submit 결과 → 사건. 429/5xx 도 부작용 여부로 나눈다(docs/03): 부작용 없음만 재시도, 부작용 불명은 조회(ambiguous).
 * 401(auth)은 M3 에 refresh 가 없으므로 바로 BLOCKED. retry_class 가 없는 거절은 permanent(자동 반복하지 않음).
 */
export function classifyOutcome(r: Pick<AdapterResult, 'status' | 'retry_class'>): OutcomeClass {
  switch (r.status) {
    case 'accepted':
      return { event: 'confirmed', retryClass: null, intentOutcome: 'accepted' };
    case 'processing':
      return { event: 'remote_accepted', retryClass: null, intentOutcome: 'accepted' };
    case 'ambiguous':
      return { event: 'ambiguous', retryClass: 'transient_unknown_side_effect', intentOutcome: 'ambiguous' };
    case 'rejected':
      switch (r.retry_class) {
        case 'auth':
          return { event: 'blocked', retryClass: 'auth', intentOutcome: 'rejected' };
        case 'transient_no_side_effect':
          return { event: 'transient_failure', retryClass: 'transient_no_side_effect', intentOutcome: 'rejected' };
        case 'transient_unknown_side_effect':
          return { event: 'ambiguous', retryClass: 'transient_unknown_side_effect', intentOutcome: 'ambiguous' };
        default:
          return { event: 'permanent_failure', retryClass: 'permanent', intentOutcome: 'rejected' };
      }
    default:
      return { event: 'ambiguous', retryClass: 'transient_unknown_side_effect', intentOutcome: 'ambiguous' };
  }
}

// ---- 항목·계획 상태 ----

/** 작업 상태 → 배포 항목 상태. LEASED 는 아직 보내지 않았으므로 QUEUED 로 보인다. */
export function itemStatusForJob(state: JobState): string {
  return state === 'LEASED' ? 'QUEUED' : state;
}

/** 계획 상태에서 "진행 중"으로 보는 항목 상태(UNKNOWN 은 자동으로 움직이지 않으므로 넣지 않는다). */
export const PLAN_IN_FLIGHT_ITEM_STATUSES = ['QUEUED', 'SENDING', 'REMOTE_PROCESSING', 'RETRY_WAIT', 'RECONCILING', 'CANCEL_REQUESTED'] as const;

export type PlanStatusValue = 'draft' | 'partially_approved' | 'approved' | 'executing' | 'partial' | 'completed' | 'canceled' | 'failed';

/**
 * 항목 상태·활성 승인에서 계획 상태(T10 computePlanStatus 와 T11 이 함께 쓰는 유일한 규칙).
 * 1) 진행 중 항목 → executing 2) PLANNED 항목 → 승인 수로 draft/partially_approved/approved
 * 3) 모두 CONFIRMED → completed, 모두 CANCELED → canceled 4) CONFIRMED(또는 PARTIAL)가 있거나 UNKNOWN 이 있으면 partial
 *    (UNKNOWN 은 원격에 있을 수도 있으므로 failed 로 부르지 않는다) 5) 나머지(FAILED·CANCELED·BLOCKED 만) → failed.
 */
export function planStatusFrom(items: ReadonlyArray<{ status: string; activeApproval: boolean }>): PlanStatusValue {
  if (items.length === 0) return 'draft';
  if (items.some((i) => (PLAN_IN_FLIGHT_ITEM_STATUSES as readonly string[]).includes(i.status))) return 'executing';
  const planned = items.filter((i) => i.status === 'PLANNED');
  if (planned.length > 0) {
    const approved = planned.filter((i) => i.activeApproval).length;
    if (approved === 0) return 'draft';
    return approved === planned.length ? 'approved' : 'partially_approved';
  }
  if (items.every((i) => i.status === 'CONFIRMED')) return 'completed';
  if (items.every((i) => i.status === 'CANCELED')) return 'canceled';
  if (items.some((i) => i.status === 'CONFIRMED' || i.status === 'PARTIAL' || i.status === 'UNKNOWN')) return 'partial';
  return 'failed';
}

// ---- 입력 스키마 ----

export const cancelSchema = z.object({});
export const reconcileSchema = z.object({});
export const WORKER_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const tickSchema = z.object({
  max_jobs: z.coerce.number().int().min(1).max(20).optional(),
  worker_id: z.string().regex(WORKER_ID_RE, 'worker_id 는 영문·숫자·_·- 1~32자입니다').optional(),
});
export type TickInput = z.infer<typeof tickSchema>;

// ---- 오류 ----

export class NotCancellableError extends AppError {
  constructor(state: string) {
    super(
      'conflict',
      state === 'UNKNOWN' ? 'cancel_unknown' : 'not_cancellable',
      state === 'UNKNOWN'
        ? '원격 결과를 확인할 수 없는 항목(UNKNOWN)은 취소를 확정할 수 없습니다. 재확인을 먼저 하세요(자동 재전송은 하지 않습니다).'
        : '이미 끝났거나 실행 전인 항목은 취소할 수 없습니다',
      { state },
    );
  }
}

export class NothingToReconcileError extends AppError {
  constructor() {
    super('conflict', 'nothing_to_reconcile', '원격 재확인이 필요한 작업이 없습니다(확인 중·결과 불명·원격 처리 중인 항목만 재확인합니다)');
  }
}

/** 화면·API 문구: 취소 확인 중. */
export const CANCEL_PENDING_MESSAGE = '취소 확인 중';
