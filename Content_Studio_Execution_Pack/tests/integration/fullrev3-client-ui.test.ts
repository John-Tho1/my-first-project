/**
 * FIX1-FULLREV3 client-ui 묶음 — 실제 진입점(db 함수·route handler)으로:
 *  - H4: 축약형 1인칭(우린·난 ·내겐·제겐·저한텐·나한텐·우리한텐·저 혼자·나 혼자·우리끼리·저흰) — 실제 Claude 어댑터(가짜 fetch, 네트워크 0)가
 *        claim 을 빼거나 fact 로 낸 경험 문단 → experience claim → 채택 뒤 ready 409
 *  - H5: 409 충돌 화면 textarea(본문·카드·소재 메모·브랜드)와 본문 <pre> — 여는 태그 뒤 LF 하나를 넣어, 브라우저 파서가 LF 하나를 버린 값이
 *        원문과 같다. 빈 줄로 시작하는 본문을 실제 409 → 그 화면에서 다시 저장 → 저장된 값이 원문과 정확히 같다.
 *  - H6: 전사 요청이 커밋됐는데 응답을 잃은 화면의 재시도 — 첫 작업이 끝난 뒤 다시 요청해도 같은 작업(200 existing), 작업·원장 행 수 그대로.
 *        force(일부러 다시 전사)는 새 작업·예약. 폴링 목록 판정(pendingTranscribeSettled)은 실제 GET /api/transcription-jobs 응답으로.
 * 키는 가짜 sentinel, setupFiles 가드가 실제 외부 호출을 막는다. 브라우저 파서 규칙은 helpers.browserTextareaRaw(Chromium 으로 따로 확인한 규칙).
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, count, eq } from 'drizzle-orm';
import {
  adoptProposal,
  closeDb,
  createContent,
  createIdea,
  createVariantDraft,
  ensureOwner,
  getDb,
  listUnconfirmedExperienceClaims,
  runAssist,
  schema,
  seed,
  setVariantAssets,
  updateContentMeta,
  type Db,
} from '@cs/db';
import { AppError, budgetPolicy, loadConfig, MIB } from '@cs/domain';
import { ClaudeLlmProvider } from '@cs/providers';
import { POST as versionsPOST } from '../../apps/web/app/api/contents/[id]/versions/route';
import { POST as ideaFormPOST } from '../../apps/web/app/api/ideas/[id]/route';
import { POST as captureFormPOST } from '../../apps/web/app/api/captures/[id]/route';
import { POST as brandPOST } from '../../apps/web/app/api/brand/route';
import { POST as transcribePOST } from '../../apps/web/app/api/assets/[id]/transcribe/route';
import { GET as jobsGET } from '../../apps/web/app/api/transcription-jobs/route';
import { POST as sessionsPOST } from '../../apps/web/app/api/uploads/sessions/route';
import { PUT as chunkPUT } from '../../apps/web/app/api/uploads/sessions/[id]/chunks/[index]/route';
import { POST as completePOST } from '../../apps/web/app/api/uploads/sessions/[id]/complete/route';
import { esc } from '../../apps/web/lib/contents';
import { pendingTranscribeSettled, transcribeOriginalNote, transcribeSettledMessage } from '../../apps/web/lib/record-client';
import { GET as assetGET } from '../../apps/web/app/api/assets/[id]/route';
import { BASE, browserTextareaRaw, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const A = 'owner@example.local';
const KEY = 'sk-ant-FAKE-fullrev3-client-ui-sentinel-4d5e';
const MODEL = 'claude-opus-5-5';
const LIVE = {
  LLM_MODE: 'live',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: MODEL,
  LLM_PRICE_INPUT_PER_1K: '0.004',
  LLM_PRICE_OUTPUT_PER_1K: '0.02',
  LLM_BUDGET_MONTHLY_LIMIT: '10',
  LLM_BUDGET_PER_RUN_MAX: '0.5',
  LLM_LIVE_APPROVAL_REF: 'D34-test-approval',
} as const;
const CHUNK = 4 * MIB;

let db: Db;
let ownerA: string;
let tokenA: string;
let tmp: string;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-fr3-cui-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  db = (await getDb(loadConfig())).db;
  ownerA = (await seed(db, { allowedIdentity: A })).ownerId;
  tokenA = await login(A);
});
beforeEach(() => {
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------- H4
function fakeFetch(...responses: Array<() => Response>) {
  return (async () => {
    const r = responses.shift();
    if (!r) throw new Error('fake fetch: 준비된 응답 없음');
    return r();
  }) as unknown as typeof fetch;
}
const message = (out: unknown) => ({
  id: 'msg_01FAKEfr3',
  type: 'message',
  role: 'assistant',
  model: MODEL,
  content: [{ type: 'text', text: JSON.stringify(out) }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  stop_details: null,
  usage: { input_tokens: 1500, output_tokens: 800, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
});
const okJson = (body: unknown) => () =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_011FAKEfr3' } });
const revOf = async (contentId: string) => (await db.select().from(schema.contents).where(eq(schema.contents.id, contentId)))[0]!.revision;

describe('FIX1-FULLREV3(H4) — 축약형 1인칭: 실제 어댑터 출력의 경험 문단이 게이트에 걸린다', () => {
  it.each<[string, string, 'missing' | 'fact']>([
    ['우린', '우린 작년에 두바이 바이어 30곳과 계약을 맺었습니다.', 'missing'],
    ['저흰', '저흰 지난해 첫 수출 계약을 따냈습니다.', 'fact'],
    ['난 + 공백', '난 2019년에 두바이로 이직했다.', 'missing'],
    ['내겐', '내겐 그 첫 계약이 전환점이었다.', 'fact'],
    ['제겐', '제겐 가장 큰 교훈이 현지 협상이었습니다.', 'missing'],
    ['저한텐', '저한텐 그 지사 발령이 기회였습니다.', 'missing'],
    ['나한텐', '나한텐 그 이직이 큰 결정이었다.', 'fact'],
    ['우리한텐', '우리한텐 중동 시장이 처음이었습니다.', 'missing'],
    ['저 혼자', '저 혼자 현지 협상을 마쳤습니다.', 'fact'],
    ['나 혼자', '나 혼자 지사를 맡아 운영했다.', 'missing'],
    ['우리끼리', '우리끼리 입찰 전략을 짜서 수주했습니다.', 'missing'],
  ])('%s → 서버가 experience claim(확인 필요) → 채택 뒤 미확인 → ready 409', async (label, paragraph, shape) => {
    const owner = (await ensureOwner(db, `fr3-h4-${randomUUID()}@example.local`)).id;
    await db.insert(schema.brandProfiles).values({ ownerId: owner, version: 1, penName: 'p', audience: 'a', pillars: ['x'] });
    const c = await createContent(db, owner, { title: `H4 ${label}`, body: '본문.' });
    const out = {
      proposed_text: `해외 영업 이야기입니다.\n\n${paragraph}`,
      proposed_tags: ['해외영업'],
      claims: shape === 'fact' ? [{ text: paragraph, kind: 'fact', source_refs: [], needs_user_confirmation: false }] : [],
      followup_questions: [],
      warnings: [],
    };
    const llm = new ClaudeLlmProvider({ apiKey: KEY, model: MODEL, fetch: fakeFetch(okJson(message(out))) });
    const r = await runAssist(
      db,
      owner,
      c.content.id,
      { mode: 'draft', baseVersion: 1, brandProfileVersion: 1, answerIds: [], budget: budgetPolicy(loadConfig({ ...LIVE })) },
      llm,
    );
    expect(r.claims.map((x) => [x.text, x.kind, x.needs_user_confirmation])).toEqual([[paragraph, 'experience', true]]);
    await adoptProposal(db, owner, c.content.id, r.run.id, 1);
    expect((await listUnconfirmedExperienceClaims(db, owner, c.content.id)).map((u) => [u.run_id, u.claim_index])).toEqual([[r.run.id, 0]]);
    await updateContentMeta(db, owner, c.content.id, { lifecycle: 'review' }, await revOf(c.content.id));
    const e = await updateContentMeta(db, owner, c.content.id, { lifecycle: 'ready' }, await revOf(c.content.id)).then(
      () => null,
      (x: AppError) => x,
    );
    expect(e?.code).toBe('unconfirmed_experience_claims');
  });

  it('난초·난관·고난·우린다·전 세계 문단은 claim 을 더하지 않는다 — ready 전환 가능', async () => {
    const owner = (await ensureOwner(db, `fr3-h4-neg-${randomUUID()}@example.local`)).id;
    await db.insert(schema.brandProfiles).values({ ownerId: owner, version: 1, penName: 'p', audience: 'a', pillars: ['x'] });
    const c = await createContent(db, owner, { title: 'H4 부정', body: '본문.' });
    const out = {
      proposed_text: '난초 수출이 늘었다.\n\n어려운 난관을 넘긴 고난 속의 시장이다.\n\n찻잎을 우린다.\n\n전 세계 수요가 커졌다.',
      proposed_tags: [],
      claims: [],
      followup_questions: [],
      warnings: [],
    };
    const llm = new ClaudeLlmProvider({ apiKey: KEY, model: MODEL, fetch: fakeFetch(okJson(message(out))) });
    const r = await runAssist(
      db,
      owner,
      c.content.id,
      { mode: 'draft', baseVersion: 1, brandProfileVersion: 1, answerIds: [], budget: budgetPolicy(loadConfig({ ...LIVE })) },
      llm,
    );
    expect(r.claims).toEqual([]);
    await adoptProposal(db, owner, c.content.id, r.run.id, 1);
    await updateContentMeta(db, owner, c.content.id, { lifecycle: 'review' }, await revOf(c.content.id));
    expect((await updateContentMeta(db, owner, c.content.id, { lifecycle: 'ready' }, await revOf(c.content.id))).lifecycle).toBe('ready');
  });
});

// ---------------------------------------------------------------- H5
function formPost(p: string, fields: Record<string, string>): Request {
  return new Request(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html,application/xhtml+xml', ...ORIGIN_HEADERS, ...cookieHeader(tokenA) },
    body: new URLSearchParams(fields).toString(),
  });
}
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** 409 HTML 의 폼을 브라우저처럼 읽는다(textarea 는 여는 태그 뒤 LF 하나를 버림). raw 는 textarea 원문(escape 된 그대로). */
function parsedForm(html: string): { action: string; fields: Record<string, string>; rawTextareas: Record<string, string> } {
  const forms = [...html.matchAll(/<form method="post" action="([^"]*)">([\s\S]*?)<\/form>/g)];
  expect(forms).toHaveLength(1);
  const [, action, inner] = forms[0]!;
  const fields: Record<string, string> = {};
  const rawTextareas: Record<string, string> = {};
  for (const m of inner!.matchAll(/<input\b[^>]*\bname="([^"]*)"[^>]*\bvalue="([^"]*)"[^>]*>/g)) fields[unesc(m[1]!)] = unesc(m[2]!);
  for (const m of inner!.matchAll(/<textarea\b[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/textarea>/g)) {
    rawTextareas[unesc(m[1]!)] = m[2]!;
    fields[unesc(m[1]!)] = unesc(browserTextareaRaw(m[2]!));
  }
  for (const m of inner!.matchAll(/<select\b[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const sel = /<option value="([^"]*)" selected>/.exec(m[2]!) ?? /<option value="([^"]*)"/.exec(m[2]!);
    fields[unesc(m[1]!)] = unesc(sel![1]!);
  }
  return { action: unesc(action!), fields, rawTextareas };
}
/** 그 화면에서 '다시 저장'(같은 출처 문서의 폼 POST — referrer-policy same-origin) */
const resubmitReq = (action: string, documentPath: string, fields: Record<string, string>) =>
  new Request(new URL(action, `${BASE}${documentPath}`), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', origin: BASE, referer: `${BASE}${documentPath}`, ...cookieHeader(tokenA) },
    body: new URLSearchParams(fields).toString(),
  });

describe('FIX1-FULLREV3(H5) — 409 충돌 화면 textarea 의 맨 앞 빈 줄이 다시 저장해도 남는다', () => {
  it('브라우저 규칙(helpers.browserTextareaRaw): 여는 태그 뒤 LF·CRLF 하나만 버린다', () => {
    expect(browserTextareaRaw('\n\n본문')).toBe('\n본문');
    expect(browserTextareaRaw('\r\n본문')).toBe('본문');
    expect(browserTextareaRaw('본문\n')).toBe('본문\n');
    expect(browserTextareaRaw('\n')).toBe('');
  });

  it('원고 본문(renderVersionConflictHtml): 빈 줄 두 개로 시작하는 본문 → 409 → 다시 저장 → 저장 본문이 원문과 같다(<pre> 미리보기도)', async () => {
    const { content } = await createContent(db, ownerA, { title: 'H5 본문', body: '처음 본문' });
    const p = `/api/contents/${content.id}/versions`;
    expect((await versionsPOST(formPost(p, { base_version: '1', body: '탭 A 본문' }), ctx(content.id))).status).toBe(303);
    const mine = '\n\n탭 B — 빈 줄 두 개로 시작하는 <본문> & "따옴표"\n둘째 줄';
    const res = await versionsPOST(formPost(p, { base_version: '1', body: mine }), ctx(content.id));
    expect(res.status).toBe(409);
    const html = await res.text();
    const form = parsedForm(html);
    expect(form.rawTextareas.body).toBe(`\n${esc(mine)}`);
    expect(form.fields).toMatchObject({ base_version: '2', body: mine });
    // <pre> 미리보기(현재·내 본문)도 여는 태그 뒤 LF — 화면의 첫 빈 줄이 사라지지 않는다
    expect(html).toContain(`<pre>\n${esc(mine)}</pre>`);
    expect(html).toContain(`<pre>\n${esc('탭 A 본문')}</pre>`);
    const ok = await versionsPOST(resubmitReq(form.action, p, form.fields), ctx(content.id));
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe(`/contents/${content.id}?saved_version=3`);
    const [v3] = await db
      .select({ body: schema.contentVersions.body })
      .from(schema.contentVersions)
      .where(and(eq(schema.contentVersions.contentId, content.id), eq(schema.contentVersions.version, 3)));
    expect(v3?.body).toBe(mine);
  });

  it('카드(renderFieldsConflictHtml, ideas): 빈 줄로 시작하는 근거 → 409 → 다시 저장 → 저장 값이 원문과 같다', async () => {
    const idea = await createIdea(db, ownerA, { idea: 'H5 카드' });
    const p = `/api/ideas/${idea.id}`;
    const base = { _method: 'PATCH', audience: '', idea: 'H5 카드', risk: 'none', next_question: '', next_decision: '', tags: '' };
    expect((await ideaFormPOST(formPost(p, { ...base, expected_revision: '1', evidence: '탭 A 근거' }), ctx(idea.id))).status).toBe(303);
    const mine = '\n\n탭 B 근거 — 빈 줄로 시작';
    const res = await ideaFormPOST(formPost(p, { ...base, expected_revision: '1', evidence: mine }), ctx(idea.id));
    expect(res.status).toBe(409);
    const form = parsedForm(await res.text());
    expect(form.rawTextareas.evidence).toBe(`\n${esc(mine)}`);
    expect(form.fields).toMatchObject({ expected_revision: '2', evidence: mine });
    const ok = await ideaFormPOST(resubmitReq(form.action, p, form.fields), ctx(idea.id));
    expect(ok.status).toBe(303);
    expect((await db.select({ e: schema.ideas.evidence }).from(schema.ideas).where(eq(schema.ideas.id, idea.id)))[0]!.e).toBe(mine);
  });

  it('소재 메모(captures renderConflictHtml): 빈 줄로 시작하는 긴 메모 → 409 → 다시 저장 → 저장 메모가 원문과 같다', async () => {
    const [cap] = await db.select().from(schema.captures).where(and(eq(schema.captures.ownerId, ownerA), eq(schema.captures.commandKey, 'fx-003')));
    const id = cap!.id;
    const p = `/api/captures/${id}`;
    const rev = cap!.revision;
    expect((await captureFormPOST(formPost(p, { _method: 'PATCH', expected_revision: String(rev), user_note: '탭 A 메모', title: '', risk: 'none' }), ctx(id))).status).toBe(303);
    const mine = `\n\n${'긴 메모 '.repeat(250).trim()}`; // 충돌 query 가 2000자를 넘어 409 HTML
    const res = await captureFormPOST(formPost(p, { _method: 'PATCH', expected_revision: String(rev), user_note: mine, title: '', risk: 'none' }), ctx(id));
    expect(res.status).toBe(409);
    const form = parsedForm(await res.text());
    expect(form.rawTextareas.user_note).toBe(`\n${esc(mine)}`);
    expect(form.fields).toMatchObject({ expected_revision: String(rev + 1), user_note: mine });
    const ok = await captureFormPOST(resubmitReq(form.action, p, form.fields), ctx(id));
    expect(ok.status).toBe(303);
    expect((await db.select({ n: schema.captures.userNote }).from(schema.captures).where(eq(schema.captures.id, id)))[0]!.n).toBe(mine);
  });

  it('브랜드(renderBrandConflictHtml): 빈 줄로 시작하는 예문 textarea → 409 → 브라우저가 읽은 값 = 내 입력, 다시 저장 303', async () => {
    const base = (await db.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.ownerId, ownerA))).reduce((m, r) => Math.max(m, r.version), 0);
    const common = { pen_name: 'H5 필명', audience: 'H5 독자', pillars: 'A축', tone: 'formal', style_rules: '', avoid_phrases: '', cta_rules: '' };
    expect((await brandPOST(formPost('/api/brand', { ...common, base_version: String(base), sample_texts: '탭 A 예문' }))).status).toBe(303);
    const mine = { ...common, base_version: String(base), style_rules: '\n\n짧게 쓴다', sample_texts: '\n\n첫 예문입니다.\n\n둘째 예문입니다.' };
    const res = await brandPOST(formPost('/api/brand', mine));
    expect(res.status).toBe(409);
    const form = parsedForm(await res.text());
    expect(form.rawTextareas.sample_texts).toBe(`\n${esc(mine.sample_texts)}`);
    expect(form.rawTextareas.style_rules).toBe(`\n${esc(mine.style_rules)}`);
    expect(form.fields).toEqual({ ...mine, base_version: String(base + 1) });
    const ok = await brandPOST(resubmitReq(form.action, '/api/brand', form.fields));
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe(`/brand?saved=${base + 2}`);
  });
});

