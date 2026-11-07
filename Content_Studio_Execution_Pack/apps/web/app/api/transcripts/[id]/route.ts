import { getTranscript, transcriptView } from '@cs/db';
import { NotFoundError } from '@cs/domain';
import { apiHandler, json } from '../../../../lib/api';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/transcripts/{id} — 전사 버전 한 개. 다른 owner 404. */
export const GET = apiHandler<Ctx>(async (request, ctx) => {
  const owner = await requireOwner(request);
  const { id } = await ctx.params;
  const t = await getTranscript(owner.db, owner.ownerId, id.toLowerCase());
  if (!t) throw new NotFoundError('전사 본문을 찾을 수 없습니다');
  return json({ transcript: transcriptView(t) });
});
