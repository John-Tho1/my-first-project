/**
 * T04 원고: 소재 → 원고(버전 1·원문 연결), 버전 추가(base_version)·충돌(A02), 불변 버전 트리거, 메타데이터 CAS·상태 전이,
 * owner 제한(A01: 읽기·수정·연결·FK), 목록 필터·cursor, diff·버전 조회, 폼 경로(303·409 비교 화면).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, count, eq, sql } from 'drizzle-orm';
import { closeDb, createContent, getDb, linkContentCaptures, schema, seed, type Db } from '@cs/db';
import { loadConfig } from '@cs/domain';
import { POST as captureContentsPOST } from '../../apps/web/app/api/captures/[id]/contents/route';
import { GET as diffGET } from '../../apps/web/app/api/contents/[id]/diff/route';
import { GET as contentGET, PATCH as contentPATCH, POST as contentFormPOST } from '../../apps/web/app/api/contents/[id]/route';
import { GET as versionGET } from '../../apps/web/app/api/contents/[id]/versions/[n]/route';
import { GET as versionsGET, POST as versionsPOST } from '../../apps/web/app/api/contents/[id]/versions/route';
import { GET as contentsGET, POST as contentsPOST } from '../../apps/web/app/api/contents/route';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const A = 'owner@example.local';
const B = 'other@example.local';

let db: Db;
let ownerA: string;
let ownerB: string;
let tokenA: string;
let tokenB: string;
let fx001: string;
let fx007: string;
let captureB: string;

const as = (identity: string) => vi.stubEnv('AUTH_ALLOWED_IDENTITY', identity);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

type ContentJson = {
  content: { id: string; title: string; revision: number; lifecycle: string; current_version_id: string; tags: string[]; series: string | null };
  version: { version: number; body: string; id: string };
  capture_ids: string[];
};

async function fromCapture(captureId: string, token = tokenA) {
  return captureContentsPOST(jsonPost(`/api/captures/${captureId}/contents`, {}, cookieHeader(token)), ctx(captureId));
}

function appendVersion(id: string, body: unknown, token = tokenA) {
  return versionsPOST(jsonPost(`/api/contents/${id}/versions`, body, cookieHeader(token)), ctx(id));
}

function getContent(id: string, token = tokenA) {
  return contentGET(new Request(`${BASE}/api/contents/${id}`, { headers: cookieHeader(token) }), ctx(id));
}

function patchContent(id: string, body: unknown, headers: Record<string, string> = {}, token = tokenA) {
  return contentPATCH(
    new Request(`${BASE}/api/contents/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...ORIGIN_HEADERS, ...cookieHeader(token), ...headers },
      body: JSON.stringify(body),
    }),
    ctx(id),
  );
}

function formPost(path: string, fields: Record<string, string>, token = tokenA): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html,application/xhtml+xml',
      ...ORIGIN_HEADERS,
      ...cookieHeader(token),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

async function createDirect(body: Record<string, unknown>, token = tokenA) {
  const res = await contentsPOST(jsonPost('/api/contents', body, cookieHeader(token)));
  expect(res.status).toBe(201);
  return (await res.json()) as ContentJson;
}

/** drizzle 은 PG 오류를 cause 에 담는다 — 원래 메시지를 꺼낸다. 성공하면 null. */
async function pgError(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return `${err.message ?? ''} ${err.cause?.message ?? ''}`;
  }
}

const versionCount = async (contentId: string) =>
  (await db.select({ n: count() }).from(schema.contentVersions).where(eq(schema.contentVersions.contentId, contentId)))[0]!.n;

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
  ownerB = (await seed(db, { allowedIdentity: B })).ownerId;
  fx001 = await captureIdByKey(ownerA, 'fx-001');
  fx007 = await captureIdByKey(ownerA, 'fx-007');
  captureB = await captureIdByKey(ownerB, 'fx-001');
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

