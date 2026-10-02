/**
 * T10 배포함 — 폼 → API 입력, 폼 오류 리다이렉트, 화면 문구(서버 전용).
 * 모든 성공 문구에는 MOCK 이 들어가고 "게시 완료" 같은 말은 쓰지 않는다(M3 은 모의 실행만, 실제 게시 없음).
 */
import {
  AppError,
  CREDENTIAL_STATUS_LABEL,
  formatMskInline,
  MOCK_SCENARIO_VALUES,
  recordedAdapterIdOf,
  scenarioApplies,
  type AdapterId,
  type CredentialStatus,
} from '@cs/domain';
import { errorResponse, seeOther } from './api';

export const MAX_DISTRIBUTION_REQUEST = 64 * 1024;

export const PLAN_STATUS_LABEL: Record<string, string> = {
  draft: '승인 전',
  partially_approved: '일부 승인',
  approved: '승인됨(실행 전)',
  executing: '처리 중(MOCK)',
  partial: '부분 성공(MOCK — 성공한 항목은 다시 보내지 않음)',
  attention: '확인 필요',
  completed: '처리 끝(MOCK — 실제 발행 아님)',
  canceled: '취소됨',
  failed: '실패',
};

export const ITEM_STATUS_LABEL: Record<string, string> = {
  PLANNED: '계획됨(실행 전)',
  QUEUED: 'QUEUED · 대기',
  BLOCKED: 'BLOCKED · 보류',
  SENDING: 'SENDING · 전송 중',
  REMOTE_PROCESSING: 'REMOTE_PROCESSING · 원격 처리 중',
  CONFIRMED: 'CONFIRMED · MOCK 확인(실제 발행 아님)',
  RETRY_WAIT: 'RETRY_WAIT · 재시도 대기',
  RECONCILING: 'RECONCILING · 등록 여부 확인 필요',
  UNKNOWN: 'UNKNOWN · 확인 불가 — 자동 재전송 안 함, 재확인 또는 새 계획 필요',
  CANCEL_REQUESTED: 'CANCEL_REQUESTED · 취소 확인 중',
  CANCELED: '취소됨',
  FAILED: '실패',
  PARTIAL: '일부',
};

export const VISIBILITY_LABEL: Record<string, string> = { private: '비공개(private)', unlisted: '일부 공개(unlisted)', public: '공개(public)' };

export const PROBLEM_LABEL: Record<string, string> = {
  variant_changed: '채널 초안이 새 버전으로 바뀜',
  variant_not_review: '채널 초안이 검토 상태가 아님',
  content_changed: '원고가 바뀜',
  assets_changed: '첨부 파일이 바뀜',
  account_changed: '계정 상태·연결이 바뀜',
  payload_changed: '배포 내용이 스냅샷과 다름',
  schedule_passed: '예약 시각이 지남',
  brand_changed: '브랜드 프로필이 새 버전으로 바뀜',
  publish_at_passed: '예약 공개 시각(publishAt)이 지남',
};

export function problemLabel(p: string): string {
  if (p.startsWith('blocked:')) return `검토 차단: ${p.slice('blocked:'.length)}`;
  return PROBLEM_LABEL[p] ?? p;
}

export const DISTRIBUTE_ERROR_TEXT: Record<string, string> = {
  hash_mismatch: '화면에서 본 내용과 서버의 배포 내용(hash)이 다릅니다. 새로 고친 뒤 다시 확인하세요.',
  snapshot_stale: '계획 이후 본문·미디어·원고·계정·일정이 바뀌어 승인·실행하지 않았습니다. 새 배포 계획을 만드세요.',
  confirm_required: '"내용을 확인했습니다"를 체크해야 승인할 수 있습니다.',
  no_items: '승인할 항목을 하나 이상 고르세요(기본 선택 없음).',
  already_approved: '이미 승인한 항목입니다.',
  item_not_planned: '실행 전(PLANNED) 항목만 승인할 수 있습니다.',
  approval_required: '유효한 승인이 없어 실행하지 않았습니다(아무것도 대기열에 넣지 않음).',
  already_executed: '이미 실행한 항목입니다. 중복 작업을 만들지 않았습니다.',
  already_revoked: '이미 철회했거나 무효가 된 승인입니다.',
  purpose_mismatch: '승인 목적이 항목과 다릅니다.',
  command_key_reused: '이 실행 키는 다른 계획에 쓰였습니다. 새로 고친 뒤 다시 시도하세요.',
  variant_not_review: '검토 중인 채널 초안만 배포 계획에 넣을 수 있습니다.',
  stale_variant: '원문이 바뀐 채널 초안입니다. 다시 초안을 만들고 검토한 뒤 계획을 만드세요.',
  media_incomplete: '채널에 필요한 미디어가 부족합니다.',
  unconfirmed_experience_claims: '확인하지 않은 1인칭 경험 주장이 있습니다.',
  channel_mismatch: '채널 초안의 채널과 계정 플랫폼이 다릅니다.',
  account_not_ready: '배포 계정이 준비되지 않았습니다.',
  account_credential_blocked: '배포 계정 연결이 만료·해제되었거나 다시 연결이 필요합니다. 설정 → 배포 계정 연결에서 다시 연결한 뒤 실행하세요.',
  mock_only: '모의(MOCK) 계정은 모의 실행만 할 수 있습니다.',
  schedule_in_past: '예약 시각은 지금부터 1분 뒤 이후여야 합니다(모스크바 시각).',
  invalid_schedule: '예약 날짜·시각 형식을 확인하세요(모스크바 시각).',
  duplicate_item: '같은 채널 초안·계정 조합이 두 번 들어 있습니다.',
  asset_deleted: '원본을 지운 첨부 파일이 있어 배포할 수 없습니다.',
  csrf: '요청 출처를 확인할 수 없어 거부했습니다.',
  invalid: '입력값을 확인하세요.',
  conflict: '다른 곳에서 먼저 바뀌었습니다. 새로 고친 뒤 다시 시도하세요.',
  live_blocked: '실제 채널 게시는 허용·구현되지 않았습니다(외부로 아무것도 보내지 않음).',
  not_cancellable: '이미 끝났거나 실행 전인 항목은 취소할 수 없습니다.',
  cancel_unknown: '결과를 확인할 수 없는 항목(UNKNOWN)은 취소를 확정할 수 없습니다. 먼저 재확인하세요(자동 재전송은 하지 않습니다).',
  nothing_to_reconcile: '재확인할 작업이 없습니다(확인 중·결과 불명·원격 처리 중인 항목만 재확인합니다).',
  not_retryable: '보류(BLOCKED)된 작업이 있는 항목만 재시도할 수 있습니다.',
  attempts_exhausted: '시도 한도에 이르렀습니다. 새 배포 계획을 만드세요.',
  outcome_unknown: '마지막 전송 결과를 알 수 없어 다시 보내지 않았습니다. 재확인을 먼저 하세요.',
  not_mock_account: '모의 시나리오는 모의(MOCK) 계정 항목에만 정할 수 있습니다.',
  item_finished: '이미 끝난 항목은 모의 시나리오를 바꿀 수 없습니다.',
  scenario_not_applicable:
    '이 항목의 모의 어댑터(일반 모의·Threads 모의·YouTube 모의)에 맞지 않는 시나리오입니다. threads_* 는 모의 연결한 Threads 계정, youtube_* 는 모의 연결한 YouTube 계정 항목에만 쓸 수 있습니다.',
  // T15(D27): YouTube 모의 연결 계정의 목적·공개 범위·예약 공개 규칙
  requested_result_not_supported: '모의 연결한 YouTube 계정은 비공개 업로드 또는 공개 게시 계획만 만들 수 있습니다(결과는 MOCK).',
  visibility_mismatch: '요청 결과와 공개 범위가 맞지 않습니다(비공개 업로드 = private, 공개 게시 = public·unlisted 또는 private + 예약 공개).',
  publish_at_not_supported: '예약 공개(publishAt)는 YouTube 항목에만 정할 수 있습니다.',
  publish_at_requires_public_publish: '비공개 업로드 계획에는 예약 공개를 넣을 수 없습니다(공개 계획으로 따로 승인해야 합니다).',
  publish_at_requires_private: '예약 공개는 private 영상에만 정할 수 있습니다.',
  publish_at_before_send: '예약 공개 시각은 업로드 시작 시각보다 뒤여야 합니다.',
  server: '서버 오류가 발생했습니다.',
};

