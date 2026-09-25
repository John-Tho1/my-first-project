import { getTranscriptionJob, transcriptionJobView } from '@cs/db';
import { NotFoundError } from '@cs/domain';
import { apiHandler, json } from '../../../../lib/api';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/transcription-jobs/{id} — 한 작업(전사 버전 목록·최신 본문 포함). 다른 owner 404. */
export const GET = apiHandler<Ctx>(async (request, ctx) => {
  const owner = await requireOwner(request);
  const { id } = await ctx.params;
  const job = await getTranscriptionJob(owner.db, owner.ownerId, id.toLowerCase());
  if (!job) throw new NotFoundError('전사 작업을 찾을 수 없습니다');
  return json({ job: await transcriptionJobView(owner.db, owner.ownerId, job) });
});
