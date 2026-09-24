/**
 * 세션 검증(서버 전용). Next 내부 API 에 의존하지 않으므로 route handler 와 통합 테스트에서 그대로 쓴다.
 * - 쿠키 원문 → 형식 검사 → sha256 → DB 의 유효 세션(expires_at > now, revoked_at IS NULL) 조회
 * - 세션 owner 의 식별자가 현재 AUTH_ALLOWED_IDENTITY 와 다르면 거부(allowlist 가 바뀌면 기존 세션도 무효)
 * - last_seen_at 은 5분에 한 번만 갱신
 */
import { findActiveSession, touchSession, type Db } from '@cs/db';
import {
  hashSessionToken,
  identityMatches,
  isWellFormedSessionToken,
  readCookie,
  SESSION_COOKIE_NAME,
  shouldTouchSession,
  UnauthorizedError,
  type AppConfig,
} from '@cs/domain';
import { getAppDb, getConfig } from './server';

export interface OwnerSession {
  ownerId: string;
  sessionId: string;
  expiresAt: Date;
  /** 화면 표시는 maskIdentity 로 가려서 쓴다 */
  identity: string;
}

export async function validateSessionToken(
  db: Db,
  token: string | null | undefined,
  config: Pick<AppConfig, 'AUTH_ALLOWED_IDENTITY'>,
  now: Date = new Date(),
): Promise<OwnerSession | null> {
  if (!token || !isWellFormedSessionToken(token)) return null;
  const row = await findActiveSession(db, hashSessionToken(token), now);
  if (!row) return null;
  if (!identityMatches(row.identity, config.AUTH_ALLOWED_IDENTITY)) return null;
  if (shouldTouchSession(row.lastSeenAt, now)) await touchSession(db, row.sessionId, now);
  return { ownerId: row.ownerId, sessionId: row.sessionId, expiresAt: row.expiresAt, identity: row.identity };
}

/** Cookie 헤더 원문으로 세션을 검증한다. */
export async function validateSessionCookie(
  db: Db,
  cookieHeader: string | null | undefined,
  config: Pick<AppConfig, 'AUTH_ALLOWED_IDENTITY'>,
  now: Date = new Date(),
): Promise<OwnerSession | null> {
  return validateSessionToken(db, readCookie(cookieHeader, SESSION_COOKIE_NAME), config, now);
}

export interface RequestContext {
  config: AppConfig;
  db: Db;
}

/** route handler 용: 요청의 쿠키로 owner 를 확인한다. 없거나 만료·폐기면 UnauthorizedError(401). */
export async function requireOwner(
  request: Request,
  ctx?: RequestContext,
): Promise<OwnerSession & RequestContext> {
  const config = ctx?.config ?? getConfig();
  const db = ctx?.db ?? (await getAppDb(config)).db;
  const session = await validateSessionCookie(db, request.headers.get('cookie'), config);
  if (!session) throw new UnauthorizedError();
  return { ...session, config, db };
}
