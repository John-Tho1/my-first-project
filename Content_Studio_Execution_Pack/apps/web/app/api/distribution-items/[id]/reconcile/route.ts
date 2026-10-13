import { reconcileItem } from '@cs/db';
import { assertSameOrigin, reconcileSchema } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { readRequestFields, validationError } from '../../../../../lib/body';
import { distributeFormFailure, MAX_DISTRIBUTION_REQUEST, reconciledParam } from '../../../../../lib/distribution';
import { jobCredentials } from '../../../../../lib/oauth';
import { getChannelAdapters, getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/distribution-items/{id}/reconcile — {} → 200 { item_id, job_id, state_before, state, found, remote }.
 * 기존 결과 조회만(docs/04): 확인 중·결과 불명(UNKNOWN)·원격 처리 중 작업의 원격 상태를 읽고, 찾으면 CONFIRMED(+ 모의 결과 = MOCK),
 * 못 찾으면 상태 그대로. 절대 다시 보내지 않는다. 대상 작업 없음 409 nothing_to_reconcile, 다른 owner 404.
 * 화면 폼: reconciled=found|not_found|unsupported|unknown(M3 화면 FIX D8 — 조회 미지원·불명을 "찾지 못함"으로 뭉개지 않는다).
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  let back = '/distribute';
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const body = await readRequestFields(request, MAX_DISTRIBUTION_REQUEST);
    if (body.kind === 'form' && body.data.plan_id) back = `/distribute/${encodeURIComponent(body.data.plan_id)}`;
    const parsed = reconcileSchema.safeParse(body.kind === 'form' ? {} : body.data);
    if (!parsed.success) throw validationError(parsed.error);
    // FIX-LIVEP1(Codex P1): 연결 정보 의존성을 작업 처리기와 같게 넘긴다(키 묶음 — 실제 계정 조회는 서버 안에서 봉인 해제한 토큰으로만).
    const r = await reconcileItem(owner.db, getChannelAdapters(config), owner.ownerId, id.toLowerCase(), { timeoutMs: config.JOB_SUBMIT_TIMEOUT_MS, credentials: jobCredentials(config, owner.db) });
    if (html) return seeOther(`${back}${back.includes('?') ? '&' : '?'}reconciled=${r.outcome === 'stale_lookup' ? 'stale' : reconciledParam(r.remote)}`);
    return json(r);
  } catch (e) {
    if (html) return distributeFormFailure(e, request, back);
    return errorResponse(e, request);
  }
}
