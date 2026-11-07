/**
 * FIX1-FULLREV2(G2, 결정 D40-1 — docs/03 "동일 본문을 새 plan으로 의도적으로 재게시하는 경우 경고 후 새 사용자 승인"):
 * 같은 owner 의 다른 계획에 같은 글(같은 채널 초안 버전 + 같은 계정, 또는 같은 payload_hash) 항목이 이미 게시됨(결과 기록 — USER_CONFIRMED 포함)·결과 불명·
 * 진행 중이면 새 계획의 JSON·화면에 경고하고, **실제 계정** 항목의 승인·실행은 acknowledge_duplicate: true 가 있어야 한다(없으면 409 — 아무것도 바꾸지 않음).
 * 모의 계정 항목은 경고만. CANCELED·FAILED(보내지 않음)·PLANNED(작업 없음) 는 세지 않는다. 같은 계획의 항목은 서로 영향 없음.
 *
 * - 실제 Threads 계정은 실제 OAuth 연결 흐름(주입 fixture fetch — 가짜 토큰·숫자 ID)으로 만들고 "실제 게시 계정으로 사용"으로 켠다. 실제 게시(작업 처리)는 하지 않는다 —
 *   다른 계획 항목의 결과 불명·게시됨·보류 상태는 항목·작업 상태와 결과 기록을 직접 써서 만든다(판정은 항목 상태·결과 기록만 본다).
 * - 진행 중(QUEUED)·취소(CANCELED)·모의 게시(MOCK CONFIRMED)는 실제 route·작업 처리기(모의 어댑터)로 만든다.
 * - 화면은 실제 화면 컴포넌트를 실제 DB 로 렌더한다(lib/auth 의 getSession 만 쿠키 대신 로그인한 세션 토큰을 실제 검증 함수로 확인 — next/headers 없이).
 *   react-dom/server 는 앱(apps/web)의 의존성이라 앱 기준 require 로 읽고, 화면 모듈(tsx)은 실행 시점 경로로 import 한다(루트 tsc 범위 밖 — 웹 tsc 가 검사).
 * - 네트워크 호출 0(전역 fetch 는 OAuth 연결 동안만 fixture, 그 밖에는 부르면 실패).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  closeDb,
  createContent,
  createVariantDraft,
  duplicatePublishesForItems,
  duplicatePublishesForVariantVersions,
  getDb,
  listChannelAccounts,
  runJobsTick,
  schema,
  seed,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { DUPLICATE_PUBLISH_UNACKNOWLEDGED_MESSAGE, loadConfig, type AppConfig } from '@cs/domain';
import { createMockAdapterRegistry, THREADS_LONG_LIVED_URL, THREADS_ME_URL, THREADS_TOKEN_URL } from '@cs/providers';
import { POST as accountsPOST } from '../../apps/web/app/api/channel-accounts/route';
import { POST as connectPOST } from '../../apps/web/app/api/channel-accounts/[id]/connect/route';
import { POST as targetPOST } from '../../apps/web/app/api/channel-accounts/[id]/publish-target/route';
import { GET as callbackGET } from '../../apps/web/app/api/oauth/callback/route';
import { POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { GET as planGET } from '../../apps/web/app/api/distribution-plans/[id]/route';
import { POST as approvePOST } from '../../apps/web/app/api/distribution-plans/[id]/approve/route';
import { POST as executePOST } from '../../apps/web/app/api/distribution-plans/[id]/execute/route';
import { POST as cancelPOST } from '../../apps/web/app/api/distribution-items/[id]/cancel/route';
import { DISTRIBUTE_ERROR_TEXT, DUPLICATE_ACK_LABEL, duplicateWarningLine } from '../../apps/web/lib/distribution';
import { jobCredentials } from '../../apps/web/lib/oauth';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const h = vi.hoisted(() => ({ token: '' }));
// 화면(server component)의 getSession: 쿠키(next/headers) 대신 로그인한 세션 토큰을 실제 검증 함수(validateSessionToken·실제 DB)로 확인한다. 나머지는 lib/session 그대로.
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
const pagePath = (rel: string) => path.resolve(import.meta.dirname, '../../apps/web/app', rel);
const PlanPage = ((await import(/* @vite-ignore */ pagePath('distribute/[id]/page.tsx'))) as { default: PageFn }).default;
const NewPlanPage = ((await import(/* @vite-ignore */ pagePath('distribute/new/page.tsx'))) as { default: PageFn }).default;

