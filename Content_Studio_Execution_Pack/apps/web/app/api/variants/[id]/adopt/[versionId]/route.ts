import { adoptVariantProposal, variantVersionView } from '@cs/db';
import { assertSameOrigin, variantAdoptSchema } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../../lib/api';
import { readRequestFields, validationError } from '../../../../../../lib/body';
import { getConfig } from '../../../../../../lib/server';
import { requireOwner } from '../../../../../../lib/session';
import { MAX_VARIANT_REQUEST, variantBackHref } from '../../../../../../lib/variants';
import { writingFormFailure } from '../../../../../../lib/writing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string; versionId: string }> };

/**
 * POST /api/variants/{id}/adopt/{versionId} — { base_version(현재 파생본 버전, 없으면 0) }. AI 제안(모의)을 새 사용자 버전으로 채택.
 * 201 { version }. 제안이 원고 현재 버전에서 나오지 않았으면 409 stale_base, base 불일치 409, 다른 owner·다른 파생본 → 404.
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id, versionId } = await ctx.params;
  let back = '/contents?missing=1';
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    back = await variantBackHref(owner.db, owner.ownerId, id);
    const body = await readRequestFields(request, MAX_VARIANT_REQUEST);
    const parsed = variantAdoptSchema.safeParse(body.kind === 'form' ? { base_version: Number(body.data.base_version) } : body.data);
    if (!parsed.success) throw validationError(parsed.error);
    const r = await adoptVariantProposal(owner.db, owner.ownerId, id.toLowerCase(), versionId, parsed.data.base_version);
    if (html) return seeOther(`/contents/${r.variant.contentId}?variant_saved=${r.variant.channel}#variants`);
    return json({ version: variantVersionView(r.version) }, { status: 201 });
  } catch (e) {
    if (html) return writingFormFailure(e, request, back, '/contents?missing=1');
    return errorResponse(e, request);
  }
}
