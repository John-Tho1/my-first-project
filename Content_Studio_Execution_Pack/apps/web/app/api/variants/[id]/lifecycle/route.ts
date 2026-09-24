import { setVariantLifecycle } from '@cs/db';
import { assertSameOrigin, variantLifecycleSchema } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { readRequestFields, validationError } from '../../../../../lib/body';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';
import { formToVariantLifecycle, MAX_VARIANT_REQUEST, variantBackHref } from '../../../../../lib/variants';
import { writingFormFailure } from '../../../../../lib/writing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/variants/{id}/lifecycle — { lifecycle: draft|review, base_version(현재 파생본 버전) } → 200 { id, lifecycle }.
 * review 로: stale → 409 stale_variant, 미디어 부족 → 409 media_incomplete(missing), 미해결 경험 claim → 409 unconfirmed_experience_claims.
 * review 는 승인이 아니다(APPROVED·게시는 M3).
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  let back = '/contents?missing=1';
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    back = await variantBackHref(owner.db, owner.ownerId, id);
    const body = await readRequestFields(request, MAX_VARIANT_REQUEST);
    const parsed = variantLifecycleSchema.safeParse(body.kind === 'form' ? formToVariantLifecycle(body.data) : body.data);
    if (!parsed.success) throw validationError(parsed.error);
    const v = await setVariantLifecycle(owner.db, owner.ownerId, id.toLowerCase(), {
      lifecycle: parsed.data.lifecycle,
      baseVersion: parsed.data.base_version,
    });
    if (html) return seeOther(`/contents/${v.contentId}?variant_saved=${v.channel}#variants`);
    return json({ id: v.id, channel: v.channel, lifecycle: v.lifecycle });
  } catch (e) {
    if (html) return writingFormFailure(e, request, back, '/contents?missing=1');
    return errorResponse(e, request);
  }
}
