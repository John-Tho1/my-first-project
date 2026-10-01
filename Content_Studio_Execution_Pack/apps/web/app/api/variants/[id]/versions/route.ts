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
 * 화면 폼(form-urlencoded)은 본문이 기준 — 본문과 중복되는 칸(thread_parts·text·caption·script·markdown)은 본문에서 만들고,
 * metadata(JSON) 칸에서는 나머지만 받는다. 오류는 구체 코드로 되돌린다(metadata_json·invalid_metadata·thread_part_too_long 등).
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
    const form = body.kind === 'form';
    const parsed = variantEditSchema.safeParse(form ? formToVariantEdit(body.data) : body.data);
    if (!parsed.success) throw validationError(parsed.error);
    const r = await appendVariantVersion(owner.db, owner.ownerId, id.toLowerCase(), {
      baseVersion: parsed.data.base_version,
      body: parsed.data.body,
      metadata: parsed.data.metadata,
      // M3 화면 FIX(D2): 화면 폼은 본문이 기준(중복 칸을 본문에서 만든다). JSON API 는 불일치를 계속 400 으로 거부.
      bodyAuthoritative: form,
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
