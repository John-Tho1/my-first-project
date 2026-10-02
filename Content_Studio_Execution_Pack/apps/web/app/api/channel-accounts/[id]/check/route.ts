import { checkCredential } from '@cs/db';
import { assertSameOrigin } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { accountFormFailure, oauthDeps } from '../../../../../lib/oauth';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/channel-accounts/{id}/check — 연결 확인(공급자에 계정 정보 조회 — 모의). last_checked_at 기록, 다른 계정·무효 토큰이면 오류 상태.
 * 같은 출처·로그인 필요, 다른 owner 의 계정은 404. 응답·감사에 토큰·암호문 없음(폼은 303 으로 설정 화면).
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const deps = oauthDeps(config);
    const r = await checkCredential(owner.db, { ownerId: owner.ownerId, accountId: id, providerFor: deps.providerFor, keyring: deps.keyring });
    if (html) return seeOther('/settings?checked=1#accounts');
    return json({ account: r });
  } catch (e) {
    if (html) return accountFormFailure(e);
    return errorResponse(e, request);
  }
}