const A = 'owner-dup@example.local';
const KEY = randomBytes(32).toString('base64');
const APP_ID = '000000000000002';
const SECRET = 'FAKE_app_secret_DUPLICATE_integration_only';
const SHORT = 'FAKE_short_token_DUPLICATE_it_ssssssssssss';
const LONG = 'FAKE_long_token_DUPLICATE_it_publish_llllll';
const REDIRECT = `${BASE}/api/oauth/callback`;
const PROFILE_ID = '17841400000000099';
const OAUTH_ENV = { OAUTH_MODE: 'live', THREADS_APP_ID: APP_ID, THREADS_APP_SECRET: SECRET, OAUTH_REDIRECT_URI: REDIRECT, OAUTH_LIVE_APPROVAL_REF: 'D31' } as const;
const GATE_KEYS = ['PUBLISH_MODE', 'PUBLISH_LIVE_APPROVAL_REF', 'PUBLISH_LIVE_MAX_POSTS'] as const;
const setGates = (g: Partial<Record<(typeof GATE_KEYS)[number], string>>) => {
  for (const k of GATE_KEYS) vi.stubEnv(k, g[k] ?? '');
};
// 실행 앞선 검사(pendingLiveJobs)는 다른 계획의 끝나지 않은 실제 작업도 센다 — 이 파일은 실제 작업을 처리하지 않으므로 상한을 넉넉히(실제 게시 없음)
const gatesOn = () => setGates({ PUBLISH_MODE: 'enabled', PUBLISH_LIVE_APPROVAL_REF: 'DUP-IT', PUBLISH_LIVE_MAX_POSTS: '500' });

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

/** 실제 Threads 계정(연결 전 행) → 실제 OAuth 연결(fixture) → 실제 게시 계정으로 사용 */
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
      if (key === `GET ${THREADS_ME_URL}`) return jsonRes(200, { id: PROFILE_ID, username: 'duptester' });
      throw new Error(`fixture 없음: ${key}`);
    }),
  );
  const u = new URL(REDIRECT);
  u.searchParams.set('code', 'FAKE_code_DUPLICATE_it_cccccccccccccc');
  u.searchParams.set('state', state);
  const cb = await callbackGET(new Request(u.toString(), { headers: { accept: 'application/json', ...cookieHeader(h.token) } }));
  expect(cb.status, await cb.clone().text()).toBe(200);
  vi.unstubAllGlobals();
  for (const k of Object.keys(OAUTH_ENV)) vi.stubEnv(k, '');
  const on = await targetPOST(post(`/api/channel-accounts/${account.id}/publish-target`, { enabled: true }), ctx(account.id));
  expect(on.status, await on.clone().text()).toBe(200);
  return account.id;
}

interface PlanRef {
  planId: string;
  itemId: string;
  hash: string;
}
async function reviewVariant(body: string): Promise<{ variantId: string; contentId: string }> {
  const { content } = await createContent(db, owner, { title: `DUP ${randomUUID().slice(0, 6)}`, body });
  const { variant } = await createVariantDraft(db, owner, content.id, { channel: 'threads', baseVersion: 1 });
  await setVariantLifecycle(db, owner, variant.id, { lifecycle: 'review', baseVersion: 1 });
  return { variantId: variant.id, contentId: content.id };
}
async function plan(variantId: string, accountId: string): Promise<PlanRef> {
  const res = await plansPOST(post('/api/distribution-plans', { items: [{ variant_id: variantId, channel_account_id: accountId }] }));
  expect(res.status, await res.clone().text()).toBe(201);
  const p = (await res.json()) as { plan: { id: string }; items: Array<{ id: string; payload_hash: string }> };
  return { planId: p.plan.id, itemId: p.items[0]!.id, hash: p.items[0]!.payload_hash };
}
const approveBody = (p: PlanRef, purpose: string, extra: Record<string, unknown> = {}) => ({
  item_ids: [p.itemId],
  expected_hashes: { [p.itemId]: p.hash },
  confirm: true,
  purpose,
  ...extra,
});
const approve = (p: PlanRef, purpose: string, extra: Record<string, unknown> = {}) => approvePOST(post(`/api/distribution-plans/${p.planId}/approve`, approveBody(p, purpose, extra)), ctx(p.planId));
const execute = (p: PlanRef, extra: Record<string, unknown> = {}, key = `k-${randomUUID()}`) =>
  executePOST(post(`/api/distribution-plans/${p.planId}/execute`, { command_key: key, ...extra }), ctx(p.planId));
