/**
 * T07(결정 D13): 입력 버전 고정(허용 출처), claim–source 연결(모델이 만든 출처는 저장하지 않음), 비용 예약(A15),
 * live 경계(fail-closed, 외부 호출 0), health 의 준비 상태, export → 빈 DB 복원(새 표 포함).
 * 외부 호출 없음: 모든 AI 는 MockLlmProvider 또는 그것을 감싼 테스트 stub 이다.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, count, eq, sql } from 'drizzle-orm';
import {
  closeDb,
  commitRestore,
  confirmClaims,
  createContentFromCapture,
  createRestorePreview,
  createTestDb,
  ensureOwner,
  exportOwner,
  generationRunView,
  getBrandProfileByVersion,
  getDb,
  getWritingState,
  listClaimsForRun,
  monthlyUsage,
  ownerScope,
  promptBrand,
  runAssist,
  runVariantAssist,
  createContent,
  schema,
  seed,
  selectBundleRows,
  type AssistLlm,
  type Db,
} from '@cs/db';
import {
  AppError,
  assistInputVersion,
  buildAssistPrompt,
  budgetPolicy,
  costMicro,
  fromMicro,
  loadConfig,
  mskNextMonthStart,
  pickDefaultSources,
  reserveFor,
  RESTORED_TABLES,
  toMicro,
  type BudgetPolicy,
  type LlmStructuredOutput,
} from '@cs/domain';
import { LocalStorageAdapter, MockLlmProvider } from '@cs/providers';
import { GET as healthGET } from '../../apps/web/app/api/health/route';
import { POST as assistPOST } from '../../apps/web/app/api/contents/[id]/assist/route';
import { assistResponse } from '../../apps/web/lib/writing';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const A = 'owner@example.local';
const B = 'budget-other@example.local';

let db: Db;
let ownerA: string;
let ownerB: string;
let tokenA: string;
let svA: string;
let svB: string;
let tmp: string;

const as = (identity: string) => vi.stubEnv('AUTH_ALLOWED_IDENTITY', identity);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const assist = (id: string, body: unknown) => assistPOST(jsonPost(`/api/contents/${id}/assist`, body, cookieHeader(tokenA)), ctx(id));

const n = async (t: typeof schema.generationRuns | typeof schema.usageLedger | typeof schema.claims) =>
  (await db.select({ n: count() }).from(t))[0]!.n;
const versionsOf = async (contentId: string) =>
  (await db.select({ n: count() }).from(schema.contentVersions).where(eq(schema.contentVersions.contentId, contentId)))[0]!.n;
const counts = async (contentId: string) => ({
  runs: await n(schema.generationRuns),
  ledger: await n(schema.usageLedger),
  claims: await n(schema.claims),
  versions: await versionsOf(contentId),
});

/** owner 의 URL 출처 + source_version + 그 출처를 가진 소재 → 그 소재에서 시작한 원고. */
async function contentWithSource(ownerId: string, key: string, url: string) {
  const [src] = await db.insert(schema.sources).values({ ownerId, kind: 'url', canonicalUrl: url }).returning();
  const [sv] = await db
    .insert(schema.sourceVersions)
    .values({ sourceId: src!.id, excerpt: '공개 보고서 요약(가상)', extractionState: 'fetched', rawHash: 'h' })
    .returning();
  const [cap] = await db
    .insert(schema.captures)
    .values({ ownerId, rawText: `가상 소재 ${key}: 시장이 커지고 있다.`, inputType: 'url', sourceId: src!.id, commandKey: key })
    .returning();
  const c = await createContentFromCapture(db, ownerId, cap!.id);
  return { contentId: c.content.id, svId: sv!.id, versionId: c.version.id };
}

/** prepareAssist 와 같은 입력으로 프롬프트를 다시 만들어 예약액을 계산한다(테스트 기대값용). */
async function expectedReserve(ownerId: string, contentId: string, policy: BudgetPolicy, sourceIds: string[] = []) {
  const [c] = await db.select().from(schema.contents).where(eq(schema.contents.id, contentId));
  const [v] = await db.select().from(schema.contentVersions).where(eq(schema.contentVersions.id, c!.currentVersionId!));
  const brand = (await getBrandProfileByVersion(db, ownerId, 1))!;
  const inputVersion = assistInputVersion({ contentVersionId: v!.id, brandProfileVersion: 1, answerIds: [], sourceVersionIds: sourceIds });
  const prompt = buildAssistPrompt({ mode: 'draft', inputVersion, brand: promptBrand(brand), answers: [], title: c!.title, body: v!.body });
  return reserveFor(policy, prompt);
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-t07-it-'));
  db = (await getDb(loadConfig())).db;
  ownerA = (await seed(db, { allowedIdentity: A })).ownerId;
  ownerB = (await seed(db, { allowedIdentity: B })).ownerId;
  svA = (await contentWithSource(ownerA, 'src-a', 'https://example.com/report-a')).svId;
  svB = (await contentWithSource(ownerB, 'src-b', 'https://example.com/report-b')).svId;
  as(A);
  tokenA = await login(A);
});
beforeEach(() => as(A));
afterAll(async () => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
  await closeDb();
});

