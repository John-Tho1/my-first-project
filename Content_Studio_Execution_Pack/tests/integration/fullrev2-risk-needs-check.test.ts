/**
 * FIX2-FULLREV2(G9, 결정 D40-2 — docs/03 "worker는 실행 직전 … risk … 다시 검사"):
 * 원고의 아이디어(contents.idea_id) 또는 연결 소재(content_captures)에 위험 표시 '확인 필요'(risk='needs_check')가 있으면 스냅샷 재검사 문제 코드
 * risk_needs_check 로 승인·실행·전송 직전(beginSend)이 모두 막힌다(다른 스냅샷 문제와 같은 장치 — 승인 409·실행 409+승인 무효·전송 직전 승인 무효+작업 BLOCKED·항목 PLANNED).
 * 아이디어·소재의 위험 표시를 '확인 필요'로 바꾸는 경로(아이디어 PATCH·폼, 소재 PATCH)는 그 원고 항목의 활성 승인을 invalidated:risk_needs_check 로 철회한다.
 * '확인 필요' 해제는 승인을 되살리지 않는다(같은 계획에서 다시 승인). 계획 화면 승인 카드에 위험 표시가 보인다(접힌 칸 밖).
 *
 * - 실제 Threads 계정은 실제 OAuth 연결 흐름(주입 fixture fetch — 가짜 토큰·숫자 ID)으로 만들고 "실제 게시 계정으로 사용"으로 켠다.
 *   실제 게시는 하지 않는다 — 전송 직전 재검사가 어댑터 호출 전에 막는다(네트워크 호출 0).
 * - 화면은 실제 화면 컴포넌트를 실제 DB 로 렌더한다(lib/auth 의 getSession 만 로그인한 세션 토큰으로 — fullrev2-duplicate-publish 와 같은 방식).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  approveItems,
  closeDb,
  executePlan,
  createCapture,
  createContent,
  createIdea,
  createVariantDraft,
  getDb,
  listChannelAccounts,
  runJobsTick,
  schema,
  seed,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { loadConfig, RISK_NEEDS_CHECK_MESSAGE, RISK_NEEDS_CHECK_PROBLEM, type AppConfig } from '@cs/domain';
import { createMockAdapterRegistry, THREADS_LONG_LIVED_URL, THREADS_ME_URL, THREADS_TOKEN_URL } from '@cs/providers';
import { POST as accountsPOST } from '../../apps/web/app/api/channel-accounts/route';
import { POST as connectPOST } from '../../apps/web/app/api/channel-accounts/[id]/connect/route';
import { POST as targetPOST } from '../../apps/web/app/api/channel-accounts/[id]/publish-target/route';
import { GET as callbackGET } from '../../apps/web/app/api/oauth/callback/route';
import { POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { GET as planGET } from '../../apps/web/app/api/distribution-plans/[id]/route';
import { POST as approvePOST } from '../../apps/web/app/api/distribution-plans/[id]/approve/route';
import { POST as executePOST } from '../../apps/web/app/api/distribution-plans/[id]/execute/route';
import { PATCH as ideaPATCH, POST as ideaFormPOST } from '../../apps/web/app/api/ideas/[id]/route';
import { PATCH as capturePATCH } from '../../apps/web/app/api/captures/[id]/route';
import { DISTRIBUTE_ERROR_TEXT } from '../../apps/web/lib/distribution';
import { jobCredentials } from '../../apps/web/lib/oauth';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const h = vi.hoisted(() => ({ token: '' }));
vi.mock('../../apps/web/lib/auth', async () => {
  const session = await import('../../apps/web/lib/session');
  const server = await import('../../apps/web/lib/server');
  return {
    requireOwner: session.requireOwner,
    validateSessionCookie: session.validateSessionCookie,
    validateSessionToken: session.validateSessionToken,
    getSession: async () => {
      if (!h.token) return null;
      const config = server.getConfig();
      const { db: appDb } = await server.getAppDb(config);
      return session.validateSessionToken(appDb, h.token, config);
    },
  };
});

type PageFn = (props: { params?: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) => Promise<unknown>;
const { renderToStaticMarkup } = createRequire(path.resolve(import.meta.dirname, '../../apps/web/package.json'))('react-dom/server') as { renderToStaticMarkup: (el: unknown) => string };
const PlanPage = ((await import(/* @vite-ignore */ path.resolve(import.meta.dirname, '../../apps/web/app', 'distribute/[id]/page.tsx'))) as { default: PageFn }).default;

