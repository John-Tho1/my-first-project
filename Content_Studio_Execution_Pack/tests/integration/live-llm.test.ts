/**
 * LIVE-L1(D34 1단계): 실제 Claude 어댑터(ClaudeLlmProvider)를 db 층·route 로 끝까지 — 가짜 fetch 가 기록된 Messages API 응답을 돌려준다.
 * 네트워크 0(setupFiles 가드가 api.anthropic.com 을 막는다), 과금 0. 시험 키는 가짜 sentinel 이며 응답·DB·감사에 나오지 않아야 한다.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { count, eq, sql } from 'drizzle-orm';
import {
  adoptProposal,
  appendContentVersion,
  closeDb,
  commitRestore,
  confirmClaims,
  createContent,
  createRestorePreview,
  createTestDb,
  ensureOwner,
  exportOwner,
  getDb,
  parseBundleZip,
  hasUnresolvedLiveUsage,
  listUnconfirmedExperienceClaims,
  liveRunsUsed,
  runAssist,
  runVariantAssist,
  schema,
  seed,
  updateContentMeta,
  usageLedgerView,
  type Db,
} from '@cs/db';
import {
  AppError,
  budgetPolicy,
  buildBundle,
  costMicro,
  fromMicro,
  LIVE_LLM_FIXED_INPUT_BYTES,
  LIVE_LLM_FRAMING_OVERHEAD_TOKENS,
  loadConfig,
  reserveFor,
  toMicro,
  utf8ByteLength,
  writeZip,
  type BundleTables,
} from '@cs/domain';
import { ClaudeLlmProvider, LocalStorageAdapter, MockLlmProvider } from '@cs/providers';
import { GET as healthGET } from '../../apps/web/app/api/health/route';
import { GET as healthDetailsGET } from '../../apps/web/app/api/health/details/route';
import { POST as assistPOST } from '../../apps/web/app/api/contents/[id]/assist/route';
import { BASE, cookieHeader, jsonPost, login } from './helpers';

const KEY = 'sk-ant-FAKE-integration-sentinel-9a8b7c';
const ECHO = 'UPSTREAM-ECHO-통합-원문-5d4c';
const MODEL = 'claude-opus-5-5';
const A = 'owner@example.local';

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
const policy = (extra: Record<string, string> = {}) => budgetPolicy(loadConfig({ ...LIVE, ...extra }));

let db: Db;
let ownerA: string;
let tokenA: string;

interface Call {
  url: string;
  headers: Headers;
  body: { model: string; max_tokens: number; system: string; messages: Array<{ role: string; content: string }>; output_config: { format: { schema: unknown } } };
}
function fakeFetch(...responses: Array<() => Response>) {
  const calls: Call[] = [];
  const fn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Call['body'],
    });
    const r = responses.shift();
    if (!r) throw new Error('fake fetch: 준비된 응답 없음');
    return r();
  }) as typeof fetch;
  return { fetch: fn, calls };
}
const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_011FAKEint' } });
const modelOut = {
  proposed_text: '첫 미팅 전에 상대 회사의 최근 발표 자료를 읽어 두면 대화가 빨라집니다.',
  proposed_tags: ['해외영업'],
  claims: [
    { text: '사전 조사가 대화를 빠르게 한다.', kind: 'opinion', source_refs: [], needs_user_confirmation: false },
    { text: '제가 직접 겪은 일입니다.', kind: 'fact', source_refs: [], needs_user_confirmation: false },
  ],
  followup_questions: ['어떤 산업의 독자인가요?'],
  warnings: [],
};
const message = (over: Record<string, unknown> = {}, text = JSON.stringify(modelOut)) => ({
  id: 'msg_01FAKEint',
  type: 'message',
  role: 'assistant',
  model: MODEL,
  content: [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text },
  ],
  stop_reason: 'end_turn',
  stop_sequence: null,
  stop_details: null,
  usage: { input_tokens: 1500, output_tokens: 800, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  ...over,
});
const claude = (f: typeof fetch) => new ClaudeLlmProvider({ apiKey: KEY, model: MODEL, fetch: f });

async function freshOwner(identity: string) {
  const owner = (await ensureOwner(db, identity)).id;
  await db.insert(schema.brandProfiles).values({ ownerId: owner, version: 1, penName: 'p', audience: 'a', pillars: ['x'] });
  return owner;
}
const n = async (t: typeof schema.generationRuns | typeof schema.usageLedger | typeof schema.claims | typeof schema.contentVersions) =>
  (await db.select({ n: count() }).from(t))[0]!.n;
const counts = async () => ({
  runs: await n(schema.generationRuns),
  ledger: await n(schema.usageLedger),
  claims: await n(schema.claims),
  versions: await n(schema.contentVersions),
});
const draft = (budget = policy()) => ({ mode: 'draft' as const, baseVersion: 1, brandProfileVersion: 1, answerIds: [], budget });
const failCode = async (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof AppError ? e.code : String(e)));
/** DB 의 실행 기록·원장·감사·버전 전체에 키·되풀이 원문이 없는지 */
async function expectDbClean() {
  const dump = JSON.stringify([
    await db.select().from(schema.generationRuns),
    await db.select().from(schema.usageLedger),
    await db.select().from(schema.auditEvents),
    await db.select().from(schema.contentVersions),
  ]);
  expect(dump.includes(KEY)).toBe(false);
  expect(dump.includes('sk-ant')).toBe(false);
  expect(dump.includes(ECHO)).toBe(false);
}

beforeAll(async () => {
  db = (await getDb(loadConfig())).db;
  ownerA = (await seed(db, { allowedIdentity: A })).ownerId;
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  tokenA = await login(A);
});
beforeEach(() => vi.stubEnv('AUTH_ALLOWED_IDENTITY', A));
afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await closeDb();
});

