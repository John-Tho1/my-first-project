import { opsSummary } from '@cs/db';
import { apiHandler, json } from '../../../../lib/api';
import { getConfig } from '../../../../lib/server';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/ops/summary — 운영 숫자(D23(e): 공개 /api/health 에서 옮김). 로그인한 owner 범위만.
 * { ops: { backup_age_hours, attention_plans, repeated_failures, pending_deletes, disk{db,assets,uploads,exports}, disk_partial } }
 * 숫자만(경로·ID 없음), 기록이 없으면 null. 폴더 바이트는 이 PC 의 폴더 전체 측정이며 60초 동안 같은 측정값을 쓴다.
 */
export const GET = apiHandler(async (request) => {
  const owner = await requireOwner(request);
  const ops = await opsSummary(owner.db, owner.ownerId, getConfig(), new Date());
  return json({ ops });
});
