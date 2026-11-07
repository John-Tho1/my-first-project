import { createIdea } from '@cs/db';
import { assertSameOrigin, ideaCreateSchema, isUuid, NotFoundError } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { readRequestFields, validationError } from '../../../../../lib/body';
import { formFailure, formToIdeaCreate, ideaView, MAX_IDEA_REQUEST } from '../../../../../lib/contents';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/captures/{id}/ideas — 소재를 콘텐츠 카드로 발전(docs/04 "소재화"). 수동 입력만(AI 없음, M2 에서 제안 추가).
 * 경로의 capture 를 연결 소재 맨 앞에 넣는다(본문의 capture_ids 와 합침). 다른 owner·없는 소재 → 404.
 * 201 { idea }. 폼은 303 → /ideas/{id}?saved=1.
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  const captureId = id.toLowerCase();
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    if (!isUuid(captureId)) throw new NotFoundError('소재를 찾을 수 없습니다');
    const body = await readRequestFields(request, MAX_IDEA_REQUEST);
    let raw: unknown;
    if (body.kind === 'form') {
      raw = formToIdeaCreate(body.data, captureId);
    } else {
      const data = (body.data ?? {}) as Record<string, unknown>;
      const extra = Array.isArray(data.capture_ids) ? (data.capture_ids as unknown[]) : [];
      raw = typeof data === 'object' && !Array.isArray(data) ? { ...data, capture_ids: [captureId, ...extra] } : data;
    }
    const parsed = ideaCreateSchema.safeParse(raw);
    if (!parsed.success) throw validationError(parsed.error);
    const idea = await createIdea(owner.db, owner.ownerId, parsed.data);
    if (html) return seeOther(`/ideas/${idea.id}?saved=1`);
    return json({ idea: ideaView(idea, [...new Set(parsed.data.capture_ids ?? [])]) }, { status: 201 });
  } catch (e) {
    if (html) return formFailure(e, request, `/captures/${encodeURIComponent(id)}`, '/captures?missing=1');
    return errorResponse(e, request);
  }
}