describe('db 층 + ClaudeLlmProvider(가짜 fetch)', () => {
  it('성공: 제안 버전(현재 아님)·claims, run model=claude-opus-5-5, 원장은 응답 usage 로 확정, 예약은 보낸 문자열 그대로를 센 상한', async () => {
    const owner = await freshOwner('live-l1-ok@example.local');
    const c = await createContent(db, owner, { title: '첫 미팅', body: '해외 영업 첫 미팅 준비에 대해 쓴다.' });
    const { fetch, calls } = fakeFetch(json(200, message()));
    const p = policy();
    const r = await runAssist(db, owner, c.content.id, draft(p), claude(fetch));
    expect(calls).toHaveLength(1);
    expect(r.run).toMatchObject({ status: 'succeeded', provider: 'anthropic', model: MODEL });
    expect(r.proposal.body).toBe(modelOut.proposed_text);
    expect(r.proposal.createdBy).toBe('ai:live');
    const [content] = await db.select().from(schema.contents).where(eq(schema.contents.id, c.content.id));
    expect(content!.currentVersionId).toBe(c.version.id); // 제안은 현재 버전이 아니다
    // 1인칭 claim → experience + 확인 필요(기존 규칙)
    expect(r.claims.map((x) => [x.kind, x.needs_user_confirmation])).toEqual([
      ['opinion', false],
      ['experience', true],
    ]);
    // 예약: 실제로 보낸 프롬프트로 다시 계산한 값과 같고, 입력 추정 = 보낸 바이트 + 고정분 + 여유
    const sent = calls[0]!.body;
    const expected = reserveFor(p, sent.messages[0]!.content);
    expect(toMicro(r.ledger.reservedAmount)).toBe(expected.reserveMicro);
    expect(expected.tokensIn).toBe(
      utf8ByteLength(sent.messages[0]!.content) + utf8ByteLength(sent.system) + utf8ByteLength(JSON.stringify(sent.output_config.format.schema)) + LIVE_LLM_FRAMING_OVERHEAD_TOKENS,
    );
    expect(utf8ByteLength(sent.system) + utf8ByteLength(JSON.stringify(sent.output_config.format.schema))).toBe(LIVE_LLM_FIXED_INPUT_BYTES);
    expect(sent.max_tokens).toBe(4096);
    expect(r.ledger.pricingSnapshot).toMatchObject({ mode: 'live', token_estimate: 'utf8_bytes+fixed+overhead', output_allowance_tokens: 4096 });
    // 확정: 응답 usage(1500/800) × 단가
    expect(r.ledger).toMatchObject({ state: 'settled', tokensIn: 1500, tokensOut: 800, failed: false, overBudget: false });
    expect(r.ledger.actualAmount).toBe(fromMicro(costMicro(p.pricing, 1500, 800)));
    await expectDbClean();
  });

  it('실제 사용량이 예약을 넘으면(가정 밖) 자르지 않고 그대로 기록 — overage·over_budget', async () => {
    const owner = await freshOwner('live-l1-overage@example.local');
    const c = await createContent(db, owner, { title: '초과', body: '짧은 본문.' });
    const { fetch } = fakeFetch(json(200, message({ usage: { input_tokens: 200_000, output_tokens: 4096 } })));
    const p = policy();
    const r = await runAssist(db, owner, c.content.id, draft(p), claude(fetch));
    const actual = costMicro(p.pricing, 200_000, 4096);
    expect(actual).toBeGreaterThan(toMicro(r.ledger.reservedAmount));
    expect(r.ledger).toMatchObject({ tokensIn: 200_000, tokensOut: 4096, overBudget: true, actualAmount: fromMicro(actual) });
    expect(r.ledger.overageAmount).toBe(fromMicro(actual - toMicro(r.ledger.reservedAmount)));
    expect((r.run.outputJson as { over_budget?: boolean }).over_budget).toBe(true);
  });

  it('refusal: run failed(llm_refusal), 502 llm_failed, 본문·현재 버전 그대로, 원장은 예약액 전액 확정(D13), 모델 텍스트 저장 없음', async () => {
    const owner = await freshOwner('live-l1-refusal@example.local');
    const c = await createContent(db, owner, { title: '거절', body: '사용자 원문은 그대로 남아야 한다.' });
    const before = await counts();
    const { fetch, calls } = fakeFetch(
      json(200, message({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: ECHO } }, `{"proposed_text":"${ECHO}`)),
    );
    expect(await failCode(runAssist(db, owner, c.content.id, draft(), claude(fetch)))).toBe('llm_failed');
    expect(calls).toHaveLength(1);
    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.contentId, c.content.id));
    expect(run).toMatchObject({ status: 'failed', error: 'llm_refusal', outputJson: null, provider: 'anthropic', model: MODEL });
    const [ledger] = await db.select().from(schema.usageLedger).where(eq(schema.usageLedger.runId, run!.id));
    expect(ledger).toMatchObject({ state: 'settled', failed: true, actualAmount: ledger!.reservedAmount });
    expect(toMicro(ledger!.reservedAmount)).toBeGreaterThan(0n);
    const [content] = await db.select().from(schema.contents).where(eq(schema.contents.id, c.content.id));
    expect(content!.currentVersionId).toBe(c.version.id);
    const versions = await db.select().from(schema.contentVersions).where(eq(schema.contentVersions.contentId, c.content.id));
    expect(versions.map((v) => v.body)).toEqual(['사용자 원문은 그대로 남아야 한다.']);
    const after = await counts();
    expect(after).toEqual({ ...before, runs: before.runs + 1, ledger: before.ledger + 1 });
    const audits = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.versionOrHash, run!.id));
    expect(audits.map((a) => a.sanitizedDetails)).toEqual([expect.objectContaining({ status: 'failed', provider: 'anthropic', error: 'llm_refusal' })]);
    await expectDbClean();
  });

  it.each([
    [401, 'authentication_error', 'llm_auth_failed'],
    [429, 'rate_limit_error', 'llm_rate_limited'],
    [529, 'overloaded_error', 'llm_server_error'],
  ])('HTTP %i → run failed(%s → %s), 호출 1번, 원장 예약액 확정, 원문·키 저장 없음', async (status, type, code) => {
    const owner = await freshOwner(`live-l1-http-${status}@example.local`);
    const c = await createContent(db, owner, { title: `오류 ${status}`, body: '본문.' });
    const { fetch, calls } = fakeFetch(json(status, { type: 'error', error: { type, message: `${ECHO} ${KEY}` } }), json(200, message()));
    expect(await failCode(runAssist(db, owner, c.content.id, draft(), claude(fetch)))).toBe('llm_failed');
    expect(calls).toHaveLength(1);
    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.contentId, c.content.id));
    expect(run).toMatchObject({ status: 'failed', error: code });
    const [ledger] = await db.select().from(schema.usageLedger).where(eq(schema.usageLedger.runId, run!.id));
    expect(ledger).toMatchObject({ failed: true, actualAmount: ledger!.reservedAmount });
    await expectDbClean();
  });

  it('예산 429: 월 상한·1회 상한을 넘으면 호출 0번, run·원장·버전 없음', async () => {
    const owner = await freshOwner('live-l1-budget@example.local');
    const c = await createContent(db, owner, { title: '예산', body: '본문.' });
    const before = await counts();
    const { fetch, calls } = fakeFetch(json(200, message()), json(200, message()));
    const monthly = policy({ LLM_BUDGET_MONTHLY_LIMIT: '0.01', LLM_BUDGET_PER_RUN_MAX: '' });
    const perRun = policy({ LLM_BUDGET_PER_RUN_MAX: '0.05' });
    for (const p of [monthly, perRun]) {
      const e = await runAssist(db, owner, c.content.id, draft(p), claude(fetch)).then(
        () => null,
        (x: unknown) => x as AppError,
      );
      expect([e?.kind, e?.code]).toEqual(['budget_exceeded', 'budget_exceeded']);
    }
    expect((await runAssist(db, owner, c.content.id, draft(monthly), claude(fetch)).catch((x: AppError) => x.extra))).toMatchObject({ reason: 'monthly_limit' });
    expect((await runAssist(db, owner, c.content.id, draft(perRun), claude(fetch)).catch((x: AppError) => x.extra))).toMatchObject({ reason: 'per_run_max' });
    expect(calls).toHaveLength(0);
    expect(await counts()).toEqual(before);
  });

  it('채널 초안(variant)도 같은 provider·같은 예약 규칙, usage 로 확정', async () => {
    const owner = await freshOwner('live-l1-variant@example.local');
    const c = await createContent(db, owner, { title: '채널', body: '블로그용 본문.' });
    const plain = { ...modelOut, claims: [{ text: '사전 조사가 중요하다.', kind: 'opinion', source_refs: [], needs_user_confirmation: false }] };
    const { fetch, calls } = fakeFetch(json(200, message({ usage: { input_tokens: 900, output_tokens: 300 } }, JSON.stringify(plain))));
    const p = policy();
    const r = await runVariantAssist(db, owner, c.content.id, { channel: 'blog', baseVersion: 1, budget: p }, claude(fetch));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.max_tokens).toBe(4096);
    expect(toMicro(r.ledger.reservedAmount)).toBe(reserveFor(p, calls[0]!.body.messages[0]!.content).reserveMicro);
    expect(r.ledger).toMatchObject({ tokensIn: 900, tokensOut: 300, actualAmount: fromMicro(costMicro(p.pricing, 900, 300)) });
  });
});