const A = 'owner-risk@example.local';
const KEY = randomBytes(32).toString('base64');
const APP_ID = '000000000000003';
const SECRET = 'FAKE_app_secret_RISK_integration_only';
const SHORT = 'FAKE_short_token_RISK_it_ssssssssssssssss';
const LONG = 'FAKE_long_token_RISK_it_publish_lllllllll';
const REDIRECT = `${BASE}/api/oauth/callback`;
const PROFILE_ID = '17841400000000077';
const OAUTH_ENV = { OAUTH_MODE: 'live', THREADS_APP_ID: APP_ID, THREADS_APP_SECRET: SECRET, OAUTH_REDIRECT_URI: REDIRECT, OAUTH_LIVE_APPROVAL_REF: 'D31' } as const;
const GATE_KEYS = ['PUBLISH_MODE', 'PUBLISH_LIVE_APPROVAL_REF', 'PUBLISH_LIVE_MAX_POSTS'] as const;
const setGates = (g: Partial<Record<(typeof GATE_KEYS)[number], string>>) => {
  for (const k of GATE_KEYS) vi.stubEnv(k, g[k] ?? '');
};
const gatesOn = () => setGates({ PUBLISH_MODE: 'enabled', PUBLISH_LIVE_APPROVAL_REF: 'RISK-IT', PUBLISH_LIVE_MAX_POSTS: '500' });

let db: Db;
let owner: string;
let tmp: string;
let liveAccount: string;
let mockThreads: string;
let fetchCalls = 0;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (p: string, body: unknown = {}) => jsonPost(p, body, cookieHeader(h.token));
const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const formPost = (p: string, fields: Record<string, string>) =>
  new Request(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', ...ORIGIN_HEADERS, ...cookieHeader(h.token) },
    body: new URLSearchParams(fields).toString(),
  });