const PASS = new Set(Object.keys(DISTRIBUTE_ERROR_TEXT));

/** 폼 실패: 401 → /login, 404 → notFoundHref, 그 밖 → back?error=<code>. */
export function distributeFormFailure(e: unknown, request: Request, back: string, notFoundHref = '/distribute?missing=1'): Response {
  const res = errorResponse(e, request);
  if (res.status === 401) {
    const headers = new Headers();
    const cookie = res.headers.get('set-cookie');
    if (cookie) headers.set('set-cookie', cookie);
    return seeOther('/login', headers);
  }
  if (res.status === 404) return seeOther(notFoundHref);
  let code = 'server';
  if (res.status === 503) code = 'live_blocked';
  else if (e instanceof AppError) {
    if (PASS.has(e.code)) code = e.code;
    else if (e.kind === 'csrf') code = 'csrf';
    else if (e.kind === 'conflict') code = 'conflict';
    else if (e.kind === 'bad_request') code = 'invalid';
  }
  const sep = back.includes('?') ? '&' : '?';
  return seeOther(`${back}${sep}error=${code}`);
}

/** /distribute/new 폼 → planCreateSchema 입력. 체크한(use_<variant>=on) 파생본만 항목이 된다(기본 선택 없음). */
export function formToPlanCreate(f: Record<string, string>) {
  const items: Array<Record<string, unknown>> = [];
  for (const [k, v] of Object.entries(f)) {
    if (!k.startsWith('use_') || v !== 'on') continue;
    const vid = k.slice(4);
    const date = (f[`date_${vid}`] ?? '').trim();
    const time = (f[`time_${vid}`] ?? '').trim();
    items.push({
      variant_id: vid,
      channel_account_id: f[`account_${vid}`] ?? '',
      visibility: f[`visibility_${vid}`] || undefined,
      schedule: date || time ? { date, time } : undefined,
    });
  }
  return { items, target_summary: f.target_summary || undefined };
}

/**
 * /distribute/{id} 승인 폼 → approveSchema 입력. 항목 체크박스(item_<id>=on)는 기본 해제, 숨은 hash_<id> 는 화면에 보인 hash.
 * confirm 체크박스가 없으면 confirm=false 로 넘겨 스키마가 거부한다.
 */
export function formToApprove(f: Record<string, string>) {
  const itemIds = Object.entries(f)
    .filter(([k, v]) => k.startsWith('item_') && v === 'on')
    .map(([k]) => k.slice(5));
  const expected: Record<string, string> = {};
  for (const [k, v] of Object.entries(f)) if (k.startsWith('hash_')) expected[k.slice(5)] = v;
  return { item_ids: itemIds, expected_hashes: expected, confirm: f.confirm === 'yes', purpose: f.purpose ?? '' };
}

export function formToExecute(f: Record<string, string>) {
  return { command_key: f.command_key ?? '' };
}

/** 결과 종류 → 화면 문구(CONFIRMED ≠ 공개: 비공개 업로드·예약·게시를 구분한다, A12). */
export const RESULT_KIND_LABEL: Record<string, string> = {
  UPLOADED_PRIVATE: '비공개 업로드',
  SCHEDULED_REMOTE: '원격 예약',
  PUBLISHED: '게시',
  MANUAL_REPORTED: '수동 기록',
};

