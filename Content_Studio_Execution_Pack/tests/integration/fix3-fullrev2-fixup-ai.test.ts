/**
 * FIX3-FULLREV2 fixup — 채널 초안 AI 실패(실제 진입점: runVariantAssist·POST /api/contents/{id}/variants):
 *  - G21 보강: 폼 경로 303 이 허용 목록 실패 코드(?failure=)를 싣고, 화면은 그 코드만(aiRunFailureView) RunFailureNotice 로 원인·영구 실패 안내를 보인다.
 *    채널 초안 run(mode='variant')은 작성 보조 run 목록에 없으므로 이 경로가 아니면 브라우저 사용자는 일반 문구만 본다.
 *  - G21 보강(B3): 채널 초안 AI 의 스키마 실패 분류 = 원고 작성 보조(invalid_output — provider_error 아님).
 * 키는 가짜 sentinel, setupFiles 가드가 실제 외부 호출을 막는다(전역 fetch stub).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, createContent, getDb, runAssist, runVariantAssist, schema, seed, type AssistLlm, type Db } from '@cs/db';
import { AI_PERMANENT_FAILURE_GUIDANCE, AppError, budgetPolicy, loadConfig } from '@cs/domain';
import { POST as variantsPOST } from '../../apps/web/app/api/contents/[id]/variants/route';
import { POST as assistPOST } from '../../apps/web/app/api/contents/[id]/assist/route';
import { formFailureCode } from '../../apps/web/lib/writing';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const webRequire = createRequire(path.resolve(import.meta.dirname, '../../apps/web/package.json'));
const { renderToStaticMarkup } = webRequire('react-dom/server') as { renderToStaticMarkup: (el: unknown) => string };
const { createElement } = webRequire('react') as { createElement: (type: unknown, props: unknown) => unknown };
type PanelModule = { RunFailureNotice: (props: { error: string | null }) => unknown };
const { RunFailureNotice } = (await import(/* @vite-ignore */ path.resolve(import.meta.dirname, '../../apps/web/app', 'contents/[id]/writing-panel.tsx'))) as PanelModule;

const A = 'owner@example.local';
const KEY = 'sk-ant-FAKE-fix3-fixup-sentinel-9a8b7c';
const ECHO = 'UPSTREAM-ECHO-FIXUP-원문-4d3c';
const LIVE = {
  LLM_MODE: 'live',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'claude-opus-5-5',
  LLM_PRICE_INPUT_PER_1K: '0.004',
  LLM_PRICE_OUTPUT_PER_1K: '0.02',
  LLM_BUDGET_MONTHLY_LIMIT: '10',
  LLM_BUDGET_PER_RUN_MAX: '0.5',
  LLM_LIVE_APPROVAL_REF: 'D34-test-approval',
} as const;

let db: Db;
let ownerA: string;
let tokenA: string;

const as = (identity: string) => vi.stubEnv('AUTH_ALLOWED_IDENTITY', identity);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const render = (error: string | null) => renderToStaticMarkup(createElement(RunFailureNotice, { error }));

function formPost(p: string, fields: Record<string, string>): Request {
  return new Request(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html,application/xhtml+xml', ...ORIGIN_HEADERS, ...cookieHeader(tokenA) },
    body: new URLSearchParams(fields).toString(),
  });
}

/** 스키마에 맞지 않는 출력을 내는 AI(모의 이름) — 공급자 오류가 아니라 응답 형식 실패 */
const badSchema: AssistLlm = { name: 'mock', mode: 'mock', generate: async () => ({ nope: true }) as never };

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

async function withLive401<T>(fn: () => Promise<T>): Promise<T> {
  try {
    for (const [k, v] of Object.entries(LIVE)) vi.stubEnv(k, v);
    vi.stubEnv('ANTHROPIC_API_KEY', KEY);
    vi.stubGlobal('fetch', (async () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `${ECHO} ${KEY}` } }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'request-id': 'req_011FAKEfixup' },
      })) as unknown as typeof fetch);
    return await fn();
  } finally {
    for (const k of [...Object.keys(LIVE), 'ANTHROPIC_API_KEY']) vi.stubEnv(k, '');
    vi.stubEnv('LLM_MODE', 'mock');
    vi.unstubAllGlobals();
  }
}

