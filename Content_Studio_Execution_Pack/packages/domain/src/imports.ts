/**
 * T18(제안 결정 D32) Notion·Drive 선택 가져오기 — 순수 함수(ZIP 읽기·항목 추출·판정). DB·파일·네트워크 없음.
 *
 * 입력은 사용자가 직접 올린 내보내기 ZIP 이다(Notion "Markdown & CSV" 내보내기, Google Drive "다운로드" ZIP).
 * 외부 서비스에 연결하지 않는다 — 자격 증명·OAuth 없음. 원본 파일은 읽기만 하고, 앱 안에 사본(소재)을 만든다.
 *
 * 안전 규칙(내보내기 복원 ZIP 규칙 isSafeZipPath 재사용 + 상한):
 *  - 위험한 경로(`..`·절대 경로·역슬래시·드라이브 문자·빈 조각) 가 하나라도 있으면 ZIP 전체를 거부한다(zip-slip). 파일을 디스크에 풀지 않는다.
 *  - 암호화·ZIP64·분할 ZIP 거부. 압축 방식은 저장(0)·deflate(8)만. 항목 수·텍스트 항목 크기·풀린 텍스트 총량·중첩 ZIP 깊이에 상한.
 *  - deflate 는 Node zlib.inflateRawSync 의 maxOutputLength 로 선언 크기 이상 풀지 않는다(압축 폭탄 차단). 풀린 크기·CRC-32 는 목록과 같아야 한다.
 *  - 텍스트(.md·.markdown·.txt·.html·.htm·.csv)만 가져온다. 이미지·첨부·그 밖의 파일은 목록에만 남기고(skipped) 풀지 않는다.
 */
import { createHash } from 'node:crypto';
import { crc32, inflateRawSync } from 'node:zlib';
import { MAX_RAW_TEXT, MAX_TITLE } from './capture';
import { AppError } from './errors';
import { isSafeZipPath, ZipFormatError } from './zip';

export const IMPORT_SOURCE_KINDS = ['notion_export', 'drive_export', 'mock_connector'] as const;
export type ImportSourceKind = (typeof IMPORT_SOURCE_KINDS)[number];
export const IMPORT_FILE_KINDS = ['notion_export', 'drive_export'] as const;
export type ImportFileKind = (typeof IMPORT_FILE_KINDS)[number];

/** 올릴 수 있는 ZIP 최대 크기(50 MiB). */
export const IMPORT_MAX_ZIP_BYTES = 50 * 1024 * 1024;
/** ZIP 안 항목 수 상한(중첩 ZIP 안 항목 포함). */
export const IMPORT_MAX_ENTRIES = 5000;
/** 텍스트 항목 하나의 풀린 크기 상한(2 MiB). 넘으면 too_large 로 건너뛴다(풀지 않음). */
export const IMPORT_MAX_TEXT_ENTRY_BYTES = 2 * 1024 * 1024;
/** 풀린 텍스트 총량 상한(64 MiB). 넘으면 ZIP 전체를 거부한다. */
export const IMPORT_MAX_TOTAL_TEXT_BYTES = 64 * 1024 * 1024;
/** 중첩 ZIP(예: Notion 큰 내보내기의 Part-1.zip) 깊이 상한 — 바깥 ZIP 안의 ZIP 한 겹만. */
export const IMPORT_MAX_NESTED_DEPTH = 1;
/** 중첩 ZIP 하나의 풀린 크기 상한(= 올릴 수 있는 ZIP 크기). */
const MAX_NESTED_ZIP_BYTES = IMPORT_MAX_ZIP_BYTES;
/**
 * FIX-T18 round 1(Codex review-T18 P0 :328): 묶음 전체(바깥 + 모든 중첩 ZIP)에서 실제로 푸는 바이트 합 상한(128 MiB).
 * 중첩 ZIP 컨테이너를 푸는 바이트와 텍스트 항목을 푸는 바이트를 모두 센다(풀기 **전에** 선언 크기로 검사 — 넘으면 묶음 전체 거부).
 */
export const IMPORT_MAX_TOTAL_INFLATED_BYTES = 128 * 1024 * 1024;
/**
 * FIX-T18 round 2(Codex review-FIX-T18 P0 :499): 묶음 전체에서 실제로 푸는 **압축 입력** 바이트 합 상한(바깥 파일 + 풀린 바이트 상한).
 * 겹치는 구간을 거부하므로 정상 경로에서는 넘을 수 없다 — 같은 압축 데이터를 되풀이해 푸는 회귀를 막는 방어선.
 */
export const IMPORT_MAX_TOTAL_COMPRESSED_BYTES = IMPORT_MAX_ZIP_BYTES + IMPORT_MAX_TOTAL_INFLATED_BYTES;
/** FIX-T18 round 1: 바깥 ZIP 안에서 풀 수 있는 중첩 ZIP 개수 상한(넘으면 묶음 전체 거부). */
export const IMPORT_MAX_NESTED_ARCHIVES = 16;
/** 가져올 수 있는(텍스트) 항목 수 상한 — 미리보기 한 번에 이 수를 넘으면 거부(나눠서 올리기). */
export const IMPORT_MAX_ITEMS = 1000;
/** FIX-T18 round 1(P2 :339): 원장 크기 값의 상한 — ZIP 의 크기 필드는 unsigned 32bit 이다(원장 byte_size 는 0039 에서 bigint). */
export const IMPORT_MAX_DECLARED_BYTES = 0xffffffff;

