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
 * POST /api/approvals/{id}/revoke — { reason? } → 200 { approval, blocked_job_ids, cancel_requested_job_ids }. 대기열(QUEUED) 작업은 BLOCKED,
 * 항목은 PLANNED 로, 승인됨 파생본은 review 로. 이미 전송 단계(LEASED·SENDING·REMOTE_PROCESSING·RECONCILING)인 작업은 되돌렸다고 주장하지 않고
 * CANCEL_REQUESTED("취소 확인 중")로 기록한다(T11 D18). 재시도 대기 작업도 즉시 BLOCKED(T12 D19). HTML 은 저장된 결과 수를 안내에 넘긴다. 이미 철회 409, 다른 owner 404.
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
    // FIX-T11(P2): 안내는 저장된 결과로 — 철회로 BLOCKED 된 작업 수, CANCEL_REQUESTED 로 기록된 작업 수.
    if (html) return seeOther(`/distribute/${r.planId}?revoked=1&revoked_blocked=${r.blockedJobIds.length}&revoked_cancel=${r.cancelRequestedJobIds.length}`);
    return json({ approval: approvalView(r.approval), plan_id: r.planId, blocked_job_ids: r.blockedJobIds, cancel_requested_job_ids: r.cancelRequestedJobIds });
  } catch (e) {
    if (html) return distributeFormFailure(e, request, back);
    return errorResponse(e, request);
  }
}
