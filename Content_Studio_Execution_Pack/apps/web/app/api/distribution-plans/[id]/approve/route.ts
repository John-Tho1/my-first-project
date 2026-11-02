import { approvalView, approveItems, duplicateWarningView, planView } from '@cs/db';
import { AppError, approveSchema, assertSameOrigin } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { readRequestFields, validationError } from '../../../../../lib/body';
import { distributeFormFailure, formToApprove, MAX_DISTRIBUTION_REQUEST } from '../../../../../lib/distribution';
import { getConfig, getStorage } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/distribution-plans/{id}/approve — { item_ids, expected_hashes: { [item_id]: sha256 }, confirm: true, purpose } → 200 { plan, approvals }.
 * confirm 없음 400 confirm_required, hash 불일치 409 hash_mismatch, 스냅샷이 지금과 다름 409 snapshot_stale, 다른 owner 404.
 * FIX1-FULLREV2(G2, D40-1): 다른 계획의 같은 글이 이미 게시됨·결과 불명·진행 중인 **실제 계정** 항목은 acknowledge_duplicate: true(JSON boolean, 폼은 체크박스
 * acknowledge_duplicate=yes)가 있어야 승인된다 — 없으면 409 duplicate_publish_unacknowledged(아무것도 바꾸지 않음). 모의 계정 항목은 경고만(200 duplicate_warnings).
 * 승인은 이 경로로만 생긴다(모르는 키는 버림 — approved_by_ai 같은 값은 무시).
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  const back = `/distribute/${encodeURIComponent(id)}`;
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    const body = await readRequestFields(request, MAX_DISTRIBUTION_REQUEST);
    const raw = (body.kind === 'form' ? formToApprove(body.data) : body.data) as Record<string, unknown> | null;
    if (!raw || typeof raw !== 'object' || raw.confirm !== true) {
      throw new AppError('bad_request', 'confirm_required', '내용을 확인했다는 표시(confirm: true)가 필요합니다');
    }
    if (!Array.isArray(raw.item_ids) || raw.item_ids.length === 0) throw new AppError('bad_request', 'no_items', '승인할 항목을 하나 이상 고르세요');
    const parsed = approveSchema.safeParse(raw);
    if (!parsed.success) throw validationError(parsed.error);
    // T16(D29 제안): Instagram 모의 연결 항목은 승인 전에 잠정 규격을 파일 앞부분으로 검사한다(저장소 범위 읽기 창구).
    const r = await approveItems(owner.db, owner.ownerId, id.toLowerCase(), parsed.data, undefined, { media: getStorage() });
    if (html) return seeOther(`/distribute/${r.plan.id}?approved=${r.approvals.length}`);
    return json({ plan: planView(r.plan), approvals: r.approvals.map(approvalView), mode: 'MOCK', duplicate_warnings: r.duplicateWarnings.map(duplicateWarningView) });
  } catch (e) {
    if (html) return distributeFormFailure(e, request, back);
    return errorResponse(e, request);
  }
}
