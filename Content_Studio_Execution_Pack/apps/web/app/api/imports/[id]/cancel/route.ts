import { cancelImportRun } from '@cs/db';
import { assertSameOrigin } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { importFormFailure, importRunView, removeImportZip } from '../../../../../lib/imports';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** POST /api/imports/{id}/cancel — 미리보기 취소(원장에 canceled, 올린 ZIP 삭제). 소재·출처는 바뀌지 않는다. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  const back = `/imports/${encodeURIComponent(id)}`;
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const run = await cancelImportRun(owner.db, owner.ownerId, id);
    await removeImportZip(config, run.id);
    if (html) return seeOther(back);
    return json({ run: importRunView(run) });
  } catch (e) {
    if (html) return importFormFailure(e, request, back, '/imports?error=invalid');
    return errorResponse(e, request);
  }
}
