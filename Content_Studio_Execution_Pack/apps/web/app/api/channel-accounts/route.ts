import { channelAccountView, listChannelAccounts } from '@cs/db';
import { apiHandler, json } from '../../../lib/api';
import { requireOwner } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/channel-accounts — 배포 계정(M3 은 모의 계정만, 인증 비밀 없음). */
export const GET = apiHandler(async (request) => {
  const owner = await requireOwner(request);
  const rows = await listChannelAccounts(owner.db, owner.ownerId);
  return json({ items: rows.map(channelAccountView) });
});
