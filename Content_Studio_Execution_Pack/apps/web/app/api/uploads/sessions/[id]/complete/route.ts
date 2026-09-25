import { completeUploadSession, uploadSessionView } from '@cs/db';
import { assertSameOrigin } from '@cs/domain';
import { apiHandler, json } from '../../../../../../lib/api';
import { getConfig, getStorage, getUploadStore } from '../../../../../../lib/server';
import { requireOwner } from '../../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/uploads/sessions/{id}/complete — 조각을 이어 붙여 크기·형식 서명·sha256 을 확인한다(디코딩 없음, D15).
 * 통과 200 { session(verified), asset(VERIFIED), duplicate }. 조각이 빠짐 409 upload_incomplete(세션 그대로).
 * 검사 실패 → 세션 rejected·조각 삭제 후 415(형식) 또는 400(크기·checksum) upload_rejected { reason }.
 */
export const POST = apiHandler<Ctx>(async (request, ctx) => {
  const config = getConfig();
  assertSameOrigin(request, config);
  const owner = await requireOwner(request);
  const { id } = await ctx.params;
  const r = await completeUploadSession(owner.db, getUploadStore(config), getStorage(config), owner.ownerId, id.toLowerCase());
  const a = r.asset;
  return json({
    session: uploadSessionView(r.session, []),
    duplicate: r.duplicate,
    asset: {
      id: a.id,
      mime: a.mime,
      bytes: a.bytes,
      checksum: a.checksum,
      verification_state: a.verificationState,
      verification_scope: a.verificationScope,
      deleted_at: a.deletedAt?.toISOString() ?? null,
    },
  });
});
