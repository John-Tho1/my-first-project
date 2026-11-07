import { createIdea, listIdeas } from '@cs/db';
import { assertSameOrigin, BadRequestError, decodeCaptureCursor, encodeCaptureCursor, ideaCreateSchema } from '@cs/domain';
import { apiHandler, errorResponse, json, seeOther, wantsHtml } from '../../../lib/api';
import { readRequestFields, validationError } from '../../../lib/body';
import { formFailure, formToIdeaCreate, ideaView, MAX_IDEA_REQUEST } from '../../../lib/contents';
import { getConfig } from '../../../lib/server';
import { requireOwner } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/ideas — 콘텐츠 카드 생성(수동 입력, AI 없음). capture_ids 는 같은 owner 의 소재만(아니면 404).
 * 201 { idea }. 브라우저 폼은 303 → /ideas/{id}?saved=1.
 */
export async function POST(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    const body = await readRequestFields(request, MAX_IDEA_REQUEST);
    const raw = body.kind === 'form' ? formToIdeaCreate(body.data) : body.data;
    const parsed = ideaCreateSchema.safeParse(raw);
    if (!parsed.success) throw validationError(parsed.error);
    const idea = await createIdea(owner.db, owner.ownerId, parsed.data);
    if (html) return seeOther(`/ideas/${idea.id}?saved=1`);
    return json({ idea: ideaView(idea, parsed.data.capture_ids ?? []) }, { status: 201 });
  } catch (e) {
    if (html) return formFailure(e, request, '/ideas', '/ideas?missing=1');
    return errorResponse(e, request);
  }
}

/** GET /api/ideas?cursor=&limit= — (updated_at desc, id desc) cursor pagination. */
export const GET = apiHandler(async (request) => {
  const owner = await requireOwner(request);
  const params = new URL(request.url).searchParams;
  const rawCursor = params.get('cursor');
  const c = rawCursor ? decodeCaptureCursor(rawCursor) : null;
  if (rawCursor && !c) throw new BadRequestError('cursor 가 올바르지 않습니다');
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new BadRequestError('limit 은 1~50 사이 정수입니다');
  const page = await listIdeas(owner.db, owner.ownerId, { cursor: c ? { at: c.receivedAt, id: c.id } : null, limit });
  return json({
    items: page.items.map((i) => ideaView(i)),
    next_cursor: page.next ? encodeCaptureCursor(page.next.at, page.next.id) : null,
  });
});
