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
  'late_result',
  // T14(D26): 원격에 남긴 단계 참조(컨테이너 등)로 이어서 보낼 수 있음 — 새 시도(새 전송 의도)가 같은 참조를 재사용한다(새 원격 객체 없음).
  'resume',
  // T14(D26): 계정별 로컬 요청 제한 — 전송 의도를 만들지 않고 창(window)이 풀리는 시각까지 대기.
  'local_rate_limited',
  // FIX-T14(Codex review-T14 missed case): 아직 시작하지 않은(QUEUED·RETRY_WAIT·BLOCKED) 작업을 취소하는데 스레드 일부가 이미 원격에 게시됨 —
  // 남은 부분은 보내지 않지만 취소 성공(CANCELED·"보내지 않음")이라고 하지 않는다(A11). → UNKNOWN(사유 thread_partial_canceled).
  'cancel_partial',
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
  QUEUED: { lease: 'LEASED', blocked: 'BLOCKED', canceled: 'CANCELED', late_result: 'RECONCILING', cancel_partial: 'UNKNOWN' },
  LEASED: {
    send_start: 'SENDING',
    blocked: 'BLOCKED',
    canceled: 'CANCELED',
    cancel_requested: 'CANCEL_REQUESTED',
    permanent_failure: 'FAILED',
    lease_expired_before_intent: 'QUEUED',
    late_result: 'RECONCILING',
    local_rate_limited: 'RETRY_WAIT',
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
    resume: 'RETRY_WAIT',
  },
  // FIX-T11(P0): late_result — lease 를 잃은 옛 시도가 부작용이 있을 수 있는 결과(accepted·processing·ambiguous)를 늦게 돌려주면
  // 다음 시도(새 의도)로 가지 않고 조회로 돌린다(맹목 재전송 금지).
  RETRY_WAIT: { lease: 'LEASED', blocked: 'BLOCKED', canceled: 'CANCELED', late_result: 'RECONCILING', cancel_partial: 'UNKNOWN' },
  RECONCILING: {
    reconciled_found: 'CONFIRMED',
    remote_accepted: 'REMOTE_PROCESSING',
    reconciled_not_found: 'RETRY_WAIT',
    reconcile_unsupported: 'UNKNOWN',
    reconcile_retry: 'RECONCILING',
    permanent_failure: 'FAILED',
    cancel_requested: 'CANCEL_REQUESTED',
    resume: 'RETRY_WAIT',
  },
  UNKNOWN: { reconciled_found: 'CONFIRMED', remote_accepted: 'REMOTE_PROCESSING', reconcile_retry: 'UNKNOWN' },
  CANCEL_REQUESTED: {
    cancel_too_late: 'CONFIRMED',
    canceled: 'CANCELED',
    // T15(D27): 취소 요청 중 원격이 업로드한 영상을 거부(처리 실패)했다고 조회로 확인 — 실패(공개된 것 없음, 취소 성공이라고 하지 않음).
    permanent_failure: 'FAILED',
    reconcile_retry: 'CANCEL_REQUESTED',
    reconcile_unsupported: 'UNKNOWN',
    lease_expired_after_intent: 'CANCEL_REQUESTED',
  },
  BLOCKED: { unblock: 'QUEUED', canceled: 'CANCELED', cancel_partial: 'UNKNOWN' },
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
 * FIX-T11 round 2(P1): 전송 의도 없이 lease 가 만료된 횟수의 한도(시도 한도 max_attempts 와 별개). 시도(attempt)는 전송 의도를 쓸 때만 센다.
 * 이 횟수가 한도에 이르면 보내지 않은 채 FAILED(lease_expired_before_intent) — 보내기 전에 되풀이해 죽는 작업이 끝없이 lease 되지 않게.
 */
export const PRE_INTENT_EXPIRY_LIMIT = 5;
/**
 * FIX-T14(Codex review-T14 missed case): 원격 처리 지연(REMOTE_PROCESSING → resume) 뒤의 재개는 장애가 아니므로 시도 한도에서 빼는 최대 횟수.
 * 게시물마다 컨테이너는 한 번만 IN_PROGRESS → FINISHED 가 되므로 정상 흐름의 지연 재개는 게시물 수(최대 20) 이하다 — 그 이상은 시도로 센다.
 */