describe('허용 출처(입력 버전 고정)와 claim–source 연결', () => {
  it('source_version_ids → refs 에 고정, 프롬프트 t07-assist-v2, claim·claim_sources(locator) 저장, 모의 원장(0) 확정', async () => {
    const { contentId, svId } = await contentWithSource(ownerA, 'src-a2', 'https://example.com/report-a2');
    const res = await assist(contentId, { mode: 'draft', base_version: 1, brand_profile_version: 1, source_version_ids: [svId.toUpperCase()] });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.run.prompt_version).toBe('t07-assist-v3');
    expect(body.run.input_version_refs.source_version_ids).toEqual([svId]);
    expect(body.run.input_version_refs.input_version).toContain(`;sv:${svId}`);
    expect(body.usage).toMatchObject({ state: 'settled', reserved_amount: '0.000000', actual_amount: '0.000000', failed: false });
    expect(body.usage.pricing_snapshot).toMatchObject({ mode: 'mock', priced: false });
    expect(body.usage.tokens_in).toBeGreaterThan(0);

    const views = await listClaimsForRun(db, ownerA, body.run.id);
    expect(views).toHaveLength(body.claims.length);
    const opinion = views.find((v) => v.kind === 'opinion')!;
    expect(opinion).toMatchObject({ evidence_grade: 'source', sources: [{ source_version_id: svId, locator: 'https://example.com/report-a2' }] });
    const [claimRow] = await db.select().from(schema.claims).where(eq(schema.claims.id, opinion.id));
    expect(claimRow).toMatchObject({ ownerId: ownerA, contentVersionId: body.proposal_version.id, runId: body.run.id });
    // claims·claim_sources 는 추가 전용
    await expect(db.execute(sql`update claims set statement = 'x'`)).rejects.toThrow();
    await expect(db.execute(sql`delete from claim_sources`)).rejects.toThrow();
  });

  it('다른 owner·다른 원고의 source_version → 404, 형식 오류 → 400, 아무것도 쓰지 않음', async () => {
    const { contentId } = await contentWithSource(ownerA, 'src-a3', 'https://example.com/report-a3');
    const before = await counts(contentId);
    expect((await assist(contentId, { mode: 'draft', base_version: 1, brand_profile_version: 1, source_version_ids: [svB] })).status).toBe(404);
    expect((await assist(contentId, { mode: 'draft', base_version: 1, brand_profile_version: 1, source_version_ids: [svA] })).status).toBe(404);
    expect((await assist(contentId, { mode: 'draft', base_version: 1, brand_profile_version: 1, source_version_ids: ['nope'] })).status).toBe(400);
    expect(await counts(contentId)).toEqual(before);
  });

  it('모델이 만든 출처(허용 목록 밖)는 저장하지 않고 개수·경고·needs_check 로만 남긴다', async () => {
    const { contentId, svId } = await contentWithSource(ownerA, 'src-a4', 'https://example.com/report-a4');
    const mock = new MockLlmProvider();
    const inventing: AssistLlm = {
      name: 'mock',
      mode: 'mock',
      async generate(input) {
        const out = await mock.generate(input);
        return {
          ...out,
          claims: [
            { text: '시장은 30% 커졌다.', kind: 'fact', source_refs: [svId, 'https://invented.example/fake-report'], needs_user_confirmation: false },
            { text: '근거가 필요한 사실.', kind: 'fact', source_refs: ['00000000-0000-4000-8000-000000000000'], needs_user_confirmation: false },
          ],
        } satisfies LlmStructuredOutput;
      },
    };
    const r = await runAssist(db, ownerA, contentId, { mode: 'draft', baseVersion: 1, brandProfileVersion: 1, answerIds: [], sourceVersionIds: [svId] }, inventing);
    expect(r.claims.map((c) => [c.source_refs, c.dropped_source_refs, c.needs_check])).toEqual([
      [[svId], 1, true],
      [[], 1, true],
    ]);
    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, r.run.id));
    const stored = JSON.stringify(run!.outputJson);
    expect(stored).not.toContain('invented.example');
    expect(stored).not.toContain('00000000-0000-4000-8000-000000000000');
    expect((run!.outputJson as { warnings: string[] }).warnings.some((w) => w.startsWith('출처 미확인'))).toBe(true);
    const srcs = await db
      .select()
      .from(schema.claimSources)
      .innerJoin(schema.claims, eq(schema.claims.id, schema.claimSources.claimId))
      .where(eq(schema.claims.runId, r.run.id));
    expect(srcs.map((s) => s.claim_sources.sourceVersionId)).toEqual([svId]);
    const views = await listClaimsForRun(db, ownerA, r.run.id);
    expect(views.map((v) => [v.evidence_grade, v.needs_check])).toEqual([
      ['source', true],
      ['none', true],
    ]);
  });

  it('경험 claim 을 사용자가 확인하면 evidence_grade 는 user_confirmed 로 파생된다(claims 행은 그대로)', async () => {
    const { contentId } = await contentWithSource(ownerA, 'src-a5', 'https://example.com/report-a5');
    const mock = new MockLlmProvider();
    const exp: AssistLlm = {
      name: 'mock',
      mode: 'mock',
      generate: async (input) => ({
        ...(await mock.generate(input)),
        claims: [{ text: '제가 직접 협상했습니다.', kind: 'experience', source_refs: [], needs_user_confirmation: true }],
      }),
    };
    const r = await runAssist(db, ownerA, contentId, { mode: 'draft', baseVersion: 1, brandProfileVersion: 1, answerIds: [] }, exp);
    expect((await listClaimsForRun(db, ownerA, r.run.id))[0]).toMatchObject({ evidence_grade: 'none', personal_experience_confirmed: false, needs_check: true });
    await confirmClaims(db, ownerA, contentId, r.run.id, [0], 'confirmed');
    expect((await listClaimsForRun(db, ownerA, r.run.id))[0]).toMatchObject({
      evidence_grade: 'user_confirmed',
      personal_experience_confirmed: true,
      needs_check: false,
    });
    const [row] = await db.select().from(schema.claims).where(eq(schema.claims.runId, r.run.id));
    expect(row!.evidenceGrade).toBe('none');
    expect(await listClaimsForRun(db, ownerB, r.run.id)).toEqual([]);
  });
});

