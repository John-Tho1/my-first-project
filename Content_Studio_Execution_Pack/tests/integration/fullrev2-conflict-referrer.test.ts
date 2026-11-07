/**
 * FIX1-FULLREV2(G4): 409 충돌 화면(원고 본문·원고 정보·카드·소재 긴 입력)이 `Referrer-Policy: no-referrer` 로 나가서 그 화면의 재저장 폼 POST 를
 * 브라우저가 `Origin: null`·Referer 없이 보냈고, assertSameOrigin 이 CSRF 로 거부했다(A02 — 충돌 뒤 내 입력을 저장할 길이 막힘).
 * 수정: 충돌 화면은 `Referrer-Policy: same-origin`(같은 출처 요청에만 Origin·Referer, 다른 출처로는 Referer 없음).
 * 시험(화면별):
 *  - 409 응답의 referrer-policy 가 same-origin
 *  - 그 HTML 의 폼을 브라우저처럼 다시 보낸다 — Origin 은 응답의 Referrer-Policy 로 정한다(Fetch "append a request Origin header":
 *    폼 POST 탐색은 no-referrer 면 `null`, same-origin 이면 같은 출처일 때 출처). same-origin → 303 저장 성공
 *  - 같은 폼을 `Origin: null` 로 보내면 여전히 거부(폼은 303 ?error=csrf / ?edit_error=csrf, JSON 은 403) — 서버 검사는 느슨해지지 않았다
 * 실제 브라우저로 보낸 요청은 아니다(Next 서버 없이 route handler 를 직접 호출) — Origin 결정은 아래 navigationPostOrigin 이 표준 규칙을 흉내 낸다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, count, eq } from 'drizzle-orm';
import { closeDb, createContent, createIdea, getDb, schema, seed, type Db } from '@cs/db';
import { loadConfig } from '@cs/domain';
import { PATCH as capturePATCH, POST as captureFormPOST } from '../../apps/web/app/api/captures/[id]/route';
import { PATCH as contentPATCH, POST as contentFormPOST } from '../../apps/web/app/api/contents/[id]/route';
import { POST as versionsPOST } from '../../apps/web/app/api/contents/[id]/versions/route';
import { PATCH as ideaPATCH, POST as ideaFormPOST } from '../../apps/web/app/api/ideas/[id]/route';
import { BASE, browserTextareaRaw, cookieHeader, login, ORIGIN_HEADERS } from './helpers';

const A = 'owner@example.local';

let db: Db;
let owner: string;
let token: string;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => {
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  db = (await getDb(loadConfig())).db;
  owner = (await seed(db, { allowedIdentity: A })).ownerId;
  token = await login(A);
});
beforeEach(() => vi.stubEnv('AUTH_ALLOWED_IDENTITY', A));
afterAll(async () => {
  vi.unstubAllEnvs();
  await closeDb();
});

/** 처음 폼 제출(사용자가 화면에서 누른 것) — 같은 출처 문서에서 보낸 POST */
function formPost(path: string, fields: Record<string, string>): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html,application/xhtml+xml', ...ORIGIN_HEADERS, ...cookieHeader(token) },
    body: new URLSearchParams(fields).toString(),
  });
}

/**
 * Fetch 표준 "append a request Origin header" 중 폼 POST 탐색(mode navigate, 메서드 GET/HEAD 아님)의 규칙.
 * 정책 값이 비었으면 기본값 strict-origin-when-cross-origin. 모르는 값이면 시험이 실패한다(조용히 넘어가지 않게).
 */
