import { planIdOfItem, retryItem } from '@cs/db';
import { assertSameOrigin, retrySchema } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { readRequestFields, validationError } from '../../../../../lib/body';
import { distributeFormFailure, itemFormBack, MAX_DISTRIBUTION_REQUEST } from '../../../../../lib/distribution';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/distribution-items/{id}/retry — {} → 200 { item_id, job_id, state: 'QUEUED', attempt_next, message } (T12, D19).
 * 보류(BLOCKED)된 항목을 사용자가 명시적으로 다시 대기열에 넣는다(같은 작업, 다음 lease = 새 시도·새 전송 의도, 감사 기록).
 * 활성 승인 hash = 항목 hash · 스냅샷 그대로 · 마지막 결과가 불명이 아님 · 시도 한도 안일 때만. 승인 없음 보류(항목 PLANNED)는
 * 409 approval_required(다시 승인 후 실행). 작업 없는 보류(복원)는 409 not_retryable. 다른 owner 404. 실행 자체는 worker 가 한다(MOCK).
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
    const parsed = retrySchema.safeParse(body.kind === 'form' ? {} : body.data);
    if (!parsed.success) throw validationError(parsed.error);
    const r = await retryItem(owner.db, owner.ownerId, id.toLowerCase());
    if (html) {
      const to = await back.target();
      return seeOther(`${to}${to.includes('?') ? '&' : '?'}retried=1`);
    }
    return json({ ...r, mode: 'MOCK' });
  } catch (e) {
    if (html) return distributeFormFailure(e, request, await back.target());
    return errorResponse(e, request);
  }
}