const BLOCK_REASON_LABEL: Record<string, string> = {
  approval_missing: '승인 없음/변경됨',
  approval_revoked: '승인 철회됨',
  approval_invalidated: '승인 무효(내용 변경)',
  snapshot_stale: '승인 없음/변경됨(내용 변경)',
  auth: '계정 인증 필요(자동 재시도 안 함)',
  execution_not_allowed: '실행 모드가 허용하지 않음',
  account_missing: '계정 없음',
  // T13: 연결 정보 차단(보내지 않음 — 다시 연결 뒤 재시도)
  credential_blocked: '계정 연결 만료·해제 — 다시 연결 필요(보내지 않음)',
  credential_expired: '계정 연결 만료 — 다시 연결 필요(보내지 않음)',
  credential_revoked: '계정 연결 해제됨 — 다시 연결 필요(보내지 않음)',
  credential_needs_reconnect: '계정 다시 연결 필요(보내지 않음)',
  credential_error: '계정 연결 오류 — 다시 연결 필요(보내지 않음)',
  // T14: Threads 모의 어댑터의 401·연결 정보 문제(원격 호출 없음 또는 거절)
  auth_invalid_token: '계정 다시 연결 필요(401 — 자동 재시도 안 함)',
  credential_unavailable: '계정 다시 연결 필요(연결 정보를 쓸 수 없음 — 보내지 않음)',
  credential_missing: '계정 다시 연결 필요(연결 정보 없음 — 보내지 않음)',
  secrets_not_configured: '서버 암호화 키 없음 — 연결 정보를 열 수 없음(보내지 않음)',
};

/** T14(D26): 요청 제한으로 기다리는 재시도 대기(로컬 제한 또는 원격 429). */
const RATE_LIMIT_CODES = new Set(['local_rate_limited', 'rate_limited', 'quota_exceeded']);
export const isRateLimitWait = (job: { state: string; lastErrorCode: string | null }) => job.state === 'RETRY_WAIT' && RATE_LIMIT_CODES.has(job.lastErrorCode ?? '');
/** FIX-T15: web tick 의 조각 예산을 쓰고 양보한 업로드(장애 아님 — 다음 처리에서 같은 세션으로 이어 올림). */
export const isUploadSliceWait = (job: { state: string; lastErrorCode: string | null }) => job.state === 'RETRY_WAIT' && job.lastErrorCode === 'upload_slice_yield';

interface JobLike {
  state: string;
  attempt: number;
  maxAttempts: number;
  nextRunAt: Date;
  lastErrorCode: string | null;
}

interface PubLike {
  permalink: string | null;
  resultKind: string;
  isMock: boolean;
}

/**
 * 작업 상태 한 줄(docs/03 상태 분리 문구). 예: `RETRY_WAIT · 재시도 대기 (2/5, 다음 18:04 MSK)`,
 * `CONFIRMED · MOCK 게시 확인 (mock://threads/…)`. 모의 결과는 항상 MOCK 을 붙이고 "게시 완료"라고 하지 않는다.
 */
export function jobStatusText(job: JobLike, pub?: PubLike | null, blockReason?: string | null, channel?: string): string {
  switch (job.state) {
    case 'QUEUED':
      return 'QUEUED · 대기';
    case 'LEASED':
      return 'LEASED · 처리 시작(아직 보내지 않음)';
    case 'SENDING':
      return 'SENDING · 전송 중';
    case 'REMOTE_PROCESSING':
      return 'REMOTE_PROCESSING · 원격 처리 중(확인 대기)';
    case 'RETRY_WAIT':
      // T15: YouTube 는 할당량(업로드 시작 수) — "할당량 소진"
      if (isRateLimitWait(job)) return `RETRY_WAIT · ${channel === 'youtube' ? '할당량 소진' : '요청 제한'} — ${mskHourMinute(job.nextRunAt)} 이후 재시도`;
      if (isUploadSliceWait(job)) return 'RETRY_WAIT · 업로드 진행 중 — 다음 처리에서 같은 세션으로 이어 올림';
      return `RETRY_WAIT · 재시도 대기 (${job.attempt}/${job.maxAttempts}, 다음 ${mskHourMinute(job.nextRunAt)})`;
    case 'RECONCILING':
      return 'RECONCILING · 등록 여부 확인 필요';
    case 'UNKNOWN':
      return 'UNKNOWN · 확인 불가 — 자동 재전송 안 함, 재확인 또는 새 계획 필요';
    case 'CANCEL_REQUESTED':
      return 'CANCEL_REQUESTED · 취소 확인 중';
    case 'CANCELED':
      return 'CANCELED · 취소됨(보내지 않음)';
    case 'FAILED':
      return `FAILED · 실패${job.lastErrorCode ? ` (${job.lastErrorCode})` : ''}`;
    case 'BLOCKED':
      return `BLOCKED · ${BLOCK_REASON_LABEL[blockReason ?? job.lastErrorCode ?? ''] ?? '보류'}`;
    case 'CONFIRMED': {
      const kind = pub ? (RESULT_KIND_LABEL[pub.resultKind] ?? pub.resultKind) : '결과';
      const mock = !pub || pub.isMock ? 'MOCK ' : '';
      return `CONFIRMED · ${mock}${kind} 확인${pub?.permalink ? ` (${pub.permalink})` : ''}`;
    }
    default:
      return job.state;
  }
}

// ---- T12(D19): 항목 상태 문구·모의 시나리오 ----

