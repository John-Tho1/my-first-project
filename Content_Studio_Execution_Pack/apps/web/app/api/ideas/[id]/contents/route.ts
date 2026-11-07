import { createContentFromIdea } from '@cs/db';
import { assertSameOrigin } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { contentView, formFailure, versionView } from '../../../../../lib/contents';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/ideas/{id}/contents — 카드에서 원고 시작. 제목 = 카드 문구, 본문 = 카드 항목 인용 + 빈 작성 칸,
 * 카드의 소재를 원문(origin)으로 연결. 201 { content, version }. 폼은 303 → /contents/{id}?saved=1.
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    const created = await createContentFromIdea(owner.db, owner.ownerId, id);
    if (html) return seeOther(`/contents/${created.content.id}?saved=1`);
    return json(
      { content: contentView(created.content), version: versionView(created.version), capture_ids: created.captureIds },
      { status: 201 },
    );
  } catch (e) {
    if (html) return formFailure(e, request, `/ideas/${encodeURIComponent(id)}`, '/ideas?missing=1');
    return errorResponse(e, request);
  }
}
