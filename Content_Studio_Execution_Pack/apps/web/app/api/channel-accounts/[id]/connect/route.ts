import { startOAuthConnect } from '@cs/db';
import { assertSameOrigin } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { accountFormFailure, oauthDeps } from '../../../../../lib/oauth';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/channel-accounts/{id}/connect — 계정 연결 시작(T13, D24). 같은 출처·로그인 필요. 다른 owner 의 계정은 404.
 * → 200 { account_id, authorize_url, expires_at, provider, mock, scopes } (폼은 303 으로 authorize_url).
 * authorize_url 에는 OAuth 규약상 state·PKCE challenge 가 들어간다(verifier 는 서버에 봉인, state 는 서버에 hash 만).
 * T13 은 Threads 모의 계정만(모의 공급자, 네트워크 없음). 실제 계정은 503 LIVE_OAUTH_NOT_CONFIGURED. 마스터 키가 없으면 503 secrets_not_configured.
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const deps = oauthDeps(config);
    const r = await startOAuthConnect(owner.db, {
      ownerId: owner.ownerId,
      sessionId: owner.sessionId,
      accountId: id,
      providerFor: deps.providerFor,
      keyring: deps.keyring,
      redirectUri: deps.redirectUri,
    });
    if (html) return seeOther(r.authorizeUrl);
    return json({
      account_id: id.toLowerCase(),
      authorize_url: r.authorizeUrl,
      expires_at: r.expiresAt.toISOString(),
      provider: r.provider,
      mock: r.mock,
      scopes: r.scopes,
      notice: r.mock ? 'MOCK — 모의 연결입니다. 실제 Threads 로 아무것도 보내지 않습니다.' : null,
    });
  } catch (e) {
    if (html) return accountFormFailure(e);
    return errorResponse(e, request);
  }
}