/** 개발용 모의 시나리오 선택지(값 → 설명). 실제 채널 개념이 아니다. */
export const MOCK_SCENARIO_LABEL: Record<(typeof MOCK_SCENARIO_VALUES)[number], string> = {
  success: '성공(공개 범위 그대로, YouTube 는 비공개 업로드 → 확인)',
  success_public: '공개 결과(payload 가 public 일 때만, 아니면 거절)',
  processing_then_confirm: '원격 처리 중 → 조회에서 확인',
  transient: '일시 오류(503, 보내지 않음) 반복',
  transient_then_success: '첫 시도 일시 오류 → 재시도 성공',
  rate_limited: '요청 제한(429, Retry-After 5초) 반복',
  server_error_no_side_effect: '서버 오류(503, 부작용 없음) 반복',
  server_error_side_effect_unknown: '서버 오류(쓰기 뒤 5xx — 결과 불명, 조회)',
  permanent: '형식 오류(400) — 재시도 안 함',
  auth: '인증 만료(401) — 계정 다시 연결 필요',
  ambiguous_sent: '응답 유실(원격은 받음) — 조회로 확인',
  ambiguous_not_sent: '연결 끊김(원격에 없음) — 조회 뒤 재시도',
  hang: '응답 없음(시간 초과) — 조회',
  cancel_supported: '원격 취소 지원(처리 중 → 취소 가능)',
  reconcile_unsupported: '원격 조회 불가 — 3회 뒤 확인 불가(UNKNOWN)',
  // T14(D26): Threads 모의 어댑터(모의 연결 계정)
  threads_success: 'Threads 모의: 컨테이너 → 게시 성공',
  threads_container_slow: 'Threads 모의: 컨테이너 처리 지연 → 원격 처리 중 → 같은 컨테이너로 게시',
  threads_publish_timeout_sent: 'Threads 모의: 게시 응답 유실(원격은 게시함) — 조회로 확인, 다시 게시 안 함',
  threads_publish_timeout_not_sent: 'Threads 모의: 게시 시간 초과(원격 게시 안 됨) — 조회 뒤 같은 컨테이너로 게시',
  threads_thread_partial: 'Threads 모의: 3번째 게시물 5xx(결과 불명) — 앞 게시물은 다시 게시 안 함',
  threads_rate_limited: 'Threads 모의: 요청 제한(429, Retry-After 5초) 한 번',
  threads_token_invalid: 'Threads 모의: 토큰 거절(401) — 계정 다시 연결 필요',
  threads_text_too_long: 'Threads 모의: 형식 오류(400 글자 수) — 재시도 안 함',
  // T15(D27): YouTube 모의 어댑터(모의 연결 계정 — 재개 업로드)
  youtube_success_private: 'YouTube 모의: 재개 업로드 → 처리 → 비공개 업로드 확인',
  youtube_processing_slow: 'YouTube 모의: 업로드 뒤 처리 지연(조회 3회) → 확인',
  youtube_network_drop: 'YouTube 모의: 50% 지점에서 연결 끊김 → 같은 세션으로 이어 올리기',
  youtube_response_lost_after_complete: 'YouTube 모의: 마지막 조각 응답 유실(원격은 받음) — 조회로 확인, 다시 올리지 않음',
  youtube_session_expired_before_complete: 'YouTube 모의: 업로드 중 세션 만료(영상 없음 확인) → 새 세션',
  youtube_quota_exceeded: 'YouTube 모의: 할당량 초과(403 quotaExceeded) → 초기화 시각까지 대기',
  youtube_token_invalid: 'YouTube 모의: 토큰 거절(401) — 계정 다시 연결 필요',
  youtube_rejected: 'YouTube 모의: 업로드 뒤 처리 거부(rejected) — 실패, 재시도 안 함',
  youtube_public_unverified_forced_private: 'YouTube 모의: 미검증 프로젝트 — public 요청도 비공개로 강제',
  youtube_scheduled_private: 'YouTube 모의: 검증된 프로젝트 + 예약 공개(payload 의 publish_at) → 원격 예약',
  youtube_project_verified: 'YouTube 모의(시험·개발 전용): 검증된 프로젝트 — public 요청이면 공개 결과',
};

export const MOCK_SCENARIO_OPTIONS = MOCK_SCENARIO_VALUES.map((v) => ({ value: v, label: `${v} — ${MOCK_SCENARIO_LABEL[v]}` }));

/** T14: 항목 어댑터에 맞는 시나리오 선택지만(일반 모의 ↔ Threads 모의). */
export function mockScenarioOptionsFor(adapter: AdapterId) {
  return MOCK_SCENARIO_OPTIONS.filter((o) => scenarioApplies(adapter, o.value));
}

/** T14: 원격 단계 한 줄 — `게시물 2/3 · 컨테이너 생성됨 · mockthr_ct_…`. 모의 ID 만, "게시 완료" 라고 하지 않는다. */
export const REMOTE_STEP_LABEL: Record<string, string> = {
  'container:created': '컨테이너 생성됨',
  'container:finished': '컨테이너 준비됨',
  'container:error': '컨테이너 오류',
  'publish:published': '게시됨(MOCK)',
};
export function remoteStepLine(step: { kind: string; status: string; postIndex: number; remoteId: string }, total: number): string {
  const label = REMOTE_STEP_LABEL[`${step.kind}:${step.status}`] ?? `${step.kind} ${step.status}`;
  return `게시물 ${step.postIndex + 1}/${total} · ${label} · ${step.remoteId}`;
}

/**
 * T15(D27): YouTube 재개 업로드 진행 한 줄 — `업로드 50% (0.2/0.3 MB) · 세션 재개 1회`. 세션 URI 는 넣지 않는다(`세션 있음`만).
 * received·total 은 원격이 확인한 값(remote_steps). 100% 여도 "게시"가 아니다.
 */
export function youtubeProgressLine(p: { received: number | null; total: number | null; resumes: number; sessions: number }): string {
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
  const total = p.total ?? 0;
  const received = Math.min(p.received ?? 0, total);
  const pct = total > 0 ? Math.floor((received / total) * 100) : 0;
  const extra = p.sessions > 1 ? ` · 새 세션 ${p.sessions - 1}회(만료)` : '';
  return `업로드 ${pct}% (${mb(received)}/${mb(total)} MB) · 세션 재개 ${p.resumes}회${extra}`;
}

/** T15: YouTube 단계 상태 문구(모의 ID 만 — 세션 URI 는 `세션 있음`). */
export const YOUTUBE_STEP_LABEL: Record<string, string> = {
  'upload_session:created': '업로드 세션 진행 중(세션 있음)',
  'upload_session:finished': '업로드 세션 완료(모든 바이트 받음)',
  'upload_session:expired': '업로드 세션 만료(영상 없음 확인)',
  'upload_session:error': '업로드 세션 오류',
  'video:uploaded': '영상 업로드됨 — 처리 중',
  'video:processed': '영상 처리 끝(MOCK)',
  'video:error': '영상 처리 실패·거부',
};

const mskClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hour12: false });

/** `HH:mm MSK` (재시도 대기 표시). */
export function mskHourMinute(d: Date): string {
  return `${mskClock.format(d)} MSK`;
}

/** 승인 문제로 보류된 이유(항목은 PLANNED 로 돌아가 있다 — 다시 승인 후 실행). */
export const APPROVAL_BLOCK_REASONS = new Set(['approval_missing', 'approval_revoked', 'approval_invalidated', 'snapshot_stale']);

export interface BlockEventLike {
  stateAfter: string;
  sanitizedDetails: unknown;
}

