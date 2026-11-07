import { getContentDetail, updateContentMeta } from '@cs/db';
import {
  allowedLifecycleOptions,
  assertSameOrigin,
  BadRequestError,
  ConflictError,
  contentLifecycleSchema,
  contentMetaPatchSchema,
  NotFoundError,
  parseIfMatchRevision,
} from '@cs/domain';
import { apiHandler, json, seeOther } from '../../../../lib/api';
import { readRequestFields, validationError } from '../../../../lib/body';
import { revisionEtag } from '../../../../lib/captures';
import {
  contentDetailView,
  contentView,
  formFailure,
  formToContentMetaPatch,
  jsonObject,
  LIFECYCLE_LABEL,
  MAX_IDEA_REQUEST,
  methodNotAllowed,
  nz,
  renderFieldsConflictHtml,
  tagsText,
} from '../../../../lib/contents';
import { getConfig } from '../../../../lib/server';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };
const NOT_FOUND = '원고를 찾을 수 없습니다';

/** GET /api/contents/{id} — 원고 + 현재 본문 + 버전 목록 + 원문(수집) + 카드. ETag = 메타데이터 revision. */
export const GET = apiHandler<Ctx>(async (request, ctx) => {
  const owner = await requireOwner(request);
  const { id } = await ctx.params;
  const d = await getContentDetail(owner.db, owner.ownerId, id.toLowerCase());
  if (!d) throw new NotFoundError(NOT_FOUND);
  return json(contentDetailView(d), { headers: { etag: revisionEtag(d.content.revision) } });
});

async function applyPatch(owner: Awaited<ReturnType<typeof requireOwner>>, id: string, raw: unknown) {
  const parsed = contentMetaPatchSchema.safeParse(raw);
  if (!parsed.success) throw validationError(parsed.error);
  const { expected_revision, ...patch } = parsed.data;
  return updateContentMeta(owner.db, owner.ownerId, id.toLowerCase(), patch, expected_revision);
}

/**
 * PATCH /api/contents/{id} — 메타데이터(제목·연재·독자·태그·상태) 수정. 본문은 POST /versions 로만.
 * `If-Match: "<revision>"` 또는 expected_revision. stale → 409 { current, yours }. 허용되지 않은 상태 전이 → 400 invalid_transition.
 */
export const PATCH = apiHandler<Ctx>(async (request, ctx) => {
  assertSameOrigin(request, getConfig());
  const { id } = await ctx.params;
  const ifMatch = parseIfMatchRevision(request.headers.get('if-match'));
  if (ifMatch === undefined) throw new BadRequestError('If-Match 형식이 올바르지 않습니다. 예: If-Match: "3"');
  const owner = await requireOwner(request);
  const data = jsonObject(await readRequestFields(request, MAX_IDEA_REQUEST));
  if ('body' in data) throw new BadRequestError('본문은 POST /api/contents/{id}/versions 로 새 버전을 추가해 바꿉니다');
  const updated = await applyPatch(owner, id, ifMatch === null ? data : { ...data, expected_revision: ifMatch });
  return json({ content: contentView(updated) }, { headers: { etag: revisionEtag(updated.revision) } });
});

/** POST /api/contents/{id} — 메타데이터 폼 경로(`_method=PATCH`). 성공 303 → /contents/{id}?meta_updated=<rev>, 충돌 409 비교 화면. */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  const back = `/contents/${encodeURIComponent(id)}`;
  let form: Record<string, string> = {};
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    const body = await readRequestFields(request, MAX_IDEA_REQUEST);
    if (body.kind !== 'form' || body.data._method !== 'PATCH') return methodNotAllowed('GET, PATCH');
    form = body.data;
    const updated = await applyPatch(owner, id, formToContentMetaPatch(form));
    return seeOther(`${back}?meta_updated=${updated.revision}`);
  } catch (e) {
    if (e instanceof ConflictError) {
      const cur = e.extra!.current as Record<string, unknown>;
      const curLifecycle = contentLifecycleSchema.safeParse(cur.lifecycle);
      const options = (curLifecycle.success ? allowedLifecycleOptions(curLifecycle.data) : []).map(
        (v) => [v, LIFECYCLE_LABEL[v] ?? v] as [string, string],
      );
      return renderFieldsConflictHtml({
        title: '원고 정보 수정 충돌',
        action: `/api/contents/${id.toLowerCase()}`,
        backHref: back,
        currentRevision: Number(cur.revision),
        fields: [
          { name: 'title', label: '제목', current: nz(cur.title), yours: nz(form.title), input: 'text', maxLength: 200 },
          { name: 'series', label: '연재', current: nz(cur.series), yours: nz(form.series), input: 'text', maxLength: 100 },
          { name: 'audience', label: '독자', current: nz(cur.audience), yours: nz(form.audience), input: 'text', maxLength: 500 },
          { name: 'tags', label: '태그(쉼표로 구분)', current: tagsText(cur.tags), yours: nz(form.tags), input: 'text' },
          {
            name: 'lifecycle',
            label: '상태',
            current: LIFECYCLE_LABEL[nz(cur.lifecycle)] ?? nz(cur.lifecycle),
            yours: nz(form.lifecycle),
            input: { options },
          },
        ],
      });
    }
    return formFailure(e, request, back, '/contents?missing=1');
  }
}
