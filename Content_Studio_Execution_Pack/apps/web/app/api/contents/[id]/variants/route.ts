import {
  createVariantDraft,
  generationRunView,
  getContentRow,
  getVariantState,
  listVariantStates,
  runVariantAssist,
  usageLedgerView,
  variantStateView,
  variantVersionView,
} from '@cs/db';
import { assertSameOrigin, budgetPolicy, NotFoundError, variantCreateSchema } from '@cs/domain';
import { MOCK_WARNING } from '@cs/providers';
import { apiHandler, errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { readRequestFields, validationError } from '../../../../../lib/body';
import { getConfig, getLlm } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';
import { formToVariantCreate, MAX_VARIANT_REQUEST } from '../../../../../lib/variants';
import { writingFormFailure } from '../../../../../lib/writing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/contents/{id}/variants — 채널 파생본(현재 버전·stale·미디어 완성·채택 전 AI 제안). 다른 owner → 404. */
export const GET = apiHandler<Ctx>(async (request, ctx) => {
  const owner = await requireOwner(request);
  const { id } = await ctx.params;
  const content = await getContentRow(owner.db, owner.ownerId, id.toLowerCase());
  if (!content || !content.currentVersionId) throw new NotFoundError('원고를 찾을 수 없습니다');
  const states = await listVariantStates(owner.db, owner.ownerId, content.id, content.currentVersionId);
  return json({ items: states.map(variantStateView) });
});

/**
 * POST /api/contents/{id}/variants — { channel: threads|instagram|youtube|blog, mode: draft|ai_draft, base_version(원고 현재 버전) }.
 * - draft: 원고 현재 버전을 채널 모양으로 바꾼 새 현재 버전(결정적). 201 { variant, version }.
 * - ai_draft: 모의 AI 제안(현재가 아닌 버전, 예산 예약·claim 저장 — T07 규칙). 201 { variant, run, proposal, usage, claims, mock_warning }.
 * base_version ≠ 원고 현재 버전 → 409 stale_base. 게시하지 않는다(PUBLISH_MODE=disabled).
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  const back = `/contents/${encodeURIComponent(id)}`;
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const body = await readRequestFields(request, MAX_VARIANT_REQUEST);
    const parsed = variantCreateSchema.safeParse(body.kind === 'form' ? formToVariantCreate(body.data) : body.data);
    if (!parsed.success) throw validationError(parsed.error);
    const { channel, mode, base_version } = parsed.data;
    const contentId = id.toLowerCase();
    if (mode === 'draft') {
      const r = await createVariantDraft(owner.db, owner.ownerId, contentId, { channel, baseVersion: base_version });
      if (html) return seeOther(`/contents/${r.variant.contentId}?variant_saved=${channel}#variants`);
      const state = await getVariantState(owner.db, owner.ownerId, r.variant.id, r.version.contentVersionId);
      return json({ variant: state ? variantStateView(state) : null, version: variantVersionView(r.version) }, { status: 201 });
    }
    const llm = getLlm(config);
    const r = await runVariantAssist(owner.db, owner.ownerId, contentId, { channel, baseVersion: base_version, budget: budgetPolicy(config) }, llm);
    if (html) return seeOther(`/contents/${r.variant.contentId}?variant_proposal=${channel}#variants`);
    return json(
      {
        variant: { id: r.variant.id, channel: r.variant.channel, current_version_id: r.variant.currentVersionId, lifecycle: r.variant.lifecycle },
        run: generationRunView(r.run),
        proposal: variantVersionView(r.proposal),
        claims: r.claims,
        warnings: r.output.warnings,
        usage: usageLedgerView(r.ledger),
        mock_warning: r.run.provider === 'mock' ? MOCK_WARNING : null,
      },
      { status: 201 },
    );
  } catch (e) {
    if (html) return writingFormFailure(e, request, back, '/contents?missing=1');
    return errorResponse(e, request);
  }
}