describe('route·health(서버 환경의 키, 가짜 fetch 는 전역 stub — 실제 전송 없음)', () => {
  const stubLive = (key: string) => {
    for (const [k, v] of Object.entries(LIVE)) vi.stubEnv(k, v);
    vi.stubEnv('ANTHROPIC_API_KEY', key);
  };
  const reset = () => {
    for (const k of [...Object.keys(LIVE), 'ANTHROPIC_API_KEY']) vi.stubEnv(k, '');
    vi.stubEnv('LLM_MODE', 'mock');
    vi.unstubAllGlobals();
  };
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  /** T21-P3(G4): llm 준비 상태는 로그인 뒤 GET /api/health/details 에만 있다. */
  const healthDetails = () => healthDetailsGET(new Request(`${BASE}/api/health/details`, { headers: cookieHeader(tokenA) }), undefined);

  it('모두 갖추면 POST assist → 201 실제 provider(anthropic), mock_warning 없음, 응답에 키 없음 / health live_ready=true', async () => {
    const c = await createContent(db, ownerA, { title: 'route live', body: '라우트 본문.' });
    const { fetch, calls } = fakeFetch(json(200, message()));
    try {
      stubLive(KEY);
      vi.stubGlobal('fetch', fetch);
      const res = await assistPOST(jsonPost(`/api/contents/${c.content.id}/assist`, { mode: 'draft', base_version: 1, brand_profile_version: 1 }, cookieHeader(tokenA)), ctx(c.content.id));
      const text = await res.text();
      expect(res.status).toBe(201);
      const body = JSON.parse(text);
      expect(body.run).toMatchObject({ provider: 'anthropic', model: MODEL, status: 'succeeded' });
      expect(body.mock_warning).toBeNull();
      expect(text.includes(KEY)).toBe(false);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
      expect(calls[0]!.headers.get('x-api-key') === KEY).toBe(true);
      const h = await healthDetails();
      expect(h.status).toBe(200);
      const htext = await h.text();
      // T21-P3(G4): 공개 health 에는 llm 준비 상태가 없다(키·승인 기록 참조도 물론 없음)
      const pub = await (await healthGET()).text();
      expect(Object.keys(JSON.parse(pub)).sort()).toEqual(['app', 'db_ok', 'status', 'time_utc']);
      expect(pub.includes(KEY)).toBe(false);
      expect(JSON.parse(htext).llm).toEqual({ mode: 'live', live_ready: true, missing: [] });
      expect(htext.includes(KEY)).toBe(false);
      expect(htext).not.toContain('D34-test-approval');
    } finally {
      reset();
    }
  });

  it.each([
    ['ANTHROPIC_API_KEY', ''],
    ['ANTHROPIC_API_KEY(형식)', 'sk-ant FAKE with space'],
  ])('키 상태 %s → 503 live_provider_not_configured(이름만), 아무것도 쓰지 않음, 호출 0', async (name, key) => {
    const c = await createContent(db, ownerA, { title: `route ${name}`, body: '본문.' });
    const before = await counts();
    const { fetch, calls } = fakeFetch(json(200, message()));
    try {
      stubLive(key);
      vi.stubGlobal('fetch', fetch);
      const res = await assistPOST(jsonPost(`/api/contents/${c.content.id}/assist`, { mode: 'draft', base_version: 1, brand_profile_version: 1 }, cookieHeader(tokenA)), ctx(c.content.id));
      const text = await res.text();
      expect(res.status).toBe(503);
      expect(JSON.parse(text).error).toBe('live_provider_not_configured');
      expect(text).toContain(name);
      expect(text).not.toContain('FAKE');
      const h = await (await healthDetails()).json();
      expect(h.llm).toEqual({ mode: 'live', live_ready: false, missing: [name] });
    } finally {
      reset();
    }
    expect(calls).toHaveLength(0);
    expect(await counts()).toEqual(before);
  });

  it('기본(mock) 모드: 키가 있어도 모의 provider(실제 호출 경로 없음)', async () => {
    const c = await createContent(db, ownerA, { title: 'route mock', body: '모의 본문.' });
    try {
      vi.stubEnv('ANTHROPIC_API_KEY', KEY);
      const res = await assistPOST(jsonPost(`/api/contents/${c.content.id}/assist`, { mode: 'draft', base_version: 1, brand_profile_version: 1 }, cookieHeader(tokenA)), ctx(c.content.id));
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.run.provider).toBe('mock');
      expect(body.mock_warning).not.toBeNull();
    } finally {
      reset();
    }
  });
});

// ---- FIX round 1(Codex review-LIVEL1) ----

const BIG = { input_tokens: 200_000, output_tokens: 4096 };
const ledgerOf = async (contentId: string) => {
  const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.contentId, contentId));
  const [ledger] = await db.select().from(schema.usageLedger).where(eq(schema.usageLedger.runId, run!.id));
  return { run: run!, ledger: ledger! };
};

describe('FIX1 P1 :93 — 예약은 추정, 실제는 항상 기록, 초과는 다음 예약에서 막힌다(상한 초과는 최대 1회분)', () => {
  it('실제액이 1회 상한·월 잔여를 넘는 호출 → 초과액 그대로 기록, 다음 예약은 429(호출 0)', async () => {
    const owner = await freshOwner('live-l1-fix1-cap@example.local');
    const c = await createContent(db, owner, { title: '상한 초과', body: '짧은 본문.' });
    const p = policy({ LLM_BUDGET_PER_RUN_MAX: '0.5', LLM_BUDGET_MONTHLY_LIMIT: '0.6' });
    const { fetch, calls } = fakeFetch(json(200, message({ usage: { input_tokens: 300_000, output_tokens: 4096 } })), json(200, message()));
    const r = await runAssist(db, owner, c.content.id, draft(p), claude(fetch));
    const actual = costMicro(p.pricing, 300_000, 4096);
    expect(actual).toBeGreaterThan(p.perRunMaxMicro!);
    expect(actual).toBeGreaterThan(p.monthlyLimitMicro!);
    expect(toMicro(r.ledger.reservedAmount)).toBeLessThanOrEqual(p.perRunMaxMicro!);
    expect(r.ledger).toMatchObject({ actualAmount: fromMicro(actual), overBudget: true, overageAmount: fromMicro(actual - toMicro(r.ledger.reservedAmount)) });
    const before = await counts();
    const e = await runAssist(db, owner, c.content.id, draft(p), claude(fetch)).then(
      () => null,
      (x: AppError) => x,
    );
    expect([e?.code, (e?.extra as { reason?: string } | undefined)?.reason]).toEqual(['budget_exceeded', 'monthly_limit']);
    expect(calls).toHaveLength(1);
    expect(await counts()).toEqual(before);
  });
});

describe('FIX1 P1 :222 — 실패 정산 = max(예약액, 응답 usage 비용), failed=true, 초과 기록', () => {
  it.each<[string, Record<string, unknown>, string | undefined, string]>([
    ['refusal', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: ECHO } }, `{"x":"${ECHO}`, 'llm_refusal'],
    ['max_tokens', { stop_reason: 'max_tokens' }, `{"proposed_text":"${ECHO}`, 'llm_max_tokens'],
    ['unexpected_stop', { stop_reason: 'model_context_window_exceeded' }, undefined, 'llm_unexpected_stop'],
    ['invalid_output', {}, `nope ${ECHO}`, 'llm_invalid_output'],
    ['citation', {}, JSON.stringify({ ...modelOut, proposed_text: '자세한 내용은 https://fake.example/report 참고.' }), 'unverifiable_citation'],
  ])('%s + 예약 초과 usage → run failed, 실제액 = usage 비용, overage·over_budget, tokens 기록, 원문 없음', async (label, over, text, code) => {
    const owner = await freshOwner(`live-l1-fix1-fail-${label}@example.local`);
    const c = await createContent(db, owner, { title: `실패 ${label}`, body: '사용자 원문.' });
    const { fetch } = fakeFetch(json(200, message({ ...over, usage: BIG }, text)));
    const p = policy();
    expect(await failCode(runAssist(db, owner, c.content.id, draft(p), claude(fetch)))).toBe('llm_failed');
    const { run, ledger } = await ledgerOf(c.content.id);
    expect(run).toMatchObject({ status: 'failed', error: code });
    const actual = costMicro(p.pricing, BIG.input_tokens, BIG.output_tokens);
    expect(actual).toBeGreaterThan(toMicro(ledger.reservedAmount));
    expect(ledger).toMatchObject({
      state: 'settled',
      failed: true,
      tokensIn: BIG.input_tokens,
      tokensOut: BIG.output_tokens,
      actualAmount: fromMicro(actual),
      overageAmount: fromMicro(actual - toMicro(ledger.reservedAmount)),
      overBudget: true,
    });
    const versions = await db.select().from(schema.contentVersions).where(eq(schema.contentVersions.contentId, c.content.id));
    expect(versions.map((v) => v.body)).toEqual(['사용자 원문.']);
    await expectDbClean();
  });

  it('실패 + 예약보다 작은 usage → 실제액은 예약액(D13 그대로), tokens 는 응답 값, 초과 없음', async () => {
    const owner = await freshOwner('live-l1-fix1-fail-small@example.local');
    const c = await createContent(db, owner, { title: '작은 실패', body: '본문.' });
    const { fetch } = fakeFetch(json(200, message({ stop_reason: 'max_tokens', usage: { input_tokens: 10, output_tokens: 20 } })));
    await failCode(runAssist(db, owner, c.content.id, draft(), claude(fetch)));
    const { ledger } = await ledgerOf(c.content.id);
    expect(ledger).toMatchObject({ failed: true, tokensIn: 10, tokensOut: 20, actualAmount: ledger.reservedAmount, overBudget: false });
  });

  it('usage 를 모르는 실패(HTTP 529) → D13 그대로(예약액, tokens 없음)', async () => {
    const owner = await freshOwner('live-l1-fix1-fail-nousage@example.local');
    const c = await createContent(db, owner, { title: '모름', body: '본문.' });
    const { fetch } = fakeFetch(json(529, { type: 'error', error: { type: 'overloaded_error', message: ECHO } }));
    await failCode(runAssist(db, owner, c.content.id, draft(), claude(fetch)));
    const { ledger } = await ledgerOf(c.content.id);
    expect(ledger).toMatchObject({ failed: true, tokensIn: null, tokensOut: null, actualAmount: ledger.reservedAmount, overBudget: false });
  });

  it('채널 초안(variant) 실패도 같은 정산', async () => {
    const owner = await freshOwner('live-l1-fix1-variant-fail@example.local');
    const c = await createContent(db, owner, { title: '채널 실패', body: '본문.' });
    const { fetch } = fakeFetch(json(200, message({ stop_reason: 'refusal', usage: BIG })));
    const p = policy();
    await failCode(runVariantAssist(db, owner, c.content.id, { channel: 'blog', baseVersion: 1, budget: p }, claude(fetch)));
    const { ledger } = await ledgerOf(c.content.id);
    expect(ledger).toMatchObject({
      failed: true,
      tokensIn: BIG.input_tokens,
      overBudget: true,
      actualAmount: fromMicro(costMicro(p.pricing, BIG.input_tokens, BIG.output_tokens)),
    });
  });

  it('모의 provider 실패는 기존 D13 그대로(tokens 없음, 예약액)', async () => {
    const owner = await freshOwner('live-l1-fix1-mock-fail@example.local');
    const c = await createContent(db, owner, { title: '모의 실패', body: '본문.' });
    const priced = budgetPolicy(loadConfig({ LLM_PRICE_INPUT_PER_1K: '1', LLM_PRICE_OUTPUT_PER_1K: '1' }));
    await failCode(runAssist(db, owner, c.content.id, draft(priced), new MockLlmProvider({ fail: true })));
    const { ledger } = await ledgerOf(c.content.id);
    expect(ledger).toMatchObject({ failed: true, tokensIn: null, tokensOut: null, actualAmount: ledger.reservedAmount });
  });
});

