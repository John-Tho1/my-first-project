import { adoptProposal, generationRunView } from '@cs/db';
import { adoptRequestSchema, assertSameOrigin } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../../../lib/api';
import { readRequestFields, validationError } from '../../../../../../../lib/body';
import { contentView, versionView } from '../../../../../../../lib/contents';
import { getConfig } from '../../../../../../../lib/server';
import { requireOwner } from '../../../../../../../lib/session';
import { MAX_WRITING_REQUEST, writingFormFailure } from '../../../../../../../lib/writing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string; runId: string }> };

/**
 * POST /api/contents/{id}/assist/{runId}/adopt — body { base_version }. 제안 본문으로 새 사용자 버전을 만들어 현재 버전으로 한다.
 * 201 { content, version, run }. base_version 또는 run 의 입력 버전이 현재가 아니면 409 stale_base. 다른 owner·다른 원고의 run → 404.
 * "무시(취소)"는 서버 호출이 없다 — 제안은 현재가 아닌 버전(AI 제안)으로 남는다.
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id, runId } = await ctx.params;
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    const body = await readRequestFields(request, MAX_WRITING_REQUEST);
    const parsed = adoptRequestSchema.safeParse(body.kind === 'form' ? { base_version: Number(body.data.base_version) } : body.data);
    if (!parsed.success) throw validationError(parsed.error);
    const r = await adoptProposal(owner.db, owner.ownerId, id.toLowerCase(), runId, parsed.data.base_version);
    if (html) return seeOther(`/contents/${r.content.id}?saved_version=${r.version.version}&run=${r.run.id}#assist`);
    return json({ content: contentView(r.content), version: versionView(r.version), run: generationRunView(r.run) }, { status: 201 });
  } catch (e) {
    if (html) return writingFormFailure(e, request, `/contents/${encodeURIComponent(id)}`, '/contents?missing=1');
    return errorResponse(e, request);
  }
}