describe('비용 예약(A15)', () => {
  const PRICE = { LLM_PRICE_INPUT_PER_1K: '1', LLM_PRICE_OUTPUT_PER_1K: '2' };
  const stubPrice = () => {
    for (const [k, v] of Object.entries(PRICE)) vi.stubEnv(k, v);
  };
  const unstubPrice = () => {
    for (const k of [...Object.keys(PRICE), 'LLM_BUDGET_MONTHLY_LIMIT', 'LLM_BUDGET_PER_RUN_MAX', 'LLM_MOCK_FAIL_NEXT']) vi.stubEnv(k, '');
  };

  it('예약 = 추정 입력×단가 + 출력 여유분×단가, 확정 = 실제 토큰×단가', async () => {
    const { contentId } = await contentWithSource(ownerA, 'bud-1', 'https://example.com/b1');
    stubPrice();
    try {
      const policy = budgetPolicy(loadConfig(process.env));
      const exp = await expectedReserve(ownerA, contentId, policy);
      const res = await assist(contentId, { mode: 'draft', base_version: 1, brand_profile_version: 1 });
      expect(res.status).toBe(201);
      const u = (await res.json()).usage;
      expect(u.reserved_amount).toBe(fromMicro(exp.reserveMicro));
      expect(u.tokens_in).toBe(exp.tokensIn);
      expect(u.actual_amount).toBe(fromMicro(costMicro(policy.pricing, u.tokens_in, u.tokens_out)));
      expect(u.pricing_snapshot).toMatchObject({ currency: 'USD', input_per_1k: '1.000000', output_per_1k: '2.000000' });
      expect(toMicro(u.actual_amount)).toBeLessThanOrEqual(toMicro(u.reserved_amount));
    } finally {
      unstubPrice();
    }
  });

  it('월 상한·1회 상한 초과 → 429 budget_exceeded, run·원장·버전 없음', async () => {
    const { contentId } = await contentWithSource(ownerA, 'bud-2', 'https://example.com/b2');
    const before = await counts(contentId);
    stubPrice();
    try {
      vi.stubEnv('LLM_BUDGET_MONTHLY_LIMIT', '0.000001');
      const res = await assist(contentId, { mode: 'draft', base_version: 1, brand_profile_version: 1 });
      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({ error: 'budget_exceeded', reason: 'monthly_limit', currency: 'USD' });
      vi.stubEnv('LLM_BUDGET_MONTHLY_LIMIT', '');
      vi.stubEnv('LLM_BUDGET_PER_RUN_MAX', '0.000001');
      const res2 = await assist(contentId, { mode: 'draft', base_version: 1, brand_profile_version: 1 });
      expect(res2.status).toBe(429);
      expect((await res2.json()).reason).toBe('per_run_max');
    } finally {
      unstubPrice();
    }
    expect(await counts(contentId)).toEqual(before);
  });

  it('실패한 호출은 예약액 전체를 실제액으로 확정(failed=true), run failed, 버전 없음', async () => {
    const { contentId } = await contentWithSource(ownerA, 'bud-3', 'https://example.com/b3');
    const versions = await versionsOf(contentId);
    stubPrice();
    vi.stubEnv('LLM_MOCK_FAIL_NEXT', '1');
    let runId: string;
    try {
      const res = await assist(contentId, { mode: 'draft', base_version: 1, brand_profile_version: 1 });
      expect(res.status).toBe(502);
      const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.contentId, contentId));
      runId = run!.id;
      expect(run!.status).toBe('failed');
    } finally {
      unstubPrice();
    }
    const [l] = await db.select().from(schema.usageLedger).where(eq(schema.usageLedger.runId, runId));
    expect(l).toMatchObject({ state: 'settled', failed: true, tokensIn: null });
    expect(l!.actualAmount).toBe(l!.reservedAmount);
    expect(toMicro(l!.reservedAmount)).toBeGreaterThan(0);
    expect(await versionsOf(contentId)).toBe(versions);
  });

  it('동시 3건: 모두 예약된 뒤에 확정되는 상황에서 상한에 맞는 2건만 성공, 1건은 429(run·원장 없음)', async () => {
    const owner = (await ensureOwner(db, 'budget-concurrent@example.local')).id;
    await db.insert(schema.brandProfiles).values({ ownerId: owner, version: 1, penName: 'p', audience: 'a', pillars: ['x'] });
    const { contentId } = await contentWithSource(owner, 'bud-c', 'https://example.com/bc');
    const base = budgetPolicy(loadConfig({ LLM_PRICE_INPUT_PER_1K: '1', LLM_PRICE_OUTPUT_PER_1K: '2' }));
    const r = await expectedReserve(owner, contentId, base);
    const policy: BudgetPolicy = { ...base, monthlyLimitMicro: r.reserveMicro * 2n + r.reserveMicro / 2n };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    const mock = new MockLlmProvider();
    const gated: AssistLlm = {
      name: 'mock',
      mode: 'mock',
      async generate(input) {
        started++;
        await gate;
        return mock.generate(input);
      },
      usageOf: (i, o) => mock.usageOf(i, o),
    };
    const call = () =>
      runAssist(db, owner, contentId, { mode: 'draft', baseVersion: 1, brandProfileVersion: 1, answerIds: [], budget: policy }, gated).then(
        () => 'ok',
        (e: unknown) => (e instanceof AppError ? e.code : 'other'),
      );
    const p = [call(), call(), call()];
    // 세 요청의 예약 단계가 끝날 때까지 기다린 뒤(2건은 provider 에서 대기, 1건은 거부) 풀어 준다
    const settled = await Promise.race([Promise.all(p).then(() => 'done'), new Promise((res) => setTimeout(() => res('waiting'), 1500))]);
    expect(settled).toBe('waiting');
    expect(started).toBe(2);
    release();
    const results = await Promise.all(p);
    expect(results.sort()).toEqual(['budget_exceeded', 'ok', 'ok']);
    const ledger = await db.select().from(schema.usageLedger).where(eq(schema.usageLedger.ownerId, owner));
    expect(ledger).toHaveLength(2);
    const runs = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.ownerId, owner));
    expect(runs).toHaveLength(2);
    const u = (await monthlyUsage(db, owner)).byCurrency;
    expect(u.map((x) => x.currency)).toEqual(['USD']);
    expect(u[0]!.usedMicro).toBeLessThanOrEqual(policy.monthlyLimitMicro!);
    expect(u[0]!.pending).toBe(0);
  });
});

