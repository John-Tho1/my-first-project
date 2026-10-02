/**
 * T13(결정 D24): 계정 연결(OAuth) 공통 틀 — 공급자 인터페이스, state·PKCE, scope, 연결 상태(health) 판정, live 준비 상태.
 *
 * - T13 은 모의 공급자(Threads 형태, 프로세스 안, 네트워크 없음)만 있다. 실제 Meta OAuth 왕복·토큰 발급은 하지 않는다.
 * - state: 32바이트 난수(base64url). 서버에는 SHA-256 만 저장, 한 번만 쓰임, owner + 로그인 세션 + 계정에 묶임, TTL 10분.
 * - PKCE: S256(verifier 32바이트 난수 base64url → SHA-256 → base64url). verifier 는 서버에 암호화해 둔다(브라우저로 나가지 않음).
 * - scope: 게시에 필요한 최소(Threads 기본 + 게시). reply·insights 는 기본으로 요청하지 않는다(docs/03). 실제 이름은 T14 에서 공식 문서로 재확인.
 * - 토큰·code·state·verifier 는 오류 메시지·감사·응답·로그에 넣지 않는다(코드 값만).
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AppConfig } from './config';
import { AppError, GuardError } from './errors';
import type { Channel } from './channel';

export const OAUTH_PROVIDER_IDS = ['mock_threads', 'threads'] as const;
export type OAuthProviderId = (typeof OAUTH_PROVIDER_IDS)[number];

/** T13 잠정 scope(D24 — T14 에서 공식 문서로 재확인). 게시에 필요한 최소만. */
export const THREADS_REQUIRED_SCOPES = ['threads_basic', 'threads_content_publish'] as const;
/** 기본 연결에서 요청하지 않는 scope(답글·통계). 공급자가 이 값을 요청 URL 에 넣으면 시험이 실패한다. */
export const THREADS_NOT_REQUESTED_BY_DEFAULT = ['threads_manage_replies', 'threads_read_replies', 'threads_manage_insights'] as const;

/** 채널별 필요한 최소 scope(T13 은 Threads 만 — 다른 채널은 연결 공급자가 없어 빈 목록). */
export function requiredScopesForPlatform(platform: string): readonly string[] {
  return platform === 'threads' ? THREADS_REQUIRED_SCOPES : [];
}

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
/** 만료 7일 전부터 "곧 만료"(Threads 장기 토큰은 60일 — 공식 문서 재확인은 T14). */
export const OAUTH_EXPIRING_SOON_MS = 7 * 24 * 3600_000;

export interface OAuthAuthorizeRequest {
  state: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: readonly string[];
  /** 모의 공급자 전용: 연결할 계정(실제 공급자는 사용자가 로그인한 계정) */
  loginHint?: string;
}

export interface OAuthTokenSet {
  accessToken: string;
  /** Threads 는 별도 refresh token 이 없다(장기 토큰 자체로 갱신) — null */
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
}

export interface OAuthAccountInfo {
  externalAccountId: string;
  displayName: string;
}

/** 저장된(복호화한) 토큰. 메모리에서만 쓰고 버린다. */
export interface StoredOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
}

/**
 * 공급자 인터페이스. 모든 메서드는 실패 시 OAuthProviderError(code 만) 를 던진다.
 * mock=true 인 공급자는 네트워크를 쓰지 않고, 그 토큰은 실제 연결·실제 게시로 인정되지 않는다.
 */
export interface OAuthProvider {
  readonly id: OAuthProviderId;
  readonly platform: Channel;
  readonly mock: boolean;
  requiredScopes(): readonly string[];
  buildAuthorizeUrl(req: OAuthAuthorizeRequest): string;
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string; now: Date }): Promise<OAuthTokenSet>;
  refresh(input: { tokens: StoredOAuthTokens; now: Date }): Promise<OAuthTokenSet>;
  revoke(input: { tokens: StoredOAuthTokens; now: Date }): Promise<void>;
  accountInfo(input: { accessToken: string; now: Date }): Promise<OAuthAccountInfo>;
}

export type OAuthProviderErrorCode =
  | 'invalid_grant'
  | 'pkce_mismatch'
  | 'redirect_mismatch'
  | 'code_expired'
  | 'code_reused'
  | 'invalid_token'
  | 'token_expired'
  | 'token_revoked'
  | 'scope_not_allowed'
  | 'invalid_request'
  | 'provider_error';

/** 공급자 오류 — 코드만 담는다(토큰·code 값 없음). */
export class OAuthProviderError extends Error {
  readonly code: OAuthProviderErrorCode;
  constructor(code: OAuthProviderErrorCode) {
    super(`oauth provider error: ${code}`);
    this.name = 'OAuthProviderError';
    this.code = code;
  }
}

// ---- 흐름 오류(HTTP) ----

export type OAuthFlowErrorCode =
  | 'oauth_state_invalid'
  | 'oauth_state_expired'
  | 'oauth_state_used'
  | 'oauth_redirect_mismatch'
  | 'oauth_denied'
  | 'oauth_exchange_failed'
  | 'oauth_bad_request';

