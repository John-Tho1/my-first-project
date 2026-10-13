/**
 * 인증 규칙(T02, 결정 D3) — 서버 전용 순수 함수. Next 에 의존하지 않아 단위 테스트가 가능하다.
 *
 * 로그인 수단은 둘이다.
 * - dev: 비밀번호 없는 개발용 세션 모드(D3). APP_BASE_URL 이 localhost/127.0.0.1 일 때만 허용한다.
 *   T21-P1a(G1a): 운영 빌드(NODE_ENV 가 development·test·없음 이외)에서는 dev 로그인을 거부한다(config.ts isDevAuthAllowedForNodeEnv).
 * - oidc(T21-P1b): 일반 OpenID Connect(oidc.ts · @cs/providers oidc-login.ts · /api/auth/oidc/start·callback). 이 모드에서는
 *   식별자 입력 로그인(POST /api/auth/login)을 거부한다(IdentityLoginDisabledError).
 * 자체 비밀번호·암호 알고리즘은 구현하지 않는다. 세션 토큰은 CSPRNG 난수, DB 에는 sha256 해시만 저장한다.
 * 로그인 시도 횟수 제한: T21-P1a 에서 추가(전역 15분 창, 아래 assertLoginNotRateLimited).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isDevAuthAllowedForNodeEnv, type AppConfig } from './config';
import {
  CsrfError,
  DevLoginNotAllowedError,
  DevLoginRefusedInProductionError,
  IdentityLoginDisabledError,
  LoginRateLimitedError,
} from './errors';

export const SESSION_COOKIE_NAME = 'cs_session';
/** last_seen_at 갱신 최소 간격 */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

export function isLocalhostBaseUrl(baseUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return false;
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.has(u.hostname);
}

/** AUTH_MODE=dev 로그인은 localhost 기본 URL 에서만 허용한다. */
export function assertDevLoginAllowed(config: Pick<AppConfig, 'APP_BASE_URL'>): void {
  if (!isLocalhostBaseUrl(config.APP_BASE_URL)) throw new DevLoginNotAllowedError();
}

/**
 * 식별자 입력 로그인(POST /api/auth/login) 전에 호출. oidc → IdentityLoginDisabledError(T21-P1b — OIDC 로그인은 /api/auth/oidc/start),
 * dev → 실행 환경 검사(T21-P1a) 후 localhost 검사.
 * nodeEnv 는 호출 측이 반드시 넘긴다(web 은 빌드 때 고정되는 `process.env.NODE_ENV`). production 등이면
 * 설정 객체가 어떻게 만들어졌든 dev 로그인을 거부한다(loadConfig 의 거부와 겹치는 두 번째 방어선).
 */
export function assertLoginAvailable(
  config: Pick<AppConfig, 'AUTH_MODE' | 'APP_BASE_URL'>,
  nodeEnv: string | undefined,
): void {
  if (config.AUTH_MODE === 'oidc') throw new IdentityLoginDisabledError();
  if (!isDevAuthAllowedForNodeEnv(nodeEnv)) throw new DevLoginRefusedInProductionError();
  assertDevLoginAllowed(config);
}

// ---- 로그인 시도 횟수 제한(T21-P1a) ----

/** 실패를 세는 시간 창. */
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
/** 시간 창 안에서 허용하는 실패 횟수. 이만큼 실패가 쌓이면 다음 시도부터 429. */
export const LOGIN_MAX_FAILURES = 10;
/**
 * 실패로 세는 감사 사유(auth.login_denied 의 details.reason). 설정 거부(not_allowed 등)는 세지 않는다.
 * T21-P1b: OIDC callback 의 검증 실패(oidc_invalid — state 없음·만료·재사용·다른 브라우저·code 교환 거절·ID token 검증 실패)와
 * 허용 신원 불일치(oidc_identity_mismatch — email·email_verified·sub)도 같은 전역 창에서 센다. IdP 장애(oidc_provider_error)·
 * IdP 쪽 취소(oidc_cancelled)는 세지 않는다(공격자가 만들 수 없는 실패이거나 자격 증명을 시험하지 않음).
 */
export const LOGIN_FAILURE_REASONS = ['identity_mismatch', 'invalid_request', 'oidc_invalid', 'oidc_identity_mismatch'] as const;

/**
 * 전역(식별자·IP 와 무관) 시간 창 제한. IP 는 프록시 헤더로 위조할 수 있고 식별자별로 세면 다른 식별자를 계속 바꿔 넣을 수 있으므로
 * 전체 실패 수로 센다. 마지막 성공 로그인 이전의 실패는 세지 않는다(호출 측이 그렇게 센 값을 넘긴다).
 * 대가: 시간 창 안에서는 주인도 새로 로그인할 수 없다(이미 있는 세션은 그대로). 창이 지나면 풀린다.
 */
