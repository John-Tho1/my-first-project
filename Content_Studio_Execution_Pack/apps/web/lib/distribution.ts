/**
 * T10 배포함 — 폼 → API 입력, 폼 오류 리다이렉트, 화면 문구(서버 전용).
 * 모든 성공 문구에는 MOCK 이 들어가고 "게시 완료" 같은 말은 쓰지 않는다(M3 은 모의 실행만, 실제 게시 없음).
 */
import { AppError } from '@cs/domain';
import { errorResponse, seeOther } from './api';

export const MAX_DISTRIBUTION_REQUEST = 64 * 1024;

export const PLAN_STATUS_LABEL: Record<string, string> = {
  draft: '승인 전',
  partially_approved: '일부 승인',
  approved: '승인됨(실행 전)',
  executing: '실행 대기열(MOCK)',
  partial: '일부 처리',
  completed: '처리 끝',
  canceled: '취소됨',
  failed: '실패',
};

export const ITEM_STATUS_LABEL: Record<string, string> = {
  PLANNED: '계획됨(실행 전)',
  QUEUED: '대기열(MOCK)',
  BLOCKED: '보류(BLOCKED)',
  SENDING: '전송 중',
  REMOTE_PROCESSING: '원격 처리 중',
  CONFIRMED: '확인됨',
  RETRY_WAIT: '재시도 대기',
  RECONCILING: '확인 중',
  UNKNOWN: '결과 불명(UNKNOWN)',
  CANCEL_REQUESTED: '취소 요청됨',
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
