import { getContentVersion } from '@cs/db';
import { BadRequestError, diffLines, diffStats, NotFoundError } from '@cs/domain';
import { apiHandler, json } from '../../../../../lib/api';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

const VERSION_RE = /^[1-9][0-9]{0,8}$/;

/** GET /api/contents/{id}/diff?from=1&to=2 — 두 버전 본문의 줄 단위 diff { from, to, stats, lines:[{type,text}] }. */
export const GET = apiHandler<Ctx>(async (request, ctx) => {
  const owner = await requireOwner(request);
  const { id } = await ctx.params;
  const p = new URL(request.url).searchParams;
  const from = p.get('from') ?? '';
  const to = p.get('to') ?? '';
  if (!VERSION_RE.test(from) || !VERSION_RE.test(to)) throw new BadRequestError('from·to 는 1 이상의 버전 번호입니다');
  const a = await getContentVersion(owner.db, owner.ownerId, id.toLowerCase(), Number(from));
  const b = a ? await getContentVersion(owner.db, owner.ownerId, id.toLowerCase(), Number(to)) : null;
  if (!a || !b) throw new NotFoundError('버전을 찾을 수 없습니다');
  const lines = diffLines(a.version.body, b.version.body);
  return json({ from: a.version.version, to: b.version.version, stats: diffStats(lines), lines });
});
