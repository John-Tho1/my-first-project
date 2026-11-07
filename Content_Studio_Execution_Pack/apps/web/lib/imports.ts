/**
 * T18(제안 결정 D32) 가져오기 공용(서버 전용): 저장 경로·원본 다시 읽기·선택 해석·응답 모양·폼 오류 문구.
 * 외부 서비스에 연결하지 않는다 — 올린 ZIP 또는 모의 커넥터(IMPORT_CONNECTOR_MODE=mock)만.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ImportFileChangedError, ImportFileMissingError, resolveFromRoot, type ImportItemRow, type ImportRunRow } from '@cs/db';
import {
  AppError,
  BadRequestError,
  isUuid,
  parseImportArchive,
  parseImportFile,
  sha256Bytes,
  type AppConfig,
  type ImportFileKind,
  type ImportSelection,
  type ParsedImportItem,
} from '@cs/domain';
import { createImportConnector } from '@cs/providers';
import { errorResponse, readBodyCapped, seeOther } from './api';

export const IMPORT_MULTIPART_OVERHEAD = 1024 * 1024;

export function importsDir(config: AppConfig): string {
  return resolveFromRoot(config.IMPORT_LOCAL_DIR);
}

export function importZipPath(config: AppConfig, runId: string): string {
  if (!isUuid(runId)) throw new Error('잘못된 가져오기 ID');
  return path.join(importsDir(config), `${runId}.zip`);
}

export async function saveImportZip(config: AppConfig, runId: string, zip: Uint8Array): Promise<void> {
  await mkdir(/*turbopackIgnore: true*/ importsDir(config), { recursive: true });
  await writeFile(/*turbopackIgnore: true*/ importZipPath(config, runId), zip, { flag: 'wx' });
}

export async function removeImportZip(config: AppConfig, runId: string): Promise<void> {
  await rm(/*turbopackIgnore: true*/ importZipPath(config, runId), { force: true }).catch(() => undefined);
}

/** T18: 커넥터가 꺼져 있음(IMPORT_CONNECTOR_MODE=disabled) — 503. 외부 호출 없음. */
export class ImportConnectorDisabledError extends AppError {
  constructor() {
    super('service_unavailable', 'import_connector_disabled', '가져오기 커넥터가 꺼져 있습니다(준비 중). 내보내기 ZIP 을 올려 가져오세요.');
  }
}

/** 모의 커넥터의 범위 전체를 항목으로 읽는다(외부 ID = 커넥터 ID). */
export async function loadConnectorItems(config: AppConfig): Promise<ParsedImportItem[]> {
  const connector = createImportConnector(config);
  if (!connector) throw new ImportConnectorDisabledError();
  const out: ParsedImportItem[] = [];
  for (const entry of await connector.listScope()) {
    const f = await connector.fetchItem(entry.id);
    out.push({ ...parseImportFile('drive_export', f.path, f.path, f.bytes), externalId: f.id });
  }
  return out;
}

/** 확정 때 원본 다시 읽기: ZIP 은 저장한 파일 + checksum 확인, 모의 커넥터는 다시 조회. */
export function importLoader(config: AppConfig) {
  return async (run: ImportRunRow): Promise<readonly ParsedImportItem[]> => {
    if (run.sourceKind === 'mock_connector') return loadConnectorItems(config);
    let zip: Uint8Array;
    try {
      zip = new Uint8Array(await readFile(/*turbopackIgnore: true*/ importZipPath(config, run.id)));
    } catch {
      throw new ImportFileMissingError();
    }
    if (sha256Bytes(zip) !== run.fileChecksum) throw new ImportFileChangedError();
    return parseImportArchive(run.sourceKind as ImportFileKind, zip).items;
  };
}

const MAX_SELECTION_BODY = 512 * 1024;
const uuidList = (v: unknown, field: string): string[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 5000) throw new BadRequestError(`${field} 는 ID 배열이어야 합니다`);
  return v.map((x) => {
    if (typeof x !== 'string' || !isUuid(x.toLowerCase())) throw new BadRequestError(`${field} 는 ID 배열이어야 합니다`);
    return x.toLowerCase();
  });
};
const folderList = (v: unknown): string[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 1000 || v.some((x) => typeof x !== 'string' || x.length > 1024)) throw new BadRequestError('folders 는 문자열 배열이어야 합니다');
  return v as string[];
};

/**
 * 확정 선택 읽기. JSON `{ item_ids, folders, version_ids, backfill_ids }` 또는 폼(같은 이름 여러 값: item·folder·version·backfill).
 * FIX-T18 round 2: backfill(원본 보충) — 원본 파일이 빠진 동일 항목만(DB 경계가 다시 확인).
 * 아무것도 고르지 않으면 400(빈 확정 금지 — 실수로 전부 건너뛰는 것을 막는다).
 */