const FLOW_MESSAGES: Record<OAuthFlowErrorCode, string> = {
  oauth_state_invalid: '연결 요청을 확인할 수 없습니다. 설정 화면에서 다시 연결하세요.',
  oauth_state_expired: '연결 요청 시간이 지났습니다(10분). 다시 연결하세요.',
  oauth_state_used: '이미 처리한 연결 요청입니다. 다시 연결하세요.',
  oauth_redirect_mismatch: '연결 응답 주소가 등록된 redirect URI 와 다릅니다.',
  oauth_denied: '연결이 취소되었습니다(공급자에서 거부).',
  oauth_exchange_failed: '연결을 마치지 못했습니다(인증 코드 교환 실패). 다시 연결하세요.',
  oauth_bad_request: '연결 응답 형식이 올바르지 않습니다.',
};

export class OAuthFlowError extends AppError {
  constructor(code: OAuthFlowErrorCode, extra?: Record<string, unknown>) {
    super('bad_request', code, FLOW_MESSAGES[code], extra);
  }
}

export class OAuthNotSupportedError extends AppError {
  constructor() {
    super('bad_request', 'oauth_not_supported', 'T13 에서는 Threads 모의 계정만 연결할 수 있습니다(다른 채널·실제 계정 연결은 이후 작업).');
  }
}

export class OAuthAccountMismatchError extends AppError {
  constructor() {
    super('conflict', 'oauth_account_mismatch', '연결한 계정이 이 배포 계정과 다릅니다. 연결 정보를 저장하지 않았습니다(계정을 바꾸려면 새 계정으로 추가해야 합니다).');
  }
}

export class CredentialNotFoundError extends AppError {
  constructor() {
    super('conflict', 'credential_not_connected', '이 계정에는 저장된 연결 정보가 없습니다. 먼저 연결하세요.');
  }
}

export class CredentialRefreshFailedError extends AppError {
  constructor(code: string) {
    super('conflict', 'credential_refresh_failed', '연결 정보를 갱신하지 못했습니다. 계정을 다시 연결하세요.', { reason: code });
  }
}

/** 실행 차단(409): 이 계정의 연결 정보가 쓸 수 없는 상태. */
export class AccountCredentialBlockedError extends AppError {
  constructor(items: Array<{ item_id: string; account_id: string; status: CredentialStatus }>) {
    super('conflict', 'account_credential_blocked', '배포 계정 연결이 만료·철회되었거나 다시 연결이 필요해 실행하지 않았습니다(아무것도 대기열에 넣지 않음).', { items });
  }
}

/** live 계정 연결이 준비되지 않음(fail-closed). */
export class LiveOAuthNotConfiguredError extends GuardError {
  readonly missing: string[];
  constructor(missing: string[] = []) {
    super(
      'LIVE_OAUTH_NOT_CONFIGURED',
      `실제 계정 연결(OAuth)이 구현·승인되어 있지 않습니다. 외부로 아무것도 보내지 않았습니다.${missing.length ? ` (준비 안 됨: ${missing.join(', ')})` : ''}`,
    );
    this.missing = missing;
  }
}

// ---- state·PKCE ----

const B64U_43 = /^[A-Za-z0-9_-]{43}$/;

export const newOAuthState = (): string => randomBytes(32).toString('base64url');
export const newCodeVerifier = (): string => randomBytes(32).toString('base64url');
export const isWellFormedOAuthState = (v: unknown): v is string => typeof v === 'string' && B64U_43.test(v);
export const isWellFormedCodeVerifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(v);
export const hashOAuthState = (state: string): string => createHash('sha256').update(state, 'utf8').digest('hex');
/** RFC 7636 S256 */
export const codeChallengeS256 = (verifier: string): string => createHash('sha256').update(verifier, 'ascii').digest('base64url');

/** callback 의 redirect URI(정확 일치 대상). 설정이 없으면 APP_BASE_URL + /api/oauth/callback. */
export function oauthRedirectUri(config: Pick<AppConfig, 'APP_BASE_URL' | 'OAUTH_REDIRECT_URI'>): string {
  if (config.OAUTH_REDIRECT_URI) return config.OAUTH_REDIRECT_URI;
  return new URL('/api/oauth/callback', config.APP_BASE_URL).toString();
}

