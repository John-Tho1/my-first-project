import { getContentVersion } from '@cs/db';
import { NotFoundError } from '@cs/domain';
import { apiHandler, json } from '../../../../../../lib/api';
import { versionView } from '../../../../../../lib/contents';
import { requireOwner } from '../../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string; n: string }> };

/** GET /api/contents/{id}/versions/{n} — 특정 버전 본문(불변). ETag = 버전 번호. */
export const GET = apiHandler<Ctx>(async (request, ctx) => {
  const owner = await requireOwner(request);
  const { id, n } = await ctx.params;
  const num = /^[1-9][0-9]{0,8}$/.test(n) ? Number(n) : NaN;
  const r = Number.isInteger(num) ? await getContentVersion(owner.db, owner.ownerId, id.toLowerCase(), num) : null;
  if (!r) throw new NotFoundError('버전을 찾을 수 없습니다');
  return json({ version: versionView(r.version) }, { headers: { etag: `"v${r.version.version}"` } });
});
