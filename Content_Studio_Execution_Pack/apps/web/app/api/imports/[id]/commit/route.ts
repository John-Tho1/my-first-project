import { commitImportRun } from '@cs/db';
import { assertSameOrigin } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { importFormFailure, importItemView, importLoader, importRunView, readImportSelection, removeImportZip } from '../../../../../lib/imports';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/imports/{id}/commit — 선택 확정(T18, D32 제안).
 * JSON { item_ids?: uuid[], folders?: string[], version_ids?: uuid[] } 또는 폼(item·folder·version 을 여러 번).
 * - item_ids ∪ folders 안의 새 항목 → 새 소재(원문 보존) + 출처(외부 ID) + 출처 버전(원본 checksum).
 * - 동일(같은 외부 ID·checksum) → 건너뜀(멱등). 충돌 → version_ids 에 있을 때만 기존 출처에 새 버전 + 새 소재. 기존 소재는 바꾸지 않는다.
 * 원본을 다시 읽어 미리보기와 checksum 이 다르면 그 항목은 failed_changed(ZIP 자체가 바뀌면 409 import_file_changed).
 * 아무것도 고르지 않음 → 400 import_nothing_selected. 이미 확정 → 409. 다른 owner·없는 ID → 404.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  const back = `/imports/${encodeURIComponent(id)}`;
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const selection = await readImportSelection(request);
    const out = await commitImportRun(owner.db, owner.ownerId, id, selection, importLoader(config));
    await removeImportZip(config, out.run.id);
    if (html) return seeOther(back);
    return json({ run: importRunView(out.run), result: out.result, items: out.items.map(importItemView) });
  } catch (e) {
    if (html) return importFormFailure(e, request, back, '/imports?error=invalid');
    return errorResponse(e, request);
  }
}
