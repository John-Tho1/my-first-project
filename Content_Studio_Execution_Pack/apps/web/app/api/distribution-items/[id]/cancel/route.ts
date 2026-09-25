import { cancelItem } from '@cs/db';
import { assertSameOrigin, cancelSchema } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { readRequestFields, validationError } from '../../../../../lib/body';
import { distributeFormFailure, MAX_DISTRIBUTION_REQUEST } from '../../../../../lib/distribution';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/distribution-items/{id}/cancel — {} → 200
 * - 아직 시작하지 않은 작업(QUEUED·RETRY_WAIT·BLOCKED): { canceled: true, state: 'CANCELED' }
 * - 이미 전송 단계(LEASED·SENDING·REMOTE_PROCESSING·RECONCILING): { cancel_requested: true, state: 'CANCEL_REQUESTED', message: '취소 확인 중' }
 *   — 원격 취소를 주장하지 않는다(A11). worker 가 원격 결과를 확인해 CANCELED 또는 CONFIRMED(취소 불가, 이미 전송됨)로 정한다.
 * UNKNOWN 409 cancel_unknown, 끝난·실행 전 항목 409 not_cancellable, 다른 owner 404.
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
    const parsed = cancelSchema.safeParse(body.kind === 'form' ? {} : body.data);
    if (!parsed.success) throw validationError(parsed.error);
    const r = await cancelItem(owner.db, owner.ownerId, id.toLowerCase());
    if (html) return seeOther(`${back}${back.includes('?') ? '&' : '?'}${r.canceled ? 'canceled=1' : 'cancel_requested=1'}`);
    return json(r);
  } catch (e) {
    if (html) return distributeFormFailure(e, request, back);
    return errorResponse(e, request);
  }
}
