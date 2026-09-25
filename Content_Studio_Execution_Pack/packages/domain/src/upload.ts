/**
 * T08 업로드 세션(결정 D9·D15) — 순수 함수. DB·파일 시스템 없음.
 *
 * - 음성·영상 파일은 조각(chunk)으로 나눠 올린다: 같은 세션으로 끊긴 곳부터 다시 올릴 수 있다(A14).
 * - 조각 크기는 4–8MiB(기본 8MiB). 마지막 조각만 짧을 수 있고, 나머지는 정확히 chunk_size 여야 한다.
 * - 한도: 음성 200MiB, 영상 2GiB. 세션은 24시간 뒤 만료(worker 가 조각 파일을 지운다).
 * - 완료 시 서버가 조각을 차례로 이어 붙이며(메모리에 전체를 올리지 않음) 크기·앞부분 서명(magic bytes)·sha256 을 확인한다.
 *   VERIFIED 의 범위는 "형식 서명·크기·checksum" 이며 디코딩(재생 가능 여부)은 확인하지 않는다(assets.verification_scope).
 */
import { z } from 'zod';
import { BadRequestError, PayloadTooLargeError, UnsupportedMediaTypeError } from './errors';

export const MIB = 1024 * 1024;
export const MIN_CHUNK_BYTES = 4 * MIB;
export const MAX_CHUNK_BYTES = 8 * MIB;
export const DEFAULT_CHUNK_BYTES = 8 * MIB;
export const MAX_MEDIA_BYTES = { audio: 200 * MIB, video: 2048 * MIB } as const;
export const UPLOAD_SESSION_TTL_MS = 24 * 3600_000;
/** 완료 시 서명 판정에 쓰는 앞부분 바이트 수 */
export const SNIFF_HEAD_BYTES = 64;
/** assets.verification_scope 기본값 — VERIFIED 가 실제로 확인한 범위 */
export const VERIFICATION_SCOPE = 'signature_size_checksum' as const;

export const ALLOWED_MEDIA_MIME = [
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/webm',
  'video/mp4',
  'video/webm',
  'video/quicktime',
] as const;
export type MediaMime = (typeof ALLOWED_MEDIA_MIME)[number];
export type MediaKind = keyof typeof MAX_MEDIA_BYTES;

export const MEDIA_EXT: Record<MediaMime, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/webm': 'weba',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

export const isMediaMime = (m: string): m is MediaMime => (ALLOWED_MEDIA_MIME as readonly string[]).includes(m);
export const mediaKindOf = (m: string): MediaKind | null => (m.startsWith('audio/') ? 'audio' : m.startsWith('video/') ? 'video' : null);
/** 전사할 수 있는 파일인가(음성·영상 형식) */
export const isTranscribableMime = (m: string) => isMediaMime(m);

export const UPLOAD_STATES = ['open', 'completed', 'verified', 'rejected', 'aborted', 'expired'] as const;
export type UploadState = (typeof UPLOAD_STATES)[number];

export class UnsupportedMediaError extends UnsupportedMediaTypeError {
  constructor(message = '지원하지 않는 음성·영상 형식입니다. MP3·M4A(MP4 음성)·WAV·WebM 음성, MP4·WebM·MOV 영상만 올릴 수 있습니다.') {
    super(message);
  }
}

// ---- 조각 계획 ----

export function chunkCount(bytes: number, chunkSize: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || !Number.isSafeInteger(chunkSize) || chunkSize < 1) return 0;
  return Math.ceil(bytes / chunkSize);
}

/** index 번째 조각의 정확한 크기. 범위 밖이면 null. */
export function expectedChunkBytes(bytes: number, chunkSize: number, index: number): number | null {
  const n = chunkCount(bytes, chunkSize);
  if (!Number.isSafeInteger(index) || index < 0 || index >= n) return null;
  return index < n - 1 ? chunkSize : bytes - chunkSize * (n - 1);
}

/** 받은 조각 번호 목록 → 처음 빠진 번호(모두 있으면 null)와 빠진 번호들(최대 limit 개) */
export function missingChunks(total: number, received: Iterable<number>, limit = 20): { next: number | null; missing: number[] } {
  const have = new Set(received);
  const missing: number[] = [];
  let next: number | null = null;
  for (let i = 0; i < total; i++) {
    if (have.has(i)) continue;
    if (next === null) next = i;
    if (missing.length < limit) missing.push(i);
  }
  return { next, missing };
}

/** 진행률(0–100, 내림) */
export function uploadProgress(received: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.floor((received * 100) / total));
}

// ---- 세션 생성 입력 ----

export const uploadSessionCreateSchema = z
  .object({
    kind: z.enum(['audio', 'video']),
    mime: z.string().min(1).max(100),
    bytes: z.int().min(1),
    sha256: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/)
      .optional(),
    chunk_size: z.int().optional(),
  })
  .strict();
export type UploadSessionCreateInput = z.infer<typeof uploadSessionCreateSchema>;