export const FREE_RESUME_MAX = 20;

/** FIX-T14: 시도 한도에 세는 시도 수 = 전송 의도 수(attempt) − 처리 지연 재개 수(resume_count). */
export function countedAttempts(job: { attempt: number; resumeCount?: number | null }): number {
  return Math.max(0, job.attempt - Math.max(0, job.resumeCount ?? 0));
}

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

/**
 * T15(D27): 원격이 정한 다음 시각(할당량 초기화 등)까지 기다리는 부작용 없는 일시 오류. 시도 한도 안이면 그 시각(지금 + 1초 이상)까지 RETRY_WAIT,
 * 한도에 이르면 FAILED. Retry-After 1시간 상한은 쓰지 않는다(할당량은 하루 단위로 풀린다 — 잠정).
 */
export function decideRetryAt(attempt: number, maxAttempts: number, retryAt: Date, now: Date): RetryDecision {
  if (attempt >= maxAttempts) return { retry: false, reason: 'max_attempts' };
  return { retry: true, nextRunAt: new Date(Math.max(retryAt.getTime(), now.getTime() + 1000)) };
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
  /**
   * T15(D27): 원격 할당량처럼 "이 시각까지는 다시 보내도 같은 거절"인 부작용 없는 일시 오류의 다음 시도 시각(ISO). 있으면 작업 처리기는
   * Retry-After 1시간 상한(retry_after_too_long) 대신 이 시각까지 RETRY_WAIT 로 기다린다(시도 한도는 그대로).
   */
  retry_at?: string;
  provider_request_id?: string;
  error_code?: string;
}

/**
 * reconcile 결과. read 권한이 없으면 unsupported, 조회했지만 판단 불가면 unknown. not_found 는 capabilities.definitive_not_found 일 때만 "보내지 않았음"으로 믿는다.
 * T14(D26) resumable: 원격에 남긴 단계 참조(remote_steps — 예: Threads 컨테이너)로 확인해 보니 **남은 단계는 아직 게시되지 않았음**이 확실하고,
 * 같은 참조를 재사용해 이어 보낼 수 있다(새 원격 객체를 만들지 않음). published_parts = 이미 게시된 부분 수(스레드의 앞 게시물 등).
 * 작업 처리기는 이것을 새 시도(새 전송 의도)로 이어 보낸다 — 사용자 재확인은 조회만(이어 보내지 않음).
 * T15(D27) failed: 원격이 받은 결과를 스스로 거부·처리 실패로 끝냈음이 확인됨(예: YouTube uploadStatus failed/rejected) — 영구 실패(FAILED).
 */
export interface ReconcileResult {
  status: 'found' | 'processing' | 'not_found' | 'unsupported' | 'unknown' | 'resumable' | 'failed';
  result_kind?: ResultKind;
  external_id?: string;
  permalink?: string;
  remote_visibility?: RemoteVisibility;
  provider_request_id?: string;
  error_code?: string;
  published_parts?: number;
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
  /** T14(D26): 어댑터 식별자(mock_generic·mock_threads). 전송 의도에 기록해 조회 때 같은 어댑터를 쓴다. */
  adapter?: string;
  /** T14: 미디어 첨부 지원 여부(Threads T14 = 텍스트만 → false) */
  media?: boolean;
  /** T14: 글자 수·게시물 수 한도(잠정값 — 확인일·API 버전과 함께, docs/03 "숫자를 사실로 고정하지 않음") */
  text?: ChannelTextLimits;
  /** T14: 계정별 요청 제한(잠정값). 있으면 작업 처리기가 전송 의도 전에 로컬로 센다(local_rate_limited). */
  rate_limit?: ChannelRateLimit;
}

export interface ChannelTextLimits {
  max_post_chars: number;
  max_posts: number;
  unit: 'code_point';
  checked_at: string | null;
  api_version: string | null;
  source: string;
}

export interface ChannelRateLimit {
  /** 창(window) 안에서 허용할 게시 단위 수(게시물 1개 = 1) */
  max_units: number;
  window_sec: number;
  checked_at: string | null;
  api_version: string | null;
  source: string;
}

