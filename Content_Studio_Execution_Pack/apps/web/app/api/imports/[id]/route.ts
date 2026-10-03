import { getImportRun, listBackfillableImportItemIds, listImportItems } from '@cs/db';
import { NotFoundError } from '@cs/domain';
import { apiHandler, json } from '../../../../lib/api';
import { importItemView, importRunView } from '../../../../lib/imports';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/imports/{id} — owner 자신의 가져오기 미리보기·결과(항목 포함). 다른 owner·없는 ID → 404.
 * FIX-T18 round 2: 미리보기 중이면 backfillable_item_ids(원본 파일이 빠진 동일 항목 — 확정 때 backfill_ids 로 고를 수 있음).
 */
export const GET = apiHandler<{ params: Promise<{ id: string }> }>(async (request, ctx) => {
  const owner = await requireOwner(request);
  const { id } = await ctx.params;
  const run = await getImportRun(owner.db, owner.ownerId, id.toLowerCase());
  if (!run) throw new NotFoundError('가져오기를 찾을 수 없습니다');
  const items = await listImportItems(owner.db, owner.ownerId, run.id);
  const backfillable = run.status === 'preview' ? [...(await listBackfillableImportItemIds(owner.db, owner.ownerId, items))] : [];
  return json({ run: importRunView(run), items: items.map(importItemView), backfillable_item_ids: backfillable });
});