describe('FIX1 놓친 케이스(c) — proposed_text 의 미확인 1인칭 경험은 채택 뒤 게이트에 걸린다', () => {
  it('claims=[] 인 출력의 1인칭 문장 → experience claim 저장 → 채택하면 미확인 경험으로 남음', async () => {
    const owner = await freshOwner('live-l1-fix1-gate@example.local');
    const c = await createContent(db, owner, { title: '게이트', body: '본문.' });
    const out = { ...modelOut, proposed_text: '해외 영업 이야기. 제가 직접 계약서를 고쳐 썼습니다.', claims: [] };
    const { fetch } = fakeFetch(json(200, message({}, JSON.stringify(out))));
    const r = await runAssist(db, owner, c.content.id, draft(), claude(fetch));
    // FIX3-LIVEL1: 확인 claim 단위가 문단으로 바뀌었다(의도한 동작 변경) — 1인칭 문장이 든 문단 전체
    expect(r.claims.map((x) => [x.text, x.kind, x.needs_user_confirmation])).toEqual([['해외 영업 이야기. 제가 직접 계약서를 고쳐 썼습니다.', 'experience', true]]);
    await adoptProposal(db, owner, c.content.id, r.run.id, 1);
    const unresolved = await listUnconfirmedExperienceClaims(db, owner, c.content.id);
    expect(unresolved.map((u) => [u.run_id, u.claim_index])).toEqual([[r.run.id, 0]]);
  });
});

