/**
 * FIX3-FULLREV2 writing-content 묶음 — 실제 진입점(db 함수·route handler)으로:
 *  - G20(D40-4): 넓힌 1인칭 판별 — 실제 Claude 어댑터(가짜 fetch, 네트워크 0)가 claim 을 빼거나 fact 로 낸 경험 문단 → experience claim → 채택 뒤 ready 409
 *  - G21: 실패한 AI 실행의 안정 코드 → 작성 패널 고정 문구(허용 목록) + 영구 실패 안내, JSON 502 에 run_id·failure_code(원문 없음)
 *  - G22: budget_currency_mismatch 폼 경로 → 자기 코드·문구(일반 conflict 아님)
 *  - G29(D40-5): 본문이 그대로(CRLF 차이 포함)인 저장 → 새 버전·승인 철회·파생본 stale 없음, 메모 있어도 마찬가지
 *  - G31: /brand 폼 충돌 → 409 비교 화면(내 입력 보존) → 그 화면에서 다시 저장 → 303
 *  - G32: 검색어 고유 조각 9개 이상 → 400(조용히 자르지 않음)
 * 키는 가짜 sentinel, setupFiles 가드가 실제 외부 호출을 막는다.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, count, eq, isNull } from 'drizzle-orm';
import {
  adoptProposal,
  appendContentVersion,
  closeDb,
  createContent,
  createVariantDraft,
  ensureOwner,
  getDb,
  getLedgerForRun,
  getWritingState,
  listChannelAccounts,
  listUnconfirmedExperienceClaims,
  runAssist,
  schema,
  seed,
  setVariantLifecycle,
  updateContentMeta,
  type Db,
} from '@cs/db';
import { AI_PERMANENT_FAILURE_GUIDANCE, AppError, budgetPolicy, loadConfig, SEARCH_TERMS_LIMIT_MESSAGE, type Channel } from '@cs/domain';
import { ClaudeLlmProvider, MockLlmProvider } from '@cs/providers';
import { POST as assistPOST } from '../../apps/web/app/api/contents/[id]/assist/route';
import { POST as versionsPOST } from '../../apps/web/app/api/contents/[id]/versions/route';
import { POST as brandPOST } from '../../apps/web/app/api/brand/route';
import { GET as searchGET } from '../../apps/web/app/api/search/route';
import { POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { POST as approvePOST } from '../../apps/web/app/api/distribution-plans/[id]/approve/route';
import { WRITING_ERROR_TEXT } from '../../apps/web/lib/writing';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

// react·react-dom 은 apps/web 의 의존성이다(루트 시험에서 직접 import 하지 않음 — fullrev2-risk-needs-check 와 같은 방식).
const webRequire = createRequire(path.resolve(import.meta.dirname, '../../apps/web/package.json'));
const { renderToStaticMarkup } = webRequire('react-dom/server') as { renderToStaticMarkup: (el: unknown) => string };
const { createElement } = webRequire('react') as { createElement: (type: unknown, props: unknown) => unknown };
// .tsx 는 루트 tsconfig(jsx 없음) 밖이라 경로로 동적 import 한다(fullrev2-risk-needs-check 와 같은 방식).
type PanelModule = { WritingPanel: (props: Record<string, unknown>) => unknown; RunFailureNotice: (props: { error: string | null }) => unknown };
const { WritingPanel, RunFailureNotice } = (await import(/* @vite-ignore */ path.resolve(import.meta.dirname, '../../apps/web/app', 'contents/[id]/writing-panel.tsx'))) as PanelModule;

const A = 'owner@example.local';
const B = 'fix3-currency@example.local';
const KEY = 'sk-ant-FAKE-fix3-fullrev2-sentinel-1b2c3d';
const ECHO = 'UPSTREAM-ECHO-FIX3-원문-7e6f';
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
const policy = () => budgetPolicy(loadConfig({ ...LIVE }));

let db: Db;
let ownerA: string;
let tokenA: string;

const as = (identity: string) => vi.stubEnv('AUTH_ALLOWED_IDENTITY', identity);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