describe('소재 → 원고, 버전 추가·충돌', () => {
  let contentId: string;

  it('POST /api/captures/{id}/contents → 201, 버전 1, 원문 인용 본문, origin 연결, audit', async () => {
    const res = await fromCapture(fx007);
    expect(res.status).toBe(201);
    const body = (await res.json()) as ContentJson;
    contentId = body.content.id;
    expect(body.version.version).toBe(1);
    expect(body.content.current_version_id).toBe(body.version.id);
    expect(body.content.lifecycle).toBe('draft');
    expect(body.version.body.startsWith('> 원문:\n> 주재원으로 처음 부임하면')).toBe(true);
    expect(body.content.title.startsWith('주재원으로 처음 부임하면')).toBe(true);
    expect(body.capture_ids).toEqual([fx007]);
    const links = await db.select().from(schema.contentCaptures).where(eq(schema.contentCaptures.contentId, contentId));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ captureId: fx007, ownerId: ownerA, role: 'origin' });
    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.entityId, contentId), eq(schema.auditEvents.action, 'content.create')));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.sanitizedDetails)).not.toContain('주재원');

    const detail = await getContent(contentId);
    expect(detail.status).toBe(200);
    expect(detail.headers.get('etag')).toBe('"1"');
    const d = (await detail.json()) as {
      current_version: { version: number };
      versions: Array<{ version: number; bytes: number }>;
      origin_captures: Array<{ id: string; raw_text: string }>;
    };
    expect(d.current_version.version).toBe(1);
    expect(d.versions).toHaveLength(1);
    expect(d.versions[0]!.bytes).toBeGreaterThan(0);
    expect(d.origin_captures.map((c) => c.id)).toEqual([fx007]);
  });

  it('base_version=1 → 201 버전 2, current 이동; 다시 base_version=1 → 409 current+yours, 버전은 여전히 2개', async () => {
    const r1 = await appendVersion(contentId, { base_version: 1, body: '첫 수정 본문\n둘째 줄', note: '초안 1차' });
    expect(r1.status).toBe(201);
    const v2 = (await r1.json()) as ContentJson;
    expect(v2.version.version).toBe(2);
    expect(v2.content.current_version_id).toBe(v2.version.id);

    const mine = '다른 탭에서 쓴 본문 — 잃으면 안 됨';
    const r2 = await appendVersion(contentId, { base_version: 1, body: mine });
    expect(r2.status).toBe(409);
    const c = (await r2.json()) as {
      error: string;
      current: { version: number; body: string };
      yours: { base_version: number; body: string };
    };
    expect(c.error).toBe('conflict');
    expect(c.current).toMatchObject({ version: 2, body: '첫 수정 본문\n둘째 줄' });
    expect(c.yours).toMatchObject({ base_version: 1, body: mine });
    expect(await versionCount(contentId)).toBe(2);

    const list = await versionsGET(new Request(`${BASE}/api/contents/${contentId}/versions`, { headers: cookieHeader(tokenA) }), ctx(contentId));
    const items = ((await list.json()) as { items: Array<{ version: number; note: string | null }> }).items;
    expect(items.map((i) => i.version)).toEqual([2, 1]);
    expect(items[0]!.note).toBe('초안 1차');
  });

  it('버전 조회는 불변 본문, diff 는 줄 단위', async () => {
    const v1 = await versionGET(new Request(`${BASE}/x`, { headers: cookieHeader(tokenA) }), {
      params: Promise.resolve({ id: contentId, n: '1' }),
    });
    expect(v1.status).toBe(200);
    expect(((await v1.json()) as { version: { body: string } }).version.body.startsWith('> 원문:')).toBe(true);
    const missing = await versionGET(new Request(`${BASE}/x`, { headers: cookieHeader(tokenA) }), {
      params: Promise.resolve({ id: contentId, n: '9' }),
    });
    expect(missing.status).toBe(404);

    const d = await diffGET(new Request(`${BASE}/api/contents/${contentId}/diff?from=1&to=2`, { headers: cookieHeader(tokenA) }), ctx(contentId));
    expect(d.status).toBe(200);
    const body = (await d.json()) as { stats: { added: number; removed: number }; lines: Array<{ type: string; text: string }> };
    expect(body.lines).toContainEqual({ type: 'add', text: '첫 수정 본문' });
    expect(body.lines.some((l) => l.type === 'del' && l.text.startsWith('> 원문:'))).toBe(true);
    const bad = await diffGET(new Request(`${BASE}/api/contents/${contentId}/diff?from=0&to=2`, { headers: cookieHeader(tokenA) }), ctx(contentId));
    expect(bad.status).toBe(400);
  });

  it('content_versions 직접 UPDATE·DELETE 는 트리거가 막는다(불변)', async () => {
    const upd = await pgError(db.execute(sql`update content_versions set body = 'x' where content_id = ${contentId}`));
    expect(upd).toMatch(/content_versions_immutable/);
    const del = await pgError(db.execute(sql`delete from content_versions where content_id = ${contentId}`));
    expect(del).toMatch(/content_versions_immutable/);
    const bodies = await db.select({ body: schema.contentVersions.body }).from(schema.contentVersions).where(eq(schema.contentVersions.contentId, contentId));
    expect(bodies.some((b) => b.body === 'x')).toBe(false);
    expect(await versionCount(contentId)).toBe(2);
  });

  it('폼: 저장 303 → saved_version, stale 폼은 409 비교 화면(두 본문 전체 + diff + 재저장 폼)', async () => {
    const ok = await versionsPOST(formPost(`/api/contents/${contentId}/versions`, { base_version: '2', body: '폼 저장 본문' }), ctx(contentId));
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe(`/contents/${contentId}?saved_version=3`);

    const mine = '<script>alert(1)</script> 내 본문\n'.repeat(3);
    const stale = await versionsPOST(formPost(`/api/contents/${contentId}/versions`, { base_version: '2', body: mine }), ctx(contentId));
    expect(stale.status).toBe(409);
    expect(stale.headers.get('content-type')).toContain('text/html');
    expect(stale.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await stale.text();
    expect(html).toContain('폼 저장 본문');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; 내 본문');
    expect(html).not.toContain('<script>');
    expect(html).toContain('name="base_version" value="3"');
    expect(html).toContain('class="add"');
    expect(await versionCount(contentId)).toBe(3);
  });
});