export type ImportFormat = 'md' | 'txt' | 'html' | 'csv' | 'other';
export type ImportSkipReason =
  | 'unsupported_type' // 이미지·첨부·그 밖의 파일(목록만)
  | 'too_large' // 풀린 크기 > IMPORT_MAX_TEXT_ENTRY_BYTES
  | 'too_long' // 소재 원문 상한(MAX_RAW_TEXT 자) 초과
  | 'not_utf8' // UTF-8 이 아님(또는 NUL 포함)
  | 'empty' // 본문 없음
  | 'duplicate_in_archive'; // 같은 외부 ID 가 ZIP 안에 두 번
export type ImportDecision = 'new' | 'identical' | 'conflict' | 'skipped';

export class ImportTooLargeError extends AppError {
  constructor(message = '파일이 너무 큽니다. 최대 50MB ZIP 까지 올릴 수 있습니다.') {
    super('payload_too_large', 'import_too_large', message);
  }
}

/** ZIP 은 읽었지만 가져올 수 없는 묶음(항목 수·총량 초과 등). 400 import_invalid. */
export class ImportInvalidError extends AppError {
  constructor(message: string) {
    super('bad_request', 'import_invalid', message);
  }
}

/** 미리보기·확정에 쓰는 항목 하나(본문 포함 — DB 원장에는 본문을 넣지 않는다). */
export interface ParsedImportItem {
  /** 외부 ID: `notion:<32 hex>` 또는 `path:<ZIP 안 경로>`(또는 모의 커넥터 `mock:<id>`) */
  externalId: string;
  /** ZIP 안 원래 경로(중첩 ZIP 이면 `<안쪽 ZIP 이름>!/<경로>`) */
  externalPath: string;
  /** 폴더(경로의 디렉터리 부분, 루트는 '') — 선택 범위 단위 */
  folder: string;
  title: string | null;
  format: ImportFormat;
  /** 원본 파일 바이트의 sha256(hex). 건너뛴(풀지 않은) 항목은 null */
  contentChecksum: string | null;
  /** 원본 파일 크기(풀린 크기, 바이트) */
  byteSize: number;
  /** 원본에 적힌 생성 시각 문자열(Notion 속성 "Created: …" 등) — 해석하지 않고 그대로(최대 100자) */
  externalCreatedText: string | null;
  /** 소재 원문으로 넣을 본문(.md·.txt·.csv 는 원문 그대로(BOM 만 뗌), .html 은 추출한 텍스트 — 파생 값). 건너뛴 항목은 null */
  body: string | null;
  /**
   * FIX-T18 round 1(Codex review-T18 P0 :293, AGENTS "원본 보존"): 원본 파일 바이트를 그대로 디코딩한 문자열(BOM 포함, 변환 없음).
   * 가져오는 항목은 UTF-8·NUL 없음이 보장되므로 UTF-8 로 다시 인코딩하면 원본 바이트와 정확히 같고 sha256 = contentChecksum.
   * 확정 때 source_version_originals 에 그대로 보관한다(내보내기·복원 포함). 건너뛴 항목은 null.
   */
  original: string | null;
  skipReason: ImportSkipReason | null;
}

export interface ParsedImportArchive {
  fileChecksum: string;
  fileBytes: number;
  items: ParsedImportItem[];
  /** 지원하지 않는(목록만 남긴) 파일 수 */
  attachments: number;
}

export const sha256Bytes = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

// ---- ZIP(저장·deflate) 읽기 ----

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

interface RawEntry {
  path: string;
  method: number;
  crc: number;
  compSize: number;
  size: number;
  dataStart: number;
  /** FIX-T18 round 2: local header 시작(구간 겹침 검사용) */
  localOffset: number;
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  return -1;
}

/**
 * 중앙 목록을 읽고 경로·형식을 검사한다(내용은 풀지 않는다).
 * FIX-T18 round 1: records = 중앙 목록 레코드 수(디렉터리 포함) — 전역 항목 수 상한은 이 값으로 센다.
 * 모든 레코드(디렉터리·첨부 포함)의 압축 방식은 저장(0)·deflate(8)만. local header 의 이름·방식·암호화 플래그는 중앙 목록과 같아야 한다
 * (데이터 디스크립터 bit 3 이 있으면 local 의 크기·CRC 는 0 일 수 있으므로 중앙 목록 값만 쓴다).
 */