function fakeFetch(...responses: Array<() => Response>) {
  let calls = 0;
  const fn = (async () => {
    calls += 1;
    const r = responses.shift();
    if (!r) throw new Error('fake fetch: 준비된 응답 없음');
    return r();
  }) as unknown as typeof fetch;
  return { fetch: fn, calls: () => calls };
}
const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_011FAKEfix3' } });
const message = (out: unknown) => ({
  id: 'msg_01FAKEfix3',
  type: 'message',
  role: 'assistant',
  model: MODEL,
  content: [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: JSON.stringify(out) },
  ],
  stop_reason: 'end_turn',
  stop_sequence: null,
  stop_details: null,
  usage: { input_tokens: 1500, output_tokens: 800, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
});
const claude = (f: typeof fetch) => new ClaudeLlmProvider({ apiKey: KEY, model: MODEL, fetch: f });
const draft = () => ({ mode: 'draft' as const, baseVersion: 1, brandProfileVersion: 1, answerIds: [], budget: policy() });

async function freshOwner(identity: string) {
  const owner = (await ensureOwner(db, identity)).id;
  await db.insert(schema.brandProfiles).values({ ownerId: owner, version: 1, penName: 'p', audience: 'a', pillars: ['x'] });
  return owner;
}
const revOf = async (contentId: string) => (await db.select().from(schema.contents).where(eq(schema.contents.id, contentId)))[0]!.revision;

function formPost(path: string, fields: Record<string, string>, token = tokenA): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html,application/xhtml+xml', ...ORIGIN_HEADERS, ...cookieHeader(token) },
    body: new URLSearchParams(fields).toString(),
  });
}

beforeAll(async () => {
  db = (await getDb(loadConfig())).db;
  ownerA = (await seed(db, { allowedIdentity: A })).ownerId;
  as(A);
  tokenA = await login(A);
});
beforeEach(() => as(A));
afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await closeDb();
});

