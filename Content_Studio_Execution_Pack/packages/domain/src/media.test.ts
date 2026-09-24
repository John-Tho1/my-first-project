import { describe, expect, it } from 'vitest';
import { InvalidStorageKeyError, UnsupportedMediaTypeError } from './errors';
import {
  assertValidStorageKey,
  buildAssetKey,
  contentTypeForMime,
  extensionForMime,
  fileExtension,
  isValidStorageKey,
  resolveUploadMime,
  sniffMime,
} from './media';

const bytes = (...xs: number[]) => new Uint8Array(xs);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 16);
const WEBP = new Uint8Array([...Buffer.from('RIFF'), 1, 2, 3, 4, ...Buffer.from('WEBPVP8 ')]);
const PDF = new Uint8Array(Buffer.from('%PDF-1.7\n%âãÏÓ\n', 'latin1'));
const TEXT = new Uint8Array(Buffer.from('# 제목\n해외 영업 메모\n', 'utf8'));

describe('sniffMime (magic bytes)', () => {
  it('허용 형식 판정', () => {
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(JPEG)).toBe('image/jpeg');
    expect(sniffMime(WEBP)).toBe('image/webp');
    expect(sniffMime(PDF)).toBe('application/pdf');
    expect(sniffMime(TEXT)).toBe('text/plain');
  });
  it('거부: 빈 파일, NUL 포함, 잘못된 UTF-8, RIFF 이지만 WEBP 아님, 실행 파일', () => {
    expect(sniffMime(new Uint8Array())).toBeNull();
    expect(sniffMime(bytes(0x68, 0x69, 0x00, 0x21))).toBeNull();
    expect(sniffMime(bytes(0xc3, 0x28))).toBeNull();
    expect(sniffMime(new Uint8Array([...Buffer.from('RIFF'), 1, 2, 3, 4, ...Buffer.from('WAVE')]))).toBeNull();
    expect(sniffMime(bytes(0x4d, 0x5a, 0x90, 0x00))).toBeNull(); // MZ (exe)
    expect(sniffMime(bytes(0x7f, 0x45, 0x4c, 0x46, 0x02))).toBeNull(); // ELF
  });
  it('짧은 조각은 서명으로 오인하지 않는다', () => {
    expect(sniffMime(bytes(0x89, 0x50))).toBeNull(); // 0x89 는 UTF-8 로도 무효
    expect(sniffMime(new Uint8Array(Buffer.from('RIFF')))).toBe('text/plain');
  });
});

describe('resolveUploadMime (확장자 ↔ 내용 일치)', () => {
  it('일치하면 통과, 확장자 없으면 내용만으로', () => {
    expect(resolveUploadMime(PNG, 'a.png')).toBe('image/png');
    expect(resolveUploadMime(JPEG, 'A.JPEG')).toBe('image/jpeg');
    expect(resolveUploadMime(TEXT, 'note.md')).toBe('text/plain');
    expect(resolveUploadMime(TEXT, 'note.markdown')).toBe('text/plain');
    expect(resolveUploadMime(PDF, null)).toBe('application/pdf');
    expect(resolveUploadMime(PNG, 'noext')).toBe('image/png');
  });
  it('.png 인데 텍스트 → 415', () => {
    expect(() => resolveUploadMime(TEXT, 'fake.png')).toThrow(UnsupportedMediaTypeError);
    expect(() => resolveUploadMime(TEXT, 'fake.png')).toThrow(/확장자와 실제 내용/);
  });
  it('.txt 인데 PNG, 허용 목록 밖 확장자, 판정 불가 → 415', () => {
    expect(() => resolveUploadMime(PNG, 'a.txt')).toThrow(UnsupportedMediaTypeError);
    expect(() => resolveUploadMime(TEXT, 'script.html')).toThrow(UnsupportedMediaTypeError);
    expect(() => resolveUploadMime(TEXT, 'image.svg')).toThrow(UnsupportedMediaTypeError);
    expect(() => resolveUploadMime(bytes(0, 1, 2), 'x.bin')).toThrow(UnsupportedMediaTypeError);
  });
  it('fileExtension', () => {
    expect(fileExtension('a.b.PNG')).toBe('png');
    expect(fileExtension('.hidden')).toBeNull();
    expect(fileExtension('dir\\x.pdf')).toBe('pdf');
    expect(fileExtension('trail.')).toBeNull();
  });
  it('다운로드 Content-Type·확장자', () => {
    expect(contentTypeForMime('text/plain')).toBe('text/plain; charset=utf-8');
    expect(contentTypeForMime('image/png')).toBe('image/png');
    expect(contentTypeForMime('text/html')).toBe('application/octet-stream');
    expect(extensionForMime('image/jpeg')).toBe('jpg');
    expect(extensionForMime('x/unknown')).toBe('bin');
  });
});

describe('저장 키 검증 (경로 조작 차단)', () => {
  const owner = '11111111-2222-4333-8444-555555555555';
  const asset = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  it('assets/<uuid>/<uuid> 만 허용', () => {
    expect(isValidStorageKey(`assets/${owner}/${asset}`)).toBe(true);
    expect(buildAssetKey(owner, asset.toUpperCase())).toBe(`assets/${owner}/${asset}`);
  });
  it.each([
    '../etc/passwd',
    `assets/../${owner}/${asset}`,
    `assets/${owner}/../${asset}`,
    `assets/${owner}/${asset}/..`,
    `/assets/${owner}/${asset}`,
    `/etc/passwd`,
    `C:\\assets\\${owner}\\${asset}`,
    `assets\\${owner}\\${asset}`,
    `assets/${owner}\\${asset}`,
    `assets/${owner}/${asset}\n`,
    `assets/${owner}/${asset}.png`,
    `assets/${owner}/${asset.toUpperCase()}`,
    `assets//${asset}`,
    `assets/${owner}/`,
    `assets/${owner}/%2e%2e`,
    '',
  ])('거부: %j', (key) => {
    expect(isValidStorageKey(key)).toBe(false);
    expect(() => assertValidStorageKey(key)).toThrow(InvalidStorageKeyError);
  });
  it('buildAssetKey 도 잘못된 id 를 거부', () => {
    expect(() => buildAssetKey('..', asset)).toThrow(InvalidStorageKeyError);
    expect(() => buildAssetKey(owner, '../x')).toThrow(InvalidStorageKeyError);
  });
});
