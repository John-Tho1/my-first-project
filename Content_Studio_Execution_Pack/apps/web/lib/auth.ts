/**
 * 접근 제어 진입점(서버 전용).
 * - route handler: requireOwner(request) — 요청의 Cookie 헤더를 직접 읽는다(Next 내부 API 불필요, 테스트 용이).
 * - server component: getSession() — next/headers 의 cookies() 로 원문을 읽고 같은 검증 함수를 쓴다.
 *   server component 는 쿠키를 지울 수 없으므로(Next 제약) 만료·폐기 세션이면 /login 으로 보내기만 한다.
 *   만료 쿠키는 다음 API 응답(401) 또는 다음 로그인에서 지워지거나 덮어써진다.
 */
import { cookies } from 'next/headers';
import { SESSION_COOKIE_NAME } from '@cs/domain';
import { getAppDb, getConfig } from './server';
import { validateSessionToken, type OwnerSession } from './session';

export { requireOwner, validateSessionCookie, validateSessionToken, type OwnerSession } from './session';

export async function getSession(): Promise<OwnerSession | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value ?? null;
  if (!token) return null;
  const config = getConfig();
  const { db } = await getAppDb(config);
  return validateSessionToken(db, token, config);
}
