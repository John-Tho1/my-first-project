import { refreshCredential } from '@cs/db';
import { assertSameOrigin } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { accountFormFailure, requireMockOAuthReady, oauthDeps } from '../../../../../lib/oauth';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/channel-accounts/{id}/refresh — 연결 정보 갱신(만료 전, 공급자 refresh — 모의). 같은 계정이므로 승인은 그대로. 실패 409 credential_refresh_failed.
 * 같은 출처·로그인 필요, 다른 owner 의 계정은 404. 응답·감사에 토큰·암호문 없음(폼은 303 으로 설정 화면).
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    // M4-DEV1: 재시작 뒤 첫 사용이면 DB 의 모의 연결 정보로 모의 공급자 메모리를 다시 채운다(프로세스당 한 번, 모의 모드만)
    await requireMockOAuthReady(config, owner.db); // FIX1-M4DEV1: 다시 채우기 실패면 공급자 호출·상태 변경 없이 503 mock_rehydration_unavailable
    const deps = oauthDeps(config);
    const r = await refreshCredential(owner.db, { ownerId: owner.ownerId, accountId: id, providerFor: deps.providerFor, keyring: deps.keyring });
    if (html) return seeOther('/settings?refreshed=1#accounts');
    return json({ account: r });
  } catch (e) {
    if (html) return accountFormFailure(e);
    return errorResponse(e, request);
  }
}