export interface AdapterAccount {
  id: string;
  kind: 'mock' | 'live';
  platform: string;
  external_account_id: string;
  /** T13: channel_accounts.credential_state(none·linked·needs_reconnect). T14 어댑터 선택 규칙(D26)에 쓴다. */
  credential_state?: string;
}

/** T14(D26)·T15(D27): 어댑터 식별자. */
export const ADAPTER_IDS = ['mock_generic', 'mock_threads', 'mock_youtube'] as const;
export type AdapterId = (typeof ADAPTER_IDS)[number];

/**
 * T14(D26) 어댑터 선택 규칙(한 곳): 모의 계정 + platform='threads' + 연결 정보를 쓴 적 있음(credential_state ≠ none)
 * → Threads 모의 어댑터(mock_threads, 컨테이너 → 게시 2단계, T13 연결 정보 사용). 연결한 적 없는 모의 계정(M3 seed 계정)
 * → 일반 모의 어댑터(mock_generic, M3 동작 그대로). live 계정 → null(어댑터 없음 — LiveChannelNotConfiguredError).
 * T15(D27): 모의 계정 + platform='youtube' + 연결 정보를 쓴 적 있음 → YouTube 모의 어댑터(mock_youtube, 재개 업로드, Google 형 모의 OAuth 연결 정보 사용).
 */
export function adapterIdFor(account: Pick<AdapterAccount, 'kind' | 'platform' | 'credential_state'>): AdapterId | null {
  if (account.kind !== 'mock') return null;
  const linked = account.credential_state !== undefined && account.credential_state !== 'none';
  if (account.platform === 'threads' && linked) return 'mock_threads';
  if (account.platform === 'youtube' && linked) return 'mock_youtube';
  return 'mock_generic';
}

/**
 * FIX-T14(Codex review-T14 P0 jobs.ts:848): T14 이전 코드가 만든 전송 의도에는 adapter_id 가 없다. 그때 어댑터는 일반 모의 어댑터 하나뿐이었다
 * (live 는 어댑터 없음 — 의도 자체가 생기지 않음). 그래서 adapter_id 가 없거나 null 이면 **명시적으로** mock_generic 으로 읽는다 — 현재 계정 상태로
 * 고른 어댑터(adapterIdFor)로 대신하지 않는다. 문자열이지만 모르는 값이면 null(조회는 unknown 으로 닫는다).
 */
export const LEGACY_SEND_ADAPTER_ID: AdapterId = 'mock_generic';
export function recordedAdapterIdOf(sanitizedDetails: Record<string, unknown> | null | undefined): { id: AdapterId; legacy: boolean } | { id: null; raw: string } {
  const v = sanitizedDetails?.adapter_id;
  if (v === undefined || v === null) return { id: LEGACY_SEND_ADAPTER_ID, legacy: true };
  if (typeof v === 'string' && (ADAPTER_IDS as readonly string[]).includes(v)) return { id: v as AdapterId, legacy: false };
  return { id: null, raw: typeof v === 'string' ? v.slice(0, 64) : typeof v };
}

/**
 * T14: 원격 단계 기록(remote_steps) — 어댑터가 외부 호출 사이에 남기는 참조. ID 는 모의 ID 만(DB CHECK remote_id LIKE 'mock%').
 * T15(D27): YouTube 재개 업로드 — upload_session(세션 URI, post_index = 세션 순번, 받은 바이트 수는 단조 증가) · video(영상 ID, post_index 0).
 * 종류별 상태: container created|finished|error · publish published · upload_session created(진행 중)|finished(다 보냄)|expired|error ·
 * video uploaded|processed|error.
 */
export const REMOTE_STEP_KINDS = ['container', 'publish', 'upload_session', 'video'] as const;
export type RemoteStepKind = (typeof REMOTE_STEP_KINDS)[number];
export const REMOTE_STEP_STATUSES = ['created', 'finished', 'published', 'error', 'expired', 'uploaded', 'processed'] as const;
export type RemoteStepStatus = (typeof REMOTE_STEP_STATUSES)[number];
/** 종류별 허용 상태(DB CHECK remote_steps_kind_status_chk 와 같아야 한다). */
export const REMOTE_STEP_KIND_STATUSES: Readonly<Record<RemoteStepKind, readonly RemoteStepStatus[]>> = {
  container: ['created', 'finished', 'error'],
  publish: ['published'],
  upload_session: ['created', 'finished', 'expired', 'error'],
  video: ['uploaded', 'processed', 'error'],
};

