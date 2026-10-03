import { discardCollectorRun } from '@cs/db';
import { assertSameOrigin } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../../lib/api';
import { collectFormFailure, runView } from '../../../../../../lib/collector';
import { getConfig } from '../../../../../../lib/server';
import { requireOwner } from '../../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/collector/runs/{id}/discard — 미리보기 버리기(원장에 discarded). 소재는 바뀌지 않는다. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  const back = `/collect/runs/${encodeURIComponent(id)}`;
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const run = await discardCollectorRun(owner.db, owner.ownerId, id);
    if (html) return seeOther(back);
    return json({ run: runView(run) });
  } catch (e) {
    if (html) return collectFormFailure(e, request, back, '/collect');
    return errorResponse(e, request);
  }
}
