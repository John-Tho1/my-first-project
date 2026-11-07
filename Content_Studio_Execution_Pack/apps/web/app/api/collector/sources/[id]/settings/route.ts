import { updateCollectorSourceSettings } from '@cs/db';
import { assertSameOrigin } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../../lib/api';
import { collectFormFailure, parseSettingsInput, readFormOrJson, sourceView } from '../../../../../../lib/collector';
import { getConfig } from '../../../../../../lib/server';
import { requireOwner } from '../../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/collector/sources/{id}/settings — 켜기/끄기·주기(off|daily|weekly). JSON { enabled?, schedule? } 또는 폼.
 * 주기를 켜도 COLLECTOR_SCHEDULER=on(+ COLLECTOR_MODE=mock)이 아니면 저장만 하고 실행하지 않는다. 다른 owner → 404.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const patch = parseSettingsInput(await readFormOrJson(request));
    const row = await updateCollectorSourceSettings(owner.db, owner.ownerId, id, patch);
    if (html) return seeOther('/collect');
    return json({ source: sourceView(row) });
  } catch (e) {
    if (html) return collectFormFailure(e, request, '/collect', '/collect');
    return errorResponse(e, request);
  }
}