// ---------------------------------------------------------------- G20
describe('FIX3-FULLREV2(G20) — 넓힌 1인칭 판별: 실제 어댑터 출력의 경험 문단이 게이트에 걸린다', () => {
  it.each<[string, string, 'missing' | 'fact']>([
    ['저희 팀(claim 누락)', '저희 팀은 지난해 두바이 바이어 30곳과 계약을 맺었습니다.', 'missing'],
    ['저희 팀(fact 로 냄)', '저희 팀은 지난해 두바이 바이어 30곳과 계약을 맺었습니다.', 'fact'],
    ['우리 회사', '우리 회사는 작년에 첫 수출 계약을 따냈습니다.', 'missing'],
    ['저도', '저도 처음엔 현지 협상에서 실패했습니다.', 'fact'],
    ['제게', '제게 가장 큰 교훈은 첫 계약이었습니다.', 'missing'],
    ['강조 ** 뒤', '**저는** 2019년에 두바이로 이직했습니다.', 'missing'],
    ['꺾쇠 「 뒤', '「저는 괜찮습니다」라고 답하고 계약을 마쳤습니다.', 'fact'],
    ['작은따옴표 ‘ 뒤', '‘제가 하겠습니다’라고 말하고 지사를 맡았습니다.', 'missing'],
    ['괄호 ( 뒤', '(제가 맡았던 첫 거래처였습니다.)', 'missing'],
    ['영어 I', 'I moved to Dubai in 2019 and signed thirty buyers.', 'fact'],
  ])('%s → 서버가 experience claim(확인 필요) → 채택 뒤 미확인 → ready 409', async (label, paragraph, shape) => {
    const owner = await freshOwner(`fix3-g20-${randomUUID()}@example.local`);
    const c = await createContent(db, owner, { title: `G20 ${label}`, body: '본문.' });
    const out = {
      proposed_text: `해외 영업 이야기입니다.\n\n${paragraph}`,
      proposed_tags: ['해외영업'],
      claims: shape === 'fact' ? [{ text: paragraph, kind: 'fact', source_refs: [], needs_user_confirmation: false }] : [],
      followup_questions: [],
      warnings: [],
    };
    const { fetch } = fakeFetch(json(200, message(out)));
    const r = await runAssist(db, owner, c.content.id, draft(), claude(fetch));
    expect(r.claims.map((x) => [x.text, x.kind, x.needs_user_confirmation])).toEqual([[paragraph, 'experience', true]]);
    await adoptProposal(db, owner, c.content.id, r.run.id, 1);
    const unresolved = await listUnconfirmedExperienceClaims(db, owner, c.content.id);
    expect(unresolved.map((u) => [u.run_id, u.claim_index])).toEqual([[r.run.id, 0]]);
    await updateContentMeta(db, owner, c.content.id, { lifecycle: 'review' }, await revOf(c.content.id));
    const e = await updateContentMeta(db, owner, c.content.id, { lifecycle: 'ready' }, await revOf(c.content.id)).then(
      () => null,
      (x: AppError) => x,
    );
    expect(e?.code).toBe('unconfirmed_experience_claims');
  });

  it('1인칭이 아닌 문단(우리나라·AI)은 claim 을 더하지 않는다 — ready 전환 가능', async () => {
    const owner = await freshOwner(`fix3-g20-neg-${randomUUID()}@example.local`);
    const c = await createContent(db, owner, { title: 'G20 부정', body: '본문.' });
    const out = { proposed_text: '우리나라는 수출 비중이 크다.\n\nAI 활용이 늘었다.', proposed_tags: [], claims: [], followup_questions: [], warnings: [] };
    const { fetch } = fakeFetch(json(200, message(out)));
    const r = await runAssist(db, owner, c.content.id, draft(), claude(fetch));
    expect(r.claims).toEqual([]);
    await adoptProposal(db, owner, c.content.id, r.run.id, 1);
    await updateContentMeta(db, owner, c.content.id, { lifecycle: 'review' }, await revOf(c.content.id));
    const ready = await updateContentMeta(db, owner, c.content.id, { lifecycle: 'ready' }, await revOf(c.content.id));
    expect(ready.lifecycle).toBe('ready');
  });
});

// ---------------------------------------------------------------- G21
async function renderPanel(owner: string, contentId: string): Promise<string> {
  const detail = (await db.select().from(schema.contents).where(eq(schema.contents.id, contentId)))[0]!;
  const current = (await db.select().from(schema.contentVersions).where(eq(schema.contentVersions.id, detail.currentVersionId!)))[0]!;
  const w = await getWritingState(db, owner, contentId);
  const run = w.runs[0] ?? null;
  const ledger = run ? await getLedgerForRun(db, owner, run.id) : null;
  return renderToStaticMarkup(
    createElement(WritingPanel, {
      contentId,
      title: detail.title,
      current: { id: current.id, version: current.version, body: current.body },
      state: w,
      selectedRun: run,
      claimViews: [],
      ledger,
      proposal: null,
      answeredCount: null,
      confirmedCount: null,
      llmMode: 'live',
    }),
  );
}

