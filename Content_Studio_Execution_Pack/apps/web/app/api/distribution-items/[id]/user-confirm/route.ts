import { planIdOfItem, userConfirmItem } from '@cs/db';
import { assertSameOrigin, userConfirmSchema } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { readRequestFields, validationError } from '../../../../../lib/body';
import { distributeFormFailure, itemFormBack, MAX_DISTRIBUTION_REQUEST } from '../../../../../lib/distribution';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/distribution-items/{id}/user-confirm — { candidate_external_id } → 200 { item_id, job_id, state_before, state: 'CONFIRMED',
 * publication_id, external_id, permalink, verification: 'USER_CONFIRMED', confirmed_by: 'owner', confirmed_at, mode: 'LIVE', message } (LIVEP1-USERCONFIRM).
 * 결과 불명 실제 Threads 게시의 "Threads에서 확인함": 사용자가 확인 후보 링크를 직접 열어 자기 글임을 확인했다는 기록이다(앱 검증 VERIFIED 아님).
 * **외부 호출·재게시 없음**(어댑터·fetch 를 쓰지 않음). 실제 게시 조건(PUBLISH_MODE 등)과 무관 — 이미 일어난 게시의 기록만 남긴다.
 * 허용(모두): 실제 Threads 계정 항목 · 결과 없음 · 가장 최근 작업 UNKNOWN/RECONCILING(복원 이력 아님) · 게시 시도 표식 있음·게시 기록 없음 ·
 * 가장 최근 재확인 이력의 후보(threads:<숫자> + 공식 링크) = 요청한 candidate_external_id. 아니면 409(user_confirm_* 코드), 형식 오류 400,
 * 다른 owner 404. 화면 폼: plan_id(되돌아갈 계획) + candidate_external_id → 303 /distribute/{plan}?user_confirmed=1.
 * FIX5-FULLREV(T4, 사용자 결정 2026-10-23): HTML 폼이 plan_id 없이 오면 /distribute 대신 항목이 속한 계획 화면(취소 경로와 같은 lib itemFormBack —
 * owner 확인 뒤에만 owner 범위 조회 planIdOfItem, 실패하면 /distribute). 오류 리다이렉트도 같다. CSRF·로그인 실패는 조회 없이 그대로, 404 는 /distribute?missing=1.
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  const back = itemFormBack(html);
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    back.ownerChecked(() => planIdOfItem(owner.db, owner.ownerId, id.toLowerCase()));
    const body = await readRequestFields(request, MAX_DISTRIBUTION_REQUEST);
    if (body.kind === 'form') back.formPlanId(body.data.plan_id);
    const parsed = userConfirmSchema.safeParse(body.kind === 'form' ? { candidate_external_id: body.data.candidate_external_id } : body.data);
    if (!parsed.success) throw validationError(parsed.error);
    const r = await userConfirmItem(owner.db, owner.ownerId, id.toLowerCase(), parsed.data);
    if (html) {
      const to = await back.target();
      return seeOther(`${to}${to.includes('?') ? '&' : '?'}user_confirmed=1`);
    }
    return json(r);
  } catch (e) {
    if (html) return distributeFormFailure(e, request, await back.target());
    return errorResponse(e, request);
  }
}
