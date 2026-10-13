/**
 * T21-P1b(T21_DEPLOY_REVIEW G1): 운영 로그인 — 일반 OpenID Connect(AUTH_MODE=oidc), 단일 owner. IdP 는 정하지 않는다(설정으로만).
 *
 * 이 파일은 순수 규칙만 둔다(네트워크 없음): 설정 형식, 준비 상태(이름만), 허용 신원 판정, 흐름 쿠키, 오류 코드·고정 문구.
 * 실제 OIDC 처리(discovery·인증 URL·code 교환·ID token 서명·iss·aud·exp·nonce 검증)는 검증된 라이브러리(openid-client)가
 * @cs/providers oidc-login.ts 에서 한다 — 자체 JWT·암호 검증을 구현하지 않는다(docs/02).
 *
 * 허용 신원 규칙(결정 — 핸드오프에 기록):
 * - AUTH_ALLOWED_IDENTITY 를 환경에 **명시**하면: ID token 의 email 이 그 값과 같고(대소문자 무시) email_verified 가 불리언 true 여야 한다.
 * - AUTH_ALLOWED_SUBJECT 를 설정하면: ID token 의 sub 가 그 값과 정확히 같아야 한다(issuer 가 하나로 고정이므로 issuer+sub 고정).
 * - 둘 다 설정하면 둘 다 맞아야 한다. 둘 다 없으면(AUTH_ALLOWED_IDENTITY 가 기본값뿐이면) 준비 안 됨 — 로그인 시작 자체를 거부.
 * - 다른 사용자를 자동으로 만들지 않는다. owner 행은 언제나 AUTH_ALLOWED_IDENTITY(기본값 포함)로 찾거나 만든다(dev 와 같은 owner 키).
 * 값(이메일·sub·토큰·code)은 응답·감사·로그에 넣지 않는다. 화면·health 에는 설정 **이름**만.
 */
import { createHash } from 'node:crypto';
import type { AppConfig } from './config';
import { AppError, OidcNotConfiguredError } from './errors';
import { envPresent } from './oauth';
import { isValidOidcClientSecret, parseOidcScopes } from './oidc-format';
import { readSecretKeyring } from './secrets';
import { identityMatches, isLocalhostBaseUrl, resolveCookieSecure } from './auth';

/** callback 경로(OIDC_REDIRECT_URI 는 APP_BASE_URL 의 origin + 이 경로와 정확히 같아야 한다). */
export const OIDC_CALLBACK_PATH = '/api/auth/oidc/callback';
export const OIDC_START_PATH = '/api/auth/oidc/start';
/** 로그인 요청(state·nonce·PKCE verifier) 유효 시간. */
export const OIDC_STATE_TTL_MS = 10 * 60_000;
/** 동시에 남겨 두는 진행 중 로그인 요청 상한(인증 없는 시작 경로가 표를 키우지 못하게 — 넘으면 가장 오래된 것부터 지운다). */
export const OIDC_MAX_PENDING_STATES = 100;
/** IdP HTTP 요청 하나의 시간 제한. */
export const OIDC_HTTP_TIMEOUT_MS = 10_000;
/** discovery 결과(Configuration·JWKS 캐시 포함) 재사용 시간. */
export const OIDC_DISCOVERY_TTL_MS = 60 * 60_000;

/** 브라우저 결합 쿠키 — 시작한 브라우저에서만 callback 을 받는다(로그인 CSRF·state 가로채기 방지). 값은 난수, DB 에는 sha256 만. */
export const OIDC_FLOW_COOKIE_NAME = 'cs_oidc_flow';
const OIDC_FLOW_COOKIE_PATH = '/api/auth/oidc';

/** 이 앱이 IdP 에 등록해야 하는 redirect URI(정확 일치 대상). */
export function expectedOidcRedirectUri(config: Pick<AppConfig, 'APP_BASE_URL'>): string {
  return `${new URL(config.APP_BASE_URL).origin}${OIDC_CALLBACK_PATH}`;
}

export type OidcConfig = Pick<
  AppConfig,
  | 'AUTH_MODE'
  | 'APP_BASE_URL'
  | 'AUTH_ALLOWED_IDENTITY'
  | 'AUTH_ALLOWED_SUBJECT'
  | 'OIDC_ISSUER_URL'
  | 'OIDC_CLIENT_ID'
  | 'OIDC_REDIRECT_URI'
  | 'OIDC_SCOPES'
>;

/** 허용 신원 정책 — 확인할 값(서버 안에서만 쓴다, 화면·로그에 내보내지 않는다). null = 그 항목은 확인하지 않음. */
export interface OidcIdentityPolicy {
  email: string | null;
  subject: string | null;
}

