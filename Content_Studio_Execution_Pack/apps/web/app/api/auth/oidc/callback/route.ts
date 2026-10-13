import { consumeOidcLoginState, countRecentLoginFailures, createSession, ensureOwner, recordAudit, withLoginAttemptLock } from '@cs/db';
import {
  AppError,
  assertLoginNotRateLimited,
  buildClearedOidcFlowCookie,
  buildSessionCookie,
  checkOidcIdentity,
  generateSessionToken,
  hashSessionToken,
  hashUserAgent,
  isWellFormedOAuthState,
  LOGIN_FAILURE_REASONS,
  LOGIN_FAILURE_WINDOW_MS,
  OIDC_FLOW_COOKIE_NAME,
  OidcCancelledError,
  oidcClientSettings,
  OidcIdentityDeniedError,
  oidcIdentityPolicy,
  OidcLoginInvalidError,
  oidcLoginReadiness,
  OidcNotConfiguredError,
  OidcProviderUnavailableError,
  oidcSettingsFingerprint,
  OidcStateInvalidError,
  readCookie,
  requestRedirectTarget,
  requireSecretKeyring,
  sessionTtlMs,
  type AppConfig,
} from '@cs/domain';
import { OidcLoginFailure } from '@cs/providers';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { withOAuthResponseHeaders } from '../../../../../lib/oauth';
import { getOidcLoginClient } from '../../../../../lib/oidc';
import { getAppDb, getConfig } from '../../../../../lib/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 판정 결과(값 없음). reason = 감사 사유(LOGIN_FAILURE_REASONS 에 든 것만 횟수 제한에 센다), check = 어느 검사인지. */
interface Failure {
  reason: 'oidc_invalid' | 'oidc_identity_mismatch' | 'oidc_provider_error' | 'oidc_cancelled';
  check: string;
  error: AppError;
}

const fail = (reason: Failure['reason'], check: string): Failure => {
  const error =
    reason === 'oidc_identity_mismatch'
      ? new OidcIdentityDeniedError()
      : reason === 'oidc_provider_error'
        ? new OidcProviderUnavailableError()
        : reason === 'oidc_cancelled'
          ? new OidcCancelledError()
          : check.startsWith('state') || check === 'redirect_mismatch'
            ? new OidcStateInvalidError()
            : new OidcLoginInvalidError();
  return { reason, check, error };
};

/**
 * GET /api/auth/oidc/callback?code&state(|error) — OIDC 로그인 완료(T21-P1b). 인증 없음(로그인 전), state·브라우저 결합 쿠키가 CSRF 를 막는다.
 *
 * 1) AUTH_MODE=oidc·준비 상태 → 2) 전역 로그인 시도 제한 조기 검사(429 — 맞는 callback 이어도, state 를 소비하지 않고 감사 기록 없음)
 * 3) 요청 주소(origin+path) = OIDC_REDIRECT_URI 정확 일치 → 4) state 형식 → 1회용 소비(같은 브라우저 결합 쿠키·10분·설정 지문)
 * 5) IdP 의 error 파라미터면 취소 → 6) 라이브러리로 code 교환(PKCE)·ID token 검증(서명·iss·aud·exp·iat·nonce) → 7) 허용 신원(email+email_verified / sub)
 * 8) 전역 잠금 안(withLoginAttemptLock — T21-P1a 와 같은 판정 경로): 재검사(429) → 실패면 auth.login_denied(reason·check) 기록, 성공이면 owner 확인·세션·auth.login 기록.
 * 네트워크(6)는 잠금 밖에서 한다(느린 IdP 가 전역 잠금을 붙잡지 않게). 결합 쿠키는 결과와 관계없이 지운다.
 * 응답: 브라우저는 303 / (성공) 또는 /login?error=<코드>, 그 밖은 200 {ok, expires_at} / JSON 오류. code·state·토큰·IdP 오류 본문은 응답·감사·로그에 없다.
 */
