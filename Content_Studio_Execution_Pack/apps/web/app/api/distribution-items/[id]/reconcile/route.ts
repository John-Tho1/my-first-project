import { reconcileItem } from '@cs/db';
import { assertSameOrigin, reconcileSchema } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { readRequestFields, validationError } from '../../../../../lib/body';
import { distributeFormFailure, MAX_DISTRIBUTION_REQUEST } from '../../../../../lib/distribution';
import { getChannelAdapters, getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/distribution-items/{id}/reconcile — {} → 200 { item_id, job_id, state_before, state, found, remote }.
 * 기존 결과 조회만(docs/04): 확인 중·결과 불명(UNKNOWN)·원격 처리 중 작업의 원격 상태를 읽고, 찾으면 CONFIRMED(+ 모의 결과 = MOCK),
 * 못 찾으면 상태 그대로. 절대 다시 보내지 않는다. 대상 작업 없음 409 nothing_to_reconcile, 다른 owner 404.
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  let back = '/distribute';
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const body = await readRequestFields(request, MAX_DISTRIBUTION_REQUEST);
    if (body.kind === 'form' && body.data.plan_id) back = `/distribute/${encodeURIComponent(body.data.plan_id)}`;
    const parsed = reconcileSchema.safeParse(body.kind === 'form' ? {} : body.data);
    if (!parsed.success) throw validationError(parsed.error);
    const r = await reconcileItem(owner.db, getChannelAdapters(), owner.ownerId, id.toLowerCase(), { timeoutMs: config.JOB_SUBMIT_TIMEOUT_MS });
    if (html) return seeOther(`${back}${back.includes('?') ? '&' : '?'}reconciled=${r.found ? 'found' : 'not_found'}`);
    return json(r);
  } catch (e) {
    if (html) return distributeFormFailure(e, request, back);
    return errorResponse(e, request);
  }
}
