/**
 * FIX-T18 round 1(Codex review-T18): 중첩 ZIP 전역 예산(P0 :328), ZIP 형식 검사(놓친 케이스), HTML 선형 처리(P0 :248),
 * 원본 그대로 보존(P0 :293), 실제 선택 판정(P1 web :122), 크기 경계(P2 :339).
 */
import { describe, expect, it } from 'vitest';
import { buildTestZip } from '../../../tests/helpers/import-zip';
import {
  effectiveImportChoice,
  HTML_TO_TEXT_MAX_INPUT,
  htmlToText,
  IMPORT_MAX_ENTRIES,
  IMPORT_MAX_NESTED_ARCHIVES,
  IMPORT_MAX_TEXT_ENTRY_BYTES,
  IMPORT_MAX_TOTAL_INFLATED_BYTES,
  ImportInvalidError,
  ImportTooLargeError,
  originalBytes,
  parseImportArchive,
  parseImportFile,
  sha256Bytes,
} from './imports';
import { ZipFormatError } from './zip';

describe('FIX-T18 round 1 — 중첩 ZIP 전역 예산(P0 :328)', () => {
  it(`안쪽 ZIP 이 ${IMPORT_MAX_NESTED_ARCHIVES}개를 넘으면 거부, 상한 이하는 받는다`, () => {
    const inner = buildTestZip([{ path: 'a.md', data: '# a\n\n본문' }]);
    const outer = buildTestZip(Array.from({ length: IMPORT_MAX_NESTED_ARCHIVES + 1 }, (_, i) => ({ path: `Part-${i}.zip`, data: inner })));
    expect(() => parseImportArchive('drive_export', outer)).toThrow(ImportInvalidError);
    const ok = buildTestZip(Array.from({ length: IMPORT_MAX_NESTED_ARCHIVES }, (_, i) => ({ path: `Part-${i}.zip`, data: inner })));
    expect(parseImportArchive('drive_export', ok).items).toHaveLength(IMPORT_MAX_NESTED_ARCHIVES);
  });

  it(`안쪽 ZIP 컨테이너를 푸는 바이트도 누적 상한(${IMPORT_MAX_TOTAL_INFLATED_BYTES / 1024 / 1024}MiB)에 든다 — 첨부만 든 큰 안쪽 ZIP 반복 → 거부`, () => {
    // 안쪽 ZIP: 9 MiB 첨부(저장, 0 바이트) 하나 — 텍스트가 아니므로 고치기 전에는 어떤 누적 상한에도 걸리지 않았다.
    const inner = buildTestZip([{ path: 'big.bin', data: new Uint8Array(9 * 1024 * 1024), method: 0 }]);
    const count = Math.floor(IMPORT_MAX_TOTAL_INFLATED_BYTES / inner.length) + 1;
    expect(count).toBeLessThanOrEqual(IMPORT_MAX_NESTED_ARCHIVES);
    const outer = buildTestZip(Array.from({ length: count }, (_, i) => ({ path: `Part-${i}.zip`, data: inner })));
    expect(outer.length).toBeLessThan(5 * 1024 * 1024); // 올리는 파일은 작다(deflate)
    expect(() => parseImportArchive('drive_export', outer)).toThrow(ImportTooLargeError);
    // 상한 바로 아래(개수 하나 적게)는 받는다 — 첨부는 목록만
    const under = buildTestZip(Array.from({ length: count - 1 }, (_, i) => ({ path: `Part-${i}.zip`, data: inner })));
    expect(parseImportArchive('drive_export', under).attachments).toBe(count - 1);
  }, 60_000);

  it(`디렉터리만 많은 중첩 ZIP: 디렉터리 레코드도 전역 항목 수(${IMPORT_MAX_ENTRIES})에 센다`, () => {
    const dirs = (n: number, tag: string) => buildTestZip(Array.from({ length: n }, (_, i) => ({ path: `${tag}${i}/`, data: '', method: 0 as const })));
    const outer = buildTestZip([
      { path: 'Part-1.zip', data: dirs(3000, 'a') },
      { path: 'Part-2.zip', data: dirs(3000, 'b') },
    ]);
    expect(() => parseImportArchive('drive_export', outer)).toThrow(ImportInvalidError);
    const flat = buildTestZip(Array.from({ length: IMPORT_MAX_ENTRIES + 1 }, (_, i) => ({ path: `d${i}/`, data: '', method: 0 as const })));
    expect(() => parseImportArchive('drive_export', flat)).toThrow(ImportInvalidError);
  });

  it('두 겹째 ZIP 은 풀지 않는다(깊이 1) — 첨부로 남는다', () => {
    const deep = buildTestZip([{ path: 'x.md', data: '# x' }]);
    const inner = buildTestZip([{ path: 'deeper.zip', data: deep }]);
    const res = parseImportArchive('drive_export', buildTestZip([{ path: 'Part-1.zip', data: inner }]));
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ skipReason: 'unsupported_type', format: 'other' });
  });
});

