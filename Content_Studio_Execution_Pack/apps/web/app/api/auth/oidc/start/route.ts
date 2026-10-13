import { randomBytes } from 'node:crypto';
import { countRecentLoginFailures, createOidcLoginState } from '@cs/db';
import {
  AppError,
  assertLoginNotRateLimited,
  buildOidcFlowCookie,
  CsrfError,
  LOGIN_FAILURE_REASONS,
  LOGIN_FAILURE_WINDOW_MS,
  oidcClientSettings,
  oidcLoginReadiness,
  OidcNotConfiguredError,
  OidcProviderUnavailableError,
  oidcSettingsFingerprint,
  requireSecretKeyring,
} from '@cs/domain';
import { OidcLoginFailure } from '@cs/providers';
import { errorResponse, seeOther, wantsHtml } from '../../../../../lib/api';
import { withOAuthResponseHeaders } from '../../../../../lib/oauth';
import { getOidcLoginClient } from '../../../../../lib/oidc';
import { getAppDb, getConfig } from '../../../../../lib/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

/**
 * GET /api/auth/oidc/start — OIDC 로그인 시작(T21-P1b). 인증 없음(로그인 전).
 * 순서: 다른 사이트에서 연 요청 거부(Sec-Fetch-Site 가 있으면 same-origin·none 만) → AUTH_MODE=oidc·준비 상태(이름은 서버 로그에만)
 * → 전역 로그인 시도 제한(429, 막힌 동안 IdP 로 보내지 않음) → discovery(캐시·시간 제한) → state·nonce·PKCE verifier 난수
 * → 로그인 요청 행(state 해시·브라우저 결합 해시·봉인한 verifier·nonce, 10분, 1회용) → 303 IdP 인증 URL + 결합 쿠키(HttpOnly·SameSite=Lax·Path=/api/auth/oidc).
 * 성공은 감사 기록을 남기지 않는다(로그인 결과는 callback 이 기록). 실패: 브라우저는 303 /login?error=<코드>, 그 밖은 JSON 오류.
 * 응답에는 Referrer-Policy: no-referrer, Cache-Control: no-store.
 */
export async function GET(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  let res: Response;
  try {
    const site = request.headers.get('sec-fetch-site');
    if (site !== null && !ALLOWED_FETCH_SITES.has(site.toLowerCase())) throw new CsrfError();
    const config = getConfig();
    const readiness = oidcLoginReadiness(config, process.env);
    if (!readiness.ready) {
      // 이름만(값 없음) 서버 로그에 — 로그인 전이라 화면에서는 볼 수 없으므로 운영자가 여기서 확인한다.
      console.warn(`[auth] oidc_not_configured: ${readiness.missing.join(', ')}`);
      throw new OidcNotConfiguredError();
    }
    const { db } = await getAppDb(config);
    assertLoginNotRateLimited(
      await countRecentLoginFailures(db, { now: new Date(), windowMs: LOGIN_FAILURE_WINDOW_MS, reasons: LOGIN_FAILURE_REASONS }),
    );
    const keyring = requireSecretKeyring(process.env);
    const settings = oidcClientSettings(config, process.env);
    let auth;
    try {
      auth = await getOidcLoginClient(config, process.env).createAuthorizationRequest();
    } catch (e) {
      if (e instanceof OidcLoginFailure) {
        console.warn(`[auth] oidc_start_failed: ${e.kind}/${e.step}`);
        throw new OidcProviderUnavailableError();
      }
      throw e;
    }
    const browserToken = randomBytes(32).toString('base64url');
    await createOidcLoginState(db, {
      state: auth.state,
      browserToken,
      secrets: { codeVerifier: auth.codeVerifier, nonce: auth.nonce },
      settingsHash: oidcSettingsFingerprint(settings),
      keyring,
    });
    res = seeOther(auth.url, { 'set-cookie': buildOidcFlowCookie(browserToken, config) });
  } catch (e) {
    res = html ? seeOther(`/login?error=${startErrorCode(e)}`) : errorResponse(e, request);
  }
  return withOAuthResponseHeaders(res);
}

function startErrorCode(e: unknown): string {
  if (e instanceof AppError) {
    if (e.code === 'login_rate_limited') return 'rate_limited';
    if (e.code === 'csrf') return 'csrf';
    if (e.code.startsWith('oidc_')) return e.code;
    if (e.code === 'secrets_not_configured') return 'oidc_not_configured';
  }
  return 'server';
}
