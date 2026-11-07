import { transcriptToCapture } from '@cs/db';
import { assertSameOrigin } from '@cs/domain';
import { apiHandler, json } from '../../../../../lib/api';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/transcripts/{id}/to-capture — 이 전사 버전을 소재(capture)로 저장한다. raw_text = 전사 본문(그대로), input_type text,
 * 메모 "음성 전사(모의)", capture_transcript_id = 이 버전. 같은 버전을 다시 보내면 기존 소재(200). 새로 만들면 201.
 */
export const POST = apiHandler<Ctx>(async (request, ctx) => {
  const config = getConfig();
  assertSameOrigin(request, config);
  const owner = await requireOwner(request);
  const { id } = await ctx.params;
  const r = await transcriptToCapture(owner.db, owner.ownerId, id.toLowerCase());
  const c = r.capture;
  return json(
    {
      created: r.created,
      capture: { id: c.id, raw_text: c.rawText, input_type: c.inputType, user_note: c.userNote, capture_transcript_id: c.captureTranscriptId },
    },
    { status: r.created ? 201 : 200 },
  );
});
