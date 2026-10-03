/**
 * T18(D32 제안) 가져오기 순수 함수: ZIP 안전(zip-slip·암호화·거짓 크기·압축 폭탄·상한), 항목 해석(Notion ID·제목·생성 표시·HTML),
 * 판정(new·identical·conflict·skipped), 폴더 선택.
 */
import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { buildTestZip, NOTION_IDS, notionExport } from '../../../tests/helpers/import-zip';
import {
  decideImportItem,
  externalIdFor,
  guessImportKind,
  htmlToText,
  IMPORT_MAX_ENTRIES,
  IMPORT_MAX_TEXT_ENTRY_BYTES,
  IMPORT_MAX_ZIP_BYTES,
  ImportInvalidError,
  ImportTooLargeError,
  inSelectedFolder,
  parseImportArchive,
  sha256Bytes,
} from './imports';
import { ZipFormatError } from './zip';

describe('T18 ZIP 안전', () => {
  it.each([
    ['../evil.md'],
    ['a/../../evil.md'],
    ['/etc/passwd.md'],
    ['C:/win.md'],
    ['a\\..\\evil.md'],
    ['a//b.md'],
  ])('zip-slip 경로 %s → ZIP 전체 거부(파일을 풀지 않음)', (p) => {
    const zip = buildTestZip([
      { path: 'ok.md', data: '# ok\n\n본문' },
      { path: p, data: 'x' },
    ]);
    expect(() => parseImportArchive('drive_export', zip)).toThrow(ZipFormatError);
  });

  it('디렉터리 항목의 위험한 경로도 거부', () => {
    const zip = buildTestZip([{ path: '../dir/', data: '', method: 0 }]);
    expect(() => parseImportArchive('drive_export', zip)).toThrow(ZipFormatError);
  });

  it('암호화 항목 → 거부', () => {
    const zip = buildTestZip([{ path: 'a.md', data: 'x', encrypted: true }]);
    expect(() => parseImportArchive('drive_export', zip)).toThrow(ZipFormatError);
  });

  it('선언 크기보다 많이 풀리는 항목(압축 폭탄·거짓 크기) → 거부', () => {
    const big = 'A'.repeat(200_000);
    const zip = buildTestZip([{ path: 'bomb.md', data: big, declaredSize: 100 }]);
    expect(() => parseImportArchive('drive_export', zip)).toThrow(ZipFormatError);
  });

  it('텍스트 항목이 2MB 를 넘으면 풀지 않고 too_large(건너뜀)', () => {
    const zip = buildTestZip([{ path: 'huge.md', data: 'x', declaredSize: IMPORT_MAX_TEXT_ENTRY_BYTES + 1 }]);
    const out = parseImportArchive('drive_export', zip);
    expect(out.items[0]).toMatchObject({ skipReason: 'too_large', contentChecksum: null, body: null });
  });

  it('ZIP 50MB 초과 → ImportTooLargeError', () => {
    expect(() => parseImportArchive('drive_export', new Uint8Array(IMPORT_MAX_ZIP_BYTES + 1))).toThrow(ImportTooLargeError);
  });

  it(`항목 수 상한(${IMPORT_MAX_ENTRIES}) 초과 → ImportInvalidError`, () => {
    const entries = Array.from({ length: IMPORT_MAX_ENTRIES + 1 }, (_, i) => ({ path: `f/${i}.png`, data: 'x', method: 0 as const }));
    expect(() => parseImportArchive('drive_export', buildTestZip(entries))).toThrow(ImportInvalidError);
  });

  it('CRC 불일치(손상) → 거부', () => {
    const zip = buildTestZip([{ path: 'a.md', data: '# a\n\n본문', method: 0 }]);
    const at = 30 + 'a.md'.length;
    zip[at] = zip[at]! ^ 0xff; // 본문 첫 바이트 변조
    expect(() => parseImportArchive('drive_export', zip)).toThrow(ZipFormatError);
  });

  it('지원하지 않는 압축 방식 → 거부', () => {
    const zip = buildTestZip([{ path: 'a.md', data: deflateRawSync(Buffer.from('x')), method: 0 }]);
    zip.writeUInt16LE(12, 8); // local method = bzip2
    const cdStart = zip.length - 22 - (46 + 'a.md'.length);
    zip.writeUInt16LE(12, cdStart + 10);
    expect(() => parseImportArchive('drive_export', zip)).toThrow(ZipFormatError);
  });
});

