import { generationRunView, runAssist } from '@cs/db';
import { assertSameOrigin, assistRequestSchema, budgetPolicy } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { readRequestFields, validationError } from '../../../../../lib/body';
import { getConfig, getLlm } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';
import { assistResponse, formToAssist, MAX_WRITING_REQUEST, writingFormFailure } from '../../../../../lib/writing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/contents/{id}/assist — AI 작성 보조(현재는 모의만, 결정 D7). body { mode: outline|draft|revise, base_version,
 * brand_profile_version, answer_ids[] }.
 * - provider 를 먼저 확인한다: LLM_MODE=live 는 fail-closed(503) — run·버전을 남기지 않는다.
 * - base_version ≠ 현재 → 409 stale_base(run·버전 없음). 브랜드 버전 없음 → 400. 이 원고의 답변이 아님 → 404.
 * - 성공 201 { run, proposal_version, diff, claims, followup_questions, warnings, mock_warning } — 제안은 현재 버전이 아니다.
 * - provider 실패 → 502 llm_failed(run=failed, 버전 없음, 본문 그대로, 원장은 예약액 전체를 실제액으로 확정).
 * - T07: source_version_ids(이 원고 소재의 출처만, 아니면 404) → 허용 출처. 예산 초과 → 429 budget_exceeded(run·원장·버전 없음).
 * 폼: 303 → /contents/{id}?run=<run_id>#assist.
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const llm = getLlm(config);
    const body = await readRequestFields(request, MAX_WRITING_REQUEST);
    const parsed = assistRequestSchema.safeParse(body.kind === 'form' ? formToAssist(body.data) : body.data);
    if (!parsed.success) throw validationError(parsed.error);
    const r = await runAssist(
      owner.db,
      owner.ownerId,
      id.toLowerCase(),
      {
        mode: parsed.data.mode,
        baseVersion: parsed.data.base_version,
        brandProfileVersion: parsed.data.brand_profile_version,
        answerIds: parsed.data.answer_ids,
        sourceVersionIds: parsed.data.source_version_ids,
        budget: budgetPolicy(config),
      },
      llm,
    );
    if (html) return seeOther(`/contents/${r.run.contentId}?run=${r.run.id}#assist`);
    return json(assistResponse(r, generationRunView(r.run)), { status: 201 });
  } catch (e) {
    if (html) return writingFormFailure(e, request, `/contents/${encodeURIComponent(id)}`, '/contents?missing=1');
    return errorResponse(e, request);
  }
}