describe('FIX3-FULLREV2(G21) — 실패한 AI 실행의 원인 코드: 작성 패널(허용 목록 문구) + JSON 502(run_id·failure_code)', () => {
  it.each<[number, string, string, boolean, string]>([
    [401, 'authentication_error', 'llm_auth_failed', true, '실제 AI 인증에 실패했습니다(ANTHROPIC_API_KEY 를 확인하세요).'],
    [404, 'not_found_error', 'llm_not_found', true, '실제 AI 모델 또는 경로를 찾지 못했습니다(LLM_MODEL 을 확인하세요).'],
    [400, 'invalid_request_error', 'llm_bad_request', true, '실제 AI 가 요청 형식을 거부했습니다.'],
    [529, 'overloaded_error', 'llm_server_error', false, '실제 AI 서버 오류입니다. 잠시 뒤 다시 시도하세요.'],
  ])('db 층 HTTP %i(%s) → LlmFailedError extra {run_id, failure_code:%s}, 패널에 고정 문구·코드, 영구=%s 안내, 원문 없음', async (status, type, code, permanent, text) => {
    const owner = await freshOwner(`fix3-g21-${status}-${randomUUID()}@example.local`);
    const c = await createContent(db, owner, { title: `G21 ${status}`, body: '본문.' });
    const { fetch } = fakeFetch(json(status, { type: 'error', error: { type, message: `${ECHO} ${KEY}` } }));
    const e = await runAssist(db, owner, c.content.id, draft(), claude(fetch)).then(
      () => null,
      (x: AppError) => x,
    );
    expect(e?.code).toBe('llm_failed');
    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.contentId, c.content.id));
    expect(run).toMatchObject({ status: 'failed', error: code });
    expect(e?.extra).toEqual({ run_id: run!.id, failure_code: code, permanent });
    expect(e!.message).toContain(text);
    expect(e!.message.includes(AI_PERMANENT_FAILURE_GUIDANCE)).toBe(permanent);
    expect(e!.message.includes('잠시 뒤 다시 시도') && permanent).toBe(false);
    expect(e!.message).not.toContain(ECHO);

    const html = await renderPanel(owner, c.content.id);
    expect(html).toContain(`원인: ${text}`);
    expect(html).toContain(`<code>${code}</code>`);
    expect(html).toContain(`data-failure-code="${code}"`);
    expect(html.includes(AI_PERMANENT_FAILURE_GUIDANCE)).toBe(permanent);
    expect(html).not.toContain(ECHO);
    expect(html).not.toContain('sk-ant');
  });

  it('모의: 본문 URL 로 unverifiable_citation → 영구 실패 안내(재시도마다 예약액 확정)', async () => {
    const owner = await freshOwner(`fix3-g21-cite-${randomUUID()}@example.local`);
    const c = await createContent(db, owner, { title: 'G21 인용', body: 'https://example.com/a 를 읽었다. 시장은 커졌다.' });
    const e = await runAssist(db, owner, c.content.id, { ...draft(), budget: budgetPolicy(loadConfig()) }, new MockLlmProvider()).then(
      () => null,
      (x: AppError) => x,
    );
    expect(e?.extra).toMatchObject({ failure_code: 'unverifiable_citation', permanent: true });
    const html = await renderPanel(owner, c.content.id);
    expect(html).toContain('<code>unverifiable_citation</code>');
    expect(html).toContain(AI_PERMANENT_FAILURE_GUIDANCE);
  });

  it('허용 목록 밖 run.error(원문 같은 값)는 화면에 그리지 않는다 — 일반 문구만', () => {
    const raw = `${ECHO} <script>x</script>`;
    const html = renderToStaticMarkup(createElement(RunFailureNotice, { error: raw }));
    expect(html).toContain('원인: 제안을 만들지 못했습니다.');
    expect(html).not.toContain(ECHO);
    expect(html).not.toContain('<code>');
    expect(html).not.toContain('data-failure-code');
    expect(renderToStaticMarkup(createElement(RunFailureNotice, { error: null }))).not.toContain('<code>');
  });

  it('route(JSON, live, 전역 fetch stub): 401 → 502 { error:llm_failed, run_id, failure_code:llm_auth_failed, permanent:true }, 원문·키 없음 / 폼 → 303 ?error=llm_failed', async () => {
    const c = await createContent(db, ownerA, { title: 'G21 route', body: '라우트 본문.' });
    const err = () => json(401, { type: 'error', error: { type: 'authentication_error', message: `${ECHO} ${KEY}` } })();
    try {
      for (const [k, v] of Object.entries(LIVE)) vi.stubEnv(k, v);
      vi.stubEnv('ANTHROPIC_API_KEY', KEY);
      vi.stubGlobal('fetch', (async () => err()) as unknown as typeof fetch);
      const res = await assistPOST(jsonPost(`/api/contents/${c.content.id}/assist`, { mode: 'draft', base_version: 1, brand_profile_version: 1 }, cookieHeader(tokenA)), ctx(c.content.id));
      const text = await res.text();
      expect(res.status).toBe(502);
      const body = JSON.parse(text);
      const runs = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.contentId, c.content.id));
      expect(runs).toHaveLength(1);
      expect(body).toMatchObject({ error: 'llm_failed', run_id: runs[0]!.id, failure_code: 'llm_auth_failed', permanent: true });
      expect(body.message).toContain(AI_PERMANENT_FAILURE_GUIDANCE);
      expect(text).not.toContain(ECHO);
      expect(text).not.toContain(KEY);
      const form = await assistPOST(
        formPost(`/api/contents/${c.content.id}/assist`, { mode: 'draft', base_version: '1', brand_profile_version: '1' }),
        ctx(c.content.id),
      );
      expect(form.status).toBe(303);
      expect(form.headers.get('location')).toContain('error=llm_failed');
    } finally {
      for (const k of [...Object.keys(LIVE), 'ANTHROPIC_API_KEY']) vi.stubEnv(k, '');
      vi.stubEnv('LLM_MODE', 'mock');
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------- G22
describe('FIX3-FULLREV2(G22) — budget_currency_mismatch 폼 경로는 자기 코드·문구', () => {
  it('이번 달 원장에 다른 통화(RUB) → 폼 제출 303 ?error=budget_currency_mismatch(conflict 아님), 문구는 통화 원인', async () => {
    const ownerB = (await seed(db, { allowedIdentity: B })).ownerId;
    as(B);
    const tokenB = await login(B);
    const c = await createContent(db, ownerB, { title: 'G22', body: '통화 본문.' });
    const rub = budgetPolicy(loadConfig({ LLM_BUDGET_CURRENCY: 'RUB' }));
    expect(rub.currency).toBe('RUB');
    await runAssist(db, ownerB, c.content.id, { mode: 'draft', baseVersion: 1, brandProfileVersion: 1, answerIds: [], budget: rub }, new MockLlmProvider());
    const runsBefore = (await db.select({ n: count() }).from(schema.generationRuns).where(eq(schema.generationRuns.ownerId, ownerB)))[0]!.n;
    const res = await assistPOST(formPost(`/api/contents/${c.content.id}/assist`, { mode: 'draft', base_version: '1', brand_profile_version: '1' }, tokenB), ctx(c.content.id));
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get('location')!, BASE);
    expect(loc.searchParams.get('error')).toBe('budget_currency_mismatch');
    expect(WRITING_ERROR_TEXT.budget_currency_mismatch).toContain('다른 통화');
    expect(WRITING_ERROR_TEXT.budget_currency_mismatch).not.toBe(WRITING_ERROR_TEXT.conflict);
    expect((await db.select({ n: count() }).from(schema.generationRuns).where(eq(schema.generationRuns.ownerId, ownerB)))[0]!.n).toBe(runsBefore);
  });
});