/** 보류 이유: code = 판단에 쓰는 표준 코드, detail = 상세 사유(예: 'invalidated:assets_changed' — 화면에 따로 보인다). */
export interface BlockInfo {
  code: string | null;
  detail: string | null;
}

/**
 * FIX-T12(P2, Codex review-T12 lib/distribution.ts:269): 최근 BLOCKED 이벤트(최신 먼저)와 작업의 lastErrorCode 에서 보류 이유를 정한다.
 * 승인 철회·무효 여부는 **구조화된 코드**(이벤트 event·lastErrorCode·reason 중 APPROVAL_BLOCK_REASONS 에 있는 것)로 먼저 판단하고,
 * 'invalidated:<이유>'·사용자 철회 사유 같은 상세 reason 은 detail 로 따로 돌려준다(상세 사유가 표준 코드를 가리지 않게).
 */
export function blockInfoOf(events: readonly BlockEventLike[], job: { lastErrorCode: string | null } | null): BlockInfo {
  const ev = events.find((e) => e.stateAfter === 'BLOCKED');
  const d = (ev?.sanitizedDetails ?? {}) as { reason?: unknown; event?: unknown };
  const evCode = typeof d.event === 'string' && d.event ? d.event : null;
  const reason = typeof d.reason === 'string' && d.reason ? d.reason : null;
  const last = job?.lastErrorCode ?? null;
  const approvalCode = [evCode, last, reason].find((c): c is string => c !== null && APPROVAL_BLOCK_REASONS.has(c)) ?? null;
  const code = approvalCode ?? reason ?? last ?? evCode;
  return { code, detail: reason && reason !== code ? reason : null };
}

/** 상세 보류 사유 문구('invalidated:assets_changed' → '첨부 파일이 바뀜', 'user: …' → 사용자 사유). */
export function blockDetailLabel(detail: string | null): string | null {
  if (!detail) return null;
  if (detail.startsWith('invalidated:')) return problemLabel(detail.slice('invalidated:'.length));
  if (detail === 'user') return '사용자 철회';
  if (detail.startsWith('user:')) return `사용자 철회: ${detail.slice('user:'.length).trim()}`;
  return problemLabel(detail);
}

/**
 * FIX-T11(P2, Codex review-T11 page.tsx:267): 승인 철회 뒤 안내 — 철회 사실과 **저장된 작업 결과**를 구분한다(추측하지 않는다).
 * blocked = 철회로 BLOCKED 가 된 작업 수(대기·재시도 대기 → 다음 전송 차단), cancelRequested = 이미 전송 단계라 CANCEL_REQUESTED 로 기록된 수.
 * 수가 없으면(이전 링크) 작업 결과를 말하지 않는다.
 */
/**
 * FIX-T11 round 2(P2, Codex review-FIX-T11T12 page.tsx:28): 철회 리다이렉트의 결과 수(revoked_blocked·revoked_cancel) 파싱 — 페이지가 이것을 쓴다.
 * 0 이상 정수(최대 3자리)만, 없거나 잘못된 값이면 null(작업 결과를 말하지 않는다).
 */
export function revocationCountParam(v: string | string[] | undefined): number | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return /^\d{1,3}$/.test(t) ? Number(t) : null;
}

export function revocationNotice(blocked: number | null, cancelRequested: number | null): string {
  const parts = ['승인을 철회했습니다(MOCK).'];
  if (blocked === null && cancelRequested === null) return parts[0]!;
  if (blocked) parts.push(`대기·재시도 대기 중이던 작업 ${blocked}개는 보류(BLOCKED) — 다음 전송이 차단되었습니다.`);
  if (cancelRequested) {
    parts.push(`이미 전송 단계에 들어간 작업 ${cancelRequested}개는 취소 확인 중입니다 — 원격 결과를 확인한 뒤 취소됨 또는 "취소 불가(이미 전송됨)"으로 표시됩니다.`);
  }
  if (!blocked && !cancelRequested) parts.push('대기 중이던 작업은 없었습니다.');
  return parts.join(' ');
}

export interface ItemHeadlineInput {
  status: string;
  channel: string;
  job: (JobLike & { lastRetryClass?: string | null }) | null;
  pub: PubLike | null;
  blockReason: string | null;
  /** FIX-T12: 상세 보류 사유(표준 코드와 별도) */
  blockDetail?: string | null;
  /** FIX-T12: 활성 승인이 있는지(없으면서 작업이 BLOCKED 인 PLANNED 항목 = 승인 문제) */
  activeApproval?: boolean;
  /** FIX-T12: 스냅샷이 지금 행과 달라 이 계획을 다시 승인할 수 없음(snapshotProblems 있음) */
  needsNewPlan?: boolean;
  /** T15: YouTube 원격 예약 공개 시각(승인 스냅샷 provider_metadata.publish_at) — 원격 예약 문구에 쓴다 */
  publishAt?: string | null;
  /** T15: 영상 업로드 뒤 삭제는 범위 밖 — 취소 요청 뒤 업로드가 확인된 항목 */
  cancelTooLate?: boolean;
}

/**
 * 항목 상태 한 줄(docs/03·docs/05 문구). 성공은 항상 MOCK 결과이며 "게시 완료"·"공개 게시 성공"이라고 하지 않는다.
 * YouTube 비공개 업로드는 `비공개 업로드 완료, 공개 전환 확인 필요`(A12).
 */
