import { listTranscriptionJobs, transcriptionJobView } from '@cs/db';
import { BadRequestError, isUuid } from '@cs/domain';
import { apiHandler, json } from '../../../lib/api';
import { requireOwner } from '../../../lib/session';
import { runInlineWorker } from '../../../lib/stt';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/transcription-jobs?asset_id= — 이 owner 의 전사 작업 목록(최근 50). WORKER_MODE=inline 이면 먼저 worker tick 1회
 * (업로드 만료 정리 + 모의 전사 한 단계)를 실행한다 — 화면의 진행률 폴링이 곧 처리 주기다.
 */
export const GET = apiHandler(async (request) => {
  const owner = await requireOwner(request);
  const raw = new URL(request.url).searchParams.get('asset_id');
  const assetId = raw === null ? undefined : raw.toLowerCase();
  if (assetId !== undefined && !isUuid(assetId)) throw new BadRequestError('asset_id 형식이 올바르지 않습니다');
  await runInlineWorker(owner.config, owner.db);
  const jobs = await listTranscriptionJobs(owner.db, owner.ownerId, { assetId });
  const views = [];
  for (const j of jobs) views.push(await transcriptionJobView(owner.db, owner.ownerId, j));
  return json({ jobs: views });
});