// ---------------------------------------------------------------- G29
const BODY = '# 첫 달 회고\n\n대리점과 첫 회의를 했다.\n\n재고 리스크를 먼저 합의했다.';

async function approvedBlogWithThreadsVariant() {
  const acc = Object.fromEntries((await listChannelAccounts(db, ownerA)).map((a) => [a.platform, a.id])) as Record<Channel, string>;
  const { content, version } = await createContent(db, ownerA, { title: `G29 ${randomUUID()}`, body: BODY });
  const { variant: blog } = await createVariantDraft(db, ownerA, content.id, { channel: 'blog', baseVersion: 1 });
  await setVariantLifecycle(db, ownerA, blog.id, { lifecycle: 'review', baseVersion: 1 });
  const { variant: threads } = await createVariantDraft(db, ownerA, content.id, { channel: 'threads', baseVersion: 1 });
  const planRes = await plansPOST(jsonPost('/api/distribution-plans', { items: [{ variant_id: blog.id, channel_account_id: acc.blog }] }, cookieHeader(tokenA)));
  expect(planRes.status).toBe(201);
  const p = (await planRes.json()) as { plan: { id: string }; items: Array<{ id: string; payload_hash: string }> };
  const item = p.items[0]!;
  const ap = await approvePOST(
    jsonPost(`/api/distribution-plans/${p.plan.id}/approve`, { item_ids: [item.id], expected_hashes: { [item.id]: item.payload_hash }, confirm: true, purpose: 'mock_publish' }, cookieHeader(tokenA)),
    ctx(p.plan.id),
  );
  expect(ap.status).toBe(200);
  return { contentId: content.id, versionId: version.id, blogId: blog.id, threadsId: threads.id, approvalId: ((await ap.json()) as { approvals: Array<{ id: string }> }).approvals[0]!.id };
}

