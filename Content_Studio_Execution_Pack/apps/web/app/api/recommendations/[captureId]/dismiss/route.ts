import { dismissRecommendation } from '@cs/db';
import { assertSameOrigin } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { collectFormFailure } from '../../../../../lib/collector';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/recommendations/{captureId}/dismiss — "다시 볼 만한 소재" 에서 닫기(멱등). 소재는 바뀌지 않는다. 다른 owner → 404. */
export async function POST(request: Request, ctx: { params: Promise<{ captureId: string }> }): Promise<Response> {
  const html = wantsHtml(request);
  const { captureId } = await ctx.params;
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const out = await dismissRecommendation(owner.db, owner.ownerId, captureId);
    if (html) return seeOther('/captures');
    return json(out);
  } catch (e) {
    if (html) return collectFormFailure(e, request, '/captures', '/captures?missing=1');
    return errorResponse(e, request);
  }
}