/** AUTH_ALLOWED_IDENTITY 는 환경에 명시했을 때만 email 확인에 쓴다(기본값 owner@example.local 로는 OIDC 신원을 허용하지 않는다). */
export function oidcIdentityPolicy(
  config: Pick<AppConfig, 'AUTH_ALLOWED_IDENTITY' | 'AUTH_ALLOWED_SUBJECT'>,
  env: Record<string, string | undefined>,
): OidcIdentityPolicy {
  return {
    email: envPresent(env, 'AUTH_ALLOWED_IDENTITY') ? config.AUTH_ALLOWED_IDENTITY : null,
    subject: config.AUTH_ALLOWED_SUBJECT ?? null,
  };
}

export interface OidcLoginReadiness {
  ready: boolean;
  /** 빠졌거나 잘못된 설정의 **이름**만(값 없음). */
  missing: string[];
}

/**
 * OIDC 로그인 준비 상태(이름만). 시작·callback 경로와 화면(설정·health details)이 **같은 함수**를 쓴다.
 * 조건: AUTH_MODE=oidc · OIDC_ISSUER_URL · OIDC_CLIENT_ID · OIDC_CLIENT_SECRET(서버 환경, 형식) · OIDC_REDIRECT_URI(= APP_BASE_URL origin + callback 경로)
 * · APP_BASE_URL(https — localhost 만 http 허용) · 허용 신원(AUTH_ALLOWED_IDENTITY 명시 또는 AUTH_ALLOWED_SUBJECT) · email 확인이면 OIDC_SCOPES 에 email
 * · SECRETS_MASTER_KEY(로그인 요청의 PKCE verifier·nonce 를 봉인해 둔다).
 */
export function oidcLoginReadiness(config: OidcConfig, env: Record<string, string | undefined>): OidcLoginReadiness {
  const missing: string[] = [];
  if (config.AUTH_MODE !== 'oidc') missing.push('AUTH_MODE=oidc');
  if (!config.OIDC_ISSUER_URL) missing.push('OIDC_ISSUER_URL');
  if (!config.OIDC_CLIENT_ID) missing.push('OIDC_CLIENT_ID');
  if (!envPresent(env, 'OIDC_CLIENT_SECRET')) missing.push('OIDC_CLIENT_SECRET');
  else if (!isValidOidcClientSecret(env.OIDC_CLIENT_SECRET)) missing.push('OIDC_CLIENT_SECRET(형식)');
  if (!config.OIDC_REDIRECT_URI) missing.push('OIDC_REDIRECT_URI');
  else if (config.OIDC_REDIRECT_URI !== expectedOidcRedirectUri(config)) missing.push('OIDC_REDIRECT_URI(불일치)');
  const base = new URL(config.APP_BASE_URL);
  if (base.protocol !== 'https:' && !isLocalhostBaseUrl(config.APP_BASE_URL)) missing.push('APP_BASE_URL(https)');
  const policy = oidcIdentityPolicy(config, env);
  if (policy.email === null && policy.subject === null) missing.push('AUTH_ALLOWED_IDENTITY 또는 AUTH_ALLOWED_SUBJECT');
  if (policy.email !== null && !parseOidcScopes(config.OIDC_SCOPES).includes('email')) missing.push('OIDC_SCOPES(email 필요)');
  if (!readSecretKeyring(env).ok) missing.push('SECRETS_MASTER_KEY');
  return { ready: missing.length === 0, missing };
}

/** 준비된 설정에서 provider 가 쓸 값(비밀 포함 — 서버 안에서만). 준비 안 됐으면 OidcNotConfiguredError. */
export interface OidcClientSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export function oidcClientSettings(config: OidcConfig, env: Record<string, string | undefined>): OidcClientSettings {
  const r = oidcLoginReadiness(config, env);
  if (!r.ready) throw new OidcNotConfiguredError();
  return {
    issuer: config.OIDC_ISSUER_URL!,
    clientId: config.OIDC_CLIENT_ID!,
    clientSecret: env.OIDC_CLIENT_SECRET!.trim(),
    redirectUri: config.OIDC_REDIRECT_URI!,
    scopes: parseOidcScopes(config.OIDC_SCOPES),
  };
}

/**
 * 시작~callback 사이에 설정이 바뀌었는지 확인하는 지문(issuer·client_id·redirect·scope). 비밀은 넣지 않는다.
 * 로그인 요청 행에 저장하고 callback 때 같아야 한다.
 */
export function oidcSettingsFingerprint(s: Pick<OidcClientSettings, 'issuer' | 'clientId' | 'redirectUri' | 'scopes'>): string {
  return createHash('sha256').update(`oidc/v1\n${s.issuer}\n${s.clientId}\n${s.redirectUri}\n${s.scopes.join(' ')}`, 'utf8').digest('hex');
}