async function snapshot(x: { contentId: string; blogId: string; threadsId: string; approvalId: string }) {
  const content = (await db.select().from(schema.contents).where(eq(schema.contents.id, x.contentId)))[0]!;
  const versions = (await db.select({ n: count() }).from(schema.contentVersions).where(eq(schema.contentVersions.contentId, x.contentId)))[0]!.n;
  const approval = (await db.select().from(schema.approvals).where(eq(schema.approvals.id, x.approvalId)))[0]!;
  const active = (await db.select({ n: count() }).from(schema.approvals).where(and(eq(schema.approvals.id, x.approvalId), isNull(schema.approvals.revokedAt))))[0]!.n;
  const variants = await db.select().from(schema.variants).where(eq(schema.variants.contentId, x.contentId));
  const variantVersions = await db.select().from(schema.variantVersions);
  const currentContentVersionOf = (vid: string) => {
    const v = variants.find((r) => r.id === vid)!;
    return variantVersions.find((vv) => vv.id === v.currentVersionId)!.contentVersionId;
  };
  return {
    currentVersionId: content.currentVersionId,
    updatedAt: content.updatedAt.toISOString(),
    versions,
    activeApprovals: active,
    revokeReason: approval.revokeReason,
    lifecycles: Object.fromEntries(variants.map((v) => [v.id, v.lifecycle])),
    // stale 판정: 파생본 현재 버전의 content_version_id ≠ 원고 현재 버전
    stale: Object.fromEntries([x.blogId, x.threadsId].map((id) => [id, currentContentVersionOf(id) !== content.currentVersionId])),
  };
}