describe('FIX1 놓친 케이스(d) — LLM_LIVE_MAX_RUNS(D34 2단계 범위)', () => {
  const limited = (extra: Record<string, string> = {}) => policy({ LLM_LIVE_MAX_RUNS: '1', ...extra });

  it('순차: 같은 승인 기록으로 1회 뒤 2번째는 429 live_run_limit(호출 0·행 0), 승인 기록이 바뀌면 다시 1회', async () => {
    const owner = await freshOwner('live-l1-fix1-runs-seq@example.local');
    const c = await createContent(db, owner, { title: '횟수', body: '본문.' });
    const { fetch, calls } = fakeFetch(json(200, message()), json(200, message()));
    const first = await runAssist(db, owner, c.content.id, draft(limited()), claude(fetch));
    expect(first.run.status).toBe('succeeded');
    const before = await counts();
    const e = await runAssist(db, owner, c.content.id, draft(limited()), claude(fetch)).then(
      () => null,
      (x: AppError) => x,
    );
    expect([e?.kind, e?.code]).toEqual(['budget_exceeded', 'live_run_limit']);
    expect(calls).toHaveLength(1);
    expect(await counts()).toEqual(before);
    const next = await runAssist(db, owner, c.content.id, draft(limited({ LLM_LIVE_APPROVAL_REF: 'D34-test-approval-2' })), claude(fetch));
    expect(next.run.status).toBe('succeeded');
    expect(calls).toHaveLength(2);
    // 승인 기록 값은 원장 스냅숏에 남지만 사용량 view(화면·API 응답)에는 나오지 않는다
    expect(next.ledger.pricingSnapshot).toMatchObject({ approval_ref: 'D34-test-approval-2' });
    expect(JSON.stringify(usageLedgerView(next.ledger))).not.toContain('D34-test-approval');
  });

  it('실패한 호출도 1회로 센다', async () => {
    const owner = await freshOwner('live-l1-fix1-runs-fail@example.local');
    const c = await createContent(db, owner, { title: '실패 횟수', body: '본문.' });
    const { fetch, calls } = fakeFetch(json(529, { type: 'error', error: { type: 'overloaded_error', message: 'x' } }), json(200, message()));
    await failCode(runAssist(db, owner, c.content.id, draft(limited()), claude(fetch)));
    expect(await failCode(runAssist(db, owner, c.content.id, draft(limited()), claude(fetch)))).toBe('live_run_limit');
    expect(calls).toHaveLength(1);
  });

  it('동시 2건 → 정확히 1건만 호출, 1건은 live_run_limit', async () => {
    const owner = await freshOwner('live-l1-fix1-runs-conc@example.local');
    const c1 = await createContent(db, owner, { title: '동시 1', body: '본문 1.' });
    const c2 = await createContent(db, owner, { title: '동시 2', body: '본문 2.' });
    const { fetch, calls } = fakeFetch(json(200, message()), json(200, message()));
    const results = await Promise.allSettled([
      runAssist(db, owner, c1.content.id, draft(limited()), claude(fetch)),
      runAssist(db, owner, c2.content.id, draft(limited()), claude(fetch)),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((x): x is PromiseRejectedResult => x.status === 'rejected');
    expect(rejected.map((x) => (x.reason as AppError).code)).toEqual(['live_run_limit']);
    expect(calls).toHaveLength(1);
    expect((await db.select().from(schema.usageLedger).where(eq(schema.usageLedger.ownerId, owner))).length).toBe(1);
  });

  it('LLM_LIVE_MAX_RUNS 없음 → 횟수 제한 없음(기존 동작)', async () => {
    const owner = await freshOwner('live-l1-fix1-runs-none@example.local');
    const c = await createContent(db, owner, { title: '무제한', body: '본문.' });
    const { fetch, calls } = fakeFetch(json(200, message()), json(200, message()));
    await runAssist(db, owner, c.content.id, draft(), claude(fetch));
    await runAssist(db, owner, c.content.id, draft(), claude(fetch));
    expect(calls).toHaveLength(2);
  });
});

// ---- FIX round 2(Codex review-FIX-LIVEL1) ----

const snapshotOf = (l: { pricingSnapshot: Record<string, unknown> }) => l.pricingSnapshot;

describe('FIX2 P1 :287 — 짧은 경험 claim 을 확인해도 본문의 다른 경험은 게이트에 남는다', () => {
  it('공백 없이 이어진 두 경험 + 첫 문장만 claim → 둘째 문장 claim 추가 → 첫째만 확인해도 ready 전환은 409', async () => {
    const owner = await freshOwner('live-l1-fix2-gate@example.local');
    const c = await createContent(db, owner, { title: '부분 claim', body: '본문.' });
    const out = {
      ...modelOut,
      proposed_text: '제가 직접 협상했습니다.그리고 제가 매출을 두 배로 늘렸습니다.',
      claims: [{ text: '제가 직접 협상했습니다.', kind: 'experience', source_refs: [], needs_user_confirmation: true }],
    };
    const { fetch } = fakeFetch(json(200, message({}, JSON.stringify(out))));
    const r = await runAssist(db, owner, c.content.id, draft(), claude(fetch));
    // FIX3-LIVEL1: 문단 단위 — 첫 문장 claim 은 문단과 같지 않으므로 문단 전체 claim 이 더해진다(의도한 동작 변경)
    expect(r.claims.map((x) => x.text)).toEqual(['제가 직접 협상했습니다.', '제가 직접 협상했습니다.그리고 제가 매출을 두 배로 늘렸습니다.']);
    await adoptProposal(db, owner, c.content.id, r.run.id, 1);
    const after = await confirmClaims(db, owner, c.content.id, r.run.id, [0]);
    expect(after.unconfirmed.map((u) => u.claim_index)).toEqual([1]);
    const rev = async () => (await db.select().from(schema.contents).where(eq(schema.contents.id, c.content.id)))[0]!.revision;
    await updateContentMeta(db, owner, c.content.id, { lifecycle: 'review' }, await rev());
    const e = await updateContentMeta(db, owner, c.content.id, { lifecycle: 'ready' }, await rev()).then(
      () => null,
      (x: AppError) => x,
    );
    expect(e?.code).toBe('unconfirmed_experience_claims');
  });
});

describe('FIX2 P2 :489 — 원장 usage 출처(usage_source): provider | estimate | none', () => {
  it('성공 + 유효 usage → provider, tokens = 응답 값', async () => {
    const owner = await freshOwner('live-l1-fix2-src-ok@example.local');
    const c = await createContent(db, owner, { title: '출처 provider', body: '본문.' });
    const { fetch } = fakeFetch(json(200, message()));
    const r = await runAssist(db, owner, c.content.id, draft(), claude(fetch));
    expect(r.ledger).toMatchObject({ tokensIn: 1500, tokensOut: 800 });
    expect(snapshotOf(r.ledger)).toMatchObject({ usage_source: 'provider' });
  });

  it('성공 + usage 이상 → run 은 성공, 원장은 예약액(D13)·tokens NULL·usage_source none', async () => {
    const owner = await freshOwner('live-l1-fix2-src-bad@example.local');
    const c = await createContent(db, owner, { title: '출처 none', body: '본문.' });
    const { fetch } = fakeFetch(json(200, message({ usage: { input_tokens: 'x', output_tokens: 1 } })));
    const r = await runAssist(db, owner, c.content.id, draft(), claude(fetch));
    expect(r.run.status).toBe('succeeded');
    expect(r.ledger).toMatchObject({ tokensIn: null, tokensOut: null, actualAmount: r.ledger.reservedAmount, overBudget: false, failed: false });
    expect(snapshotOf(r.ledger)).toMatchObject({ usage_source: 'none' });
  });

  it('usage 없음 + 서버 인용 검증 실패 → 예약액·tokens NULL·usage_source none(추정을 실제처럼 쓰지 않음)', async () => {
    const owner = await freshOwner('live-l1-fix2-src-cite@example.local');
    const c = await createContent(db, owner, { title: '출처 인용', body: '본문.' });
    const text = JSON.stringify({ ...modelOut, proposed_text: '자세한 내용은 https://fake.example/x 참고.' });
    const { fetch } = fakeFetch(json(200, message({ usage: undefined }, text)));
    expect(await failCode(runAssist(db, owner, c.content.id, draft(), claude(fetch)))).toBe('llm_failed');
    const { run, ledger } = await ledgerOf(c.content.id);
    expect(run.error).toBe('unverifiable_citation');
    expect(ledger).toMatchObject({ failed: true, tokensIn: null, tokensOut: null, actualAmount: ledger.reservedAmount });
    expect(snapshotOf(ledger)).toMatchObject({ usage_source: 'none' });
  });

  it('응답 없는 실패(HTTP 529) → usage_source none, tokens NULL', async () => {
    const owner = await freshOwner('live-l1-fix2-src-529@example.local');
    const c = await createContent(db, owner, { title: '출처 529', body: '본문.' });
    const { fetch } = fakeFetch(json(529, { type: 'error', error: { type: 'overloaded_error', message: 'x' } }));
    await failCode(runAssist(db, owner, c.content.id, draft(), claude(fetch)));
    const { ledger } = await ledgerOf(c.content.id);
    expect(ledger).toMatchObject({ tokensIn: null, tokensOut: null });
    expect(snapshotOf(ledger)).toMatchObject({ usage_source: 'none' });
  });

  it('실패 + 응답 usage(refusal) → usage_source provider', async () => {
    const owner = await freshOwner('live-l1-fix2-src-refusal@example.local');
    const c = await createContent(db, owner, { title: '출처 거절', body: '본문.' });
    const { fetch } = fakeFetch(json(200, message({ stop_reason: 'refusal', usage: { input_tokens: 5, output_tokens: 6 } })));
    await failCode(runAssist(db, owner, c.content.id, draft(), claude(fetch)));
    const { ledger } = await ledgerOf(c.content.id);
    expect(ledger).toMatchObject({ tokensIn: 5, tokensOut: 6 });
    expect(snapshotOf(ledger)).toMatchObject({ usage_source: 'provider' });
  });

  it('모의 성공 → usage_source estimate(글자/3 결정적 추정)', async () => {
    const owner = await freshOwner('live-l1-fix2-src-mock@example.local');
    const c = await createContent(db, owner, { title: '출처 모의', body: '모의 본문.' });
    const r = await runAssist(db, owner, c.content.id, { ...draft(), budget: undefined }, new MockLlmProvider());
    expect(snapshotOf(r.ledger)).toMatchObject({ usage_source: 'estimate' });
  });
});

describe('FIX2 놓친 케이스 — 초과·동시·범위·복원', () => {
  it('(a) 실제액 > 예약액·1회 상한이어도 월 잔여가 충분하면 다음 요청은 허용(1회 상한은 예약 추정에만 적용)', async () => {
    const owner = await freshOwner('live-l1-fix2-next-ok@example.local');
    const c = await createContent(db, owner, { title: '다음 허용', body: '본문.' });
    const p = policy({ LLM_BUDGET_PER_RUN_MAX: '0.5', LLM_BUDGET_MONTHLY_LIMIT: '10' });
    const { fetch, calls } = fakeFetch(json(200, message({ usage: { input_tokens: 200_000, output_tokens: 4096 } })), json(200, message()));
    const first = await runAssist(db, owner, c.content.id, draft(p), claude(fetch));
    expect(toMicro(first.ledger.actualAmount!)).toBeGreaterThan(p.perRunMaxMicro!);
    expect(first.ledger.overBudget).toBe(true);
    const next = await runAssist(db, owner, c.content.id, draft(p), claude(fetch));
    expect(next.run.status).toBe('succeeded');
    expect(calls).toHaveLength(2);
  });

  it('(b) 횟수 제한 없는 동시 호출 2건이 각각 예약을 넘으면 초과액이 합쳐져, 월 상한을 한 호출의 초과액보다 더 넘는다(문서화한 동작)', async () => {
    const owner = await freshOwner('live-l1-fix2-conc-over@example.local');
    const c1 = await createContent(db, owner, { title: '동시 초과 1', body: '본문 1.' });
    const c2 = await createContent(db, owner, { title: '동시 초과 2', body: '본문 2.' });
    const p = policy({ LLM_BUDGET_MONTHLY_LIMIT: '0.3' });
    const big = { usage: { input_tokens: 200_000, output_tokens: 4096 } };
    // 두 호출이 모두 예약을 마치고 공급자 호출 중일 때까지 응답을 붙잡는다(실제 동시 진행)
    let arrived = 0;
    let open: () => void = () => undefined;
    const gate = new Promise<void>((r) => (open = r));
    const calls: string[] = [];
    const gated = (async (u: Parameters<typeof fetch>[0]) => {
      calls.push(String(u));
      if (++arrived === 2) open();
      await gate;
      return json(200, message(big))();
    }) as typeof fetch;
    const rs = await Promise.all([runAssist(db, owner, c1.content.id, draft(p), claude(gated)), runAssist(db, owner, c2.content.id, draft(p), claude(gated))]);
    expect(calls).toHaveLength(2);
    expect(rs.every((r) => r.ledger.overBudget)).toBe(true);
    const total = rs.reduce((s, r) => s + toMicro(r.ledger.actualAmount!), 0n);
    const overages = rs.map((r) => toMicro(r.ledger.overageAmount));
    expect(overages.every((o) => o > 0n)).toBe(true);
    // 월 상한을 넘은 양 > 어느 한 호출의 초과액 — "한 호출분" 경계는 LLM_LIVE_MAX_RUNS=1 일 때만 성립
    expect(total - p.monthlyLimitMicro!).toBeGreaterThan(overages.reduce((a, b) => (a > b ? a : b)));
    // 그 뒤 요청은 월 합계(초과액 포함)가 상한을 넘으므로 거부된다
    expect(await failCode(runAssist(db, owner, c1.content.id, draft(p), claude(gated)))).toBe('budget_exceeded');
  });

  // FIX3-LIVEL1: 열·금액 범위 밖 보고값은 'none' 이 아니라 provider_unstorable 로 보존하고 새 live 예약을 막는다(의도한 동작 변경).
  it('(c) JS 안전 정수지만 integer 열 범위 밖 usage → 예약액·tokens NULL·provider_unstorable(보고값 보존), DB 오류 없음', async () => {
    const owner = await freshOwner('live-l1-fix2-int4@example.local');
    const c = await createContent(db, owner, { title: '열 범위', body: '본문.' });
    const { fetch } = fakeFetch(json(200, message({ usage: { input_tokens: 2_147_483_648, output_tokens: 10 } })));
    const r = await runAssist(db, owner, c.content.id, draft(), claude(fetch));
    expect(r.ledger).toMatchObject({ tokensIn: null, tokensOut: null, actualAmount: r.ledger.reservedAmount });
    expect(snapshotOf(r.ledger)).toMatchObject({ usage_source: 'provider_unstorable', reported_tokens_in: '2147483648', reported_tokens_out: '10' });
  });

  // FIX3-LIVEL1: 단가 설정은 0~100 으로 제한됐다 — 999999999 는 설정 단계에서 거부. 금액 범위 밖 정산 자체는 FIX3 블록(설정을 우회한 정책)에서 시험한다.
  it('(c) 금액이 numeric(18,6) 를 넘게 되는 단가는 설정에서 거부(정산 경로는 FIX3 시험)', () => {
    expect(() => policy({ LLM_PRICE_INPUT_PER_1K: '999999999' })).toThrow();
  });

  it('(d) approval_ref 가 있는 원장을 내보내고 빈 DB 에 복원해도 횟수(LLM_LIVE_MAX_RUNS)가 이어진다', async () => {
    const owner = await freshOwner('live-l1-fix2-restore@example.local');
    const c = await createContent(db, owner, { title: '복원 횟수', body: '본문.' });
    const { fetch } = fakeFetch(json(200, message()));
    await runAssist(db, owner, c.content.id, draft(policy({ LLM_LIVE_MAX_RUNS: '1' })), claude(fetch));
    expect(await liveRunsUsed(db, owner, LIVE.LLM_LIVE_APPROVAL_REF)).toBe(1);
    const tmp = mkdtempSync(path.join(tmpdir(), 'cs-livel1-fix2-'));
    try {
      const storage = new LocalStorageAdapter(path.join(tmp, 'assets'));
      const exported = await exportOwner(db, storage, owner, { outDir: path.join(tmp, 'exports') });
      const zip = new Uint8Array(readFileSync(exported.zipPath));
      const h = await createTestDb();
      try {
        const target = (await ensureOwner(h.db, 'restore-livel1-fix2@example.local')).id;
        const restoresDir = path.join(tmp, 'restores');
        const pv = await createRestorePreview(h.db, target, zip, { restoresDir, source: 'upload' });
        await commitRestore(h.db, new LocalStorageAdapter(path.join(tmp, 'assets-b')), target, pv.restoreId, { mode: 'empty_only', confirm: true, restoresDir });
        expect(await liveRunsUsed(h.db, target, LIVE.LLM_LIVE_APPROVAL_REF)).toBe(1);
      } finally {
        await h.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---- FIX round 3(Codex review-FIX2-LIVEL1) ----

const OVER_INT = { input_tokens: 2_147_483_648, output_tokens: 7 };
const snap = (l: { pricingSnapshot: Record<string, unknown> }) => l.pricingSnapshot as Record<string, unknown>;

describe('FIX3 P1 :310·:372 — 문단 claim 이 확인될 때까지 게이트가 막는다', () => {
  it('인용문을 품은 1인칭 문단 → 문단 전체 claim → 확인 전 ready 409, 확인 뒤 ready', async () => {
    const owner = await freshOwner('live-l1-fix3-gate@example.local');
    const c = await createContent(db, owner, { title: '문단 claim', body: '본문.' });
    const out = { ...modelOut, proposed_text: '저는 “좋습니다.”라고 답하고 계약을 따냈습니다.', claims: [] };
    const { fetch } = fakeFetch(json(200, message({}, JSON.stringify(out))));
    const r = await runAssist(db, owner, c.content.id, draft(), claude(fetch));
    expect(r.claims.map((x) => [x.text, x.kind, x.needs_user_confirmation])).toEqual([['저는 “좋습니다.”라고 답하고 계약을 따냈습니다.', 'experience', true]]);
    await adoptProposal(db, owner, c.content.id, r.run.id, 1);
    const rev = async () => (await db.select().from(schema.contents).where(eq(schema.contents.id, c.content.id)))[0]!.revision;
    await updateContentMeta(db, owner, c.content.id, { lifecycle: 'review' }, await rev());
    const blocked = await updateContentMeta(db, owner, c.content.id, { lifecycle: 'ready' }, await rev()).then(
      () => null,
      (x: AppError) => x,
    );
    expect(blocked?.code).toBe('unconfirmed_experience_claims');
    await confirmClaims(db, owner, c.content.id, r.run.id, [0]);
    const ready = await updateContentMeta(db, owner, c.content.id, { lifecycle: 'ready' }, await rev());
    expect(ready.lifecycle).toBe('ready');
  });
});

describe('FIX3 P1 db/budget.ts:255 — 저장 범위 밖 보고 usage: 보존(provider_unstorable) + 새 live 예약 차단', () => {
  const expectUnstorable = (l: { pricingSnapshot: Record<string, unknown>; tokensIn: number | null; actualAmount: string | null; reservedAmount: string }, tokensIn: string, tokensOut: string) => {
    expect(l.tokensIn).toBeNull();
    expect(l.actualAmount).toBe(l.reservedAmount);
    expect(snap(l)).toMatchObject({ usage_source: 'provider_unstorable', reported_tokens_in: tokensIn, reported_tokens_out: tokensOut });
    expect(snap(l).reported_cost).toMatch(/^\d+\.\d{6}$/);
  };

  it('assist 성공 + 2^31 tokens → 보고값·계산 비용을 문자열로 보존, 예약액 확정, 다음 live 예약은 429 live_usage_unresolved(호출 0·행 0)', async () => {
    const owner = await freshOwner('live-l1-fix3-unst-ok@example.local');
    const c = await createContent(db, owner, { title: '범위 밖 성공', body: '본문.' });
    const { fetch, calls } = fakeFetch(json(200, message({ usage: OVER_INT })), json(200, message()));
    const p = policy();
    const r = await runAssist(db, owner, c.content.id, draft(p), claude(fetch));
    expect(r.run.status).toBe('succeeded');
    expectUnstorable(r.ledger, '2147483648', '7');
    expect(snap(r.ledger).reported_cost).toBe(fromMicro(costMicro(p.pricing, 2_147_483_648, 7)));
    const before = await counts();
    const e = await runAssist(db, owner, c.content.id, draft(p), claude(fetch)).then(
      () => null,
      (x: AppError) => x,
    );
    expect([e?.kind, e?.code]).toEqual(['budget_exceeded', 'live_usage_unresolved']);
    expect(calls).toHaveLength(1);
    expect(await counts()).toEqual(before);
    // 모의 예약은 막지 않는다(실제 과금 경로가 아님)
    const mock = await runAssist(db, owner, c.content.id, { ...draft(), budget: undefined }, new MockLlmProvider());
    expect(mock.run.status).toBe('succeeded');
  });

  it('assist 실패(refusal) + 2^31 tokens → provider_unstorable·failed, 유한 월 상한에서 두 번째 live 예약도 거부', async () => {
    const owner = await freshOwner('live-l1-fix3-unst-fail@example.local');
    const c = await createContent(db, owner, { title: '범위 밖 실패', body: '본문.' });
    const { fetch, calls } = fakeFetch(json(200, message({ stop_reason: 'refusal', usage: OVER_INT })), json(200, message()));
    const p = policy({ LLM_BUDGET_MONTHLY_LIMIT: '10' });
    expect(await failCode(runAssist(db, owner, c.content.id, draft(p), claude(fetch)))).toBe('llm_failed');
    const { ledger } = await ledgerOf(c.content.id);
    expect(ledger.failed).toBe(true);
    expectUnstorable(ledger, '2147483648', '7');
    expect(await failCode(runAssist(db, owner, c.content.id, draft(p), claude(fetch)))).toBe('live_usage_unresolved');
    expect(calls).toHaveLength(1);
  });

  it('채널 초안(variant) 성공 + 2^31 tokens → provider_unstorable, 이후 variant·assist live 예약 모두 거부', async () => {
    const owner = await freshOwner('live-l1-fix3-unst-variant@example.local');
    const c = await createContent(db, owner, { title: '범위 밖 채널', body: '본문.' });
    const plain = { ...modelOut, claims: [{ text: '사전 조사가 중요하다.', kind: 'opinion', source_refs: [], needs_user_confirmation: false }] };
    const { fetch, calls } = fakeFetch(json(200, message({ usage: OVER_INT }, JSON.stringify(plain))), json(200, message()));
    const p = policy();
    const r = await runVariantAssist(db, owner, c.content.id, { channel: 'blog', baseVersion: 1, budget: p }, claude(fetch));
    expectUnstorable(r.ledger, '2147483648', '7');
    expect(await failCode(runVariantAssist(db, owner, c.content.id, { channel: 'threads', baseVersion: 1, budget: p }, claude(fetch)))).toBe('live_usage_unresolved');
    expect(await failCode(runAssist(db, owner, c.content.id, draft(p), claude(fetch)))).toBe('live_usage_unresolved');
    expect(calls).toHaveLength(1);
  });

  it('금액이 numeric(18,6) 밖(설정 범위를 우회한 정책) → provider_unstorable 로 보고 비용 보존, 차단', async () => {
    const owner = await freshOwner('live-l1-fix3-unst-amount@example.local');
    const c = await createContent(db, owner, { title: '금액 밖', body: '본문.' });
    const base = policy();
    const huge = { ...base, pricing: { ...base.pricing!, inputPer1kMicro: toMicro('999999999') }, monthlyLimitMicro: null, perRunMaxMicro: null };
    const { fetch } = fakeFetch(json(200, message({ usage: { input_tokens: 2_000_000_000, output_tokens: 1 } })));
    const r = await runAssist(db, owner, c.content.id, draft(huge), claude(fetch));
    expectUnstorable(r.ledger, '2000000000', '1');
    expect(snap(r.ledger).reported_cost).toBe(fromMicro(costMicro(huge.pricing, 2_000_000_000, 1)));
    expect(await failCode(runAssist(db, owner, c.content.id, draft(huge), claude(fetch)))).toBe('live_usage_unresolved');
  });
});

describe('FIX3 놓친 (b) — export→restore 와 usage_source', () => {
  it('provider_unstorable 행은 복원 뒤에도 live 예약을 막고, 키 없는 이전 행은 키 없이 남는다', async () => {
    const owner = await freshOwner('live-l1-fix3-restore@example.local');
    const c1 = await createContent(db, owner, { title: '복원 1', body: '본문 1.' });
    const c2 = await createContent(db, owner, { title: '복원 2', body: '본문 2.' });
    const { fetch } = fakeFetch(json(200, message()), json(200, message({ usage: OVER_INT })));
    const legacy = await runAssist(db, owner, c1.content.id, draft(), claude(fetch));
    // 이전(LIVE-L1 전) 행 흉내: usage_source 키 없음
    await db.execute(sql`update usage_ledger set pricing_snapshot = pricing_snapshot - 'usage_source' where id = ${legacy.ledger.id}::uuid`);
    await runAssist(db, owner, c2.content.id, draft(), claude(fetch));
    const tmp = mkdtempSync(path.join(tmpdir(), 'cs-livel1-fix3-'));
    try {
      const exported = await exportOwner(db, new LocalStorageAdapter(path.join(tmp, 'assets')), owner, { outDir: path.join(tmp, 'exports') });
      const zip = new Uint8Array(readFileSync(exported.zipPath));
      const h = await createTestDb();
      try {
        const target = (await ensureOwner(h.db, 'restore-livel1-fix3@example.local')).id;
        const restoresDir = path.join(tmp, 'restores');
        const pv = await createRestorePreview(h.db, target, zip, { restoresDir, source: 'upload' });
        await commitRestore(h.db, new LocalStorageAdapter(path.join(tmp, 'assets-b')), target, pv.restoreId, { mode: 'empty_only', confirm: true, restoresDir });
        const rows = await h.db.select().from(schema.usageLedger).where(eq(schema.usageLedger.ownerId, target));
        const byRun = new Map(rows.map((x) => [x.id, x.pricingSnapshot as Record<string, unknown>]));
        expect(byRun.get(legacy.ledger.id)).not.toHaveProperty('usage_source');
        expect([...byRun.values()].map((s) => s.usage_source ?? '(없음)').sort()).toEqual(['(없음)', 'provider_unstorable']);
        // 복원된 원고로 live 예약 → 차단
        const restoredContent = (await h.db.select().from(schema.contents).where(eq(schema.contents.ownerId, target)))[0]!;
        const again = fakeFetch(json(200, message()));
        const e = await runAssist(h.db, target, restoredContent.id, draft(), claude(again.fetch)).then(
          () => null,
          (x: AppError) => x,
        );
        expect(e?.code).toBe('live_usage_unresolved');
        expect(again.calls).toHaveLength(0);
      } finally {
        await h.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---- FIX round 4(Codex review-FIX3-LIVEL1) ----

describe('FIX4 놓친 (d) — 문단 claim 을 확인한 뒤 본문을 고치면(현재 동작 고정)', () => {
  it('confirmed 는 본문 변경과 무관하게 해결 상태 — 확인 뒤 사용자가 다른 경험 문장을 직접 써 넣어도 게이트는 다시 막지 않는다', async () => {
    const owner = await freshOwner('live-l1-fix4-edit@example.local');
    const c = await createContent(db, owner, { title: '확인 뒤 수정', body: '본문.' });
    const para = '저는 두바이에서 계약을 따냈습니다.';
    const { fetch } = fakeFetch(json(200, message({}, JSON.stringify({ ...modelOut, proposed_text: para, claims: [] }))));
    const r = await runAssist(db, owner, c.content.id, draft(), claude(fetch));
    await adoptProposal(db, owner, c.content.id, r.run.id, 1);
    await confirmClaims(db, owner, c.content.id, r.run.id, [0]);
    expect(await listUnconfirmedExperienceClaims(db, owner, c.content.id)).toEqual([]);
    // 사용자가 문단 일부를 바꾸고 새 1인칭 경험을 직접 덧붙인다(AI run 이 아님 — claim 이 새로 생기지 않는다)
    const cur = (await db.select().from(schema.contents).where(eq(schema.contents.id, c.content.id)))[0]!;
    const curVersion = (await db.select().from(schema.contentVersions).where(eq(schema.contentVersions.id, cur.currentVersionId!)))[0]!;
    await appendContentVersion(db, owner, c.content.id, { baseVersion: curVersion.version, body: '저는 두바이에서 계약을 놓쳤습니다.\n\n제가 직접 팀을 꾸렸습니다.' });
    expect(await listUnconfirmedExperienceClaims(db, owner, c.content.id)).toEqual([]);
    const rev = async () => (await db.select().from(schema.contents).where(eq(schema.contents.id, c.content.id)))[0]!.revision;
    await updateContentMeta(db, owner, c.content.id, { lifecycle: 'review' }, await rev());
    const ready = await updateContentMeta(db, owner, c.content.id, { lifecycle: 'ready' }, await rev());
    expect(ready.lifecycle).toBe('ready');
    // claims 행은 AI 제안 버전·run 에 묶여 있고(추가 전용) 사용자 버전으로 옮겨지지 않는다
    const rows = await db.select().from(schema.claims).where(eq(schema.claims.runId, r.run.id));
    expect(rows.map((x) => x.statement)).toEqual([para]);
  });
});

describe('FIX4 P2 bundle.ts:1315 — provider_unstorable 보고값 문자열은 export→restore 에서 그대로', () => {
  it('MAX_SAFE_INTEGER 보고값과 그 너머(직접 쓴 문자열)가 복원 뒤에도 같은 문자열', async () => {
    const owner = await freshOwner('live-l1-fix4-maxsafe@example.local');
    const c = await createContent(db, owner, { title: '경계', body: '본문.' });
    const { fetch } = fakeFetch(json(200, message({ usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 } })));
    const r = await runAssist(db, owner, c.content.id, draft(), claude(fetch));
    const s = r.ledger.pricingSnapshot as Record<string, string>;
    expect(s.reported_tokens_in).toBe('9007199254740991');
    expect(s.reported_cost).toBe(fromMicro(costMicro(policy().pricing, Number.MAX_SAFE_INTEGER, 1)));
    // 안전 정수 너머(다른 경로에서 온 문자열) — 정밀도 손실 없이 보존돼야 한다
    await db.execute(sql`update usage_ledger set pricing_snapshot = jsonb_set(pricing_snapshot, '{reported_tokens_out}', '"9007199254740993"') where id = ${r.ledger.id}::uuid`);
    const tmp = mkdtempSync(path.join(tmpdir(), 'cs-livel1-fix4-'));
    try {
      const exported = await exportOwner(db, new LocalStorageAdapter(path.join(tmp, 'assets')), owner, { outDir: path.join(tmp, 'exports') });
      const zip = new Uint8Array(readFileSync(exported.zipPath));
      const h = await createTestDb();
      try {
        const target = (await ensureOwner(h.db, 'restore-livel1-fix4@example.local')).id;
        const restoresDir = path.join(tmp, 'restores');
        const pv = await createRestorePreview(h.db, target, zip, { restoresDir, source: 'upload' });
        await commitRestore(h.db, new LocalStorageAdapter(path.join(tmp, 'assets-b')), target, pv.restoreId, { mode: 'empty_only', confirm: true, restoresDir });
        const [row] = await h.db.select().from(schema.usageLedger).where(eq(schema.usageLedger.id, r.ledger.id));
        expect(row!.pricingSnapshot).toMatchObject({
          usage_source: 'provider_unstorable',
          reported_tokens_in: '9007199254740991',
          reported_tokens_out: '9007199254740993',
          reported_cost: s.reported_cost,
        });
        expect(await hasUnresolvedLiveUsage(h.db, target)).toBe(true);
      } finally {
        await h.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---- LIVEL1-H1(review-FIX4-LIVEL1 놓친 케이스) ----

describe('LIVEL1-H1 — 실제 복원 경로·수동 해결 왕복', () => {
  /** owner 에 provider_unstorable 행 1개를 만들고 내보낸 묶음(zip)을 돌려준다 */
  async function unstorableBundle(identity: string, tmp: string) {
    const owner = await freshOwner(identity);
    const c = await createContent(db, owner, { title: 'H1', body: '본문.' });
    const { fetch } = fakeFetch(json(200, message({ usage: OVER_INT })));
    const r = await runAssist(db, owner, c.content.id, draft(), claude(fetch));
    const exported = await exportOwner(db, new LocalStorageAdapter(path.join(tmp, `assets-${owner}`)), owner, { outDir: path.join(tmp, 'exports') });
    return { owner, ledgerId: r.ledger.id, zip: new Uint8Array(readFileSync(exported.zipPath)) };
  }

  it('보고값이 손상된 provider_unstorable 행을 담은 묶음 → 실제 복원 경로에서 integrity 거부, 대상 DB 변화 없음', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cs-livel1-h1a-'));
    try {
      const { ledgerId, zip } = await unstorableBundle('live-l1-h1-corrupt@example.local', tmp);
      const parsed = await parseBundleZip(zip);
      const h = await createTestDb();
      try {
        const target = (await ensureOwner(h.db, 'restore-livel1-h1a@example.local')).id;
        const restoresDir = path.join(tmp, 'restores');
        const countAll = async () =>
          Object.fromEntries(
            await Promise.all(
              (['usageLedger', 'generationRuns', 'contents', 'contentVersions', 'claims'] as const).map(async (k) => [k, (await h.db.select({ n: count() }).from(schema[k]))[0]!.n] as const),
            ),
          );
        const before = await countAll();
        for (const [label, mutate] of [
          ['reported_cost 없음', (s: Record<string, unknown>) => void delete s.reported_cost],
          ['reported_tokens_in 음수', (s: Record<string, unknown>) => void (s.reported_tokens_in = '-1')],
          ['reported_* 만 남고 usage_source 없음', (s: Record<string, unknown>) => void delete s.usage_source],
        ] as const) {
          const t = structuredClone(parsed.tables) as BundleTables;
          const row = t.usage_ledger.find((l) => l.id === ledgerId)!;
          mutate(row.pricing_snapshot as Record<string, unknown>);
          const bundle = buildBundle({
            exportId: randomUUID(),
            exportedAt: new Date().toISOString(),
            appVersion: parsed.manifest.app_version,
            migrations: parsed.manifest.schema_migrations,
            owner: { id: parsed.manifest.owner.id, identityMasked: parsed.manifest.owner.identity_masked },
            tables: t,
            assetBytes: new Map(parsed.assetBytes),
          });
          const e = await createRestorePreview(h.db, target, writeZip(bundle.entries), { restoresDir, source: 'upload' }).then(
            () => null,
            (x: AppError) => x,
          );
          expect(e?.code, label).toBe('integrity');
        }
        expect(await countAll()).toEqual(before);
        expect(await hasUnresolvedLiveUsage(h.db, target)).toBe(false);
      } finally {
        await h.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('수동 해결 절차(reported_* → resolution.original_reported, 재정산, usage_source 변경) → 차단 해제, 월 예산에 재정산액 반영, export→restore 성공·original_reported 보존', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cs-livel1-h1b-'));
    try {
      const { owner, ledgerId } = await unstorableBundle('live-l1-h1-resolve@example.local', tmp);
      expect(await hasUnresolvedLiveUsage(db, owner)).toBe(true);
      const [row] = await db.select().from(schema.usageLedger).where(eq(schema.usageLedger.id, ledgerId));
      const s = row!.pricingSnapshot as Record<string, unknown>;
      const original = { reported_tokens_in: s.reported_tokens_in, reported_tokens_out: s.reported_tokens_out, reported_cost: s.reported_cost };
      // 인계의 수동 해결 절차 4~6: 보고값은 resolution 안에 보존, 재정산(월 상한 10 에 거의 닿는 9.95), 출처를 provider 로
      const { reported_tokens_in: _a, reported_tokens_out: _b, reported_cost: _c, ...rest } = s;
      void _a;
      void _b;
      void _c;
      const resolved = {
        ...rest,
        usage_source: 'provider',
        resolution: {
          resolved_at: '2026-10-10T12:00:00.000Z',
          resolved_by: 'operator',
          reason: '시험: 콘솔 확인 결과 실제 청구 9.95 USD 로 판단',
          settled_amount: '9.950000',
          original_usage_source: 'provider_unstorable',
          original_reported: original,
        },
      };
      const reserved = toMicro(row!.reservedAmount);
      const settled = toMicro('9.950000');
      await db
        .update(schema.usageLedger)
        .set({ pricingSnapshot: resolved, actualAmount: '9.950000', overageAmount: fromMicro(settled > reserved ? settled - reserved : 0n), overBudget: settled > reserved })
        .where(eq(schema.usageLedger.id, ledgerId));
      expect(await hasUnresolvedLiveUsage(db, owner)).toBe(false);
      // 월 예산 검사는 재정산액을 포함한다: 월 상한 10 에서 다음 예약(약 0.1)은 거부
      const c2 = await createContent(db, owner, { title: 'H1 다음', body: '본문.' });
      const { fetch, calls } = fakeFetch(json(200, message()));
      const e = await runAssist(db, owner, c2.content.id, draft(policy({ LLM_BUDGET_MONTHLY_LIMIT: '10' })), claude(fetch)).then(
        () => null,
        (x: AppError) => x,
      );
      expect([e?.code, (e?.extra as { reason?: string } | undefined)?.reason]).toEqual(['budget_exceeded', 'monthly_limit']);
      expect(calls).toHaveLength(0);
      // 상한을 올리면 차단 없이 호출된다(live_usage_unresolved 아님)
      const ok = await runAssist(db, owner, c2.content.id, draft(policy({ LLM_BUDGET_MONTHLY_LIMIT: '100' })), claude(fetch));
      expect(ok.run.status).toBe('succeeded');
      // export → 빈 DB 복원: 무결성 통과, original_reported 그대로, 차단 없음
      const exported = await exportOwner(db, new LocalStorageAdapter(path.join(tmp, 'assets-r')), owner, { outDir: path.join(tmp, 'exports-r') });
      const h = await createTestDb();
      try {
        const target = (await ensureOwner(h.db, 'restore-livel1-h1b@example.local')).id;
        const restoresDir = path.join(tmp, 'restores-r');
        const pv = await createRestorePreview(h.db, target, new Uint8Array(readFileSync(exported.zipPath)), { restoresDir, source: 'upload' });
        await commitRestore(h.db, new LocalStorageAdapter(path.join(tmp, 'assets-r2')), target, pv.restoreId, { mode: 'empty_only', confirm: true, restoresDir });
        const [back] = await h.db.select().from(schema.usageLedger).where(eq(schema.usageLedger.id, ledgerId));
        expect(back!.actualAmount).toBe('9.950000');
        expect((back!.pricingSnapshot as { resolution: { original_reported: unknown } }).resolution.original_reported).toEqual(original);
        expect(back!.pricingSnapshot).not.toHaveProperty('reported_cost');
        expect(await hasUnresolvedLiveUsage(h.db, target)).toBe(false);
      } finally {
        await h.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
