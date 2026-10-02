/**
 * T13(결정 D24) 서버 전용: 계정 연결(OAuth) 의존성 — 공급자 선택·키 묶음·redirect URI. 비밀 값은 process.env 에서만 읽고 돌려주지 않는다.
 * 기본·개발용 마스터 키는 없다: SECRETS_MASTER_KEY 가 없으면 연결 관련 동작만 503(secrets_not_configured), 나머지 앱은 그대로.
 */
import type { KeyringSource, ProviderFor } from '@cs/db';
import {
  AppError,
  envPresent,
  liveOAuthReadiness,
  oauthRedirectUri,
  readSecretKeyring,
  requireSecretKeyring,
  secretsReadiness,
  type AppConfig,
} from '@cs/domain';
import { MockThreadsOAuthProvider, resolveOAuthProvider } from '@cs/providers';
import { errorResponse, seeOther } from './api';

export interface OAuthDeps {
  providerFor: ProviderFor;
  keyring: KeyringSource;
  redirectUri: string;
}

export function oauthDeps(config: AppConfig, env: Record<string, string | undefined> = process.env): OAuthDeps {
  const redirectUri = oauthRedirectUri(config);
  return {
    redirectUri,
    providerFor: (account) => resolveOAuthProvider(account, config, env, redirectUri),
    keyring: () => requireSecretKeyring(env),
  };
}

/** 모의 "동의 화면" 경로가 쓰는 공급자(등록 redirect URI = 설정값) */
export function mockThreadsProvider(config: AppConfig): MockThreadsOAuthProvider {
  return new MockThreadsOAuthProvider({ registeredRedirectUri: oauthRedirectUri(config), appBaseUrl: config.APP_BASE_URL });
}

/** 화면 표시: 키 설정 여부·live 준비 상태(이름만, 값 없음) */
export function oauthReadinessView(config: AppConfig, env: Record<string, string | undefined> = process.env) {
  const secrets = secretsReadiness(env);
  return {
    secrets,
    live: liveOAuthReadiness(config, { threadsAppSecretPresent: envPresent(env, 'THREADS_APP_SECRET'), masterKeyConfigured: readSecretKeyring(env).ok }),
    redirectUri: oauthRedirectUri(config),
  };
}

export const ACCOUNT_ERROR_TEXT: Record<string, string> = {
  secrets_not_configured: '서버 비밀 암호화 키(SECRETS_MASTER_KEY·SECRETS_KEY_VERSION)가 설정되지 않아 계정을 연결할 수 없습니다. 다른 기능은 그대로 쓸 수 있습니다.',
  oauth_not_supported: 'T13 에서는 Threads 모의 계정만 연결할 수 있습니다.',
  live_oauth_not_configured: '실제 계정 연결은 아직 준비되지 않았습니다(T14, 별도 승인 후). 외부로 아무것도 보내지 않았습니다.',
  oauth_state_invalid: '연결 요청을 확인할 수 없습니다. 다시 연결하세요.',
  oauth_state_expired: '연결 요청 시간이 지났습니다(10분). 다시 연결하세요.',
  oauth_state_used: '이미 처리한 연결 요청입니다. 다시 연결하세요.',
  oauth_redirect_mismatch: '연결 응답 주소가 등록된 redirect URI 와 다릅니다.',
  oauth_denied: '연결이 취소되었습니다.',
  oauth_exchange_failed: '연결을 마치지 못했습니다. 다시 연결하세요.',
  oauth_bad_request: '연결 응답 형식이 올바르지 않습니다.',
  oauth_account_mismatch: '연결한 계정이 이 배포 계정과 달라 저장하지 않았습니다.',
  credential_not_connected: '이 계정에는 저장된 연결 정보가 없습니다.',
  credential_refresh_failed: '연결 정보를 갱신하지 못했습니다. 다시 연결하세요.',
  credential_unreadable: '저장된 연결 정보를 읽을 수 없습니다. 다시 연결하세요.',
  not_found: '배포 계정을 찾을 수 없습니다.',
  csrf: '요청 출처를 확인할 수 없어 거부했습니다.',
  server: '처리하지 못했습니다. 잠시 뒤 다시 시도하세요.',
};

/**
 * FIX-T13(Codex Q7): callback·모의 동의 화면의 **모든** 응답(성공·실패·HTML·비로그인·예상하지 못한 예외)에
 * Referrer-Policy: no-referrer, Cache-Control: no-store 를 붙인다 — code·state 가 든 URL 이 Referer·캐시로 새지 않게.
 */
export function withOAuthResponseHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set('referrer-policy', 'no-referrer');
  headers.set('cache-control', 'no-store');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** callback·동의 화면 처리기를 감싼다: 어떤 예외도 일반 오류 응답으로 바꾸고 위 헤더를 붙인다. */
export function oauthEndpoint(fn: (request: Request) => Promise<Response>): (request: Request) => Promise<Response> {
  return async (request) => {
    let res: Response;
    try {
      res = await fn(request);
    } catch (e) {
      res = errorResponse(e, request);
    }
    return withOAuthResponseHeaders(res);
  };
}

/** D25-3: 모의 동의 화면의 시험용 매개변수 — 운영(NODE_ENV=production)에서는 거부 */
export const MOCK_TEST_PARAMS = ['mock_user', 'mock_grant', 'mock_deny'] as const;
export function mockTestParamsAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== 'production';
}

/** 폼 제출 실패 → 설정 화면(오류 코드만 query 에 — 값·토큰 없음) */
export function accountFormFailure(e: unknown): Response {
  let code = 'server';
  if (e instanceof AppError && e.kind === 'unauthorized') return seeOther('/login');
  if (e instanceof AppError) code = e.code;
  else if (e && typeof e === 'object' && 'code' in e && String((e as { code: unknown }).code) === 'LIVE_OAUTH_NOT_CONFIGURED') code = 'live_oauth_not_configured';
  if (!(code in ACCOUNT_ERROR_TEXT)) code = 'server';
  return seeOther(`/settings?account_error=${encodeURIComponent(code)}#accounts`);
}
