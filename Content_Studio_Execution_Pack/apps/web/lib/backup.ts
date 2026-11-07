/**
 * 내보내기·복원 공용(서버 전용, T05). 경로 해석·응답 모양·폼 오류 문구.
 * 화면 문구 규칙(docs/07): 실제 복원 결과 없이 "안전"·"백업 완료"라고 쓰지 않는다.
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { resolveFromRoot, type ExportRunRow, type RestoreRunRow } from '@cs/db';
import { AppError, formatMsk, PayloadTooLargeError, type AppConfig } from '@cs/domain';
import { errorResponse, seeOther } from './api';

/** 복원용 업로드 상한(ZIP 256MB) + multipart 여유. */
export const MAX_RESTORE_UPLOAD = 256 * 1024 * 1024;
export const RESTORE_MULTIPART_OVERHEAD = 1024 * 1024;

export function exportsDir(config: AppConfig): string {
  return resolveFromRoot(config.EXPORT_LOCAL_DIR);
}

export function restoresDir(config: AppConfig): string {
  return resolveFromRoot(config.RESTORE_LOCAL_DIR);
}

export function exportRunView(r: ExportRunRow) {
  return {
    export_id: r.id,
    created_at: r.createdAt.toISOString(),
    format_version: r.formatVersion,
    manifest_sha256: r.manifestSha256,
    zip_bytes: r.zipBytes,
    status: r.status,
    totals: r.totals,
    download_url: `/api/exports/${r.id}`,
  };
}

export function restoreRunView(r: RestoreRunRow) {
  return {
    restore_id: r.id,
    created_at: r.createdAt.toISOString(),
    source: r.source,
    status: r.status,
    mode: r.mode,
    committed_at: r.committedAt ? r.committedAt.toISOString() : null,
    manifest_sha256: r.manifestSha256,
    preview: r.preview,
    result: r.result,
  };
}

/** `content-studio-export-20260924-1822-msk.zip` */
export function exportFilename(createdAt: Date): string {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(formatMsk(createdAt));
  const stamp = m ? `${m[1]}${m[2]}${m[3]}-${m[4]}${m[5]}` : 'unknown';
  return `content-studio-export-${stamp}-msk.zip`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 요청 본문을 메모리에 모으지 않고 임시 파일로 흘려 쓴다(상한 초과 시 413 + 임시 파일 삭제).
 * 반환: 임시 파일 경로(호출자가 지운다).
 */
export async function streamBodyToTempFile(request: Request, dir: string, limit: number): Promise<string> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) throw new PayloadTooLargeError('파일이 너무 큽니다. 최대 256MB 까지 올릴 수 있습니다.');
  await mkdir(/*turbopackIgnore: true*/ dir, { recursive: true });
  const tmp = path.join(dir, `upload-${randomUUID()}.tmp`);
  const out = createWriteStream(/*turbopackIgnore: true*/ tmp, { flags: 'wx' });
  const done = new Promise<void>((resolve, reject) => {
    out.on('finish', () => resolve());
    out.on('error', reject);
  });
  let total = 0;
  try {
    if (request.body) {
      const reader = request.body.getReader();
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel().catch(() => undefined);
          throw new PayloadTooLargeError('파일이 너무 큽니다. 최대 256MB 까지 올릴 수 있습니다.');
        }
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      }
    }
    out.end();
    await done;
    return tmp;
  } catch (e) {
    out.destroy();
    await rm(/*turbopackIgnore: true*/ tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** 복원·내보내기 폼 오류 코드 → 고정 문구(쿼리 값을 그대로 출력하지 않는다). */
export const BACKUP_ERROR_TEXT: Record<string, string> = {
  manifest_mismatch: '파일의 checksum 이 manifest 와 일치하지 않습니다(변조 또는 손상). 복원하지 않았습니다.',
  invalid_zip: 'ZIP 파일을 읽을 수 없습니다. 이 앱에서 만든 내보내기 파일인지 확인하세요.',
  invalid_bundle: 'Content Studio 내보내기 파일이 아닙니다.',
  unsupported_version: '지원하지 않는 내보내기 형식 버전입니다.',
  schema_incompatible: '이 앱보다 새로운 DB 구조에서 만든 파일이라 복원할 수 없습니다.',
  invalid_rows: '파일 안의 데이터 형식이 올바르지 않습니다.',
  integrity: '파일 안의 관계(ID 참조)가 맞지 않습니다.',
  restore_target_not_empty: '이 계정에 이미 데이터가 있어 "빈 환경에만 복원"을 할 수 없습니다. "없는 항목만 추가"를 고르세요.',
  restore_conflict: '같은 ID 의 다른 데이터가 있어 "빈 환경에만 복원"을 할 수 없습니다.',
  already_committed: '이미 복원한 미리보기입니다.',
  restore_not_committable: '이 미리보기는 복원할 수 없는 상태입니다. 파일을 다시 올리세요.',
  restore_file_missing: '미리보기에 쓴 파일이 서버에 없습니다. 파일을 다시 올리세요.',
  confirm_required: '"내용을 확인했습니다"를 체크해야 복원합니다.',
  too_large: '파일이 너무 큽니다. 최대 256MB 까지 올릴 수 있습니다.',
  csrf: '요청 출처를 확인할 수 없어 거부했습니다. 이 화면에서 다시 시도하세요.',
  invalid: '요청을 처리하지 못했습니다. 입력을 확인하세요.',
  server: '서버 오류가 발생했습니다.',
};

export function backupErrorCode(e: unknown): string {
  if (e instanceof AppError) {
    if (e.code in BACKUP_ERROR_TEXT) return e.code;
    if (e.kind === 'payload_too_large') return 'too_large';
    if (e.kind === 'csrf') return 'csrf';
    return 'invalid';
  }
  return 'server';
}

/** 폼 실패: 401 → /login, 404 → notFoundHref, 그 외 → back?error=<code>. */
export function backupFormFailure(e: unknown, request: Request, back: string, notFoundHref: string): Response {
  const res = errorResponse(e, request);
  if (res.status === 401) {
    const headers = new Headers();
    const cookie = res.headers.get('set-cookie');
    if (cookie) headers.set('set-cookie', cookie);
    return seeOther('/login', headers);
  }
  if (res.status === 404) return seeOther(notFoundHref);
  const sep = back.includes('?') ? '&' : '?';
  return seeOther(`${back}${sep}error=${backupErrorCode(e)}`);
}