export async function GET(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  let config: AppConfig | null = null;
  let res: Response;
  try {
    config = getConfig();
    if (!oidcLoginReadiness(config, process.env).ready) throw new OidcNotConfiguredError();
    const { db } = await getAppDb(config);
    const limit = { windowMs: LOGIN_FAILURE_WINDOW_MS, reasons: LOGIN_FAILURE_REASONS };
    assertLoginNotRateLimited(await countRecentLoginFailures(db, { now: new Date(), ...limit }));

    const settings = oidcClientSettings(config, process.env);
    const keyring = requireSecretKeyring(process.env);
    const params = new URL(request.url).searchParams;
    let failure: Failure | null = null;
    let claims: { sub: string; email?: unknown; email_verified?: unknown } | null = null;

    if (requestRedirectTarget(request.url) !== settings.redirectUri) {
      failure = fail('oidc_invalid', 'redirect_mismatch');
    } else {
      const state = params.get('state');
      if (!isWellFormedOAuthState(state) || params.getAll('state').length !== 1) {
        failure = fail('oidc_invalid', 'state_missing');
      } else {
        const consumed = await consumeOidcLoginState(db, {
          state,
          browserToken: readCookie(request.headers.get('cookie'), OIDC_FLOW_COOKIE_NAME),
          settingsHash: oidcSettingsFingerprint(settings),
          keyring,
        });
        if (consumed.status !== 'ok') {
          failure = fail('oidc_invalid', `state_${consumed.status}`);
        } else if (params.has('error')) {
          // IdP 가 거부·취소(access_denied 등). 오류 값·설명은 기록하지 않는다.
          failure = fail('oidc_cancelled', 'provider_error_param');
        } else {
          try {
            claims = await getOidcLoginClient(config, process.env).completeAuthorization({
              callbackParams: params,
              expectedState: state,
              expectedNonce: consumed.secrets.nonce,
              codeVerifier: consumed.secrets.codeVerifier,
            });
          } catch (e) {
            if (!(e instanceof OidcLoginFailure)) throw e;
            failure = e.kind === 'unavailable' ? fail('oidc_provider_error', e.step) : fail('oidc_invalid', e.step);
          }
          if (claims) {
            const verdict = checkOidcIdentity(claims, oidcIdentityPolicy(config, process.env));
            if (!verdict.ok) failure = fail('oidc_identity_mismatch', verdict.check);
          }
        }
      }
    }

    const cfg = config;
    const outcome = await withLoginAttemptLock(db, limit, async (tx, { now, failures, seq }) => {
      assertLoginNotRateLimited(failures); // 던지면 아무것도 쓰지 않은 채 되돌려진다
      if (failure) {
        await recordAudit(tx, {
          ownerId: null,
          action: 'auth.login_denied',
          entity: 'session',
          versionOrHash: seq,
          details: { reason: failure.reason, check: failure.check, mode: 'oidc' },
          at: now,
        });
        return { kind: 'failed' as const, failure };
      }
      const owner = await ensureOwner(tx, cfg.AUTH_ALLOWED_IDENTITY);
      const token = generateSessionToken();
      const session = await createSession(tx, {
        ownerId: owner.id,
        tokenHash: hashSessionToken(token),
        expiresAt: new Date(now.getTime() + sessionTtlMs(cfg)),
        userAgentHash: hashUserAgent(request.headers.get('user-agent')),
        now,
      });
      await recordAudit(tx, {
        ownerId: owner.id,
        action: 'auth.login',
        entity: 'session',
        entityId: session.id,
        versionOrHash: seq,
        details: { mode: 'oidc' },
        at: now,
      });
      return { kind: 'ok' as const, token, session };
    });
    if (outcome.kind === 'failed') {
      console.warn(`[auth] oidc_login_denied: ${outcome.failure.reason}/${outcome.failure.check}`);
      throw outcome.failure.error;
    }
    const headers = new Headers();
    headers.append('set-cookie', buildSessionCookie(outcome.token, config));
    headers.append('set-cookie', buildClearedOidcFlowCookie(config));
    res = html ? seeOther('/', headers) : json({ ok: true, expires_at: outcome.session.expiresAt.toISOString() }, { headers });
  } catch (e) {
    res = html ? seeOther(`/login?error=${callbackErrorCode(e)}`) : errorResponse(e, request);
    if (config) {
      const h = new Headers(res.headers);
      h.append('set-cookie', buildClearedOidcFlowCookie(config));
      res = new Response(res.body, { status: res.status, headers: h });
    }
  }
  return withOAuthResponseHeaders(res);
}

function callbackErrorCode(e: unknown): string {
  if (e instanceof AppError) {
    if (e.code === 'login_rate_limited') return 'rate_limited';
    if (e.code.startsWith('oidc_')) return e.code;
    if (e.code === 'secrets_not_configured') return 'oidc_not_configured';
    if (e.code === 'login_sequence_exhausted') return 'server';
  }
  return 'server';
}
