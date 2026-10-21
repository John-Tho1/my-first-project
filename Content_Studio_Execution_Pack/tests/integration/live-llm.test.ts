/**
 * LIVE-L1(D34 1단계): 실제 Claude 어댑터(ClaudeLlmProvider)를 db 층·route 로 끝까지 — 가짜 fetch 가 기록된 Messages API 응답을 돌려준다.
 * 네트워크 0(setupFiles 가드가 api.anthropic.com 을 막는다), 과금 0. 시험 키는 가짜 sentinel 이며 응답·DB·감사에 나오지 않아야 한다.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, count, eq, sql } from 'drizzle-orm';
import {
  adoptProposal,
  appendContentVersion,
  checkBundleZip,
  closeDb,
  commitRestore,
  confirmClaims,
  createContent,
  createRestorePreview,
  createTestDb,
  ensureOwner,
  exportOwner,
  getDb,
  getRestoreRun,
  insertAsset,
  parseBundleZip,
  hasUnresolvedLiveUsage,
  listUnconfirmedExperienceClaims,
  liveRunsUsed,
  monthlyUsage,
  openDb,
  ownerScope,
  restoreZipPath,
  runAssist,
  runLedgerResolveCli,
  runVariantAssist,
  schema,
  seed,
  selectBundleRows,
  updateContentMeta,
  usageLedgerView,
  type BlobStore,
  type Db,
} from '@cs/db';
import {
  AppError,
  budgetPolicy,
  buildAssetKey,
  buildBundle,
  costMicro,
  fromMicro,
  LIVE_LLM_FIXED_INPUT_BYTES,
  LIVE_LLM_FRAMING_OVERHEAD_TOKENS,
  loadConfig,
  mskMonthStart,
  RESTORED_TABLES,
  reserveFor,
  sha256Hex,
  toMicro,
  utf8ByteLength,
  writeZip,
  type BundleTables,
  type ParsedBundle,
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

// ---- LIVEL1-H2(LIVEL1-H1 뒤 낮은 우선순위 보강) ----

/** owner 에 provider_unstorable 원장 1개(2^31 tokens)를 만든다(공용 DB). */
async function unstorableRun(identity: string) {
  const owner = await freshOwner(identity);
  const c = await createContent(db, owner, { title: 'H2', body: '본문.' });
  const { fetch } = fakeFetch(json(200, message({ usage: OVER_INT })));
  const r = await runAssist(db, owner, c.content.id, draft(), claude(fetch));
  return { owner, contentId: c.content.id, ledgerId: r.ledger.id };
}

/** 인계 LIVEL1 수동 해결 절차 4~6 을 공용 DB 의 원장 행에 적용(H1 시험과 같은 모양): reported_* → resolution.original_reported, 재정산, 출처 provider. */
async function resolveUnstorable(ledgerId: string, settledAmount = '9.950000') {
  const [row] = await db.select().from(schema.usageLedger).where(eq(schema.usageLedger.id, ledgerId));
  const { reported_tokens_in, reported_tokens_out, reported_cost, ...rest } = row!.pricingSnapshot as Record<string, unknown>;
  const original = { reported_tokens_in, reported_tokens_out, reported_cost };
  const resolved = {
    ...rest,
    usage_source: 'provider',
    resolution: {
      resolved_at: '2026-10-10T12:00:00.000Z',
      resolved_by: 'operator',
      reason: `시험: 콘솔 확인 결과 실제 청구 ${settledAmount} USD 로 판단`,
      settled_amount: settledAmount,
      original_usage_source: 'provider_unstorable',
      original_reported: original,
    },
  };
  const reserved = toMicro(row!.reservedAmount);
  const settled = toMicro(settledAmount);
  await db
    .update(schema.usageLedger)
    .set({ pricingSnapshot: resolved, actualAmount: settledAmount, overageAmount: fromMicro(settled > reserved ? settled - reserved : 0n), overBudget: settled > reserved })
    .where(eq(schema.usageLedger.id, ledgerId));
  return { original };
}

async function exportZip(owner: string, tmp: string, tag: string) {
  const exported = await exportOwner(db, new LocalStorageAdapter(path.join(tmp, `assets-${tag}`)), owner, { outDir: path.join(tmp, `exports-${tag}`) });
  return new Uint8Array(readFileSync(exported.zipPath));
}

/** H1 시험과 같은 구성: 검증된 묶음의 표를 고친 뒤 buildBundle(manifest 해시 다시 계산) → zip. */
function rebuiltZip(parsed: ParsedBundle, mutate: (t: BundleTables) => void) {
  const t = structuredClone(parsed.tables) as BundleTables;
  mutate(t);
  const bundle = buildBundle({
    exportId: randomUUID(),
    exportedAt: new Date().toISOString(),
    appVersion: parsed.manifest.app_version,
    migrations: parsed.manifest.schema_migrations,
    owner: { id: parsed.manifest.owner.id, identityMasked: parsed.manifest.owner.identity_masked },
    tables: t,
    assetBytes: new Map(parsed.assetBytes),
  });
  return writeZip(bundle.entries);
}

const rowCountsOf = async (dbX: Db) =>
  Object.fromEntries(
    await Promise.all(
      (['usageLedger', 'generationRuns', 'contents', 'contentVersions', 'claims'] as const).map(async (k) => [k, (await dbX.select({ n: count() }).from(schema[k]))[0]!.n] as const),
    ),
  );
const errOf = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (x: unknown) => x as AppError,
  );

