import { readFile, rm } from 'node:fs/promises';
import { createImportPreview } from '@cs/db';
import {
  AppError,
  assertSameOrigin,
  BadRequestError,
  guessImportKind,
  IMPORT_MAX_ZIP_BYTES,
  ImportTooLargeError,
  parseImportArchive,
  type ImportFileKind,
} from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../lib/api';
import { streamBodyToTempFile } from '../../../../lib/backup';
import { readRequestFields } from '../../../../lib/body';
import {
  IMPORT_MULTIPART_OVERHEAD,
  importFormFailure,
  importItemView,
  importRunView,
  importsDir,
  loadConnectorItems,
  removeImportZip,
  safeFileName,
  saveImportZip,
} from '../../../../lib/imports';
import { getConfig } from '../../../../lib/server';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const KINDS = ['auto', 'notion_export', 'drive_export'] as const;
const parseKind = (v: unknown): (typeof KINDS)[number] => {
  if (v === undefined || v === null || v === '') return 'auto';
  if (typeof v !== 'string' || !(KINDS as readonly string[]).includes(v)) throw new BadRequestError('source_kind 는 auto·notion_export·drive_export 중 하나입니다');
  return v as (typeof KINDS)[number];
};

/**
 * POST /api/imports/preview — 가져오기 미리보기(T18, D32 제안). 소재·출처는 바뀌지 않고 원장(import_runs·import_items)만 남는다.
 * - multipart/form-data `file`(내보내기 ZIP ≤ 50MB) + `source_kind`(auto|notion_export|drive_export), 또는 application/zip 본문(+ ?kind=).
 *   본문을 먼저 data/imports/ 임시 파일로 흘려 쓴 뒤 검사한다. 확정·취소 전까지 ZIP 을 data/imports/<import_id>.zip 에 둔다.
 * - application/json `{ source: 'mock_connector' }`: IMPORT_CONNECTOR_MODE=mock 일 때만(모의 자료, 외부 호출 0). 꺼져 있으면 503 import_connector_disabled.
 * 200 { import_id, run, items }. 위험한 ZIP(경로 이탈·암호화·ZIP64·상한 초과) → 400/413, 원장 행 없음.
 * 브라우저 폼: 303 → /imports/<id> (실패는 /imports?error=<code>).
 */
export async function POST(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  let tmp: string | null = null;
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request); // 로그인 확인 전에는 본문을 읽지 않는다
    const type = (request.headers.get('content-type') ?? '').toLowerCase();
    let out: Awaited<ReturnType<typeof createImportPreview>>;

    if (type.startsWith('application/json') || type.startsWith('application/x-www-form-urlencoded')) {
      const body = await readRequestFields(request, 4 * 1024);
      const data = body.data as Record<string, unknown> | null;
      if (!data || typeof data !== 'object' || data.source !== 'mock_connector') throw new BadRequestError('source 는 mock_connector 이어야 합니다(파일은 multipart 로 올리세요)');
      const items = await loadConnectorItems(config);
      out = await createImportPreview(owner.db, owner.ownerId, {
        sourceKind: 'mock_connector',
        fileName: null,
        fileChecksum: null,
        fileBytes: null,
        items,
        attachments: 0,
      });
    } else if (type.startsWith('multipart/form-data') || type.startsWith('application/zip') || type.startsWith('application/octet-stream')) {
      const multipart = type.startsWith('multipart/form-data');
      try {
        tmp = await streamBodyToTempFile(request, importsDir(config), IMPORT_MAX_ZIP_BYTES + (multipart ? IMPORT_MULTIPART_OVERHEAD : 0));
      } catch (e) {
        if (e instanceof AppError && e.kind === 'payload_too_large') throw new ImportTooLargeError();
        throw e;
      }
      let zip: Uint8Array;
      let fileName: string | null = null;
      let kind: (typeof KINDS)[number];
      if (multipart) {
        let form: FormData;
        try {
          form = await new Response(await readFile(/*turbopackIgnore: true*/ tmp), { headers: { 'content-type': request.headers.get('content-type')! } }).formData();
        } catch {
          throw new BadRequestError();
        }
        const file = form.get('file');
        if (!(file instanceof Blob) || file.size === 0) throw new AppError('bad_request', 'file_required', '가져올 ZIP 파일(file)을 선택하세요');
        if (file.size > IMPORT_MAX_ZIP_BYTES) throw new ImportTooLargeError();
        kind = parseKind(form.get('source_kind'));
        fileName = safeFileName((file as File).name);
        zip = new Uint8Array(await file.arrayBuffer());
      } else {
        kind = parseKind(new URL(request.url).searchParams.get('kind'));
        zip = new Uint8Array(await readFile(/*turbopackIgnore: true*/ tmp));
      }
      // 파싱은 auto 일 때 Drive 규칙(경로 ID)으로 한 번 읽어 Notion 페이지 ID 가 보이면 Notion 규칙으로 다시 읽는다.
      let parsed = parseImportArchive(kind === 'auto' ? 'drive_export' : kind, zip);
      let finalKind: ImportFileKind = kind === 'auto' ? 'drive_export' : kind;
      if (kind === 'auto') {
        const notionProbe = parseImportArchive('notion_export', zip);
        finalKind = guessImportKind(fileName, notionProbe.items);
        if (finalKind === 'notion_export') parsed = notionProbe;
      }
      out = await createImportPreview(owner.db, owner.ownerId, {
        sourceKind: finalKind,
        fileName,
        fileChecksum: parsed.fileChecksum,
        fileBytes: parsed.fileBytes,
        items: parsed.items,
        attachments: parsed.attachments,
        saveFile: (runId) => saveImportZip(config, runId, zip),
        removeFile: (runId) => removeImportZip(config, runId),
      });
    } else {
      throw new BadRequestError('multipart/form-data(file), application/zip 또는 application/json(source: mock_connector)으로 보내야 합니다');
    }

    if (html) return seeOther(`/imports/${out.run.id}`);
    return json({ import_id: out.run.id, run: importRunView(out.run), items: out.items.map(importItemView) });
  } catch (e) {
    if (html) return importFormFailure(e, request, '/imports', '/imports?error=invalid');
    return errorResponse(e, request);
  } finally {
    if (tmp) await rm(/*turbopackIgnore: true*/ tmp, { force: true }).catch(() => undefined);
  }
}
