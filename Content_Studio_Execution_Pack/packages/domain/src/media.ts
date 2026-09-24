/**
 * 파일(asset) 규칙(T02) — 순수 함수. docs/01 §1 "확장자뿐 아니라 MIME·파일 내용 확인".
 * 형식은 확장자·브라우저가 보낸 Content-Type 이 아니라 파일 앞부분 바이트(magic bytes)로 판정한다.
 * 확장자가 있으면 판정 결과와 일치해야 한다(예: `.png` 인데 내용이 텍스트 → 거부).
 */
import { z } from 'zod';
import { InvalidStorageKeyError, UnsupportedMediaTypeError } from './errors';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/plain'] as const;
export type AllowedMime = (typeof ALLOWED_MIME)[number];

/** 저작권·사용권 상태. 기본 unknown(확인 전). */
export const rightsStatusSchema = z.enum(['unknown', 'owned', 'licensed', 'public_domain']);
export type RightsStatus = z.infer<typeof rightsStatusSchema>;

const EXT_TO_MIME: Record<string, AllowedMime> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/plain', // text/markdown 은 text/plain 으로 취급
  markdown: 'text/plain',
};

const MIME_TO_EXT: Record<AllowedMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

export function extensionForMime(mime: string): string {
  return MIME_TO_EXT[mime as AllowedMime] ?? 'bin';
}

/** 다운로드 응답용 Content-Type. 텍스트는 charset 명시. */
export function contentTypeForMime(mime: string): string {
  if (mime === 'text/plain') return 'text/plain; charset=utf-8';
  return (ALLOWED_MIME as readonly string[]).includes(mime) ? mime : 'application/octet-stream';
}

function startsWith(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
  return true;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

/** 텍스트로 인정하는 제어 문자: TAB, LF, FF, CR. 그 밖의 C0 제어 문자(NUL 포함)·DEL 이 있으면 텍스트가 아니다. */
function hasBinaryControl(bytes: Uint8Array): boolean {
  for (const b of bytes) {
    if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d) || b === 0x7f) return true;
  }
  return false;
}

function isUtf8Text(bytes: Uint8Array): boolean {
  if (hasBinaryControl(bytes)) return false;
  try {
    utf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** 내용으로 형식을 판정한다. 허용 목록 밖이면 null. 빈 파일은 null. */
export function sniffMime(bytes: Uint8Array): AllowedMime | null {
  if (bytes.length === 0) return null;
  if (startsWith(bytes, PNG)) return 'image/png';
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return 'image/webp';
  if (startsWith(bytes, PDF)) return 'application/pdf';
  if (isUtf8Text(bytes)) return 'text/plain';
  return null;
}

/** 파일 이름의 확장자(소문자). 없으면 null. */
export function fileExtension(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const base = filename.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

/**
 * 업로드 파일의 형식을 확정한다. 내용 판정이 실패하거나, 확장자가 허용 목록 밖이거나,
 * 확장자가 가리키는 형식과 내용이 다르면 UnsupportedMediaTypeError.
 */
export function resolveUploadMime(bytes: Uint8Array, filename?: string | null): AllowedMime {
  const sniffed = sniffMime(bytes);
  if (!sniffed) throw new UnsupportedMediaTypeError();
  const ext = fileExtension(filename);
  if (ext !== null) {
    const expected = EXT_TO_MIME[ext];
    if (!expected) throw new UnsupportedMediaTypeError();
    if (expected !== sniffed) {
      throw new UnsupportedMediaTypeError('파일 확장자와 실제 내용이 일치하지 않습니다. 파일 형식을 확인하세요.');
    }
  }
  return sniffed;
}

// ---- 저장 키 ----

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** `assets/<ownerId>/<uuid>` — 소문자 UUID 두 개만 허용. `..`·절대경로·역슬래시·기타 문자는 모두 불일치. */
export const STORAGE_KEY_RE = new RegExp(`^assets/${UUID}/${UUID}$`);
const UUID_RE = new RegExp(`^${UUID}$`);

export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

export function isValidStorageKey(key: string): boolean {
  return typeof key === 'string' && STORAGE_KEY_RE.test(key);
}

export function assertValidStorageKey(key: string): void {
  if (!isValidStorageKey(key)) throw new InvalidStorageKeyError();
}

export function buildAssetKey(ownerId: string, assetId: string): string {
  const key = `assets/${ownerId.toLowerCase()}/${assetId.toLowerCase()}`;
  assertValidStorageKey(key);
  return key;
}