describe('메타데이터 CAS·상태 전이', () => {
  let id: string;
  beforeAll(async () => {
    id = (await createDirect({ title: '상태 테스트', body: '본문', series: '해외 사업·영업 운영', tags: ['영업', 'AI'] })).content.id;
  });

  it('If-Match 로 수정 → 200 etag "2"; 같은 If-Match 다시 → 409 current/yours', async () => {
    const r = await patchContent(id, { title: '바뀐 제목', tags: ['영업', ' 영업 ', 'AI'] }, { 'if-match': '"1"' });
    expect(r.status).toBe(200);
    expect(r.headers.get('etag')).toBe('"2"');
    const body = (await r.json()) as ContentJson;
    expect(body.content.tags).toEqual(['영업', 'AI']);
    const again = await patchContent(id, { title: '늦은 제목' }, { 'if-match': '"1"' });
    expect(again.status).toBe(409);
    const c = (await again.json()) as { current: { revision: number; title: string }; yours: { title: string } };
    expect(c.current).toMatchObject({ revision: 2, title: '바뀐 제목' });
    expect(c.yours.title).toBe('늦은 제목');
  });

  it('draft→ready 는 400 invalid_transition, published 는 400, draft→review→ready→archived→draft 는 허용', async () => {
    const bad = await patchContent(id, { expected_revision: 2, lifecycle: 'ready' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_transition');
    const pub = await patchContent(id, { expected_revision: 2, lifecycle: 'published' });
    expect(pub.status).toBe(400);
    let rev = 2;
    for (const next of ['review', 'ready', 'archived', 'draft']) {
      const r = await patchContent(id, { expected_revision: rev, lifecycle: next });
      expect(r.status, next).toBe(200);
      rev++;
    }
    // DB CHECK 도 published 를 막는다
    expect(await pgError(db.execute(sql`update contents set lifecycle = 'published' where id = ${id}`))).toMatch(/contents_lifecycle_chk/);
  });

  it('PATCH 로 본문은 못 바꾼다(400), 폼 경로 _method 없으면 405, 폼 충돌은 409 HTML', async () => {
    const r = await patchContent(id, { expected_revision: 6, body: 'x' });
    expect(r.status).toBe(400);
    const no = await contentFormPOST(formPost(`/api/contents/${id}`, { title: 'x' }), ctx(id));
    expect(no.status).toBe(405);
    const stale = await contentFormPOST(
      formPost(`/api/contents/${id}`, { _method: 'PATCH', expected_revision: '1', title: '폼 늦은 제목', lifecycle: 'draft', tags: 'a' }),
      ctx(id),
    );
    expect(stale.status).toBe(409);
    const html = await stale.text();
    expect(html).toContain('폼 늦은 제목');
    expect(html).toContain('name="expected_revision" value="6"');
    const ok = await contentFormPOST(
      formPost(`/api/contents/${id}`, { _method: 'PATCH', expected_revision: '6', title: '폼 제목', series: '', audience: '', tags: 'x, y', lifecycle: 'draft' }),
      ctx(id),
    );
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe(`/contents/${id}?meta_updated=7`);
  });
});

describe('owner 제한(A01)', () => {
  let idA: string;
  beforeAll(async () => {
    idA = (await createDirect({ title: 'A 의 원고', body: 'A 본문', capture_ids: [fx001] })).content.id;
  });

  it('B 는 A 의 원고를 읽기·수정·버전 추가·diff 할 수 없다(404)', async () => {
    as(B);
    expect((await getContent(idA, tokenB)).status).toBe(404);
    expect((await patchContent(idA, { expected_revision: 1, title: 'x' }, {}, tokenB)).status).toBe(404);
    expect((await appendVersion(idA, { base_version: 1, body: 'x' }, tokenB)).status).toBe(404);
    const d = await diffGET(new Request(`${BASE}/api/contents/${idA}/diff?from=1&to=1`, { headers: cookieHeader(tokenB) }), ctx(idA));
    expect(d.status).toBe(404);
    expect(await versionCount(idA)).toBe(1);
  });

  it('B 는 A 의 소재로 원고를 시작·연결할 수 없다(404), 검사를 건너뛴 삽입은 복합 FK 가 막는다', async () => {
    as(B);
    expect((await fromCapture(fx001, tokenB)).status).toBe(404);
    const res = await contentsPOST(jsonPost('/api/contents', { title: 't', body: 'b', capture_ids: [fx001] }, cookieHeader(tokenB)));
    expect(res.status).toBe(404);
    // B 의 원고에 A 의 capture 를 직접 연결 시도(owner 확인 없이) → FK 위반
    const own = await createContent(db, ownerB, { title: 'B 원고', body: 'b', captureIds: [captureB] });
    expect(await pgError(linkContentCaptures(db, ownerB, own.content.id, [fx001]))).toMatch(/content_captures_capture_same_owner_fk/);
    // owner_id 를 A 로 속여도 (content, owner) FK 가 막는다
    expect(
      await pgError(db.insert(schema.contentCaptures).values({ contentId: own.content.id, captureId: fx001, ownerId: ownerA })),
    ).toMatch(/content_captures_content_same_owner_fk/);
  });
});

describe('목록 필터·cursor', () => {
  it('12개 원고를 5개씩 cursor 로 누락·중복 없이 넘기고, series·tag·lifecycle 로 거른다', async () => {
    const C = 'pager2@example.local';
    as(C);
    const tokenC = await login(C);
    const ids = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const res = await contentsPOST(
        jsonPost(
          '/api/contents',
          { title: `페이지 ${i}`, body: `본문 ${i}`, series: i % 2 ? '홀수 연재' : '짝수 연재', tags: i % 3 === 0 ? ['셋'] : [] },
          cookieHeader(tokenC),
        ),
      );
      expect(res.status).toBe(201);
      ids.add(((await res.json()) as ContentJson).content.id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `${BASE}/api/contents?limit=5${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await contentsGET(new Request(url, { headers: cookieHeader(tokenC) }), undefined);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<{ id: string }>; next_cursor: string | null };
      seen.push(...body.items.map((i) => i.id));
      cursor = body.next_cursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(12);
    expect(new Set(seen)).toEqual(ids);

    const list = async (q: string) =>
      ((await (await contentsGET(new Request(`${BASE}/api/contents?${q}`, { headers: cookieHeader(tokenC) }), undefined)).json()) as {
        items: Array<{ id: string; title: string }>;
      }).items;
    expect(await list(`series=${encodeURIComponent('홀수 연재')}`)).toHaveLength(6);
    expect(await list(`tag=${encodeURIComponent('셋')}`)).toHaveLength(4);
    expect(await list('lifecycle=draft')).toHaveLength(12);
    expect(await list('lifecycle=review')).toHaveLength(0);
    const bad = await contentsGET(new Request(`${BASE}/api/contents?lifecycle=published`, { headers: cookieHeader(tokenC) }), undefined);
    expect(bad.status).toBe(400);
    // 다른 owner(A) 의 원고는 섞이지 않는다
    expect((await list('limit=50')).every((i) => i.title.startsWith('페이지 '))).toBe(true);
  });
});
