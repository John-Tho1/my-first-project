import { mockScenarioView, planIdOfItem, setMockScenario } from '@cs/db';
import { assertSameOrigin, mockScenarioSchema } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { readRequestFields, validationError } from '../../../../../lib/body';
import { distributeFormFailure, itemFormBack, MAX_DISTRIBUTION_REQUEST } from '../../../../../lib/distribution';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * PUT /api/distribution-items/{id}/mock-scenario — { scenario, delay_ms?(0~5000) } → 200 { item_id, scenario, delay_ms, updated_at, notice }.
 * 개발용 · 모의 결과 선택(실제 채널 없음, T12 D19). 모의(MOCK) 계정 항목만(아니면 400 not_mock_account), 끝난 항목 409 item_finished,
 * 다른 owner 404, CSRF(같은 출처). 승인 스냅샷 밖 표에 저장하므로 payload hash·승인 상태는 바뀌지 않는다.
 * POST 는 HTML 폼용(같은 동작, 303 으로 계획 화면).
 * FIX5-FULLREV(T4, 사용자 결정 2026-10-23): HTML 폼이 plan_id 없이 오면 /distribute 대신 항목이 속한 계획 화면(취소 경로와 같은 lib itemFormBack —
 * owner 확인 뒤에만 owner 범위 조회 planIdOfItem, 실패하면 /distribute). 오류 리다이렉트도 같다. CSRF·로그인 실패는 조회 없이 그대로, 404 는 /distribute?missing=1.
 */
async function handle(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  const back = itemFormBack(html);
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    back.ownerChecked(() => planIdOfItem(owner.db, owner.ownerId, id.toLowerCase()));
    const body = await readRequestFields(request, MAX_DISTRIBUTION_REQUEST);
    let input: unknown = body.data;
    if (body.kind === 'form') {
      back.formPlanId(body.data.plan_id);
      input = { scenario: body.data.scenario ?? '', delay_ms: body.data.delay_ms || undefined };
    }
    const parsed = mockScenarioSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    const row = await setMockScenario(owner.db, owner.ownerId, id.toLowerCase(), parsed.data);
    if (html) {
      const to = await back.target();
      return seeOther(`${to}${to.includes('?') ? '&' : '?'}scenario_saved=1`);
    }
    return json({ ...mockScenarioView(row), mode: 'MOCK' });
  } catch (e) {
    if (html) return distributeFormFailure(e, request, await back.target());
    return errorResponse(e, request);
  }
}

export async function PUT(request: Request, ctx: Ctx): Promise<Response> {
  return handle(request, ctx);
}

export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  return handle(request, ctx);
}
