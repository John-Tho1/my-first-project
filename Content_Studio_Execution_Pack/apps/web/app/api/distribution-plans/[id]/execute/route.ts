import { executePlan } from '@cs/db';
import { assertSameOrigin, executeSchema } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { readRequestFields, validationError } from '../../../../../lib/body';
import { distributeFormFailure, formToExecute, MAX_DISTRIBUTION_REQUEST } from '../../../../../lib/distribution';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/distribution-plans/{id}/execute — { command_key(8~64), item_ids? } → 200 { plan_id, queued: [{ item_id, job_id, mode: 'MOCK' }], mode: 'MOCK', notice, idempotent_replay }.
 * 승인 없음 403 approval_required(아무것도 넣지 않음), 스냅샷 변경 409 snapshot_stale(승인 철회), 이미 실행 409 already_executed.
 * 같은 command_key 재호출 → 저장된 결과(idempotent_replay: true). 실제 게시가 아니다 — 작업은 QUEUED 로만 생기고 T11 이 처리한다.
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  const back = `/distribute/${encodeURIComponent(id)}`;
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const body = await readRequestFields(request, MAX_DISTRIBUTION_REQUEST);
    const parsed = executeSchema.safeParse(body.kind === 'form' ? formToExecute(body.data) : body.data);
    if (!parsed.success) throw validationError(parsed.error);
    const r = await executePlan(owner.db, owner.ownerId, id.toLowerCase(), { commandKey: parsed.data.command_key, itemIds: parsed.data.item_ids }, config);
    if (html) return seeOther(`/distribute/${r.plan_id}?executed=${r.queued.length}${r.idempotent_replay ? '&replay=1' : ''}`);
    return json(r);
  } catch (e) {
    if (html) return distributeFormFailure(e, request, back);
    return errorResponse(e, request);
  }
}
