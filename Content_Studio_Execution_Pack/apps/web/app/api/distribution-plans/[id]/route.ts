import { getPlanDetail, planDetailView } from '@cs/db';
import { NotFoundError } from '@cs/domain';
import { apiHandler, json } from '../../../../lib/api';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/distribution-plans/{id} — 계획·항목(나가는 payload·hash)·활성 승인·작업(MOCK). 다른 owner → 404. */
export const GET = apiHandler<Ctx>(async (request, ctx) => {
  const owner = await requireOwner(request);
  const { id } = await ctx.params;
  const d = await getPlanDetail(owner.db, owner.ownerId, id.toLowerCase());
  if (!d) throw new NotFoundError('배포 계획을 찾을 수 없습니다');
  return json(planDetailView(d));
});