export function assertLoginNotRateLimited(failuresInWindow: number): void {
  if (failuresInWindow >= LOGIN_MAX_FAILURES) throw new LoginRateLimitedError();
}

/**
 * 식별자 비교(상수 시간). 길이 차이로 인한 조기 종료를 피하려고 양쪽을 sha256 으로 같은 길이로 만든 뒤
 * crypto.timingSafeEqual 로 비교한다.
 */
export function identityMatches(input: string, allowed: string): boolean {
  const a = createHash('sha256').update(input, 'utf8').digest();
  const b = createHash('sha256').update(allowed, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** `owner@example.local` → `ow***@example.local`. '@' 가 없으면 앞 2글자 + `***`. */
export function maskIdentity(identity: string): string {
  const at = identity.lastIndexOf('@');
  const local = at >= 0 ? identity.slice(0, at) : identity;
  const domain = at >= 0 ? identity.slice(at) : '';
  return `${Array.from(local).slice(0, 2).join('')}***${domain}`;
}

// ---- 세션 토큰 ----

/** 32바이트 CSPRNG 난수의 base64url(43자). 쿠키에만 존재하고 DB 에는 해시만 저장한다. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function isWellFormedSessionToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

/** sha256 hex(64자). */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function hashUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  return createHash('sha256').update(ua.slice(0, 1024), 'utf8').digest('hex');
}

export function sessionTtlMs(config: Pick<AppConfig, 'AUTH_SESSION_TTL_MINUTES'>): number {
  return config.AUTH_SESSION_TTL_MINUTES * 60 * 1000;
}

export interface SessionState {
  expiresAt: Date;
  revokedAt: Date | null;
}

/** expires_at > now 이고 revoked_at 이 없을 때만 유효. */
export function isSessionActive(s: SessionState, now: Date): boolean {
  return s.revokedAt === null && s.expiresAt.getTime() > now.getTime();
}

export function shouldTouchSession(lastSeenAt: Date, now: Date): boolean {
  return now.getTime() - lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS;
}

// ---- 쿠키 ----

export function resolveCookieSecure(config: Pick<AppConfig, 'AUTH_COOKIE_SECURE' | 'APP_BASE_URL'>): boolean {
  if (config.AUTH_COOKIE_SECURE === 'true') return true;
  if (config.AUTH_COOKIE_SECURE === 'false') return false;
  // auto: http://localhost·127.0.0.1 만 Secure 없이(브라우저가 http 에서 Secure 쿠키를 버리므로), 나머지는 Secure.
  try {
    const u = new URL(config.APP_BASE_URL);
    return !(u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname));
  } catch {
    return true;
  }
}

/** Cookie 헤더에서 이름으로 값 하나를 꺼낸다. 없거나 형식이 이상하면 null. */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}

type CookieConfig = Pick<AppConfig, 'AUTH_COOKIE_SECURE' | 'APP_BASE_URL' | 'AUTH_SESSION_TTL_MINUTES'>;

export function buildSessionCookie(token: string, config: CookieConfig): string {
  const attrs = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${config.AUTH_SESSION_TTL_MINUTES * 60}`,
  ];
  if (resolveCookieSecure(config)) attrs.push('Secure');
  return attrs.join('; ');
}

export function buildClearedSessionCookie(config: Pick<AppConfig, 'AUTH_COOKIE_SECURE' | 'APP_BASE_URL'>): string {
  const attrs = [`${SESSION_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (resolveCookieSecure(config)) attrs.push('Secure');
  return attrs.join('; ');
}

// ---- CSRF ----

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

function originOf(value: string | null): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * 상태 변경 요청(POST/PUT/PATCH/DELETE)의 출처 검사.
 * - Origin(없으면 Referer)의 origin 이 APP_BASE_URL 의 origin 과 같아야 한다. 둘 다 없으면 거부.
 * - Sec-Fetch-Site 가 있으면 same-origin 또는 none 이어야 한다.
 * GET/HEAD 는 상태를 바꾸지 않으므로 검사하지 않는다.
 */
export function assertSameOrigin(
  request: { method: string; headers: { get(name: string): string | null } },
  config: Pick<AppConfig, 'APP_BASE_URL'>,
): void {
  if (!STATE_CHANGING.has(request.method.toUpperCase())) return;
  const expected = new URL(config.APP_BASE_URL).origin;
  const originHeader = request.headers.get('origin');
  // Origin: null(불투명 출처)은 Referer 로 대체하지 않고 거부한다.
  const actual = originHeader !== null ? originOf(originHeader) : originOf(request.headers.get('referer'));
  if (actual === null || actual !== expected) throw new CsrfError();
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && !ALLOWED_FETCH_SITES.has(site.toLowerCase())) throw new CsrfError();
}
