import { confirmClaims } from '@cs/db';
import { assertSameOrigin, claimConfirmSchema } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../../lib/api';
import { readRequestFields, validationError } from '../../../../../../lib/body';
import { getConfig } from '../../../../../../lib/server';
import { requireOwner } from '../../../../../../lib/session';
import { formToClaimConfirm, MAX_WRITING_REQUEST, writingFormFailure } from '../../../../../../lib/writing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/contents/{id}/claims/confirm — body { run_id, claim_indexes[], resolution?: 'confirmed'|'removed' }(기본 confirmed).
 * 사용자가 AI 제안의 1인칭 경험 claim 을 해결(A03): 사실임을 확인하거나, 본문에서 뺐다고 표시한다.
 * 200 { confirmed, unconfirmed }. 확인이 필요한 claim 이 아니면 400, 다른 owner·다른 원고의 run → 404.
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    const body = await readRequestFields(request, MAX_WRITING_REQUEST);
    const parsed = claimConfirmSchema.safeParse(body.kind === 'form' ? formToClaimConfirm(body.data) : body.data);
    if (!parsed.success) throw validationError(parsed.error);
    const r = await confirmClaims(
      owner.db,
      owner.ownerId,
      id.toLowerCase(),
      parsed.data.run_id,
      parsed.data.claim_indexes,
      parsed.data.resolution,
    );
    if (html) {
      return seeOther(`/contents/${id.toLowerCase()}?confirmed=${r.confirmed.length}&run=${encodeURIComponent(parsed.data.run_id)}#assist`);
    }
    return json({ confirmed: r.confirmed, unconfirmed: r.unconfirmed });
  } catch (e) {
    if (html) return writingFormFailure(e, request, `/contents/${encodeURIComponent(id)}`, '/contents?missing=1');
    return errorResponse(e, request);
  }
}