// ---------------------------------------------------------------- H6
function media(bytes: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes);
  let x = seed * 2654435761;
  for (let i = 0; i < bytes; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  out.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0], 0); // mp3(ID3) 서명 + 합성 바이트
  return out;
}
const bare = (url: string) => new Request(`${BASE}${url}`, { method: 'POST', headers: { accept: 'application/json', ...ORIGIN_HEADERS, ...cookieHeader(tokenA) } });
const getReq = (url: string) => new Request(`${BASE}${url}`, { headers: { accept: 'application/json', ...cookieHeader(tokenA) } });
async function uploadAsset(seedN: number): Promise<string> {
  const file = media(9000, seedN);
  const s = await (await sessionsPOST(jsonPost('/api/uploads/sessions', { kind: 'audio', mime: 'audio/mpeg', bytes: file.byteLength, chunk_size: CHUNK }, cookieHeader(tokenA)), undefined as never)).json();
  const sid = s.session.id as string;
  const put = await chunkPUT(
    new Request(`${BASE}/api/uploads/sessions/${sid}/chunks/0`, {
      method: 'PUT',
      headers: { accept: 'application/json', 'content-type': 'application/octet-stream', ...ORIGIN_HEADERS, ...cookieHeader(tokenA) },
      body: file,
    }),
    { params: Promise.resolve({ id: sid, index: '0' }) },
  );
  expect(put.status).toBe(201);
  const done = await completePOST(bare(`/api/uploads/sessions/${sid}/complete`), ctx(sid));
  expect(done.status).toBe(200);
  return (await done.json()).asset.id as string;
}
const transcribe = (assetId: string, body: Record<string, unknown>) =>
  transcribePOST(jsonPost(`/api/assets/${assetId}/transcribe`, body, cookieHeader(tokenA)), ctx(assetId));
