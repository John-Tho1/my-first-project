import { appendVariantVersion, getVariantState, variantStateView, variantVersionView } from '@cs/db';
import { assertSameOrigin, variantEditSchema } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { readRequestFields, validationError } from '../../../../../lib/body';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';
import { contentCurrentVersionId, formToVariantEdit, MAX_VARIANT_REQUEST, variantBackHref } from '../../../../../lib/variants';
import { writingFormFailure } from '../../../../../lib/writing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/variants/{id}/versions — 사용자 수정 { base_version(현재 파생본 버전, 없으면 0), body, metadata(채널 형식) }.
 * 201 { variant, version }. base_version 이 현재가 아니면 409 { current, yours }. 채널 형식 위반 → 400 invalid_metadata.
 * 새 버전은 lifecycle 을 draft 로 되돌린다. 수정만으로 stale 이 풀리지 않는다(원고 버전은 그대로).
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
    const parsed = variantEditSchema.safeParse(body.kind === 'form' ? formToVariantEdit(body.data) : body.data);
    if (!parsed.success) throw validationError(parsed.error);
    const r = await appendVariantVersion(owner.db, owner.ownerId, id.toLowerCase(), {
      baseVersion: parsed.data.base_version,
      body: parsed.data.body,
      metadata: parsed.data.metadata,
    });
    if (html) return seeOther(`/contents/${r.variant.contentId}?variant_saved=${r.variant.channel}#variants`);
    const cur = await contentCurrentVersionId(owner.db, owner.ownerId, r.variant.contentId);
    const state = cur ? await getVariantState(owner.db, owner.ownerId, r.variant.id, cur) : null;
    return json({ variant: state ? variantStateView(state) : null, version: variantVersionView(r.version) }, { status: 201 });
  } catch (e) {
    if (html) return writingFormFailure(e, request, back, '/contents?missing=1');
    return errorResponse(e, request);
  }
}
