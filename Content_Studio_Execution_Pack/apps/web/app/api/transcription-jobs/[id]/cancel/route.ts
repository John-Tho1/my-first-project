import { cancelTranscriptionJob, transcriptionJobView } from '@cs/db';
import { assertSameOrigin } from '@cs/domain';
import { apiHandler, json } from '../../../../../lib/api';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/transcription-jobs/{id}/cancel — queued → canceled(예약 해제, 0), running → canceled(예약액 확정, failed=true).
 * 이미 끝난 작업 409 job_not_cancelable. 다른 owner 404.
 */
export const POST = apiHandler<Ctx>(async (request, ctx) => {
  const config = getConfig();
  assertSameOrigin(request, config);
  const owner = await requireOwner(request);
  const { id } = await ctx.params;
  const job = await cancelTranscriptionJob(owner.db, owner.ownerId, id.toLowerCase());
  return json({ job: await transcriptionJobView(owner.db, owner.ownerId, job) });
});