const patchReq = (p: string, body: unknown) =>
  new Request(`${BASE}${p}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...ORIGIN_HEADERS, ...cookieHeader(h.token) },
    body: JSON.stringify(body),
  });

async function connectLiveAccount(): Promise<string> {
  for (const [k, v] of Object.entries(OAUTH_ENV)) vi.stubEnv(k, v);
  const created = await accountsPOST(post('/api/channel-accounts', { platform: 'threads', kind: 'live' }));
  const { account } = (await created.json()) as { account: { id: string } };
  const c = await connectPOST(post(`/api/channel-accounts/${account.id}/connect`), ctx(account.id));
  expect(c.status, await c.clone().text()).toBe(200);
  const state = new URL(((await c.json()) as { authorize_url: string }).authorize_url).searchParams.get('state')!;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const u = new URL(input);
      const key = `${init?.method ?? 'GET'} ${u.origin}${u.pathname}`;
      if (key === `POST ${THREADS_TOKEN_URL}`) return jsonRes(200, { access_token: SHORT, token_type: 'bearer', user_id: 1 });
      if (key === `GET ${THREADS_LONG_LIVED_URL}`) return jsonRes(200, { access_token: LONG, token_type: 'bearer', expires_in: 5184000 });
      if (key === `GET ${THREADS_ME_URL}`) return jsonRes(200, { id: PROFILE_ID, username: 'risktester' });
      throw new Error(`fixture 없음: ${key}`);
    }),
  );
  const u = new URL(REDIRECT);
  u.searchParams.set('code', 'FAKE_code_RISK_it_cccccccccccccccccc');
  u.searchParams.set('state', state);
  const cb = await callbackGET(new Request(u.toString(), { headers: { accept: 'application/json', ...cookieHeader(h.token) } }));
  expect(cb.status, await cb.clone().text()).toBe(200);
  vi.unstubAllGlobals();
  for (const k of Object.keys(OAUTH_ENV)) vi.stubEnv(k, '');
  const on = await targetPOST(post(`/api/channel-accounts/${account.id}/publish-target`, { enabled: true }), ctx(account.id));
  expect(on.status, await on.clone().text()).toBe(200);
  return account.id;
}

interface Fixture {
  ideaId: string;
  captureId: string;
  contentId: string;
  variantId: string;
}
/** 아이디어 + 소재 1개를 연결한 원고 → Threads 채널 초안(review). risk 는 처음 값(기본 none). */
async function fixture(o: { ideaRisk?: 'none' | 'needs_check'; captureRisk?: 'none' | 'needs_check' } = {}): Promise<Fixture> {
  const tag = randomUUID().slice(0, 8);
  const idea = await createIdea(db, owner, { idea: `위험 표시 시험 아이디어 ${tag}`, risk: o.ideaRisk ?? 'none' });
  const { capture } = await createCapture(db, owner, { input_type: 'text', raw_text: `위험 표시 시험 소재 ${tag}`, command_key: `risk-${tag}` });
  if (o.captureRisk === 'needs_check') await db.update(schema.captures).set({ risk: 'needs_check' }).where(eq(schema.captures.id, capture.id));
  const { content } = await createContent(db, owner, { title: `RISK ${tag}`, body: `위험 표시 시험 글 ${tag}`, ideaId: idea.id, captureIds: [capture.id] });
  const { variant } = await createVariantDraft(db, owner, content.id, { channel: 'threads', baseVersion: 1 });
  await setVariantLifecycle(db, owner, variant.id, { lifecycle: 'review', baseVersion: 1 });
  return { ideaId: idea.id, captureId: capture.id, contentId: content.id, variantId: variant.id };
}

interface PlanRef {
  planId: string;
  itemId: string;
  hash: string;
}
async function plan(variantId: string, accountId: string): Promise<PlanRef> {
  const res = await plansPOST(post('/api/distribution-plans', { items: [{ variant_id: variantId, channel_account_id: accountId }] }));
  expect(res.status, await res.clone().text()).toBe(201);
  const p = (await res.json()) as { plan: { id: string }; items: Array<{ id: string; payload_hash: string }> };
  return { planId: p.plan.id, itemId: p.items[0]!.id, hash: p.items[0]!.payload_hash };
}
const purposeOf = (accountId: string) => (accountId === liveAccount ? 'public_publish' : 'mock_publish');
const approve = (p: PlanRef, purpose: string) =>
  approvePOST(post(`/api/distribution-plans/${p.planId}/approve`, { item_ids: [p.itemId], expected_hashes: { [p.itemId]: p.hash }, confirm: true, purpose }), ctx(p.planId));
const execute = (p: PlanRef) => executePOST(post(`/api/distribution-plans/${p.planId}/execute`, { command_key: `k-${randomUUID()}` }), ctx(p.planId));

const itemOf = async (id: string) => (await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, id)))[0]!;
const jobsOf = (itemId: string) => db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId));
const approvalsOf = (itemId: string) => db.select().from(schema.approvals).where(eq(schema.approvals.distributionItemId, itemId));
const planOf = async (id: string) => (await db.select().from(schema.distributionPlans).where(eq(schema.distributionPlans.id, id)))[0]!;
const variantOf = async (id: string) => (await db.select().from(schema.variants).where(eq(schema.variants.id, id)))[0]!;
const ideaRev = async (id: string) => (await db.select().from(schema.ideas).where(eq(schema.ideas.id, id)))[0]!.revision;
const captureRev = async (id: string) => (await db.select().from(schema.captures).where(eq(schema.captures.id, id)))[0]!.revision;
const publicationsOf = (itemId: string) => db.select().from(schema.publications).where(eq(schema.publications.itemId, itemId));
const intentsOf = (jobId: string) => db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, jobId));

const patchIdeaRisk = async (id: string, risk: 'none' | 'needs_check') => {
  const r = await ideaPATCH(patchReq(`/api/ideas/${id}`, { expected_revision: await ideaRev(id), risk }), ctx(id));
  expect(r.status, await r.clone().text()).toBe(200);
};
const patchCaptureRisk = async (id: string, risk: 'none' | 'needs_check') => {
  const r = await capturePATCH(patchReq(`/api/captures/${id}`, { expected_revision: await captureRev(id), risk }), ctx(id));
  expect(r.status, await r.clone().text()).toBe(200);
};
const formIdeaRisk = async (id: string, risk: 'none' | 'needs_check') => {
  const r = await ideaFormPOST(
    formPost(`/api/ideas/${id}`, { _method: 'PATCH', expected_revision: String(await ideaRev(id)), idea: '폼으로 고친 아이디어', audience: '', evidence: '', risk, next_question: '', next_decision: '', tags: '' }),
    ctx(id),
  );
  expect(r.status, await r.clone().text()).toBe(303);
};

const registry = createMockAdapterRegistry();
async function tick(planId: string, cfg: AppConfig) {
  return runJobsTick(db, registry, {
    workerId: 'risk-w',
    config: cfg,
    ownerId: owner,
    planId,
    clock: () => new Date(),
    random: () => 0.5,
    submitTimeoutMs: 5000,
    maxJobs: 5,
    credentials: jobCredentials(cfg, db),
  });
}

/** 승인 → 실행(QUEUED). 실제 계정은 게이트를 켠 채 실행한다(작업 처리 전 — 실제 게시 없음). */
async function approvedQueued(f: Fixture, accountId: string): Promise<PlanRef> {
  const p = await plan(f.variantId, accountId);
  const ap = await approve(p, purposeOf(accountId));
  expect(ap.status, await ap.clone().text()).toBe(200);
  if (accountId === liveAccount) gatesOn();
  const ex = await execute(p);
  expect(ex.status, await ex.clone().text()).toBe(200);
  expect((await itemOf(p.itemId)).status).toBe('QUEUED');
  expect((await jobsOf(p.itemId)).map((j) => j.state)).toEqual(['QUEUED']);
  return p;
}

/** 훅 철회 결과: 승인 invalidated:risk_needs_check, 작업 BLOCKED(approval_invalidated), 항목 PLANNED, 계획 재계산, 파생본 approved → review */
async function expectRevokedByHook(p: PlanRef, variantId: string) {
  const [a] = await approvalsOf(p.itemId);
  expect(a!.revokedAt).not.toBeNull();
  expect(a!.revokeReason).toBe('invalidated:risk_needs_check');
  expect((await itemOf(p.itemId)).status).toBe('PLANNED');
  const [j] = await jobsOf(p.itemId);
  expect(j!.state).toBe('BLOCKED');
  expect(j!.lastErrorCode).toBe('approval_invalidated');
  expect(await intentsOf(j!.id)).toEqual([]);
  expect((await planOf(p.planId)).status).not.toBe('approved');
  expect((await variantOf(variantId)).lifecycle).toBe('review');
}

const textOf = (html: string) =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
const renderPlan = async (planId: string, q: Record<string, string> = {}) => renderToStaticMarkup(await PlanPage({ params: Promise.resolve({ id: planId }), searchParams: Promise.resolve(q) }));

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-risk-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('EXPORT_LOCAL_DIR', path.join(tmp, 'exports'));
  vi.stubEnv('SECRETS_MASTER_KEY', KEY);
  vi.stubEnv('SECRETS_KEY_VERSION', '1');
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  db = (await getDb(loadConfig())).db;
  owner = (await seed(db, { allowedIdentity: A })).ownerId;
  mockThreads = (await listChannelAccounts(db, owner)).find((a) => a.platform === 'threads' && a.kind === 'mock')!.id;
  h.token = await login(A);
  liveAccount = await connectLiveAccount();
});
beforeEach(() => {
  setGates({});
  vi.stubGlobal('fetch', async () => {
    fetchCalls++;
    throw new Error('RISK 시험: 네트워크 호출 금지');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  expect(fetchCalls).toBe(0);
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
  await closeDb();
});

const ACCOUNTS = [
  { mode: 'MOCK', account: () => mockThreads },
  { mode: 'LIVE', account: () => liveAccount },
] as const;

describe.each(ACCOUNTS)('FIX2-FULLREV2(G9): 위험 표시 확인 필요 — $mode', ({ mode, account }) => {
  it.each([
    { source: '아이디어', risk: { ideaRisk: 'needs_check' } },
    { source: '연결 소재', risk: { captureRisk: 'needs_check' } },
  ] as const)("승인: $source 가 '확인 필요'면 409(한국어 해제 안내) · 승인 없음 · 계획 JSON·화면에 위험 표시 → 해제하면 같은 계획에서 승인 200", async ({ source, risk }) => {
    const f = await fixture(risk);
    const p = await plan(f.variantId, account()); // 계획 생성은 막지 않는다(승인 카드에서 보인다)
    const r = await approve(p, purposeOf(account()));
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string; message: string; items: Array<{ item_id: string; reasons: string[] }> };
    expect(body.error).toBe('snapshot_stale');
    expect(body.message).toBe(RISK_NEEDS_CHECK_MESSAGE);
    expect(body.message).toContain("'확인 필요'를 해제");
    expect(body.items).toEqual([{ item_id: p.itemId, reasons: [RISK_NEEDS_CHECK_PROBLEM] }]);
    expect(await approvalsOf(p.itemId)).toEqual([]);
    expect((await planOf(p.planId)).status).toBe('draft');

    // 계획 JSON: problems 와 위험 출처
    const g = await planGET(new Request(`${BASE}/api/distribution-plans/${p.planId}`, { headers: { accept: 'application/json', ...cookieHeader(h.token) } }), ctx(p.planId));
    const items = ((await g.json()) as { items: Array<{ problems: string[]; risk_needs_check: { idea_id: string | null; capture_ids: string[] } | null }> }).items;
    expect(items[0]!.problems).toEqual([RISK_NEEDS_CHECK_PROBLEM]);
    expect(items[0]!.risk_needs_check).toEqual(source === '아이디어' ? { idea_id: f.ideaId, capture_ids: [] } : { idea_id: null, capture_ids: [f.captureId] });

    // 화면: 승인 카드에 위험 표시(접힌 칸 밖) · "새 계획 필요" 줄 없음 · 승인할 수 있는 항목 없음
    const html = await renderPlan(p.planId);
    const i = html.indexOf('data-testid="risk-needs-check"');
    expect(i).toBeGreaterThan(-1);
    const before = html.slice(0, i);
    expect(before.lastIndexOf('<details')).toBeLessThanOrEqual(before.lastIndexOf('</details>')); // 열린 <details> 안이 아니다
    const t = textOf(html);
    expect(t).toContain("위험 표시 '확인 필요' — 이 원고의 아이디어 또는 연결 소재에 '확인 필요'가 있어 승인·실행할 수 없습니다");
    expect(html).toContain(source === '아이디어' ? `href="/ideas/${f.ideaId}"` : `href="/captures/${f.captureId}"`);
    expect(t).not.toContain('새 계획 필요');
    expect(t).toContain('승인할 수 있는 항목이 없습니다.');

    // 폼 승인: 위험 표시만으로 막힌 거절은 해제 안내 코드로 돌아간다
    const fr = await approvePOST(formPost(`/api/distribution-plans/${p.planId}/approve`, { [`item_${p.itemId}`]: 'on', [`hash_${p.itemId}`]: p.hash, [`purpose_${p.itemId}`]: purposeOf(account()), confirm: 'yes' }), ctx(p.planId));
    expect(fr.status).toBe(303);
    expect(fr.headers.get('location')).toContain('error=risk_needs_check');
    expect(DISTRIBUTE_ERROR_TEXT.risk_needs_check).toBe(RISK_NEEDS_CHECK_MESSAGE);
    expect(await approvalsOf(p.itemId)).toEqual([]);

    // 해제(확인 필요 → 없음) — 같은 계획에서 다시 승인할 수 있다(스냅샷 hash 와 무관)
    if (source === '아이디어') await patchIdeaRisk(f.ideaId, 'none');
    else await patchCaptureRisk(f.captureId, 'none');
    const ok = await approve(p, purposeOf(account()));
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await approvalsOf(p.itemId)).filter((a) => a.revokedAt === null)).toHaveLength(1);
  });

  it("실행: 훅을 거치지 않은 '확인 필요'(직접 DB 변경)도 실행 409(해제 안내) · 대기열 없음 · 승인 invalidated:risk_needs_check · 항목 PLANNED", async () => {
    const f = await fixture();
    const p = await plan(f.variantId, account());
    expect((await approve(p, purposeOf(account()))).status).toBe(200);
    await db.update(schema.ideas).set({ risk: 'needs_check' }).where(eq(schema.ideas.id, f.ideaId));
    if (mode === 'LIVE') gatesOn();
    const r = await execute(p);
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error: string; message: string; items: Array<{ item_id: string; reasons: string[] }> };
    expect(body).toMatchObject({ error: 'snapshot_stale', message: RISK_NEEDS_CHECK_MESSAGE, items: [{ item_id: p.itemId, reasons: [RISK_NEEDS_CHECK_PROBLEM] }] });
    expect(await jobsOf(p.itemId)).toEqual([]);
    expect((await itemOf(p.itemId)).status).toBe('PLANNED');
    const [a] = await approvalsOf(p.itemId);
    expect(a!.revokeReason).toBe('invalidated:risk_needs_check');
    expect((await variantOf(f.variantId)).lifecycle).toBe('review');
  });

  it.each([
    { path: '아이디어 PATCH', change: (f: Fixture) => patchIdeaRisk(f.ideaId, 'needs_check'), clear: (f: Fixture) => patchIdeaRisk(f.ideaId, 'none') },
    { path: '아이디어 폼', change: (f: Fixture) => formIdeaRisk(f.ideaId, 'needs_check'), clear: (f: Fixture) => formIdeaRisk(f.ideaId, 'none') },
    { path: '소재 PATCH', change: (f: Fixture) => patchCaptureRisk(f.captureId, 'needs_check'), clear: (f: Fixture) => patchCaptureRisk(f.captureId, 'none') },
  ])("승인·대기(QUEUED) 뒤 $path 로 '확인 필요' → 승인 철회(invalidated:risk_needs_check)·작업 BLOCKED·항목 PLANNED · 해제해도 되살리지 않음", async ({ change, clear }) => {
    const f = await fixture();
    const p = await approvedQueued(f, account());
    await change(f);
    await expectRevokedByHook(p, f.variantId);
    const audits = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'approval.invalidate'));
    expect(audits.some((e) => (e.sanitizedDetails as Record<string, unknown>).item_id === p.itemId && (e.sanitizedDetails as Record<string, unknown>).reason === 'invalidated:risk_needs_check')).toBe(true);
    // 해제는 승인을 되살리지 않는다
    await clear(f);
    expect((await approvalsOf(p.itemId)).filter((a) => a.revokedAt === null)).toEqual([]);
    expect((await itemOf(p.itemId)).status).toBe('PLANNED');
    expect((await jobsOf(p.itemId)).map((j) => j.state)).toEqual(['BLOCKED']);
    // 작업 처리기는 보류 작업을 보내지 않는다(네트워크 0)
    if (mode === 'LIVE') gatesOn();
    await tick(p.planId, loadConfig());
    expect(await publicationsOf(p.itemId)).toEqual([]);
  });

  it("전송 직전(beginSend): 훅을 거치지 않은 '확인 필요'(직접 DB 변경 — 연결 소재)도 보내기 전에 막는다 — 승인 invalidated:risk_needs_check·작업 BLOCKED(snapshot_stale)·항목 PLANNED, 보낸 것 없음", async () => {
    const f = await fixture();
    const p = await approvedQueued(f, account());
    await db.update(schema.captures).set({ risk: 'needs_check' }).where(eq(schema.captures.id, f.captureId));
    // 훅을 거치지 않았으므로 승인은 아직 활성
    expect((await approvalsOf(p.itemId)).filter((a) => a.revokedAt === null)).toHaveLength(1);
    if (mode === 'LIVE') gatesOn();
    await tick(p.planId, loadConfig());
    const [j] = await jobsOf(p.itemId);
    expect(j!.state).toBe('BLOCKED');
    expect(j!.lastErrorCode).toBe('snapshot_stale');
    expect(await intentsOf(j!.id)).toEqual([]);
    expect(await publicationsOf(p.itemId)).toEqual([]);
    expect((await itemOf(p.itemId)).status).toBe('PLANNED');
    const [a] = await approvalsOf(p.itemId);
    expect(a!.revokeReason).toBe('invalidated:risk_needs_check');
    // 본문은 그대로 — 파생본 approved → review(훅과 같은 결과, draft 아님)
    expect((await variantOf(f.variantId)).lifecycle).toBe('review');
    const ev = await db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, j!.id));
    expect(ev.some((e) => (e.sanitizedDetails as { problems?: string[] }).problems?.includes(RISK_NEEDS_CHECK_PROBLEM))).toBe(true);
  });

  it("위험 표시 없음('none')·그 밖의 값은 영향 없음 — 승인 200·실행 200, 'none' 으로 다시 저장해도 승인 그대로", async () => {
    const f = await fixture();
    // 스키마 밖의 다른 값(직접 DB) — '확인 필요'만 막는다
    await db.update(schema.ideas).set({ risk: 'reviewed' }).where(eq(schema.ideas.id, f.ideaId));
    const p = await approvedQueued(f, account());
    await patchCaptureRisk(f.captureId, 'none');
    await db.update(schema.ideas).set({ risk: 'none' }).where(eq(schema.ideas.id, f.ideaId));
    await patchIdeaRisk(f.ideaId, 'none');
    expect((await approvalsOf(p.itemId)).filter((a) => a.revokedAt === null)).toHaveLength(1);
    expect((await itemOf(p.itemId)).status).toBe('QUEUED');
    expect((await jobsOf(p.itemId)).map((j) => j.state)).toEqual(['QUEUED']);
    const html = await renderPlan(p.planId);
    expect(html).not.toContain('data-testid="risk-needs-check"');
  });
});

describe("FIX2-FULLREV2(G9): '확인 필요'는 그 원고만 막는다", () => {
  it('다른 원고(같은 아이디어·소재를 쓰지 않음)의 승인은 그대로', async () => {
    const risky = await fixture();
    const other = await fixture();
    const pr = await approvedQueued(risky, mockThreads);
    const po = await approvedQueued(other, mockThreads);
    await patchIdeaRisk(risky.ideaId, 'needs_check');
    await expectRevokedByHook(pr, risky.variantId);
    expect((await approvalsOf(po.itemId)).filter((a) => a.revokedAt === null)).toHaveLength(1);
    expect((await itemOf(po.itemId)).status).toBe('QUEUED');
  });
});

describe('FIX2-FULLREV2(G9 fixup): 승인·실행은 위험 표시 출처(아이디어·소재)를 항목 잠금 전에 FOR SHARE 로 잠근다', () => {
  // PGlite 는 연결 하나라 경합을 재현할 수 없다 — 트랜잭션 안에서 실제로 보낸 SQL 의 순서를 확인한다(훅 순서: 아이디어/소재 → 원고 → … → 항목).
  async function txSql<T>(fn: () => Promise<T>): Promise<{ result: T; sql: string[] }> {
    const client = (await getDb(loadConfig())).client;
    const orig = client.transaction.bind(client);
    const seen: string[] = [];
    const spy = vi.spyOn(client, 'transaction').mockImplementation(((cb: (tx: { query: (...a: unknown[]) => Promise<unknown> }) => Promise<unknown>) =>
      orig(async (tx) => {
        const q = tx.query.bind(tx) as (...a: unknown[]) => Promise<unknown>;
        (tx as unknown as { query: (...a: unknown[]) => Promise<unknown> }).query = (text: unknown, ...rest: unknown[]) => {
          seen.push(String(text));
          return q(text, ...rest);
        };
        return cb(tx as unknown as { query: (...a: unknown[]) => Promise<unknown> });
      })) as unknown as typeof client.transaction);
    try {
      return { result: await fn(), sql: seen };
    } finally {
      spy.mockRestore();
    }
  }
  const idx = (sqls: string[], re: RegExp) => sqls.findIndex((q) => re.test(q));
  const IDEA_SHARE = /from "ideas" .*order by "ideas"\."id".* for share$/i;
  const CAPTURE_SHARE = /from "captures" .*order by "captures"\."id".* for share$/i;
  const ACCOUNT_SHARE = /from "channel_accounts" .* for share$/i;
  const ANY_UPDATE_LOCK = / for update$/i;

  function expectRiskLockOrder(sqls: string[], firstLaterLock: RegExp) {
    const iAcc = idx(sqls, ACCOUNT_SHARE);
    const iIdea = idx(sqls, IDEA_SHARE);
    const iCap = idx(sqls, CAPTURE_SHARE);
    const iLater = idx(sqls, firstLaterLock);
    expect(iAcc, sqls.join('\n')).toBeGreaterThan(-1);
    expect(iIdea, sqls.join('\n')).toBeGreaterThan(iAcc); // 계정 다음
    expect(iCap).toBeGreaterThan(iIdea); // 아이디어 → 소재
    expect(iLater).toBeGreaterThan(iCap); // 원고·계획·항목 잠금 전
    expect(idx(sqls, ANY_UPDATE_LOCK)).toBeGreaterThan(iCap); // 어떤 FOR UPDATE 보다도 먼저
  }

  it('approveItems: 계정 FOR SHARE → 아이디어 FOR SHARE(id 순) → 소재 FOR SHARE(id 순) → 원고·파생본·계획·항목 FOR UPDATE, 승인 200', async () => {
    const f = await fixture();
    const p = await plan(f.variantId, mockThreads);
    const { result, sql: sqls } = await txSql(() =>
      approveItems(db, owner, p.planId, { item_ids: [p.itemId], expected_hashes: { [p.itemId]: p.hash }, confirm: true, purpose: 'mock_publish' }),
    );
    expect(result.approvals).toHaveLength(1);
    expectRiskLockOrder(sqls, /from "contents" .* for update$/i);
    expect(idx(sqls, /from "distribution_items" .* for update$/i)).toBeGreaterThan(idx(sqls, CAPTURE_SHARE));
  });

  it('executePlan: 계정 FOR SHARE → 아이디어·소재 FOR SHARE → 계획 FOR UPDATE → 항목 FOR UPDATE, 실행 200', async () => {
    const f = await fixture();
    const p = await plan(f.variantId, mockThreads);
    expect((await approve(p, 'mock_publish')).status).toBe(200);
    const cfg = loadConfig(process.env);
    const { result, sql: sqls } = await txSql(() => executePlan(db, owner, p.planId, { commandKey: `lock-${randomUUID()}` }, cfg));
    expect(result.queued).toHaveLength(1);
    expectRiskLockOrder(sqls, /from "distribution_plans" .* for update$/i);
  });
});