describe('LIVEL1-H2 — 수동 해결 resolution 형식: 실제 복원 경로', () => {
  type ResolvedSnap = { usage_source: unknown; resolution: { settled_amount: string; original_reported: { reported_cost: string } } };

  it('해결한 행의 resolution 을 고친 묶음(재정산액 ≠ 확정액·original_reported 비용 형식·출처 estimate) → 복원 미리보기 integrity, 대상 DB 변화 없음 — 고치지 않은 같은 묶음은 통과', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cs-livel1-h2-res-'));
    try {
      const { owner, ledgerId } = await unstorableRun('live-l1-h2-res@example.local');
      await resolveUnstorable(ledgerId);
      expect(await hasUnresolvedLiveUsage(db, owner)).toBe(false);
      const parsed = await parseBundleZip(await exportZip(owner, tmp, 'src'));
      const h = await createTestDb();
      try {
        const target = (await ensureOwner(h.db, 'restore-livel1-h2-res@example.local')).id;
        const restoresDir = path.join(tmp, 'restores');
        const before = await rowCountsOf(h.db);
        const snapOf = (t: BundleTables) => t.usage_ledger.find((l) => l.id === ledgerId)!.pricing_snapshot as unknown as ResolvedSnap;
        const cases: Array<[string, (t: BundleTables) => void]> = [
          ['settled_amount 9.940000 < actual_amount 9.950000', (t) => void (snapOf(t).resolution.settled_amount = '9.940000')],
          ['original_reported.reported_cost = 1.5', (t) => void (snapOf(t).resolution.original_reported.reported_cost = '1.5')],
          ['usage_source 를 estimate 로(resolution 은 그대로)', (t) => void (snapOf(t).usage_source = 'estimate')],
        ];
        for (const [label, mutate] of cases) {
          const e = await errOf(createRestorePreview(h.db, target, rebuiltZip(parsed, mutate), { restoresDir, source: 'upload' }));
          expect(e?.code, label).toBe('integrity');
          expect((e?.extra as { problems?: string[] } | undefined)?.problems, label).toEqual(['usage_ledger.pricing_snapshot.resolution 형식']);
        }
        expect(await rowCountsOf(h.db)).toEqual(before);
        expect(await hasUnresolvedLiveUsage(h.db, target)).toBe(false);
        // 대조: 손대지 않은 같은 표(다시 만든 manifest)는 미리보기를 통과 — 위 거부는 바꾼 값 때문이다
        const pv = await createRestorePreview(h.db, target, rebuiltZip(parsed, () => undefined), { restoresDir, source: 'upload' });
        expect(pv.preview.tables.usage_ledger).toMatchObject({ in_bundle: 1, new: 1 });
      } finally {
        await h.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// FIX2-LIVEL1H2(검토 #12): 운영자 절차(인계 LIVEL1 "수동 해결 절차" 4~7)가 H2 복원 무결성 규칙과 맞는지 — 4~6 을 실행하고,
// 그 뒤 내보낸 묶음이 읽기 전용 확인(`pnpm bundle:check` = checkBundleZip)과 복원 미리보기를 통과하는지, 절차가 금지한 자연스러운 실수(SQL now()
// 시각·키 추가·소수 자릿수)는 확인에서 걸리는지 본다. 확인은 DB 를 열지 않는다(함수 인자에 DB 가 없고, 스크립트는 DATABASE_URL 폴더를 만들지 않음).
// FIX4-LIVEL1H2(4차 검토): 4~6 은 문서의 손 SQL 이 아니라 운영자 CLI(`pnpm ledger:resolve` = runLedgerResolveCli)로 한다. FIX3 의 문서-SQL 시험(4~6 문의
// 잘못 채움 32종·정정 문·확인 조회)은 SQL 이 없어져 지우고, 같은 경우를 tests/integration/ledger-resolve-cli.test.ts 에서 CLI 로 같은 단언 이상으로 본다.
describe('FIX2-LIVEL1H2 — 운영자 절차(4~6 = ledger:resolve)·읽기 전용 묶음 확인(bundle:check)', () => {
  const APP = fileURLToPath(new URL('../../', import.meta.url));
  const TSX_CLI = path.join(APP, 'node_modules/tsx/dist/cli.mjs');
  const CHECK_SCRIPT = path.join(APP, 'packages/db/scripts/bundle-check.ts');
  const RESOLUTION_PROBLEM = ['usage_ledger.pricing_snapshot.resolution 형식'];
  const DOC = path.join(APP, 'docs/handoffs/LIVEL1_IMPLEMENTATION_HANDOFF.md');
  /** FIX4-LIVEL1H2: 인계 4~6 = 운영자 CLI 본체(공용 DB 를 그대로 넘기고 닫지 않음). resolved_at 은 주입한 시각. */
  const RESOLVED_NOW = new Date('2026-10-21T09:15:00.123Z');
  const resolveCli = async (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runLedgerResolveCli({
      argv,
      env: { DATABASE_URL: 'memory://' },
      openDb: async () => ({ ...(await getDb(loadConfig())), close: async () => undefined }),
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      now: () => RESOLVED_NOW,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const runCheck = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [TSX_CLI, CHECK_SCRIPT, ...args], { cwd: APP, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...env } });
  const writeCounts = async () => ({
    restoreRuns: (await db.select({ n: count() }).from(schema.restoreRuns))[0]!.n,
    audits: (await db.select({ n: count() }).from(schema.auditEvents))[0]!.n,
  });

  it('4~6(ledger:resolve --confirm) → 차단 해제·재정산, 해결 뒤 묶음은 bundle:check 통과(exit 0)·복원 미리보기 통과 — 상한(5단계) 경우도. 절차가 금지한 실수는 bundle:check 가 integrity(exit 1)로 잡고, 확인은 DB·파일에 쓰지 않는다', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cs-fix2-h2-proc-'));
    try {
      const cases = [
        { who: 'fix2-h2-proc@example.local', settled: '9.950000', actual: '9.950000' }, // 원칙: settled = actual
        { who: 'fix2-h2-cap@example.local', settled: '25.000000', actual: '10.000000' }, // 5단계 상한(월 한도 10 으로 깎음, 실제 청구 25)
      ];
      const zips: string[] = [];
      for (const c of cases) {
        const { owner, ledgerId } = await unstorableRun(c.who);
        expect(await hasUnresolvedLiveUsage(db, owner)).toBe(true);
        const [before] = await db.select().from(schema.usageLedger).where(eq(schema.usageLedger.id, ledgerId));
        const { reported_tokens_in, reported_tokens_out, reported_cost } = before!.pricingSnapshot as Record<string, unknown>;
        const reason = "시험: 운영자'의 콘솔 확인 — 실제 청구 " + c.settled + ' USD';
        const done = await resolveCli(['--owner', owner, '--ledger', ledgerId, '--source', 'provider', '--actual', c.actual, '--settled', c.settled, '--by', 'operator', `--reason=${reason}`, '--confirm']);
        expect(done.code, done.err).toBe(0);
        expect(done.out.split('\n')).toContain('updated 1');
        const [row] = await db.select().from(schema.usageLedger).where(eq(schema.usageLedger.id, ledgerId));
        const snap = row!.pricingSnapshot as Record<string, unknown> & { resolution: Record<string, unknown> };
        expect(snap.usage_source).toBe('provider');
        expect(Object.keys(snap).filter((k) => k.startsWith('reported_'))).toEqual([]);
        expect(Object.keys(snap.resolution).sort()).toEqual(['original_reported', 'original_usage_source', 'reason', 'resolved_at', 'resolved_by', 'settled_amount']);
        expect(snap.resolution.resolved_at).toBe(RESOLVED_NOW.toISOString()); // FIX4: 문서 SQL 의 마이크로초 형식 대신 CLI 의 실행 시각(정확히 같은 값 — TS_RE 형식)
        expect(snap.resolution.resolved_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(snap.resolution.reason).toContain("운영자'의"); // 따옴표 그대로(셸·SQL 처리 없음)
        expect(snap.resolution.reason).toBe(reason);
        expect(snap.resolution.original_reported).toEqual({ reported_tokens_in, reported_tokens_out, reported_cost });
        expect(row!.actualAmount).toBe(c.actual);
        expect(row!.state).toBe('settled');
        expect(row!.overBudget).toBe(toMicro(c.actual) > toMicro(row!.reservedAmount));
        expect(toMicro(row!.overageAmount)).toBe(toMicro(c.actual) - toMicro(row!.reservedAmount));
        expect(await hasUnresolvedLiveUsage(db, owner)).toBe(false);
        // 7-② 내보내기 → 7-③ 읽기 전용 확인
        const zip = await exportZip(owner, tmp, c.who.split('@')[0]!);
        const w0 = await writeCounts();
        const ok = await checkBundleZip(zip);
        expect(ok).toMatchObject({ ok: true });
        expect(ok.ok && ok.rows.usage_ledger).toBe(1);
        expect(ok.ok && ok.unresolved_live_usage).toBe(0); // FIX3-LIVEL1H2: 해결한 행은 더 세지 않는다
        expect(await writeCounts()).toEqual(w0);
        const zipFile = path.join(tmp, `${c.who.split('@')[0]}.zip`);
        writeFileSync(zipFile, zip);
        zips.push(zipFile);
        // 7-④ 실제 복원 경로(버릴 DB)도 통과
        const h = await createTestDb();
        try {
          const target = (await ensureOwner(h.db, `restore-${c.who}`)).id;
          const pv = await createRestorePreview(h.db, target, zip, { restoresDir: path.join(tmp, 'restores'), source: 'upload' });
          expect(pv.preview.tables.usage_ledger).toMatchObject({ in_bundle: 1, new: 1 });
        } finally {
          await h.close();
        }
      }

      // 절차가 금지한 자연스러운 실수 — 앱은 정상으로 돌지만 묶음은 복원 거부(이제 7-③ 이 미리 잡는다)
      const parsed = await parseBundleZip(new Uint8Array(readFileSync(zips[0]!)));
      const ledgerId0 = parsed.tables.usage_ledger[0]!.id;
      const resOf = (t: BundleTables) => (t.usage_ledger.find((l) => l.id === ledgerId0)!.pricing_snapshot as { resolution: Record<string, unknown> }).resolution;
      const pgNow = ((await db.execute(sql`select to_jsonb(now()) #>> '{}' as j, now()::text as t`)).rows as Array<{ j: string; t: string }>)[0]!;
      expect(pgNow.j).toMatch(/\+00:00$/); // 이 실행 환경의 세션 시간대 UTC 에서
      const mistakes: Array<[string, (r: Record<string, unknown>) => void]> = [
        ['resolved_at = to_jsonb(now())(…+00:00)', (r) => void (r.resolved_at = pgNow.j)],
        ['resolved_at = now()::text(공백·+00)', (r) => void (r.resolved_at = pgNow.t)],
        ['키 추가(console_ref)', (r) => void (r.console_ref = 'console-2026-10')],
        ['settled_amount "9.95"(소수 2자리)', (r) => void (r.settled_amount = '9.95')],
        ['settled_amount 숫자 9.95', (r) => void (r.settled_amount = 9.95)],
        ['이전 4단계 예시(키 5개 — original_reported 없음)', (r) => void delete r.original_reported],
      ];
      const w1 = await writeCounts();
      for (const [label, mutate] of mistakes) {
        const bad = await checkBundleZip(rebuiltZip(parsed, (t) => mutate(resOf(t))));
        expect(bad, label).toEqual({ ok: false, error: 'integrity', message: '묶음 안의 관계(ID 참조)가 맞지 않습니다', problems: RESOLUTION_PROBLEM });
      }
      expect(await writeCounts()).toEqual(w1); // 확인은 DB 에 아무것도 쓰지 않는다
      const badFile = path.join(tmp, 'bad.zip');
      writeFileSync(badFile, rebuiltZip(parsed, (t) => mistakes[0]![1](resOf(t))));

      // 스크립트(pnpm bundle:check 와 같은 명령): 통과 exit 0(stdout JSON), 실패 exit 1(stderr JSON·값 없음), 사용법 2, 없는 파일 1 — DB 를 열지 않는다
      const noDb = path.join(tmp, 'must-not-exist-pglite');
      const before = readdirSync(tmp).sort();
      const good = runCheck([zips[0]!], { DATABASE_URL: noDb });
      expect(good.status, good.stderr).toBe(0);
      expect(JSON.parse(good.stdout.trim())).toMatchObject({ action: 'bundle.check', ok: true, manifest_sha256: parsed.manifestSha256 });
      const fail = runCheck([badFile], { DATABASE_URL: noDb });
      expect(fail.status).toBe(1);
      expect(fail.stdout.trim()).toBe('');
      const failJson = JSON.parse(fail.stderr.trim()) as Record<string, unknown>;
      expect(failJson).toMatchObject({ action: 'bundle.check', ok: false, error: 'integrity', problems: RESOLUTION_PROBLEM });
      expect(fail.stderr).not.toContain(pgNow.j); // 값은 내보내지 않는다
      expect(runCheck([], { DATABASE_URL: noDb }).status).toBe(2);
      const missing = runCheck([path.join(tmp, 'no-such.zip')], { DATABASE_URL: noDb });
      expect(missing.status).toBe(1);
      expect(JSON.parse(missing.stderr.trim())).toMatchObject({ ok: false, error: 'unreadable_file' });
      expect(readdirSync(tmp).sort()).toEqual(before); // DATABASE_URL 폴더·다른 파일을 만들지 않았다
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // FIX3-LIVEL1H2 의 문서-SQL 시험 두 개(4~6 문의 자리표시·잘못 채움 32종·state·경계·none·확인 조회·bundle:check 미해결 수 / 정정 문 5변형·고칠 수 없는 9형태)는
  // FIX4-LIVEL1H2 에서 손 SQL 이 문서에서 빠져 지웠다. 같은 경우(와 4차 검토가 더한 경우)를 tests/integration/ledger-resolve-cli.test.ts 가 CLI 로 본다.

  it('FIX3-LIVEL1H2: 7-④ — 문서 줄의 DATABASE_URL·RESTORE_LOCAL_DIR 로 실제 restore:preview 스크립트를 임시 작업 폴더에서 실행하면 새로 생긴 것은 그 두 폴더뿐(ZIP 사본은 RESTORE_LOCAL_DIR). RESTORE_LOCAL_DIR 를 빼면 기본값은 ./data/restores(정정 전 문구의 사본 위치). FIX4: 다른 위치를 가리키는 .env.local 이 있어도 앞에 붙인 값이 이긴다(그 .env.local 은 실제로 읽힘), 문서의 두 값은 실제 데이터 폴더가 아니다', async () => {
    const doc = readFileSync(DOC, 'utf8');
    const cmds = [...doc.matchAll(/`DATABASE_URL=(\S+) RESTORE_LOCAL_DIR=(\S+) corepack pnpm restore:preview <zip>`/g)];
    expect(cmds, '7-④ 명령 줄이 정확히 하나').toHaveLength(1);
    expect(doc).not.toMatch(/`DATABASE_URL=\S+ corepack pnpm restore:preview/); // RESTORE_LOCAL_DIR 없는 옛 문구는 남지 않음
    const day = (s: string) => s.split('<날짜>').join('20261021');
    const dbRel = day(cmds[0]![1]!);
    const restoresRel = day(cmds[0]![2]!);
    for (const p of [dbRel, restoresRel]) expect(p).toMatch(/^\.\/data\/[A-Za-z0-9._-]+$/);
    expect(restoresRel).not.toBe(dbRel);
    // FIX4-LIVEL1H2(4차 검토 #11): 버릴 위치여야 한다 — 설정 기본값(실제 DB·복원·내보내기·저장·가져오기 폴더)과 같거나 그 안·위가 아니고, <날짜>를 담는다
    expect(cmds[0]![1]).toContain('<날짜>');
    expect(cmds[0]![2]).toContain('<날짜>');
    const defaults = loadConfig({});
    for (const p of [dbRel, restoresRel]) {
      for (const real of [defaults.DATABASE_URL, defaults.RESTORE_LOCAL_DIR, defaults.EXPORT_LOCAL_DIR, defaults.STORAGE_LOCAL_DIR, defaults.IMPORT_LOCAL_DIR]) {
        const a = path.posix.normalize(p);
        const b = path.posix.normalize(real);
        expect(a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`), `${p} 는 실제 폴더 ${real} 와 겹치지 않는다`).toBe(false);
      }
    }
    const RESTORE_SCRIPT = path.join(APP, 'packages/db/scripts/restore.ts');
    const ws = mkdtempSync(path.join(tmpdir(), 'cs-fix3-h2-74-'));
    const tmp = mkdtempSync(path.join(tmpdir(), 'cs-fix3-h2-74x-'));
    try {
      // 임시 작업 폴더 = 워크스페이스 루트(pnpm-workspace.yaml): 스크립트의 .env.local 찾기(loadRootEnv)·migration 위치가 여기 기준이다.
      // 문서의 두 값(./data/…)은 이 폴더 아래 **절대 경로**로 넘긴다 — 루트를 찾는 방식이 바뀌어도 실제 ./data 에 쓰지 않게(기본 경로로 실행하는 대조는 하지 않는다).
      // migration 폴더만 복사한다(링크 아님 — 정리할 때 원본을 지우지 않도록).
      writeFileSync(path.join(ws, 'pnpm-workspace.yaml'), 'packages: []\n');
      cpSync(path.join(APP, 'packages/db/drizzle'), path.join(ws, 'packages/db/drizzle'), { recursive: true });
      // FIX4-LIVEL1H2(4차 검토 #9): 실제 환경처럼 .env.local 이 다른 DB·복원 폴더를 가리킨다(이 임시 폴더 안의 절대 경로 — 무엇이 이겨도 실제 ./data 가 아님).
      // 같은 파일의 AUTH_ALLOWED_IDENTITY 는 앞에 붙이지 않는다 — 복원 미리보기가 그 owner 를 만들면 이 .env.local 이 실제로 읽힌 것이다(대조).
      const envDb = path.join(ws, 'data', 'envlocal-db');
      const envRestores = path.join(ws, 'data', 'envlocal-restores');
      const envIdentity = 'envlocal-owner@example.local';
      writeFileSync(path.join(ws, '.env.local'), `DATABASE_URL=${envDb}\nRESTORE_LOCAL_DIR=${envRestores}\nAUTH_ALLOWED_IDENTITY=${envIdentity}\n`);
      const drizzleFiles = readdirSync(path.join(ws, 'packages/db/drizzle'), { recursive: true }).map(String).sort();
      const { owner, ledgerId } = await unstorableRun('fix3-h2-74@example.local');
      await resolveUnstorable(ledgerId);
      const zip = await exportZip(owner, tmp, 'x');
      writeFileSync(path.join(ws, 'bundle.zip'), zip);
      const preview = (extra: Record<string, string>) => {
        const env: Record<string, string | undefined> = { ...process.env, ...extra };
        delete env.AUTH_ALLOWED_IDENTITY; // 시험 프로세스의 값이 아니라 .env.local 의 값이 쓰이게(대조)
        const r = spawnSync(process.execPath, [TSX_CLI, RESTORE_SCRIPT, 'preview', 'bundle.zip'], { cwd: ws, encoding: 'utf8', timeout: 180_000, env });
        expect(r.status, r.stderr).toBe(0);
        const out = JSON.parse(r.stdout.trim()) as { ok: boolean; action: string; restore_id: string; preview: { tables: Record<string, unknown> } };
        expect(out).toMatchObject({ ok: true, action: 'restore.preview' });
        expect(out.preview.tables.usage_ledger).toMatchObject({ in_bundle: 1, new: 1 });
        return out.restore_id;
      };
      const top0 = readdirSync(ws).sort();
      expect(top0).toEqual(['.env.local', 'bundle.zip', 'packages', 'pnpm-workspace.yaml']);
      // 문서대로: 새로 생기는 것은 data/<DATABASE_URL 폴더>·data/<RESTORE_LOCAL_DIR 폴더> 두 개뿐, ZIP 사본은 RESTORE_LOCAL_DIR 에
      const id1 = preview({ DATABASE_URL: path.join(ws, dbRel), RESTORE_LOCAL_DIR: path.join(ws, restoresRel) });
      expect(readdirSync(ws).sort()).toEqual([...top0, 'data'].sort());
      expect(readdirSync(path.join(ws, 'data')).sort()).toEqual([path.basename(dbRel), path.basename(restoresRel)].sort());
      expect(readdirSync(path.join(ws, restoresRel))).toEqual([`${id1}.zip`]);
      expect(readFileSync(path.join(ws, restoresRel, `${id1}.zip`)).equals(Buffer.from(zip))).toBe(true);
      expect(readdirSync(path.join(ws, dbRel))).not.toContain(`${id1}.zip`); // ZIP 사본은 버릴 DB 폴더가 아니라 RESTORE_LOCAL_DIR 에 있다(정정 전 문구가 틀린 곳)
      expect(readdirSync(path.join(ws, 'packages/db/drizzle'), { recursive: true }).map(String).sort()).toEqual(drizzleFiles);
      expect(readdirSync(path.join(ws, 'packages/db'))).toEqual(['drizzle']);
      // .env.local 이 가리킨 곳에는 아무것도 생기지 않았다(앞에 붙인 값이 이김) — 그리고 그 .env.local 은 읽혔다(AUTH_ALLOWED_IDENTITY owner 가 버릴 DB 에 있음)
      expect([existsSync(envDb), existsSync(envRestores)]).toEqual([false, false]);
      const thrown = await openDb({ DB_DRIVER: 'pglite', DATABASE_URL: path.join(ws, dbRel) });
      try {
        expect((await thrown.db.select({ identity: schema.users.allowedIdentity }).from(schema.users)).map((u) => u.identity)).toEqual([envIdentity]);
      } finally {
        await thrown.close();
      }
      // 정정 전 문구(DATABASE_URL 만)면 사본이 가는 곳 = 설정 기본값 ./data/restores(.env.local 에 값이 있으면 그 값) — 버릴 DB 폴더를 지워도 남는다
      expect(loadConfig({}).RESTORE_LOCAL_DIR).toBe('./data/restores');
      expect(doc).toContain('`RESTORE_LOCAL_DIR`(`.env.local` 값, 없으면 `./data/restores`)');
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 300_000);
});

describe('LIVEL1-H2 — NFC/NFD 교차 중복 experience claim 은 한 번만 저장·확인(가짜 fetch)', () => {
  const t = '제가 협상했습니다.';
  const tNfd = t.normalize('NFD');
  const expC = (text: string, source_refs: string[] = []) => ({ text, kind: 'experience', source_refs, needs_user_confirmation: true });

  it('같은 경험 claim 을 NFC·NFD 로 두 번 → claims 행·output_json 모두 1개(claim_index 0), 한 번 확인으로 ready', async () => {
    const owner = await freshOwner('live-l1-h2-dedupe@example.local');
    const c = await createContent(db, owner, { title: '교차 중복', body: '본문.' });
    const out = { ...modelOut, proposed_text: t, claims: [expC(t), expC(tNfd)] };
    const { fetch } = fakeFetch(json(200, message({}, JSON.stringify(out))));
    const r = await runAssist(db, owner, c.content.id, draft(), claude(fetch));
    expect(r.claims.map((x) => [x.text, x.kind, x.needs_user_confirmation])).toEqual([[t, 'experience', true]]);
    const rows = await db.select().from(schema.claims).where(eq(schema.claims.runId, r.run.id));
    expect(rows.map((x) => [x.claimIndex, x.statement, x.kind])).toEqual([[0, t, 'experience']]);
    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, r.run.id));
    expect((run!.outputJson as { claims: unknown[] }).claims).toHaveLength(1);
    await adoptProposal(db, owner, c.content.id, r.run.id, 1);
    expect((await confirmClaims(db, owner, c.content.id, r.run.id, [0])).unconfirmed).toEqual([]);
    const rev = async () => (await db.select().from(schema.contents).where(eq(schema.contents.id, c.content.id)))[0]!.revision;
    await updateContentMeta(db, owner, c.content.id, { lifecycle: 'review' }, await rev());
    expect((await updateContentMeta(db, owner, c.content.id, { lifecycle: 'ready' }, await rev())).lifecycle).toBe('ready');
  });

  it('채널 초안(variant)도 같은 provider 후처리 — 중복 claim 은 1개', async () => {
    const owner = await freshOwner('live-l1-h2-dedupe-variant@example.local');
    const c = await createContent(db, owner, { title: '교차 중복 채널', body: '본문.' });
    const out = { ...modelOut, proposed_text: t, claims: [expC(tNfd), expC(t)] };
    const { fetch } = fakeFetch(json(200, message({}, JSON.stringify(out))));
    const r = await runVariantAssist(db, owner, c.content.id, { channel: 'blog', baseVersion: 1, budget: policy() }, claude(fetch));
    const rows = await db.select().from(schema.claims).where(eq(schema.claims.runId, r.run.id));
    expect(rows.map((x) => [x.claimIndex, x.statement])).toEqual([[0, tNfd]]);
  });

  it.each<[string, unknown[]]>([
    ['BOM 으로만 다른 두 경험 claim(하나는 호스트 모양)', [expC('제가 fake .example 에서 협상했습니다.'), expC('제가 fake\uFEFF.example 에서 협상했습니다.')]],
    [
      '탭으로만 다른 두 경험 claim(하나는 버린 출처 문구를 그대로 담음)',
      [
        { text: '시장 자료가 있다.', kind: 'fact', source_refs: ['fake\tsource'], needs_user_confirmation: false },
        expC('제가 fake source 에서 들었습니다.'),
        expC('제가 fake\tsource 에서 들었습니다.'),
      ],
    ],
  ])('인용 검사 우회 방지(지금 동작 고정): %s → 중복으로 지우지 않으므로 출력 전체 unverifiable_citation', async (_label, claims) => {
    const owner = await freshOwner(`live-l1-h2-cite-${randomUUID()}@example.local`);
    const c = await createContent(db, owner, { title: '인용 우회', body: '본문.' });
    const { fetch } = fakeFetch(json(200, message({}, JSON.stringify({ ...modelOut, claims }))));
    expect(await failCode(runAssist(db, owner, c.content.id, draft(), claude(fetch)))).toBe('llm_failed');
    const { run } = await ledgerOf(c.content.id);
    expect(run.error).toBe('unverifiable_citation');
    expect(await db.select().from(schema.claims).where(eq(schema.claims.runId, run.id))).toEqual([]);
  });
});

describe('LIVEL1-H2 — 복원한 원장과 대상의 이번 달(MSK) 예산', () => {
  const limitErr = (e: AppError | null) => [e?.code, (e?.extra as { reason?: string } | undefined)?.reason];
  /** 빈 대상 DB 에 empty_only 로 복원하고 대상 owner 와 복원된 첫 원고 id 를 돌려준다. */
  async function restoreInto(h: Awaited<ReturnType<typeof createTestDb>>, zip: Uint8Array, tmp: string, tag: string) {
    const target = (await ensureOwner(h.db, `restore-livel1-h2-${tag}@example.local`)).id;
    const restoresDir = path.join(tmp, `restores-${tag}`);
    const pv = await createRestorePreview(h.db, target, zip, { restoresDir, source: 'upload' });
    await commitRestore(h.db, new LocalStorageAdapter(path.join(tmp, `assets-b-${tag}`)), target, pv.restoreId, { mode: 'empty_only', confirm: true, restoresDir });
    const contentId = (await h.db.select().from(schema.contents).where(eq(schema.contents.ownerId, target)))[0]!.id;
    return { target, contentId, restoresDir };
  }
  const hCounts = async (dbX: Db) => ({
    runs: (await dbX.select({ n: count() }).from(schema.generationRuns))[0]!.n,
    ledger: (await dbX.select({ n: count() }).from(schema.usageLedger))[0]!.n,
  });

  it('A1: 수동 해결(9.95)된 원장을 빈 DB 에 복원 → 대상의 이번 달 사용액 = 원본, 월 상한 10 의 다음 live 예약은 429 monthly_limit(호출 0·run·원장 0), 상한 100 이면 호출 1', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cs-livel1-h2-a1-'));
    try {
      const { owner, ledgerId } = await unstorableRun('live-l1-h2-a1@example.local');
      await resolveUnstorable(ledgerId);
      const zip = await exportZip(owner, tmp, 'a1');
      const h = await createTestDb();
      try {
        const { target, contentId } = await restoreInto(h, zip, tmp, 'a1');
        const before = await hCounts(h.db);
        const f = fakeFetch(json(200, message()));
        const e = await errOf(runAssist(h.db, target, contentId, draft(policy({ LLM_BUDGET_MONTHLY_LIMIT: '10' })), claude(f.fetch)));
        expect(limitErr(e)).toEqual(['budget_exceeded', 'monthly_limit']);
        expect(f.calls).toHaveLength(0);
        expect(await hCounts(h.db)).toEqual(before);
        // 복원된 원장이 대상의 이번 달 합계에 그대로 들어간다(원본과 같음)
        const usedT = (await monthlyUsage(h.db, target)).byCurrency;
        expect(usedT).toEqual((await monthlyUsage(db, owner)).byCurrency);
        expect(usedT.map((u) => [u.currency, u.used])).toEqual([['USD', '9.950000']]);
        // 상한을 올리면 호출된다(차단 원인은 월 상한뿐)
        const ok = await runAssist(h.db, target, contentId, draft(policy({ LLM_BUDGET_MONTHLY_LIMIT: '100' })), claude(f.fetch));
        expect(ok.run.status).toBe('succeeded');
        expect(f.calls).toHaveLength(1);
      } finally {
        await h.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('A2: 지난달(MSK) 원장은 복원해도 이번 달 예산에 들어가지 않는다 — 대조: 같은 행을 이번 달에 둔 채 따로 내보낸 묶음은 429 monthly_limit', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cs-livel1-h2-a2-'));
    try {
      const owner = await freshOwner('live-l1-h2-a2@example.local');
      const c = await createContent(db, owner, { title: 'A2', body: '본문.' });
      const { fetch } = fakeFetch(json(200, message()), json(200, message()));
      const prev = await runAssist(db, owner, c.content.id, draft(), claude(fetch));
      const cur = await runAssist(db, owner, c.content.id, draft(), claude(fetch));
      // Lprev 를 9.95 로 재정산(초과 기록) — 아직 이번 달
      const settled = toMicro('9.950000');
      await db
        .update(schema.usageLedger)
        .set({ actualAmount: '9.950000', overageAmount: fromMicro(settled - toMicro(prev.ledger.reservedAmount)), overBudget: true })
        .where(eq(schema.usageLedger.id, prev.ledger.id));
      // 대조 묶음: 이번 달 그대로 내보낸다. 그 뒤 Lprev 를 지난달(MSK 월 시작 하루 전)로 옮겨 한 번 더 내보낸다 — 묶음 두 개
      const zipCur = await exportZip(owner, tmp, 'a2-cur');
      const now = new Date();
      const prevAt = new Date(mskMonthStart(now).getTime() - 24 * 3600_000);
      await db.update(schema.usageLedger).set({ createdAt: prevAt }).where(eq(schema.usageLedger.id, prev.ledger.id));
      const zipPrev = await exportZip(owner, tmp, 'a2-prev');
      // (월 경계를 지나는 순간 실행되면 now 와 runAssist 의 시각이 다른 달일 수 있다 — 무시할 만한 위험)
      {
        const h = await createTestDb();
        try {
          const { target, contentId } = await restoreInto(h, zipPrev, tmp, 'a2-prev');
          expect((await monthlyUsage(h.db, target, now)).byCurrency.map((u) => [u.currency, u.used])).toEqual([['USD', cur.ledger.actualAmount]]);
          const lastMonth = new Date(mskMonthStart(now).getTime() - 12 * 3600_000);
          expect((await monthlyUsage(h.db, target, lastMonth)).byCurrency.map((u) => u.used)).toEqual(['9.950000']);
          const f = fakeFetch(json(200, message()));
          const ok = await runAssist(h.db, target, contentId, draft(policy({ LLM_BUDGET_MONTHLY_LIMIT: '10' })), claude(f.fetch));
          expect(ok.run.status).toBe('succeeded');
          expect(f.calls).toHaveLength(1);
        } finally {
          await h.close();
        }
      }
      {
        const h = await createTestDb();
        try {
          const { target, contentId } = await restoreInto(h, zipCur, tmp, 'a2-cur');
          const used = fromMicro(settled + toMicro(cur.ledger.actualAmount!));
          expect((await monthlyUsage(h.db, target, now)).byCurrency.map((u) => u.used)).toEqual([used]);
          const before = await hCounts(h.db);
          const f = fakeFetch(json(200, message()));
          const e = await errOf(runAssist(h.db, target, contentId, draft(policy({ LLM_BUDGET_MONTHLY_LIMIT: '10' })), claude(f.fetch)));
          expect(limitErr(e)).toEqual(['budget_exceeded', 'monthly_limit']);
          expect(f.calls).toHaveLength(0);
          expect(await hCounts(h.db)).toEqual(before);
        } finally {
          await h.close();
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('A3(현재 동작 기록): add_missing 에서 원고가 대상에서 바뀌어 dependency 충돌로 빠진 run·원장은 대상의 이번 달 사용액에 들어가지 않는다', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cs-livel1-h2-a3-'));
    try {
      const owner = await freshOwner('live-l1-h2-a3@example.local');
      const c = await createContent(db, owner, { title: 'A3', body: '본문.' });
      const { fetch } = fakeFetch(json(200, message()), json(200, message()));
      const r1 = await runAssist(db, owner, c.content.id, draft(), claude(fetch));
      const zip1 = await exportZip(owner, tmp, 'a3-e1');
      const h = await createTestDb();
      try {
        const { target, restoresDir } = await restoreInto(h, zip1, tmp, 'a3');
        // 대상에서 같은 원고를 고친다 → contents 행이 묶음과 달라진다(different)
        await appendContentVersion(h.db, target, c.content.id, { baseVersion: 1, body: '대상에서 고침' });
        const r2 = await runAssist(db, owner, c.content.id, draft(), claude(fetch));
        const zip2 = await exportZip(owner, tmp, 'a3-e2');
        const pv = await createRestorePreview(h.db, target, zip2, { restoresDir, source: 'upload' });
        const dropped = [
          { table: 'generation_runs', id: r2.run.id, reason: 'dependency' },
          { table: 'usage_ledger', id: r2.ledger.id, reason: 'dependency' },
        ];
        expect(pv.preview.conflicts).toEqual(expect.arrayContaining([{ table: 'contents', id: c.content.id, reason: 'different' }, ...dropped]));
        const res = await commitRestore(h.db, new LocalStorageAdapter(path.join(tmp, 'assets-b-a3')), target, pv.restoreId, { mode: 'add_missing', confirm: true, restoresDir });
        expect(res.conflicts).toEqual(expect.arrayContaining(dropped));
        const ids = (await h.db.select({ id: schema.usageLedger.id }).from(schema.usageLedger).where(eq(schema.usageLedger.ownerId, target))).map((x) => x.id);
        expect(ids).toEqual([r1.ledger.id]);
        // 대상의 이번 달 사용액에는 L1 만 — 원본은 L1 + L2. (미리보기에 금액 경고는 없다: 남은 위험으로 기록)
        expect((await monthlyUsage(h.db, target)).byCurrency.map((u) => u.used)).toEqual([r1.ledger.actualAmount]);
        expect((await monthlyUsage(db, owner)).byCurrency.map((u) => u.used)).toEqual([fromMicro(toMicro(r1.ledger.actualAmount!) + toMicro(r2.ledger.actualAmount!))]);
        expect(pv.preview.warnings.map((w) => w.code)).toEqual([]);
      } finally {
        await h.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('LIVEL1-H2 — 복원이 실패하면 비어 있지 않은 대상 DB 의 행 값이 그대로(개수가 아니라 필드 값)', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
  /** put 은 아무것도 하지 않고 get 은 다른 바이트 — 커밋의 파일 단계(applyBundle 이 이미 쓴 뒤)에서 checksum 실패(AppError 아님) */
  const failingStore: BlobStore = { put: async () => {}, get: async () => new Uint8Array([0]) };
  // H1 시험과 같은 손상 3종
  const CORRUPT: Array<[string, (s: Record<string, unknown>) => void]> = [
    ['reported_cost 없음', (s) => void delete s.reported_cost],
    ['reported_tokens_in 음수', (s) => void (s.reported_tokens_in = '-1')],
    ['reported_* 만 남고 usage_source 없음', (s) => void delete s.usage_source],
  ];
  let tmp: string;
  let restoresDir: string;
  let h: Awaited<ReturnType<typeof createTestDb>>;
  let T: string;
  let src: { zip: Uint8Array; parsed: ParsedBundle; ledgerId: string; assetId: string };
  // 월 사용량 비교는 같은 기준 시각으로(시험이 MSK 월 경계를 지나면 흔들릴 수 있다 — 무시할 만한 위험)
  let fixedNow: Date;

  const ownerRows = async (dbX: Db, ownerId: string) => {
    const out: Record<string, unknown[]> = {};
    for (const t of RESTORED_TABLES) out[t] = (await selectBundleRows(dbX, t, ownerScope(t, ownerId))).map((r) => r.row);
    return out;
  };
  const restoreRunsOfT = () => h.db.select().from(schema.restoreRuns).where(eq(schema.restoreRuns.ownerId, T));
  const commitAudits = (restoreId: string) =>
    h.db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, 'restore.commit'), eq(schema.auditEvents.entityId, restoreId)));
  const corruptZip = (mutate: (s: Record<string, unknown>) => void) =>
    rebuiltZip(src.parsed, (t) => mutate(t.usage_ledger.find((l) => l.id === src.ledgerId)!.pricing_snapshot as Record<string, unknown>));
  const commit = (store: BlobStore, restoreId: string) => commitRestore(h.db, store, T, restoreId, { mode: 'add_missing', confirm: true, restoresDir });
  /** 전제: 정상 묶음의 미리보기 — 대상은 비어 있지 않고, 원장·파일이 새로 들어갈 자리가 있다(새면 잡히고, 저장소까지 닿는다). */
  async function validPreview() {
    const pv = await createRestorePreview(h.db, T, src.zip, { restoresDir, source: 'upload' });
    expect(pv.preview.can_commit_empty_only).toBe(false);
    expect(pv.preview.conflicts_total).toBe(0);
    expect(pv.preview.tables.usage_ledger).toMatchObject({ new: 1 });
    expect(pv.preview.tables.assets).toMatchObject({ new: 1 });
    expect(await hasUnresolvedLiveUsage(h.db, T)).toBe(false);
    return pv;
  }

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'cs-livel1-h2-keep-'));
    restoresDir = path.join(tmp, 'restores');
    // 원본 S(공용 DB): provider_unstorable 원장 + 파일 1개 → 내보내기
    const { owner: S, ledgerId } = await unstorableRun('live-l1-h2-keep-src@example.local');
    const storageDir = path.join(tmp, 'assets-src');
    const assetId = randomUUID();
    const key = buildAssetKey(S, assetId);
    await new LocalStorageAdapter(storageDir).put(key, PNG);
    await insertAsset(db, { id: assetId, ownerId: S, key, mime: 'image/png', bytes: PNG.byteLength, checksum: sha256Hex(PNG), rightsStatus: 'owned', verificationState: 'VERIFIED' });
    const exported = await exportOwner(db, new LocalStorageAdapter(storageDir), S, { outDir: path.join(tmp, 'exports') });
    const zip = new Uint8Array(readFileSync(exported.zipPath));
    src = { zip, parsed: await parseBundleZip(zip), ledgerId, assetId };
    // 대상 T(새 DB): 브랜드 v2(묶음의 v1 이 version_exists 충돌이 되지 않게) + 원고 + 정상 live run(usage_source provider)
    h = await createTestDb();
    T = (await ensureOwner(h.db, 'restore-livel1-h2-keep@example.local')).id;
    await h.db.insert(schema.brandProfiles).values({ ownerId: T, version: 2, penName: 'tp', audience: 'ta', pillars: ['y'] });
    const tc = await createContent(h.db, T, { title: '대상 원고', body: '대상 본문.' });
    const tr = await runAssist(h.db, T, tc.content.id, { ...draft(), brandProfileVersion: 2 }, claude(fakeFetch(json(200, message())).fetch));
    expect(tr.ledger.pricingSnapshot).toMatchObject({ usage_source: 'provider' });
    fixedNow = new Date();
  });
  afterAll(async () => {
    await h?.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('H2(a) 업로드 미리보기 integrity 거부(3종) → 모든 복원 표의 대상 행 값 그대로, restore_runs·ZIP 추가 없음, 차단·월 사용량 그대로', async () => {
    await validPreview(); // 전제 + restoresDir 생성(손상 미리보기는 디렉터리를 만들기 전에 거부된다)
    const before = await ownerRows(h.db, T);
    const runsBefore = await restoreRunsOfT();
    const filesBefore = readdirSync(restoresDir).sort();
    const usageBefore = await monthlyUsage(h.db, T, fixedNow);
    for (const [label, mutate] of CORRUPT) {
      const e = await errOf(createRestorePreview(h.db, T, corruptZip(mutate), { restoresDir, source: 'upload' }));
      expect(e?.code, label).toBe('integrity');
    }
    expect(await ownerRows(h.db, T)).toEqual(before);
    expect(await restoreRunsOfT()).toEqual(runsBefore);
    expect(readdirSync(restoresDir).sort()).toEqual(filesBefore);
    expect(await hasUnresolvedLiveUsage(h.db, T)).toBe(false);
    expect(await monthlyUsage(h.db, T, fixedNow)).toEqual(usageBefore);
  });

  it('H2(b) 미리보기 뒤 저장 ZIP 이 손상 묶음으로 바뀜 → 커밋 integrity 거부·restore_runs rejected, 대상 행 값 그대로, 감사 없음, 다시 커밋은 restore_not_committable', async () => {
    const pv = await validPreview();
    const before = await ownerRows(h.db, T);
    const usageBefore = await monthlyUsage(h.db, T, fixedNow);
    writeFileSync(restoreZipPath(restoresDir, pv.restoreId), corruptZip(CORRUPT[0]![1]));
    const e = await errOf(commit(new LocalStorageAdapter(path.join(tmp, 'assets-t')), pv.restoreId));
    expect(e).toBeInstanceOf(AppError);
    expect(e?.code).toBe('integrity');
    expect((await getRestoreRun(h.db, T, pv.restoreId))?.status).toBe('rejected');
    expect(await ownerRows(h.db, T)).toEqual(before);
    expect(await h.db.select().from(schema.usageLedger).where(eq(schema.usageLedger.id, src.ledgerId))).toEqual([]);
    expect(await hasUnresolvedLiveUsage(h.db, T)).toBe(false);
    expect(await monthlyUsage(h.db, T, fixedNow)).toEqual(usageBefore);
    expect(await commitAudits(pv.restoreId)).toEqual([]);
    expect((await errOf(commit(new LocalStorageAdapter(path.join(tmp, 'assets-t')), pv.restoreId)))?.code).toBe('restore_not_committable');
  });

  it('H2(c) 커밋 트랜잭션 안 실패(파일 checksum — 행을 쓴 뒤) → 전체 되돌림·restore_runs failed, 행 값·차단·월 사용량 그대로 — 대조: 실제 저장소로 다시 하면 복원되고 차단이 켜진다', async () => {
    const pv = await validPreview();
    const before = await ownerRows(h.db, T);
    const usageBefore = await monthlyUsage(h.db, T, fixedNow);
    const e = await errOf(commit(failingStore, pv.restoreId));
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(AppError);
    expect((e as unknown as Error).message).toContain('checksum');
    expect((await getRestoreRun(h.db, T, pv.restoreId))?.status).toBe('failed');
    expect(await ownerRows(h.db, T)).toEqual(before);
    expect(await h.db.select().from(schema.usageLedger).where(eq(schema.usageLedger.id, src.ledgerId))).toEqual([]);
    expect(await h.db.select().from(schema.assets).where(eq(schema.assets.id, src.assetId))).toEqual([]);
    // 되돌림이 새면 S 의 provider_unstorable 행 때문에 true 가 된다
    expect(await hasUnresolvedLiveUsage(h.db, T)).toBe(false);
    expect(await monthlyUsage(h.db, T, fixedNow)).toEqual(usageBefore);
    expect(await commitAudits(pv.restoreId)).toEqual([]);
    expect((await errOf(commit(failingStore, pv.restoreId)))?.code).toBe('restore_not_committable');
    // 대조: 같은 묶음 + 실제 저장소 → 실제로 쓰는 경로였다(되돌림을 증명)
    const pv2 = await validPreview();
    const ok = await commit(new LocalStorageAdapter(path.join(tmp, 'assets-t')), pv2.restoreId);
    expect([ok.restored.usage_ledger, ok.restored.assets, ok.assets_verified]).toEqual([1, 1, 1]);
    expect(await hasUnresolvedLiveUsage(h.db, T)).toBe(true);
    expect((await commitAudits(pv2.restoreId)).length).toBe(1);
    expect(await ownerRows(h.db, T)).not.toEqual(before);
  });
});
