import { runCollectorSource } from '@cs/db';
import { assertSameOrigin } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../../lib/api';
import { collectFormFailure, itemView, runnableCollector, runView } from '../../../../../../lib/collector';
import { getConfig } from '../../../../../../lib/server';
import { requireOwner } from '../../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/collector/sources/{id}/run — "지금 수집(모의)". 미리보기 실행만 만든다(소재 0 — 고른 항목만 /accept 로 저장).
 * COLLECTOR_MODE=disabled → 503 collector_disabled, enabled(실제) → 503 collector_live_not_ready(요청 0). 꺼진 소스 → 409.
 * 주소 정책 차단·형식 오류도 200 + 실행(status blocked|failed, error_code)으로 돌려준다(소스는 그대로).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const adapter = runnableCollector(config);
    const out = await runCollectorSource(owner.db, owner.ownerId, id, adapter, { trigger: 'manual' });
    if (html) return seeOther(`/collect/runs/${out.run.id}`);
    return json({ run: runView(out.run), items: out.items.map(itemView) });
  } catch (e) {
    if (html) return collectFormFailure(e, request, '/collect', '/collect');
    return errorResponse(e, request);
  }
}
