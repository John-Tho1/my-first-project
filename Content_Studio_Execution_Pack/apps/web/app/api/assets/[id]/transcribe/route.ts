import { requestTranscription, transcriptionJobView } from '@cs/db';
import { assertSameOrigin, sttBudgetPolicy, transcribeRequestSchema } from '@cs/domain';
import { MOCK_STT_MODEL } from '@cs/providers';
import { apiHandler, json } from '../../../../../lib/api';
import { readRequestFields, validationError } from '../../../../../lib/body';
import { assertTranscriptionAllowed, getConfig, getStorage } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';
import { MAX_SMALL_JSON } from '../../../../../lib/stt';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/assets/{id}/transcribe — 음성·영상 파일 전사 요청(T08, 모의만 — 결정 D9). body { duration_seconds?, keep_original? (기본 true) }.
 * - STT_MODE=live 는 먼저 거부(503 live_stt_not_configured) — job·원장을 남기지 않는다(어댑터 없음).
 * - 다른 owner·없는 파일 404, 원본 삭제됨 410, 음성·영상이 아님 415, VERIFIED 아님·진행 중 job·첨부된 파일 원본 삭제 409.
 * - 비용 예약(T07 원장·통화·상한) 거부 409·429 → 아무것도 남지 않는다.
 * 202 { job, existing: false } — inline worker 가 tick 마다 진행률을 25씩 올린다(GET /api/transcription-jobs 로 확인).
 * FIX1-FULLREV3(H6): 이 asset 에 이미 성공한 전사가 있고 force 가 아니면 새 작업·비용 예약 없이 200 { job(기존 성공 작업), existing: true }
 * (응답을 잃은 화면의 재시도가 같은 asset 에 작업을 하나 더 만들지 않게 — 원본이 지워진 asset 도 마찬가지). body.force=true 면 새 작업(일부러 다시 전사).
 * FIX1-FULLREV3(H6 후속): 그 요청이 keep_original=false 이고 원본이 아직 있으면 성공 뒤 삭제와 같은 경로로 원본을 지우고
 * original_deleted: true 를 함께 돌려준다. 채널 초안에 첨부된 파일·앞선 정리 대기면 지우지 않고 original_deleted: false + original_kept_reason
 * ('asset_in_use'·'cleanup_pending'). 어느 쪽이든 새 작업·예약은 없다. 해당 없으면 두 칸은 없다.
 */
export const POST = apiHandler<Ctx>(async (request, ctx) => {
  const config = getConfig();
  assertSameOrigin(request, config);
  const owner = await requireOwner(request);
  assertTranscriptionAllowed(config);
  const { id } = await ctx.params;
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  const raw = type === '' ? {} : (await readRequestFields(request, MAX_SMALL_JSON)).data;
  const parsed = transcribeRequestSchema.safeParse(raw ?? {});
  if (!parsed.success) throw validationError(parsed.error);
  const job = await requestTranscription(owner.db, owner.ownerId, id.toLowerCase(), {
    durationSeconds: parsed.data.duration_seconds,
    keepOriginal: parsed.data.keep_original ?? true,
    policy: sttBudgetPolicy(config),
    model: MOCK_STT_MODEL,
    force: parsed.data.force === true,
    files: getStorage(config),
  });
  const original = job.originalDeleted === undefined ? {} : { original_deleted: job.originalDeleted, ...(job.originalKeptReason ? { original_kept_reason: job.originalKeptReason } : {}) };
  return json({ job: await transcriptionJobView(owner.db, owner.ownerId, job), existing: job.existing, ...original }, { status: job.existing ? 200 : 202 });
});