function navigationPostOrigin(policy: string | null, documentUrl: URL, target: URL): string {
  const origin = documentUrl.origin;
  const downgrade = documentUrl.protocol === 'https:' && target.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  switch (policy === null || policy === '' ? 'strict-origin-when-cross-origin' : policy) {
    case 'no-referrer':
      return 'null';
    case 'no-referrer-when-downgrade':
    case 'strict-origin':
    case 'strict-origin-when-cross-origin':
      return downgrade ? 'null' : origin;
    case 'same-origin':
      return target.origin === origin ? origin : 'null';
    case 'origin':
    case 'origin-when-cross-origin':
    case 'unsafe-url':
      return origin;
    default:
      throw new Error(`알 수 없는 Referrer-Policy: ${policy}`);
  }
}

const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** 409 HTML 의 (하나뿐인) POST 폼: action 과, 사용자가 손대지 않고 제출할 때의 값(hidden·input·textarea·선택된 option). */
function conflictForm(html: string): { action: string; fields: Record<string, string> } {
  const forms = [...html.matchAll(/<form method="post" action="([^"]*)">([\s\S]*?)<\/form>/g)];
  expect(forms).toHaveLength(1);
  const [, action, inner] = forms[0]!;
  const fields: Record<string, string> = {};
  for (const m of inner!.matchAll(/<input\b[^>]*\bname="([^"]*)"[^>]*\bvalue="([^"]*)"[^>]*>/g)) fields[unesc(m[1]!)] = unesc(m[2]!);
  for (const m of inner!.matchAll(/<textarea\b[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/textarea>/g)) fields[unesc(m[1]!)] = unesc(browserTextareaRaw(m[2]!)); // FIX1-FULLREV3(H5): 브라우저 파서 규칙
  for (const m of inner!.matchAll(/<select\b[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const sel = /<option value="([^"]*)" selected>/.exec(m[2]!) ?? /<option value="([^"]*)"/.exec(m[2]!);
    fields[unesc(m[1]!)] = unesc(sel![1]!);
  }
  return { action: unesc(action!), fields };
}

/** 409 화면에서 "다시 저장"을 누른 브라우저 요청: Origin 은 그 화면의 Referrer-Policy 로 정한다(override 로 직접 줄 수도 있음). */
function resubmit(conflict: { url: string; res: Response; html: string }, override?: { origin: string }) {
  const { action, fields } = conflictForm(conflict.html);
  const documentUrl = new URL(conflict.url);
  const target = new URL(action, documentUrl);
  const origin = override?.origin ?? navigationPostOrigin(conflict.res.headers.get('referrer-policy'), documentUrl, target);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'text/html,application/xhtml+xml',
    origin,
    ...cookieHeader(token),
  };
  if (origin !== 'null') headers.referer = documentUrl.href; // same-origin: 같은 출처면 전체 URL. null 이면 Referer 도 없다
  return { request: new Request(target, { method: 'POST', headers, body: new URLSearchParams(fields).toString() }), fields, target };
}

async function conflictOf(url: string, res: Response) {
  expect(res.status).toBe(409);
  expect(res.headers.get('content-type')).toContain('text/html');
  return { url, res, html: await res.text() };
}

/** JSON 요청(브라우저 밖)도 Origin: null 이면 403 — assertSameOrigin 은 그대로 엄격하다. */
function jsonWithNullOrigin(method: 'POST' | 'PATCH', path: string, body: unknown, extra: Record<string, string> = {}) {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json', origin: 'null', ...cookieHeader(token), ...extra },
    body: JSON.stringify(body),
  });
}

