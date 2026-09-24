import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { exportZipPath, getExportRun, recordAudit } from '@cs/db';
import { NotFoundError } from '@cs/domain';
import { apiHandler } from '../../../../lib/api';
import { exportFilename, exportsDir } from '../../../../lib/backup';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NOT_FOUND = '내보내기를 찾을 수 없습니다';

/**
 * GET /api/exports/{id} — owner 자신의 내보내기 ZIP 을 스트림으로 내려준다.
 * 다른 owner·없는 ID·형식이 틀린 ID·파일 없음은 모두 404(존재 여부를 드러내지 않음).
 */
export const GET = apiHandler<{ params: Promise<{ id: string }> }>(async (request, ctx) => {
  const owner = await requireOwner(request);
  const { id } = await ctx.params;
  const run = await getExportRun(owner.db, owner.ownerId, id.toLowerCase());
  if (!run || run.status !== 'completed') throw new NotFoundError(NOT_FOUND);
  const file = exportZipPath(exportsDir(owner.config), run.id);
  let size: number;
  try {
    const s = await stat(/*turbopackIgnore: true*/ file);
    if (!s.isFile()) throw new Error('not a file');
    size = s.size;
  } catch {
    throw new NotFoundError(NOT_FOUND);
  }
  await recordAudit(owner.db, {
    ownerId: owner.ownerId,
    action: 'export.download',
    entity: 'export',
    entityId: run.id,
    versionOrHash: run.manifestSha256,
    details: { zip_bytes: size },
  });
  const body = Readable.toWeb(createReadStream(/*turbopackIgnore: true*/ file)) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-length': String(size),
      'content-disposition': `attachment; filename="${exportFilename(run.createdAt)}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  });
});