async function detailJson(planId: string) {
  const res = await planGET(new Request(`${BASE}/api/distribution-plans/${planId}`, { headers: { accept: 'application/json', ...cookieHeader(h.token) } }), ctx(planId));
  expect(res.status).toBe(200);
  return (await res.json()) as { items: Array<{ id: string; status: string; duplicate_publishes: Array<Record<string, unknown>>; duplicate_ack_required: boolean }> };
}
/** 다른 계획 A: 실제 계정 항목을 승인·실행(QUEUED — 실제 게시 없음, 작업 처리기를 돌리지 않음) */
async function liveExecuted(variantId: string): Promise<PlanRef> {
  const a = await plan(variantId, liveAccount);
  const ap = await approve(a, 'public_publish');
  expect(ap.status, await ap.clone().text()).toBe(200);
  expect(((await ap.json()) as { duplicate_warnings: unknown[] }).duplicate_warnings).toEqual([]);
  gatesOn();
  const ex = await execute(a);
  expect(ex.status, await ex.clone().text()).toBe(200);
  expect(await ex.json()).toMatchObject({ mode: 'LIVE', duplicate_warnings: [] });
  setGates({});
  return a;
}
const itemOf = async (id: string) => (await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, id)))[0]!;
const jobsOf = (itemId: string) => db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId));
const approvalsOf = (itemId: string) => db.select().from(schema.approvals).where(eq(schema.approvals.distributionItemId, itemId));
const planOf = async (id: string) => (await db.select().from(schema.distributionPlans).where(eq(schema.distributionPlans.id, id)))[0]!;
const auditsOf = (entityId: string) => db.select().from(schema.auditEvents).where(eq(schema.auditEvents.entityId, entityId));
const commandOf = (key: string) => db.select().from(schema.executeCommands).where(and(eq(schema.executeCommands.ownerId, owner), eq(schema.executeCommands.commandKey, key)));

/** 다른 계획 항목의 상태를 직접 만든다(판정은 항목 상태·결과 기록만 본다 — 실제 게시는 하지 않음). */
async function setOtherState(a: PlanRef, state: 'BLOCKED' | 'UNKNOWN' | 'CONFIRMED' | 'FAILED', pub?: 'VERIFIED' | 'USER_CONFIRMED') {
  const [job] = await jobsOf(a.itemId);
  await db.update(schema.jobs).set({ state, leaseOwner: null, leaseUntil: null }).where(eq(schema.jobs.id, job!.id));
  await db.update(schema.distributionItems).set({ status: state }).where(eq(schema.distributionItems.id, a.itemId));
  if (pub) {
    const n = String(Date.now()).slice(-9) + String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    await db.insert(schema.publications).values({
      ownerId: owner,
      itemId: a.itemId,
      jobId: job!.id,
      externalId: `threads:${n}`,
      permalink: `https://www.threads.com/@duptester/post/D${n.slice(-6)}`,
      resultKind: 'PUBLISHED',
      remoteVisibility: pub === 'VERIFIED' ? 'public' : 'unknown',
      verification: pub,
      isMock: false,
      verifiedAt: pub === 'VERIFIED' ? new Date() : null,
      confirmedBy: pub === 'USER_CONFIRMED' ? 'owner' : null,
      confirmedAt: pub === 'USER_CONFIRMED' ? new Date() : null,
    });
  }
}

