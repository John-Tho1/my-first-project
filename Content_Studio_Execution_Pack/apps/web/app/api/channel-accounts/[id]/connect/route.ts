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
 * 모의 계정은 모의 공급자(네트워크 없음). LIVE-T1(D31): 실제 Threads 계정은 준비 상태가 모두 갖춰졌을 때만 threads.com 인증 창 주소(이 요청 자체는
 * 외부 호출 없음 — 주소만 만든다), 아니면 503 live_oauth_not_configured(빠진 이름만). 마스터 키가 없으면 503 secrets_not_configured.
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
      notice: r.mock
        ? 'MOCK — 모의 연결입니다. 실제 Threads 로 아무것도 보내지 않습니다.'
        : '실제 Threads 인증 창으로 이동합니다(연결·프로필 조회만 — D31). 게시는 하지 않습니다.',
    });
  } catch (e) {
    if (html) return accountFormFailure(e);
    return errorResponse(e, request);
  }
}
