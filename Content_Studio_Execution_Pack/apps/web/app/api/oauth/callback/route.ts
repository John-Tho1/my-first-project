import { completeOAuthCallback } from '@cs/db';
import { oauthCallbackQuerySchema, OAuthFlowError, requestRedirectTarget } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../lib/api';
import { accountFormFailure, requireMockOAuthReady, oauthDeps, oauthEndpoint } from '../../../../lib/oauth';
import { getConfig } from '../../../../lib/server';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/oauth/callback?code&state(|error) — 계정 연결 callback(T13, D24). 로그인 필요(state 는 이 세션·owner 에 묶여 있다).
 * 검사: state 형식 → 이 owner 의 연결 요청 → 같은 세션(다른 세션 요청은 소비하지 않음) → 미사용 → 사용 처리(정상 세션은 결과와 관계없이 한 번)
 * → 10분 안 → 요청 주소 = 등록 redirect URI(정확 일치) → 공급자 거부 아님 → PKCE verifier 로 code 교환 → 공급자 계정 = 이 배포 계정.
 * 통과하면 토큰을 봉인 저장. 성공 200 { account } (브라우저는 303 /settings?connected=1). 오류는 400 oauth_* / 409 — code·state·토큰 없음.
 * 모든 응답(오류·비로그인·예외 포함)에 Referrer-Policy: no-referrer, Cache-Control: no-store(FIX-T13 Q7).
 * GET 이지만 같은 출처 검사 대신 state(세션 결합·1회용)가 CSRF 를 막는다(OAuth 규약).
 */
export const GET = oauthEndpoint(async (request: Request): Promise<Response> => {
  const html = wantsHtml(request);
  try {
    const config = getConfig();
    const owner = await requireOwner(request);
    const url = new URL(request.url);
    const parsed = oauthCallbackQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
    if (!parsed.success) throw new OAuthFlowError('oauth_bad_request');
    // M4-DEV1: 재시작 뒤 첫 사용이면 DB 의 모의 연결 정보로 모의 공급자 메모리를 다시 채운다(프로세스당 한 번, 모의 모드만)
    await requireMockOAuthReady(config, owner.db); // FIX1-M4DEV1: 다시 채우기 실패면 공급자 호출·상태 변경 없이 503 mock_rehydration_unavailable
    const deps = oauthDeps(config);
    const account = await completeOAuthCallback(owner.db, {
      ownerId: owner.ownerId,
      sessionId: owner.sessionId,
      query: parsed.data,
      requestTarget: requestRedirectTarget(request.url),
      redirectUri: deps.redirectUri,
      providerFor: deps.providerFor,
      keyring: deps.keyring,
    });
    // LIVE-T1: 실제 계정 연결은 다른 문구(게시는 범위 밖) — query 에는 고정 값만
    if (html) return seeOther(`/settings?connected=${account.mock ? '1' : 'live'}#accounts`);
    return json({ account });
  } catch (e) {
    if (html) return accountFormFailure(e);
    return errorResponse(e, request);
  }
});
