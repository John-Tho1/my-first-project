import { appendedAssetList, setVariantAssets, variantVersionView } from '@cs/db';
import { assertSameOrigin, BadRequestError, VARIANT_ROLES, variantAssetsSchema, type VariantRole } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { readRequestFields, validationError } from '../../../../../lib/body';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';
import { MAX_VARIANT_REQUEST, variantBackHref } from '../../../../../lib/variants';
import { writingFormFailure } from '../../../../../lib/writing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/variants/{id}/assets — JSON { base_version, assets: [{asset_id, position, role}] }(목록 전체 교체) → 201 { version }.
 * 폼: { asset_id, role } 한 개를 현재 첨부 뒤에 덧붙인다. 이 owner 의 파일이 아니면 404, 역할·형식 불일치 400.
 * 첨부 변경은 새 버전을 만들고 lifecycle 을 draft 로 되돌린다.
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
    let input: { baseVersion: number; assets: Array<{ assetId: string; position: number; role: VariantRole }> };
    if (body.kind === 'form') {
      const role = body.data.role as VariantRole;
      if (!(VARIANT_ROLES as readonly string[]).includes(role) || !body.data.asset_id) throw new BadRequestError('파일과 역할을 고르세요');
      input = await appendedAssetList(owner.db, owner.ownerId, id.toLowerCase(), body.data.asset_id, role);
    } else {
      const parsed = variantAssetsSchema.safeParse(body.data);
      if (!parsed.success) throw validationError(parsed.error);
      input = {
        baseVersion: parsed.data.base_version,
        assets: parsed.data.assets.map((a) => ({ assetId: a.asset_id, position: a.position, role: a.role })),
      };
    }
    const r = await setVariantAssets(owner.db, owner.ownerId, id.toLowerCase(), input);
    if (html) return seeOther(`/contents/${r.variant.contentId}?variant_saved=${r.variant.channel}#variants`);
    return json({ version: variantVersionView(r.version) }, { status: 201 });
  } catch (e) {
    if (html) return writingFormFailure(e, request, back, '/contents?missing=1');
    return errorResponse(e, request);
  }
}
