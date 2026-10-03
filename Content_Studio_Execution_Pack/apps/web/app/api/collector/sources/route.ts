import { createCollectorSource, listCollectorSources } from '@cs/db';
import { assertSameOrigin, collectorReadiness } from '@cs/domain';
import { apiHandler, errorResponse, json, seeOther, wantsHtml } from '../../../../lib/api';
import { collectFormFailure, parseSourceInput, readFormOrJson, sourceView } from '../../../../lib/collector';
import { getConfig } from '../../../../lib/server';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/collector/sources — owner 의 수집 소스(허용 목록)와 수집 모드 준비 상태. */
export const GET = apiHandler(async (request) => {
  const owner = await requireOwner(request);
  const rows = await listCollectorSources(owner.db, owner.ownerId);
  const r = collectorReadiness(owner.config);
  return json({ readiness: { mode: r.mode, can_run: r.canRun, missing: r.missing, scheduler: owner.config.COLLECTOR_SCHEDULER }, sources: rows.map(sourceView) });
});

/**
 * POST /api/collector/sources — 소스 등록(T19, D33 제안). JSON { kind: rss|atom|url, url, label? } 또는 폼.
 * 주소 정책(https 만·IP 리터럴·내부 호스트·기본 아닌 포트 거부)을 통과해야 저장. 기본 꺼짐·주기 off. 외부 요청 0(어떤 모드에서도).
 */
export async function POST(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const input = parseSourceInput(await readFormOrJson(request));
    const row = await createCollectorSource(owner.db, owner.ownerId, input);
    if (html) return seeOther('/collect');
    return json({ source: sourceView(row) }, { status: 201 });
  } catch (e) {
    if (html) return collectFormFailure(e, request, '/collect', '/collect');
    return errorResponse(e, request);
  }
}
