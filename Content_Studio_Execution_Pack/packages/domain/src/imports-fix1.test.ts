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
    // FIX-T18 round 2: 따옴표 속성 값·자체 종료처럼 쓴 raw text 요소
    ['닫히지 않은 따옴표 속성 반복', (b) => fill('<a x="', b)],
    ['= 만 있는 속성 반복', (b) => fill('<a x= ', b)],
    ['따옴표 값 안 > 반복', (b) => fill(`<a t='>'>`, b)],
    ['<script/> 반복', (b) => fill('<script/>', b)],
    ['<script/> 뒤 </script x=" 반복', (b) => `<script/>${fill('</script x="', b - 9)}`],
  ];
  /**
   * FIX-T18 round 2(오케스트레이터 지적): 벽시계·CPU 시간은 병렬 부하에 흔들린다(전체 실행에서 `<` 반복 시험이 1.7초 걸림 — 이 PC 단독은 ~200ms).
   * 주 판정은 htmlToText 가 실제로 살펴본 글자 수(stats.steps): 입력 글자당 상수(STEP_BOUND) 이하이고, 크기 4배 → 걸음 4배(여유 4.5배) 안.
   * 제곱 구현(같은 구간을 다시 훑음)이면 2MB 에서 글자당 수십만 걸음이라 반드시 실패한다(인계 문서에 일부러 넣어 실패를 확인한 기록).
   * 시간은 느슨한 보조 확인만(2MB 한 번, CPU 시간 3회 중 최소 < 1초 — 고치기 전 정규식은 128KB 에서 이미 482ms 였다).
   */
  const STEP_BOUND = 4;
  it.each(adversarial)('%s: 살펴본 글자 수가 입력에 비례(선형) · 2MB 시간은 보조 확인', (_label, make) => {
    const steps = (input: string) => {
      const s = { steps: 0 };
      htmlToText(input, s);
      return s.steps;
    };
    // 작은 크기부터 재고 그 자리에서 판정한다 — 제곱 구현은 16KB 에서 이미 글자당 수천 걸음이라, 2MB(동기 실행이라 시험 시간 제한이
    // 끊지 못함)에 닿기 전에 실패한다.
    const sizes = [16 * 1024, 128 * 1024, TWO_MB / 4, TWO_MB];
    const counts: number[] = [];
    let big = '';
    for (const b of sizes) {
      const input = make(b);
      expect(input.length).toBeLessThanOrEqual(HTML_TO_TEXT_MAX_INPUT);
      const c = steps(input);
      expect(c, `글자당 걸음(${input.length}자)`).toBeLessThanOrEqual(STEP_BOUND * input.length + 16);
      if (counts.length) expect(c / counts[counts.length - 1]!, '크기 비율 대비 걸음 비율').toBeLessThanOrEqual((b / sizes[counts.length - 1]!) * 1.125);
      counts.push(c);
      big = input;
    }
    // 보조: 정규식 후처리(엔티티·공백 정리) 처럼 계수기 밖 단계까지 포함한 실제 시간. 병렬 부하를 견디도록 느슨하게.
    let min = Infinity;
    for (let k = 0; k < 3; k++) {
      const c = process.cpuUsage();
      htmlToText(big);
      const d = process.cpuUsage(c);
      min = Math.min(min, (d.user + d.system) / 1000);
    }
    expect(min).toBeLessThan(1000);
  });

  it('상한을 넘는 입력은 처리하지 않는다', () => {
    expect(() => htmlToText('a'.repeat(HTML_TO_TEXT_MAX_INPUT + 1))).toThrow(ImportInvalidError);
  });

  it('닫히지 않은 태그·주석: 앞의 글은 남고 그 뒤는 버린다(브라우저와 같음). 태그 아닌 < 는 글자', () => {
    expect(htmlToText('<p>앞 글</p><!-- 닫히지 않음 <p>뒤</p>').text).toBe('앞 글');
    expect(htmlToText('<p>앞 글</p><script>var a = 1; <p>뒤</p>').text).toBe('앞 글');
    expect(htmlToText('<p>a < b 이고 c > d</p>').text).toBe('a < b 이고 c > d');
    expect(htmlToText('<P>대문자</P><SCRIPT>x()</SCRIPT ><BR/>끝').text).toBe('대문자\n\n끝');
  });

  it('FIX-T18 round 2(P2 :366): <script/>·<style/>·<title/> 도 raw text — 짝 닫는 태그까지(없으면 끝까지) 버린다', () => {
    expect(htmlToText('<script/>alert(1)</script><p>본문</p>').text).toBe('본문');
    expect(htmlToText('<style/>p{color:red}</style><p>본문</p>').text).toBe('본문');
    expect(htmlToText('<SCRIPT />x()</Script><p>본문</p>').text).toBe('본문');
    expect(htmlToText('<noscript/>n</noscript>본문').text).toBe('본문');
    expect(htmlToText('<p>앞</p><script/>닫히지 않음 <p>뒤</p>').text).toBe('앞');
    const t = htmlToText('<title/>탭 제목</title><p>본문</p>');
    expect(t).toEqual({ title: '탭 제목', text: '본문' });
    // void 요소의 '/' 는 그대로 자체 종료
    expect(htmlToText('줄1<br/>줄2<img src="a.png"/>끝').text).toBe('줄1\n줄2끝');
  });

  it('FIX-T18 round 2(놓친 케이스): 따옴표 속성 값 안의 > 는 태그 끝이 아니다. 닫히지 않은 따옴표는 나머지를 버린다', () => {
    expect(htmlToText('<a title="x>y" href=\'a>b\'>링크</a> 뒤').text).toBe('링크 뒤');
    expect(htmlToText('<p data-x = "1>2">본문</p>').text).toBe('본문');
    expect(htmlToText('<p class=a"b>본문</p>').text).toBe('본문'); // = 뒤가 따옴표가 아니면 값 안의 따옴표는 글자
    expect(htmlToText('<p>앞</p><a title="닫히지 않음>뒤').text).toBe('앞');
    expect(htmlToText('<script>x</script data-a=">">본문').text).toBe('본문');
  });

  it('FIX-T18 round 2(놓친 케이스): 숫자 엔티티로 NUL·짝 없는 서로게이트를 만들지 않는다', () => {
    const t = htmlToText('<p>a&#0;b&#x0;c&#xD800;d&#55296;e&#x1F600;</p>').text;
    expect(t).not.toContain('\0');
    expect(t).toBe('a&#0;b&#x0;c&#xD800;d&#55296;e😀');
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
