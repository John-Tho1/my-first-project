import { listArchiveRecommendations } from '@cs/db';
import { apiHandler, json } from '../../../lib/api';
import { requireOwner } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/recommendations — "다시 볼 만한 소재"(결정적 규칙, AI 호출 없음). owner 범위. */
export const GET = apiHandler(async (request) => {
  const owner = await requireOwner(request);
  const recs = await listArchiveRecommendations(owner.db, owner.ownerId);
  return json({
    recommendations: recs.map((r) => ({
      capture_id: r.captureId,
      title: r.title,
      received_at: r.receivedAt.toISOString(),
      shared: r.shared,
      signal: r.signal,
      reason: r.reason,
    })),
  });
});
