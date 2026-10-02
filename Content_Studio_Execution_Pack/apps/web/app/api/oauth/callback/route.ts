import { completeOAuthCallback } from '@cs/db';
import { oauthCallbackQuerySchema, OAuthFlowError, requestRedirectTarget } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../lib/api';
import { accountFormFailure, oauthDeps } from '../../../../lib/oauth';
import { getConfig } from '../../../../lib/server';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/oauth/callback?code&state(|error) — 계정 연결 callback(T13, D24). 로그인 필요(state 는 이 세션·owner 에 묶여 있다).
 * 검사: state 형식 → 이 owner 의 연결 요청 → 미사용(먼저 사용 처리 — 실패해도 재사용 불가) → 같은 세션 → 10분 안 → 요청 주소 = 등록 redirect URI
 * (정확 일치) → 공급자 거부 아님 → PKCE verifier 로 code 교환 → 공급자 계정 = 이 배포 계정. 통과하면 토큰을 봉인 저장.
 * 성공 200 { account } (폼·브라우저는 303 /settings?connected=1). 오류는 400 oauth_* / 409 oauth_account_mismatch — 응답에 code·state·토큰 없음.
 * GET 이지만 같은 출처 검사 대신 state(세션 결합·1회용)가 CSRF 를 막는다(OAuth 규약).
 */
export async function GET(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  try {
    const config = getConfig();
    const owner = await requireOwner(request);
    const url = new URL(request.url);
    const parsed = oauthCallbackQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
    if (!parsed.success) throw new OAuthFlowError('oauth_bad_request');
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
    if (html) return seeOther('/settings?connected=1#accounts', { 'referrer-policy': 'no-referrer' });
    return json({ account }, { headers: { 'referrer-policy': 'no-referrer' } });
  } catch (e) {
    if (html) return accountFormFailure(e);
    return errorResponse(e, request);
  }
}