export function itemHeadline(x: ItemHeadlineInput): string {
  const job = x.job;
  const reason = x.blockReason ?? job?.lastErrorCode ?? '';
  switch (x.status) {
    case 'PLANNED': {
      // 작업이 BLOCKED 로 남은 PLANNED 항목은 승인 문제다(표준 코드가 승인 코드이거나, 활성 승인이 없음 — 예: 401 보류 뒤 편집으로 승인 무효).
      // FIX-T12 round 2(P2): 지금 활성 승인이 있으면(다시 승인함) 과거 작업의 보류 사유보다 우선한다 — "승인 없음"이라고 하지 않는다.
      if (x.activeApproval === true) return '계획됨(실행 전)';
      const approvalProblem = job?.state === 'BLOCKED' && (APPROVAL_BLOCK_REASONS.has(reason) || x.activeApproval === false);
      if (!approvalProblem) return '계획됨(실행 전)';
      const detail = blockDetailLabel(x.blockDetail ?? null);
      if (x.needsNewPlan) return `승인 무효${detail ? ` (${detail})` : ''} — 내용이 바뀌어 이 계획은 다시 승인할 수 없습니다. 새 계획 만들기`;
      return `승인 없음${detail ? ` (${detail})` : ''} — 다시 승인 후 실행`;
    }
    case 'QUEUED':
      return '대기 중(QUEUED)';
    case 'SENDING':
      return '전송 중(MOCK)';
    case 'REMOTE_PROCESSING':
      return x.channel === 'youtube' ? '비공개 업로드 처리 중 — 확인 대기' : '원격 처리 중 — 확인 대기';
    case 'RETRY_WAIT':
      if (job && isRateLimitWait(job)) return `${x.channel === 'youtube' ? '할당량 소진' : '요청 제한'} — ${mskHourMinute(job.nextRunAt)} 이후 재시도`;
      if (job && isUploadSliceWait(job)) return '비공개 업로드 진행 중 — 다음 처리에서 이어 올림';
      return job ? `재시도 대기 (${job.attempt}/${job.maxAttempts}, 다음 ${mskHourMinute(job.nextRunAt)})` : '재시도 대기';
    case 'RECONCILING':
      return '등록 여부 확인 필요';
    case 'UNKNOWN':
      // FIX-T14: 스레드 일부가 게시된 뒤 취소(요청) — 남은 부분은 보내지 않음, 게시된 부분은 원격에 남음(취소 성공이라고 하지 않는다 A11)
      if (reason === 'thread_partial_canceled' || reason === 'thread_partial_cancel_requested') return '일부만 게시됨(MOCK) — 취소 뒤 남은 게시물은 보내지 않음, 게시된 부분은 원격에 남음';
      return '확인 불가 — 자동 재전송 안 함, 재확인 또는 새 계획 필요';
    case 'CANCEL_REQUESTED':
      return '취소 확인 중';
    case 'CANCELED':
      return '취소됨';
    case 'FAILED':
      return `실패${job?.lastErrorCode ? ` (${job.lastErrorCode})` : ''} — 자동 재시도 안 함`;
    case 'BLOCKED':
      if (!job) return '보류 — 복원된 항목(원격 결과 확인 필요, 자동 재전송 안 함)';
      if (reason === 'auth' || job.lastRetryClass === 'auth' || reason === 'mock_401_unauthorized' || reason === 'auth_invalid_token') return '계정 다시 연결 필요';
      if (APPROVAL_BLOCK_REASONS.has(reason)) return '승인 없음 — 다시 승인 후 실행';
      return `보류 — ${BLOCK_REASON_LABEL[reason] ?? reason ?? '확인 필요'}`;
    case 'CONFIRMED': {
      const kind = x.pub?.resultKind;
      if (x.channel === 'youtube') {
        // T15(D27): CONFIRMED ≠ 공개. 원격이 보고한 결과 종류로만 말하고 "게시 완료"라고 하지 않는다(A12).
        const tail = x.cancelTooLate ? ' · 업로드됨 — 삭제는 별도 동작(범위 밖)' : '';
        if (kind === 'UPLOADED_PRIVATE') return `비공개 업로드 완료, 공개 전환 확인 필요${tail}`;
        if (kind === 'SCHEDULED_REMOTE') {
          const at = x.publishAt && Number.isFinite(Date.parse(x.publishAt)) ? formatMskInline(x.publishAt) : '시각 미확인';
          return `비공개 업로드 + 예약 공개 ${at} (원격 예약, 확인 필요)${tail}`;
        }
        if (kind === 'PUBLISHED') return `공개 게시 확인(MOCK)${tail}`;
      }
      if (kind === 'UPLOADED_PRIVATE') return x.channel === 'youtube' ? '비공개 업로드 완료, 공개 전환 확인 필요' : 'MOCK 비공개 결과 확인';
      if (kind === 'SCHEDULED_REMOTE') return 'MOCK 원격 예약 확인';
      if (kind === 'PUBLISHED') return 'MOCK 공개 결과 확인';
      return 'MOCK 결과 확인';
    }
    default:
      return ITEM_STATUS_LABEL[x.status] ?? x.status;
  }
}

// ---- M3 화면 FIX(D8): 수동 재확인 결과 4종 ----

export type ReconciledKind = 'found' | 'not_found' | 'unsupported' | 'unknown' | 'stale' | 'resumable';

/** 재확인 결과(원격 조회 상태) → 리다이렉트 값. processing·unknown 은 "확인 못 함(unknown)" — 없다는 뜻이 아니다. */
export function reconciledParam(remote: string): ReconciledKind {
  if (remote === 'found' || remote === 'not_found' || remote === 'unsupported' || remote === 'resumable') return remote;
  return 'unknown';
}

export const RECONCILED_TEXT: Record<ReconciledKind, string> = {
  found: '원격에서 결과를 찾았습니다(MOCK — 실제 발행 실적 아님).',
  not_found: '원격에서 결과를 찾지 못했습니다. 상태는 그대로이며 다시 보내지 않았습니다.',
  unsupported: '이 채널은 원격 조회를 지원하지 않아 확인하지 못했습니다. 원격에 없다는 뜻이 아닙니다. 다시 보내지 않았습니다.',
  unknown: '원격 상태를 확인하지 못했습니다(진행 중이거나 기록이 없음). 없다는 뜻이 아닙니다. 다시 보내지 않았습니다.',
  stale: '조회하는 사이 작업 상태(시도)가 바뀌어 조회 결과를 적용하지 않았습니다. 아래 현재 상태를 확인하세요. 다시 보내지 않았습니다.',
  resumable:
    '원격에 아직 게시되지 않은 단계가 있습니다(저장된 컨테이너로 이어서 게시할 수 있음). 재확인은 조회만 했고 게시하지 않았습니다 — 확인 중 작업은 작업 처리기가 같은 컨테이너로 이어 갑니다.',
};

/** 쿼리 reconciled 값 → 고정 문구. 알 수 없는 값·여러 값이면 null(아무 결과도 말하지 않는다). */
export function reconciledNotice(v: string | string[] | undefined): string | null {
  if (typeof v !== 'string') return null;
  return Object.hasOwn(RECONCILED_TEXT, v) ? RECONCILED_TEXT[v as ReconciledKind] : null;
}