export interface UploadPlan {
  kind: MediaKind;
  mime: MediaMime;
  bytes: number;
  chunkSize: number;
  chunks: number;
  sha256: string | null;
}

/** 입력 → 조각 계획. 형식 415, 크기 413, 조각 크기·종류 불일치 400. */
export function planUpload(input: UploadSessionCreateInput): UploadPlan {
  const mime = input.mime.trim().toLowerCase();
  if (!isMediaMime(mime)) throw new UnsupportedMediaError();
  if (mediaKindOf(mime) !== input.kind) throw new BadRequestError('kind 와 mime 이 맞지 않습니다(audio 는 audio/*, video 는 video/*)');
  const max = MAX_MEDIA_BYTES[input.kind];
  if (input.bytes > max) {
    throw new PayloadTooLargeError(input.kind === 'audio' ? '음성 파일은 최대 200MB 까지 올릴 수 있습니다.' : '영상 파일은 최대 2GB 까지 올릴 수 있습니다.');
  }
  const chunkSize = input.chunk_size ?? DEFAULT_CHUNK_BYTES;
  if (chunkSize < MIN_CHUNK_BYTES || chunkSize > MAX_CHUNK_BYTES) throw new BadRequestError('chunk_size 는 4MiB 이상 8MiB 이하여야 합니다');
  return {
    kind: input.kind,
    mime,
    bytes: input.bytes,
    chunkSize,
    chunks: chunkCount(input.bytes, chunkSize),
    sha256: input.sha256 ? input.sha256.toLowerCase() : null,
  };
}

// ---- 형식 서명(magic bytes) ----

export type MediaFamily = 'mp3' | 'mp4' | 'm4a' | 'mov' | 'wav' | 'webm';

const ascii = (b: Uint8Array, from: number, len: number) =>
  b.length >= from + len ? String.fromCharCode(...b.subarray(from, from + len)) : '';

function indexOfBytes(hay: Uint8Array, needle: readonly number[], from = 0, to = hay.length): number {
  outer: for (let i = from; i <= Math.min(to, hay.length) - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** MPEG 오디오 프레임 머리(동기 11비트, layer ≠ reserved, version ≠ reserved, bitrate ≠ bad) */
function isMpegFrameHeader(b: Uint8Array): boolean {
  if (b.length < 4 || b[0] !== 0xff || (b[1]! & 0xe0) !== 0xe0) return false;
  const version = (b[1]! >> 3) & 0x03;
  const layer = (b[1]! >> 1) & 0x03;
  const bitrate = (b[2]! >> 4) & 0x0f;
  const rate = (b[2]! >> 2) & 0x03;
  return version !== 0x01 && layer !== 0x00 && bitrate !== 0x0f && rate !== 0x03;
}

const WEBM_DOCTYPE = [0x42, 0x82]; // EBML DocType element ID

/**
 * 파일 앞부분으로 음성·영상 계열을 판정한다. 허용 목록 밖(이미지·PDF·텍스트·matroska 등)이면 null.
 * 서명만 본다 — 뒤쪽 내용이 올바른 미디어인지(디코딩)는 확인하지 않는다(D15).
 */
export function sniffMedia(head: Uint8Array): MediaFamily | null {
  if (head.length < 12) return null;
  if (ascii(head, 0, 3) === 'ID3' && head[3]! >= 2 && head[3]! <= 4) return 'mp3';
  if (isMpegFrameHeader(head)) return 'mp3';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WAVE') return 'wav';
  if (ascii(head, 4, 4) === 'ftyp') {
    const size = ((head[0]! << 24) | (head[1]! << 16) | (head[2]! << 8) | head[3]!) >>> 0;
    if (size < 8) return null;
    const brand = ascii(head, 8, 4);
    if (brand === 'qt  ') return 'mov';
    if (brand === 'M4A ' || brand === 'M4B ') return 'm4a';
    if (/^[\x20-\x7e]{4}$/.test(brand)) return 'mp4';
    return null;
  }
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    const at = indexOfBytes(head, WEBM_DOCTYPE, 4, SNIFF_HEAD_BYTES);
    if (at < 0) return null;
    const len = head[at + 2]! & 0x7f; // 1바이트 크기(0x80 | n)
    return (head[at + 2]! & 0x80) !== 0 && ascii(head, at + 3, len) === 'webm' ? 'webm' : null;
  }
  return null;
}

const FAMILY_MIMES: Record<MediaFamily, readonly MediaMime[]> = {
  mp3: ['audio/mpeg'],
  wav: ['audio/wav'],
  m4a: ['audio/mp4'],
  mp4: ['audio/mp4', 'video/mp4'],
  mov: ['video/quicktime'],
  webm: ['audio/webm', 'video/webm'],
};

/** 신고한 형식이 파일 서명과 맞는가 */
export function mediaMatches(declared: MediaMime, family: MediaFamily | null): boolean {
  return family !== null && FAMILY_MIMES[family].includes(declared);
}
