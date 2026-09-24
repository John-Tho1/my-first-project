/**
 * T06 작성 지원(결정 D12): Brand Profile 버전(append·409·owner 범위), 인터뷰 답변(append·질문별 최신·불변),
 * assist(모의 제안 = 현재가 아닌 ai:mock 버전, 입력 버전 고정, stale 409, 실패 주입, live fail-closed),
 * 채택(새 사용자 버전·감사·재채택 409), A03(채택한 경험 claim 미확인 → ready 409 → 확인 후 허용),
 * owner 범위(다른 owner 의 원고·run·답변 404), export → 빈 DB 복원 왕복(새 표 포함).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, count, eq, sql } from 'drizzle-orm';
import {
  closeDb,
  commitRestore,
  createContent,
  createRestorePreview,
  createTestDb,
  ensureOwner,
  exportOwner,
  getDb,
  getWritingState,
  listUnconfirmedExperienceClaims,
  ownerScope,
  parseBundleZip,
  saveInterviewAnswers,
  schema,
  seed,
  selectBundleRows,
  type Db,
} from '@cs/db';
import { AppError, buildBundle, loadConfig, RESTORED_TABLES, writeZip, type BundleTables } from '@cs/domain';
import { LocalStorageAdapter, MOCK_WARNING } from '@cs/providers';
import { GET as brandGET, POST as brandPOST } from '../../apps/web/app/api/brand/route';
import { GET as answersGET, POST as answersPOST } from '../../apps/web/app/api/contents/[id]/answers/route';
import { POST as adoptPOST } from '../../apps/web/app/api/contents/[id]/assist/[runId]/adopt/route';
import { POST as assistPOST } from '../../apps/web/app/api/contents/[id]/assist/route';
import { POST as confirmPOST } from '../../apps/web/app/api/contents/[id]/claims/confirm/route';
import { PATCH as contentPATCH } from '../../apps/web/app/api/contents/[id]/route';
import { POST as versionsPOST } from '../../apps/web/app/api/contents/[id]/versions/route';
import { normalizeRunParam, selectRun } from '../../apps/web/lib/writing';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const A = 'owner@example.local';
const B = 'other-writer@example.local';

let db: Db;
let ownerA: string;
let ownerB: string;
let tokenA: string;
let tokenB: string;
let contentA: string;
let contentB: string;

const as = (identity: string) => vi.stubEnv('AUTH_ALLOWED_IDENTITY', identity);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const runCtx = (id: string, runId: string) => ({ params: Promise.resolve({ id, runId }) });

const brandPost = (body: unknown, token = tokenA) => brandPOST(jsonPost('/api/brand', body, cookieHeader(token)));
const answersPost = (id: string, body: unknown, token = tokenA) =>
  answersPOST(jsonPost(`/api/contents/${id}/answers`, body, cookieHeader(token)), ctx(id));
const assist = (id: string, body: unknown, token = tokenA) => assistPOST(jsonPost(`/api/contents/${id}/assist`, body, cookieHeader(token)), ctx(id));
const adopt = (id: string, runId: string, body: unknown, token = tokenA) =>
  adoptPOST(jsonPost(`/api/contents/${id}/assist/${runId}/adopt`, body, cookieHeader(token)), runCtx(id, runId));
const confirm = (id: string, body: unknown, token = tokenA) =>
  confirmPOST(jsonPost(`/api/contents/${id}/claims/confirm`, body, cookieHeader(token)), ctx(id));

async function setLifecycle(id: string, lifecycle: string, token = tokenA) {
  const [row] = await db.select().from(schema.contents).where(eq(schema.contents.id, id));
  return contentPATCH(
    new Request(`${BASE}/api/contents/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...ORIGIN_HEADERS, ...cookieHeader(token) },
      body: JSON.stringify({ expected_revision: row!.revision, lifecycle }),
    }),
    ctx(id),
  );
}

const runCount = async (contentId: string) =>
  (await db.select({ n: count() }).from(schema.generationRuns).where(eq(schema.generationRuns.contentId, contentId)))[0]!.n;
const versionCount = async (contentId: string) =>
  (await db.select({ n: count() }).from(schema.contentVersions).where(eq(schema.contentVersions.contentId, contentId)))[0]!.n;
const contentRow = async (id: string) => (await db.select().from(schema.contents).where(eq(schema.contents.id, id)))[0]!;
const currentBody = async (id: string) => {
  const c = await contentRow(id);
  return (await db.select().from(schema.contentVersions).where(eq(schema.contentVersions.id, c.currentVersionId!)))[0]!;
};

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

beforeAll(async () => {
  db = (await getDb(loadConfig())).db;
  ownerA = (await seed(db, { allowedIdentity: A })).ownerId;
  ownerB = (await seed(db, { allowedIdentity: B })).ownerId;
  contentA = (await createContent(db, ownerA, { title: 'T06 가상 원고', body: '첫 문단입니다.\n둘째 문단입니다.' })).content.id;
  contentB = (await createContent(db, ownerB, { title: 'B 의 원고', body: 'B 본문' })).content.id;
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

describe('Brand Profile 버전', () => {
  it('GET: seed v1 이 현재. POST base_version=1 → v2 추가, v1 은 그대로, 감사 기록', async () => {
    const g = await (await brandGET(new Request(`${BASE}/api/brand`, { headers: cookieHeader(tokenA) }), undefined)).json();
    expect(g.current.version).toBe(1);
    expect(g.current).toMatchObject({ tone: 'formal', avoid_phrases: [], cta_rules: [], sample_texts: [] });
    const v1Before = (await db.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.ownerId, ownerA)))[0]!;

    const res = await brandPost({
      base_version: 1,
      pen_name: '가상 필명',
      audience: '해외영업 실무자',
      pillars: ['해외영업', 'AI 활용', '주재원'],
      style_rules: ['짧은 문장'],
      tone: 'casual',
      avoid_phrases: ['혁신적인'],
      cta_rules: ['질문으로 끝내기'],
      sample_texts: ['내가 직접 쓴 가상 예문.'],
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.brand_profile).toMatchObject({ version: 2, tone: 'casual', avoid_phrases: ['혁신적인'], sample_texts: ['내가 직접 쓴 가상 예문.'] });
    const v1After = (await db.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.id, v1Before.id)))[0]!;
    expect(v1After).toEqual(v1Before);
    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.ownerId, ownerA), eq(schema.auditEvents.action, 'brand.version_create')));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.sanitizedDetails)).not.toContain('가상 예문');
  });

  it('오래된 base_version → 409 { current, yours }, 행 추가 없음', async () => {
    const res = await brandPost({ base_version: 1, pen_name: 'x', audience: 'y', pillars: ['z'] });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('conflict');
    expect(body.current.version).toBe(2);
    expect(body.yours.base_version).toBe(1);
    const n = (await db.select({ n: count() }).from(schema.brandProfiles).where(eq(schema.brandProfiles.ownerId, ownerA)))[0]!.n;
    expect(n).toBe(2);
  });

  it('다른 owner 는 A 의 버전을 보지 못하고, B 의 저장은 B 의 버전 번호만 올린다', async () => {
    as(B);
    const g = await (await brandGET(new Request(`${BASE}/api/brand`, { headers: cookieHeader(tokenB) }), undefined)).json();
    expect(g.versions.map((v: { version: number }) => v.version)).toEqual([1]);
    const aIds = (await db.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.ownerId, ownerA))).map((r) => r.id);
    expect(g.versions.some((v: { id: string }) => aIds.includes(v.id))).toBe(false);
    const res = await brandPost({ base_version: 1, pen_name: 'b', audience: 'b', pillars: ['b'] }, tokenB);
    expect(res.status).toBe(201);
    expect((await res.json()).brand_profile.version).toBe(2);
  });

  it('로그인 없음 → 401, Origin 없음 → 403', async () => {
    expect((await brandPOST(jsonPost('/api/brand', { base_version: 2, pen_name: 'x', audience: 'y', pillars: ['z'] }))).status).toBe(401);
    const noOrigin = await brandPOST(
      new Request(`${BASE}/api/brand`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...cookieHeader(tokenA) },
        body: '{}',
      }),
    );
    expect(noOrigin.status).toBe(403);
  });
});

describe('인터뷰 답변', () => {
  it('append + 질문별 최신 + 바뀌지 않은 답은 새 행을 만들지 않음', async () => {
    const r1 = await answersPost(contentA, {
      answers: { situation: '분기 회의 직후 대리점과 통화한 상황', judgment: '제가 먼저 가격 조건을 제안했습니다.' },
    });
    expect(r1.status).toBe(201);
    expect((await r1.json()).inserted).toHaveLength(2);
    const r2 = await answersPost(contentA, {
      answers: { situation: '분기 회의 직후 대리점 두 곳과 통화한 상황', judgment: '제가 먼저 가격 조건을 제안했습니다.', takeaway: '  ' },
    });
    expect((await r2.json()).inserted).toHaveLength(1);
    const g = await (await answersGET(new Request(`${BASE}/api/contents/${contentA}/answers`, { headers: cookieHeader(tokenA) }), ctx(contentA))).json();
    expect(g.questions).toHaveLength(3);
    expect(g.history).toHaveLength(3);
    expect(g.current.map((a: { question_key: string }) => a.question_key)).toEqual(['situation', 'judgment']);
    expect(g.current[0].answer).toBe('분기 회의 직후 대리점 두 곳과 통화한 상황');
    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.ownerId, ownerA), eq(schema.auditEvents.action, 'interview.answer')));
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit.map((x) => x.sanitizedDetails))).not.toContain('대리점');
  });

  it('다른 owner 의 원고 → 404(읽기·쓰기), 모르는 키 → 400', async () => {
    as(B);
    expect((await answersPost(contentA, { answers: { situation: '침입' } }, tokenB)).status).toBe(404);
    expect(
      (await answersGET(new Request(`${BASE}/api/contents/${contentA}/answers`, { headers: cookieHeader(tokenB) }), ctx(contentA))).status,
    ).toBe(404);
    as(A);
    expect((await answersPost(contentA, { answers: { extra: 'x' } })).status).toBe(400);
  });

  it('interview_answers 행은 UPDATE·DELETE 할 수 없다(트리거)', async () => {
    expect(await pgError(db.execute(sql`update interview_answers set answer = 'x'`))).toMatch(/append_only_immutable/);
    expect(await pgError(db.execute(sql`delete from interview_answers`))).toMatch(/append_only_immutable/);
  });
});

describe('assist(모의) · 채택 · A03', () => {
  let answerIds: string[];
  let runId: string;
  let proposalBody: string;

  beforeAll(async () => {
    const rows = await db.select().from(schema.interviewAnswers).where(eq(schema.interviewAnswers.contentId, contentA));
    // 질문별 최신만
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!latest.has(r.questionKey) || latest.get(r.questionKey)!.createdAt < r.createdAt) latest.set(r.questionKey, r);
    answerIds = [...latest.values()].map((r) => r.id);
  });

  it('outline → 201: run succeeded, 제안 = 현재가 아닌 ai:mock 버전(ai_run_id), current_version_id 그대로, MOCK_WARNING', async () => {
    const before = await contentRow(contentA);
    const res = await assist(contentA, { mode: 'outline', base_version: 1, brand_profile_version: 2, answer_ids: answerIds });
    expect(res.status).toBe(201);
    const body = await res.json();
    runId = body.run.id;
    expect(body.run).toMatchObject({ status: 'succeeded', mode: 'outline', provider: 'mock', model: 'mock', prompt_version: 't06-assist-v1' });
    expect(body.run.input_version_refs).toMatchObject({
      content_version: 1,
      content_version_id: before.currentVersionId,
      brand_profile_version: 2,
      answer_ids: [...answerIds].sort(),
    });
    expect(body.mock_warning).toBe(MOCK_WARNING);
    expect(body.warnings).toContain(MOCK_WARNING);
    expect(body.proposal_version).toMatchObject({ version: 2, created_by: 'ai:mock' });
    expect(body.diff.stats.added).toBeGreaterThan(0);
    expect(body.claims.some((c: { kind: string; needs_user_confirmation: boolean }) => c.kind === 'experience' && c.needs_user_confirmation)).toBe(true);
    proposalBody = body.proposal_version.body;

    const after = await contentRow(contentA);
    expect(after.currentVersionId).toBe(before.currentVersionId);
    expect(after.revision).toBe(before.revision);
    const [pv] = await db.select().from(schema.contentVersions).where(eq(schema.contentVersions.id, body.proposal_version.id));
    expect(pv).toMatchObject({ createdBy: 'ai:mock', aiRunId: runId, version: 2 });
    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, runId));
    expect(run).toMatchObject({ ownerId: ownerA, status: 'succeeded', outputRef: pv!.id, inputVersionId: before.currentVersionId });
    expect(run!.finishedAt).not.toBeNull();
    expect((run!.outputJson as { warnings: string[] }).warnings).toContain(MOCK_WARNING);
  });

  it('제안이 있어도 사용자 본문 저장은 현재 버전 기준으로 동작하고 번호는 최대+1(버전 3)', async () => {
    // contentA 의 버전 번호를 바꾸지 않도록 다른 원고에서 확인한다
    const other = (await createContent(db, ownerA, { title: '번호 확인', body: '원문' })).content.id;
    const r = await assist(other, { mode: 'draft', base_version: 1, brand_profile_version: 2, answer_ids: [] });
    expect(r.status).toBe(201);
    const save = await versionsPOST(jsonPost(`/api/contents/${other}/versions`, { base_version: 1, body: '사용자 수정' }, cookieHeader(tokenA)), ctx(other));
    expect(save.status).toBe(201);
    expect((await save.json()).version.version).toBe(3);
  });

  it('base_version 이 현재가 아님 → 409 stale_base, run·버전 추가 없음', async () => {
    const runs = await runCount(contentA);
    const versions = await versionCount(contentA);
    const res = await assist(contentA, { mode: 'draft', base_version: 2, brand_profile_version: 2, answer_ids: answerIds });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'stale_base', current: { version: 1 }, yours: { base_version: 2 } });
    expect(await runCount(contentA)).toBe(runs);
    expect(await versionCount(contentA)).toBe(versions);
  });

  it('없는 브랜드 버전 → 400, 다른 원고의 답변 → 404, 다른 owner 의 원고 → 404 — 모두 run 없음', async () => {
    const runs = await runCount(contentA);
    expect((await assist(contentA, { mode: 'draft', base_version: 1, brand_profile_version: 99, answer_ids: [] })).status).toBe(400);
    as(B);
    const bAns = await answersPOST(jsonPost(`/api/contents/${contentB}/answers`, { answers: { situation: 'B 의 답' } }, cookieHeader(tokenB)), ctx(contentB));
    const bAnswerId = (await bAns.json()).current[0].id as string;
    as(A);
    expect((await assist(contentA, { mode: 'draft', base_version: 1, brand_profile_version: 2, answer_ids: [bAnswerId] })).status).toBe(404);
    expect((await assist(contentA, { mode: 'draft', base_version: 1, brand_profile_version: 2, answer_ids: ['not-a-uuid'] })).status).toBe(400);
    as(B);
    expect((await assist(contentA, { mode: 'draft', base_version: 1, brand_profile_version: 1, answer_ids: [] }, tokenB)).status).toBe(404);
    as(A);
    expect(await runCount(contentA)).toBe(runs);
  });

  it('실패 주입 → 502 llm_failed: run failed, 버전 없음, 본문 그대로', async () => {
    const versions = await versionCount(contentA);
    const bodyBefore = await currentBody(contentA);
    vi.stubEnv('LLM_MOCK_FAIL_NEXT', '1');
    try {
      const res = await assist(contentA, { mode: 'revise', base_version: 1, brand_profile_version: 2, answer_ids: answerIds });
      expect(res.status).toBe(502);
      expect((await res.json()).error).toBe('llm_failed');
    } finally {
      vi.stubEnv('LLM_MOCK_FAIL_NEXT', '');
    }
    const failed = await db
      .select()
      .from(schema.generationRuns)
      .where(and(eq(schema.generationRuns.contentId, contentA), eq(schema.generationRuns.status, 'failed')));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ outputRef: null, error: 'mock_injected_failure' });
    expect(await versionCount(contentA)).toBe(versions);
    expect(await currentBody(contentA)).toEqual(bodyBefore);
  });

  it('LLM_MODE=live(설정 없음·있음) → 503 fail-closed, run 행 없음', async () => {
    const runs = await runCount(contentA);
    vi.stubEnv('LLM_MODE', 'live');
    try {
      const r1 = await assist(contentA, { mode: 'draft', base_version: 1, brand_profile_version: 2, answer_ids: [] });
      expect(r1.status).toBe(503);
      expect((await r1.json()).error).toBe('live_llm_not_allowed');
      vi.stubEnv('LLM_PROVIDER', 'placeholder');
      vi.stubEnv('LLM_MODEL', 'placeholder');
      const r2 = await assist(contentA, { mode: 'draft', base_version: 1, brand_profile_version: 2, answer_ids: [] });
      expect(r2.status).toBe(503);
      expect((await r2.json()).error).toBe('live_provider_not_configured');
    } finally {
      vi.stubEnv('LLM_MODE', 'mock');
      vi.stubEnv('LLM_PROVIDER', '');
      vi.stubEnv('LLM_MODEL', '');
    }
    expect(await runCount(contentA)).toBe(runs);
  });

  it('A03: 채택하지 않은 제안의 경험 claim 은 게이트에 걸리지 않는다', async () => {
    expect(await listUnconfirmedExperienceClaims(db, ownerA, contentA)).toEqual([]);
  });

  it('채택: 다른 owner → 404, 오래된 base → 409, 정상 → 새 사용자 버전 현재·감사, 다시 채택 → 409', async () => {
    as(B);
    expect((await adopt(contentA, runId, { base_version: 1 }, tokenB)).status).toBe(404);
    as(A);
    expect((await adopt(contentA, runId, { base_version: 2 })).status).toBe(409);
    const res = await adopt(contentA, runId, { base_version: 1 });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.version).toMatchObject({ version: 3, created_by: 'owner', ai_run_id: runId, body: proposalBody });
    expect(body.content.current_version_id).toBe(body.version.id);
    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.ownerId, ownerA), eq(schema.auditEvents.action, 'content.adopt_ai')));
    expect(audit).toHaveLength(1);
    const again = await adopt(contentA, runId, { base_version: 3 });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe('stale_base');
  });

  it('A03: 채택한 제안의 미확인 경험 claim → ready 409, 다른 owner 확인 404, 의견 claim 확인 400, 확인 후 ready 200', async () => {
    expect((await setLifecycle(contentA, 'review')).status).toBe(200);
    const blocked = await setLifecycle(contentA, 'ready');
    expect(blocked.status).toBe(409);
    const b = await blocked.json();
    expect(b.error).toBe('unconfirmed_experience_claims');
    expect(b.claims.length).toBeGreaterThan(0);
    expect(b.claims[0].text).toContain('제가');
    expect((await contentRow(contentA)).lifecycle).toBe('review');

    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, runId));
    const claims = (run!.outputJson as { claims: Array<{ kind: string }> }).claims;
    const expIdx = claims.map((c, i) => (c.kind === 'experience' ? i : -1)).filter((i) => i >= 0);
    const opIdx = claims.findIndex((c) => c.kind !== 'experience');

    as(B);
    expect((await confirm(contentA, { run_id: runId, claim_indexes: expIdx }, tokenB)).status).toBe(404);
    as(A);
    if (opIdx >= 0) expect((await confirm(contentA, { run_id: runId, claim_indexes: [opIdx] })).status).toBe(400);
    expect((await confirm(contentA, { run_id: runId, claim_indexes: [99] })).status).toBe(400);

    const ok = await confirm(contentA, { run_id: runId, claim_indexes: expIdx });
    expect(ok.status).toBe(200);
    expect((await ok.json()).unconfirmed).toEqual([]);
    // 같은 확인을 다시 보내도 행이 늘지 않는다
    await confirm(contentA, { run_id: runId, claim_indexes: expIdx });
    const rows = await db.select().from(schema.claimConfirmations).where(eq(schema.claimConfirmations.runId, runId));
    expect(rows).toHaveLength(expIdx.length);
    expect(rows.every((r) => r.ownerId === ownerA)).toBe(true);
    expect(await pgError(db.execute(sql`delete from claim_confirmations`))).toMatch(/append_only_immutable/);

    expect((await setLifecycle(contentA, 'ready')).status).toBe(200);
    expect((await contentRow(contentA)).lifecycle).toBe('ready');
  });

  it('A03 우회 방지: 이미 ready 인 원고에 미확인 경험 claim 제안 채택 → 409(버전·현재 그대로), 확인 후 채택 가능', async () => {
    const id = (await createContent(db, ownerA, { title: '준비된 원고', body: '이미 준비된 본문' })).content.id;
    expect((await setLifecycle(id, 'review')).status).toBe(200);
    expect((await setLifecycle(id, 'ready')).status).toBe(200);
    const ans = await (await answersPost(id, { answers: { judgment: '저는 현장에서 직접 계약을 마무리했습니다.' } })).json();
    const r = await (await assist(id, { mode: 'draft', base_version: 1, brand_profile_version: 2, answer_ids: [ans.current[0].id] })).json();
    const before = await contentRow(id);
    const versions = await versionCount(id);
    const blocked = await adopt(id, r.run.id, { base_version: 1 });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toBe('unconfirmed_experience_claims');
    expect(await versionCount(id)).toBe(versions);
    expect((await contentRow(id)).currentVersionId).toBe(before.currentVersionId);
    const expIdx = (r.claims as Array<{ kind: string }>).map((c, i) => (c.kind === 'experience' ? i : -1)).filter((i) => i >= 0);
    expect(expIdx.length).toBeGreaterThan(0);
    expect((await confirm(id, { run_id: r.run.id, claim_indexes: expIdx })).status).toBe(200);
    expect((await adopt(id, r.run.id, { base_version: 1 })).status).toBe(201);
    expect((await contentRow(id)).lifecycle).toBe('ready');
  });

  it('폼 경로: assist 303 → ?run=, 오래된 base → ?error=stale', async () => {
    const other = (await createContent(db, ownerA, { title: '폼 원고', body: '폼 본문' })).content.id;
    const form = (fields: Record<string, string>) =>
      assistPOST(
        new Request(`${BASE}/api/contents/${other}/assist`, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'text/html',
            ...ORIGIN_HEADERS,
            ...cookieHeader(tokenA),
          },
          body: new URLSearchParams(fields).toString(),
        }),
        ctx(other),
      );
    const ok = await form({ mode: 'outline', base_version: '1', brand_profile_version: '2', answer_ids: '' });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toMatch(new RegExp(`^/contents/${other}\\?run=[0-9a-f-]{36}#assist$`));
    const stale = await form({ mode: 'outline', base_version: '5', brand_profile_version: '2', answer_ids: '' });
    expect(stale.status).toBe(303);
    expect(stale.headers.get('location')).toBe(`/contents/${other}?error=stale`);
  });
});

describe('export → 빈 DB 복원: 새 표 왕복', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'cs-t06-it-'));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('interview_answers·generation_runs·claim_confirmations·브랜드 새 열이 ID·값 그대로, A03 상태도 같다', async () => {
    const storage = new LocalStorageAdapter(path.join(tmp, 'assets'));
    const exported = await exportOwner(db, storage, ownerA, { outDir: path.join(tmp, 'exports') });
    expect(exported.manifest.tables.interview_answers!.rows).toBeGreaterThanOrEqual(3);
    expect(exported.manifest.tables.generation_runs!.rows).toBeGreaterThanOrEqual(3);
    expect(exported.manifest.tables.claim_confirmations!.rows).toBeGreaterThanOrEqual(1);
    const zip = new Uint8Array(readFileSync(exported.zipPath));

    const h = await createTestDb();
    try {
      const dbB = h.db;
      const target = (await ensureOwner(dbB, 'restore-t06@example.local')).id;
      const p = await createRestorePreview(dbB, target, zip, { restoresDir: path.join(tmp, 'restores'), source: 'upload' });
      expect(p.preview.conflicts_total).toBe(0);
      const r = await commitRestore(dbB, new LocalStorageAdapter(path.join(tmp, 'assets-b')), target, p.restoreId, {
        mode: 'empty_only',
        confirm: true,
        restoresDir: path.join(tmp, 'restores'),
      });
      expect(r.conflicts_total).toBe(0);
      for (const t of RESTORED_TABLES) {
        const a = (await selectBundleRows(db, t, ownerScope(t, ownerA))).map((x) => x.row);
        const b = (await selectBundleRows(dbB, t, ownerScope(t, target))).map((x) => x.row);
        expect(b, t).toEqual(a);
      }
      const brandB = await dbB.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.ownerId, target));
      expect(brandB.find((x) => x.version === 2)).toMatchObject({ tone: 'casual', avoidPhrases: ['혁신적인'] });
      const runsB = await dbB.select().from(schema.generationRuns);
      expect(runsB.every((x) => x.ownerId === target)).toBe(true);
      expect(await listUnconfirmedExperienceClaims(dbB, target, contentA)).toEqual(await listUnconfirmedExperienceClaims(db, ownerA, contentA));
    } finally {
      await h.close();
    }
  });
});

describe('FIX-T06(Codex review-T06)', () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'cs-t06-fix-'));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  /** 새 원고 + 경험 답변 + assist + 채택. 채택한 run 을 돌려준다. */
  async function adoptedWithExperience(title: string) {
    const id = (await createContent(db, ownerA, { title, body: '원문' })).content.id;
    const ans = await (await answersPost(id, { answers: { judgment: '제가 직접 현지 법인을 설득했습니다.' } })).json();
    const r = await (await assist(id, { mode: 'draft', base_version: 1, brand_profile_version: 2, answer_ids: [ans.current[0].id] })).json();
    expect((await adopt(id, r.run.id, { base_version: 1 })).status).toBe(201);
    const expIdx = (r.claims as Array<{ kind: string }>).map((c, i) => (c.kind === 'experience' ? i : -1)).filter((i) => i >= 0);
    expect(expIdx.length).toBeGreaterThan(0);
    return { id, runId: r.run.id as string, expIdx };
  }

  it('P1 claims-gate: 거짓 경험 문장을 뺐다고 표시(resolution=removed)하면 ready 가능, 감사에 resolution 기록', async () => {
    const { id, runId, expIdx } = await adoptedWithExperience('제외 표시 원고');
    const cur = await currentBody(id);
    const saved = await versionsPOST(
      jsonPost(`/api/contents/${id}/versions`, { base_version: cur.version, body: '경험 문장을 뺀 본문' }, cookieHeader(tokenA)),
      ctx(id),
    );
    expect(saved.status).toBe(201);
    expect((await setLifecycle(id, 'review')).status).toBe(200);
    expect((await setLifecycle(id, 'ready')).status).toBe(409);
    expect((await confirm(id, { run_id: runId, claim_indexes: expIdx, resolution: 'bogus' })).status).toBe(400);
    const res = await confirm(id, { run_id: runId, claim_indexes: expIdx, resolution: 'removed' });
    expect(res.status).toBe(200);
    expect((await res.json()).unconfirmed).toEqual([]);
    const rows = await db.select().from(schema.claimConfirmations).where(eq(schema.claimConfirmations.runId, runId));
    expect(rows.map((r) => r.resolution)).toEqual(expIdx.map(() => 'removed'));
    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.action, 'content.claim_confirm'), eq(schema.auditEvents.versionOrHash, runId)));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.sanitizedDetails).toMatchObject({ resolution: 'removed', count: expIdx.length });
    expect((await setLifecycle(id, 'ready')).status).toBe(200);
  });

  it('P1 최근 10개 밖: 미해결 경험 claim 이 있는 run 은 11개 실행 뒤에도 목록에 있고, URL run 은 직접 조회된다', async () => {
    const { id, runId } = await adoptedWithExperience('실행 많은 원고');
    const base = (await currentBody(id)).version;
    for (let i = 0; i < 11; i++) {
      expect((await assist(id, { mode: 'outline', base_version: base, brand_profile_version: 2, answer_ids: [] })).status).toBe(201);
    }
    const all = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.contentId, id));
    expect(all).toHaveLength(12);
    const w = await getWritingState(db, ownerA, id);
    expect(w.runs.map((r) => r.id)).toContain(runId);
    expect(w.runs).toHaveLength(11); // 최근 10 + 미해결 1
    expect(w.unconfirmed.length).toBeGreaterThan(0);
    expect(w.unconfirmed.every((u) => u.run_id === runId)).toBe(true);
    // 미해결이 없는 오래된 run 도 URL 로 지정하면 조회된다(owner·원고 범위)
    const others = all.filter((r) => r.id !== runId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const oldest = others[0]!;
    expect(w.runs.map((r) => r.id)).not.toContain(oldest.id);
    expect((await getWritingState(db, ownerA, id, oldest.id)).runs.map((r) => r.id)).toContain(oldest.id);
    // 다른 원고·다른 owner 로는 그 run 이 들어오지 않는다
    expect((await getWritingState(db, ownerA, contentA, oldest.id)).runs.map((r) => r.id)).not.toContain(oldest.id);
    expect((await getWritingState(db, ownerB, id, runId)).runs).toEqual([]);
  });

  it('P2 답변 seq: 같은 시각에 저장해도 나중 저장이 최신', async () => {
    const id = (await createContent(db, ownerA, { title: '같은 시각 답변', body: '원문' })).content.id;
    const at = new Date('2026-09-24T10:00:00.000Z');
    await saveInterviewAnswers(db, ownerA, id, { answers: { situation: '첫 답' } }, at);
    await saveInterviewAnswers(db, ownerA, id, { answers: { situation: '둘째 답' } }, at);
    await saveInterviewAnswers(db, ownerA, id, { answers: { situation: '셋째 답' } }, at);
    const g = await (await answersGET(new Request(`${BASE}/api/contents/${id}/answers`, { headers: cookieHeader(tokenA) }), ctx(id))).json();
    expect(g.current[0]).toMatchObject({ answer: '셋째 답', seq: 3 });
    expect(g.history.map((h: { seq: number }) => h.seq)).toEqual([3, 2, 1]);
  });

  it('P2 브랜드 동시 저장: 409 본문의 current 는 방금 저장된 최신 버전', async () => {
    const rows = await db.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.ownerId, ownerA));
    const cur = rows.reduce((m, r) => Math.max(m, r.version), 0);
    const body = { base_version: cur, pen_name: '동시', audience: 'a', pillars: ['x'] };
    const [r1, r2] = await Promise.all([brandPost(body), brandPost(body)]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    const conflict = await (r1.status === 409 ? r1 : r2).json();
    expect(conflict.current.version).toBe(cur + 1);
  });

  it('P0 복원: 채택 버전의 run 이 복원되지 않으면(내용이 다른 기존 run) 복원 전체 중단, DB 그대로', async () => {
    const { runId } = await adoptedWithExperience('복원 순환 원고');
    const storage = new LocalStorageAdapter(path.join(tmp, 'assets'));
    const exported = await exportOwner(db, storage, ownerA, { outDir: path.join(tmp, 'exports') });
    const zip = new Uint8Array(readFileSync(exported.zipPath));
    const h = await createTestDb();
    try {
      const dbC = h.db;
      const target = (await ensureOwner(dbC, 'restore-fix@example.local')).id;
      const restoresDir = path.join(tmp, 'restores');
      const first = await createRestorePreview(dbC, target, zip, { restoresDir, source: 'upload' });
      await commitRestore(dbC, new LocalStorageAdapter(path.join(tmp, 'assets-c')), target, first.restoreId, {
        mode: 'empty_only',
        confirm: true,
        restoresDir,
      });

      // 묶음 쪽: 그 run 의 내용이 달라지고(기존 행과 different), 그 run 을 가리키는 새 채택 버전이 추가됨
      const parsed = await parseBundleZip(zip);
      const t = structuredClone(parsed.tables) as BundleTables;
      t.generation_runs.find((r) => r.id === runId)!.error = '변조';
      const adoptedV = t.content_versions.find((v) => v.ai_run_id === runId && v.created_by === 'owner')!;
      const newV = { ...adoptedV, id: '99999999-9999-4999-8999-999999999999', version: 999 };
      t.content_versions.push(newV);
      const modified = writeZip(
        buildBundle({
          exportId: '88888888-8888-4888-8888-888888888888',
          exportedAt: new Date().toISOString(),
          appVersion: parsed.manifest.app_version,
          migrations: parsed.manifest.schema_migrations,
          owner: { id: parsed.manifest.owner.id, identityMasked: parsed.manifest.owner.identity_masked },
          tables: t,
          assetBytes: new Map(parsed.assetBytes),
        }).entries,
      );
      let err: unknown;
      try {
        await createRestorePreview(dbC, target, modified, { restoresDir, source: 'upload' });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('restore_conflict');
      expect((err as AppError).extra).toEqual({ conflicts: [{ table: 'content_versions', id: newV.id, reason: 'dependency' }] });
      expect(await dbC.select().from(schema.contentVersions).where(eq(schema.contentVersions.id, newV.id))).toEqual([]);
    } finally {
      await h.close();
    }
  });
});

