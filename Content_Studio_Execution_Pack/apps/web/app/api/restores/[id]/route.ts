import { getRestoreRun } from '@cs/db';
import { NotFoundError } from '@cs/domain';
import { apiHandler, json } from '../../../../lib/api';
import { restoreRunView } from '../../../../lib/backup';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/restores/{id} — owner 자신의 복원 미리보기·결과. 다른 owner·없는 ID → 404. */
export const GET = apiHandler<{ params: Promise<{ id: string }> }>(async (request, ctx) => {
  const owner = await requireOwner(request);
  const { id } = await ctx.params;
  const run = await getRestoreRun(owner.db, owner.ownerId, id.toLowerCase());
  if (!run) throw new NotFoundError('복원 미리보기를 찾을 수 없습니다');
  return json(restoreRunView(run));
});
