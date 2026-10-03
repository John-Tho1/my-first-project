/**
 * FIX-T18 round 2(Codex review-FIX-T18 P0 :499): ZIP 항목 구간 겹침 거부(바깥·중첩), 압축 입력 예산.
 * HTML 선형성·raw text(P2 :366) 시험은 imports-fix1.test.ts 의 HTML 절에 함께 있다.
 */
import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { assembleRawZip, buildTestZip, localHeader, overlappingChainZip } from '../../../tests/helpers/import-zip';
import { IMPORT_MAX_TOTAL_COMPRESSED_BYTES, IMPORT_MAX_TOTAL_INFLATED_BYTES, IMPORT_MAX_ZIP_BYTES, parseImportArchive } from './imports';
import { ZipFormatError } from './zip';

const expectOverlap = (zip: Buffer) => {
  let err: unknown;
  try {
    parseImportArchive('drive_export', zip);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ZipFormatError);
  expect((err as Error).message).toContain('겹칩니다');
};

describe('FIX-T18 round 2 — ZIP 항목 구간 겹침(P0 :499)', () => {
  it('사슬(한 항목의 데이터가 뒤 항목 전체를 감쌈) — 각 항목은 형식상 올바르지만 구간이 겹치므로 묶음 전체 거부', () => {
    expectOverlap(overlappingChainZip(3));
    expectOverlap(overlappingChainZip(3, 'bin')); // 풀지 않는 첨부여도 구간 검사는 같다
  });

  it('레코드 1,000개 사슬(고치기 전에는 같은 바이트를 수백 번 풀었음) → 풀기 전에 거부', () => {
    const zip = overlappingChainZip(1000);
    expect(zip.length).toBeLessThan(IMPORT_MAX_ZIP_BYTES);
    expectOverlap(zip);
  });

  it('부분 겹침: 앞 항목의 선언 압축 크기가 다음 항목 local header 안으로 10바이트 들어감 → 거부', () => {
    const aData = Buffer.from('# a\n\n본문 A\n', 'utf8');
    const bData = Buffer.from('# b\n\n본문 B\n', 'utf8');
    const bBlock = Buffer.concat([localHeader('b.md', 0, crc32(bData) >>> 0, bData.length, bData.length), bData]);
    const aDeclared = Buffer.concat([aData, bBlock.subarray(0, 10)]);
    const aHeader = localHeader('a.md', 0, crc32(aDeclared) >>> 0, aDeclared.length, aDeclared.length);
    const area = Buffer.concat([aHeader, aData, bBlock]);
    const zip = assembleRawZip(area, [
      { name: 'a.md', method: 0, crc: crc32(aDeclared), compSize: aDeclared.length, size: aDeclared.length, localOffset: 0 },
      { name: 'b.md', method: 0, crc: crc32(bData), compSize: bData.length, size: bData.length, localOffset: aHeader.length + aData.length },
    ]);
    expectOverlap(zip);
    // 대조: 같은 두 항목을 올바른 크기로 적으면 받는다
    const ok = assembleRawZip(area, [
      { name: 'a.md', method: 0, crc: crc32(aData), compSize: aData.length, size: aData.length, localOffset: 0 },
      { name: 'b.md', method: 0, crc: crc32(bData), compSize: bData.length, size: bData.length, localOffset: aHeader.length + aData.length },
    ]);
    expect(parseImportArchive('drive_export', ok).items.map((i) => i.title)).toEqual(['a', 'b']);
  });

  it('같은 local header 를 가리키는 레코드: 이름이 같으면 중복 이름, 다르면 local/central 불일치로 거부(풀기 전)', () => {
    const data = Buffer.from('# a\n\n본문\n', 'utf8');
    const area = Buffer.concat([localHeader('a.md', 0, crc32(data) >>> 0, data.length, data.length), data]);
    const rec = { method: 0 as const, crc: crc32(data), compSize: data.length, size: data.length, localOffset: 0 };
    expect(() => parseImportArchive('drive_export', assembleRawZip(area, [{ name: 'a.md', ...rec }, { name: 'a.md', ...rec }]))).toThrow(ZipFormatError);
    expect(() => parseImportArchive('drive_export', assembleRawZip(area, [{ name: 'a.md', ...rec }, { name: 'b.md', ...rec }]))).toThrow(ZipFormatError);
  });

  it('중첩: 안쪽 ZIP 이 겹치는 사슬이면 묶음 전체 거부', () => {
    const outer = buildTestZip([
      { path: 'ok.md', data: '# ok\n\n본문\n' },
      { path: 'Part-1.zip', data: overlappingChainZip(50) },
    ]);
    expectOverlap(outer);
  });

  it('정상 ZIP(데이터 디스크립터 포함·여러 항목·중첩)은 그대로 받는다', () => {
    const inner = buildTestZip([
      { path: 'x.md', data: '# x\n\n안쪽\n', dataDescriptor: true },
      { path: 'y.txt', data: '안쪽 둘\n' },
    ]);
    const outer = buildTestZip([
      { path: 'a.md', data: '# a\n\n본문\n', dataDescriptor: true },
      { path: 'b.md', data: '# b\n\n본문\n', method: 0 },
      { path: 'Part-1.zip', data: inner },
    ]);
    expect(parseImportArchive('drive_export', outer).items.map((i) => i.skipReason)).toEqual([null, null, null, null]);
  });

  it('압축 입력 예산은 바깥 파일 + 풀린 바이트 상한(겹침이 없으면 넘을 수 없는 방어선)', () => {
    expect(IMPORT_MAX_TOTAL_COMPRESSED_BYTES).toBe(IMPORT_MAX_ZIP_BYTES + IMPORT_MAX_TOTAL_INFLATED_BYTES);
  });
});