function listZip(buf: Buffer): { entries: RawEntry[]; records: number } {
  if (buf.length < 22) throw new ZipFormatError('ZIP 파일이 아닙니다');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new ZipFormatError('ZIP 파일이 아닙니다(끝 레코드 없음)');
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const countDisk = buf.readUInt16LE(eocd + 8);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || countDisk !== count) throw new ZipFormatError('분할 ZIP 은 지원하지 않습니다');
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipFormatError('ZIP64 는 지원하지 않습니다');
  if (cdOffset + cdSize > eocd) throw new ZipFormatError('ZIP 목록 위치가 올바르지 않습니다');
  if (count > IMPORT_MAX_ENTRIES) throw new ImportInvalidError(`ZIP 항목이 너무 많습니다(최대 ${IMPORT_MAX_ENTRIES}개)`);

  const out: RawEntry[] = [];
  const seen = new Set<string>();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cdOffset + cdSize || buf.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipFormatError('ZIP 목록이 손상되었습니다');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > cdOffset + cdSize) throw new ZipFormatError('ZIP 목록이 손상되었습니다');
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x0001) throw new ZipFormatError('암호화된 ZIP 은 지원하지 않습니다');
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) throw new ZipFormatError('ZIP64 는 지원하지 않습니다');
    // FIX-T18 round 1: 압축 방식은 모든 레코드(디렉터리·첨부·큰 파일 포함)에서 검사한다 — 풀지 않는 항목도 지원하지 않는 방식이면 묶음 거부.
    if (method !== 0 && method !== 8) throw new ZipFormatError('지원하지 않는 ZIP 압축 방식입니다', { paths: [name.slice(0, 200)] });
    const isDir = name.endsWith('/');
    const checkName = isDir ? name.slice(0, -1) : name;
    // zip-slip: 위험한 경로가 하나라도 있으면 묶음 전체를 거부한다(디렉터리 항목 포함).
    if (!isSafeZipPath(checkName)) throw new ZipFormatError('허용되지 않는 ZIP 경로가 있습니다', { paths: [name.slice(0, 200)] });
    if (isDir) continue;
    if (seen.has(name)) throw new ZipFormatError('ZIP 안에 같은 이름의 파일이 있습니다', { paths: [name.slice(0, 200)] });
    seen.add(name);
    if (localOffset + 30 > cdOffset || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new ZipFormatError('ZIP 항목 헤더가 손상되었습니다', { paths: [name.slice(0, 200)] });
    }
    const lFlags = buf.readUInt16LE(localOffset + 6);
    const lMethod = buf.readUInt16LE(localOffset + 8);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    if (localOffset + 30 + lNameLen > cdOffset) throw new ZipFormatError('ZIP 항목 헤더가 손상되었습니다', { paths: [name.slice(0, 200)] });
    const lName = buf.subarray(localOffset + 30, localOffset + 30 + lNameLen).toString('utf8');
    // FIX-T18 round 1: local/central 불일치(이름·방식·암호화) → 거부. 해석기마다 다른 파일을 보게 만드는 ZIP 을 받지 않는다.
    if (lName !== name || lMethod !== method || (lFlags & 0x0001) !== (flags & 0x0001)) {
      throw new ZipFormatError('ZIP 항목 헤더가 목록과 다릅니다', { paths: [name.slice(0, 200)] });
    }
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > cdOffset) throw new ZipFormatError('ZIP 항목 크기가 올바르지 않습니다', { paths: [name.slice(0, 200)] });
    out.push({ path: name, method, crc, compSize, size, dataStart, localOffset });
  }
  // FIX-T18 round 2(Codex review-FIX-T18 P0 :499): 항목마다 [local header 시작, 압축 데이터 끝) 구간이 파일 안에 있고 서로 겹치지 않아야 한다.
  // 겹치면(같은 local header 를 여러 레코드가 가리키거나, 한 항목의 데이터 안에 다른 항목이 들어 있으면) 같은 압축 바이트를 여러 번 풀게 되어
  // 출력 예산으로는 CPU 를 묶을 수 없다 → 묶음 전체 거부. 구간이 서로 겹치지 않으면 한 ZIP 에서 푸는 압축 바이트 합 ≤ 파일 크기.
  const ranges = out.map((e) => ({ start: e.localOffset, end: e.dataStart + e.compSize, path: e.path })).sort((a, b) => a.start - b.start || a.end - b.end);
  for (let k = 1; k < ranges.length; k++) {
    if (ranges[k]!.start < ranges[k - 1]!.end) {
      throw new ZipFormatError('ZIP 항목의 데이터 구간이 겹칩니다', { paths: [ranges[k]!.path.slice(0, 200)] });
    }
  }
  return { entries: out, records: count };
}

/** 항목 하나를 푼다(선언 크기까지만). 방식·크기·CRC 가 맞지 않으면 ZipFormatError. */
function extract(buf: Buffer, e: RawEntry): Uint8Array {
  const data = buf.subarray(e.dataStart, e.dataStart + e.compSize);
  let bytes: Uint8Array;
  if (e.method === 0) {
    if (e.compSize !== e.size) throw new ZipFormatError('ZIP 항목 크기가 올바르지 않습니다', { paths: [e.path.slice(0, 200)] });
    bytes = new Uint8Array(data);
  } else if (e.method === 8) {
    try {
      // maxOutputLength: 선언 크기를 넘게 풀리면 RangeError(압축 폭탄·거짓 크기)
      bytes = new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.max(1, e.size) }));
    } catch {
      throw new ZipFormatError('ZIP 항목을 풀 수 없습니다(손상 또는 크기 불일치)', { paths: [e.path.slice(0, 200)] });
    }
    if (bytes.byteLength !== e.size) throw new ZipFormatError('ZIP 항목 크기가 올바르지 않습니다', { paths: [e.path.slice(0, 200)] });
  } else {
    throw new ZipFormatError('지원하지 않는 ZIP 압축 방식입니다', { paths: [e.path.slice(0, 200)] });
  }
  if (crc32(bytes) >>> 0 !== e.crc) throw new ZipFormatError('ZIP 항목의 CRC 가 일치하지 않습니다(파일 손상)', { paths: [e.path.slice(0, 200)] });
  return bytes;
}

