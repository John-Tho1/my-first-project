import { getCollectorRun, listCollectedItems } from '@cs/db';
import { NotFoundError } from '@cs/domain';
import { apiHandler, json } from '../../../../../lib/api';
import { itemView, runView } from '../../../../../lib/collector';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/collector/runs/{id} — 수집 실행(미리보기·결과)과 항목. 다른 owner·없는 ID → 404. */
export const GET = apiHandler<{ params: Promise<{ id: string }> }>(async (request, ctx) => {
  const owner = await requireOwner(request);
  const { id } = await ctx.params;
  const run = await getCollectorRun(owner.db, owner.ownerId, id.toLowerCase());
  if (!run) throw new NotFoundError('수집 실행을 찾을 수 없습니다');
  const items = await listCollectedItems(owner.db, owner.ownerId, run.id);
  return json({ run: runView(run), items: items.map(itemView) });
});
