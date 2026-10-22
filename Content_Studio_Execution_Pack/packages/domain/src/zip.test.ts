import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { assembleRawZip, buildTestZip, localHeader, overlappingChainZip } from '../../../tests/helpers/import-zip';
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

/**
 * FIX1-FULLREV(F5): 복원(readZip) 경로의 항목 구간 겹침 거부 — imports.ts listZip(FIX-T18 round 2)과 같은 규칙·문구.
 * 겹침을 받으면 항목마다 파일 크기에 가까운 사본을 만들어(항목 수 × 파일 크기) 메모리·CRC 계산이 커진다.
 */
describe('FIX1-FULLREV(F5) — readZip 항목 데이터 구간 겹침', () => {
  const expectOverlap = (zip: Buffer) => {
    let err: unknown;
    try {
      readZip(zip);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ZipFormatError);
    expect((err as Error).message).toBe('ZIP 항목의 데이터 구간이 겹칩니다');
  };

  it('저장 방식 두 항목: 앞 항목의 데이터가 뒤 항목(local header + 데이터) 전체를 감쌈 — CRC·크기·이름은 모두 맞지만 거부', () => {
    const zip = overlappingChainZip(2);
    // 대조: 각 항목은 형식상 올바르다(CRC 는 선언 구간 그대로 계산됨) — 구간이 겹친다는 것만 잘못이다.
    const cd = zip.readUInt32LE(zip.length - 22 + 16);
    expect(zip.readUInt32LE(cd + 16)).toBe(crc32(zip.subarray(30 + 'c0.txt'.length, cd)) >>> 0);
    expectOverlap(zip);
  });

  it('사슬(항목 3·200개) → 거부', () => {
    expectOverlap(overlappingChainZip(3));
    expectOverlap(overlappingChainZip(200, 'json'));
  });

  it('부분 겹침: 앞 항목의 선언 크기가 다음 항목 local header 안으로 10바이트 들어감(CRC 맞음) → 거부, 올바른 크기면 받는다', () => {
    const aData = Buffer.from('{"a":1}\n', 'utf8');
    const bData = Buffer.from('{"b":2}\n', 'utf8');
    const bBlock = Buffer.concat([localHeader('b.json', 0, crc32(bData) >>> 0, bData.length, bData.length), bData]);
    const aDeclared = Buffer.concat([aData, bBlock.subarray(0, 10)]);
    const aHeader = localHeader('a.json', 0, crc32(aDeclared) >>> 0, aDeclared.length, aDeclared.length);
    const area = Buffer.concat([aHeader, aData, bBlock]);
    const bRec = { name: 'b.json', method: 0 as const, crc: crc32(bData), compSize: bData.length, size: bData.length, localOffset: aHeader.length + aData.length };
    expectOverlap(
      assembleRawZip(area, [{ name: 'a.json', method: 0, crc: crc32(aDeclared), compSize: aDeclared.length, size: aDeclared.length, localOffset: 0 }, bRec]),
    );
    // 중앙 목록 순서를 바꿔도(뒤 항목이 먼저) 같은 판정
    expectOverlap(
      assembleRawZip(area, [bRec, { name: 'a.json', method: 0, crc: crc32(aDeclared), compSize: aDeclared.length, size: aDeclared.length, localOffset: 0 }]),
    );
    const ok = assembleRawZip(area, [{ name: 'a.json', method: 0, crc: crc32(aData), compSize: aData.length, size: aData.length, localOffset: 0 }, bRec]);
    const back = readZip(ok);
    expect(back.map((e) => e.path)).toEqual(['a.json', 'b.json']);
    expect(Buffer.from(back[0]!.bytes).equals(aData)).toBe(true);
    expect(Buffer.from(back[1]!.bytes).equals(bData)).toBe(true);
  });

  it('겹침 검사는 복사·CRC 보다 먼저 — 겹치는 항목 중 하나의 CRC 가 틀려도 겹침으로 거부', () => {
    const zip = Buffer.from(overlappingChainZip(3));
    const cd = zip.readUInt32LE(zip.length - 22 + 16);
    zip.writeUInt32LE((zip.readUInt32LE(cd + 16) ^ 0xffffffff) >>> 0, cd + 16); // 첫 항목의 중앙 목록 CRC 를 틀리게
    expectOverlap(zip);
  });

  it('겹치지 않는 정상 ZIP 은 그대로 — 디렉터리 항목은 건너뛰고, 빈 파일·이어 붙은 구간(앞 끝 = 뒤 시작)은 받는다', () => {
    const zip = buildTestZip([
      { path: 'data/', data: '', method: 0 },
      { path: 'data/a.json', data: '[1]\n', method: 0 },
      { path: 'empty.txt', data: '', method: 0 },
      { path: 'data/b.json', data: '[2]\n', method: 0 },
    ]);
    const back = readZip(zip);
    expect(back.map((e) => e.path)).toEqual(['data/a.json', 'empty.txt', 'data/b.json']);
    expect(back.map((e) => Buffer.from(e.bytes).toString('utf8'))).toEqual(['[1]\n', '', '[2]\n']);
  });
});