/** 요청 URL 에서 query 를 뺀 origin + path(정확 일치 비교용). */
export function requestRedirectTarget(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

export const oauthCallbackQuerySchema = z
  .object({
    state: z.string().max(200).optional(),
    code: z.string().max(2000).optional(),
    error: z.string().max(200).optional(),
    error_description: z.string().max(2000).optional(),
  })
  .strip();

// ---- 연결 상태(health) ----

export const CREDENTIAL_STATUSES = ['not_connected', 'connected', 'expiring_soon', 'expired', 'revoked', 'needs_reconnect', 'error'] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

export const CREDENTIAL_STATUS_LABEL: Record<CredentialStatus, string> = {
  not_connected: '연결 정보 없음',
  connected: '연결됨',
  expiring_soon: '곧 만료',
  expired: '만료됨',
  revoked: '연결 해제됨',
  needs_reconnect: '다시 연결 필요',
  error: '오류',
};

export type AccountCredentialState = 'none' | 'linked' | 'needs_reconnect';

export interface CredentialHealthInput {
  account: { kind: string; credentialState: string };
  credential: {
    status: string;
    expiresAt: Date | null;
    scopes: readonly string[];
    revokedAt: Date | null;
    lastErrorCode: string | null;
  } | null;
  requiredScopes: readonly string[];
  now: Date;
}

export interface CredentialHealth {
  status: CredentialStatus;
  /** 실행(배포)에 쓸 수 있는가 — connected·expiring_soon, 또는 연결 정보가 필요 없는 모의 계정(not_connected + mock) */
  usable: boolean;
  /** 이 계정의 실행에 연결 정보가 필요한가(live 계정, 또는 한 번이라도 연결한 계정) */
  required: boolean;
  reason: string | null;
  missingScopes: string[];
}

/**
 * 연결 상태 판정(순수 함수). 우선순위: 연결 정보 없음 → 철회 → 오류 → scope 부족 → 만료 → 곧 만료 → 연결됨.
 * - 연결 정보가 없을 때: live 계정·복원으로 "다시 연결 필요"가 된 계정은 needs_reconnect, 연결한 적 없는 모의 계정은 not_connected
 *   (M3 모의 동작 그대로 — 실행 가능, 결과는 항상 MOCK).
 * - 철회(revoked)·만료·오류·scope 부족은 실행 불가.
 */
export function credentialHealth(input: CredentialHealthInput): CredentialHealth {
  const { account, credential, requiredScopes, now } = input;
  const required = account.kind !== 'mock' || account.credentialState !== 'none';
  const out = (status: CredentialStatus, reason: string | null = null, missingScopes: string[] = []): CredentialHealth => ({
    status,
    usable: status === 'connected' || status === 'expiring_soon' || (status === 'not_connected' && !required),
    required,
    reason,
    missingScopes,
  });
  if (!credential) {
    if (account.kind !== 'mock') return out('needs_reconnect', 'no_credential');
    if (account.credentialState === 'needs_reconnect') return out('needs_reconnect', 'restored_without_credential');
    if (account.credentialState === 'linked') return out('needs_reconnect', 'no_credential');
    return out('not_connected');
  }
  if (credential.revokedAt || credential.status === 'revoked') return out('revoked');
  if (credential.status === 'error') return out('error', credential.lastErrorCode ?? 'unknown');
  const granted = new Set(credential.scopes);
  const missing = requiredScopes.filter((s) => !granted.has(s));
  if (missing.length) return out('needs_reconnect', 'scope_missing', missing);
  if (!credential.expiresAt || credential.expiresAt.getTime() <= now.getTime()) return out('expired', 'token_expired');
  if (credential.expiresAt.getTime() - now.getTime() <= OAUTH_EXPIRING_SOON_MS) return out('expiring_soon');
  return out('connected');
}

// ---- live 준비 상태 ----

export interface LiveOAuthReadiness {
  ready: false;
  missing: string[];
}

/**
 * 실제 계정 연결의 전제 조건(이름만, 값 없음). 모두 갖춰져도 T13 에는 live OAuth 어댑터가 없어 ready 는 항상 false 이고
 * 'LIVE_OAUTH_ADAPTER(T14 미구현)' 가 남는다(LLM·STT 와 같은 방식).
 */
export function liveOAuthReadiness(
  config: Pick<AppConfig, 'OAUTH_MODE' | 'THREADS_APP_ID' | 'OAUTH_LIVE_APPROVAL_REF' | 'OAUTH_REDIRECT_URI' | 'PUBLISH_MODE'>,
  secrets: { threadsAppSecretPresent: boolean; masterKeyConfigured: boolean },
): LiveOAuthReadiness {
  const missing: string[] = [];
  if (config.OAUTH_MODE !== 'live') missing.push('OAUTH_MODE=live');
  if (!config.THREADS_APP_ID) missing.push('THREADS_APP_ID');
  if (!secrets.threadsAppSecretPresent) missing.push('THREADS_APP_SECRET');
  if (!config.OAUTH_REDIRECT_URI) missing.push('OAUTH_REDIRECT_URI');
  if (!secrets.masterKeyConfigured) missing.push('SECRETS_MASTER_KEY');
  if (!config.OAUTH_LIVE_APPROVAL_REF) missing.push('OAUTH_LIVE_APPROVAL_REF');
  if (config.PUBLISH_MODE !== 'enabled') missing.push('PUBLISH_MODE=enabled');
  missing.push('LIVE_OAUTH_ADAPTER(T14 미구현)');
  return { ready: false, missing };
}

/** 환경에 비밀이 "있는지"만 본다(값을 읽어 돌려주지 않음). */
export function envPresent(env: Record<string, string | undefined>, name: string): boolean {
  const v = env[name];
  return typeof v === 'string' && v.trim() !== '';
}
