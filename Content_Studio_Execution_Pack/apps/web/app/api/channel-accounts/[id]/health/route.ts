import { getAccountHealth } from '@cs/db';
import { apiHandler, json } from '../../../../../lib/api';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/channel-accounts/{id}/health — 연결 상태(T13). DB 기록만 읽는다(공급자 호출 없음). 다른 owner 의 계정은 404.
 * { account: { status(connected·expiring_soon·expired·revoked·needs_reconnect·error·not_connected), usable_for_execution, scopes_required,
 *   scopes_granted, missing_scopes, expires_at, last_checked_at, mock, notice, … } } — 토큰·암호문 없음.
 */
export const GET = apiHandler<Ctx>(async (request, ctx) => {
  const owner = await requireOwner(request);
  const { id } = await ctx.params;
  return json({ account: await getAccountHealth(owner.db, owner.ownerId, id) });
});