// ---- M3 화면 FIX(D5): 성공 배너는 쿼리가 아니라 저장된 상태로 ----

export interface BannerStateInput {
  items: ReadonlyArray<{
    item: { status: string };
    activeApproval: unknown;
    jobs: ReadonlyArray<{ state: string }>;
    /** 가장 최근 작업의 이력(새 것부터) — 재시도 배너는 최근 이벤트가 사용자 재시도(unblock·user_retry)일 때만 */
    events?: ReadonlyArray<{ sanitizedDetails: unknown }>;
  }>;
}

export interface PlanBanners {
  /** 지금 활성 승인이 있는 항목 수(≥1 일 때만, 아니면 null) */
  approved: number | null;
  /** 작업이 있는 항목 수·작업 수(작업 ≥1 일 때만) + 같은 실행 요청 재제출 표시 */
  executed: { items: number; jobs: number; replay: boolean } | null;
  /** 실제로 CANCELED 인 항목·작업이 있을 때만 */
  canceled: boolean;
  /** 실제로 CANCEL_REQUESTED 인 항목·작업이 있을 때만 */
  cancelRequested: boolean;
  /** 가장 최근 작업이 QUEUED 이고 그 마지막 이벤트가 사용자 재시도(unblock, cause=user_retry)인 항목이 있을 때만 */
  retried: boolean;
}

const flag = (v: string | string[] | undefined) => typeof v === 'string' && v.trim() !== '';

/**
 * 성공 배너(승인·실행·취소·재시도)는 쿼리 문자열이 "보여 달라"고 할 때 저장된 상태가 그것을 뒷받침하면만 보이고, 수는 상태에서 센다.
 * 쿼리만 바꿔서(예: 미승인·작업 0건 계획에 ?approved=1&executed=1) 승인·실행했다고 말하게 할 수 없다.
 * 정보성 배너(created·ticked·scenario_saved)와 철회 배너(revoked_*, 이미 저장된 결과 수만 말함)는 이 함수 밖이다.
 */
export function bannersFromState(q: Record<string, string | string[] | undefined>, d: BannerStateInput): PlanBanners {
  const approvedItems = d.items.filter((x) => x.activeApproval != null).length;
  const jobItems = d.items.filter((x) => x.jobs.length > 0).length;
  const jobCount = d.items.reduce((n, x) => n + x.jobs.length, 0);
  // Codex review-FIX-M3screen P1: 취소됨과 취소 확인 중은 서로 다른 조건(한쪽 상태로 다른 쪽 문구를 띄우지 않는다).
  const anyIn = (state: string) => d.items.some((x) => x.item.status === state || x.jobs.some((j) => j.state === state));
  // P2: 재시도 배너는 첫 실행의 QUEUED 가 아니라 기록된 사용자 재시도(최근 작업의 마지막 이벤트 = unblock·user_retry, 아직 QUEUED)일 때만.
  const retriedNow = d.items.some((x) => {
    const latest = x.jobs.at(-1);
    const last = x.events?.[0]?.sanitizedDetails as { event?: unknown; transition?: unknown; cause?: unknown } | null | undefined;
    return latest?.state === 'QUEUED' && (last?.transition ?? last?.event) === 'unblock' && last?.cause === 'user_retry';
  });
  return {
    approved: flag(q.approved) && approvedItems > 0 ? approvedItems : null,
    executed: flag(q.executed) && jobCount > 0 ? { items: jobItems, jobs: jobCount, replay: q.replay === '1' } : null,
    canceled: q.canceled === '1' && anyIn('CANCELED'),
    cancelRequested: q.cancel_requested === '1' && anyIn('CANCEL_REQUESTED'),
    retried: q.retried === '1' && retriedNow,
  };
}


// ---- 화면 확인 D10: /distribute/new 오류 뒤 입력값 되살리기 ----

const ECHO_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ECHO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ECHO_TIME = /^\d{2}:\d{2}$/u;
const ECHO_VIS = new Set(['private', 'unlisted', 'public']);
const ECHO_NAME_MAX = 200;

export interface PlanFormDefaults {
  /** 체크했던 파생본 id */
  use: Set<string>;
  account: Record<string, string>;
  visibility: Record<string, string>;
  date: Record<string, string>;
  time: Record<string, string>;
  name: string;
}

/**
 * 계획 만들기 폼 → 오류 리다이렉트에 붙일 쿼리(`&e_…`). 형식이 맞는 값만(파생본·계정 UUID, 공개 범위 목록, 날짜 YYYY-MM-DD, 시각 HH:mm, 이름 200자).
 * 승인은 이 화면에 없다 — 계획 화면의 승인 체크("내용을 확인했습니다")는 되살리지 않는다(의도적으로 매번 새로).
 */
export function planFormEcho(f: Record<string, string>): string {
  const p = new URLSearchParams();
  const use: string[] = [];
  const vids = new Set<string>();
  for (const k of Object.keys(f)) {
    const m = /^(use|account|visibility|date|time)_(.+)$/u.exec(k);
    if (m && ECHO_UUID.test(m[2]!.toLowerCase())) vids.add(m[2]!.toLowerCase());
  }
  for (const vid of [...vids].sort()) {
    if (f[`use_${vid}`] === 'on') use.push(vid);
    const acc = (f[`account_${vid}`] ?? '').toLowerCase();
    if (ECHO_UUID.test(acc)) p.set(`e_acc_${vid}`, acc);
    const vis = f[`visibility_${vid}`] ?? '';
    if (ECHO_VIS.has(vis)) p.set(`e_vis_${vid}`, vis);
    const date = (f[`date_${vid}`] ?? '').trim();
    if (ECHO_DATE.test(date)) p.set(`e_date_${vid}`, date);
    const time = (f[`time_${vid}`] ?? '').trim();
    if (ECHO_TIME.test(time)) p.set(`e_time_${vid}`, time);
  }
  if (use.length) p.set('e_use', use.join(','));
  const name = Array.from((f.target_summary ?? '').trim()).slice(0, ECHO_NAME_MAX).join('');
  if (name) p.set('e_name', name);
  const qs = p.toString();
  return qs ? `&${qs}` : '';
}

