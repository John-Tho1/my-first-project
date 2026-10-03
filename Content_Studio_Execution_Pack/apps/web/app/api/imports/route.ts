import { listImportRuns } from '@cs/db';
import { apiHandler, json } from '../../../lib/api';
import { importRunView } from '../../../lib/imports';
import { requireOwner } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/imports — owner 자신의 가져오기 실행 기록(최근 50개). */
export const GET = apiHandler(async (request) => {
  const owner = await requireOwner(request);
  const runs = await listImportRuns(owner.db, owner.ownerId, 50);
  return json({ runs: runs.map(importRunView) });
});