describe('live 경계(fail-closed, 외부 호출 0)', () => {
  const FULL = {
    LLM_MODE: 'live',
    LLM_PROVIDER: 'provider-placeholder',
    LLM_MODEL: 'model-placeholder',
    LLM_PRICE_INPUT_PER_1K: '1',
    LLM_PRICE_OUTPUT_PER_1K: '1',
    LLM_BUDGET_MONTHLY_LIMIT: '10',
    LLM_LIVE_APPROVAL_REF: 'approval-placeholder',
  };
  const reset = () => {
    for (const k of Object.keys(FULL)) vi.stubEnv(k, '');
    vi.stubEnv('LLM_MODE', 'mock');
  };

  it.each([
    ['(모두 있음)', null, 'live_provider_not_configured'],
    ['LLM_PROVIDER', 'LLM_PROVIDER', 'live_llm_not_allowed'],
    ['LLM_MODEL', 'LLM_MODEL', 'live_llm_not_allowed'],
    ['LLM_PRICE_INPUT_PER_1K', 'LLM_PRICE_INPUT_PER_1K', 'live_provider_not_configured'],
    ['LLM_PRICE_OUTPUT_PER_1K', 'LLM_PRICE_OUTPUT_PER_1K', 'live_provider_not_configured'],
    ['LLM_BUDGET_MONTHLY_LIMIT', 'LLM_BUDGET_MONTHLY_LIMIT', 'live_provider_not_configured'],
    ['LLM_LIVE_APPROVAL_REF', 'LLM_LIVE_APPROVAL_REF', 'live_provider_not_configured'],
  ])('%s 빠짐 → 503 %s, 아무것도 쓰지 않음', async (_label, missing, code) => {
    const { contentId } = await contentWithSource(ownerA, `live-${String(missing)}`, `https://example.com/live-${String(missing)}`);
    const before = await counts(contentId);
    try {
      for (const [k, v] of Object.entries(FULL)) vi.stubEnv(k, k === missing ? '' : v);
      const res = await assist(contentId, { mode: 'draft', base_version: 1, brand_profile_version: 1 });
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(JSON.parse(text).error).toBe(code);
      expect(text).not.toMatch(/placeholder/);
      if (missing && code === 'live_provider_not_configured') expect(text).toContain(missing);
    } finally {
      reset();
    }
    expect(await counts(contentId)).toEqual(before);
  });

  it('health: llm.live_ready=false, 빠진 조건 이름만(값 없음)', async () => {
    try {
      for (const [k, v] of Object.entries(FULL)) vi.stubEnv(k, k === 'LLM_LIVE_APPROVAL_REF' ? '' : v);
      const res = await healthGET();
      const text = await res.text();
      const body = JSON.parse(text);
      expect(body.llm).toEqual({
        mode: 'live',
        live_ready: false,
        missing: ['LLM_LIVE_APPROVAL_REF', 'LIVE_ADAPTER(T07 미구현, D8 결정 후)'],
      });
      expect(text).not.toMatch(/placeholder/);
    } finally {
      reset();
    }
    const body = await (await healthGET()).json();
    expect(body.llm.live_ready).toBe(false);
    expect(body.llm.missing).toContain('LLM_MODE=live');
  });
});

describe('export → 빈 DB 복원: claims·claim_sources·usage_ledger 왕복', () => {
  it('모든 복원 표가 ID·값 그대로(원장 금액·가격 스냅숏 포함)', async () => {
    const storage = new LocalStorageAdapter(path.join(tmp, 'assets'));
    const exported = await exportOwner(db, storage, ownerA, { outDir: path.join(tmp, 'exports') });
    expect(exported.manifest.tables.claims!.rows).toBeGreaterThan(0);
    expect(exported.manifest.tables.claim_sources!.rows).toBeGreaterThan(0);
    expect(exported.manifest.tables.usage_ledger!.rows).toBeGreaterThan(0);
    const zip = new Uint8Array(readFileSync(exported.zipPath));
    const h = await createTestDb();
    try {
      const target = (await ensureOwner(h.db, 'restore-t07@example.local')).id;
      const restoresDir = path.join(tmp, 'restores');
      const p = await createRestorePreview(h.db, target, zip, { restoresDir, source: 'upload' });
      expect(p.preview.conflicts_total).toBe(0);
      const r = await commitRestore(h.db, new LocalStorageAdapter(path.join(tmp, 'assets-b')), target, p.restoreId, {
        mode: 'empty_only',
        confirm: true,
        restoresDir,
      });
      expect(r.conflicts_total).toBe(0);
      for (const t of RESTORED_TABLES) {
        const a = (await selectBundleRows(db, t, ownerScope(t, ownerA))).map((x) => x.row);
        const b = (await selectBundleRows(h.db, t, ownerScope(t, target))).map((x) => x.row);
        expect(b, t).toEqual(a);
      }
      const ledgerB = await h.db.select().from(schema.usageLedger).where(and(eq(schema.usageLedger.ownerId, target)));
      expect(ledgerB.length).toBe(exported.manifest.tables.usage_ledger!.rows);
      expect((await monthlyUsage(h.db, target)).byCurrency).toEqual((await monthlyUsage(db, ownerA)).byCurrency);
    } finally {
      await h.close();
    }
  });
});

