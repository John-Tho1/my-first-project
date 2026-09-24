/**
 * T04 콘텐츠 카드: 생성(수동)·소재에서 카드로·수정 CAS(409)·연결 소재(junction)·owner 제한(A01, FK)·목록 cursor·카드→원고.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, createIdea, getDb, linkIdeaCaptures, schema, seed, type Db } from '@cs/db';
import { loadConfig } from '@cs/domain';
import { POST as captureIdeasPOST } from '../../apps/web/app/api/captures/[id]/ideas/route';
import { POST as ideaContentsPOST } from '../../apps/web/app/api/ideas/[id]/contents/route';
import { GET as ideaGET, PATCH as ideaPATCH, POST as ideaFormPOST } from '../../apps/web/app/api/ideas/[id]/route';
import { GET as ideasGET, POST as ideasPOST } from '../../apps/web/app/api/ideas/route';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const A = 'owner@example.local';
const B = 'other@example.local';

let db: Db;
let ownerA: string;
let ownerB: string;
let tokenA: string;
let tokenB: string;
let fx001: string;
let fx004: string;
let captureB: string;

const as = (identity: string) => vi.stubEnv('AUTH_ALLOWED_IDENTITY', identity);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

type IdeaJson = { idea: { id: string; revision: number; idea: string; tags: string[]; capture_ids?: string[]; evidence: string | null } };

const captureIdByKey = async (ownerId: string, key: string) =>
  (
    await db
      .select({ id: schema.captures.id })
      .from(schema.captures)
      .where(and(eq(schema.captures.ownerId, ownerId), eq(schema.captures.commandKey, key)))
  )[0]!.id;

function patchIdea(id: string, body: unknown, headers: Record<string, string> = {}, token = tokenA) {
  return ideaPATCH(
    new Request(`${BASE}/api/ideas/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...ORIGIN_HEADERS, ...cookieHeader(token), ...headers },
      body: JSON.stringify(body),
    }),
    ctx(id),
  );
}

const getIdeaRes = (id: string, token = tokenA) =>
  ideaGET(new Request(`${BASE}/api/ideas/${id}`, { headers: cookieHeader(token) }), ctx(id));

beforeAll(async () => {
  db = (await getDb(loadConfig())).db;
  ownerA = (await seed(db, { allowedIdentity: A })).ownerId;
  ownerB = (await seed(db, { allowedIdentity: B })).ownerId;
  fx001 = await captureIdByKey(ownerA, 'fx-001');
  fx004 = await captureIdByKey(ownerA, 'fx-004');
  captureB = await captureIdByKey(ownerB, 'fx-004');
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

describe('카드 생성·조회', () => {
  it('POST /api/ideas → 201, Idea/Audience/Evidence/Risk/Next Decision·태그 저장, junction 연결', async () => {
    const res = await ideasPOST(
      jsonPost(
        '/api/ideas',
        {
          idea: '재고 리스크 합의를 먼저 하면 회의가 짧아진다',
          audience: '해외 영업 관리자',
          evidence: '분기 판매계획 회의 메모(가상)',
          risk: 'needs_check',
          next_decision: '연재 1편으로 쓸지 결정',
          tags: ['영업', '회의', '영업'],
          capture_ids: [fx001, fx001.toUpperCase()],
        },
        cookieHeader(tokenA),
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as IdeaJson;
    expect(body.idea.revision).toBe(1);
    expect(body.idea.tags).toEqual(['영업', '회의']);
    const links = await db.select().from(schema.ideaCaptures).where(eq(schema.ideaCaptures.ideaId, body.idea.id));
    expect(links.map((l) => l.captureId)).toEqual([fx001]);

    const got = await getIdeaRes(body.idea.id);
    expect(got.status).toBe(200);
    expect(got.headers.get('etag')).toBe('"1"');
    const d = (await got.json()) as { idea: { next_decision: string; capture_ids: string[] }; captures: Array<{ id: string }> };
    expect(d.idea.next_decision).toBe('연재 1편으로 쓸지 결정');
    expect(d.captures.map((c) => c.id)).toEqual([fx001]);
  });

  it('검증: 빈 idea·11개 태그·31자 태그·잘못된 risk → 400', async () => {
    for (const bad of [
      { idea: '   ' },
      { idea: 'x', tags: Array.from({ length: 11 }, (_, i) => `t${i}`) },
      { idea: 'x', tags: ['가'.repeat(31)] },
      { idea: 'x', risk: 'high' },
      { idea: 'x', extra: 1 },
    ]) {
      const res = await ideasPOST(jsonPost('/api/ideas', bad, cookieHeader(tokenA)));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('POST /api/captures/{id}/ideas → 201, 소재가 연결된 카드. 폼은 303 → /ideas/{id}?saved=1', async () => {
    const res = await captureIdeasPOST(jsonPost(`/api/captures/${fx004}/ideas`, { idea: 'AI 요약과 원문 보존' }, cookieHeader(tokenA)), ctx(fx004));
    expect(res.status).toBe(201);
    const body = (await res.json()) as IdeaJson;
    expect(body.idea.capture_ids).toEqual([fx004]);
    const form = await captureIdeasPOST(
      new Request(`${BASE}/api/captures/${fx004}/ideas`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', ...ORIGIN_HEADERS, ...cookieHeader(tokenA) },
        body: new URLSearchParams({ idea: '폼으로 만든 카드', tags: '가, 나' }).toString(),
      }),
      ctx(fx004),
    );
    expect(form.status).toBe(303);
    expect(form.headers.get('location')).toMatch(/^\/ideas\/[0-9a-f-]{36}\?saved=1$/);
  });
});

describe('카드 수정 CAS', () => {
  let id: string;
  beforeAll(async () => {
    id = (await createIdea(db, ownerA, { idea: '수정 테스트 카드', capture_ids: [fx001] })).id;
  });

  it('If-Match "1" → 200 etag "2", 같은 If-Match → 409 current/yours(제출 값 보존)', async () => {
    const r = await patchIdea(id, { evidence: '근거 추가', capture_ids: [fx004] }, { 'if-match': '"1"' });
    expect(r.status).toBe(200);
    expect(r.headers.get('etag')).toBe('"2"');
    const links = await db.select().from(schema.ideaCaptures).where(eq(schema.ideaCaptures.ideaId, id));
    expect(links.map((l) => l.captureId)).toEqual([fx004]);
    const stale = await patchIdea(id, { evidence: '늦게 쓴 근거' }, { 'if-match': '"1"' });
    expect(stale.status).toBe(409);
    const c = (await stale.json()) as { current: { revision: number; evidence: string }; yours: { evidence: string } };
    expect(c.current).toMatchObject({ revision: 2, evidence: '근거 추가' });
    expect(c.yours.evidence).toBe('늦게 쓴 근거');
  });

  it('바꿀 항목 없음 → 400, 폼 충돌 → 409 HTML(내 입력 채움), 폼 성공 → 303', async () => {
    expect((await patchIdea(id, { expected_revision: 2 })).status).toBe(400);
    const form = (fields: Record<string, string>) =>
      ideaFormPOST(
        new Request(`${BASE}/api/ideas/${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', ...ORIGIN_HEADERS, ...cookieHeader(tokenA) },
          body: new URLSearchParams(fields).toString(),
        }),
        ctx(id),
      );
    const stale = await form({ _method: 'PATCH', expected_revision: '1', idea: '폼 늦은 카드 <b>', audience: '', evidence: '', risk: 'none', next_question: '', next_decision: '', tags: '' });
    expect(stale.status).toBe(409);
    const html = await stale.text();
    expect(html).toContain('폼 늦은 카드 &lt;b&gt;');
    expect(html).toContain('name="expected_revision" value="2"');
    const ok = await form({ _method: 'PATCH', expected_revision: '2', idea: '폼 카드', audience: '', evidence: '', risk: 'none', next_question: '', next_decision: '결정', tags: 'x' });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe(`/ideas/${id}?updated=3`);
  });
});

describe('owner 제한(A01)', () => {
  let idA: string;
  beforeAll(async () => {
    idA = (await createIdea(db, ownerA, { idea: 'A 의 카드' })).id;
  });

  it('B 는 A 의 카드를 읽기·수정·원고 시작 못 한다(404)', async () => {
    as(B);
    expect((await getIdeaRes(idA, tokenB)).status).toBe(404);
    expect((await patchIdea(idA, { expected_revision: 1, idea: 'x' }, {}, tokenB)).status).toBe(404);
    const start = await ideaContentsPOST(jsonPost(`/api/ideas/${idA}/contents`, {}, cookieHeader(tokenB)), ctx(idA));
    expect(start.status).toBe(404);
  });

  it('B 는 A 의 소재를 카드에 연결 못 한다(404), 확인을 건너뛴 삽입은 복합 FK 가 막는다', async () => {
    as(B);
    const res = await ideasPOST(jsonPost('/api/ideas', { idea: 'x', capture_ids: [fx001] }, cookieHeader(tokenB)));
    expect(res.status).toBe(404);
    const viaCapture = await captureIdeasPOST(jsonPost(`/api/captures/${fx001}/ideas`, { idea: 'x' }, cookieHeader(tokenB)), ctx(fx001));
    expect(viaCapture.status).toBe(404);
    const own = await createIdea(db, ownerB, { idea: 'B 카드', capture_ids: [captureB] });
    let msg = '';
    try {
      await linkIdeaCaptures(db, ownerB, own.id, [fx001]);
    } catch (e) {
      const err = e as { message?: string; cause?: { message?: string } };
      msg = `${err.message} ${err.cause?.message ?? ''}`;
    }
    expect(msg).toMatch(/idea_captures_capture_same_owner_fk/);
    const rows = await db.select().from(schema.ideaCaptures).where(eq(schema.ideaCaptures.ideaId, own.id));
    expect(rows.map((r) => r.captureId)).toEqual([captureB]);
    expect(ownerB).not.toBe(ownerA);
  });
});

describe('목록·카드 → 원고', () => {
  it('GET /api/ideas cursor 로 누락·중복 없이, 다른 owner 카드는 없음', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const url: string = `${BASE}/api/ideas?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await ideasGET(new Request(url, { headers: cookieHeader(tokenA) }), undefined);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<{ id: string }>; next_cursor: string | null };
      seen.push(...body.items.map((i) => i.id));
      cursor = body.next_cursor;
    } while (cursor && ++guard < 20);
    const all = await db.select({ id: schema.ideas.id }).from(schema.ideas).where(eq(schema.ideas.ownerId, ownerA));
    expect(new Set(seen)).toEqual(new Set(all.map((r) => r.id)));
    expect(seen).toHaveLength(all.length);
  });

  it('POST /api/ideas/{id}/contents → 201, idea_id 연결·카드 소재가 원문으로·카드 항목 인용 본문', async () => {
    const idea = await createIdea(db, ownerA, {
      idea: '주재원 첫 달의 역할 정의',
      audience: '해외 부임 예정자',
      next_decision: '경험담 확인 후 작성',
      tags: ['주재원'],
      capture_ids: [fx001, fx004],
    });
    const res = await ideaContentsPOST(jsonPost(`/api/ideas/${idea.id}/contents`, {}, cookieHeader(tokenA)), ctx(idea.id));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      content: { id: string; idea_id: string; title: string; tags: string[] };
      version: { body: string };
      capture_ids: string[];
    };
    expect(body.content.idea_id).toBe(idea.id);
    expect(body.content.title).toBe('주재원 첫 달의 역할 정의');
    expect(body.content.tags).toEqual(['주재원']);
    expect(new Set(body.capture_ids)).toEqual(new Set([fx001, fx004]));
    expect(body.version.body).toContain('> 카드: 주재원 첫 달의 역할 정의');
    expect(body.version.body).toContain('> 다음 결정: 경험담 확인 후 작성');
    const got = (await (await getIdeaRes(idea.id)).json()) as { contents: Array<{ id: string }> };
    expect(got.contents.map((c) => c.id)).toEqual([body.content.id]);
  });
});
