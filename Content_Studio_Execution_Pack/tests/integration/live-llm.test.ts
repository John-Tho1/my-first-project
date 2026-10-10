/**
 * LIVE-L1(D34 1단계): 실제 Claude 어댑터(ClaudeLlmProvider)를 db 층·route 로 끝까지 — 가짜 fetch 가 기록된 Messages API 응답을 돌려준다.
 * 네트워크 0(setupFiles 가드가 api.anthropic.com 을 막는다), 과금 0. 시험 키는 가짜 sentinel 이며 응답·DB·감사에 나오지 않아야 한다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { count, eq } from 'drizzle-orm';
import { closeDb, createContent, ensureOwner, getDb, runAssist, runVariantAssist, schema, seed, type Db } from '@cs/db';
import {
  AppError,
  budgetPolicy,
  costMicro,
  fromMicro,
  LIVE_LLM_FIXED_INPUT_BYTES,
  LIVE_LLM_FRAMING_OVERHEAD_TOKENS,
  loadConfig,
  reserveFor,
  toMicro,
  utf8ByteLength,
} from '@cs/domain';
import { ClaudeLlmProvider } from '@cs/providers';
import { GET as healthGET } from '../../apps/web/app/api/health/route';
import { POST as assistPOST } from '../../apps/web/app/api/contents/[id]/assist/route';
import { cookieHeader, jsonPost, login } from './helpers';

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
      const h = await healthGET();
      const htext = await h.text();
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
      const h = await (await healthGET()).json();
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
