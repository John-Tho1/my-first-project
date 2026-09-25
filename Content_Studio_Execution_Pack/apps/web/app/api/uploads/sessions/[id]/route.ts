import { abortUploadSession, getUploadSessionView } from '@cs/db';
import { assertSameOrigin, NotFoundError } from '@cs/domain';
import { apiHandler, json } from '../../../../../lib/api';
import { getConfig, getUploadStore } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };
const NOT_FOUND = '업로드 세션을 찾을 수 없습니다';

/** GET /api/uploads/sessions/{id} — 진행 상태(받은 바이트·다음 조각 번호·빠진 조각). 끊긴 뒤 이어 올리기(A14)에 쓴다. */
export const GET = apiHandler<Ctx>(async (request, ctx) => {
  const owner = await requireOwner(request);
  const { id } = await ctx.params;
  const view = await getUploadSessionView(owner.db, owner.ownerId, id.toLowerCase());
  if (!view) throw new NotFoundError(NOT_FOUND);
  return json({ session: view });
});

/** DELETE /api/uploads/sessions/{id} — 업로드 중단(open 만). 받은 조각을 지운다. */
export const DELETE = apiHandler<Ctx>(async (request, ctx) => {
  const config = getConfig();
  assertSameOrigin(request, config);
  const owner = await requireOwner(request);
  const { id } = await ctx.params;
  const s = await abortUploadSession(owner.db, getUploadStore(config), owner.ownerId, id.toLowerCase());
  return json({ session: { id: s.id, state: s.state } });
});
