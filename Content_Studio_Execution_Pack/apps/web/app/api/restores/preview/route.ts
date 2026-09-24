import { readFile, rm } from 'node:fs/promises';
import { createRestorePreview, createRestorePreviewFromExport } from '@cs/db';
import { assertSameOrigin, BadRequestError, isUuid } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../lib/api';
import {
  backupFormFailure,
  exportsDir,
  MAX_RESTORE_UPLOAD,
  RESTORE_MULTIPART_OVERHEAD,
  restoresDir,
  streamBodyToTempFile,
} from '../../../../lib/backup';
import { readRequestFields } from '../../../../lib/body';
import { getConfig } from '../../../../lib/server';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/restores/preview — 복원 미리보기(DB 는 바뀌지 않는다).
 * - multipart/form-data `file`(ZIP ≤ 256MB) 또는 application/zip 본문: 본문을 먼저 data/restores/ 임시 파일로 흘려 쓴 뒤 검사한다.
 * - application/json 또는 폼 `{ export_id }`: owner 자신의 내보내기로 미리보기(다른 owner 의 ID → 404).
 * 200 { restore_id, preview }. 검증 실패(manifest_mismatch 등) → 400 + 문제 경로, restore_runs 행 없음.
 * 브라우저 폼: 303 → /settings/restores/<id> (실패는 /settings?error=<code>).
 */
export async function POST(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  let tmp: string | null = null;
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request); // 로그인 확인 전에는 본문을 읽지 않는다
    const type = (request.headers.get('content-type') ?? '').toLowerCase();
    let out: Awaited<ReturnType<typeof createRestorePreview>>;

    if (type.startsWith('application/json') || type.startsWith('application/x-www-form-urlencoded')) {
      const body = await readRequestFields(request, 4 * 1024);
      const data = body.data as Record<string, unknown> | null;
      const exportId = data && typeof data === 'object' ? data.export_id : undefined;
      if (typeof exportId !== 'string' || !isUuid(exportId.toLowerCase())) throw new BadRequestError('export_id 가 필요합니다');
      out = await createRestorePreviewFromExport(owner.db, owner.ownerId, exportId, {
        exportsDir: exportsDir(config),
        restoresDir: restoresDir(config),
      });
    } else if (type.startsWith('multipart/form-data') || type.startsWith('application/zip') || type.startsWith('application/octet-stream')) {
      const multipart = type.startsWith('multipart/form-data');
      tmp = await streamBodyToTempFile(request, restoresDir(config), MAX_RESTORE_UPLOAD + (multipart ? RESTORE_MULTIPART_OVERHEAD : 0));
      let zip: Uint8Array;
      if (multipart) {
        let form: FormData;
        try {
          form = await new Response(await readFile(/*turbopackIgnore: true*/ tmp), { headers: { 'content-type': request.headers.get('content-type')! } }).formData();
        } catch {
          throw new BadRequestError();
        }
        const file = form.get('file');
        if (!(file instanceof Blob) || file.size === 0) throw new BadRequestError('복원할 ZIP 파일(file)을 선택하세요');
        if (file.size > MAX_RESTORE_UPLOAD) throw new BadRequestError('파일이 너무 큽니다. 최대 256MB 까지 올릴 수 있습니다.');
        zip = new Uint8Array(await file.arrayBuffer());
      } else {
        zip = new Uint8Array(await readFile(/*turbopackIgnore: true*/ tmp));
      }
      out = await createRestorePreview(owner.db, owner.ownerId, zip, { restoresDir: restoresDir(config), source: 'upload' });
    } else {
      throw new BadRequestError('multipart/form-data(file), application/zip 또는 application/json(export_id)으로 보내야 합니다');
    }

    if (html) return seeOther(`/settings/restores/${out.restoreId}`);
    return json({ restore_id: out.restoreId, preview: out.preview });
  } catch (e) {
    if (html) return backupFormFailure(e, request, '/settings', '/settings?error=invalid');
    return errorResponse(e, request);
  } finally {
    if (tmp) await rm(/*turbopackIgnore: true*/ tmp, { force: true }).catch(() => undefined);
  }
}