describe('FIX-T07(Codex review-T07)', () => {
  const PRICED = budgetPolicy(loadConfig({ LLM_PRICE_INPUT_PER_1K: '1', LLM_PRICE_OUTPUT_PER_1K: '2' }));

  async function freshOwner(identity: string) {
    const owner = (await ensureOwner(db, identity)).id;
    await db.insert(schema.brandProfiles).values({ ownerId: owner, version: 1, penName: 'p', audience: 'a', pillars: ['x'] });
    return owner;
  }

  it('P1 예약 초과: provider 가 상한을 어기면 초과액을 그대로 기록(over_budget), 다음 예약은 거부, provider 는 maxOutputTokens 를 받는다', async () => {
    const owner = await freshOwner('fix-t07-overage@example.local');
    const { contentId } = await contentWithSource(owner, 'ov-1', 'https://example.com/ov1');
    const r = await expectedReserve(owner, contentId, PRICED);
    const policy: BudgetPolicy = { ...PRICED, monthlyLimitMicro: r.reserveMicro + r.reserveMicro / 2n };
    const mock = new MockLlmProvider();
    const seen: Array<number | undefined> = [];
    const greedy: AssistLlm = {
      name: 'mock',
      mode: 'mock',
      async generate(input) {
        seen.push(input.maxOutputTokens);
        return mock.generate(input);
      },
      // 상한의 10배를 썼다고 보고하는 provider(규칙 위반) — 숨기지 않고 기록해야 한다
      usageOf: (i) => ({ tokensIn: r.tokensIn, tokensOut: (i.maxOutputTokens ?? 0) * 10 }),
    };
    const res = await runAssist(db, owner, contentId, { mode: 'draft', baseVersion: 1, brandProfileVersion: 1, answerIds: [], budget: policy }, greedy);
    expect(seen).toEqual([r.tokensOutAllowance]);
    const actual = costMicro(PRICED.pricing, r.tokensIn, r.tokensOutAllowance * 10);
    expect(res.ledger).toMatchObject({ overBudget: true, reservedAmount: fromMicro(r.reserveMicro), actualAmount: fromMicro(actual) });
    expect(res.ledger.overageAmount).toBe(fromMicro(actual - r.reserveMicro));
    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, res.run.id));
    expect((run!.outputJson as { over_budget?: boolean }).over_budget).toBe(true);
    const u = (await monthlyUsage(db, owner)).byCurrency[0]!;
    expect(u).toMatchObject({ currency: 'USD', overBudgetRuns: 1, overage: fromMicro(actual - r.reserveMicro), used: fromMicro(actual) });
    // 월 합계가 상한을 넘었으므로 다음 예약은 거부(run 없음)
    let code = '';
    try {
      await runAssist(db, owner, contentId, { mode: 'draft', baseVersion: 1, brandProfileVersion: 1, answerIds: [], budget: policy }, new MockLlmProvider());
    } catch (e) {
      code = (e as AppError).code;
    }
    expect(code).toBe('budget_exceeded');
    expect((await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.ownerId, owner))).length).toBe(1);
  });

  it('P1 통화: 이번 달 원장에 다른 통화가 있으면 409 budget_currency_mismatch(아무것도 쓰지 않음), 사용량은 통화별, 복원 미리보기 경고', async () => {
    const owner = await freshOwner('fix-t07-currency@example.local');
    const { contentId } = await contentWithSource(owner, 'cur-1', 'https://example.com/cur1');
    await runAssist(db, owner, contentId, { mode: 'draft', baseVersion: 1, brandProfileVersion: 1, answerIds: [], budget: { ...PRICED, currency: 'RUB', pricing: { ...PRICED.pricing!, currency: 'RUB' } } }, new MockLlmProvider());
    const before = await counts(contentId);
    let err: AppError | null = null;
    try {
      await runAssist(db, owner, contentId, { mode: 'draft', baseVersion: 1, brandProfileVersion: 1, answerIds: [], budget: PRICED }, new MockLlmProvider());
    } catch (e) {
      err = e as AppError;
    }
    expect(err?.code).toBe('budget_currency_mismatch');
    expect(err?.extra).toEqual({ configured: 'USD', found: ['RUB'] });
    expect(await counts(contentId)).toEqual(before);
    expect((await monthlyUsage(db, owner)).byCurrency.map((c) => c.currency)).toEqual(['RUB']);

    const exported = await exportOwner(db, new LocalStorageAdapter(path.join(tmp, 'assets')), owner, { outDir: path.join(tmp, 'exports-cur') });
    const zip = new Uint8Array(readFileSync(exported.zipPath));
    const h = await createTestDb();
    try {
      const target = (await ensureOwner(h.db, 'restore-cur@example.local')).id;
      const p = await createRestorePreview(h.db, target, zip, { restoresDir: path.join(tmp, 'restores-cur'), source: 'upload', budgetCurrency: 'USD' });
      expect(p.preview.warnings.map((w) => w.code)).toContain('ledger_currency_mismatch');
      const same = await createRestorePreview(h.db, target, zip, { restoresDir: path.join(tmp, 'restores-cur'), source: 'upload', budgetCurrency: 'RUB' });
      expect(same.preview.warnings.map((w) => w.code)).not.toContain('ledger_currency_mismatch');
    } finally {
      await h.close();
    }
  });

  it('P1 버린 출처(round 4): 같은 가짜 URL 이 글에 있으면 출력 전체 실패, source_refs 에만 있으면 버리고 저장·응답 어디에도 남지 않는다', async () => {
    const FAKE = 'https://invented.example/fake-report-2026';
    const { contentId, svId } = await contentWithSource(ownerA, 'fix-leak', 'https://example.com/leak');
    const mock = new MockLlmProvider();
    const leaky: AssistLlm = {
      name: 'mock',
      mode: 'mock',
      async generate(input) {
        const out = await mock.generate(input);
        return {
          ...out,
          proposed_text: `${out.proposed_text} 출처: ${FAKE}`,
          warnings: [...out.warnings, `확인 필요: ${FAKE}`],
          followup_questions: [`${FAKE} 를 볼까요?`],
          claims: [{ text: `보고서(${FAKE})에 따르면 시장이 컸다.`, kind: 'fact', source_refs: [FAKE, svId], needs_user_confirmation: false }],
        } satisfies LlmStructuredOutput;
      },
    };
    const input = { mode: 'draft' as const, baseVersion: 1, brandProfileVersion: 1, answerIds: [], sourceVersionIds: [svId] };
    const before = await counts(contentId);
    await expect(runAssist(db, ownerA, contentId, input, leaky)).rejects.toMatchObject({ code: 'llm_failed' });
    expect((await counts(contentId)).versions).toBe(before.versions);
    expect((await counts(contentId)).claims).toBe(before.claims);
    const refsOnly: AssistLlm = {
      name: 'mock',
      mode: 'mock',
      async generate(i) {
        const out = await mock.generate(i);
        return { ...out, claims: [{ text: '시장이 컸다.', kind: 'fact', source_refs: [FAKE, svId], needs_user_confirmation: false }] } satisfies LlmStructuredOutput;
      },
    };
    const r = await runAssist(db, ownerA, contentId, input, refsOnly);
    const response = assistResponse(r, generationRunView(r.run));
    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, r.run.id));
    const [proposal] = await db.select().from(schema.contentVersions).where(eq(schema.contentVersions.id, r.proposal.id));
    const claimRows = await db.select().from(schema.claims).where(eq(schema.claims.runId, r.run.id));
    for (const [label, v] of [
      ['response', response],
      ['output_json', run!.outputJson],
      ['proposal', proposal!.body],
      ['claims', claimRows],
      ['result.output', r.output],
    ] as const) {
      expect(JSON.stringify(v), label).not.toContain('invented.example');
    }
    expect(response.claims[0]).toMatchObject({ source_refs: [svId], dropped_source_refs: 1, needs_check: true });
  });

  it('P1 user_confirmed 는 저장되지 않는다(DB CHECK) — 파생만', async () => {
    const [anyClaim] = await db.select().from(schema.claims).limit(1);
    const { id: _id, ...rest } = anyClaim!;
    void _id;
    let msg = '';
    try {
      await db.insert(schema.claims).values({ ...rest, claimIndex: 999, evidenceGrade: 'user_confirmed' });
    } catch (e) {
      const err = e as { message?: string; cause?: { message?: string } };
      msg = `${err.message ?? ''} ${err.cause?.message ?? ''}`;
    }
    expect(msg).toMatch(/claims_evidence_grade_chk/);
    // 같은 행을 'none' 으로는 넣을 수 있다(CHECK 만이 거부 이유)
    await db.insert(schema.claims).values({ ...rest, claimIndex: 999, evidenceGrade: 'none' });
  });

  it('P1 허용 출처 51개 이상: 기본 선택은 출처마다 최신 버전(≤50), 그 선택으로 요청 성공(폼 체크박스 포함)', async () => {
    const { contentId, svId } = await contentWithSource(ownerA, 'many-sv', 'https://example.com/many');
    const [first] = await db.select().from(schema.sourceVersions).where(eq(schema.sourceVersions.id, svId));
    for (let i = 0; i < 50; i++) {
      await db.insert(schema.sourceVersions).values({ sourceId: first!.sourceId, excerpt: `v${i}`, extractionState: 'fetched', fetchedAt: new Date(Date.UTC(2026, 8, 1, 0, i)) });
    }
    const w = await getWritingState(db, ownerA, contentId);
    expect(w.allowedSources.length).toBe(51);
    const pick = pickDefaultSources(w.allowedSources);
    expect(pick.selected.length).toBeLessThanOrEqual(50);
    expect(pick.selected).toHaveLength(1);
    expect(pick.excluded).toBe(50);
    // 전부 보내면 400(서버 상한 50 그대로), 기본 선택은 201
    expect((await assist(contentId, { mode: 'draft', base_version: 1, brand_profile_version: 1, source_version_ids: w.allowedSources.map((s) => s.id) })).status).toBe(400);
    expect((await assist(contentId, { mode: 'draft', base_version: 1, brand_profile_version: 1, source_version_ids: pick.selected.map((s) => s.id) })).status).toBe(201);
    const form = await assistPOST(
      new Request(`${BASE}/api/contents/${contentId}/assist`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', ...ORIGIN_HEADERS, ...cookieHeader(tokenA) },
        body: new URLSearchParams({ mode: 'outline', base_version: '1', brand_profile_version: '1', answer_ids: '', [`sv_${pick.selected[0]!.id}`]: 'on' }).toString(),
      }),
      ctx(contentId),
    );
    expect(form.status).toBe(303);
    expect(form.headers.get('location')).toMatch(/\?run=/);
    const [lastRun] = await db
      .select()
      .from(schema.generationRuns)
      .where(eq(schema.generationRuns.contentId, contentId))
      .orderBy(sql`${schema.generationRuns.createdAt} desc`)
      .limit(1);
    expect((lastRun!.inputVersionRefs as { source_version_ids: string[] }).source_version_ids).toEqual([pick.selected[0]!.id]);
  });
});

