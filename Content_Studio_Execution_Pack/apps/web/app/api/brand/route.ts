import { brandProfileView, createBrandProfileVersion, getCurrentBrandProfile, listBrandProfiles } from '@cs/db';
import { assertSameOrigin, brandProfileCreateSchema } from '@cs/domain';
import { apiHandler, errorResponse, json, seeOther, wantsHtml } from '../../../lib/api';
import { readRequestFields, validationError } from '../../../lib/body';
import { getConfig } from '../../../lib/server';
import { requireOwner } from '../../../lib/session';
import { formToBrandCreate, MAX_WRITING_REQUEST, writingFormFailure } from '../../../lib/writing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/brand — { current, versions[] }(최신 먼저). 다른 owner 의 버전은 보이지 않는다. */
export const GET = apiHandler(async (request) => {
  const owner = await requireOwner(request);
  const current = await getCurrentBrandProfile(owner.db, owner.ownerId);
  const versions = await listBrandProfiles(owner.db, owner.ownerId);
  return json({ current: current ? brandProfileView(current) : null, versions: versions.map(brandProfileView) });
});

/**
 * POST /api/brand — 새 버전 저장(append, version = 최대+1). body { base_version, pen_name, audience, pillars[], style_rules[],
 * tone, avoid_phrases[], cta_rules[], sample_texts[] }. base_version ≠ 현재 버전 → 409 { current, yours }. 기존 버전은 바꾸지 않는다.
 * 폼: 성공 303 → /brand?saved=<v>, 충돌 → /brand?error=conflict.
 */
export async function POST(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    const body = await readRequestFields(request, MAX_WRITING_REQUEST);
    const parsed = brandProfileCreateSchema.safeParse(body.kind === 'form' ? formToBrandCreate(body.data) : body.data);
    if (!parsed.success) throw validationError(parsed.error);
    const row = await createBrandProfileVersion(owner.db, owner.ownerId, parsed.data);
    if (html) return seeOther(`/brand?saved=${row.version}`);
    return json({ brand_profile: brandProfileView(row) }, { status: 201 });
  } catch (e) {
    if (html) return writingFormFailure(e, request, '/brand', '/brand');
    return errorResponse(e, request);
  }
}
