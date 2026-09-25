import { requestTranscription, transcriptionJobView } from '@cs/db';
import { assertSameOrigin, sttBudgetPolicy, transcribeRequestSchema } from '@cs/domain';
import { MOCK_STT_MODEL } from '@cs/providers';
import { apiHandler, json } from '../../../../../lib/api';
import { readRequestFields, validationError } from '../../../../../lib/body';
import { assertTranscriptionAllowed, getConfig } from '../../../../../lib/server';
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
 * 202 { job } — inline worker 가 tick 마다 진행률을 25씩 올린다(GET /api/transcription-jobs 로 확인).
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
  });
  return json({ job: await transcriptionJobView(owner.db, owner.ownerId, job) }, { status: 202 });
});