// ---- 항목 해석 ----

const TEXT_EXT: Record<string, ImportFormat> = { md: 'md', markdown: 'md', txt: 'txt', html: 'html', htm: 'html', csv: 'csv' };
/** Notion 내보내기 파일·폴더 이름 끝의 페이지 ID(32 hex, 공백 뒤) */
const NOTION_ID_RE = /\s([0-9a-f]{32})(?:_all)?$/i;

function splitPath(p: string): { folder: string; base: string; ext: string; stem: string } {
  const i = p.lastIndexOf('/');
  const folder = i < 0 ? '' : p.slice(0, i);
  const base = i < 0 ? p : p.slice(i + 1);
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return { folder, base, ext, stem };
}

/** 폴더 표시에서 Notion ID 조각을 뗀다(`Content Vault 68b1…` → `Content Vault`). */
function cleanSegment(seg: string): string {
  return seg.replace(NOTION_ID_RE, '').trim() || seg;
}

export function formatOfPath(p: string): ImportFormat {
  return TEXT_EXT[splitPath(p).ext] ?? 'other';
}

/** 외부 ID: Notion 이면 파일 이름의 페이지 ID(`notion:<hex>`, CSV `_all` 은 `notion:<hex>:all`), 그 밖에는 경로(`path:<경로>`). */
export function externalIdFor(kind: ImportFileKind, innerPath: string): string {
  const { stem, ext } = splitPath(innerPath);
  if (kind === 'notion_export') {
    const m = NOTION_ID_RE.exec(stem);
    if (m) return `notion:${m[1]!.toLowerCase()}${stem.endsWith('_all') ? ':all' : ''}${ext === 'csv' ? ':csv' : ''}`;
  }
  return `path:${innerPath}`;
}

const truncate = (s: string, n: number) => {
  const chars = Array.from(s);
  return chars.length > n ? chars.slice(0, n).join('') : s;
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/gi, (all, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      // FIX-T18 round 2(놓친 케이스): NUL(0)·짝 없는 서로게이트(D800–DFFF) 를 만들지 않는다 — 그대로 둔다.
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[ent.toLowerCase()] ?? all;
  });
}

/** FIX-T18 round 1: htmlToText 입력 상한(문자 수) — 텍스트 항목 상한과 같다. 넘으면 처리하지 않는다. */
export const HTML_TO_TEXT_MAX_INPUT = IMPORT_MAX_TEXT_ENTRY_BYTES;

/** 내용을 통째로 건너뛰는 요소(닫는 태그까지). title 은 제목으로만 쓰고 본문에는 넣지 않는다. */
const HTML_RAW_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template', 'title']);
/** 닫는 태그 뒤 줄바꿈 */
const HTML_BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'blockquote', 'pre', 'section', 'article', 'ul', 'ol', 'table']);
const isAsciiLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isTagNameChar = (c: number) => isAsciiLetter(c) || (c >= 48 && c <= 57) || c === 45 || c === 58;

/**
 * FIX-T18 round 2(선형성 검사): htmlToText 가 실제로 살펴본 글자 수(탐색 구간 길이 + 글자 단위 비교 + 반복 횟수)를 세는 계수기.
 * 시험은 벽시계 대신 이 값이 입력 길이에 비례하는지(입력 글자당 상수 이하)를 본다 — 같은 구간을 다시 훑는 구현(제곱)이면 바로 드러난다.
 */
export interface HtmlScanStats {
  steps: number;
}

/** from 부터 `</name`(대소문자 무시, 뒤가 이름 글자가 아님) 의 위치. 없으면 -1. 앞으로만 훑는다(선형). */
function findClosingTag(html: string, name: string, from: number, st: HtmlScanStats): number {
  let pos = from;
  for (;;) {
    const k = html.indexOf('</', pos);
    st.steps += (k < 0 ? html.length : k + 2) - pos + 1;
    if (k < 0) return -1;
    // 이름을 글자 단위로 비교(ASCII 대소문자 무시) — 조각 문자열을 만들지 않는다.
    let m = 0;
    while (m < name.length && (html.charCodeAt(k + 2 + m) | 0x20) === name.charCodeAt(m)) m++;
    st.steps += m + 1;
    if (m === name.length && !isTagNameChar(html.charCodeAt(k + 2 + m))) return k;
    pos = k + 2;
  }
}

const isHtmlSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;

