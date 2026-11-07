import { dismissProposal } from '@cs/db';
import { assertSameOrigin } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../../../lib/api';
import { getConfig } from '../../../../../../../lib/server';
import { requireOwner } from '../../../../../../../lib/session';
import { writingFormFailure } from '../../../../../../../lib/writing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string; runId: string }> };

/**
 * POST /api/contents/{id}/assist/{runId}/dismiss — 원고 AI 제안 무시(proposal_status='dismissed'). 200 { run_id, proposal_status }.
 * 제안 버전은 불변으로 남는다(버전 목록의 "AI 제안(모의)"). 이미 채택·무시 → 409, 다른 owner·다른 원고·채널 초안 run → 404.
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id, runId } = await ctx.params;
  const back = `/contents/${encodeURIComponent(id)}`;
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    await dismissProposal(owner.db, owner.ownerId, { contentId: id.toLowerCase() }, runId);
    if (html) return seeOther(`/contents/${id.toLowerCase()}?run=none#assist`);
    return json({ run_id: runId.toLowerCase(), proposal_status: 'dismissed' });
  } catch (e) {
    if (html) return writingFormFailure(e, request, back, '/contents?missing=1');
    return errorResponse(e, request);
  }
}
