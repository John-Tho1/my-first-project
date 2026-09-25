/**
 * T10 배포함 — 폼 → API 입력, 폼 오류 리다이렉트, 화면 문구(서버 전용).
 * 모든 성공 문구에는 MOCK 이 들어가고 "게시 완료" 같은 말은 쓰지 않는다(M3 은 모의 실행만, 실제 게시 없음).
 */
import { AppError, MOCK_SCENARIO_VALUES } from '@cs/domain';
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
};

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
export function jobStatusText(job: JobLike, pub?: PubLike | null, blockReason?: string | null): string {
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
};

export const MOCK_SCENARIO_OPTIONS = MOCK_SCENARIO_VALUES.map((v) => ({ value: v, label: `${v} — ${MOCK_SCENARIO_LABEL[v]}` }));

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
      return job ? `재시도 대기 (${job.attempt}/${job.maxAttempts}, 다음 ${mskHourMinute(job.nextRunAt)})` : '재시도 대기';
    case 'RECONCILING':
      return '등록 여부 확인 필요';
    case 'UNKNOWN':
      return '확인 불가 — 자동 재전송 안 함, 재확인 또는 새 계획 필요';
    case 'CANCEL_REQUESTED':
      return '취소 확인 중';
    case 'CANCELED':
      return '취소됨';
    case 'FAILED':
      return `실패${job?.lastErrorCode ? ` (${job.lastErrorCode})` : ''} — 자동 재시도 안 함`;
    case 'BLOCKED':
      if (!job) return '보류 — 복원된 항목(원격 결과 확인 필요, 자동 재전송 안 함)';
      if (reason === 'auth' || job.lastRetryClass === 'auth' || reason === 'mock_401_unauthorized') return '계정 다시 연결 필요';
      if (APPROVAL_BLOCK_REASONS.has(reason)) return '승인 없음 — 다시 승인 후 실행';
      return `보류 — ${BLOCK_REASON_LABEL[reason] ?? reason ?? '확인 필요'}`;
    case 'CONFIRMED': {
      const kind = x.pub?.resultKind;
      if (kind === 'UPLOADED_PRIVATE') return x.channel === 'youtube' ? '비공개 업로드 완료, 공개 전환 확인 필요' : 'MOCK 비공개 결과 확인';
      if (kind === 'SCHEDULED_REMOTE') return 'MOCK 원격 예약 확인';
      if (kind === 'PUBLISHED') return 'MOCK 공개 결과 확인';
      return 'MOCK 결과 확인';
    }
    default:
      return ITEM_STATUS_LABEL[x.status] ?? x.status;
  }
}
