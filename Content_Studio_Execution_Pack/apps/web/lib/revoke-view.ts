/**
 * M4UI FIX1: 설정 화면 "연결 해제" HTML 폼의 결과 → 리다이렉트 · 화면 문구(서버 전용, 값 없이 코드만).
 * revokeCredential 의 outcome 이 incomplete(FIX6-T13)면 "해제했습니다"라고 하지 않는다 — 연결 정보가 남아 있고 이 계정은 계속 차단된다.
 * query 에는 허용 목록의 코드만 싣는다(원문 오류·토큰·암호문 없음).
 */

/** revokeCredential 의 incomplete 이유(@cs/db RevokeIncompleteCode) — 이 목록 밖의 값은 query 에 싣지 않는다. */
export const REVOKE_INCOMPLETE_CODES = ['revoke_current_no_key', 'revoke_current_unreadable', 'revoke_provider_unavailable', 'revoke_current_seal_failed'] as const;
export type RevokeIncompleteCodeView = (typeof REVOKE_INCOMPLETE_CODES)[number];

const ALLOWED = new Set<string>(REVOKE_INCOMPLETE_CODES);

const BLOCKED = '연결 정보는 지우지 않았고, 이 계정은 해제 중으로 남아 배포 실행이 계속 차단됩니다.';
// Codex FIX-M4UI P2: 재시도와 완료를 구분한다 — 원인이 해결되지 않으면 재시도해도 끝나지 않을 수 있다.
const RESUME = '원인이 해결되고 재개 조건이 갖춰지면 작업 처리기가 같은 해제 작업을 다시 시도합니다(연결 해제를 다시 눌러도 같은 작업으로 이어집니다). 해제가 끝날 때까지 이 계정의 배포 실행은 차단됩니다.';

/** incomplete 이유별 문구(무엇이 막혔는지 · 차단 유지 · 다음에 일어나는 일). */
export const REVOKE_INCOMPLETE_TEXT: Record<RevokeIncompleteCodeView | 'unknown', string> = {
  revoke_current_no_key: `연결 해제가 끝나지 않았습니다 — 서버 비밀 암호화 키(SECRETS_MASTER_KEY)가 설정되지 않아 저장된 연결 정보를 열지 못했습니다. ${BLOCKED} 키를 설정하면 ${RESUME}`,
  revoke_current_unreadable: `연결 해제가 끝나지 않았습니다 — 저장된 연결 정보를 지금 키로 열 수 없습니다(키 버전을 모르거나 키가 맞지 않음). ${BLOCKED} 연결 정보를 봉인한 키(이전 키 버전 포함)를 설정하면 ${RESUME}`,
  revoke_provider_unavailable: `연결 해제가 끝나지 않았습니다 — 이 계정의 연결 공급자를 지금 쓸 수 없어 원격 철회를 하지 못했습니다. ${BLOCKED} 공급자를 쓸 수 있게 되면 ${RESUME}`,
  revoke_current_seal_failed: `연결 해제가 끝나지 않았습니다 — 철회 기록을 저장하지 못했습니다. ${BLOCKED} 잠시 뒤 연결 해제를 다시 누르세요. ${RESUME}`,
  unknown: `연결 해제가 끝나지 않았습니다. ${BLOCKED} 잠시 뒤 연결 해제를 다시 누르세요. ${RESUME}`,
};

export const REVOKE_DONE_TEXT = '연결을 해제했습니다. 다시 연결하기 전까지 이 계정으로는 배포하지 않습니다.';
export const REVOKE_SUPERSEDED_TEXT = '이 요청의 해제 작업은 끝났지만 그 뒤 계정이 다시 연결되었거나 새 해제가 시작되었습니다. 그 새 연결·해제는 건드리지 않았습니다 — 아래 계정 상태를 확인하세요.';

/** 연결 해제 HTML 폼의 리다이렉트 경로. incomplete → ?revoke=incomplete(&revoke_code=허용 코드), superseded → ?revoke=superseded, 그 밖(끝남) → ?revoked=1. */
export function revokeRedirectPath(outcome: string, incompleteCode: string | null | undefined): string {
  if (outcome === 'incomplete') {
    const code = incompleteCode && ALLOWED.has(incompleteCode) ? `&revoke_code=${incompleteCode}` : '';
    return `/settings?revoke=incomplete${code}#accounts`;
  }
  if (outcome === 'superseded') return '/settings?revoke=superseded#accounts';
  return '/settings?revoked=1#accounts';
}

/** 설정 화면 query → 연결 해제 결과 문구. warn=true 는 끝나지 않음(경고 표시). 해당 없으면 undefined. */
export function revokeNotice(q: { revoked?: string | undefined; revoke?: string | undefined; code?: string | undefined }): { text: string; warn: boolean } | undefined {
  if (q.revoke === 'incomplete') {
    const key = q.code && ALLOWED.has(q.code) ? (q.code as RevokeIncompleteCodeView) : 'unknown';
    return { text: REVOKE_INCOMPLETE_TEXT[key], warn: true };
  }
  if (q.revoke === 'superseded') return { text: REVOKE_SUPERSEDED_TEXT, warn: true };
  if (q.revoked) return { text: REVOKE_DONE_TEXT, warn: false };
  return undefined;
}