export interface RemoteStep {
  kind: RemoteStepKind;
  post_index: number;
  step_index: number;
  remote_id: string;
  status: RemoteStepStatus;
  /** T15: 업로드 세션의 원격이 확인한 받은 바이트 수(단조 증가 — DB 트리거). 다른 종류는 null. */
  received_bytes: number | null;
  /** T15: 업로드할 전체 바이트 수(처음 기록 뒤 불변). */
  total_bytes: number | null;
  /** T15: 같은 세션을 다음 시도가 이어 받은 횟수(단조 증가). */
  resume_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * T14: 작업 처리기가 어댑터에 주는 단계 기록 창구(작업 단위). 각 호출은 **자기 짧은 트랜잭션**(원격 호출 동안 DB 잠금 없음).
 * record 는 (job, post_index, kind) 가 없으면 넣고, 있으면 같은 remote_id 일 때만 상태를 바꾼다 — 다른 remote_id 면 던진다(참조는 바뀌지 않음).
 */
export interface RemoteStepsPort {
  list(): Promise<RemoteStep[]>;
  /**
   * T15: received_bytes 는 앞으로만(더 작으면 409 remote_step_regress), total_bytes 는 처음 값 그대로(다르면 409), resumed=true 면 resume_count + 1.
   */
  record(step: {
    kind: RemoteStepKind;
    post_index: number;
    remote_id: string;
    status: RemoteStepStatus;
    received_bytes?: number;
    total_bytes?: number;
    resumed?: boolean;
  }): Promise<RemoteStep>;
}

/**
 * T15(D27): 업로드할 미디어 파일 창구(작업 처리기가 넣는다). 승인 스냅샷의 첨부(id·checksum·mime)와 같은 **VERIFIED·지워지지 않은** owner 의
 * asset 만 연다(아니면 code). read 는 [start, end) 바이트만 읽는다 — 큰 영상을 메모리에 한꺼번에 올리지 않는다.
 */
export interface MediaFile {
  bytes: number;
  mime: string;
  checksum: string;
  read(start: number, end: number): Promise<Uint8Array>;
}
export interface MediaPort {
  open(asset: { id: string; checksum: string; mime: string }): Promise<{ ok: true; file: MediaFile } | { ok: false; code: string }>;
}
/** T15: 저장소에서 key 의 [start, end) 바이트를 읽는 함수(작업 처리기 옵션 — web·CLI 가 로컬 저장소로 넣는다). */
export interface MediaReader {
  readRange(key: string, start: number, end: number): Promise<Uint8Array>;
}

/**
 * T14: 서버 쪽에서 계정 연결 토큰을 꺼내는 창구(작업 처리기 안에서만, T13 봉인 해제). 토큰은 어댑터 메모리에만 —
 * 로그·오류·감사·작업 이력·응답·단계 기록에 넣지 않는다. 쓸 수 없으면 code 만(credential_<상태>·secrets_not_configured·decrypt_<문제>).
 */
export interface CredentialPort {
  accessToken(): Promise<{ ok: true; token: string } | { ok: false; code: string }>;
}

/**
 * T14(D26) 로컬 요청 제한 판단(순수). used = 창 안에서 이미 쓴 단위, needed = 이번 작업이 더 쓸 단위, oldestAt = 창 안 가장 오래된 사용 시각.
 * used + needed > max 이면 대기(resetAt = oldestAt + 창). 단, 창 안 사용이 0 이면 허용(한도보다 큰 작업도 영원히 막히지 않게).
 */
export function localRateLimitDecision(input: {
  used: number;
  needed: number;
  limit: Pick<ChannelRateLimit, 'max_units' | 'window_sec'>;
  oldestAt: Date | null;
  now: Date;
}): { allowed: true } | { allowed: false; resetAt: Date } {
  const { used, needed, limit, oldestAt, now } = input;
  if (needed <= 0 || used <= 0 || used + needed <= limit.max_units) return { allowed: true };
  const base = oldestAt ?? now;
  const resetAt = new Date(Math.max(base.getTime() + limit.window_sec * 1000, now.getTime() + 1000));
  return { allowed: false, resetAt };
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

/**
 * T12(D19): 모의 결과 시나리오(개발·시험 전용 — 실제 채널 개념이 아니다). 승인 스냅샷·payload 에 넣지 않고 별도 표(mock_scenarios)에 둔다
 * (hash·승인 상태가 바뀌지 않게). DB CHECK(0018)와 같은 목록이어야 한다.
 */
export const MOCK_SCENARIO_VALUES = [
  'success',
  'success_public',
  'processing_then_confirm',
  'transient',
  'transient_then_success',
  'rate_limited',
  'server_error_no_side_effect',
  'server_error_side_effect_unknown',
  'permanent',
  'auth',
  'ambiguous_sent',
  'ambiguous_not_sent',
  'hang',
  'cancel_supported',
  'reconcile_unsupported',
  // T14(D26): Threads 모의 어댑터(mock_threads) 전용 — 시뮬레이터 동작만 정한다(payload·hash 는 그대로).
  'threads_success',
  'threads_container_slow',
  'threads_publish_timeout_sent',
  'threads_publish_timeout_not_sent',
  'threads_thread_partial',
  'threads_rate_limited',
  'threads_token_invalid',
  'threads_text_too_long',
  // T15(D27): YouTube 모의 어댑터(mock_youtube) 전용 — 시뮬레이터 동작만 정한다(payload·hash 는 그대로).
  'youtube_success_private',
  'youtube_processing_slow',
  'youtube_network_drop',
  'youtube_response_lost_after_complete',
  'youtube_session_expired_before_complete',
  'youtube_quota_exceeded',
  'youtube_token_invalid',
  'youtube_rejected',
  'youtube_public_unverified_forced_private',
  'youtube_scheduled_private',
  'youtube_project_verified',
] as const;
export type MockScenarioValue = (typeof MOCK_SCENARIO_VALUES)[number];
/** T14: Threads 모의 어댑터에만 쓰는 시나리오. 'success' 는 두 어댑터 모두에 쓸 수 있다(Threads 에서는 threads_success). */
export const THREADS_MOCK_SCENARIOS = MOCK_SCENARIO_VALUES.filter((s) => s.startsWith('threads_')) as readonly MockScenarioValue[];
export const isThreadsMockScenario = (s: string): boolean => s.startsWith('threads_');
/** T15: YouTube 모의 어댑터에만 쓰는 시나리오. */
export const YOUTUBE_MOCK_SCENARIOS = MOCK_SCENARIO_VALUES.filter((s) => s.startsWith('youtube_')) as readonly MockScenarioValue[];
export const isYouTubeMockScenario = (s: string): boolean => s.startsWith('youtube_');
/** 어댑터에 맞는 시나리오인가(API 가 다르면 400 scenario_not_applicable). */
export function scenarioApplies(adapter: AdapterId, scenario: string): boolean {
  if (scenario === 'success') return true;
  if (adapter === 'mock_threads') return isThreadsMockScenario(scenario);
  if (adapter === 'mock_youtube') return isYouTubeMockScenario(scenario);
  return !isThreadsMockScenario(scenario) && !isYouTubeMockScenario(scenario);
}
export const MOCK_SCENARIO_MAX_DELAY_MS = 5000;

/** 항목별 모의 시나리오(작업 처리기가 mock 계정 항목에 대해서만 mock_scenarios 표에서 읽어 넣는다). */
export interface MockScenarioSetting {
  scenario: MockScenarioValue;
  delay_ms: number;
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
  /** lease 연장(작은 별도 트랜잭션). FIX-T11(P0): lease 를 잃었으면 LeaseLostError 를 던지고 signal 을 중단한다 — 어댑터는 부작용 전에 부른다. */
  heartbeat(): Promise<void>;
  /** T12: 항목별 모의 시나리오(모의 계정 항목만, 없으면 null). live 어댑터는 무시한다. */
  mockScenario?: MockScenarioSetting | null;
  /** T14: 이 작업의 원격 단계 기록(remote_steps). 작업 처리기가 넣는다. */
  steps?: RemoteStepsPort;
  /** T14: 서버 쪽 연결 토큰 창구(T13). 작업 처리기가 넣는다. */
  credential?: CredentialPort;
  /** T14: 조회(reconcile) 때도 승인 스냅샷이 필요한 어댑터용(예: 스레드 게시물 수). */
  snapshot?: PublishSnapshot;
  /** T15: 업로드할 미디어(VERIFIED asset 만, 범위 읽기). 작업 처리기가 넣는다. */
  media?: MediaPort;
  /** T15: 이 작업에 취소 요청이 들어왔는가(짧은 읽기). 긴 업로드가 조각 사이에 확인하고 영상이 생기기 전이면 멈춘다. */
  cancelRequested?: () => Promise<boolean>;
}

export interface ChannelAdapter {
  readonly kind: 'mock' | 'live';
  /** T14: 어댑터 식별자(전송 의도 sanitized_details.adapter_id 에 기록). 없으면 kind 로만 고른다(M3 호환). */
  readonly id?: AdapterId;
  /**
   * FIX-T14(Codex review-T14 P1): 조회 판정이 이 환경의 원격 단계 기록(remote_steps)에 기대는 어댑터(Threads·YouTube 모의). 복원한 작업은
   * 기록이 묶음과 함께 왔는지 알 수 없으므로 이런 어댑터의 not_found 를 믿지 않는다(unknown).
   */
  readonly usesRemoteSteps?: boolean;
  /** T14: 이 스냅샷이 쓸 요청 제한 단위 수(예: 스레드 게시물 수). capabilities.rate_limit 과 함께 쓴다. */
  rateUnits?(snapshot: PublishSnapshot): number;
  /** T15: 요청 제한 사용량을 셀 원격 단계 종류(기본 ['publish'] — Threads 게시. YouTube 는 ['upload_session'] = 업로드 시작 수). */
  readonly rateStepKinds?: readonly RemoteStepKind[];
  /** ctx.mockScenario 는 모의 어댑터가 항목별 capabilities(cancel 등)를 정할 때만 쓴다. */
  capabilities(account: AdapterAccount, ctx?: Pick<AdapterContext, 'mockScenario'>): AdapterCapabilities;
  validate(snapshot: PublishSnapshot): { ok: true } | { ok: false; error_code: string };
  prepare(snapshot: PublishSnapshot, ctx: AdapterContext): Promise<PreparedSubmission>;
  submit(prepared: PreparedSubmission, ctx: AdapterContext): Promise<AdapterResult>;
  reconcile(reference: RemoteReference, ctx: AdapterContext): Promise<ReconcileResult>;
  cancel(reference: RemoteReference, ctx: AdapterContext): Promise<CancelResult>;
}

export interface ChannelAdapterRegistry {
  /** live 계정은 LiveChannelNotConfiguredError(M3 에는 live 어댑터 없음). */
  getAdapterFor(account: Pick<AdapterAccount, 'kind' | 'platform' | 'credential_state'>): ChannelAdapter;
  /** T14: 전송 의도에 기록된 어댑터로 조회한다(계정 연결 상태가 그 뒤 바뀌어도 보낸 어댑터로 확인). 모르면 null. */
  getAdapterById?(id: string): ChannelAdapter | null;
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

export type PlanStatusValue = 'draft' | 'partially_approved' | 'approved' | 'executing' | 'partial' | 'attention' | 'completed' | 'canceled' | 'failed';

/** 사용자가 움직여야 하는 항목 상태(자동으로는 더 진행하지 않음): 보류(재연결·재시도)·결과 불명(재확인)·실행 전(다시 승인). */
export const PLAN_NEEDS_USER_ITEM_STATUSES = ['BLOCKED', 'UNKNOWN', 'PLANNED'] as const;

/**
 * 항목 상태·활성 승인에서 계획 상태(T10 computePlanStatus 와 T11·T12 가 함께 쓰는 유일한 규칙, D19).
 * 1) 항목 없음 → draft 2) 진행 중 항목(자동으로 움직임) → executing
 * 3) 모두 PLANNED(아직 실행 안 함) → 승인 수로 draft/partially_approved/approved
 * 4) 모두 CONFIRMED → completed, 모두 CANCELED → canceled
 * 5) CONFIRMED(또는 레거시 PARTIAL)가 하나라도 있고 나머지가 끝났거나 멈춤 → partial(부분 성공, 성공한 항목은 다시 보내지 않는다)
 * 6) CONFIRMED 없음 + 사용자 조치가 필요한 항목(BLOCKED·UNKNOWN·다시 승인할 PLANNED) → attention(확인 필요)
 *    — "failed" 라고 부르면 원격에 있을 수 있는 UNKNOWN·재연결로 풀리는 BLOCKED 를 실패로 오해하게 된다.
 * 7) 나머지(FAILED·CANCELED 만) → failed.
 */
export function planStatusFrom(items: ReadonlyArray<{ status: string; activeApproval: boolean }>): PlanStatusValue {
  if (items.length === 0) return 'draft';
  if (items.some((i) => (PLAN_IN_FLIGHT_ITEM_STATUSES as readonly string[]).includes(i.status))) return 'executing';
  if (items.every((i) => i.status === 'PLANNED')) {
    const approved = items.filter((i) => i.activeApproval).length;
    if (approved === 0) return 'draft';
    return approved === items.length ? 'approved' : 'partially_approved';
  }
  if (items.every((i) => i.status === 'CONFIRMED')) return 'completed';
  if (items.every((i) => i.status === 'CANCELED')) return 'canceled';
  if (items.some((i) => i.status === 'CONFIRMED' || i.status === 'PARTIAL')) return 'partial';
  if (items.some((i) => (PLAN_NEEDS_USER_ITEM_STATUSES as readonly string[]).includes(i.status))) return 'attention';
  return 'failed';
}

// ---- 입력 스키마 ----

export const cancelSchema = z.object({});
export const reconcileSchema = z.object({});
export const retrySchema = z.object({});
/** PUT /api/distribution-items/{id}/mock-scenario(개발용 — 모의 계정 항목만). */
export const mockScenarioSchema = z
  .object({
    scenario: z.enum(MOCK_SCENARIO_VALUES),
    delay_ms: z.coerce.number().int().min(0).max(MOCK_SCENARIO_MAX_DELAY_MS).optional(),
  })
  .strict();
export type MockScenarioInput = z.infer<typeof mockScenarioSchema>;
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

/** FIX-T11(P0): heartbeat 가 lease 를 잃었음을 알릴 때(다른 worker 가 복구·조회 중) — 어댑터는 부작용 없이 멈춘다. */
export class LeaseLostError extends Error {
  constructor() {
    super('lease lost');
    this.name = 'LeaseLostError';
  }
}

export class NothingToReconcileError extends AppError {
  constructor() {
    super('conflict', 'nothing_to_reconcile', '원격 재확인이 필요한 작업이 없습니다(확인 중·결과 불명·원격 처리 중인 항목만 재확인합니다)');
  }
}

/** T12(D19): 보류(BLOCKED) 항목 재시도 불가. code 로 이유를 구분한다. */
export class NotRetryableError extends AppError {
  constructor(code: 'not_retryable' | 'approval_required' | 'attempts_exhausted' | 'outcome_unknown', message: string, details?: Record<string, unknown>) {
    super('conflict', code, message, details);
  }
}

/** T12: 모의 시나리오는 모의(MOCK) 계정 항목에만. */
export class NotMockAccountError extends AppError {
  constructor() {
    super('bad_request', 'not_mock_account', '모의 시나리오는 모의(MOCK) 계정 항목에만 정할 수 있습니다(실제 채널에는 없는 개념)');
  }
}

/** T14(D26): 항목의 어댑터(일반 모의·Threads 모의)에 맞지 않는 모의 시나리오. */
export class ScenarioNotApplicableError extends AppError {
  constructor(adapter: AdapterId) {
    super(
      'bad_request',
      'scenario_not_applicable',
      adapter === 'mock_threads'
        ? '이 항목은 Threads 모의 연결 계정이라 threads_* 시나리오(또는 success)만 정할 수 있습니다'
        : adapter === 'mock_youtube'
          ? '이 항목은 YouTube 모의 연결 계정이라 youtube_* 시나리오(또는 success)만 정할 수 있습니다'
          : 'threads_*·youtube_* 시나리오는 모의 연결(OAuth)한 Threads·YouTube 계정 항목에만 정할 수 있습니다',
      { adapter },
    );
  }
}

/** 화면·API 문구: 취소 확인 중. */
export const CANCEL_PENDING_MESSAGE = '취소 확인 중';