// ---- 허용 신원 ----

/** 라이브러리가 검증한 ID token 의 클레임 중 판정에 쓰는 것. */
export interface OidcVerifiedClaims {
  sub: string;
  email?: unknown;
  email_verified?: unknown;
}

export type OidcIdentityCheck = 'email' | 'email_unverified' | 'subject';

/**
 * 허용 신원 판정(상수 시간 비교). 실패하면 어떤 항목이 어긋났는지(check)만 — 값은 돌려주지 않는다.
 * email: 문자열이어야 하고 email_verified === true(불리언). 비교는 trim·소문자.
 */
export function checkOidcIdentity(claims: OidcVerifiedClaims, policy: OidcIdentityPolicy): { ok: true } | { ok: false; check: OidcIdentityCheck } {
  if (policy.email === null && policy.subject === null) return { ok: false, check: 'email' };
  if (policy.subject !== null) {
    if (typeof claims.sub !== 'string' || !identityMatches(claims.sub, policy.subject)) return { ok: false, check: 'subject' };
  }
  if (policy.email !== null) {
    if (typeof claims.email !== 'string' || !identityMatches(claims.email.trim().toLowerCase(), policy.email.trim().toLowerCase())) {
      return { ok: false, check: 'email' };
    }
    if (claims.email_verified !== true) return { ok: false, check: 'email_unverified' };
  }
  return { ok: true };
}

// ---- 흐름 쿠키 ----

export function buildOidcFlowCookie(token: string, config: Pick<AppConfig, 'AUTH_COOKIE_SECURE' | 'APP_BASE_URL'>): string {
  const attrs = [`${OIDC_FLOW_COOKIE_NAME}=${token}`, `Path=${OIDC_FLOW_COOKIE_PATH}`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${OIDC_STATE_TTL_MS / 1000}`];
  if (resolveCookieSecure(config)) attrs.push('Secure');
  return attrs.join('; ');
}

export function buildClearedOidcFlowCookie(config: Pick<AppConfig, 'AUTH_COOKIE_SECURE' | 'APP_BASE_URL'>): string {
  const attrs = [`${OIDC_FLOW_COOKIE_NAME}=`, `Path=${OIDC_FLOW_COOKIE_PATH}`, 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (resolveCookieSecure(config)) attrs.push('Secure');
  return attrs.join('; ');
}

/** 결합 쿠키 값의 해시(DB 저장·비교용). */
export const hashOidcBrowserBinding = (token: string): string => createHash('sha256').update(`oidc-browser/v1\n${token}`, 'utf8').digest('hex');

// ---- 오류(고정 문구·안정 코드) ----

/** 로그인 실패로 세는 감사 사유(LOGIN_FAILURE_REASONS 에 포함 — 전역 횟수 제한). */
export const OIDC_FAILURE_REASONS = ['oidc_invalid', 'oidc_identity_mismatch'] as const;

/** 로그인 요청(state)을 확인할 수 없음 — 없음·만료·이미 사용·다른 브라우저·설정 변경 모두 같은 응답. */
export class OidcStateInvalidError extends AppError {
  constructor() {
    super('bad_request', 'oidc_state_invalid', '로그인 요청을 확인할 수 없습니다(만료·이미 사용·다른 브라우저). 로그인 화면에서 다시 시작하세요.');
  }
}

/** IdP 응답(code 교환·ID token)이 검증을 통과하지 못함. */
export class OidcLoginInvalidError extends AppError {
  constructor() {
    super('unauthorized', 'oidc_login_invalid', 'OIDC 로그인 응답을 확인하지 못했습니다. 로그인 화면에서 다시 시작하세요.');
  }
}

/** 허용된 신원이 아님(이메일·인증 여부·sub). 어떤 항목인지·어떤 값이 허용되는지 알리지 않는다. */
export class OidcIdentityDeniedError extends AppError {
  constructor() {
    super('forbidden', 'oidc_identity_denied', '이 계정으로는 로그인할 수 없습니다.');
  }
}

/** IdP 에 닿지 못함·시간 초과·5xx·discovery 실패. */
export class OidcProviderUnavailableError extends AppError {
  constructor() {
    super('upstream_failed', 'oidc_provider_unavailable', '인증 공급자(IdP)와 통신하지 못했습니다. 잠시 후 다시 시도하세요.');
  }
}

/** IdP 가 로그인을 취소·거부해 돌아옴(callback 의 error 파라미터). */
export class OidcCancelledError extends AppError {
  constructor() {
    super('unauthorized', 'oidc_cancelled', '인증 공급자에서 로그인이 취소되었습니다.');
  }
}
