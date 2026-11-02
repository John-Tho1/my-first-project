/**
 * FIX2-FULLREV2(G15): 인증 없는 로그인 경로의 반복 거부를 감사 행 대신(또는 상한을 넘은 뒤) 서버 로그로만 남긴다.
 * 사유 **이름**만(값·식별자·요청 내용 없음), 같은 사유는 프로세스당 1분에 한 번 — warnOidcNotConfigured(lib/oidc.ts)와 같은 방식.
 */
export const AUTH_DENIAL_LOG_INTERVAL_MS = 60_000;
const lastLogAt = new Map<string, number>();

export function warnAuthDenialThrottled(reason: string, now: number = Date.now()): void {
  const last = lastLogAt.get(reason);
  if (last !== undefined && now - last < AUTH_DENIAL_LOG_INTERVAL_MS) return;
  lastLogAt.set(reason, now);
  console.warn(`[auth] login_denied_not_audited: ${reason}`);
}

/** 시험용: 간격 기록을 비운다. */
export function resetAuthDenialLogForTests(): void {
  lastLogAt.clear();
}
