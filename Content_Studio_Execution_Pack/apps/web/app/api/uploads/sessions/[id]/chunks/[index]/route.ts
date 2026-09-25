import { putUploadChunk, uploadSessionView, listChunkRows } from '@cs/db';
import { AppError, assertSameOrigin, BadRequestError, MAX_CHUNK_BYTES, PayloadTooLargeError } from '@cs/domain';
import { apiHandler, json, readBodyCapped } from '../../../../../../../lib/api';
import { getConfig, getUploadStore } from '../../../../../../../lib/server';
import { requireOwner } from '../../../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string; index: string }> };

/**
 * PUT /api/uploads/sessions/{id}/chunks/{index} — 조각 바이트(raw body, 최대 8MiB).
 * 새 조각 201, 같은 번호·같은 sha256 재전송 200(duplicate), 같은 번호·다른 sha256 409 chunk_mismatch.
 * 선택 헤더 x-chunk-sha256 이 있으면 서버가 계산한 값과 같아야 한다(다르면 400, 기록 없음).
 * 로그인 확인 전에는 본문을 읽지 않는다.
 */
export const PUT = apiHandler<Ctx>(async (request, ctx) => {
  const config = getConfig();
  assertSameOrigin(request, config);
  const owner = await requireOwner(request);
  const { id, index } = await ctx.params;
  if (!/^\d{1,6}$/.test(index)) throw new BadRequestError('조각 번호가 올바르지 않습니다');
  const bytes = await readBodyCapped(request, MAX_CHUNK_BYTES).catch((e: unknown) => {
    if (e instanceof PayloadTooLargeError) throw new PayloadTooLargeError('조각은 최대 8MiB 입니다');
    throw e;
  });
  if (bytes.byteLength === 0) throw new BadRequestError('빈 조각은 받을 수 없습니다');
  const r = await putUploadChunk(owner.db, getUploadStore(config), owner.ownerId, id.toLowerCase(), Number(index), bytes, new Date(), (sha) => {
    const claimed = request.headers.get('x-chunk-sha256');
    if (claimed !== null && claimed.toLowerCase() !== sha) {
      throw new AppError('bad_request', 'chunk_checksum_mismatch', '조각 sha256 이 보낸 값(x-chunk-sha256)과 다릅니다. 다시 보내세요.');
    }
  });
  const chunks = await listChunkRows(owner.db, owner.ownerId, r.session.id);
  return json(
    { index: r.index, sha256: r.sha256, duplicate: r.duplicate, session: uploadSessionView(r.session, chunks.map((c) => c.index)) },
    { status: r.duplicate ? 200 : 201 },
  );
});