describe('FIX3-FULLREV2(G29, D40-5) — 본문이 그대로인 저장은 새 버전을 만들지 않는다', () => {
  it('db: 같은 본문 / CRLF 만 다른 본문 / 메모만 있는 저장 → unchanged, 버전 수·활성 승인·파생본 lifecycle·stale 불변; 실제 변경은 새 버전 + 철회', async () => {
    const x = await approvedBlogWithThreadsVariant();
    const before = await snapshot(x);
    expect(before).toMatchObject({ versions: 1, activeApprovals: 1, revokeReason: null, stale: { [x.blogId]: false, [x.threadsId]: false } });
    expect(before.lifecycles[x.blogId]).toBe('approved');

    const same = await appendContentVersion(db, ownerA, x.contentId, { baseVersion: 1, body: BODY });
    expect(same.unchanged).toBe(true);
    expect(same.version.id).toBe(x.versionId);
    expect(await snapshot(x)).toEqual(before);

    const crlf = await appendContentVersion(db, ownerA, x.contentId, { baseVersion: 1, body: BODY.replace(/\n/g, '\r\n') });
    expect(crlf.unchanged).toBe(true);
    const cr = await appendContentVersion(db, ownerA, x.contentId, { baseVersion: 1, body: BODY.replace(/\n/g, '\r'), note: '메모만 바꿈' });
    expect(cr.unchanged).toBe(true);
    expect(await snapshot(x)).toEqual(before);
    const notes = await db.select({ note: schema.contentVersions.note }).from(schema.contentVersions).where(eq(schema.contentVersions.contentId, x.contentId));
    expect(notes).toEqual([{ note: null }]); // 메모는 저장되지 않는다(D40-5)
    const audits = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, 'content.version_append'), eq(schema.auditEvents.entityId, x.contentId)));
    expect(audits).toHaveLength(0);

    // 앞뒤 공백 하나라도 다르면 실제 변경
    const changed = await appendContentVersion(db, ownerA, x.contentId, { baseVersion: 1, body: `${BODY} ` });
    expect(changed.unchanged).toBe(false);
    expect(changed.version.version).toBe(2);
    const after = await snapshot(x);
    expect(after).toMatchObject({ versions: 2, activeApprovals: 0, revokeReason: 'invalidated:content_changed', stale: { [x.blogId]: true, [x.threadsId]: true } });
    expect(after.lifecycles[x.blogId]).toBe('draft');
  });

  it('route: JSON 같은 본문 → 200 unchanged:true + 현재 버전, 폼(CRLF·메모) → 303 ?unchanged=1, 둘 다 새 버전·철회 없음; 실제 변경 → 201 unchanged:false', async () => {
    const x = await approvedBlogWithThreadsVariant();
    const before = await snapshot(x);
    const res = await versionsPOST(jsonPost(`/api/contents/${x.contentId}/versions`, { base_version: 1, body: BODY, note: '메모' }, cookieHeader(tokenA)), ctx(x.contentId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.unchanged).toBe(true);
    expect(body.version).toMatchObject({ id: x.versionId, version: 1 });
    const form = await versionsPOST(formPost(`/api/contents/${x.contentId}/versions`, { base_version: '1', body: BODY.replace(/\n/g, '\r\n'), note: '폼 메모' }), ctx(x.contentId));
    expect(form.status).toBe(303);
    expect(form.headers.get('location')).toBe(`/contents/${x.contentId}?unchanged=1`);
    expect(await snapshot(x)).toEqual(before);
    const real = await versionsPOST(jsonPost(`/api/contents/${x.contentId}/versions`, { base_version: 1, body: `${BODY}\n\n추가 문단` }, cookieHeader(tokenA)), ctx(x.contentId));
    expect(real.status).toBe(201);
    expect((await real.json()).unchanged).toBe(false);
    expect((await snapshot(x)).activeApprovals).toBe(0);
  });

  it('오래된 base_version 이면 본문이 같아도 기존처럼 409 충돌(검사 순서 그대로)', async () => {
    const { content } = await createContent(db, ownerA, { title: 'G29 stale', body: 'a' });
    await appendContentVersion(db, ownerA, content.id, { baseVersion: 1, body: 'b' });
    const e = await appendContentVersion(db, ownerA, content.id, { baseVersion: 1, body: 'b' }).then(
      () => null,
      (x: AppError) => x,
    );
    expect(e?.code).toBe('conflict');
  });
});

// ---------------------------------------------------------------- G32
describe('FIX3-FULLREV2(G32) — 검색어 조각 상한 초과는 400(조용히 자르지 않음)', () => {
  const get = (q: string) => searchGET(new Request(`${BASE}/api/search?${new URLSearchParams({ q }).toString()}`, { headers: { accept: 'application/json', ...cookieHeader(tokenA) } }), undefined);
  it('고유 조각 9개 → 400 + 한국어 문구, 8개(중복 포함 9개) → 200', async () => {
    const nine = '해외 영업 재고 리스 계약 조건 협상 절차 주재원';
    const res = await get(nine);
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe(SEARCH_TERMS_LIMIT_MESSAGE);
    expect(SEARCH_TERMS_LIMIT_MESSAGE).toContain('검색어는 공백으로 나눈 조각 8개까지');
    const ok = await get('해외 영업 재고 리스 계약 조건 협상 절차 해외');
    expect(ok.status).toBe(200);
  });
});

