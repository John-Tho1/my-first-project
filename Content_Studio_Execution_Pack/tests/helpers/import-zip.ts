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
}

export function buildTestZip(entries: readonly TestZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : Buffer.from(e.data);
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.path, 'utf8');
    const crc = crc32(raw) >>> 0;
    const size = e.declaredSize ?? raw.length;
    const flags = 0x0800 | (e.encrypted ? 1 : 0);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, body);
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
    offset += 30 + name.length + body.length;
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