/** 쿼리(`e_…`) → 폼 기본값. 형식이 틀린 값은 버린다(화면에는 React 가 escape 해서 넣는다). */
export function planFormDefaults(q: Record<string, string | string[] | undefined>): PlanFormDefaults {
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : '');
  const d: PlanFormDefaults = { use: new Set(), account: {}, visibility: {}, date: {}, time: {}, name: '' };
  for (const vid of one('e_use').split(',')) if (ECHO_UUID.test(vid)) d.use.add(vid);
  for (const k of Object.keys(q)) {
    const m = /^e_(acc|vis|date|time)_(.+)$/u.exec(k);
    if (!m || !ECHO_UUID.test(m[2]!)) continue;
    const v = one(k);
    if (m[1] === 'acc' && ECHO_UUID.test(v)) d.account[m[2]!] = v;
    if (m[1] === 'vis' && ECHO_VIS.has(v)) d.visibility[m[2]!] = v;
    if (m[1] === 'date' && ECHO_DATE.test(v)) d.date[m[2]!] = v;
    if (m[1] === 'time' && ECHO_TIME.test(v)) d.time[m[2]!] = v;
  }
  d.name = Array.from(one('e_name')).slice(0, ECHO_NAME_MAX).join('');
  return d;
}

// ---- M4 화면 FIX(S1): 단계 패널은 기록된 어댑터 기준 ----

export interface StepsPanelInput {
  /** 계정의 현재 선택(@cs/domain adapterIdFor) — 전송 의도가 아직 없을 때만 쓴다 */
  currentAdapter: AdapterId | null;
  /** 가장 최근 작업의 가장 최근 전송 의도(없으면 null) */
  latestIntent: { sanitizedDetails: Record<string, unknown> | null } | null;
  /** 계정 플랫폼(threads·youtube·…) */
  platform: string | null;
  remoteStepKinds: readonly string[];
}

export interface StepsPanelView {
  /** 보일 단계 패널(없으면 null) */
  panel: 'threads' | 'youtube' | null;
  /** 패널을 고른 어댑터(기록을 읽을 수 없으면 null) */
  adapter: AdapterId | null;
  /** intent = 전송 의도에 기록된 어댑터, current = 아직 보낸 적 없어 현재 선택, none = 계정 없음 */
  source: 'intent' | 'current' | 'none';
  /** 단계 목록 대신 보일 한 줄(일반 모의 어댑터로 처리됨 · 기록 확인 불가). null 이면 단계 목록·진행 안내를 그대로 보인다 */
  note: string | null;
}

const PLATFORM_STEP_NAME: Record<'threads' | 'youtube', string> = { threads: 'Threads 단계', youtube: 'YouTube 업로드 단계' };

/**
 * M4 화면 FIX(S1, D26 후속 규칙): 단계 패널의 어댑터는 **가장 최근 전송 의도에 기록된 어댑터**(recordedAdapterIdOf — adapter_id 없음·null 이면
 * mock_generic)로 고른다. 전송 의도가 아직 없을 때만 계정의 현재 선택(adapterIdFor)을 쓴다. 일반 모의 어댑터로 처리된 Threads·YouTube 항목은
 * "진행 예정" 안내 대신 "일반 모의 어댑터로 처리됨 — 단계 기록 없음(MOCK)"을 보인다. 표시 전용 — 판정·실행에는 쓰지 않는다.
 */
export function stepsPanelView(x: StepsPanelInput): StepsPanelView {
  const hasSteps = (kinds: readonly string[]) => x.remoteStepKinds.some((k) => kinds.includes(k));
  const threadsSteps = hasSteps(['container', 'publish']);
  const youtubeSteps = hasSteps(['upload_session', 'video']);
  const platformPanel = x.platform === 'threads' || x.platform === 'youtube' ? x.platform : null;
  let adapter: AdapterId | null;
  let source: StepsPanelView['source'];
  if (x.latestIntent) {
    adapter = recordedAdapterIdOf(x.latestIntent.sanitizedDetails).id;
    source = 'intent';
  } else {
    adapter = x.currentAdapter;
    source = x.currentAdapter ? 'current' : 'none';
  }
  const panel: StepsPanelView['panel'] =
    adapter === 'mock_threads' || threadsSteps ? 'threads' : adapter === 'mock_youtube' || youtubeSteps ? 'youtube' : null;
  if (panel) return { panel, adapter, source, note: null };
  if (source === 'intent' && platformPanel) {
    const name = PLATFORM_STEP_NAME[platformPanel];
    if (adapter === 'mock_generic') return { panel: platformPanel, adapter, source, note: `일반 모의 어댑터로 처리됨 — ${name} 기록 없음(MOCK)` };
    return { panel: platformPanel, adapter, source, note: `전송 의도에 기록된 어댑터를 확인할 수 없음 — ${name} 표시 안 함(MOCK)` };
  }
  return { panel: null, adapter, source, note: null };
}

// ---- M4 화면 FIX(S3): 배포함 「배포 계정」 연결 상태 ----

export interface AccountHealthLike {
  status: CredentialStatus;
  usable_for_execution: boolean;
  credential_required: boolean;
  pending_reconcile: string | null;
  mock: boolean;
}

/**
 * M4 화면 FIX(S3): 설정 화면과 같은 연결 상태(@cs/db listAccountHealth → @cs/domain credentialHealth·CREDENTIAL_STATUS_LABEL)를 한 줄로.
 * 정리 대기(pending_reconcile)가 있으면 "정리 대기 차단"을 먼저 보인다. 실행이 막히는 계정은 "배포 실행 차단"을 붙인다.
 */
export function accountHealthLine(a: AccountHealthLike): { label: string; warn: boolean; text: string } {
  const label = a.pending_reconcile ? '정리 대기 차단' : (CREDENTIAL_STATUS_LABEL[a.status] ?? a.status);
  const blocked = a.credential_required && !a.usable_for_execution;
  const parts = [label];
  if (a.status === 'not_connected' && a.mock && !blocked) parts.push('모의 배포는 연결 없이 가능(결과는 MOCK)');
  if (blocked) parts.push('배포 실행 차단');
  return { label, warn: !a.usable_for_execution, text: parts.join(' — ') };
}
