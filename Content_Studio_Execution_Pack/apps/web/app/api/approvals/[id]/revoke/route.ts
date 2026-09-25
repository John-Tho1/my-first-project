import { approvalView, revokeApproval } from '@cs/db';
import { assertSameOrigin, revokeSchema } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { readRequestFields, validationError } from '../../../../../lib/body';
import { distributeFormFailure, MAX_DISTRIBUTION_REQUEST } from '../../../../../lib/distribution';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/approvals/{id}/revoke — { reason? } → 200 { approval, blocked_job_ids }. 대기열(QUEUED) 작업은 BLOCKED, 항목은 PLANNED 로,
 * 승인됨 파생본은 review 로. 이미 철회 409 already_revoked, 다른 owner 404. 시작 전 작업만 막는다(전송 중 취소는 T11).
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  let back = '/distribute';
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    const body = await readRequestFields(request, MAX_DISTRIBUTION_REQUEST);
    if (body.kind === 'form' && body.data.plan_id) back = `/distribute/${encodeURIComponent(body.data.plan_id)}`;
    const parsed = revokeSchema.safeParse(body.kind === 'form' ? { reason: body.data.reason || undefined } : body.data);
    if (!parsed.success) throw validationError(parsed.error);
    const r = await revokeApproval(owner.db, owner.ownerId, id.toLowerCase(), parsed.data.reason);
    if (html) return seeOther(`/distribute/${r.planId}?revoked=1`);
    return json({ approval: approvalView(r.approval), plan_id: r.planId, blocked_job_ids: r.blockedJobIds });
  } catch (e) {
    if (html) return distributeFormFailure(e, request, back);
    return errorResponse(e, request);
  }
}