describe('FIX1-FULLREV2(G4): 409 충돌 화면 Referrer-Policy same-origin — 재저장 폼이 CSRF 로 거부되지 않는다', () => {
  it('시험 규칙 확인: no-referrer 화면의 폼 POST 는 Origin null, same-origin 화면은 같은 출처', () => {
    const doc = new URL(`${BASE}/api/contents/x/versions`);
    expect(navigationPostOrigin('no-referrer', doc, doc)).toBe('null');
    expect(navigationPostOrigin('same-origin', doc, doc)).toBe(BASE);
    expect(navigationPostOrigin('same-origin', doc, new URL('https://other.example/x'))).toBe('null');
    expect(navigationPostOrigin(null, doc, doc)).toBe(BASE);
  });

  it('원고 본문 저장 충돌(renderVersionConflictHtml): same-origin → 재저장 303 saved_version, Origin: null → csrf(저장 안 됨), JSON 403', async () => {
    const { content } = await createContent(db, owner, { title: 'G4 본문', body: '처음 본문' });
    const path = `/api/contents/${content.id}/versions`;
    expect((await versionsPOST(formPost(path, { base_version: '1', body: '탭 A 본문' }), ctx(content.id))).status).toBe(303);
    const conflict = await conflictOf(`${BASE}${path}`, await versionsPOST(formPost(path, { base_version: '1', body: '탭 B 내 본문' }), ctx(content.id)));
    expect(conflict.res.headers.get('referrer-policy')).toBe('same-origin');
    const versions = async () => (await db.select({ n: count() }).from(schema.contentVersions).where(eq(schema.contentVersions.contentId, content.id)))[0]!.n;

    const denied = await versionsPOST(resubmit(conflict, { origin: 'null' }).request, ctx(content.id));
    expect(denied.status).toBe(303);
    expect(denied.headers.get('location')).toBe(`/contents/${content.id}?error=csrf`);
    expect(await versions()).toBe(2);
    expect((await versionsPOST(jsonWithNullOrigin('POST', path, { base_version: 2, body: 'x' }), ctx(content.id))).status).toBe(403);

    const again = resubmit(conflict);
    expect(again.request.headers.get('origin')).toBe(BASE);
    expect(again.fields).toMatchObject({ base_version: '2', body: '탭 B 내 본문' });
    const ok = await versionsPOST(again.request, ctx(content.id));
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe(`/contents/${content.id}?saved_version=3`);
    const [v3] = await db
      .select({ body: schema.contentVersions.body })
      .from(schema.contentVersions)
      .where(and(eq(schema.contentVersions.contentId, content.id), eq(schema.contentVersions.version, 3)));
    expect(v3?.body).toBe('탭 B 내 본문');
  });

  it('원고 정보 수정 충돌(renderFieldsConflictHtml): same-origin → 재저장 303 meta_updated, Origin: null → csrf, JSON 403', async () => {
    const { content } = await createContent(db, owner, { title: 'G4 정보', body: '본문' });
    const path = `/api/contents/${content.id}`;
    const meta = { _method: 'PATCH', series: '', audience: '', tags: '', lifecycle: 'draft' };
    expect((await contentFormPOST(formPost(path, { ...meta, expected_revision: '1', title: '탭 A 제목' }), ctx(content.id))).status).toBe(303);
    const conflict = await conflictOf(`${BASE}${path}`, await contentFormPOST(formPost(path, { ...meta, expected_revision: '1', title: '탭 B 제목' }), ctx(content.id)));
    expect(conflict.res.headers.get('referrer-policy')).toBe('same-origin');
    const title = async () => (await db.select({ t: schema.contents.title }).from(schema.contents).where(eq(schema.contents.id, content.id)))[0]!.t;

    const denied = await contentFormPOST(resubmit(conflict, { origin: 'null' }).request, ctx(content.id));
    expect(denied.headers.get('location')).toBe(`/contents/${content.id}?error=csrf`);
    expect(await title()).toBe('탭 A 제목');
    expect((await contentPATCH(jsonWithNullOrigin('PATCH', path, { title: 'x' }, { 'if-match': '"2"' }), ctx(content.id))).status).toBe(403);

    const again = resubmit(conflict);
    expect(again.fields).toMatchObject({ _method: 'PATCH', expected_revision: '2', title: '탭 B 제목' });
    const ok = await contentFormPOST(again.request, ctx(content.id));
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe(`/contents/${content.id}?meta_updated=3`);
    expect(await title()).toBe('탭 B 제목');
  });

  it('카드 수정 충돌(renderFieldsConflictHtml, ideas): same-origin → 재저장 303 updated, Origin: null → csrf, JSON 403', async () => {
    const idea = await createIdea(db, owner, { idea: 'G4 카드' });
    const path = `/api/ideas/${idea.id}`;
    const base = { _method: 'PATCH', audience: '', evidence: '', risk: 'none', next_question: '', next_decision: '', tags: '' };
    expect((await ideaFormPOST(formPost(path, { ...base, expected_revision: '1', idea: '탭 A 카드' }), ctx(idea.id))).status).toBe(303);
    const conflict = await conflictOf(`${BASE}${path}`, await ideaFormPOST(formPost(path, { ...base, expected_revision: '1', idea: '탭 B 카드' }), ctx(idea.id)));
    expect(conflict.res.headers.get('referrer-policy')).toBe('same-origin');
    const text = async () => (await db.select({ t: schema.ideas.idea }).from(schema.ideas).where(eq(schema.ideas.id, idea.id)))[0]!.t;

    const denied = await ideaFormPOST(resubmit(conflict, { origin: 'null' }).request, ctx(idea.id));
    expect(denied.headers.get('location')).toBe(`/ideas/${idea.id}?error=csrf`);
    expect(await text()).toBe('탭 A 카드');
    expect((await ideaPATCH(jsonWithNullOrigin('PATCH', path, { idea: 'x' }, { 'if-match': '"2"' }), ctx(idea.id))).status).toBe(403);

    const again = resubmit(conflict);
    expect(again.fields).toMatchObject({ _method: 'PATCH', expected_revision: '2', idea: '탭 B 카드' });
    const ok = await ideaFormPOST(again.request, ctx(idea.id));
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe(`/ideas/${idea.id}?updated=3`);
    expect(await text()).toBe('탭 B 카드');
  });

  it('소재 수정 긴 입력 충돌(captures/[id] 409 HTML): same-origin → 재저장 303 updated, Origin: null → edit_error=csrf, JSON 403', async () => {
    const [cap] = await db.select().from(schema.captures).where(and(eq(schema.captures.ownerId, owner), eq(schema.captures.commandKey, 'fx-003')));
    const id = cap!.id;
    const path = `/api/captures/${id}`;
    const rev = cap!.revision;
    expect((await captureFormPOST(formPost(path, { _method: 'PATCH', expected_revision: String(rev), user_note: '탭 A 메모', title: '', risk: 'none' }), ctx(id))).status).toBe(303);
    const longNote = '긴 메모 '.repeat(250).trim(); // 충돌 query 가 2000자를 넘어 303 대신 409 HTML
    const conflict = await conflictOf(
      `${BASE}${path}`,
      await captureFormPOST(formPost(path, { _method: 'PATCH', expected_revision: String(rev), user_note: longNote, title: '', risk: 'none' }), ctx(id)),
    );
    expect(conflict.res.headers.get('referrer-policy')).toBe('same-origin');
    expect(conflict.res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const note = async () => (await db.select({ n: schema.captures.userNote }).from(schema.captures).where(eq(schema.captures.id, id)))[0]!.n;

    const denied = await captureFormPOST(resubmit(conflict, { origin: 'null' }).request, ctx(id));
    expect(denied.status).toBe(303);
    expect(denied.headers.get('location')).toBe(`/captures/${id}?edit_error=csrf`);
    expect(await note()).toBe('탭 A 메모');
    expect((await capturePATCH(jsonWithNullOrigin('PATCH', path, { user_note: 'x' }, { 'if-match': `"${rev + 1}"` }), ctx(id))).status).toBe(403);

    const again = resubmit(conflict);
    expect(again.fields).toMatchObject({ _method: 'PATCH', expected_revision: String(rev + 1), user_note: longNote, risk: 'none' });
    const ok = await captureFormPOST(again.request, ctx(id));
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe(`/captures/${id}?updated=${rev + 2}`);
    expect(await note()).toBe(longNote);
  });
});
