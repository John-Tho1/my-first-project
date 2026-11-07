/**
 * T04 검색(결정 D5): 한국어 부분 문자열("주재원", "재고 리스")·영문 대소문자 무시·빈 결과·owner 제한(A01)·필터·종류별 cursor.
 * 영문 FTS 만으로 충분하다고 가정하지 않는다(docs/05 M1) — 한국어 질의를 별도로 확인한다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { appendContentVersion, closeDb, createCapture, createContent, createIdea, getDb, schema, seed, type Db } from '@cs/db';
import { loadConfig } from '@cs/domain';
import { GET as searchGET } from '../../apps/web/app/api/search/route';
import { BASE, cookieHeader, login } from './helpers';

const A = 'owner@example.local';
const B = 'other-search@example.local';

let db: Db;
let ownerA: string;
let ownerB: string;
let tokenA: string;
let tokenB: string;
let fx001: string;
let fx007: string;
let otherCaptureB: string;

const as = (identity: string) => vi.stubEnv('AUTH_ALLOWED_IDENTITY', identity);

type Item = { kind: string; id: string; title: string; snippet: string; matched_field: string | null; score: number | null };
type Result = { items: Item[]; next_cursor: string | null; more?: Record<string, boolean> };

async function find(query: Record<string, string>, token = tokenA): Promise<Result> {
  const res = await searchGET(new Request(`${BASE}/api/search?${new URLSearchParams(query)}`, { headers: cookieHeader(token) }), undefined);
  expect(res.status, JSON.stringify(query)).toBe(200);
  return (await res.json()) as Result;
}

const captureIdByKey = async (ownerId: string, key: string) =>
  (
    await db
      .select({ id: schema.captures.id })
      .from(schema.captures)
      .where(and(eq(schema.captures.ownerId, ownerId), eq(schema.captures.commandKey, key)))
  )[0]!.id;

beforeAll(async () => {
  db = (await getDb(loadConfig())).db;
  ownerA = (await seed(db, { allowedIdentity: A })).ownerId;
  fx001 = await captureIdByKey(ownerA, 'fx-001');
  fx007 = await captureIdByKey(ownerA, 'fx-007');
  // 두 번째 owner: 같은 검색어("주재원", "재고 리스")를 담은 소재 — A 의 검색에 절대 나오면 안 된다.
  const b = await db.insert(schema.users).values({ allowedIdentity: B }).returning();
  ownerB = b[0]!.id;
  otherCaptureB = (
    await createCapture(db, ownerB, {
      input_type: 'text',
      raw_text: 'B 의 비공개 메모: 주재원 재고 리스크 AI',
      command_key: 'search-b-0001',
    })
  ).capture.id;

  // A 의 원고·카드
  const c1 = await createContent(db, ownerA, {
    title: '주재원 첫 달',
    body: '본사와 현지 법인 사이에서 번역하는 사람.',
    series: '해외·주재원·조직 차이 경험',
    tags: ['주재원', '조직'],
    captureIds: [fx007],
  });
  await appendContentVersion(db, ownerA, c1.content.id, { baseVersion: 1, body: '두 번째 버전: Expat 의 역할 정의' });
  await createContent(db, ownerA, { title: 'AI 견적 메일', body: '가격·납기 숫자는 빈칸으로.', series: '전문성의 AI 적용', tags: ['AI'] });
  await createIdea(db, ownerA, { idea: '재고 리스크를 누가 지는가', evidence: '분기 회의 메모', tags: ['영업'], capture_ids: [fx001], risk: 'needs_check' });

  as(A);
  tokenA = await login(A);
  as(B);
  tokenB = await login(B);
  as(A);
});
beforeEach(() => as(A));
afterAll(async () => {
  vi.unstubAllEnvs();
  await closeDb();
});

describe('한국어·영문 검색', () => {
  it('q=주재원 → fx-007 소재(조사 붙은 "주재원으로" 포함), 원고 제목도', async () => {
    const r = await find({ q: '주재원' });
    const caps = r.items.filter((i) => i.kind === 'capture');
    expect(caps.map((i) => i.id)).toContain(fx007);
    const hit = caps.find((i) => i.id === fx007)!;
    expect(hit.matched_field).toBe('raw_text');
    expect(hit.snippet).toContain('주재원으로 처음 부임하면');
    expect(r.items.some((i) => i.kind === 'content' && i.title === '주재원 첫 달')).toBe(true);
    expect(r.items.map((i) => i.id)).not.toContain(otherCaptureB);
  });

  it('q=재고 리스 → fx-001 소재와 카드', async () => {
    const r = await find({ q: '재고 리스' });
    expect(r.items.filter((i) => i.kind === 'capture').map((i) => i.id)).toContain(fx001);
    expect(r.items.some((i) => i.kind === 'idea' && i.snippet.includes('재고 리스크'))).toBe(true);
    expect(r.items.map((i) => i.id)).not.toContain(otherCaptureB);
  });

  it('q=ai(소문자) 는 "AI" 를 대소문자 무시로 찾는다 — 2건 이상, 점수(pg_trgm) 포함', async () => {
    const r = await find({ q: 'ai' });
    expect(r.items.length).toBeGreaterThanOrEqual(2);
    expect(r.items.filter((i) => i.kind === 'capture').length).toBeGreaterThanOrEqual(2);
    expect(r.items.every((i) => typeof i.score === 'number')).toBe(true);
  });

  it('현재 버전 본문으로 찾는다(이전 버전만 있는 문구는 안 걸림)', async () => {
    const r = await find({ q: 'expat', type: 'contents' });
    expect(r.items.map((i) => i.title)).toEqual(['주재원 첫 달']);
    expect(r.items[0]!.matched_field).toBe('body');
    const old = await find({ q: '번역하는 사람', type: 'contents' });
    expect(old.items).toHaveLength(0);
  });

  it('일치 없음 → 빈 결과, %·_ 는 문자 그대로', async () => {
    expect((await find({ q: '존재하지않는검색어xyz' })).items).toHaveLength(0);
    expect((await find({ q: '%' })).items).toHaveLength(0);
    expect((await find({ q: '_' })).items).toHaveLength(0);
  });

  it('B 는 자기 소재만 찾는다(A01)', async () => {
    as(B);
    const r = await find({ q: '주재원' }, tokenB);
    expect(r.items.map((i) => i.id)).toEqual([otherCaptureB]);
  });
});

describe('필터·페이지', () => {
  it('series·tag·lifecycle·risk·기간 필터', async () => {
    const bySeries = await find({ series: '전문성의 AI 적용' });
    expect(bySeries.items.map((i) => i.title)).toEqual(['AI 견적 메일']);
    const byTag = await find({ tag: '주재원' });
    expect(byTag.items.map((i) => `${i.kind}:${i.title}`)).toEqual(['content:주재원 첫 달']);
    const byTagIdea = await find({ tag: '영업' });
    expect(byTagIdea.items.map((i) => i.kind)).toEqual(['idea']);
    const byLifecycle = await find({ lifecycle: 'review' });
    expect(byLifecycle.items).toHaveLength(0);
    const draft = await find({ lifecycle: 'draft', type: 'contents' });
    expect(draft.items).toHaveLength(2);
    const risky = await find({ risk: 'needs_check', type: 'captures' });
    expect(risky.items.length).toBe(5); // 픽스처 needs_check 5건(fx-002·003·006·008·010)
    const range = await find({ type: 'captures', from: '2026-09-15', to: '2026-09-15' });
    expect(range.items.map((i) => i.id)).toEqual([fx007]); // 2026-09-15 05:40Z = 08:40 MSK
  });

  it('잘못된 입력 → 400(type·lifecycle=published·날짜·type=all 에 cursor)', async () => {
    for (const q of ['type=x', 'lifecycle=published', 'from=2026-13-01', 'cursor=abc', 'limit=0', `q=${'가'.repeat(201)}`]) {
      const res = await searchGET(new Request(`${BASE}/api/search?${q}`, { headers: cookieHeader(tokenA) }), undefined);
      expect(res.status, q).toBe(400);
    }
  });

  it('type=captures cursor 로 10건을 4건씩 누락·중복 없이', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await find({ type: 'captures', limit: '4', ...(cursor ? { cursor } : {}) });
      seen.push(...r.items.map((i) => i.id));
      cursor = r.next_cursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10);
    const all = await find({ limit: '2' });
    expect(all.next_cursor).toBeNull();
    expect(all.more).toMatchObject({ captures: true });
  });
});
