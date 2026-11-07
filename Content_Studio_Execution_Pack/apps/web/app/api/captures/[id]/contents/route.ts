import { createContentFromCapture } from '@cs/db';
import { assertSameOrigin } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { contentView, formFailure, versionView } from '../../../../../lib/contents';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/captures/{id}/contents — 소재에서 원고(초안) 시작.
 * 제목 = capture.title 또는 원문 첫 60자, 본문 = `> 원문:` 인용 블록 + 빈 작성 칸, 소재를 원문(origin)으로 연결.
 * 201 { content, version, capture_ids }. 폼은 303 → /contents/{id}?saved=1. 다른 owner·없는 소재 → 404.
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    const created = await createContentFromCapture(owner.db, owner.ownerId, id);
    if (html) return seeOther(`/contents/${created.content.id}?saved=1`);
    return json(
      { content: contentView(created.content), version: versionView(created.version), capture_ids: created.captureIds },
      { status: 201 },
    );
  } catch (e) {
    if (html) return formFailure(e, request, `/captures/${encodeURIComponent(id)}`, '/captures?missing=1');
    return errorResponse(e, request);
  }
}