/**
 * FIX-T18 round 2(Codex review-FIX-T18 놓친 케이스 "속성 안의 `>`"): 태그 이름 뒤 from 부터 태그를 끝내는 `>` 의 위치. 없으면 -1.
 * `=` 바로 뒤(공백 허용)의 따옴표 값 안 `>` 는 태그 끝이 아니다(브라우저와 같음). 닫히지 않은 따옴표는 끝까지 속성 값(-1).
 * 글자마다 한 번만 본다 — 따옴표 값은 indexOf 로 건너뛰고 그 자리부터 이어 간다(선형).
 */
function findTagEnd(html: string, from: number, st: HtmlScanStats): number {
  const n = html.length;
  let k = from;
  while (k < n) {
    const c = html.charCodeAt(k);
    st.steps++;
    if (c === 62) return k; // '>'
    if (c === 61) {
      // '=' 뒤 공백을 건너뛰고 따옴표로 시작하면 짝 따옴표까지 한 번에
      k++;
      while (k < n && isHtmlSpace(html.charCodeAt(k))) {
        k++;
        st.steps++;
      }
      const q = html.charCodeAt(k);
      if (q === 34 || q === 39) {
        const close = html.indexOf(q === 34 ? '"' : "'", k + 1);
        st.steps += (close < 0 ? n : close) - k + 1;
        if (close < 0) return -1;
        k = close + 1;
      }
      continue;
    }
    k++;
  }
  return -1;
}

/**
 * HTML → 텍스트(스크립트·스타일 제거, 블록 요소는 줄바꿈). 실행·외부 요청 없음. 결과는 소재 원문에 넣는 **파생 값**이고 원본 HTML 은
 * source_version_originals 에 그대로 남는다(FIX-T18 round 1 P0 :293).
 *
 * FIX-T18 round 1(Codex review-T18 P0 :248): 정규식 대신 한 번 훑는 토큰 순회(선형 시간). 모든 탐색(indexOf)은 현재 위치에서 앞으로만 가고,
 * 찾은 곳까지 위치를 옮기거나(소비) 찾지 못하면 그 자리에서 끝낸다 — 같은 구간을 다시 훑지 않는다.
 * 닫히지 않은 주석·script/style/noscript/template/title 은 나머지를 버리고(브라우저와 같음), `>` 없는 태그 시작도 나머지를 버린다.
 *
 * FIX-T18 round 2: (P2 :366) script/style/noscript/template/title 은 `<script/>` 처럼 `/` 로 끝나도 자체 종료가 아니다(HTML 은 void 요소가 아니면
 * `/` 를 무시) — 언제나 짝 닫는 태그까지(없으면 끝까지) 버린다. 속성 따옴표 값 안의 `>` 는 태그 끝이 아니다.
 * 탐색 위치는 언제나 앞으로만 간다 — `stats.steps`(살펴본 글자 수)는 입력 길이의 상수 배 이하다(시험이 확인).
 */
export function htmlToText(html: string, stats?: HtmlScanStats): { text: string; title: string | null } {
  if (html.length > HTML_TO_TEXT_MAX_INPUT) throw new ImportInvalidError('HTML 이 너무 큽니다');
  const st: HtmlScanStats = { steps: 0 };
  const out: string[] = [];
  let titleRaw: string | null = null;
  let h1: string[] | null = null;
  let h1Open = false;
  let h1Len = 0;
  const emit = (s: string) => {
    out.push(s);
    if (h1Open && h1Len < 2000) {
      h1!.push(s);
      h1Len += s.length;
    }
  };
  const n = html.length;
  // pending: 아직 내보내지 않은 글자 구간의 시작. 태그가 아닌 '<' 는 글자 구간에 그대로 남긴다(조각을 만들지 않음).
  let pending = 0;
  let i = 0;
  while (i < n) {
    st.steps++;
    const lt = html.indexOf('<', i);
    st.steps += (lt < 0 ? n : lt) - i + 1;
    if (lt < 0) break;
    const c1 = html.charCodeAt(lt + 1);
    const closing = c1 === 47; // '/'
    const markup = c1 === 33 || c1 === 63; // '<!…>'(주석·DOCTYPE), '<?xml …?>'
    const nameStart = closing ? lt + 2 : lt + 1;
    if (!markup && !isAsciiLetter(html.charCodeAt(nameStart))) {
      i = lt + 1; // 태그가 아닌 '<'(예: "a < b") 는 글자 구간에 그대로 남긴다
      continue;
    }
    if (c1 === 33 && html.startsWith('<!--', lt)) {
      if (lt > pending) emit(html.slice(pending, lt));
      const end = html.indexOf('-->', lt + 4);
      st.steps += (end < 0 ? n : end + 3) - (lt + 4) + 1;
      pending = i = end < 0 ? n : end + 3; // 닫히지 않은 주석: 나머지는 주석
      if (end >= 0) out.push(' ');
      continue;
    }
    if (lt > pending) emit(html.slice(pending, lt));
    // 이름을 먼저 읽는다(글자 단위, 최대 11자) — 그 뒤부터 태그 끝을 찾는다.
    let j = nameStart;
    while (j < n && j - nameStart <= 10 && isTagNameChar(html.charCodeAt(j))) j++;
    st.steps += j - nameStart + 1;
    let gt: number;
    if (markup) {
      gt = html.indexOf('>', nameStart);
      st.steps += (gt < 0 ? n : gt) - nameStart + 1;
    } else {
      gt = findTagEnd(html, j, st);
    }
    if (gt < 0) {
      pending = n; // '>' 없는 태그 시작(또는 닫히지 않은 따옴표 값): 나머지는 태그(버림) — 끝까지 훑었으므로 다시 훑을 일이 없다
      break;
    }
    pending = i = gt + 1;
    if (markup) continue;
    if (j - nameStart > 10) continue; // 아는 이름(최대 8자)보다 긴 이름 — 지우기만
    const name = html.slice(nameStart, j).toLowerCase();
    if (closing) {
      if (name === 'h1') h1Open = false;
      if (HTML_BLOCK_TAGS.has(name)) out.push('\n');
      continue;
    }
    if (name === 'br') {
      out.push('\n');
      continue;
    }
    if (name === 'h1' && h1 === null) {
      h1 = [];
      h1Open = true;
      continue;
    }
    // FIX-T18 round 2(P2 :366): 끝의 '/' 와 상관없이 raw text 요소 — 짝 닫는 태그까지(없으면 끝까지) 버린다.
    if (HTML_RAW_TEXT_TAGS.has(name)) {
      const end = findClosingTag(html, name, i, st);
      if (end < 0) {
        pending = n; // 닫히지 않은 script 등: 나머지는 그 요소의 내용(버림)
        break;
      }
      if (name === 'title' && titleRaw === null) titleRaw = html.slice(i, Math.min(end, i + 1000));
      out.push(' ');
      const gt2 = findTagEnd(html, end + 2 + name.length, st);
      pending = i = gt2 < 0 ? n : gt2 + 1;
      continue;
    }
  }
  if (stats) stats.steps += st.steps;
  if (pending < n) emit(html.slice(pending));
  const oneLine = (s: string) => decodeEntities(s).replace(/\s+/g, ' ').trim();
  const text = decodeEntities(out.join(''))
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v\r]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const title = (h1 && oneLine(h1.join(''))) || (titleRaw !== null && oneLine(titleRaw)) || null;
  return { text, title: title || null };
}