// ---------------------------------------------------------------- G31 (브랜드 버전을 바꾸므로 마지막)
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
function conflictForm(html: string): { action: string; fields: Record<string, string> } {
  const forms = [...html.matchAll(/<form method="post" action="([^"]*)">([\s\S]*?)<\/form>/g)];
  expect(forms).toHaveLength(1);
  const [, action, inner] = forms[0]!;
  const fields: Record<string, string> = {};
  for (const m of inner!.matchAll(/<input\b[^>]*\bname="([^"]*)"[^>]*\bvalue="([^"]*)"[^>]*>/g)) fields[unesc(m[1]!)] = unesc(m[2]!);
  for (const m of inner!.matchAll(/<textarea\b[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/textarea>/g)) fields[unesc(m[1]!)] = unesc(m[2]!);
  for (const m of inner!.matchAll(/<select\b[^>]*\bname="([^"]*)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const sel = /<option value="([^"]*)" selected>/.exec(m[2]!) ?? /<option value="([^"]*)"/.exec(m[2]!);
    fields[unesc(m[1]!)] = unesc(sel![1]!);
  }
  return { action: unesc(action!), fields };
}

describe('FIX3-FULLREV2(G31) — Brand Profile 폼 저장 충돌은 409 비교 화면(내 입력 보존)', () => {
  it('탭 A 저장 → 탭 B(같은 base) 저장 409 HTML(내 입력·현재 값, escape, same-origin) → 그 화면에서 다시 저장 → 303 saved', async () => {
    const brandCount = async () => (await db.select({ n: count() }).from(schema.brandProfiles).where(eq(schema.brandProfiles.ownerId, ownerA)))[0]!.n;
    const base = (await db.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.ownerId, ownerA))).reduce((m, r) => Math.max(m, r.version), 0);
    const tabA = { base_version: String(base), pen_name: '탭A 필명', audience: '탭A 독자', pillars: 'A축', tone: 'formal', style_rules: '', avoid_phrases: '', cta_rules: '', sample_texts: '' };
    const first = await brandPOST(formPost('/api/brand', tabA));
    expect(first.status).toBe(303);
    expect(first.headers.get('location')).toBe(`/brand?saved=${base + 1}`);
    const n1 = await brandCount();

    const tabB = {
      base_version: String(base),
      pen_name: '탭B <필명> & "따옴표"',
      audience: '탭B 독자',
      pillars: '해외영업\r\nAI 활용',
      tone: 'casual',
      style_rules: '짧게 쓴다\r\n<script>alert(1)</script>',
      avoid_phrases: '혁신적인',
      cta_rules: '댓글로 질문',
      sample_texts: '첫 예문입니다.\r\n\r\n둘째 예문입니다.',
    };
    const res = await brandPOST(formPost('/api/brand', tabB));
    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await res.text();
    expect(await brandCount()).toBe(n1); // 버전은 탭 A 의 1개만 추가
    expect(html).toContain('탭B &lt;필명&gt; &amp; &quot;따옴표&quot;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('탭A 필명'); // 현재 서버 값
    expect(html).toContain('평어(반말)');
    const { action, fields } = conflictForm(html);
    expect(action).toBe('/api/brand');
    expect(fields).toEqual({ ...tabB, base_version: String(base + 1) });

    const again = await brandPOST(
      new Request(new URL(action, `${BASE}/api/brand`), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', origin: BASE, referer: `${BASE}/api/brand`, ...cookieHeader(tokenA) },
        body: new URLSearchParams(fields).toString(),
      }),
    );
    expect(again.status).toBe(303);
    expect(again.headers.get('location')).toBe(`/brand?saved=${base + 2}`);
    const saved = (await db.select().from(schema.brandProfiles).where(and(eq(schema.brandProfiles.ownerId, ownerA), eq(schema.brandProfiles.version, base + 2))))[0]!;
    expect(saved).toMatchObject({ penName: tabB.pen_name, tone: 'casual', pillars: ['해외영업', 'AI 활용'], sampleTexts: ['첫 예문입니다.', '둘째 예문입니다.'] });
    // JSON 충돌은 기존대로 409 JSON
    const j = await brandPOST(jsonPost('/api/brand', { base_version: base, pen_name: 'x', audience: 'y', pillars: ['z'] }, cookieHeader(tokenA)));
    expect(j.status).toBe(409);
    expect((await j.json()).error).toBe('conflict');
  });
});
