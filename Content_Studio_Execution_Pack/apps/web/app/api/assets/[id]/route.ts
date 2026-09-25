import { getAssetById, recordAudit } from '@cs/db';
import { contentTypeForMime, extensionForMime, GoneError, isMediaMime, NotFoundError } from '@cs/domain';
import { apiHandler } from '../../../../lib/api';
import { getStorage } from '../../../../lib/server';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NOT_FOUND = '파일을 찾을 수 없습니다';

/**
 * GET /api/assets/{id} — 로그인한 owner 의 파일만 내려준다.
 * 다른 owner 의 ID·존재하지 않는 ID·형식이 잘못된 ID 는 모두 같은 404(403 을 쓰지 않아 ID 존재 여부를 숨긴다).
 * 브라우저가 내용을 해석·실행하지 않도록 attachment + nosniff + sandbox CSP 로 보낸다.
 * T08: 원음 보존을 끈 전사 뒤 지운 파일은 410(메타데이터만 남음). 음성·영상은 스트림으로 보낸다(큰 파일을 메모리에 올리지 않음).
 */
export const GET = apiHandler<{ params: Promise<{ id: string }> }>(async (request, ctx) => {
  const owner = await requireOwner(request);
  const { id } = await ctx.params;
  const asset = await getAssetById(owner.db, owner.ownerId, id.toLowerCase());
  if (!asset) throw new NotFoundError(NOT_FOUND);
  if (asset.deletedAt !== null) throw new GoneError();

  const storage = getStorage(owner.config);
  const opened = isMediaMime(asset.mime) ? await storage.openStream(asset.key) : null;
  const bytes = opened ? null : await storage.get(asset.key);
  if (!opened && !bytes) {
    await recordAudit(owner.db, {
      ownerId: owner.ownerId,
      action: 'asset.missing',
      entity: 'asset',
      entityId: asset.id,
      versionOrHash: asset.checksum,
    });
    throw new NotFoundError(NOT_FOUND);
  }
  await recordAudit(owner.db, {
    ownerId: owner.ownerId,
    action: 'asset.download',
    entity: 'asset',
    entityId: asset.id,
    versionOrHash: asset.checksum,
  });

  return new Response(opened ? opened.stream : bytes, {
    status: 200,
    headers: {
      'content-type': contentTypeForMime(asset.mime),
      'content-length': String(opened ? opened.bytes : bytes!.byteLength),
      'content-disposition': `attachment; filename="${asset.id}.${extensionForMime(asset.mime)}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  });
});