describe('FIX-T06 round 2(Codex review-FIX-T06)', () => {
  async function adopted(title: string) {
    const id = (await createContent(db, ownerA, { title, body: '원문' })).content.id;
    const ans = await (await answersPost(id, { answers: { judgment: '제가 직접 현지 법인을 설득했습니다.' } })).json();
    const r = await (await assist(id, { mode: 'draft', base_version: 1, brand_profile_version: 2, answer_ids: [ans.current[0].id] })).json();
    expect((await adopt(id, r.run.id, { base_version: 1 })).status).toBe(201);
    const claims = r.claims as Array<{ kind: string; text: string }>;
    const expIdx = claims.map((c, i) => (c.kind === 'experience' ? i : -1)).filter((i) => i >= 0);
    expect(expIdx.length).toBeGreaterThan(0);
    return { id, runId: r.run.id as string, expIdx, claimText: claims[expIdx[0]!]!.text };
  }
  const saveBody = async (id: string, body: string) => {
    const cur = await currentBody(id);
    const res = await versionsPOST(jsonPost(`/api/contents/${id}/versions`, { base_version: cur.version, body }, cookieHeader(tokenA)), ctx(id));
    expect(res.status).toBe(201);
  };
  const rowsFor = (runId: string) => db.select().from(schema.claimConfirmations).where(eq(schema.claimConfirmations.runId, runId));

  it('P1: 문장이 본문에 남아 있으면 removed → 409 claim_still_in_body, 행 없음', async () => {
    const { id, runId, expIdx, claimText } = await adopted('제외 거부 원고');
    expect((await currentBody(id)).body).toContain(claimText);
    const res = await confirm(id, { run_id: runId, claim_indexes: expIdx, resolution: 'removed' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'claim_still_in_body', claim_indexes: expIdx });
    expect(await rowsFor(runId)).toEqual([]);
    // 공백·문장부호만 바꿔 둔 경우도 "남아 있음"
    await saveBody(id, `앞 문장. ${claimText.replace(/\s+/g, '   ').replace(/\.$/, '!')} 뒤 문장`);
    expect((await confirm(id, { run_id: runId, claim_indexes: expIdx, resolution: 'removed' })).status).toBe(409);
    expect(await rowsFor(runId)).toEqual([]);
  });

  it('P1: 뺀 뒤 removed → body_version_id 기록·ready 가능, 문장을 다시 넣으면 ready 다시 차단, 확인하면 다시 가능', async () => {
    const { id, runId, expIdx, claimText } = await adopted('재삽입 원고');
    await saveBody(id, '경험 문장을 뺀 본문');
    const cur = await currentBody(id);
    expect((await confirm(id, { run_id: runId, claim_indexes: expIdx, resolution: 'removed' })).status).toBe(200);
    const rows = await rowsFor(runId);
    expect(rows.every((r) => r.resolution === 'removed' && r.bodyVersionId === cur.id)).toBe(true);
    expect((await setLifecycle(id, 'review')).status).toBe(200);
    expect((await setLifecycle(id, 'ready')).status).toBe(200);
    // 준비됨에서 되돌린 뒤 같은 문장을 다시 넣으면 다시 미해결
    expect((await setLifecycle(id, 'review')).status).toBe(200);
    await saveBody(id, `경험 문장을 뺀 본문\n${claimText}`);
    const unresolved = await listUnconfirmedExperienceClaims(db, ownerA, id);
    expect(unresolved.map((u) => u.claim_index).sort()).toEqual([...expIdx].sort());
    const blocked = await setLifecycle(id, 'ready');
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toBe('unconfirmed_experience_claims');
    // 이번에는 실제 경험이라고 확인 → 확인 행이 따로 추가되고 ready 가능
    expect((await confirm(id, { run_id: runId, claim_indexes: expIdx, resolution: 'confirmed' })).status).toBe(200);
    expect((await rowsFor(runId)).map((r) => r.resolution).sort()).toEqual([...expIdx.map(() => 'confirmed'), ...expIdx.map(() => 'removed')].sort());
    expect((await setLifecycle(id, 'ready')).status).toBe(200);
  });

  it('P1: confirmed 는 본문 변경과 무관하게 해결 상태 유지', async () => {
    const { id, runId, expIdx, claimText } = await adopted('확인 유지 원고');
    expect((await confirm(id, { run_id: runId, claim_indexes: expIdx })).status).toBe(200);
    await saveBody(id, `다른 본문\n${claimText}\n또 다른 줄`);
    await saveBody(id, '문장을 뺀 본문');
    expect(await listUnconfirmedExperienceClaims(db, ownerA, id)).toEqual([]);
    expect((await setLifecycle(id, 'review')).status).toBe(200);
    expect((await setLifecycle(id, 'ready')).status).toBe(200);
  });

  it('P2: 잘못된 resolution — JSON 400, 폼 303 ?error=invalid(빈 값 포함), 행 없음. 폼에 칸이 없으면 confirmed', async () => {
    const { id, runId, expIdx } = await adopted('폼 resolution 원고');
    const form = (fields: Record<string, string>) =>
      confirmPOST(
        new Request(`${BASE}/api/contents/${id}/claims/confirm`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', ...ORIGIN_HEADERS, ...cookieHeader(tokenA) },
          body: new URLSearchParams(fields).toString(),
        }),
        ctx(id),
      );
    expect((await confirm(id, { run_id: runId, claim_indexes: expIdx, resolution: '' })).status).toBe(400);
    for (const bad of ['bogus', '', 'CONFIRMED']) {
      const res = await form({ run_id: runId, claim_indexes: expIdx.join(','), resolution: bad });
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe(`/contents/${id}?error=invalid`);
    }
    expect(await rowsFor(runId)).toEqual([]);
    const ok = await form({ run_id: runId, claim_indexes: expIdx.join(',') });
    expect(ok.status).toBe(303);
    expect((await rowsFor(runId)).map((r) => r.resolution)).toEqual(expIdx.map(() => 'confirmed'));
  });

  it('P2: 대문자 ?run= UUID 도 그 run 을 조회·선택한다', async () => {
    const { id, runId } = await adopted('대문자 run 원고');
    const base = (await currentBody(id)).version;
    for (let i = 0; i < 11; i++) {
      expect((await assist(id, { mode: 'outline', base_version: base, brand_profile_version: 2, answer_ids: [] })).status).toBe(201);
    }
    const all = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.contentId, id));
    const oldestOther = all.filter((r) => r.id !== runId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]!;
    const param = normalizeRunParam(oldestOther.id.toUpperCase());
    expect(param).toBe(oldestOther.id);
    const w = await getWritingState(db, ownerA, id, param);
    expect(selectRun(w.runs, param)?.id).toBe(oldestOther.id);
    expect(normalizeRunParam('none')).toBe('none');
    expect(selectRun(w.runs, 'none')).toBeUndefined();
    expect(normalizeRunParam('not-a-uuid')).toBeUndefined();
    expect(selectRun(w.runs, undefined)?.id).toBe(w.runs[0]!.id);
  });
});
