import { getSourceVersionOriginal } from '@cs/db';
import { NotFoundError } from '@cs/domain';
import { apiHandler } from '../../../../../lib/api';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/imports/originals/{sourceVersionId} — FIX-T18 round 1(Codex review-T18 P0): 가져온 원본 파일 그대로(바이트 단위로 같음).
 * 소재 원문은 파생 값(.html 은 추출 텍스트)이고 원본은 이 경로로 받는다. 다른 owner·없는 ID → 404.
 * HTML 원본도 브라우저가 해석·실행하지 않도록 text/plain + attachment + nosniff + sandbox CSP 로 보낸다. x-content-sha256 = 출처 버전 raw_hash.
 */
export const GET = apiHandler<{ params: Promise<{ versionId: string }> }>(async (request, ctx) => {
  const owner = await requireOwner(request);
  const { versionId } = await ctx.params;
  const row = await getSourceVersionOriginal(owner.db, owner.ownerId, versionId.toLowerCase());
  if (!row) throw new NotFoundError('원본을 찾을 수 없습니다');
  const bytes = new Uint8Array(Buffer.from(row.contentBase64, 'base64'));
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': String(bytes.byteLength),
      'content-disposition': `attachment; filename="original-${row.sourceVersionId}.${row.format}"`,
      'x-content-type-options': 'nosniff',
      'x-content-sha256': row.sha256,
      'cache-control': 'private, no-store',
      'content-security-policy': "default-src 'none'; sandbox",
    },
  });
});