const config = loadConfig({});
const registry = createMockAdapterRegistry();
async function tick(planId: string, cfg: AppConfig = config) {
  return runJobsTick(db, registry, {
    workerId: 'dup-w',
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

/** 화면 HTML → 태그를 뺀 글자(React 의 텍스트 경계 주석도 뺌, 기본 문자 참조만 되돌림) */
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
const renderNew = async (contentId: string) => renderToStaticMarkup(await NewPlanPage({ searchParams: Promise.resolve({ content_id: contentId }) }));
/** 선택 승인 구역 · 실행 구역 HTML */
const section = (html: string, titleId: string) => {
  const i = html.indexOf(`aria-labelledby="${titleId}"`);
  expect(i, titleId).toBeGreaterThan(-1);
  return html.slice(i, html.indexOf('</section>', i));
};
const dupLine = (otherPlan: string, stage: 'approve' | 'execute' | 'plan', o: { kind: 'published' | 'unknown' | 'in_progress'; status: string; mock?: boolean; verification?: string | null; account?: string | null }) =>
  duplicateWarningLine(
    { itemId: 'x', planId: otherPlan, planSummary: 'Threads 1', status: o.status, kind: o.kind, mock: o.mock ?? false, verification: o.verification ?? null, accountDisplayName: o.account ?? null },
    stage,
  );

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-dup-it-'));
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
    throw new Error('DUP 시험: 네트워크 호출 금지');
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

describe('FIX1-FULLREV2(G2): 실제 계정 — 다른 계획의 같은 글이 이미 게시됨·결과 불명·진행 중이면 확인값 없이는 승인·실행하지 않는다', () => {
  it.each([
    { name: '진행 중(QUEUED — 실제 실행)', state: null, pub: undefined, kind: 'in_progress', status: 'QUEUED', verification: null },
    { name: '진행 중(BLOCKED — 보류, 재개하면 다시 보냄)', state: 'BLOCKED', pub: undefined, kind: 'in_progress', status: 'BLOCKED', verification: null },
    { name: '결과 불명(UNKNOWN)', state: 'UNKNOWN', pub: undefined, kind: 'unknown', status: 'UNKNOWN', verification: null },
    { name: '이미 게시됨(CONFIRMED · VERIFIED 결과)', state: 'CONFIRMED', pub: 'VERIFIED', kind: 'published', status: 'CONFIRMED', verification: 'VERIFIED' },
    { name: '이미 게시됨(CONFIRMED · USER_CONFIRMED 결과)', state: 'CONFIRMED', pub: 'USER_CONFIRMED', kind: 'published', status: 'CONFIRMED', verification: 'USER_CONFIRMED' },
  ] as const)('$name → 계획 JSON 경고 · 승인/실행 확인값 없으면 409(아무것도 안 바뀜) · 있으면 200(감사에 확인 기록)', async (c) => {
    const { variantId } = await reviewVariant(`중복 게시 시험 글 — ${c.name} ${randomUUID().slice(0, 4)}`);
    const a = await liveExecuted(variantId);
    if (c.state) await setOtherState(a, c.state, c.pub);

    // 새 계획 B: 같은 파생본·같은 실제 계정·public·즉시 → payload_hash 도 같다(검토 기록의 재현 그대로)
    const b = await plan(variantId, liveAccount);
    expect(b.hash).toBe(a.hash);

    // GET 계획 B: 다른 계획 A 의 항목이 경고로 보인다(실행 전 실제 항목 → 확인값 필요)
    const jb = await detailJson(b.planId);
    expect(jb.items[0]!.duplicate_ack_required).toBe(true);
    expect(jb.items[0]!.duplicate_publishes).toEqual([
      expect.objectContaining({ item_id: a.itemId, plan_id: a.planId, status: c.status, kind: c.kind, mock: false, account_id: liveAccount, account_kind: 'live', verification: c.verification, match: 'version_account' }),
    ]);
    // 같은 계획의 항목은 영향 없음: A 의 자기 항목은 자기를 중복으로 세지 않고, 아직 실행 전(PLANNED)인 B 도 A 의 중복이 아니다
    const ja = await detailJson(a.planId);
    expect(ja.items[0]!.duplicate_publishes).toEqual([]);
    expect(ja.items[0]!.duplicate_ack_required).toBe(false);

    // 승인 — 확인값 없음·false → 409, 아무것도 바뀌지 않음(승인·감사·계획 상태)
    for (const extra of [{}, { acknowledge_duplicate: false }]) {
      const r = await approve(b, 'public_publish', extra);
      expect(r.status).toBe(409);
      const body = (await r.json()) as { error: string; message: string; items: Array<{ item_id: string; duplicates: Array<Record<string, unknown>> }> };
      expect(body.error).toBe('duplicate_publish_unacknowledged');
      expect(body.message).toBe(DUPLICATE_PUBLISH_UNACKNOWLEDGED_MESSAGE);
      expect(body.items).toEqual([{ item_id: b.itemId, duplicates: [expect.objectContaining({ item_id: a.itemId, plan_id: a.planId, kind: c.kind, status: c.status })] }]);
    }
    expect(await approvalsOf(b.itemId)).toHaveLength(0);
    expect((await auditsOf(b.itemId)).filter((e) => e.action.startsWith('approval.'))).toEqual([]);
    expect((await planOf(b.planId)).status).toBe('draft');
    // JSON boolean 만 — 문자열 "yes" 는 확인값이 아니다(400)
    expect((await approve(b, 'public_publish', { acknowledge_duplicate: 'yes' })).status).toBe(400);
    expect(await approvalsOf(b.itemId)).toHaveLength(0);

    // 확인값 true → 200, 응답에 경고(LIVE), 감사에 중복 수·확인값
    const ok = await approve(b, 'public_publish', { acknowledge_duplicate: true });
    expect(ok.status, await ok.clone().text()).toBe(200);
    const okBody = (await ok.json()) as { approvals: Array<{ id: string }>; duplicate_warnings: Array<{ item_id: string; mode: string; duplicates: Array<Record<string, unknown>> }> };
    expect(okBody.duplicate_warnings).toEqual([{ item_id: b.itemId, mode: 'LIVE', duplicates: [expect.objectContaining({ item_id: a.itemId, plan_id: a.planId, kind: c.kind })] }]);
    const grant = (await auditsOf(okBody.approvals[0]!.id)).find((e) => e.action === 'approval.grant')!;
    expect(grant.sanitizedDetails).toMatchObject({ item_id: b.itemId, duplicates: 1, duplicate_acknowledged: true });

    // 실행 — 확인값 없음 → 409: 작업·항목·실행 키 모두 그대로(같은 키로 확인값과 함께 다시 보내면 실행된다)
    gatesOn();
    const key = `k-${randomUUID()}`;
    const ex409 = await execute(b, {}, key);
    expect(ex409.status).toBe(409);
    const exBody = (await ex409.json()) as { error: string; items: Array<{ item_id: string }> };
    expect(exBody.error).toBe('duplicate_publish_unacknowledged');
    expect(exBody.items.map((x) => x.item_id)).toEqual([b.itemId]);
    expect(await jobsOf(b.itemId)).toHaveLength(0);
    expect((await itemOf(b.itemId)).status).toBe('PLANNED');
    expect(await commandOf(key)).toHaveLength(0);
    expect((await auditsOf(b.planId)).filter((e) => e.action === 'plan.execute')).toEqual([]);

    const ex = await execute(b, { acknowledge_duplicate: true }, key);
    expect(ex.status, await ex.clone().text()).toBe(200);
    const done = (await ex.json()) as { mode: string; queued: Array<{ item_id: string; mode: string }>; duplicate_warnings: Array<{ item_id: string; mode: string }> };
    expect(done.mode).toBe('LIVE');
    expect(done.queued).toEqual([expect.objectContaining({ item_id: b.itemId, mode: 'LIVE' })]);
    expect(done.duplicate_warnings).toEqual([expect.objectContaining({ item_id: b.itemId, mode: 'LIVE' })]);
    expect(await jobsOf(b.itemId)).toHaveLength(1);
    const exAudit = (await auditsOf(b.planId)).find((e) => e.action === 'plan.execute')!;
    expect(exAudit.sanitizedDetails).toMatchObject({ duplicate_items: 1, duplicate_acknowledged: true });
  });

  it('실행은 실제 게시 항목이 있을 때 owner 단위 advisory 잠금을 잡은 뒤 중복을 조회한다(PGlite 는 연결 하나라 동시 실행은 재현 못 함 — 잠금 호출만 확인)', async () => {
    const { variantId } = await reviewVariant(`잠금 시험 글 ${randomUUID().slice(0, 6)}`);
    const a = await liveExecuted(variantId);
    const b = await plan(variantId, liveAccount);
    expect((await approve(b, 'public_publish', { acknowledge_duplicate: true })).status).toBe(200);
    // 모의 항목만 있는 실행은 잠금을 잡지 않는다
    const m = await reviewVariant(`잠금 시험 모의 글 ${randomUUID().slice(0, 6)}`);
    const pm = await plan(m.variantId, mockThreads);
    expect((await approve(pm, 'mock_publish')).status).toBe(200);

    const seen: string[] = [];
    const orig = db.transaction.bind(db);
    const spy = vi.spyOn(db, 'transaction').mockImplementation(((fn: (tx: unknown) => Promise<unknown>, cfg?: unknown) =>
      orig(async (tx) => {
        const ex = tx.execute.bind(tx);
        (tx as unknown as { execute: (q: unknown) => unknown }).execute = (q: unknown) => {
          seen.push(JSON.stringify((q as { queryChunks?: unknown }).queryChunks ?? q));
          return ex(q as never);
        };
        return fn(tx);
      }, cfg as never)) as never);
    try {
      gatesOn();
      expect((await execute(pm)).status).toBe(200);
      expect(seen.filter((s) => s.includes('pg_advisory_xact_lock') && s.includes('cs.duplicate-publish'))).toEqual([]);
      expect((await execute(b, { acknowledge_duplicate: true })).status).toBe(200);
      expect(seen.filter((s) => s.includes('pg_advisory_xact_lock') && s.includes(`cs.duplicate-publish:${owner}`))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
    expect((await itemOf(a.itemId)).status).toBe('QUEUED');
  });
});

describe('FIX1-FULLREV2(G2): 모의 계정은 경고만(막지 않음) · 보내지 않은 끝 상태·실행 전 항목은 세지 않음', () => {
  it('모의 계정: 다른 계획에서 MOCK 처리됨(CONFIRMED·MOCK 결과) → JSON·화면 경고(MOCK 문구, 확인 체크 없음), 확인값 없이 승인·실행 200 + duplicate_warnings(MOCK)', async () => {
    const { variantId } = await reviewVariant(`모의 중복 시험 글 ${randomUUID().slice(0, 6)}`);
    const a = await plan(variantId, mockThreads);
    expect((await approve(a, 'mock_publish')).status).toBe(200);
    expect((await execute(a)).status).toBe(200);
    expect((await tick(a.planId)).results).toEqual({ CONFIRMED: 1 });
    expect((await itemOf(a.itemId)).status).toBe('CONFIRMED');

    // 다른 계정(실제 계정)의 같은 채널 초안은 중복이 아니다(같은 계정에 두 번 나가는 것만) — 확인값 없이 승인 200
    const l = await plan(variantId, liveAccount);
    expect(l.hash).not.toBe(a.hash);
    expect((await detailJson(l.planId)).items[0]!.duplicate_publishes).toEqual([]);
    const apL = await approve(l, 'public_publish');
    expect(apL.status, await apL.clone().text()).toBe(200);
    expect(((await apL.json()) as { duplicate_warnings: unknown[] }).duplicate_warnings).toEqual([]);

    const b = await plan(variantId, mockThreads);
    expect(b.hash).toBe(a.hash);
    const jb = await detailJson(b.planId);
    expect(jb.items[0]!.duplicate_ack_required).toBe(false);
    expect(jb.items[0]!.duplicate_publishes).toEqual([
      expect.objectContaining({ item_id: a.itemId, plan_id: a.planId, status: 'CONFIRMED', kind: 'published', mock: true, account_kind: 'mock', verification: 'MOCK' }),
    ]);

    // 화면: MOCK 문구("게시"라고 하지 않음), 확인 체크박스 없음
    const html = await renderPlan(b.planId);
    const approveSec = section(html, 'approve-title');
    expect(textOf(approveSec)).toContain(dupLine(a.planId, 'approve', { kind: 'published', status: 'CONFIRMED', mock: true, verification: 'MOCK' }));
    expect(textOf(approveSec)).toContain('모의 처리됨(MOCK — 실제 게시 아님)');
    expect(textOf(approveSec)).not.toContain('이미 게시됨');
    expect(html).not.toContain('name="acknowledge_duplicate"');

    const ap = await approve(b, 'mock_publish');
    expect(ap.status, await ap.clone().text()).toBe(200);
    expect(((await ap.json()) as { duplicate_warnings: unknown[] }).duplicate_warnings).toEqual([
      { item_id: b.itemId, mode: 'MOCK', duplicates: [expect.objectContaining({ item_id: a.itemId, kind: 'published', mock: true })] },
    ]);
    // 실행 구역도 MOCK 경고만(체크 없음)
    const html2 = await renderPlan(b.planId);
    expect(textOf(section(html2, 'execute-title'))).toContain(dupLine(a.planId, 'execute', { kind: 'published', status: 'CONFIRMED', mock: true, verification: 'MOCK' }));
    expect(html2).not.toContain('name="acknowledge_duplicate"');
    const ex = await execute(b);
    expect(ex.status, await ex.clone().text()).toBe(200);
    expect(await ex.json()).toMatchObject({ mode: 'MOCK', duplicate_warnings: [{ item_id: b.itemId, mode: 'MOCK' }] });
  });

  it('CANCELED(보내지 않음)·FAILED(보내지 않음)·PLANNED(승인만, 실행 전) 다른 계획 → 경고 없음, 실제 계정도 확인값 없이 승인·실행 200 · 그 뒤 실행 전이던 계획을 실행하면 이번엔 409', async () => {
    const { variantId, contentId } = await reviewVariant(`보내지 않은 중복 시험 글 ${randomUUID().slice(0, 6)}`);
    // A1: 실행 → 취소(QUEUED → CANCELED, not_sent)
    const a1 = await liveExecuted(variantId);
    const c = await cancelPOST(post(`/api/distribution-items/${a1.itemId}/cancel`), ctx(a1.itemId));
    expect(c.status, await c.clone().text()).toBe(200);
    expect((await itemOf(a1.itemId)).status).toBe('CANCELED');
    // A2: 실행 → FAILED(보내지 않음 — 시도 한도 등)
    const a2 = await liveExecuted(variantId);
    await setOtherState(a2, 'FAILED');
    // A3: 승인만(실행 전 PLANNED)
    const a3 = await plan(variantId, liveAccount);
    expect((await approve(a3, 'public_publish')).status).toBe(200);

    const b = await plan(variantId, liveAccount);
    const jb = await detailJson(b.planId);
    expect(jb.items[0]!.duplicate_publishes).toEqual([]);
    expect(jb.items[0]!.duplicate_ack_required).toBe(false);
    // 화면: 경고·확인 체크박스 없음(필요할 때만)
    const html = await renderPlan(b.planId);
    expect(html).not.toContain('data-duplicate-publish');
    expect(html).not.toContain('name="acknowledge_duplicate"');
    const newHtml = await renderNew(contentId);
    expect(newHtml).not.toContain('data-duplicate-publish');

    const ap = await approve(b, 'public_publish');
    expect(ap.status, await ap.clone().text()).toBe(200);
    expect(((await ap.json()) as { duplicate_warnings: unknown[] }).duplicate_warnings).toEqual([]);
    gatesOn();
    const ex = await execute(b);
    expect(ex.status, await ex.clone().text()).toBe(200);
    expect(await ex.json()).toMatchObject({ mode: 'LIVE', duplicate_warnings: [] });

    // 실행 전이던 A3 를 이제 실행하면 B(진행 중 QUEUED)가 중복 — 나중 실행의 검사가 먼저 실행된 쪽을 잡는다
    const ex3 = await execute(a3);
    expect(ex3.status).toBe(409);
    const body3 = (await ex3.json()) as { error: string; items: Array<{ item_id: string; duplicates: Array<Record<string, unknown>> }> };
    expect(body3.error).toBe('duplicate_publish_unacknowledged');
    expect(body3.items).toEqual([{ item_id: a3.itemId, duplicates: [expect.objectContaining({ item_id: b.itemId, plan_id: b.planId, kind: 'in_progress', status: 'QUEUED' })] }]);
    expect(await jobsOf(a3.itemId)).toHaveLength(0);
  });
});

describe('FIX1-FULLREV2(G2): 화면 폼 경로·화면 경고', () => {
  it('배포 계획 화면: 승인 카드·실행 구역에 경고 + 확인 체크박스(실제 항목에 중복이 있을 때만), 폼은 체크 없으면 303 ?error=duplicate_publish_unacknowledged(아무것도 안 바뀜) · 체크하면 승인·실행 · 배포 계획 만들기 줄에도 경고', async () => {
    const { variantId, contentId } = await reviewVariant(`화면 중복 시험 글 ${randomUUID().slice(0, 6)}`);
    const a = await liveExecuted(variantId);

    // 배포 계획 만들기: 채널 초안 줄에 경고(계정 이름 포함 — 그 계정을 고르면 같은 글)
    const newHtml = await renderNew(contentId);
    expect(newHtml).toContain('data-duplicate-publish="plan"');
    expect(textOf(newHtml)).toContain(dupLine(a.planId, 'plan', { kind: 'in_progress', status: 'QUEUED', account: (await listChannelAccounts(db, owner)).find((x) => x.id === liveAccount)!.displayName }));
    expect(newHtml).toContain(`href="/distribute/${a.planId}"`);

    const b = await plan(variantId, liveAccount);
    const html = await renderPlan(b.planId);
    const approveSec = section(html, 'approve-title');
    expect(textOf(approveSec)).toContain(dupLine(a.planId, 'approve', { kind: 'in_progress', status: 'QUEUED' }));
    expect(textOf(approveSec)).toContain('이 글은 계획 「Threads 1」 에서 진행 중(QUEUED) — 다시 승인하면 같은 글이 한 번 더 게시될 수 있습니다');
    expect(approveSec).toContain(`href="/distribute/${a.planId}"`);
    expect(approveSec).toContain('<input type="checkbox" name="acknowledge_duplicate" value="yes"/>');
    expect(textOf(approveSec)).toContain(DUPLICATE_ACK_LABEL);
    // 실행 구역에는 아직 실행할 항목이 없어 경고·체크 없음
    expect(section(html, 'execute-title')).not.toContain('acknowledge_duplicate');

    const fields = { [`item_${b.itemId}`]: 'on', [`hash_${b.itemId}`]: b.hash, [`purpose_${b.itemId}`]: 'public_publish', confirm: 'yes' };
    const r1 = await approvePOST(formPost(`/api/distribution-plans/${b.planId}/approve`, fields), ctx(b.planId));
    expect(r1.status).toBe(303);
    expect(r1.headers.get('location')).toBe(`/distribute/${b.planId}?error=duplicate_publish_unacknowledged`);
    expect(await approvalsOf(b.itemId)).toHaveLength(0);
    // 되돌아온 화면: 허용 목록 문구(서버 오류로 뭉개지지 않음)
    expect(textOf(await renderPlan(b.planId, { error: 'duplicate_publish_unacknowledged' }))).toContain(DISTRIBUTE_ERROR_TEXT.duplicate_publish_unacknowledged!);
    // 다른 값은 확인이 아니다
    const r1b = await approvePOST(formPost(`/api/distribution-plans/${b.planId}/approve`, { ...fields, acknowledge_duplicate: 'on' }), ctx(b.planId));
    expect(r1b.headers.get('location')).toBe(`/distribute/${b.planId}?error=duplicate_publish_unacknowledged`);
    expect(await approvalsOf(b.itemId)).toHaveLength(0);

    const r2 = await approvePOST(formPost(`/api/distribution-plans/${b.planId}/approve`, { ...fields, acknowledge_duplicate: 'yes' }), ctx(b.planId));
    expect(r2.status).toBe(303);
    expect(r2.headers.get('location')).toBe(`/distribute/${b.planId}?approved=1`);
    expect(await approvalsOf(b.itemId)).toHaveLength(1);

    // 실행 구역: 경고(실행 문구) + 실행 폼 안의 확인 체크박스
    const html2 = await renderPlan(b.planId);
    const execSec = section(html2, 'execute-title');
    expect(textOf(execSec)).toContain(dupLine(a.planId, 'execute', { kind: 'in_progress', status: 'QUEUED' }));
    expect(textOf(execSec)).toContain('— 실행하면 같은 글이 한 번 더 게시될 수 있습니다');
    const form = execSec.slice(execSec.indexOf('<form'), execSec.indexOf('</form>'));
    expect(form).toContain('<input type="checkbox" name="acknowledge_duplicate" value="yes"/>');
    expect(section(html2, 'approve-title')).not.toContain('acknowledge_duplicate');

    gatesOn();
    const key = `k-${randomUUID()}`;
    const e1 = await executePOST(formPost(`/api/distribution-plans/${b.planId}/execute`, { command_key: key }), ctx(b.planId));
    expect(e1.status).toBe(303);
    expect(e1.headers.get('location')).toBe(`/distribute/${b.planId}?error=duplicate_publish_unacknowledged`);
    expect(await jobsOf(b.itemId)).toHaveLength(0);
    expect(await commandOf(key)).toHaveLength(0);
    const e2 = await executePOST(formPost(`/api/distribution-plans/${b.planId}/execute`, { command_key: key, acknowledge_duplicate: 'yes' }), ctx(b.planId));
    expect(e2.status).toBe(303);
    expect(e2.headers.get('location')).toBe(`/distribute/${b.planId}?executed=1`);
    expect(await jobsOf(b.itemId)).toHaveLength(1);
  });

  it('결과 불명·사용자 확인 게시 문구: 승인 카드에 "결과 불명"·"이미 게시됨(사용자 확인)"', async () => {
    const v1 = await reviewVariant(`화면 결과 불명 시험 글 ${randomUUID().slice(0, 6)}`);
    const a1 = await liveExecuted(v1.variantId);
    await setOtherState(a1, 'UNKNOWN');
    const b1 = await plan(v1.variantId, liveAccount);
    expect(textOf(section(await renderPlan(b1.planId), 'approve-title'))).toContain(
      '이 글은 계획 「Threads 1」 에서 결과 불명(UNKNOWN — 게시됐을 수 있음) — 다시 승인하면 같은 글이 한 번 더 게시될 수 있습니다',
    );
    const v2 = await reviewVariant(`화면 사용자 확인 시험 글 ${randomUUID().slice(0, 6)}`);
    const a2 = await liveExecuted(v2.variantId);
    await setOtherState(a2, 'CONFIRMED', 'USER_CONFIRMED');
    const b2 = await plan(v2.variantId, liveAccount);
    expect(textOf(section(await renderPlan(b2.planId), 'approve-title'))).toContain(
      '이 글은 계획 「Threads 1」 에서 이미 게시됨(사용자 확인) — 다시 승인하면 같은 글이 한 번 더 게시될 수 있습니다',
    );
    expect(textOf(await renderNew(v2.contentId))).toContain('에서 이미 게시됨(사용자 확인) — 같은 계정으로 다시 계획·승인하면 같은 글이 한 번 더 게시될 수 있습니다');
  });
});

describe('FIX1-FULLREV2(G2): 조회 함수 — 같은 payload_hash 도 같은 글, 새 계획 화면은 계정 무관', () => {
  it('duplicatePublishesForItems: 채널 초안 버전이 달라도 payload_hash 가 같으면 중복(match payload_hash) · 같은 계획은 제외 · duplicatePublishesForVariantVersions 는 계정 무관·모든 계획', async () => {
    const { variantId } = await reviewVariant(`조회 함수 시험 글 ${randomUUID().slice(0, 6)}`);
    const a = await liveExecuted(variantId);
    const [aRow] = await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, a.itemId));
    // 방어선: hash 만 같은 가상 항목(다른 채널 초안 버전·다른 계획) → payload_hash 로 잡힌다
    const other = randomUUID();
    const byHash = await duplicatePublishesForItems(db, owner, [{ id: 'probe', planId: other, variantVersionId: randomUUID(), channelAccountId: randomUUID(), payloadHash: a.hash }]);
    expect(byHash.get('probe')).toEqual([expect.objectContaining({ itemId: a.itemId, planId: a.planId, match: 'payload_hash', kind: 'in_progress' })]);
    // 같은 계획이면 제외(자기 자신)
    const self = await duplicatePublishesForItems(db, owner, [aRow!]);
    expect(self.get(a.itemId)).toEqual([]);
    // 같은 버전·같은 계정 → version_account
    const byVersion = await duplicatePublishesForItems(db, owner, [{ ...aRow!, id: 'probe2', planId: other }]);
    expect(byVersion.get('probe2')).toEqual([expect.objectContaining({ itemId: a.itemId, match: 'version_account' })]);
    // 같은 버전·다른 계정 · hash 다름 → 중복 아님
    const otherAccount = await duplicatePublishesForItems(db, owner, [{ ...aRow!, id: 'probe3', planId: other, channelAccountId: mockThreads, payloadHash: 'f'.repeat(64) }]);
    expect(otherAccount.get('probe3')).toEqual([]);
    // 새 계획 화면: 버전만(계정 무관), 없으면 []
    const byV = await duplicatePublishesForVariantVersions(db, owner, [aRow!.variantVersionId, randomUUID()]);
    expect(byV.get(aRow!.variantVersionId)).toEqual([expect.objectContaining({ itemId: a.itemId, accountId: liveAccount, accountKind: 'live', mock: false })]);
    expect([...byV.values()].filter((v) => v.length === 0)).toHaveLength(1);
    // 다른 owner 의 자료는 보지 않는다
    const stranger = await duplicatePublishesForItems(db, randomUUID(), [{ ...aRow!, id: 'probe4', planId: other }]);
    expect(stranger.get('probe4')).toEqual([]);
  });
});
