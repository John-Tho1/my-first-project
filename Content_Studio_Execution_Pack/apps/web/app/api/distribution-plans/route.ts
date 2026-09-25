import { createPlan, listPlans, planView } from '@cs/db';
import { assertSameOrigin, decodeCaptureCursor, encodeCaptureCursor, planCreateSchema } from '@cs/domain';
import { apiHandler, errorResponse, json, seeOther, wantsHtml } from '../../../lib/api';
import { readRequestFields, validationError } from '../../../lib/body';
import { distributeFormFailure, formToPlanCreate, MAX_DISTRIBUTION_REQUEST } from '../../../lib/distribution';
import { getConfig } from '../../../lib/server';
import { requireOwner } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/distribution-plans?cursor= — 배포 계획 목록(최근 순, cursor pagination). 모의 계획이면 mock=true. */
export const GET = apiHandler(async (request) => {
  const owner = await requireOwner(request);
  const raw = new URL(request.url).searchParams.get('cursor');
  const c = raw ? decodeCaptureCursor(raw) : null;
  const page = await listPlans(owner.db, owner.ownerId, { cursor: c ? { at: c.receivedAt, id: c.id } : null, limit: 20 });
  return json({
    items: page.items.map((e) => ({ ...planView(e.plan), item_count: e.itemCount, channels: e.channels, mock: e.mock })),
    next_cursor: page.next ? encodeCaptureCursor(page.next.at, page.next.id) : null,
  });
});

/**
 * POST /api/distribution-plans — { items: [{ variant_id, channel_account_id, requested_result?, visibility?, schedule?: { date, time }(MSK) }], target_summary? }
 * → 201 { plan, items(payload·payload_hash) }. 승인은 만들지 않는다 — approved·approval 같은 입력 키는 버린다.
 * 검토 중이 아닌 초안 409 variant_not_review, stale 409 stale_variant, 미디어 부족 409 media_incomplete, 채널 불일치 400 channel_mismatch,
 * 다른 owner 의 파생본·계정 404, 과거 예약 400 schedule_in_past.
 */
export async function POST(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  let back = '/distribute';
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    const body = await readRequestFields(request, MAX_DISTRIBUTION_REQUEST);
    if (body.kind === 'form' && body.data.content_id) back = `/distribute/new?content_id=${encodeURIComponent(body.data.content_id)}`;
    const parsed = planCreateSchema.safeParse(body.kind === 'form' ? formToPlanCreate(body.data) : body.data);
    if (!parsed.success) throw validationError(parsed.error);
    const r = await createPlan(owner.db, owner.ownerId, parsed.data);
    if (html) return seeOther(`/distribute/${r.plan.id}?created=1`);
    return json(
      {
        plan: planView(r.plan),
        mode: 'MOCK',
        items: r.items.map((i) => ({
          id: i.id,
          variant_id: i.variantId,
          channel_account_id: i.channelAccountId,
          status: i.status,
          requested_result: i.requestedResult,
          visibility: i.visibility,
          scheduled_at_utc: i.scheduledAtUtc ? i.scheduledAtUtc.toISOString() : null,
          payload_hash: i.payloadHash,
          payload: i.payloadJson,
        })),
      },
      { status: 201 },
    );
  } catch (e) {
    if (html) return distributeFormFailure(e, request, back);
    return errorResponse(e, request);
  }
}