describe('FIX-T18 round 1 — ZIP 형식 검사(놓친 케이스)', () => {
  it('정상적인 데이터 디스크립터(bit 3) ZIP — local 크기·CRC 0 이어도 중앙 목록으로 읽는다', () => {
    const res = parseImportArchive(
      'drive_export',
      buildTestZip([
        { path: 'd/a.md', data: '# 디스크립터\n\n본문', dataDescriptor: true },
        { path: 'd/b.txt', data: '저장', method: 0, dataDescriptor: true },
      ]),
    );
    expect(res.items.map((i) => [i.title, i.skipReason])).toEqual([
      ['디스크립터', null],
      ['b', null],
    ]);
  });

  it('local/central 이름 불일치 → 거부', () => {
    expect(() => parseImportArchive('drive_export', buildTestZip([{ path: 'a.md', data: '# a', localName: 'b.md' }]))).toThrow(ZipFormatError);
  });

  it('지원하지 않는 압축 방식은 첨부·디렉터리·큰 파일에서도 거부(풀지 않는 항목 포함)', () => {
    expect(() => parseImportArchive('drive_export', buildTestZip([{ path: 'a.md', data: '# a' }, { path: 'p.png', data: 'x', rawMethod: 12 }]))).toThrow(ZipFormatError);
    expect(() => parseImportArchive('drive_export', buildTestZip([{ path: 'dir/', data: '', rawMethod: 14 }]))).toThrow(ZipFormatError);
    expect(() =>
      parseImportArchive('drive_export', buildTestZip([{ path: 'big.md', data: 'x', rawMethod: 9, declaredSize: IMPORT_MAX_TEXT_ENTRY_BYTES + 1 }])),
    ).toThrow(ZipFormatError);
  });

  it.each([[2 ** 31 - 1], [2 ** 31], [0xfffffffe]])('선언 크기 %d 인 첨부 — 풀지 않고 byteSize 를 그대로(원장 bigint) 남긴다(P2 :339)', (size) => {
    const res = parseImportArchive('drive_export', buildTestZip([{ path: 'v.mp4', data: 'x', method: 0, declaredSize: size }]));
    expect(res.items[0]).toMatchObject({ skipReason: 'unsupported_type', byteSize: size });
  });
});

describe('FIX-T18 round 1 — HTML 선형 처리(P0 :248)', () => {
  const TWO_MB = 2 * 1024 * 1024;
  const fill = (unit: string, bytes: number) => unit.repeat(Math.floor(bytes / unit.length));
  const adversarial: Array<[string, (bytes: number) => string]> = [
    ['닫히지 않은 <script> 반복', (b) => fill('<script>', b)],
    ['닫히지 않은 <style x> 반복', (b) => fill('<style x>', b)],
    ['닫히지 않은 주석 반복', (b) => fill('<!--', b)],
    ['> 없는 태그 시작 반복', (b) => fill('<a', b)],
    ['< 만 반복', (b) => fill('<', b)],
    ['</ 만 반복', (b) => fill('</', b)],
    ['<title> 뒤 닫는 태그 흉내 반복', (b) => `<title>${fill('</titl', b - 7)}`],
    ['<script> 뒤 </scrip 반복', (b) => `<script>${fill('</scrip', b - 8)}`],
    ['<h1> 열고 짧은 태그 반복', (b) => `<h1>${fill('<b>x', b - 4)}`],
    ['엔티티 흉내 반복', (b) => fill('&#x1F600&amp', b)],
  ];
  it.each(adversarial)('%s: 2MB 를 200ms 안에, 크기에 비례(선형)', (_label, make) => {
    htmlToText(make(64 * 1024)); // 준비(JIT)
    const small = make(TWO_MB / 4);
    const big = make(TWO_MB);
    expect(big.length).toBeLessThanOrEqual(HTML_TO_TEXT_MAX_INPUT);
    // 이 프로세스(시험 워커 fork)가 쓴 CPU 시간(ms)을 세 번 재어 가장 작은 값 — 다른 시험 파일이 함께 돌 때의
    // 벽시계 경합을 빼고 이 함수의 실제 작업량만 본다(상한 200ms 자체는 그대로).
    const best = (input: string, times: number) => {
      let min = Infinity;
      for (let k = 0; k < 3; k++) {
        const c = process.cpuUsage();
        for (let r = 0; r < times; r++) htmlToText(input);
        const d = process.cpuUsage(c);
        min = Math.min(min, (d.user + d.system) / 1000);
      }
      return min;
    };
    const tBig = best(big, 1);
    const tSmallX4 = best(small, 4); // 1/4 크기를 네 번 = 같은 총 글자 수
    expect(tBig).toBeLessThan(200);
    // 같은 총 글자 수: 선형이면 2MB 한 번 ≈ 512KB 네 번, 제곱이면 4 배 — 여유를 두고 2.5 배 + 타이머 눈금 2칸(Windows CPU 시간 눈금 약 15.6ms) 안
    expect(tBig).toBeLessThan(tSmallX4 * 2.5 + 32);
  });

  it('상한을 넘는 입력은 처리하지 않는다', () => {
    expect(() => htmlToText('a'.repeat(HTML_TO_TEXT_MAX_INPUT + 1))).toThrow(ImportInvalidError);
  });

  it('닫히지 않은 태그·주석: 앞의 글은 남고 그 뒤는 버린다(브라우저와 같음). 태그 아닌 < 는 글자', () => {
    expect(htmlToText('<p>앞 글</p><!-- 닫히지 않음 <p>뒤</p>').text).toBe('앞 글');
    expect(htmlToText('<p>앞 글</p><script>var a = 1; <p>뒤</p>').text).toBe('앞 글');
    expect(htmlToText('<p>a < b 이고 c > d</p>').text).toBe('a < b 이고 c > d');
    expect(htmlToText('<P>대문자</P><SCRIPT>x()</SCRIPT ><BR/>끝').text).toBe('대문자\n\n끝');
    expect(htmlToText('<script/>남음').text).toBe('남음');
  });

  it('제목: 첫 h1(안쪽 태그 제거·엔티티) → 없으면 title. title·script 내용은 본문에 없음', () => {
    expect(htmlToText('<title>탭 &amp; 제목</title><p>본문</p>')).toEqual({ title: '탭 & 제목', text: '본문' });
    const h = htmlToText('<head><title>탭</title></head><h1>큰 <b>제목</b></h1><h1>둘째</h1>');
    expect(h.title).toBe('큰 제목');
    expect(h.text).not.toContain('탭');
  });
});