describe('T18 Notion 내보내기 해석', () => {
  const out = parseImportArchive('notion_export', notionExport());

  it('Notion 페이지 ID → 외부 ID, 첫 # 제목, Created 표시, 폴더', () => {
    const p1 = out.items.find((i) => i.externalId === `notion:${NOTION_IDS.page1}`)!;
    expect(p1.title).toBe('현지 파트너 첫 미팅');
    expect(p1.externalCreatedText).toBe('September 1, 2026 10:00 AM');
    expect(p1.folder).toBe(`Content Vault ${NOTION_IDS.vault}`);
    expect(p1.format).toBe('md');
    expect(p1.body).toContain('가격 협상 순서');
    expect(p1.contentChecksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('이미지·첨부는 목록에만(unsupported_type, 풀지 않음), CSV 는 텍스트 항목', () => {
    const img = out.items.find((i) => i.externalPath.endsWith('photo.png'))!;
    expect(img).toMatchObject({ skipReason: 'unsupported_type', body: null, contentChecksum: null, format: 'other' });
    expect(out.attachments).toBe(1);
    const csv = out.items.find((i) => i.format === 'csv')!;
    expect(csv.externalId).toBe(`notion:${NOTION_IDS.vault}:csv`);
    expect(csv.skipReason).toBeNull();
  });

  it('같은 바이트 → 같은 파일 checksum·같은 항목(결정적)', () => {
    const again = parseImportArchive('notion_export', notionExport());
    expect(again.fileChecksum).toBe(out.fileChecksum);
    expect(again.items.map((i) => [i.externalId, i.contentChecksum])).toEqual(out.items.map((i) => [i.externalId, i.contentChecksum]));
  });

  it('자동 판별: 페이지 ID 가 있으면 Notion, 없으면 Drive', () => {
    expect(guessImportKind(null, out.items)).toBe('notion_export');
    const drive = parseImportArchive('drive_export', buildTestZip([{ path: '콘텐츠/메모.txt', data: '메모' }]));
    expect(guessImportKind('content.zip', drive.items)).toBe('drive_export');
    expect(drive.items[0]!.externalId).toBe('path:콘텐츠/메모.txt');
  });

  it('중첩 ZIP(Part-1.zip) 한 겹은 풀고, 두 겹째 ZIP 은 첨부로 남긴다', () => {
    const inner2 = buildTestZip([{ path: 'deep.md', data: '# deep' }]);
    const inner = buildTestZip([
      { path: `Page ${NOTION_IDS.page2}.md`, data: '# 안쪽\n\n본문' },
      { path: 'deeper.zip', data: inner2, method: 0 },
    ]);
    const outer = buildTestZip([{ path: 'Export-Part-1.zip', data: inner, method: 0 }]);
    const res = parseImportArchive('notion_export', outer);
    const page = res.items.find((i) => i.externalId === `notion:${NOTION_IDS.page2}`)!;
    expect(page.externalPath).toBe(`Export-Part-1.zip!/Page ${NOTION_IDS.page2}.md`);
    expect(res.items.find((i) => i.externalPath.endsWith('deeper.zip'))!.skipReason).toBe('unsupported_type');
  });

  it('같은 외부 ID 가 두 번 → 두 번째는 duplicate_in_archive', () => {
    const zip = buildTestZip([
      { path: `a/P ${NOTION_IDS.page1}.md`, data: '# 1' },
      { path: `b/P ${NOTION_IDS.page1}.md`, data: '# 2' },
    ]);
    const res = parseImportArchive('notion_export', zip);
    expect(res.items.map((i) => i.skipReason)).toEqual([null, 'duplicate_in_archive']);
  });

  it('UTF-8 아님·빈 본문 → 건너뜀', () => {
    const zip = buildTestZip([
      { path: 'bad.txt', data: new Uint8Array([0xff, 0xfe, 0x00, 0x41]) },
      { path: 'empty.md', data: '   \n' },
    ]);
    const res = parseImportArchive('drive_export', zip);
    expect(res.items.map((i) => i.skipReason)).toEqual(['not_utf8', 'empty']);
  });
});

describe('T18 HTML(Drive) → 텍스트', () => {
  it('스크립트·스타일 제거, 제목, 엔티티', () => {
    const h = htmlToText('<html><head><title>T</title><style>p{}</style></head><body><h1>제목 &amp; 부제</h1><script>alert(1)</script><p>첫&nbsp;줄</p><p>둘째<br>줄</p></body></html>');
    expect(h.title).toBe('제목 & 부제');
    expect(h.text).not.toContain('alert');
    expect(h.text).toContain('첫 줄');
    expect(h.text).toContain('둘째\n줄');
  });
});

describe('T18 판정·선택', () => {
  const item = { skipReason: null, contentChecksum: sha256Bytes(new Uint8Array([1])) };
  it('new / identical(어떤 버전과 같음) / conflict / skipped', () => {
    expect(decideImportItem(item, undefined)).toBe('new');
    expect(decideImportItem(item, { sourceId: 's', versionChecksums: new Set(['x', item.contentChecksum]) })).toBe('identical');
    expect(decideImportItem(item, { sourceId: 's', versionChecksums: new Set(['x']) })).toBe('conflict');
    expect(decideImportItem({ skipReason: 'unsupported_type', contentChecksum: null }, undefined)).toBe('skipped');
  });
  it('폴더 선택은 하위 폴더 포함, 이름이 접두어만 같은 폴더는 제외', () => {
    expect(inSelectedFolder('a/b', ['a'])).toBe(true);
    expect(inSelectedFolder('a', ['a'])).toBe(true);
    expect(inSelectedFolder('ab', ['a'])).toBe(false);
    expect(inSelectedFolder('x', [''])).toBe(true);
  });
  it('외부 ID: Notion ID 가 없으면 경로', () => {
    expect(externalIdFor('notion_export', 'x/y.md')).toBe('path:x/y.md');
    expect(externalIdFor('drive_export', `x/P ${NOTION_IDS.page1}.md`)).toBe(`path:x/P ${NOTION_IDS.page1}.md`);
  });
});