const CREATED_RE = /^(?:Created(?: time)?|Date Created|생성 일시|생성일|만든 날짜|작성일)\s*:\s*(.{1,100})$/im;

/** 텍스트 파일 하나를 항목으로 해석한다(경로·바이트 → 제목·본문·checksum). */
export function parseImportFile(kind: ImportFileKind, innerPath: string, displayPath: string, bytes: Uint8Array): ParsedImportItem {
  const { folder, stem } = splitPath(displayPath);
  const format = formatOfPath(innerPath);
  const base: ParsedImportItem = {
    externalId: externalIdFor(kind, innerPath),
    externalPath: displayPath,
    folder,
    title: truncate(cleanSegment(stem), MAX_TITLE) || null,
    format,
    contentChecksum: sha256Bytes(bytes),
    byteSize: bytes.byteLength,
    externalCreatedText: null,
    body: null,
    original: null,
    skipReason: null,
  };
  if (bytes.byteLength > IMPORT_MAX_TEXT_ENTRY_BYTES) return { ...base, contentChecksum: null, skipReason: 'too_large' };
  let original: string;
  try {
    // ignoreBOM: BOM 도 원본의 일부로 남긴다(다시 인코딩하면 원본 바이트와 같다).
    original = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ...base, skipReason: 'not_utf8' };
  }
  if (original.includes('\0')) return { ...base, skipReason: 'not_utf8' };
  const text = original.charCodeAt(0) === 0xfeff ? original.slice(1) : original;
  let body = text;
  let title = base.title;
  if (format === 'html') {
    const h = htmlToText(text);
    body = h.text;
    if (h.title) title = truncate(h.title, MAX_TITLE);
  } else if (format === 'md') {
    const m = /^\s{0,3}#\s+(.+?)\s*#*\s*$/m.exec(text.slice(0, 4000));
    if (m && text.slice(0, m.index).trim() === '') title = truncate(m[1]!.trim(), MAX_TITLE);
  }
  const created = CREATED_RE.exec(text.slice(0, 4000));
  const out: ParsedImportItem = { ...base, title, body, original, externalCreatedText: created ? created[1]!.trim() : null };
  if (body.trim() === '') return { ...out, body: null, original: null, skipReason: 'empty' };
  if (body.length > MAX_RAW_TEXT) return { ...out, body: null, original: null, skipReason: 'too_long' };
  return out;
}

/** 원본 문자열(original)을 UTF-8 로 되돌린 바이트 — 가져온 원본 파일과 바이트 단위로 같다. */
export const originalBytes = (original: string): Uint8Array => new TextEncoder().encode(original);

/**
 * 내보내기 ZIP 을 읽어 항목 목록을 만든다(미리보기·확정 공용 — 같은 바이트면 같은 결과).
 * 안쪽 `.zip` 은 한 겹까지 풀어 그 안의 파일을 같은 규칙으로 읽는다(경로는 `<안쪽 ZIP>!/<경로>` 로 표시, 외부 ID 는 안쪽 경로 기준).
 */