describe('FIX-T18 round 1 — 원본 그대로 보존(P0 :293)', () => {
  it('HTML 원본(링크·표·BOM·CRLF 포함)은 original 에 바이트 그대로, 본문은 추출 텍스트(파생)', () => {
    const html =
      '﻿<html><head><title>근거 문서</title></head><body><p><a href="https://example.com/source">근거</a></p><table><tr><td>A</td><td>B</td></tr></table></body></html>\r\n';
    const bytes = new TextEncoder().encode(html);
    const item = parseImportFile('drive_export', 'd/근거.html', 'd/근거.html', bytes);
    expect(item.body).toContain('근거');
    expect(item.body).not.toContain('https://example.com/source');
    expect(item.original).toBe(html);
    const back = originalBytes(item.original!);
    expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
    expect(sha256Bytes(back)).toBe(item.contentChecksum);
  });

  it('md 도 원본 보존(BOM 은 original 에만, 본문에서는 뗌). 건너뛴 항목은 original 없음', () => {
    const md = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('# 제목\r\n\r\n본문\r\n')]);
    const item = parseImportFile('drive_export', 'a.md', 'a.md', md);
    expect(item.body!.charCodeAt(0)).not.toBe(0xfeff);
    expect(item.title).toBe('제목');
    expect(Buffer.from(originalBytes(item.original!)).equals(Buffer.from(md))).toBe(true);
    const zip = parseImportArchive('drive_export', buildTestZip([{ path: 'e.md', data: ' \n' }, { path: 'p.png', data: 'x' }]));
    expect(zip.items.map((i) => i.original)).toEqual([null, null]);
  });
});

describe('FIX-T18 round 1 — 실제 선택 판정(P1 web :122)', () => {
  const sel = (o: Partial<{ itemIds: string[]; folders: string[]; versionIds: string[] }>) => ({
    itemIds: new Set(o.itemIds ?? []),
    folders: o.folders ?? [],
    versionIds: new Set(o.versionIds ?? []),
  });
  it('new 는 항목·폴더, conflict 는 version 만, identical·skipped 는 어떤 선택으로도 쓰지 않음', () => {
    const n = { id: 'n', decision: 'new', folder: 'a/b' };
    const c = { id: 'c', decision: 'conflict', folder: 'a' };
    const i = { id: 'i', decision: 'identical', folder: 'a' };
    const s = { id: 's', decision: 'skipped', folder: 'a' };
    expect(effectiveImportChoice(n, sel({ folders: ['a'] }))).toBe('import');
    expect(effectiveImportChoice(n, sel({ folders: ['없는 폴더'] }))).toBeNull();
    expect(effectiveImportChoice(n, sel({ versionIds: ['n'] }))).toBeNull();
    expect(effectiveImportChoice(c, sel({ itemIds: ['c'], folders: [''] }))).toBeNull();
    expect(effectiveImportChoice(c, sel({ versionIds: ['c'] }))).toBe('version');
    expect(effectiveImportChoice(i, sel({ itemIds: ['i'], folders: [''] }))).toBeNull();
    expect(effectiveImportChoice(s, sel({ itemIds: ['s'], folders: [''] }))).toBeNull();
  });
});
