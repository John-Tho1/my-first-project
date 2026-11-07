import { dismissProposal, variantContentId } from '@cs/db';
import { assertSameOrigin, NotFoundError } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../../../lib/api';
import { getConfig } from '../../../../../../../lib/server';
import { requireOwner } from '../../../../../../../lib/session';
import { writingFormFailure } from '../../../../../../../lib/writing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string; runId: string }> };

/**
 * POST /api/variants/{id}/proposals/{runId}/dismiss — 채널 초안 AI 제안 무시(proposal_status='dismissed'). 200 { run_id, proposal_status }.
 * 버전 행은 불변으로 남고 목록에서만 빠진다. 이미 채택·무시 → 409, 다른 owner·다른 파생본 → 404. 본문은 읽지 않는다.
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id, runId } = await ctx.params;
  let back = '/contents?missing=1';
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    const contentId = await variantContentId(owner.db, owner.ownerId, id.toLowerCase());
    if (!contentId) throw new NotFoundError('채널 초안을 찾을 수 없습니다');
    back = `/contents/${contentId}`;
    await dismissProposal(owner.db, owner.ownerId, { contentId, variantId: id.toLowerCase() }, runId);
    if (html) return seeOther(`${back}#variants`);
    return json({ run_id: runId.toLowerCase(), proposal_status: 'dismissed' });
  } catch (e) {
    if (html) return writingFormFailure(e, request, back, '/contents?missing=1');
    return errorResponse(e, request);
  }
}
