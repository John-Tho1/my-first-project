import { acceptCollectedItems } from '@cs/db';
import { assertSameOrigin } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../../lib/api';
import { collectFormFailure, itemView, parseItemIds, readFormOrJson, runnableCollector, runView } from '../../../../../../lib/collector';
import { getConfig } from '../../../../../../lib/server';
import { requireOwner } from '../../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/collector/runs/{id}/accept — 고른 새 항목만 소재로 저장. JSON { item_ids: uuid[] } 또는 폼(item 을 여러 번).
 * 수집기로 다시 읽어 내용이 같을 때만 저장(다르면 failed_changed), 그사이 중복이 되면 skipped_duplicate. 원문 보존(출처·출처 버전·원본 조각).
 * 빈 선택 400 collector_nothing_selected, 새 항목 아님 400 collector_invalid_selection, 이미 저장·버림 409, 다른 owner 404. 게시·배포 호출 없음(A04).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  const back = `/collect/runs/${encodeURIComponent(id)}`;
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const isJson = (request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json');
    const ids = parseItemIds(await readFormOrJson(request), isJson);
    const adapter = runnableCollector(config);
    const out = await acceptCollectedItems(owner.db, owner.ownerId, id, ids, adapter);
    if (html) return seeOther(back);
    return json({ run: runView(out.run), result: out.result, items: out.items.map(itemView) });
  } catch (e) {
    if (html) return collectFormFailure(e, request, back, '/collect');
    return errorResponse(e, request);
  }
}
