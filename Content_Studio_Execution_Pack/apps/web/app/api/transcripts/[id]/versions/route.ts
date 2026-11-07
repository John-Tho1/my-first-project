import { createTranscriptVersion, transcriptView } from '@cs/db';
import { assertSameOrigin, transcriptEditSchema } from '@cs/domain';
import { apiHandler, json } from '../../../../../lib/api';
import { readRequestFields, validationError } from '../../../../../lib/body';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';
import { MAX_TRANSCRIPT_REQUEST } from '../../../../../lib/stt';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/transcripts/{id}/versions — 사용자 수정. body { base_version, text }. 기존 버전은 바뀌지 않고 새 버전(created_by owner)을 더한다.
 * base_version 이 최신이 아니면 409 stale_transcript { current_version }. 다른 owner 404.
 */
export const POST = apiHandler<Ctx>(async (request, ctx) => {
  const config = getConfig();
  assertSameOrigin(request, config);
  const owner = await requireOwner(request);
  const { id } = await ctx.params;
  const body = await readRequestFields(request, MAX_TRANSCRIPT_REQUEST);
  const raw = body.kind === 'form' ? { base_version: Number(body.data.base_version), text: body.data.text } : body.data;
  const parsed = transcriptEditSchema.safeParse(raw);
  if (!parsed.success) throw validationError(parsed.error);
  const t = await createTranscriptVersion(owner.db, owner.ownerId, id.toLowerCase(), { baseVersion: parsed.data.base_version, text: parsed.data.text });
  return json({ transcript: transcriptView(t) }, { status: 201 });
});
