import { createContent, listContents } from '@cs/db';
import {
  assertSameOrigin,
  BadRequestError,
  contentCreateSchema,
  contentLifecycleSchema,
  decodeCaptureCursor,
  encodeCaptureCursor,
  MAX_SERIES,
  MAX_TAG,
  parseTagsInput,
} from '@cs/domain';
import { apiHandler, errorResponse, json, seeOther, wantsHtml } from '../../../lib/api';
import { blankToUndefined, readRequestFields, validationError } from '../../../lib/body';
import { contentView, formFailure, MAX_CONTENT_REQUEST, versionView } from '../../../lib/contents';
import { getConfig } from '../../../lib/server';
import { requireOwner } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function formToCreate(f: Record<string, string>) {
  return {
    title: f.title ?? '',
    body: f.body ?? '',
    series: blankToUndefined(f.series),
    audience: blankToUndefined(f.audience),
    tags: parseTagsInput(f.tags),
    idea_id: blankToUndefined(f.idea_id),
    capture_ids: blankToUndefined(f.capture_id) ? [f.capture_id!] : undefined,
  };
}

/**
 * POST /api/contents — 원고 생성: contents + 버전 1(본문) + 원문 연결(capture_ids, 같은 owner 만 — 아니면 404).
 * 201 { content, version, capture_ids }. 폼은 303 → /contents/{id}?saved=1.
 */
export async function POST(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    const body = await readRequestFields(request, MAX_CONTENT_REQUEST);
    const parsed = contentCreateSchema.safeParse(body.kind === 'form' ? formToCreate(body.data) : body.data);
    if (!parsed.success) throw validationError(parsed.error);
    const d = parsed.data;
    const created = await createContent(owner.db, owner.ownerId, {
      title: d.title,
      body: d.body,
      series: d.series,
      audience: d.audience,
      tags: d.tags,
      ideaId: d.idea_id,
      captureIds: d.capture_ids,
    });
    if (html) return seeOther(`/contents/${created.content.id}?saved=1`);
    return json(
      { content: contentView(created.content), version: versionView(created.version), capture_ids: created.captureIds },
      { status: 201 },
    );
  } catch (e) {
    if (html) return formFailure(e, request, '/contents', '/contents?missing=1');
    return errorResponse(e, request);
  }
}

/** GET /api/contents?series=&tag=&lifecycle=&cursor=&limit= — 아카이브 목록(updated_at desc, id desc). */
export const GET = apiHandler(async (request) => {
  const owner = await requireOwner(request);
  const p = new URL(request.url).searchParams;
  const rawCursor = p.get('cursor');
  const c = rawCursor ? decodeCaptureCursor(rawCursor) : null;
  if (rawCursor && !c) throw new BadRequestError('cursor 가 올바르지 않습니다');
  const rawLimit = p.get('limit');
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new BadRequestError('limit 은 1~50 사이 정수입니다');
  const series = blankToUndefined(p.get('series') ?? undefined);
  const tag = blankToUndefined(p.get('tag') ?? undefined);
  if ((series?.length ?? 0) > MAX_SERIES || (tag?.length ?? 0) > MAX_TAG) throw new BadRequestError('필터 값이 너무 깁니다');
  const rawLifecycle = blankToUndefined(p.get('lifecycle') ?? undefined);
  const lifecycle = rawLifecycle === undefined ? undefined : contentLifecycleSchema.safeParse(rawLifecycle);
  if (lifecycle && !lifecycle.success) throw new BadRequestError('lifecycle 은 draft·review·ready·archived 중 하나입니다');
  const page = await listContents(owner.db, owner.ownerId, {
    series,
    tag,
    lifecycle: lifecycle?.data,
    cursor: c ? { at: c.receivedAt, id: c.id } : null,
    limit,
  });
  return json({
    items: page.items.map(contentView),
    next_cursor: page.next ? encodeCaptureCursor(page.next.at, page.next.id) : null,
  });
});