describe('FIX-T07 round 2(Codex review-FIX-T07)', () => {
  const PRICED = budgetPolicy(loadConfig({ LLM_PRICE_INPUT_PER_1K: '1', LLM_PRICE_OUTPUT_PER_1K: '2' }));
  const FAKE = 'https://fake-only-in-text.example/report';
  const mock = new MockLlmProvider();
  const citing: AssistLlm = {
    name: 'mock',
    mode: 'mock',
    generate: async (input) => ({
      ...(await mock.generate(input)),
      proposed_text: '보고서[1]에 따르면 시장이 컸다.',
      claims: [{ text: '시장이 컸다.', kind: 'fact', source_refs: ['[1]'], needs_user_confirmation: false }],
    }),
  };
  const urlOnlyInText: AssistLlm = {
    name: 'mock',
    mode: 'mock',
    generate: async (input) => {
      const out = await mock.generate(input);
      return { ...out, proposed_text: `${out.proposed_text} 자세히: ${FAKE}`, warnings: [...out.warnings, `확인: ${FAKE}`], claims: [] };
    },
  };

  async function freshOwner(identity: string) {
    const owner = (await ensureOwner(db, identity)).id;
    await db.insert(schema.brandProfiles).values({ ownerId: owner, version: 1, penName: 'p', audience: 'a', pillars: ['x'] });
    return owner;
  }
  const failCode = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return (e as AppError).code;
    }
  };

  it('P1 원고: [1] 인용(허용 출처 없음) → 502 경로(llm_failed), run failed·error=unverifiable_citation, 제안 없음, 본문 그대로', async () => {
    const { contentId } = await contentWithSource(ownerA, 'cite-1', 'https://example.com/cite1');
    const before = await counts(contentId);
    const body = (await db.select().from(schema.contents).where(eq(schema.contents.id, contentId)))[0]!.currentVersionId;
    expect(await failCode(runAssist(db, ownerA, contentId, { mode: 'draft', baseVersion: 1, brandProfileVersion: 1, answerIds: [] }, citing))).toBe('llm_failed');
    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.contentId, contentId));
    expect(run).toMatchObject({ status: 'failed', error: 'unverifiable_citation', outputRef: null });
    const after = await counts(contentId);
    expect(after.versions).toBe(before.versions);
    expect(after.claims).toBe(before.claims);
    expect((await db.select().from(schema.contents).where(eq(schema.contents.id, contentId)))[0]!.currentVersionId).toBe(body);
  });

  it('P1 원고(round 4): 가짜 URL 이 본문·경고에만 있고 source_refs 가 비어도 출력 전체 실패 — run failed, 제안 없음, 글 어디에도 저장 안 됨', async () => {
    const { contentId } = await contentWithSource(ownerA, 'cite-2', 'https://example.com/cite2');
    const before = await counts(contentId);
    expect(await failCode(runAssist(db, ownerA, contentId, { mode: 'draft', baseVersion: 1, brandProfileVersion: 1, answerIds: [] }, urlOnlyInText))).toBe('llm_failed');
    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.contentId, contentId));
    expect(run).toMatchObject({ status: 'failed', error: 'unverifiable_citation', outputRef: null, outputJson: null });
    expect((await counts(contentId)).versions).toBe(before.versions);
    const bodies = await db.select({ body: schema.contentVersions.body }).from(schema.contentVersions).where(eq(schema.contentVersions.contentId, contentId));
    expect(JSON.stringify(bodies)).not.toContain('fake-only-in-text');
  });

  it('P1 채널 초안: 같은 두 입력 — [1] 도 가짜 URL 도 실패(버전 없음)', async () => {
    const id = (await createContent(db, ownerA, { title: '채널 인용', body: '본문 한 줄.' })).content.id;
    expect(await failCode(runVariantAssist(db, ownerA, id, { channel: 'blog', baseVersion: 1 }, citing))).toBe('llm_failed');
    const [vr] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.contentId, id));
    expect(vr).toMatchObject({ status: 'failed', error: 'unverifiable_citation' });
    expect(await failCode(runVariantAssist(db, ownerA, id, { channel: 'blog', baseVersion: 1 }, urlOnlyInText))).toBe('llm_failed');
    const [variant] = await db.select().from(schema.variants).where(eq(schema.variants.contentId, id));
    expect((await db.select().from(schema.variantVersions).where(eq(schema.variantVersions.variantId, variant!.id))).length).toBe(0);
  });

  it('P2 합계: 행마다 600000000000.000000 인 원장 두 행의 합을 정확히 읽고, 예약 검사도 답한다(429)', async () => {
    const owner = await freshOwner('fix-t07-r2-sum@example.local');
    const { contentId } = await contentWithSource(owner, 'sum-1', 'https://example.com/sum1');
    await runAssist(db, owner, contentId, { mode: 'draft', baseVersion: 1, brandProfileVersion: 1, answerIds: [] }, new MockLlmProvider());
    await runAssist(db, owner, contentId, { mode: 'draft', baseVersion: 1, brandProfileVersion: 1, answerIds: [] }, new MockLlmProvider());
    await db.execute(sql`update usage_ledger set reserved_amount = 600000000000.000000, actual_amount = 600000000000.000000 where owner_id = ${owner}::uuid`);
    const u = (await monthlyUsage(db, owner)).byCurrency;
    expect(u).toMatchObject([{ currency: 'USD', used: '1200000000000.000000', runs: 2 }]);
    const policy: BudgetPolicy = { ...PRICED, monthlyLimitMicro: toMicro('999999999999') };
    expect(await failCode(runAssist(db, owner, contentId, { mode: 'draft', baseVersion: 1, brandProfileVersion: 1, answerIds: [], budget: policy }, new MockLlmProvider()))).toBe(
      'budget_exceeded',
    );
  });

  it('P2 월 상한: 다음 달 created_at 의 RUB 원장은 이번 달 USD 예약·사용량에 영향이 없다', async () => {
    const owner = await freshOwner('fix-t07-r2-window@example.local');
    const { contentId } = await contentWithSource(owner, 'win-1', 'https://example.com/win1');
    await runAssist(db, owner, contentId, { mode: 'draft', baseVersion: 1, brandProfileVersion: 1, answerIds: [] }, new MockLlmProvider());
    const next = mskNextMonthStart(new Date());
    await db.execute(sql`update usage_ledger set currency = 'RUB', created_at = ${next.toISOString()}::timestamptz + interval '1 hour' where owner_id = ${owner}::uuid`);
    expect((await monthlyUsage(db, owner)).byCurrency).toEqual([]);
    expect(await failCode(runAssist(db, owner, contentId, { mode: 'draft', baseVersion: 1, brandProfileVersion: 1, answerIds: [], budget: PRICED }, new MockLlmProvider()))).toBe('ok');
    expect((await monthlyUsage(db, owner)).byCurrency.map((c) => c.currency)).toEqual(['USD']);
    // 다음 달 시점으로 보면 RUB 가 있어 USD 예약은 거부된다(그 달에만)
    const nextMonthUsage = await monthlyUsage(db, owner, new Date(next.getTime() + 2 * 3600_000));
    expect(nextMonthUsage.byCurrency.map((c) => c.currency)).toEqual(['RUB']);
  });
});

