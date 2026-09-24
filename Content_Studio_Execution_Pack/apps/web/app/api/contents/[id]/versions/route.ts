import { appendContentVersion, getContentRow, listContentVersions } from '@cs/db';
import { assertSameOrigin, ConflictError, contentBodyUpdateSchema, NotFoundError } from '@cs/domain';
import { apiHandler, errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { blankToUndefined, readRequestFields, validationError } from '../../../../../lib/body';
import {
  contentView,
  formFailure,
  MAX_CONTENT_REQUEST,
  renderVersionConflictHtml,
  versionSummaryView,
  versionView,
} from '../../../../../lib/contents';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/contents/{id}/versions — 버전 목록(본문 제외, 바이트 길이 포함). */
export const GET = apiHandler<Ctx>(async (request, ctx) => {
  const owner = await requireOwner(request);
  const { id } = await ctx.params;
  const content = await getContentRow(owner.db, owner.ownerId, id.toLowerCase());
  if (!content) throw new NotFoundError('원고를 찾을 수 없습니다');
  const versions = await listContentVersions(owner.db, content.id);
  return json({ items: versions.map(versionSummaryView) });
});

/**
 * POST /api/contents/{id}/versions — 본문 새 버전 저장 { base_version, body, note? }.
 * base_version 이 현재 버전이면 201 { content, version }(version = 현재+1).
 * 아니면 409 { error:'conflict', current:{version, body, created_at}, yours:{base_version, body, note} } — 두 본문 모두 돌려준다(A02).
 * 브라우저 폼: 성공 303 → /contents/{id}?saved_version=<n>, 충돌은 409 비교 화면(현재/내 본문 전체 + diff + 재저장 폼).
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  const contentId = id.toLowerCase();
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    const body = await readRequestFields(request, MAX_CONTENT_REQUEST);
    const raw =
      body.kind === 'form'
        ? { base_version: Number(body.data.base_version), body: body.data.body ?? '', note: blankToUndefined(body.data.note) }
        : body.data;
    const parsed = contentBodyUpdateSchema.safeParse(raw);
    if (!parsed.success) throw validationError(parsed.error);
    const r = await appendContentVersion(owner.db, owner.ownerId, contentId, {
      baseVersion: parsed.data.base_version,
      body: parsed.data.body,
      note: parsed.data.note,
    });
    if (html) return seeOther(`/contents/${r.content.id}?saved_version=${r.version.version}`);
    return json({ content: contentView(r.content), version: versionView(r.version) }, { status: 201 });
  } catch (e) {
    if (html && e instanceof ConflictError) {
      const current = e.extra!.current as { version: number; body: string };
      const yours = e.extra!.yours as { base_version: number; body: string; note: string | null };
      return renderVersionConflictHtml(contentId, current, yours);
    }
    if (html) return formFailure(e, request, `/contents/${encodeURIComponent(id)}`, '/contents?missing=1');
    return errorResponse(e, request);
  }
}