/** 폴링 한 번(inline worker 가 한 단계 진행) — 화면이 받는 것과 같은 응답 */
async function poll(): Promise<Array<{ id: string; asset_id: string; state: string }>> {
  const r = await jobsGET(getReq('/api/transcription-jobs'), undefined as never);
  expect(r.status).toBe(200);
  return (await r.json()).jobs;
}
const jobsFor = async (assetId: string) =>
  (await db.select({ n: count() }).from(schema.transcriptionJobs).where(and(eq(schema.transcriptionJobs.assetId, assetId), eq(schema.transcriptionJobs.ownerId, ownerA))))[0]!.n;
const ledgerRows = async () => (await db.select({ n: count() }).from(schema.usageLedger).where(eq(schema.usageLedger.ownerId, ownerA)))[0]!.n;

describe('FIX1-FULLREV3(H6) — 응답을 잃은 전사 요청의 재시도가 같은 asset 에 작업·예약을 하나 더 만들지 않는다', () => {
  it('요청 커밋(응답 잃음) → 폴링 목록에 그 asset 작업 → 판정이 재시도 버튼을 거둠 → 끝난 뒤 재시도해도 같은 작업(200 existing), 작업·원장 수 그대로', async () => {
    const assetId = await uploadAsset(301);
    const pending = { assetId, key: 'cs-upload:sha256:h6' };
    // 서버는 요청을 커밋했다 — 화면은 이 응답을 잃었다고 본다(fetch 오류·커밋 뒤 5xx)
    const first = await transcribe(assetId, { keep_original: true });
    expect(first.status).toBe(202);
    const firstBody = await first.json();
    expect(firstBody.existing).toBe(false);
    const jobId = firstBody.job.id as string;
    // 화면의 다음 폴링: 진행 중 작업이 보인다 → '전사만 다시 요청'을 거둘 판정
    const seen = pendingTranscribeSettled(pending, await poll());
    expect(seen).toMatchObject({ id: jobId, asset_id: assetId });
    expect(transcribeSettledMessage(seen!.state)).toContain('이미 서버에 들어가 있습니다');
    for (let i = 0; i < 6; i++) await poll();
    const after = await poll();
    expect(after.find((j) => j.id === jobId)?.state).toBe('succeeded');
    expect(pendingTranscribeSettled(pending, after)).toMatchObject({ id: jobId, state: 'succeeded' });
    // 그래도 (예: 판정 전 버튼을 누름 · 같은 파일을 다시 고름) 재시도가 오면 서버가 같은 작업을 돌려준다
    const jobsBefore = await jobsFor(assetId);
    const ledgerBefore = await ledgerRows();
    const retry = await transcribe(assetId, { keep_original: true });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ existing: true, job: { id: jobId, state: 'succeeded', asset_id: assetId } });
    expect(await jobsFor(assetId)).toBe(jobsBefore);
    expect(await ledgerRows()).toBe(ledgerBefore);
    expect(jobsBefore).toBe(1);
  });

  it('일부러 다시 전사(force: true)는 새 작업·새 예약(202 existing:false)', async () => {
    const assetId = await uploadAsset(302);
    const first = (await (await transcribe(assetId, {})).json()).job.id as string;
    for (let i = 0; i < 6; i++) await poll();
    const ledgerBefore = await ledgerRows();
    const forced = await transcribe(assetId, { force: true });
    expect(forced.status).toBe(202);
    const body = await forced.json();
    expect(body.existing).toBe(false);
    expect(body.job.id).not.toBe(first);
    expect(await jobsFor(assetId)).toBe(2);
    expect(await ledgerRows()).toBe(ledgerBefore + 1);
    // 그 새 작업이 진행 중이면 force 가 아닌 재시도는 전과 같이 409 transcription_in_progress
    const busy = await transcribe(assetId, {});
    expect(busy.status).toBe(409);
    expect((await busy.json()).error).toBe('transcription_in_progress');
  });

  it('실패·취소 작업만 있으면 재시도는 새 작업(판정도 거두지 않음)', async () => {
    const assetId = await uploadAsset(303);
    const q = (await (await transcribe(assetId, {})).json()).job.id as string;
    const { POST: cancelPOST } = await import('../../apps/web/app/api/transcription-jobs/[id]/cancel/route');
    expect((await cancelPOST(bare(`/api/transcription-jobs/${q}/cancel`), ctx(q))).status).toBe(200);
    expect(pendingTranscribeSettled({ assetId }, await poll())).toBeNull();
    const again = await transcribe(assetId, {});
    expect(again.status).toBe(202);
    expect((await again.json()).existing).toBe(false);
    expect(await jobsFor(assetId)).toBe(2);
  });

  it('FIX1-FULLREV3(H6 후속) 실패 작업만 있고 force 없음 → 새 작업·새 예약(202 existing:false)', async () => {
    const assetId = await uploadAsset(304);
    vi.stubEnv('STT_MOCK_FAIL_NEXT', '1');
    try {
      const f = (await (await transcribe(assetId, {})).json()).job.id as string;
      for (let i = 0; i < 6; i++) await poll();
      const jf = (await db.select().from(schema.transcriptionJobs).where(eq(schema.transcriptionJobs.id, f)))[0]!;
      expect(jf.state).toBe('failed');
    } finally {
      vi.stubEnv('STT_MOCK_FAIL_NEXT', '');
    }
    const ledgerBefore = await ledgerRows();
    const again = await transcribe(assetId, {});
    expect(again.status).toBe(202);
    const body = await again.json();
    expect(body.existing).toBe(false);
    expect(body).not.toHaveProperty('original_deleted');
    expect(await jobsFor(assetId)).toBe(2);
    expect(await ledgerRows()).toBe(ledgerBefore + 1);
  });
});

