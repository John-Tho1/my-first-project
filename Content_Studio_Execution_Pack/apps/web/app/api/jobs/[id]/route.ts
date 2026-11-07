import { getJobDetail } from '@cs/db';
import { NotFoundError } from '@cs/domain';
import { apiHandler, json } from '../../../../lib/api';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/jobs/{id} — 작업의 실제 상태(비밀·본문 없음): { job, events(최근 50), intents, publications }.
 * lease_owner 는 worker 표시 이름뿐(호스트 이름 없음). 모의 결과는 verification=MOCK·is_mock=true(실제 발행 실적 아님). 다른 owner → 404.
 */
export const GET = apiHandler<Ctx>(async (request, ctx) => {
  const owner = await requireOwner(request);
  const { id } = await ctx.params;
  const d = await getJobDetail(owner.db, owner.ownerId, id.toLowerCase());
  if (!d) throw new NotFoundError('작업을 찾을 수 없습니다');
  return json(d);
});
