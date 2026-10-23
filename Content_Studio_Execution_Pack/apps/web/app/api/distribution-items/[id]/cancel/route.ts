import { cancelItem, planIdOfItem } from '@cs/db';
import { assertSameOrigin, cancelSchema } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { readRequestFields, validationError } from '../../../../../lib/body';
import { cancelRedirectQuery, distributeFormFailure, itemPlanBack, MAX_DISTRIBUTION_REQUEST } from '../../../../../lib/distribution';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/distribution-items/{id}/cancel — {} → 200
 * - 아직 시작하지 않은 작업(QUEUED·RETRY_WAIT·BLOCKED): { canceled: true, state: 'CANCELED' }
 * - 이미 전송 단계(LEASED·SENDING·REMOTE_PROCESSING·RECONCILING): { cancel_requested: true, state: 'CANCEL_REQUESTED', message: '취소 확인 중' }
 *   — 원격 취소를 주장하지 않는다(A11). worker 가 원격 결과를 확인해 CANCELED 또는 CONFIRMED(취소 불가, 이미 전송됨)로 정한다.
 * UNKNOWN 409 cancel_unknown, 끝난·실행 전 항목 409 not_cancellable, 다른 owner 404.
 * FIX3-FULLREV(R2): HTML 폼은 취소됨 → canceled=1, 취소 확인 중 → cancel_requested=1(지금 그대로), 결과 불명(state UNKNOWN — 부분 게시·복원 미확정) →
 * cancel_unknown=1 + 항목 + 허용 목록 사유 코드(cancelRedirectQuery — 화면은 저장된 상태로 전용 배너). JSON 응답은 그대로.
 * FIX4-FULLREV(S4): HTML 폼이 plan_id 없이 오면 /distribute(배너 없음) 대신 항목이 속한 계획 화면(owner 범위 조회 planIdOfItem — 실패하면 /distribute 그대로).
 * 오류 리다이렉트(distributeFormFailure 의 back)도 같다 — owner 를 확인한 뒤에만 조회하므로(CSRF·로그인 실패는 조회 없이 그대로) 다른 owner 의 항목은 찾지 못하고,
 * 404 는 지금처럼 /distribute?missing=1 이다.
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  let back = '/distribute';
  // FIX4-FULLREV(S4): plan_id 없는 HTML 요청의 되돌아갈 곳 — owner 를 확인한 뒤에만 정한다(항목의 계획 화면, 조회 실패면 /distribute)
  let backOfItem: (() => Promise<string>) | null = null;
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    if (html) backOfItem = () => itemPlanBack(() => planIdOfItem(owner.db, owner.ownerId, id.toLowerCase()));
    const body = await readRequestFields(request, MAX_DISTRIBUTION_REQUEST);
    if (body.kind === 'form' && body.data.plan_id) {
      back = `/distribute/${encodeURIComponent(body.data.plan_id)}`;
      backOfItem = null;
    }
    const parsed = cancelSchema.safeParse(body.kind === 'form' ? {} : body.data);
    if (!parsed.success) throw validationError(parsed.error);
    const r = await cancelItem(owner.db, owner.ownerId, id.toLowerCase());
    if (html) {
      const to = backOfItem ? await backOfItem() : back;
      return seeOther(`${to}${to.includes('?') ? '&' : '?'}${cancelRedirectQuery(r)}`);
    }
    return json(r);
  } catch (e) {
    if (html) return distributeFormFailure(e, request, backOfItem ? await backOfItem() : back);
    return errorResponse(e, request);
  }
}
