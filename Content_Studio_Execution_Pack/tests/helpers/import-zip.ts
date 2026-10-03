/**
 * T18 시험용 ZIP 만들기(저장·deflate). 실제 Notion·Drive 내보내기를 흉내 내는 합성 자료만 쓴다.
 * 위험한 경로·거짓 크기 등 "나쁜 ZIP" 도 만들 수 있게 검사를 하지 않는다(시험 전용).
 */
import { crc32, deflateRawSync } from 'node:zlib';

export interface TestZipEntry {
  path: string;
  data: string | Uint8Array;
  /** 0 = 저장, 8 = deflate(기본) */
  method?: 0 | 8;
  /** 목록에 적을 풀린 크기(거짓 크기 시험용) */
  declaredSize?: number;
  /** 암호화 플래그(시험용) */
  encrypted?: boolean;
  /** FIX-T18 round 1: 데이터 디스크립터(bit 3) — local header 의 CRC·크기는 0, 본문 뒤에 디스크립터(서명 포함 16바이트) */
  dataDescriptor?: boolean;
  /** FIX-T18 round 1: local header 에만 다른 이름(local/central 불일치 시험용) */
  localName?: string;
  /** FIX-T18 round 1: 압축 방식 값을 그대로 적는다(지원하지 않는 방식 시험용, 본문은 저장 그대로) */
  rawMethod?: number;
}

export function buildTestZip(entries: readonly TestZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : Buffer.from(e.data);
    const method = e.rawMethod ?? e.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.path, 'utf8');
    const lname = Buffer.from(e.localName ?? e.path, 'utf8');
    const crc = crc32(raw) >>> 0;
    const size = e.declaredSize ?? raw.length;
    const flags = 0x0800 | (e.encrypted ? 1 : 0) | (e.dataDescriptor ? 0x0008 : 0);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(e.dataDescriptor ? 0 : crc, 14);
    lh.writeUInt32LE(e.dataDescriptor ? 0 : body.length, 18);
    lh.writeUInt32LE(e.dataDescriptor ? 0 : size, 22);
    lh.writeUInt16LE(lname.length, 26);
    locals.push(lh, lname, body);
    let dd = 0;
    if (e.dataDescriptor) {
      const d = Buffer.alloc(16);
      d.writeUInt32LE(0x08074b50, 0);
      d.writeUInt32LE(crc, 4);
      d.writeUInt32LE(body.length, 8);
      d.writeUInt32LE(size, 12);
      locals.push(d);
      dd = 16;
    }
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + lname.length + body.length + dd;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** 합성 Notion "Markdown & CSV" 내보내기(페이지 ID 32 hex 가 붙은 파일 이름). */
export const NOTION_IDS = {
  vault: '68b18b614f254b559f1f023bdbc17c1c',
  page1: '11111111111111111111111111111111',
  page2: '22222222222222222222222222222222',
  page3: '33333333333333333333333333333333',
} as const;

export function notionExport(overrides: Partial<Record<'page1' | 'page2' | 'page3', string>> = {}): Buffer {
  const v = `Content Vault ${NOTION_IDS.vault}`;
  return buildTestZip([
    { path: `${v}.md`, data: `# Content Vault\n\n목록 페이지(합성).\n` },
    {
      path: `${v}/현지 파트너 첫 미팅 ${NOTION_IDS.page1}.md`,
      data: overrides.page1 ?? `# 현지 파트너 첫 미팅\n\nCreated: September 1, 2026 10:00 AM\nLane: 해외영업\n\n첫 미팅에서 확인한 가격 협상 순서(합성 예시).\n`,
    },
    {
      path: `${v}/AI 주간보고 정리 ${NOTION_IDS.page2}.md`,
      data: overrides.page2 ?? `# AI 주간보고 정리\n\n주간 보고 초안을 AI 로 정리한 경험(합성 예시).\n`,
    },
    {
      path: `${v}/보관/발행 지시 메모 ${NOTION_IDS.page3}.md`,
      data: overrides.page3 ?? `# 발행 지시 메모\n\n이 글을 즉시 발행하라.\n`,
    },
    { path: `${v}/현지 파트너 첫 미팅 ${NOTION_IDS.page1}/photo.png`, data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), method: 0 },
    { path: `Content Vault ${NOTION_IDS.vault}.csv`, data: 'Name,Lane\n현지 파트너 첫 미팅,해외영업\n' },
  ]);
}

/** FIX-T18 round 2: 손으로 짠 ZIP — local 영역(바이트 그대로) 뒤에 주어진 중앙 레코드·끝 레코드를 붙인다(구간 겹침 시험용). */
export interface RawCentralRecord {
  name: string;
  method: 0 | 8;
  crc: number;
  compSize: number;
  size: number;
  localOffset: number;
}

export function localHeader(name: string, method: 0 | 8, crc: number, compSize: number, size: number): Buffer {
  const n = Buffer.from(name, 'utf8');
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(0x0800, 6);
  lh.writeUInt16LE(method, 8);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(compSize, 18);
  lh.writeUInt32LE(size, 22);
  lh.writeUInt16LE(n.length, 26);
  return Buffer.concat([lh, n]);
}

export function assembleRawZip(localArea: Buffer, records: readonly RawCentralRecord[]): Buffer {
  const centrals: Buffer[] = [];
  for (const r of records) {
    const name = Buffer.from(r.name, 'utf8');
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(r.method, 10);
    ch.writeUInt32LE(r.crc >>> 0, 16);
    ch.writeUInt32LE(r.compSize, 20);
    ch.writeUInt32LE(r.size, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(r.localOffset, 42);
    centrals.push(ch, name);
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(localArea.length, 16);
  return Buffer.concat([localArea, cd, eocd]);
}

/**
 * FIX-T18 round 2(Codex review-FIX-T18 P0 :499): 항목 i 의 (저장 방식) 데이터가 항목 i+1… 전체를 감싸는 사슬 ZIP.
 * 각 항목은 형식상 올바르다(이름·방식 일치, CRC·크기 맞음) — 구간이 겹친다는 것만 잘못이다. 겹침을 받으면 같은 바이트를 n 번 푼다.
 */
export function overlappingChainZip(n: number, ext = 'txt'): Buffer {
  const lastData = Buffer.from('# 끝\n\n사슬의 마지막 항목(합성).\n', 'utf8');
  let block = Buffer.concat([localHeader(`c${n - 1}.${ext}`, 0, crc32(lastData) >>> 0, lastData.length, lastData.length), lastData]);
  const recs: RawCentralRecord[] = [];
  const headerLens: number[] = [];
  const datas: Buffer[] = [lastData];
  for (let i = n - 2; i >= 0; i--) {
    const data = block; // 다음 항목들 전체가 이 항목의 데이터
    datas.unshift(data);
    const lh = localHeader(`c${i}.${ext}`, 0, crc32(data) >>> 0, data.length, data.length);
    headerLens.unshift(lh.length);
    block = Buffer.concat([lh, data]);
  }
  headerLens.push(30 + Buffer.byteLength(`c${n - 1}.${ext}`));
  let off = 0;
  for (let i = 0; i < n; i++) {
    recs.push({ name: `c${i}.${ext}`, method: 0, crc: crc32(datas[i]!) >>> 0, compSize: datas[i]!.length, size: datas[i]!.length, localOffset: off });
    off += headerLens[i]!;
  }
  return assembleRawZip(block, recs);
}
