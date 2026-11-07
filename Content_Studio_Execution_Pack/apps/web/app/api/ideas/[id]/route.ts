import { getIdea, updateIdea } from '@cs/db';
import {
  assertSameOrigin,
  BadRequestError,
  ConflictError,
  ideaPatchSchema,
  NotFoundError,
  parseIfMatchRevision,
} from '@cs/domain';
import { apiHandler, json, seeOther } from '../../../../lib/api';
import { readRequestFields, validationError } from '../../../../lib/body';
import { revisionEtag } from '../../../../lib/captures';
import {
  formFailure,
  formToIdeaPatch,
  ideaView,
  jsonObject,
  MAX_IDEA_REQUEST,
  methodNotAllowed,
  nz,
  renderFieldsConflictHtml,
  tagsText,
} from '../../../../lib/contents';
import { RISK_LABEL } from '../../../../lib/labels';
import { getConfig } from '../../../../lib/server';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };
const NOT_FOUND = '카드를 찾을 수 없습니다';

/** GET /api/ideas/{id} — 카드 + 연결 소재 + 이 카드에서 시작한 원고. 다른 owner·없는 ID → 404. */
export const GET = apiHandler<Ctx>(async (request, ctx) => {
  const owner = await requireOwner(request);
  const { id } = await ctx.params;
  const d = await getIdea(owner.db, owner.ownerId, id.toLowerCase());
  if (!d) throw new NotFoundError(NOT_FOUND);
  return json(
    {
      idea: ideaView(d.idea, d.captures.map((c) => c.id)),
      captures: d.captures.map((c) => ({ id: c.id, title: c.title, raw_text: c.rawText, received_at: c.receivedAt.toISOString() })),
      contents: d.contents.map((c) => ({ id: c.id, title: c.title, lifecycle: c.lifecycle, updated_at: c.updatedAt.toISOString() })),
    },
    { headers: { etag: revisionEtag(d.idea.revision) } },
  );
});

async function applyPatch(owner: Awaited<ReturnType<typeof requireOwner>>, id: string, raw: unknown) {
  const parsed = ideaPatchSchema.safeParse(raw);
  if (!parsed.success) throw validationError(parsed.error);
  const { expected_revision, ...patch } = parsed.data;
  return updateIdea(owner.db, owner.ownerId, id.toLowerCase(), patch, expected_revision);
}

/**
 * PATCH /api/ideas/{id} — `If-Match: "<revision>"` 또는 본문 expected_revision(둘 다면 헤더 우선).
 * stale → 409 { current, yours }.
 */
export const PATCH = apiHandler<Ctx>(async (request, ctx) => {
  assertSameOrigin(request, getConfig());
  const { id } = await ctx.params;
  const ifMatch = parseIfMatchRevision(request.headers.get('if-match'));
  if (ifMatch === undefined) throw new BadRequestError('If-Match 형식이 올바르지 않습니다. 예: If-Match: "3"');
  const owner = await requireOwner(request);
  const data = jsonObject(await readRequestFields(request, MAX_IDEA_REQUEST));
  const updated = await applyPatch(owner, id, ifMatch === null ? data : { ...data, expected_revision: ifMatch });
  return json({ idea: ideaView(updated) }, { headers: { etag: revisionEtag(updated.revision) } });
});

/** POST /api/ideas/{id} — 폼 수정 경로(`_method=PATCH`). 성공 303 → /ideas/{id}?updated=<rev>, 충돌 409 비교 화면. */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  const back = `/ideas/${encodeURIComponent(id)}`;
  let form: Record<string, string> = {};
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    const body = await readRequestFields(request, MAX_IDEA_REQUEST);
    if (body.kind !== 'form' || body.data._method !== 'PATCH') return methodNotAllowed('GET, PATCH');
    form = body.data;
    const updated = await applyPatch(owner, id, formToIdeaPatch(form));
    return seeOther(`${back}?updated=${updated.revision}`);
  } catch (e) {
    if (e instanceof ConflictError) {
      const cur = e.extra!.current as Record<string, unknown>;
      const riskOptions = Object.entries(RISK_LABEL) as Array<[string, string]>;
      return renderFieldsConflictHtml({
        title: '카드 수정 충돌',
        action: `/api/ideas/${id.toLowerCase()}`,
        backHref: back,
        currentRevision: Number(cur.revision),
        fields: [
          { name: 'idea', label: '핵심 아이디어(Idea)', current: nz(cur.idea), yours: nz(form.idea), input: 'textarea', maxLength: 500 },
          { name: 'audience', label: '독자(Audience)', current: nz(cur.audience), yours: nz(form.audience), input: 'text', maxLength: 500 },
          { name: 'evidence', label: '근거(Evidence)', current: nz(cur.evidence), yours: nz(form.evidence), input: 'textarea', maxLength: 2000 },
          { name: 'risk', label: '위험(Risk)', current: RISK_LABEL[nz(cur.risk)] ?? nz(cur.risk), yours: nz(form.risk), input: { options: riskOptions } },
          { name: 'next_question', label: '다음 질문', current: nz(cur.next_question), yours: nz(form.next_question), input: 'textarea', maxLength: 2000 },
          { name: 'next_decision', label: '다음 결정(Next Decision)', current: nz(cur.next_decision), yours: nz(form.next_decision), input: 'textarea', maxLength: 2000 },
          { name: 'tags', label: '태그(쉼표로 구분)', current: tagsText(cur.tags), yours: nz(form.tags), input: 'text' },
        ],
      });
    }
    return formFailure(e, request, back, '/ideas?missing=1');
  }
}
