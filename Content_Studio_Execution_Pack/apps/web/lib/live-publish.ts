/**
 * LIVE-P2(결정 D39): 실제 게시 즉시 중지·재개 폼의 결과·오류 문구(쿼리 값을 그대로 출력하지 않는다 — 코드별 고정 문구만).
 */
import { AppError } from '@cs/domain';
import { seeOther } from './api';

export const LIVE_PUBLISH_SECTION = '#live-publish';

export const LIVE_PUBLISH_ERROR_TEXT: Record<string, string> = {
  live_resume_confirm_required: "재개하지 않았습니다 — 확인 칸에 '재개'를 정확히 입력해야 합니다.",
  csrf: '요청 출처를 확인할 수 없어 거부했습니다.',
  bad_request: '요청 형식이 올바르지 않습니다.',
  server: '처리하지 못했습니다. 잠시 뒤 다시 시도하세요(상태는 바꾸지 않았습니다).',
};

export const LIVE_PUBLISH_DONE_TEXT: Record<string, string> = {
  paused: '실제 게시를 일시 중지했습니다 — 지금부터 실제 게시 전송은 보내지 않고 보류합니다(모의 전송은 그대로). 이미 게시를 시도한 항목의 확인은 계속됩니다.',
  resumed: "실제 게시를 재개했습니다 — 보류된 항목은 '재시도'를 눌러야 다시 보냅니다.",
};

/** 폼 실패 → 설정 화면 "실제 게시" 구역으로(로그인 없으면 로그인 화면). */
export function livePublishFormFailure(e: unknown): Response {
  if (e instanceof AppError && e.kind === 'unauthorized') return seeOther('/login');
  let code = e instanceof AppError ? e.code : 'server';
  if (!(code in LIVE_PUBLISH_ERROR_TEXT)) code = 'server';
  return seeOther(`/settings?live_error=${encodeURIComponent(code)}${LIVE_PUBLISH_SECTION}`);
}
