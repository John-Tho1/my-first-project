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
  getBrandProfileByVersion,
  getDb,
  listClaimsForRun,
  monthlyUsage,
  ownerScope,
  promptBrand,
  runAssist,
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
  reserveFor,
  RESTORED_TABLES,
  toMicro,
  type BudgetPolicy,
  type LlmStructuredOutput,
} from '@cs/domain';
import { LocalStorageAdapter, MockLlmProvider } from '@cs/providers';
import { GET as healthGET } from '../../apps/web/app/api/health/route';
import { POST as assistPOST } from '../../apps/web/app/api/contents/[id]/assist/route';
import { cookieHeader, jsonPost, login } from './helpers';

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
    expect(body.run.prompt_version).toBe('t07-assist-v2');
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
    const policy: BudgetPolicy = { ...base, monthlyLimitMicro: r.reserveMicro * 2 + Math.floor(r.reserveMicro / 2) };
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
    const u = await monthlyUsage(db, owner);
    expect(u.usedMicro).toBeLessThanOrEqual(policy.monthlyLimitMicro!);
    expect(u.pending).toBe(0);
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
      expect((await monthlyUsage(h.db, target)).usedMicro).toBe((await monthlyUsage(db, ownerA)).usedMicro);
    } finally {
      await h.close();
    }
  });
});