export function parseImportArchive(kind: ImportFileKind, zip: Uint8Array): ParsedImportArchive {
  if (zip.byteLength > IMPORT_MAX_ZIP_BYTES) throw new ImportTooLargeError();
  const items: ParsedImportItem[] = [];
  const seenIds = new Set<string>();
  let attachments = 0;
  // FIX-T18 round 1(Codex review-T18 P0 :328): 바깥·안쪽 ZIP 이 함께 쓰는 하나의 예산. 풀기 전에 선언 크기로 검사한다.
  // FIX-T18 round 2(Codex review-FIX-T18 P0 :499): 푸는 압축 입력 바이트(compressed)도 센다. 한 ZIP 안 구간은 서로 겹치지 않으므로(listZip)
  // 압축 입력 합 ≤ 바깥 파일 + 풀린 중첩 ZIP 합 — 이 상한은 그 관계가 깨지는 회귀를 막는 방어선이다.
  const budget = { records: 0, inflated: 0, compressed: 0, text: 0, nested: 0 };
  const spend = (compressed: number, bytes: number) => {
    budget.compressed += compressed;
    if (budget.compressed > IMPORT_MAX_TOTAL_COMPRESSED_BYTES) throw new ImportTooLargeError('푸는 압축 데이터가 너무 큽니다');
    budget.inflated += bytes;
    if (budget.inflated > IMPORT_MAX_TOTAL_INFLATED_BYTES) throw new ImportTooLargeError('풀린 내용이 너무 큽니다(중첩 ZIP 포함 최대 128MB)');
  };

  const walk = (bytes: Uint8Array, prefix: string, depth: number) => {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const { entries: list, records } = listZip(buf);
    // 디렉터리를 포함한 모든 중앙 목록 레코드를 전역으로 센다(중첩 ZIP 안 레코드 포함).
    budget.records += records;
    if (budget.records > IMPORT_MAX_ENTRIES) throw new ImportInvalidError(`ZIP 항목이 너무 많습니다(중첩 포함 최대 ${IMPORT_MAX_ENTRIES}개)`);
    for (const e of list) {
      const display = prefix ? `${prefix}!/${e.path}` : e.path;
      const { ext, folder, stem } = splitPath(display);
      if (ext === 'zip' && depth < IMPORT_MAX_NESTED_DEPTH) {
        if (e.size > MAX_NESTED_ZIP_BYTES) throw new ImportTooLargeError('안쪽 ZIP 이 너무 큽니다');
        budget.nested += 1;
        if (budget.nested > IMPORT_MAX_NESTED_ARCHIVES) throw new ImportInvalidError(`안쪽 ZIP 이 너무 많습니다(최대 ${IMPORT_MAX_NESTED_ARCHIVES}개)`);
        spend(e.compSize, e.size);
        walk(extract(buf, e), display, depth + 1);
        continue;
      }
      const format = formatOfPath(e.path);
      const skipped = (reason: ImportSkipReason, checksum: string | null = null): ParsedImportItem => ({
        externalId: externalIdFor(kind, e.path),
        externalPath: display,
        folder,
        title: truncate(cleanSegment(stem), MAX_TITLE) || null,
        format,
        contentChecksum: checksum,
        byteSize: e.size,
        externalCreatedText: null,
        body: null,
        original: null,
        skipReason: reason,
      });
      // FIX-T18 round 1(P2 :339): ZIP 크기 필드는 unsigned 32bit — 원장(bigint)에 넣기 전에 범위를 확인한다.
      if (!Number.isSafeInteger(e.size) || e.size < 0 || e.size > IMPORT_MAX_DECLARED_BYTES) throw new ZipFormatError('ZIP 항목 크기가 올바르지 않습니다');
      let item: ParsedImportItem;
      if (format === 'other') {
        attachments++;
        item = skipped('unsupported_type');
      } else if (e.size > IMPORT_MAX_TEXT_ENTRY_BYTES) {
        item = skipped('too_large');
      } else {
        budget.text += e.size;
        if (budget.text > IMPORT_MAX_TOTAL_TEXT_BYTES) throw new ImportTooLargeError('풀린 텍스트가 너무 큽니다(최대 64MB)');
        spend(e.compSize, e.size);
        item = parseImportFile(kind, e.path, display, extract(buf, e));
      }
      if (seenIds.has(item.externalId)) {
        item = { ...item, externalId: `${item.externalId}#${items.length}`, body: null, original: null, skipReason: 'duplicate_in_archive' };
      }
      seenIds.add(item.externalId);
      items.push(item);
    }
  };
  walk(zip, '', 0);
  const importable = items.filter((i) => i.skipReason === null).length;
  if (importable > IMPORT_MAX_ITEMS) throw new ImportInvalidError(`가져올 수 있는 항목이 너무 많습니다(최대 ${IMPORT_MAX_ITEMS}개). 폴더를 나눠 내보내세요.`);
  return { fileChecksum: sha256Bytes(zip), fileBytes: zip.byteLength, items, attachments };
}

/** 파일 이름·내용으로 Notion 내보내기인지 추정(사용자가 고르지 않았을 때). 페이지 ID 가 붙은 파일이 하나라도 있으면 Notion. */
export function guessImportKind(fileName: string | null, items: readonly ParsedImportItem[]): ImportFileKind {
  if (items.some((i) => i.externalId.startsWith('notion:'))) return 'notion_export';
  if (fileName && /notion/i.test(fileName)) return 'notion_export';
  return 'drive_export';
}