describe('FIX3-FULLREV2 fixup(G21) — 채널 초안 AI 실패 원인이 폼 경로 화면에도 보인다', () => {
  it('폼 POST variants(ai_draft, live 401) → 303 ?error=llm_failed&failure=llm_auth_failed → 화면 안내에 고정 원인 문구·영구 실패 안내, 원문·키 없음', async () => {
    const c = await createContent(db, ownerA, { title: 'fixup G21 채널', body: '채널 초안 본문.' });
    const res = await withLive401(() => variantsPOST(formPost(`/api/contents/${c.content.id}/variants`, { channel: 'threads', mode: 'ai_draft', base_version: '1' }), ctx(c.content.id)));
    expect(res.status).toBe(303);
    const loc = res.headers.get('location')!;
    expect(loc).toBe(`/contents/${c.content.id}?error=llm_failed&failure=llm_auth_failed`);
    expect(loc).not.toContain(ECHO);
    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.contentId, c.content.id));
    expect(run).toMatchObject({ mode: 'variant', status: 'failed', error: 'llm_auth_failed' });
    // 화면(page.tsx)이 쓰는 판정: 쿼리 → 허용 목록 코드 → RunFailureNotice
    const q = new URL(loc, BASE).searchParams;
    const code = formFailureCode(q.get('error'), q.get('failure'));
    expect(code).toBe('llm_auth_failed');
    const html = render(code);
    expect(html).toContain('원인: 실제 AI 인증에 실패했습니다(ANTHROPIC_API_KEY 를 확인하세요).');
    expect(html).toContain('<code>llm_auth_failed</code>');
    expect(html).toContain(AI_PERMANENT_FAILURE_GUIDANCE);
    expect(html).not.toContain(ECHO);
    expect(html).not.toContain('sk-ant');
  });

  it('원고 작성 보조 폼 실패도 같은 failure 쿼리를 싣는다(모의 본문 URL → unverifiable_citation)', async () => {
    const c = await createContent(db, ownerA, { title: 'fixup G21 원고', body: 'https://example.com/a 를 읽었다. 시장은 커졌다.' });
    const res = await assistPOST(formPost(`/api/contents/${c.content.id}/assist`, { mode: 'draft', base_version: '1', brand_profile_version: '1' }), ctx(c.content.id));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/contents/${c.content.id}?error=llm_failed&failure=unverifiable_citation`);
  });

  it('쿼리를 손으로 바꿔도 허용 목록 밖 값·다른 error 는 그리지 않는다(null) — 화면에 원문이 나가지 않는다', () => {
    expect(formFailureCode('llm_failed', '<script>alert(1)</script>')).toBeNull();
    expect(formFailureCode('llm_failed', `${ECHO}`)).toBeNull();
    expect(formFailureCode('llm_failed', '__proto__')).toBeNull();
    expect(formFailureCode('llm_failed', 'toString')).toBeNull();
    expect(formFailureCode('stale', 'llm_auth_failed')).toBeNull();
    expect(formFailureCode('llm_failed', undefined)).toBeNull();
    expect(formFailureCode(undefined, 'llm_auth_failed')).toBeNull();
    expect(formFailureCode('llm_failed', 'llm_server_error')).toBe('llm_server_error');
  });

  it('page.tsx 연결: 쿼리 error·failure 를 formFailureCode 로만 읽어 RunFailureNotice 로 그린다(소스 검사)', () => {
    const src = readFileSync(path.resolve(import.meta.dirname, '../../apps/web/app/contents/[id]/page.tsx'), 'utf8');
    expect(src).toMatch(/const failure = formFailureCode\(str\(q\.error\), str\(q\.failure\)\);/);
    expect(src).toMatch(/\{failure \? <RunFailureNotice error=\{failure\} \/> : null\}/);
    expect(src).not.toMatch(/q\.failure\)?\s*\}/); // 쿼리 값을 직접 그리지 않음
  });

  it('JSON 경로(variants ai_draft, live 401)는 502 { run_id, failure_code, permanent } — 기존 규칙 그대로', async () => {
    const c = await createContent(db, ownerA, { title: 'fixup G21 JSON', body: '본문.' });
    const res = await withLive401(() =>
      variantsPOST(jsonPost(`/api/contents/${c.content.id}/variants`, { channel: 'threads', mode: 'ai_draft', base_version: 1 }, cookieHeader(tokenA)), ctx(c.content.id)),
    );
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: 'llm_failed', failure_code: 'llm_auth_failed', permanent: true });
    expect(text).not.toContain(ECHO);
    expect(text).not.toContain(KEY);
  });
});

describe('FIX3-FULLREV2 fixup(G21·B3) — 스키마 실패 분류: 채널 초안 = 원고 작성 보조 = invalid_output', () => {
  it('같은 형식 오류 출력 → 두 경로 모두 run.error·감사·LlmFailedError 의 failure_code 가 invalid_output(provider_error 아님)', async () => {
    const c = await createContent(db, ownerA, { title: 'fixup B3', body: '형식 실패 본문.' });
    const policy = budgetPolicy(loadConfig());
    const ve = await runVariantAssist(db, ownerA, c.content.id, { channel: 'blog', baseVersion: 1, budget: policy }, badSchema).then(
      () => null,
      (x: AppError) => x,
    );
    expect(ve?.code).toBe('llm_failed');
    expect(ve?.extra).toMatchObject({ failure_code: 'invalid_output', permanent: false });
    const we = await runAssist(db, ownerA, c.content.id, { mode: 'draft', baseVersion: 1, brandProfileVersion: 1, answerIds: [], budget: policy }, badSchema).then(
      () => null,
      (x: AppError) => x,
    );
    expect(we?.extra).toMatchObject({ failure_code: 'invalid_output' });
    const runs = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.contentId, c.content.id));
    expect(runs.map((r) => [r.mode, r.status, r.error]).sort()).toEqual([
      ['draft', 'failed', 'invalid_output'],
      ['variant', 'failed', 'invalid_output'],
    ]);
    const audits = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'variant.assist'));
    const mine = audits.filter((a) => a.versionOrHash === runs.find((r) => r.mode === 'variant')!.id);
    expect(mine.map((a) => (a.sanitizedDetails as { error?: string }).error)).toEqual(['invalid_output']);
  });
});
