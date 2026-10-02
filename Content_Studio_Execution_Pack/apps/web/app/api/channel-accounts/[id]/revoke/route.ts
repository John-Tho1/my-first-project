import { revokeCredential } from '@cs/db';
import { assertSameOrigin } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { accountFormFailure, oauthDeps } from '../../../../../lib/oauth';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/channel-accounts/{id}/revoke — 연결 해제: 공급자 철회(가능하면) + 암호문 삭제 + revoked_at. 그 계정을 쓰는 활성 승인 철회(account_changed). 다시 연결 전까지 이 계정 실행 차단.
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
    const r = await revokeCredential(owner.db, { ownerId: owner.ownerId, accountId: id, providerFor: deps.providerFor, keyring: deps.keyring });
    if (html) return seeOther('/settings?revoked=1#accounts');
    return json({ account: r.health, outcome: r.outcome, remote_revoke: r.remoteRevoke, revoked_approvals: r.revokedApprovals });
  } catch (e) {
    if (html) return accountFormFailure(e);
    return errorResponse(e, request);
  }
}