describe('FIX1-FULLREV3(H6 후속) — 원음 보존을 끈 요청이 기존 성공 작업을 만나도 원음 보존 끄기를 버리지 않는다', () => {
  const assetRow = async (id: string) => (await db.select().from(schema.assets).where(eq(schema.assets.id, id)))[0]!;
  const auditsOf = async (assetId: string, action: string) =>
    (await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.entityId, assetId), eq(schema.auditEvents.action, action)))).length;
  async function succeededKept(seedN: number) {
    const assetId = await uploadAsset(seedN);
    const first = await transcribe(assetId, { keep_original: true });
    expect(first.status).toBe(202);
    const jobId = (await first.json()).job.id as string;
    for (let i = 0; i < 6; i++) await poll();
    expect((await poll()).find((j) => j.id === jobId)?.state).toBe('succeeded');
    expect((await assetRow(assetId)).deletedAt).toBeNull();
    return { assetId, jobId };
  }

  it('keep_original=false 가 기존 성공 작업을 만남 → 원본 삭제(의도·감사·다운로드 410), 200 existing + original_deleted:true, 새 작업·원장 없음 · 화면 문구', async () => {
    const { assetId, jobId } = await succeededKept(311);
    const jobsBefore = await jobsFor(assetId);
    const ledgerBefore = await ledgerRows();
    const r = await transcribe(assetId, { keep_original: false });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ existing: true, original_deleted: true, job: { id: jobId, state: 'succeeded' } });
    expect(body).not.toHaveProperty('original_kept_reason');
    const row = await assetRow(assetId);
    expect(row.deletedAt).not.toBeNull();
    expect(row.pendingDeleteKey).toBeNull(); // 커밋 뒤 파일까지 지웠다
    expect(await auditsOf(assetId, 'asset.delete_original')).toBe(1);
    const dl = await assetGET(new Request(`${BASE}/api/assets/${assetId}`, { headers: { accept: 'application/json', ...cookieHeader(tokenA) } }), ctx(assetId));
    expect(dl.status).toBe(410);
    expect(await jobsFor(assetId)).toBe(jobsBefore);
    expect(await ledgerRows()).toBe(ledgerBefore);
    expect(transcribeSettledMessage('succeeded') + transcribeOriginalNote(body)).toContain('원음 보존을 끈 요청이라 원본 파일을 지웠습니다');
    // 같은 요청을 다시 보내도(원본은 이미 없음) 기존 작업만 — 원본 칸 없음, 삭제 감사 그대로
    const again = await transcribe(assetId, { keep_original: false });
    expect(again.status).toBe(200);
    const b2 = await again.json();
    expect(b2).toMatchObject({ existing: true, job: { id: jobId } });
    expect(b2).not.toHaveProperty('original_deleted');
    expect(await auditsOf(assetId, 'asset.delete_original')).toBe(1);
  });

  it('채널 초안에 첨부된 파일 → 지우지 않음(감사 delete_original_skipped), 200 existing + original_deleted:false·asset_in_use · 화면이 이유를 말한다', async () => {
    const { assetId, jobId } = await succeededKept(312);
    const contentId = (await createContent(db, ownerA, { title: 'H6 첨부', body: '본문.' })).content.id;
    const { variant } = await createVariantDraft(db, ownerA, contentId, { channel: 'youtube', baseVersion: 1 });
    await setVariantAssets(db, ownerA, variant.id, { baseVersion: 1, assets: [{ assetId, position: 1, role: 'attachment' }] });
    const jobsBefore = await jobsFor(assetId);
    const ledgerBefore = await ledgerRows();
    const r = await transcribe(assetId, { keep_original: false });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ existing: true, original_deleted: false, original_kept_reason: 'asset_in_use', job: { id: jobId } });
    const row = await assetRow(assetId);
    expect(row.deletedAt).toBeNull();
    expect(row.pendingDeleteKey).toBeNull();
    expect(await auditsOf(assetId, 'asset.delete_original')).toBe(0);
    expect(await auditsOf(assetId, 'asset.delete_original_skipped')).toBe(1);
    expect(await jobsFor(assetId)).toBe(jobsBefore);
    expect(await ledgerRows()).toBe(ledgerBefore);
    const note = transcribeOriginalNote(body);
    expect(note).toContain('원본 파일은 지우지 않았습니다');
    expect(note).toContain('채널 초안에 첨부된 파일');
  });

  it('keep_original=true(기본)는 전과 같다 — 원본 그대로, 원본 칸 없음', async () => {
    const { assetId, jobId } = await succeededKept(313);
    for (const b of [{ keep_original: true }, {}]) {
      const r = await transcribe(assetId, b);
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body).toMatchObject({ existing: true, job: { id: jobId } });
      expect(body).not.toHaveProperty('original_deleted');
      expect(transcribeOriginalNote(body)).toBe('');
    }
    expect((await assetRow(assetId)).deletedAt).toBeNull();
    expect(await auditsOf(assetId, 'asset.delete_original')).toBe(0);
  });
});