// ---- 판정 ----

export interface ExistingImportSource {
  sourceId: string;
  /** 그 출처의 모든 버전 raw_hash(원본 checksum) */
  versionChecksums: ReadonlySet<string>;
}

/**
 * 미리보기 판정. 건너뛴 항목 → skipped. 같은 (공급자, 외부 ID) 출처가 없으면 new.
 * 있으면 어떤 버전의 checksum 과 같으면 identical(다시 가져오지 않음), 아니면 conflict(덮어쓰지 않음 — 사용자가 고를 때만 새 버전).
 */
export function decideImportItem(item: Pick<ParsedImportItem, 'skipReason' | 'contentChecksum'>, existing: ExistingImportSource | undefined): ImportDecision {
  if (item.skipReason !== null || item.contentChecksum === null) return 'skipped';
  if (!existing) return 'new';
  return existing.versionChecksums.has(item.contentChecksum) ? 'identical' : 'conflict';
}

export const IMPORT_KIND_LABEL: Record<ImportSourceKind, string> = {
  notion_export: 'Notion 내보내기',
  drive_export: 'Drive 내보내기',
  mock_connector: '모의 커넥터',
};

export const IMPORT_DECISION_LABEL: Record<ImportDecision, string> = {
  new: '새 항목',
  identical: '이미 가져옴(동일)',
  conflict: '충돌(내용 다름)',
  skipped: '건너뜀',
};

export const IMPORT_SKIP_LABEL: Record<ImportSkipReason, string> = {
  unsupported_type: '지원하지 않는 파일(첨부·이미지 — 목록만)',
  too_large: '파일이 너무 큼(2MB 초과)',
  too_long: `본문이 너무 김(${MAX_RAW_TEXT.toLocaleString('en-US')}자 초과)`,
  not_utf8: 'UTF-8 텍스트가 아님',
  empty: '본문 없음',
  duplicate_in_archive: 'ZIP 안 중복 항목',
};

export const IMPORT_OUTCOMES = [
  'imported',
  'versioned',
  'skipped_identical',
  'skipped_unselected',
  'skipped_conflict',
  'skipped_unsupported',
  'failed_changed',
  // FIX-T18 round 2(Codex review-FIX-T18 P1): 동일 항목의 빠진 원본 바이트만 기존 출처 버전에 채움(소재·출처·버전 그대로).
  'original_backfilled',
] as const;
export type ImportOutcome = (typeof IMPORT_OUTCOMES)[number];

export const IMPORT_OUTCOME_LABEL: Record<ImportOutcome, string> = {
  imported: '가져옴(새 소재)',
  versioned: '새 버전으로 추가(기존 소재 그대로)',
  skipped_identical: '동일 — 건너뜀',
  skipped_unselected: '선택 안 함',
  skipped_conflict: '충돌 — 덮어쓰지 않고 건너뜀',
  skipped_unsupported: '지원 안 함 — 건너뜀',
  failed_changed: '미리보기 뒤 내용이 바뀜 — 건너뜀',
  original_backfilled: '원본 보충(빠진 원본 파일만 채움, 소재 그대로)',
};

/** 확정 선택: item_ids(가져올 항목) ∪ folders(그 폴더·하위 폴더의 new 항목). 충돌은 version_ids 에 있을 때만 새 버전. */
export interface ImportSelection {
  itemIds: ReadonlySet<string>;
  folders: readonly string[];
  versionIds: ReadonlySet<string>;
  /**
   * FIX-T18 round 2(Codex review-FIX-T18 P1): "원본 보충" 을 고른 동일(identical) 항목 — 기존 출처 버전에 원본 행이 없을 때(0039 이전 가져오기)만
   * 올린 바이트(sha256 = raw_hash)를 채운다. 새 항목·폴더 선택과 별개의 명시 선택이다(선택 규칙을 넓히지 않음).
   */
  backfillIds?: ReadonlySet<string>;
}

export function inSelectedFolder(folder: string, folders: readonly string[]): boolean {
  return folders.some((f) => f === '' || folder === f || folder.startsWith(`${f}/`));
}

/**
 * 원장 항목이 이 선택으로 실제로 쓰기를 일으키는지(미리보기 판정 기준). new 는 item_ids·폴더, conflict 는 version_ids 에 있을 때만,
 * identical 은 backfill_ids 에 있을 때만 'backfill'(원본이 실제로 빠졌는지는 DB 경계가 다시 확인한다).
 */
export function effectiveImportChoice(
  item: { id: string; decision: string; folder: string },
  selection: ImportSelection,
): 'import' | 'version' | 'backfill' | null {
  if (item.decision === 'new') return selection.itemIds.has(item.id) || inSelectedFolder(item.folder, selection.folders) ? 'import' : null;
  if (item.decision === 'conflict') return selection.versionIds.has(item.id) ? 'version' : null;
  if (item.decision === 'identical') return selection.backfillIds?.has(item.id) ? 'backfill' : null;
  return null;
}
