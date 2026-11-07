import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { findPackageZip, recordAudit } from '@cs/db';
import { NotFoundError } from '@cs/domain';
import { apiHandler } from '../../../../lib/api';
import { exportsDir } from '../../../../lib/backup';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NOT_FOUND = '배포 파일을 찾을 수 없습니다';

/**
 * GET /api/packages/{id} — owner 자신의 배포 파일 ZIP(수동 게시용, 승인·게시 아님). 파일은 owner 폴더에서만 찾으므로
 * 다른 owner·없는 ID·형식이 틀린 ID 는 모두 404.
 */
export const GET = apiHandler<{ params: Promise<{ id: string }> }>(async (request, ctx) => {
  const owner = await requireOwner(request);
  const { id } = await ctx.params;
  const file = await findPackageZip(exportsDir(owner.config), owner.ownerId, id.toLowerCase());
  let size: number;
  try {
    if (!file) throw new Error('not found');
    const s = await stat(/*turbopackIgnore: true*/ file);
    if (!s.isFile()) throw new Error('not a file');
    size = s.size;
  } catch {
    throw new NotFoundError(NOT_FOUND);
  }
  await recordAudit(owner.db, {
    ownerId: owner.ownerId,
    action: 'package.download',
    entity: 'package',
    entityId: id.toLowerCase(),
    details: { zip_bytes: size },
  });
  const body = Readable.toWeb(createReadStream(/*turbopackIgnore: true*/ file)) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-length': String(size),
      'content-disposition': `attachment; filename="content-studio-package-${id.toLowerCase().slice(0, 8)}.zip"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  });
});
