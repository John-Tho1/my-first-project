import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { isSafeZipPath, readZip, writeZip, ZipFormatError } from './zip';

const enc = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));

describe('store-only ZIP', () => {
  it('왕복: 한국어 이름·빈 파일·바이너리 바이트가 그대로 돌아온다', () => {
    const bin = new Uint8Array(1024).map((_, i) => (i * 7) % 256);
    const entries = [
      { path: 'manifest.json', bytes: enc('{"a":1}\n') },
      { path: 'markdown/소재/노트.md', bytes: enc('# 주재원\n원문 그대로') },
      { path: 'empty.txt', bytes: new Uint8Array(0) },
      { path: 'assets/x.png', bytes: bin },
    ];
    const zip = writeZip(entries, new Date('2026-09-24T12:00:00Z'));
    const back = readZip(zip);
    expect(back.map((e) => e.path)).toEqual(entries.map((e) => e.path));
    back.forEach((e, i) => expect(Buffer.from(e.bytes).equals(Buffer.from(entries[i]!.bytes))).toBe(true));
    // 표준 형식 확인: 첫 4바이트는 local header, 끝 22바이트는 EOCD
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
  });

  it('빈 ZIP 도 왕복된다', () => {
    const zip = writeZip([]);
    expect(zip.length).toBe(22);
    expect(readZip(zip)).toEqual([]);
  });

  it('바이트 한 개를 바꾸면 CRC 불일치로 거부한다', () => {
    const zip = writeZip([{ path: 'data/captures.json', bytes: enc('[{"raw_text":"주재원"}]') }]);
    const bad = Buffer.from(zip);
    const off = 30 + Buffer.byteLength('data/captures.json');
    bad[off + 3] = bad[off + 3]! ^ 0xff;
    expect(() => readZip(bad)).toThrow(ZipFormatError);
    expect(() => readZip(bad)).toThrow(/CRC/);
  });

  it('CRC 값은 zlib.crc32 와 같다', () => {
    const bytes = enc('hello');
    const zip = writeZip([{ path: 'h.txt', bytes }]);
    expect(zip.readUInt32LE(14)).toBe(crc32(bytes) >>> 0);
  });

  it.each(['../evil.txt', 'a/../../b', '/etc/passwd', 'a\\b', 'C:/x', 'a//b', './a', ''])('위험한 경로 %j 는 쓰기·읽기 모두 거부', (p) => {
    expect(isSafeZipPath(p)).toBe(false);
    expect(() => writeZip([{ path: p, bytes: enc('x') }])).toThrow(ZipFormatError);
    // 이름만 바꿔 치기: 같은 길이의 안전한 이름으로 만든 뒤 central/local 이름을 덮어쓴다.
    if (p.length === 0) return;
    const safe = 'z'.repeat(Buffer.byteLength(p));
    const zip = Buffer.from(writeZip([{ path: safe, bytes: enc('x') }]));
    const name = Buffer.from(p, 'utf8');
    name.copy(zip, 30); // local header 이름
    const cd = zip.readUInt32LE(zip.length - 22 + 16);
    name.copy(zip, cd + 46); // central 이름
    expect(() => readZip(zip)).toThrow(ZipFormatError);
  });

  it('중복 이름은 거부한다', () => {
    expect(() => writeZip([{ path: 'a.txt', bytes: enc('1') }, { path: 'a.txt', bytes: enc('2') }])).toThrow(/같은 이름/);
    const zip = Buffer.from(writeZip([{ path: 'a.txt', bytes: enc('1') }, { path: 'b.txt', bytes: enc('2') }]));
    const cd = zip.readUInt32LE(zip.length - 22 + 16);
    // 두 번째 항목의 local·central 이름을 a.txt 로 바꾼다
    const secondLocal = 30 + 5 + 1;
    zip.write('a', secondLocal + 30, 'utf8');
    zip.write('a', cd + 46 + 5 + 46, 'utf8');
    expect(() => readZip(zip)).toThrow(/같은 이름/);
  });

  it('ZIP 이 아닌 바이트·잘린 파일은 거부한다', () => {
    expect(() => readZip(enc('not a zip at all, just text......'))).toThrow(ZipFormatError);
    const zip = writeZip([{ path: 'a.txt', bytes: enc('hello world') }]);
    expect(() => readZip(zip.subarray(0, zip.length - 30))).toThrow(ZipFormatError);
  });

  it('압축(method 8) 항목은 거부한다', () => {
    const zip = Buffer.from(writeZip([{ path: 'a.txt', bytes: enc('abc') }]));
    const cd = zip.readUInt32LE(zip.length - 22 + 16);
    zip.writeUInt16LE(8, cd + 10);
    expect(() => readZip(zip)).toThrow(/압축/);
  });
});
