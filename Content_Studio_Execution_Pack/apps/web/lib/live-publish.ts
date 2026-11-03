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

/** FIX3-FULLREV2(G11): 쿼리와 저장된 스위치가 맞지 않을 때(다른 탭에서 바꿈·뒤로 가기) 완료 문구 대신 쓰는 중립 문구. */
export const LIVE_PUBLISH_DONE_STALE_TEXT = "실제 게시 스위치가 그 뒤 다시 바뀌었습니다 — 지금 상태는 아래 '상태'를 보세요.";

/**
 * FIX3-FULLREV2(G11, D21 원칙): 쿼리(?live_publish=)는 "보여 달라"는 신호일 뿐 — 완료 문구는 저장된 스위치와 맞을 때만(paused ∧ 중지 중, resumed ∧ 켜짐).
 * 맞지 않으면 중립 문구(stale), 모르는 값·없음은 undefined(아무것도 안 그림).
 */
export function livePublishDoneBanner(query: string | undefined, paused: boolean): { text: string; stale: boolean } | undefined {
  if (query !== 'paused' && query !== 'resumed') return undefined;
  const matches = query === 'paused' ? paused : !paused;
  return matches ? { text: LIVE_PUBLISH_DONE_TEXT[query]!, stale: false } : { text: LIVE_PUBLISH_DONE_STALE_TEXT, stale: true };
}

/** 폼 실패 → 설정 화면 "실제 게시" 구역으로(로그인 없으면 로그인 화면). */
export function livePublishFormFailure(e: unknown): Response {
  if (e instanceof AppError && e.kind === 'unauthorized') return seeOther('/login');
  let code = e instanceof AppError ? e.code : 'server';
  if (!(code in LIVE_PUBLISH_ERROR_TEXT)) code = 'server';
  return seeOther(`/settings?live_error=${encodeURIComponent(code)}${LIVE_PUBLISH_SECTION}`);
}