describe('FIX-T07 round 4(Codex review-FIX3-T07): 구조화 인용만 — 원고·채널 경로 fail-closed', () => {
  const mock = new MockLlmProvider();
  const saying = (text: string, sourceRefs: string[] = []): AssistLlm => ({
    name: 'mock',
    mode: 'mock',
    generate: async (input) => ({
      ...(await mock.generate(input)),
      proposed_text: text,
      claims: [{ text: '시장이 컸다.', kind: 'opinion', source_refs: sourceRefs, needs_user_confirmation: false }],
    }),
  });
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'ok';
    } catch (e) {
      return (e as AppError).code;
    }
  };
  const BYPASSES = (svId: string) => [
    `근거 https://fake.example/${svId} 입니다`,
    'example.com?doc=x 참고',
    'example.com:8443/report 참고',
    'https://example.com/report(other)',
    '출처:fake.example',
    '//fake.example/report 참고',
    'fake．example 참고',
    'fabricated.example/report 참고',
    '[출처: https://example.com/r4-report]', // 허용 locator 라도 자유문 인용은 실패
    // FIX round 5(Codex review-FIX4-T07)
    '203.0.113.5/report 참고',
    'example.xn--p1ai/report 참고',
    'fake.example에 따르면 시장이 커졌다',
    'FAKE.md 참고',
    // FIX round 6(Codex review-FIX5-T07): 보이지 않는 서식 문자·영역 ID IPv6
    'fake\u200B.example/report',
    'fake.e\u00ADxample/report',
    'https:/\u200D/fake.example/report',
    '[fe80::1%25eth0]:8080/report',
    '[fe80::1%eth0]/x',
    // FIX round 7(Codex review-FIX6-T07): Cf 가 아닌 무시 가능 문자
    'fake.\uFE0Fexample/report',
    '보고서[\u034F99]', // 원고 경로는 허용 출처 10개 — 범위 밖 번호로(허용 0개인 [\u034F9] 는 아래 테스트)
  ];

  it('원고: 라운드 2–3 우회 문자열·버린 자유문 참조는 모두 실패(run failed·버전 없음·본문 그대로), [1]·[10]·오탐 예시는 통과', async () => {
    const { contentId, svId } = await contentWithSource(ownerA, 'r4-a', 'https://example.com/r4-report');
    const [sv] = await db.select().from(schema.sourceVersions).where(eq(schema.sourceVersions.id, svId));
    for (let i = 0; i < 9; i++) await db.insert(schema.sourceVersions).values({ sourceId: sv!.sourceId, excerpt: `v${i}`, extractionState: 'fetched' });
    const ids = (await db.select().from(schema.sourceVersions).where(eq(schema.sourceVersions.sourceId, sv!.sourceId))).map((x) => x.id);
    expect(ids).toHaveLength(10);
    const input = { mode: 'draft' as const, baseVersion: 1, brandProfileVersion: 1, answerIds: [], sourceVersionIds: ids };
    const current = async () => (await db.select().from(schema.contents).where(eq(schema.contents.id, contentId)))[0]!.currentVersionId;
    const body = await current();
    const before = await counts(contentId);
    const failing = [...BYPASSES(svId).map((t) => saying(t)), saying('가공연구소 2025 보고서에 따르면 시장이 컸다.', ['가공연구소 2025 보고서'])];
    for (const llm of failing) expect(await code(runAssist(db, ownerA, contentId, input, llm))).toBe('llm_failed');
    const runs = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.contentId, contentId));
    expect(runs).toHaveLength(failing.length);
    for (const r of runs) expect(r).toMatchObject({ status: 'failed', error: 'unverifiable_citation', outputRef: null });
    const after = await counts(contentId);
    expect({ versions: after.versions, claims: after.claims }).toEqual({ versions: before.versions, claims: before.claims });
    expect(after.runs - before.runs).toBe(failing.length); // 실패 run·원장은 남는다(T07 규칙)
    expect(await current()).toBe(body);

    const ok = await runAssist(db, ownerA, contentId, input, saying('보고서[1]와 [10], budget.ts, 3.14, owner@example.local — 해외 영업 메모.', [ids[0]!]));
    expect(ok.proposal.body).toBe('보고서[1]와 [10], budget.ts, 3.14, owner@example.local — 해외 영업 메모.');
    expect(await code(runAssist(db, ownerA, contentId, input, saying('보고서[11]')))).toBe('llm_failed');
  });

  it('채널 초안: 같은 우회 문자열은 모두 실패(버전 없음), 평범한 글은 통과', async () => {
    const id = (await createContent(db, ownerA, { title: 'r4 채널', body: '본문.' })).content.id;
    for (const t of BYPASSES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')) {
      expect(await code(runVariantAssist(db, ownerA, id, { channel: 'blog', baseVersion: 1 }, saying(t))), t).toBe('llm_failed');
    }
    expect(await code(runVariantAssist(db, ownerA, id, { channel: 'blog', baseVersion: 1 }, saying('가공연구소 2025 보고서 기준', ['가공연구소 2025 보고서'])))).toBe(
      'llm_failed',
    );
    const [variant] = await db.select().from(schema.variants).where(eq(schema.variants.contentId, id));
    if (variant) expect((await db.select().from(schema.variantVersions).where(eq(schema.variantVersions.variantId, variant.id))).length).toBe(0);
    const ok = await runVariantAssist(db, ownerA, id, { channel: 'blog', baseVersion: 1 }, saying('budget.ts 와 3.14 를 정리한 글입니다.'));
    expect(ok.proposal.body).toBe('budget.ts 와 3.14 를 정리한 글입니다.');
  });

  it('FIX round 7: 허용 출처가 없고 source_refs 도 비면 CGJ 를 끼운 [9] 는 원고·채널 모두 실패, 변형 선택자가 끼인 [1] 은 허용 1개면 통과', async () => {
    const { contentId, svId } = await contentWithSource(ownerA, 'r7-a', 'https://example.com/r7');
    const noSources = { mode: 'draft' as const, baseVersion: 1, brandProfileVersion: 1, answerIds: [] };
    expect(await code(runAssist(db, ownerA, contentId, noSources, saying('보고서[\u034F9]')))).toBe('llm_failed');
    expect(await code(runAssist(db, ownerA, contentId, noSources, saying('fake.\uFE0Fexample/report')))).toBe('llm_failed');
    const ok = await runAssist(db, ownerA, contentId, { ...noSources, sourceVersionIds: [svId] }, saying('보고서[\uFE0F1] — cafe\u0301 메모'));
    expect(ok.proposal.body).toBe('보고서[\uFE0F1] — cafe\u0301 메모');
    const id = (await createContent(db, ownerA, { title: 'r7 채널', body: '본문.' })).content.id;
    expect(await code(runVariantAssist(db, ownerA, id, { channel: 'blog', baseVersion: 1 }, saying('보고서[\u034F9]')))).toBe('llm_failed');
    expect(await code(runVariantAssist(db, ownerA, id, { channel: 'blog', baseVersion: 1 }, saying('fake.\uFE0Fexample/report')))).toBe('llm_failed');
  });

  it('모의 provider 의 기본 출력은 URL 모양 글이 없어 통과한다(출처가 있어도)', async () => {
    const { contentId, svId } = await contentWithSource(ownerA, 'r4-mock', 'https://example.com/r4-mock');
    const r = await runAssist(db, ownerA, contentId, { mode: 'draft', baseVersion: 1, brandProfileVersion: 1, answerIds: [], sourceVersionIds: [svId] }, new MockLlmProvider());
    expect(r.run.status).toBe('succeeded');
  });
});
