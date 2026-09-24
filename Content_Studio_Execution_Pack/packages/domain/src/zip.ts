/**
 * 최소 ZIP(store-only, method 0) 작성·읽기(T05, 결정 D6). 새 의존성 없이 Node `zlib.crc32` 만 쓴다.
 *
 * - 작성: 파일마다 local header + 바이트, 끝에 central directory + EOCD. 압축·암호화·ZIP64 없음.
 *   전체 2 GiB(0x7fffffff) 이상이면 ZipTooLargeError. 이름은 UTF-8(general purpose flag bit 11).
 * - 읽기: EOCD → central directory → 각 local header 를 따라가 바이트를 꺼내고 CRC-32 를 검사한다.
 *   `..`·절대 경로·역슬래시·드라이브 문자·빈 조각·중복 이름·압축(method≠0)·암호화·ZIP64 는 거부한다.
 *   디렉터리 항목(이름이 `/` 로 끝나고 크기 0)은 건너뛴다(다른 도구로 다시 묶은 경우 대비).
 */
import { crc32 } from 'node:zlib';
import { AppError } from './errors';

export interface ZipEntry {
  path: string;
  bytes: Uint8Array;
}

/** ZIP 형식 오류 — 400 invalid_zip. message 는 사용자에게 보여도 되는 고정 문구. */
export class ZipFormatError extends AppError {
  constructor(message: string, extra?: Record<string, unknown>) {
    super('bad_request', 'invalid_zip', message, extra);
  }
}

export class ZipTooLargeError extends AppError {
  constructor() {
    super('payload_too_large', 'zip_too_large', '내보내기 파일이 2 GiB 를 넘어 만들 수 없습니다');
  }
}

export const ZIP_MAX_BYTES = 0x7fffffff;
const MAX_ENTRIES = 65_535;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800;

/** ZIP 안 경로 규칙: 슬래시 구분 상대 경로, 각 조각은 비어 있지 않고 `.`/`..` 가 아님. */
export function isSafeZipPath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > 512) return false;
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0') || /^[A-Za-z]:/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getUTCFullYear(), 1980), 2107);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/** store-only ZIP 을 만든다. 경로가 안전하지 않거나 중복이면 ZipFormatError. */
export function writeZip(entries: readonly ZipEntry[], modified: Date = new Date(0)): Buffer {
  if (entries.length > MAX_ENTRIES) throw new ZipFormatError('ZIP 항목이 너무 많습니다');
  const { time, date } = dosDateTime(modified.getTime() === 0 ? new Date(Date.UTC(1980, 0, 1)) : modified);
  const seen = new Set<string>();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    if (!isSafeZipPath(e.path)) throw new ZipFormatError('ZIP 경로가 올바르지 않습니다', { paths: [e.path] });
    if (seen.has(e.path)) throw new ZipFormatError('ZIP 안에 같은 이름의 파일이 있습니다', { paths: [e.path] });
    seen.add(e.path);
    const name = Buffer.from(e.path, 'utf8');
    const size = e.bytes.byteLength;
    const crc = crc32(e.bytes) >>> 0;
    if (offset + 30 + name.length + size > ZIP_MAX_BYTES) throw new ZipTooLargeError();

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(SIG_LOCAL, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(FLAG_UTF8, 6);
    lh.writeUInt16LE(0, 8); // method: store
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(size, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, Buffer.from(e.bytes.buffer, e.bytes.byteOffset, e.bytes.byteLength));

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(SIG_CENTRAL, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(FLAG_UTF8, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(size, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); // extra
    ch.writeUInt16LE(0, 32); // comment
    ch.writeUInt16LE(0, 34); // disk
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + size;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  if (offset + cdSize + 22 > ZIP_MAX_BYTES) throw new ZipTooLargeError();
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * ZIP 을 읽어 항목 목록을 돌려준다(입력 순서). 형식 위반·CRC 불일치·위험한 경로·중복 이름이면 ZipFormatError.
 * 반환 바이트는 입력 버퍼를 복사한 것이다.
 */
export function readZip(input: Uint8Array): ZipEntry[] {
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
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

  const out: ZipEntry[] = [];
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
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipFormatError('ZIP64 는 지원하지 않습니다');
    }
    if (name.endsWith('/') && size === 0) {
      // 디렉터리 항목 — 경로만 검사하고 건너뛴다.
      if (!isSafeZipPath(name.slice(0, -1))) throw new ZipFormatError('허용되지 않는 ZIP 경로가 있습니다', { paths: [name] });
      continue;
    }
    if (!isSafeZipPath(name)) throw new ZipFormatError('허용되지 않는 ZIP 경로가 있습니다', { paths: [name] });
    if (seen.has(name)) throw new ZipFormatError('ZIP 안에 같은 이름의 파일이 있습니다', { paths: [name] });
    seen.add(name);
    if (method !== 0 || compSize !== size) {
      throw new ZipFormatError('압축된 ZIP 항목은 지원하지 않습니다(이 앱이 만든 내보내기 파일만 복원할 수 있습니다)', { paths: [name] });
    }

    if (localOffset + 30 > cdOffset || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new ZipFormatError('ZIP 항목 헤더가 손상되었습니다', { paths: [name] });
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const end = start + size;
    if (end > cdOffset) throw new ZipFormatError('ZIP 항목 크기가 올바르지 않습니다', { paths: [name] });
    const localName = buf.subarray(localOffset + 30, localOffset + 30 + lNameLen).toString('utf8');
    if (localName !== name) throw new ZipFormatError('ZIP 항목 이름이 목록과 다릅니다', { paths: [name] });
    const bytes = new Uint8Array(buf.subarray(start, end)); // 복사
    if (crc32(bytes) >>> 0 !== crc) throw new ZipFormatError('ZIP 항목의 CRC 가 일치하지 않습니다(파일 손상)', { paths: [name] });
    out.push({ path: name, bytes });
  }
  return out;
}
