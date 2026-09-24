/**
 * T03 수집: 저장·멱등·원문 불변·수정 충돌(A02)·중복 후보·추출 차단(A05)·A04·owner 제한(A01)·cursor 목록.
 * route handler 를 new Request(...) 로 직접 호출한다. 외부 fetch 는 전부 spy 로 0회임을 확인한다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, count, eq } from 'drizzle-orm';
import { closeDb, getDb, schema, seed, updateCapture, type Db } from '@cs/db';
import { loadConfig } from '@cs/domain';
import { DisabledPublisher } from '@cs/providers';
import { POST as extractPOST } from '../../apps/web/app/api/captures/[id]/extract/route';
import { GET as captureGET, PATCH as capturePATCH, POST as captureFormPOST } from '../../apps/web/app/api/captures/[id]/route';
import { GET as listGET, POST as capturesPOST } from '../../apps/web/app/api/captures/route';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const A = 'owner@example.local';
const B = 'other@example.local';
const C = 'pager@example.local';

let db: Db;
let ownerA: string;
let tokenA: string;
let tokenB: string;
let tokenC: string;
let seq = 0;
const key = () => `it-key-${String(++seq).padStart(4, '0')}`;

const as = (identity: string) => vi.stubEnv('AUTH_ALLOWED_IDENTITY', identity);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function create(body: Record<string, unknown>, token = tokenA): Promise<Response> {
  return capturesPOST(jsonPost('/api/captures', body, cookieHeader(token)));
}

async function createOk(body: Record<string, unknown>, token = tokenA) {
  const res = await create(body, token);
  expect(res.status).toBe(201);
  return (await res.json()) as {
    capture: { id: string; revision: number; raw_text: string; source_id: string | null; content_hash: string };
    created: boolean;
    duplicates: { exact: Array<{ id: string; reason: string }>; similar: Array<{ id: string; score: number }> };
  };
}

function get(id: string, token = tokenA) {
  return captureGET(new Request(`${BASE}/api/captures/${id}`, { headers: cookieHeader(token) }), ctx(id));
}

function patch(id: string, body: unknown, headers: Record<string, string> = {}, token = tokenA) {
  return capturePATCH(
    new Request(`${BASE}/api/captures/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...ORIGIN_HEADERS, ...cookieHeader(token), ...headers },
      body: JSON.stringify(body),
    }),
    ctx(id),
  );
}

function extract(id: string, token = tokenA) {
  return extractPOST(
    new Request(`${BASE}/api/captures/${id}/extract`, {
      method: 'POST',
      headers: { accept: 'application/json', ...ORIGIN_HEADERS, ...cookieHeader(token) },
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

const countWhere = async (table: typeof schema.captures | typeof schema.sources, ownerId: string) =>
  (await db.select({ n: count() }).from(table).where(eq(table.ownerId, ownerId)))[0]!.n;

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  db = (await getDb(loadConfig())).db;
  ownerA = (await seed(db, { allowedIdentity: A })).ownerId;
  as(A);
  tokenA = await login(A);
  as(B);
  tokenB = await login(B);
  as(C);
  tokenC = await login(C);
  as(A);
});
beforeEach(() => {
  as(A);
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  // 이 파일의 어떤 경로도 외부 fetch 를 하지 않는다(A05·수집 비활성).
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await closeDb();
});

describe('POST /api/captures — 저장·멱등', () => {
  it('텍스트 → 201, revision 1, content_hash, 이력 1행, audit capture.create(원문 미기록)', async () => {
    const k = key();
    const body = await createOk({ input_type: 'text', raw_text: '  현지 파트너와의 첫 미팅 메모  ', user_note: '왜: 연재 후보', command_key: k });
    expect(body.created).toBe(true);
    expect(body.capture.raw_text).toBe('  현지 파트너와의 첫 미팅 메모  '); // 원문 그대로(공백 포함)
    expect(body.capture.revision).toBe(1);
    expect(body.capture.content_hash).toMatch(/^[0-9a-f]{64}$/);
    const revs = await db.select().from(schema.captureRevisions).where(eq(schema.captureRevisions.captureId, body.capture.id));
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ revision: 1, userNote: '왜: 연재 후보', changedBy: 'owner' });
    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.action, 'capture.create'), eq(schema.auditEvents.entityId, body.capture.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.ownerId).toBe(ownerA);
    expect(JSON.stringify(audit[0]!.sanitizedDetails)).not.toContain('미팅');
  });

  it('같은 command_key 재요청 → 200 created:false, 같은 capture, 행·이력·audit 증가 없음', async () => {
    const k = key();
    const first = await createOk({ input_type: 'text', raw_text: '더블클릭 테스트', command_key: k });
    const before = {
      captures: await countWhere(schema.captures, ownerA),
      revs: (await db.select({ n: count() }).from(schema.captureRevisions))[0]!.n,
      audit: (await db.select({ n: count() }).from(schema.auditEvents).where(eq(schema.auditEvents.action, 'capture.create')))[0]!.n,
    };
    const res = await create({ input_type: 'text', raw_text: '더블클릭 테스트', command_key: k });
    expect(res.status).toBe(200);
    const again = await res.json();
    expect(again.created).toBe(false);
    expect(again.capture.id).toBe(first.capture.id);
    expect(await countWhere(schema.captures, ownerA)).toBe(before.captures);
    expect((await db.select({ n: count() }).from(schema.captureRevisions))[0]!.n).toBe(before.revs);
    expect(
      (await db.select({ n: count() }).from(schema.auditEvents).where(eq(schema.auditEvents.action, 'capture.create')))[0]!.n,
    ).toBe(before.audit);
  });

  it('URL 원문은 앞뒤 공백(ASCII·유니코드)까지 그대로 보존하고, 정규화·source 연결은 trim 된 값으로 한다', async () => {
    const raw = '  https://example.com/keep-ws/?utm_source=x  ';
    const saved = await createOk({ input_type: 'url', url: raw, command_key: key() });
    expect(saved.capture.raw_text).toBe(raw);
    const withNote = await createOk({ input_type: 'url', url: raw, raw_text: ' 메모 ', command_key: key() });
    expect(withNote.capture.raw_text).toBe(`${raw}
 메모 `);
    expect(withNote.capture.source_id).toBe(saved.capture.source_id); // 같은 정규화 URL → 같은 source
    const [src] = await db.select().from(schema.sources).where(eq(schema.sources.id, saved.capture.source_id!));
    expect(src!.normalizedUrl).toBe('https://example.com/keep-ws');
  });

  it('URL 수집은 sources 1행을 만들고, 추적 파라미터만 다른 같은 URL 은 source 공유 + 정확 중복(url)', async () => {
    const sourcesBefore = await countWhere(schema.sources, ownerA);
    const first = await createOk({
      input_type: 'url',
      url: 'https://example.com/guides/export-pricing/?utm_source=newsletter#top',
      raw_text: '수출 가격 책정 가이드',
      command_key: key(),
    });
    expect(first.capture.source_id).toBeTruthy();
    expect(first.capture.raw_text).toBe('https://example.com/guides/export-pricing/?utm_source=newsletter#top\n수출 가격 책정 가이드');
    expect(await countWhere(schema.sources, ownerA)).toBe(sourcesBefore + 1);
    const [src] = await db.select().from(schema.sources).where(eq(schema.sources.id, first.capture.source_id!));
    expect(src).toMatchObject({
      kind: 'url',
      canonicalUrl: 'https://example.com/guides/export-pricing/',
      normalizedUrl: 'https://example.com/guides/export-pricing',
    });

    const second = await createOk({
      input_type: 'url',
      url: 'https://EXAMPLE.com/guides/export-pricing?fbclid=xyz',
      command_key: key(),
    });
    expect(second.capture.source_id).toBe(first.capture.source_id);
    expect(await countWhere(schema.sources, ownerA)).toBe(sourcesBefore + 1);
    expect(second.duplicates.exact).toContainEqual({ id: first.capture.id, reason: 'url' });
  });

  it('같은 원문(공백·NFD 차이) → 정확 중복(content), 비슷한 한국어 문장 → 유사 후보', async () => {
    const base = await createOk({
      input_type: 'text',
      raw_text: '해외 법인 월간 보고에서 환율 가정과 실제 환율의 차이를 먼저 설명하면 질문이 줄어든다',
      command_key: key(),
    });
    const exact = await createOk({
      input_type: 'text',
      raw_text: '해외 법인 월간 보고에서   환율 가정과 실제 환율의 차이를\n먼저 설명하면 질문이 줄어든다'.normalize('NFD'),
      command_key: key(),
    });
    expect(exact.duplicates.exact).toContainEqual({ id: base.capture.id, reason: 'content' });
    expect(exact.duplicates.similar.map((s) => s.id)).not.toContain(base.capture.id); // 정확 중복은 유사 목록에 중복 표시하지 않음

    const similar = await createOk({
      input_type: 'text',
      raw_text: '해외 법인의 월간 보고 때 환율 가정과 실제 환율 차이를 먼저 설명하니 질문이 줄었다',
      command_key: key(),
    });
    expect(similar.duplicates.exact).toEqual([]);
    const hit = similar.duplicates.similar.find((s) => s.id === base.capture.id);
    expect(hit).toBeDefined();
    expect(hit!.score).toBeGreaterThanOrEqual(0.45);

    const unrelated = await createOk({ input_type: 'text', raw_text: '모스크바 겨울 출장 짐 목록: 방한화, 보조배터리', command_key: key() });
    expect(unrelated.duplicates.similar.map((s) => s.id)).not.toContain(base.capture.id);
  });

  it('입력 오류: 빈 원문 400, http(s) 아닌 URL 400 invalid_url, 짧은 command_key 400', async () => {
    expect((await create({ input_type: 'text', raw_text: '   ', command_key: key() })).status).toBe(400);
    const bad = await create({ input_type: 'url', url: 'file:///etc/passwd', command_key: key() });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('invalid_url');
    expect((await create({ input_type: 'text', raw_text: 'a', command_key: 'short' })).status).toBe(400);
  });

  it('로그인 없으면 401, Origin 없으면 403', async () => {
    const noCookie = await capturesPOST(jsonPost('/api/captures', { input_type: 'text', raw_text: 'x', command_key: key() }));
    expect(noCookie.status).toBe(401);
    const noOrigin = await capturesPOST(
      new Request(`${BASE}/api/captures`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...cookieHeader(tokenA) },
        body: JSON.stringify({ input_type: 'text', raw_text: 'x', command_key: key() }),
      }),
    );
    expect(noOrigin.status).toBe(403);
  });

  it('브라우저 폼: URL 칸이 비면 텍스트 수집, 303 → /captures/{id}?saved=1', async () => {
    const res = await capturesPOST(formPost('/api/captures', { raw_text: '폼으로 저장한 한 문장', url: '', user_note: '', command_key: crypto.randomUUID() }));
    expect(res.status).toBe(303);
    const loc = res.headers.get('location')!;
    expect(loc).toMatch(/^\/captures\/[0-9a-f-]{36}\?saved=1$/);
    const id = loc.split('/')[2]!.split('?')[0]!;
    const [row] = await db.select().from(schema.captures).where(eq(schema.captures.id, id));
    expect(row).toMatchObject({ inputType: 'text', rawText: '폼으로 저장한 한 문장', userNote: null });
    // 잘못된 URL → 고정 오류 코드로 되돌아감(입력값을 query 에 싣지 않음)
    const bad = await capturesPOST(formPost('/api/captures', { raw_text: 'x', url: 'ftp://example.com', command_key: crypto.randomUUID() }));
    expect(bad.headers.get('location')).toBe('/?capture_error=invalid_url');
  });
});

describe('PATCH /api/captures/{id} — 원문 불변·수정 충돌(A02)', () => {
  it('두 PATCH 가 같은 expected_revision → 두 번째 409 { current, yours }, 원문 불변, 이력은 정확히 1행 증가', async () => {
    const { capture } = await createOk({ input_type: 'text', raw_text: 'A02 원문 — 바뀌면 안 됨', user_note: '처음 메모', command_key: key() });
    const revsBefore = (await db.select().from(schema.captureRevisions).where(eq(schema.captureRevisions.captureId, capture.id))).length;

    const r1 = await patch(capture.id, { user_note: '탭 1 의 메모' }, { 'if-match': '"1"' });
    expect(r1.status).toBe(200);
    expect(r1.headers.get('etag')).toBe('"2"');
    expect((await r1.json()).capture).toMatchObject({ revision: 2, user_note: '탭 1 의 메모', raw_text: 'A02 원문 — 바뀌면 안 됨' });

    const r2 = await patch(capture.id, { expected_revision: 1, user_note: '탭 2 의 메모', risk: 'needs_check' });
    expect(r2.status).toBe(409);
    const conflict = await r2.json();
    expect(conflict.error).toBe('conflict');
    expect(conflict.message).toBe('다른 곳에서 먼저 수정되었습니다. 현재 내용과 비교한 뒤 다시 저장하세요.');
    expect(conflict.current).toMatchObject({ revision: 2, user_note: '탭 1 의 메모', risk: 'none' });
    expect(conflict.yours).toEqual({ expected_revision: 1, user_note: '탭 2 의 메모', risk: 'needs_check' });

    const [row] = await db.select().from(schema.captures).where(eq(schema.captures.id, capture.id));
    expect(row).toMatchObject({ rawText: 'A02 원문 — 바뀌면 안 됨', revision: 2, userNote: '탭 1 의 메모', risk: 'none' });
    const revs = await db.select().from(schema.captureRevisions).where(eq(schema.captureRevisions.captureId, capture.id));
    expect(revs.length - revsBefore).toBe(1);
    expect(revs.find((r) => r.revision === 1)!.userNote).toBe('처음 메모'); // 이전 값 보존
  });

  it('If-Match 헤더가 본문 expected_revision 보다 우선', async () => {
    const { capture } = await createOk({ input_type: 'text', raw_text: '헤더 우선 테스트', command_key: key() });
    await patch(capture.id, { title: 't2' }, { 'if-match': '"1"' });
    const stale = await patch(capture.id, { expected_revision: 2, title: 't3' }, { 'if-match': '"1"' });
    expect(stale.status).toBe(409);
    const ok = await patch(capture.id, { expected_revision: 1, title: 't3' }, { 'if-match': 'W/"2"' });
    expect(ok.status).toBe(200);
    expect(await patch(capture.id, { title: 'x' }, { 'if-match': '*' }).then((r) => r.status)).toBe(400);
  });

  it('raw_text 를 보내면 400 raw_text_immutable, 원문 그대로', async () => {
    const { capture } = await createOk({ input_type: 'text', raw_text: '불변 원문', command_key: key() });
    const res = await patch(capture.id, { expected_revision: 1, raw_text: '바꾼 원문', user_note: 'x' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('raw_text_immutable');
    const [row] = await db.select().from(schema.captures).where(eq(schema.captures.id, capture.id));
    expect(row).toMatchObject({ rawText: '불변 원문', revision: 1 });
  });

  it('seed 된(이력 없는) 행의 첫 수정은 이전 값(system)과 새 값(owner) 두 행을 남긴다', async () => {
    const [fx] = await db.select().from(schema.captures).where(and(eq(schema.captures.ownerId, ownerA), eq(schema.captures.commandKey, 'fx-002')));
    const updated = await updateCapture(db, ownerA, fx!.id, { risk: 'none' }, 1);
    expect(updated.revision).toBe(2);
    const revs = await db.select().from(schema.captureRevisions).where(eq(schema.captureRevisions.captureId, fx!.id));
    expect(revs.map((r) => [r.revision, r.changedBy, r.risk]).sort()).toEqual([
      [1, 'system', 'needs_check'],
      [2, 'owner', 'none'],
    ]);
  });

  it('브라우저 폼 수정: 성공 303 ?updated=2 / 충돌 303 ?conflict=1&y_… / 긴 입력 충돌은 409 HTML / _method 없으면 405', async () => {
    const { capture } = await createOk({ input_type: 'text', raw_text: '폼 수정 대상', command_key: key() });
    const path = `/api/captures/${capture.id}`;
    const ok = await captureFormPOST(formPost(path, { _method: 'PATCH', expected_revision: '1', user_note: '새 메모', title: '', risk: 'none' }), ctx(capture.id));
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe(`/captures/${capture.id}?updated=2`);

    const stale = await captureFormPOST(
      formPost(path, { _method: 'PATCH', expected_revision: '1', user_note: '내 메모 <b>', title: '제목', risk: 'needs_check' }),
      ctx(capture.id),
    );
    expect(stale.status).toBe(303);
    const loc = new URL(stale.headers.get('location')!, BASE);
    expect(loc.pathname).toBe(`/captures/${capture.id}`);
    expect(Object.fromEntries(loc.searchParams)).toEqual({
      conflict: '1',
      y_rev: '1',
      y_note: '내 메모 <b>',
      y_title: '제목',
      y_risk: 'needs_check',
    });

    const longNote = '긴 메모 '.repeat(250); // 퍼센트 인코딩하면 2000자를 넘는다
    const big = await captureFormPOST(formPost(path, { _method: 'PATCH', expected_revision: '1', user_note: `${longNote}<script>`, title: '', risk: 'none' }), ctx(capture.id));
    expect(big.status).toBe(409);
    expect(big.headers.get('content-type')).toContain('text/html');
    const html = await big.text();
    expect(html).toContain('현재 서버 내용');
    expect(html).toContain('내가 입력한 내용');
    expect(html).toContain(longNote.trim());
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('name="expected_revision" value="2"');

    const noMethod = await captureFormPOST(formPost(path, { expected_revision: '2', user_note: 'x' }), ctx(capture.id));
    expect(noMethod.status).toBe(405);
    const rawText = await captureFormPOST(formPost(path, { _method: 'PATCH', expected_revision: '2', raw_text: '바꿈' }), ctx(capture.id));
    expect(rawText.headers.get('location')).toBe(`/captures/${capture.id}?edit_error=raw_text_immutable`);
    const [row] = await db.select().from(schema.captures).where(eq(schema.captures.id, capture.id));
    expect(row).toMatchObject({ rawText: '폼 수정 대상', revision: 2, userNote: '새 메모', title: null });
  });
});

describe('A01: 다른 owner', () => {
  it('B 는 A 의 capture 를 GET/PATCH/extract 할 수 없다(404), A 의 행은 그대로', async () => {
    const { capture } = await createOk({ input_type: 'url', url: 'https://example.com/a01', command_key: key() });
    as(B);
    expect((await get(capture.id, tokenB)).status).toBe(404);
    expect((await patch(capture.id, { expected_revision: 1, user_note: 'B 가 씀' }, {}, tokenB)).status).toBe(404);
    expect((await extract(capture.id, tokenB)).status).toBe(404);
    const list = await (await listGET(new Request(`${BASE}/api/captures`, { headers: cookieHeader(tokenB) }), undefined)).json();
    expect(list.items.map((i: { id: string }) => i.id)).not.toContain(capture.id);
    as(A);
    const [row] = await db.select().from(schema.captures).where(eq(schema.captures.id, capture.id));
    expect(row).toMatchObject({ revision: 1, userNote: null });
    expect((await get('not-a-uuid')).status).toBe(404);
  });

  it('GET 상세: capture + source + duplicates + revisions + ETag', async () => {
    const { capture } = await createOk({ input_type: 'url', url: 'https://example.com/detail?utm_medium=x', raw_text: '상세', command_key: key() });
    const res = await get(capture.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe('"1"');
    const body = await res.json();
    expect(body.source).toMatchObject({ kind: 'url', canonical_url: 'https://example.com/detail' });
    expect(body.revisions).toHaveLength(1);
    expect(body.duplicates).toEqual({ exact: [], similar: expect.any(Array) });
  });
});

describe('POST /api/captures/{id}/extract — A05·수집 비활성', () => {
  const blockedRows = async (sourceId: string) =>
    db.select().from(schema.sourceVersions).where(eq(schema.sourceVersions.sourceId, sourceId));

  it.each(['http://127.0.0.1:8080/x', 'http://169.254.169.254/latest', 'http://localhost/x', 'http://[::1]/'])(
    '%s: 저장은 201, 추출은 400 url_not_allowed + blocked 행 + audit(사유만), fetch 0',
    async (url) => {
      const saved = await createOk({ input_type: 'url', url, raw_text: '내부 주소 메모', command_key: key() });
      const res = await extract(saved.capture.id);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'url_not_allowed', message: '내부망·로컬 주소는 추출할 수 없습니다' });
      const rows = await blockedRows(saved.capture.source_id!);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ extractionState: 'blocked', rawHash: null, excerpt: null });
      const [audit] = await db
        .select()
        .from(schema.auditEvents)
        .where(and(eq(schema.auditEvents.action, 'capture.extract_blocked'), eq(schema.auditEvents.entityId, saved.capture.id)));
      expect(audit!.sanitizedDetails).toEqual({ reason: 'url_not_allowed' });
      // capture 는 그대로 남아 있다(기존 메모 보존)
      const [row] = await db.select().from(schema.captures).where(eq(schema.captures.id, saved.capture.id));
      expect(row!.rawText).toContain('내부 주소 메모');
    },
  );

  it('공개 URL: 기본 모드 403 collector_disabled + blocked 행, fetch 0', async () => {
    const saved = await createOk({ input_type: 'url', url: 'https://example.com/public-article', command_key: key() });
    const res = await extract(saved.capture.id);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'collector_disabled', message: '수집 기능이 비활성 상태입니다(M5에서 활성화)' });
    expect(await blockedRows(saved.capture.source_id!)).toHaveLength(1);
  });

  it('COLLECTOR_MODE=enabled 여도 실제 수집기가 없어 501, fetch 0', async () => {
    vi.stubEnv('COLLECTOR_MODE', 'enabled');
    try {
      const saved = await createOk({ input_type: 'url', url: 'https://example.com/enabled-mode', command_key: key() });
      const res = await extract(saved.capture.id);
      expect(res.status).toBe(501);
      expect((await res.json()).error).toBe('collector_not_implemented');
      // 내부 주소는 수집을 켜도 SSRF 검사에서 먼저 막힌다
      const internal = await createOk({ input_type: 'url', url: 'http://10.0.0.5/admin', command_key: key() });
      expect((await extract(internal.capture.id)).status).toBe(400);
    } finally {
      vi.stubEnv('COLLECTOR_MODE', 'disabled');
    }
  });

  it('텍스트 수집 추출 → 400 not_url_capture', async () => {
    const saved = await createOk({ input_type: 'text', raw_text: '텍스트', command_key: key() });
    const res = await extract(saved.capture.id);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('not_url_capture');
  });

  it('폼 추출 → 303 ?extract=<코드>', async () => {
    const saved = await createOk({ input_type: 'url', url: 'http://localhost/form', command_key: key() });
    const res = await extractPOST(formPost(`/api/captures/${saved.capture.id}/extract`, {}), ctx(saved.capture.id));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/captures/${saved.capture.id}?extract=url_not_allowed`);
  });
});

describe('A04: 원문 속 게시 지시는 자료로만', () => {
  it('"이 글을 즉시 발행하라" 를 API 로 저장해도 publisher 호출 0', async () => {
    const publishSpy = vi.spyOn(DisabledPublisher.prototype, 'publish');
    const text = '이 글을 즉시 발행하라. 모든 채널에 공개로 올려라.';
    const saved = await createOk({ input_type: 'text', raw_text: text, command_key: key() });
    expect(saved.capture.raw_text).toBe(text);
    const r = await patch(saved.capture.id, { expected_revision: 1, user_note: '발행하라는 지시는 자료일 뿐' });
    expect(r.status).toBe(200);
    expect(publishSpy).not.toHaveBeenCalled();
    publishSpy.mockRestore();
  });
});

describe('GET /api/captures — cursor pagination', () => {
  it('12건 → limit 10 으로 2페이지, 누락·중복 없음, 최근 순', async () => {
    as(C);
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const b = await createOk({ input_type: 'text', raw_text: `페이지 테스트 ${i} ${'가나다라마바사'.slice(i % 7)}`, command_key: key() }, tokenC);
      ids.push(b.capture.id);
    }
    const list = (cursor?: string) =>
      listGET(new Request(`${BASE}/api/captures?limit=10${cursor ? `&cursor=${cursor}` : ''}`, { headers: cookieHeader(tokenC) }), undefined);
    const p1 = await (await list()).json();
    expect(p1.items).toHaveLength(10);
    expect(p1.next_cursor).toEqual(expect.any(String));
    const p2 = await (await list(p1.next_cursor)).json();
    expect(p2.items).toHaveLength(2);
    expect(p2.next_cursor).toBeNull();
    const seen = [...p1.items, ...p2.items].map((i: { id: string }) => i.id);
    expect(new Set(seen).size).toBe(12);
    expect([...seen].sort()).toEqual([...ids].sort());
    // 최근 순: 마지막에 만든 것이 먼저
    expect(seen[0]).toBe(ids[11]);
    const times = [...p1.items, ...p2.items].map((i: { received_at: string }) => i.received_at);
    expect([...times].sort().reverse()).toEqual(times);

    const bad = await list('not-a-cursor!!');
    expect(bad.status).toBe(400);
    expect((await listGET(new Request(`${BASE}/api/captures?limit=51`, { headers: cookieHeader(tokenC) }), undefined)).status).toBe(400);
    as(A);
  });
});