export async function readImportSelection(request: Request): Promise<ImportSelection> {
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  const bytes = await readBodyCapped(request, MAX_SELECTION_BODY);
  let items: string[];
  let folders: string[];
  let versions: string[];
  let backfills: string[];
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (type.startsWith('application/json')) {
      const data = JSON.parse(text) as Record<string, unknown>;
      if (!data || typeof data !== 'object') throw new BadRequestError();
      items = uuidList(data.item_ids, 'item_ids');
      folders = folderList(data.folders);
      versions = uuidList(data.version_ids, 'version_ids');
      backfills = uuidList(data.backfill_ids, 'backfill_ids');
    } else if (type.startsWith('application/x-www-form-urlencoded')) {
      const form = new URLSearchParams(text);
      items = uuidList(form.getAll('item'), 'item');
      folders = folderList(form.getAll('folder'));
      versions = uuidList(form.getAll('version'), 'version');
      backfills = uuidList(form.getAll('backfill'), 'backfill');
    } else {
      throw new BadRequestError('application/json 또는 폼 형식으로 보내야 합니다');
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new BadRequestError();
  }
  if (!items.length && !folders.length && !versions.length && !backfills.length) {
    throw new AppError('bad_request', 'import_nothing_selected', '가져올 항목을 하나 이상 고르세요');
  }
  return { itemIds: new Set(items), folders, versionIds: new Set(versions), backfillIds: new Set(backfills) };
}

export function importRunView(r: ImportRunRow) {
  return {
    import_id: r.id,
    source_kind: r.sourceKind,
    file_name: r.fileName,
    file_checksum: r.fileChecksum,
    file_bytes: r.fileBytes,
    status: r.status,
    counts: r.counts,
    result: r.result,
    created_at: r.createdAt.toISOString(),
    committed_at: r.committedAt ? r.committedAt.toISOString() : null,
    canceled_at: r.canceledAt ? r.canceledAt.toISOString() : null,
  };
}

export function importItemView(i: ImportItemRow) {
  return {
    id: i.id,
    external_id: i.externalId,
    external_path: i.externalPath,
    folder: i.folder,
    title: i.title,
    format: i.format,
    content_checksum: i.contentChecksum,
    byte_size: i.byteSize,
    external_created_text: i.externalCreatedText,
    decision: i.decision,
    skip_reason: i.skipReason,
    matched_source_id: i.matchedSourceId,
    outcome: i.outcome,
    target_capture_id: i.targetCaptureId,
    target_source_id: i.targetSourceId,
    target_source_version_id: i.targetSourceVersionId,
  };
}

/** 파일 이름: 경로 조각·제어 문자 제거, 200자까지. */
export function safeFileName(name: string | null | undefined): string | null {
  if (!name) return null;
  // eslint-disable-next-line no-control-regex
  const base = name.split(/[\\/]/u).pop()!.replace(/[\u0000-\u001f\u007f]/gu, '').trim();
  return base ? Array.from(base).slice(0, 200).join('') : null;
}

/** 폼 오류 코드 → 고정 문구(쿼리 값을 그대로 출력하지 않는다). */
export const IMPORT_ERROR_TEXT: Record<string, string> = {
  invalid_zip: 'ZIP 파일을 읽을 수 없거나 허용되지 않는 경로가 들어 있습니다(경로 이탈·암호화·ZIP64 는 지원하지 않음). 아무것도 가져오지 않았습니다.',
  import_invalid: '이 ZIP 은 가져올 수 없습니다(항목 수·크기 상한). 폴더를 나눠 내보내세요.',
  import_too_large: '파일이 너무 큽니다. 최대 50MB ZIP 까지 올릴 수 있습니다.',
  import_connector_disabled: '가져오기 커넥터는 준비 중입니다(모의). 내보내기 ZIP 을 올려 가져오세요.',
  import_nothing_selected: '가져올 항목을 하나 이상 고르세요(새 항목, 또는 "새 버전으로 추가" 를 고른 충돌 항목). 아무것도 바꾸지 않았습니다.',
  import_invalid_selection: '"새 버전으로 추가" 는 충돌 항목만, "원본 보충" 은 원본 파일이 빠진 동일 항목만 고를 수 있습니다. 아무것도 바꾸지 않았습니다.',
  import_already_committed: '이미 확정한 가져오기입니다.',
  import_not_committable: '이 가져오기는 확정할 수 없는 상태입니다. 파일을 다시 올리세요.',
  import_file_missing: '미리보기에 쓴 파일이 서버에 없습니다. 파일을 다시 올리세요.',
  import_file_changed: '미리보기 뒤 파일이 바뀌었습니다. 파일을 다시 올리세요.',
  file_required: '가져올 ZIP 파일을 선택하세요.',
  csrf: '요청 출처를 확인할 수 없어 거부했습니다. 이 화면에서 다시 시도하세요.',
  invalid: '요청을 처리하지 못했습니다. 입력을 확인하세요.',
  server: '서버 오류가 발생했습니다.',
};

export function importErrorCode(e: unknown): string {
  if (e instanceof AppError) {
    if (e.code in IMPORT_ERROR_TEXT) return e.code;
    if (e.kind === 'payload_too_large') return 'import_too_large';
    if (e.kind === 'csrf') return 'csrf';
    return 'invalid';
  }
  return 'server';
}

/** 폼 실패: 401 → /login, 404 → notFoundHref, 그 외 → back?error=<code>. */
export function importFormFailure(e: unknown, request: Request, back: string, notFoundHref: string): Response {
  const res = errorResponse(e, request);
  if (res.status === 401) {
    const headers = new Headers();
    const cookie = res.headers.get('set-cookie');
    if (cookie) headers.set('set-cookie', cookie);
    return seeOther('/login', headers);
  }
  if (res.status === 404) return seeOther(notFoundHref);
  const sep = back.includes('?') ? '&' : '?';
  return seeOther(`${back}${sep}error=${importErrorCode(e)}`);
}

export const IMPORT_STATUS_LABEL: Record<string, string> = {
  preview: '미리보기만(아직 가져오지 않음)',
  committed: '가져오기 확정',
  canceled: '취소함',
  failed: '실패',
};
