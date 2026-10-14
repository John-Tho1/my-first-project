/**
 * LIVEP1-USERCONFIRM: 결과 불명 실제 Threads 게시의 "Threads에서 확인함"(사용자 확인) — 실제 POST route handler 로 끝까지.
 * - 결과 불명 상태는 실제 흐름으로 만든다: 승인 → 실행 → 작업 처리기 → 실제 어댑터(주입 fixture fetch: 게시 시간 초과) → 재확인(목록 fixture)이
 *   확인 후보를 이력에 남김 → RECONCILING/UNKNOWN.
 * - 사용자 확인 route 는 네트워크를 쓰지 않는다: 호출 동안 전역 fetch 를 "부르면 실패"로 바꿔 0회를 확인하고, fixture fetch 호출 수도 그대로인지 본다.
 * - 토큰·시크릿·code 는 모두 가짜(FAKE_…), ID 는 가짜 숫자. setupFiles 가드가 실제 Threads·Meta 요청을 막는다.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  closeDb,
  createContent,
  createVariantDraft,
  getDb,
  getPlanDetail,
  liveApprovalUsage,
  readOwnerTables,
  listChannelAccounts,
  runJobsTick,
  runRestoreDrill,
  schema,
  seed,
  setMockScenario,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { checkIntegrity, livePublishReadiness, loadConfig, type AppConfig, type Channel } from '@cs/domain';
import {
  createMockAdapterRegistry,
  LiveCapableAdapterRegistry,
  LiveThreadsPublishAdapter,
  LocalStorageAdapter,
  THREADS_LONG_LIVED_URL,
  THREADS_ME_URL,
  THREADS_TOKEN_URL,
} from '@cs/providers';
import { POST as accountsPOST } from '../../apps/web/app/api/channel-accounts/route';
import { POST as connectPOST } from '../../apps/web/app/api/channel-accounts/[id]/connect/route';
import { POST as targetPOST } from '../../apps/web/app/api/channel-accounts/[id]/publish-target/route';
import { GET as callbackGET } from '../../apps/web/app/api/oauth/callback/route';
import { POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { POST as approvePOST } from '../../apps/web/app/api/distribution-plans/[id]/approve/route';
import { POST as executePOST } from '../../apps/web/app/api/distribution-plans/[id]/execute/route';
import { POST as retryPOST } from '../../apps/web/app/api/distribution-items/[id]/retry/route';
import { POST as reconcilePOST } from '../../apps/web/app/api/distribution-items/[id]/reconcile/route';
import { POST as cancelPOST } from '../../apps/web/app/api/distribution-items/[id]/cancel/route';
import { POST as userConfirmPOST } from '../../apps/web/app/api/distribution-items/[id]/user-confirm/route';
import { liveCandidateForCard, liveItemHeadline, liveVerificationLabel, userConfirmCandidateForCard } from '../../apps/web/lib/distribution';
import { jobCredentials } from '../../apps/web/lib/oauth';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const A = 'owner-uc@example.local';
const KEY = randomBytes(32).toString('base64');
const APP_ID = '000000000000001';
const SECRET = 'FAKE_app_secret_USERCONFIRM_integration_only';
const SHORT = 'FAKE_short_token_USERCONFIRM_it_ssssssssss';
const LONG = 'FAKE_long_token_USERCONFIRM_it_publish_lllll';
const REDIRECT = `${BASE}/api/oauth/callback`;
const PROFILE_ID = '17841400000000088';
const MIN = 60_000;

let db: Db;
let owner: string;
let token: string;
let tmp: string;
let liveAccount: string;
const mockAcc = {} as Record<Channel, string>;

const OAUTH_ENV = { OAUTH_MODE: 'live', THREADS_APP_ID: APP_ID, THREADS_APP_SECRET: SECRET, OAUTH_REDIRECT_URI: REDIRECT, OAUTH_LIVE_APPROVAL_REF: 'D31' } as const;
const GATE_KEYS = ['PUBLISH_MODE', 'PUBLISH_LIVE_APPROVAL_REF', 'PUBLISH_LIVE_MAX_POSTS'] as const;
const setGates = (g: Partial<Record<(typeof GATE_KEYS)[number], string>>) => {
  for (const k of GATE_KEYS) vi.stubEnv(k, g[k] ?? '');
};
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (p: string, body: unknown = {}) => jsonPost(p, body, cookieHeader(token));
const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
// 실행 앞선 검사(pendingLiveJobs)는 다른 계획의 끝나지 않은 실제 작업도 보수적으로 센다 — 이 파일의 QUEUED·RECONCILING 남은 작업 때문에 상한을 넉넉히.
const fullCfg = (ref: string, max = '5') => {
  setGates({ PUBLISH_MODE: 'enabled', PUBLISH_LIVE_APPROVAL_REF: ref, PUBLISH_LIVE_MAX_POSTS: max });
  return loadConfig();
};

// ---- 실제 게시 fixture(주입 fetch) ----
type Reply = (() => Response | Promise<Response>) | Error;
let idSeq = 500;
const nextId = () => `18000000000${String(++idSeq).padStart(6, '0')}`;
function publishFixture(routes: (ids: { ct: string; media: string }) => Record<string, Reply>) {
  const ids = { ct: nextId(), media: nextId() };
  const calls: string[] = [];
  const table = routes(ids);
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    calls.push(key);
    const r = table[key];
    if (!r) throw new Error(`fixture 없음: ${key}`);
    if (r instanceof Error) throw r;
    return r();
  });
  return { fetch, calls, ids };
}
const permalinkOf = (media: string) => `https://www.threads.com/@uctester/post/${media.slice(-6)}`;
const timeoutErr = () => Object.assign(new Error('timeout'), { name: 'TimeoutError' });
const ts = (ms: number) => new Date(ms).toISOString().replace('Z', '+0000');

function registryWith(fetch: (input: string, init?: RequestInit) => Promise<Response>, config: AppConfig) {
  const gate = () => livePublishReadiness(config);
  return new LiveCapableAdapterRegistry(createMockAdapterRegistry(), new LiveThreadsPublishAdapter({ gate, fetch, pollIntervalMs: 0 }), gate);
}
let vt = 0;
/** 이 계획의 작업만 처리(다른 시험의 작업과 섞이지 않게). */
async function tick(registry: LiveCapableAdapterRegistry, config: AppConfig, planId: string, advanceMs = 0) {
  vt += advanceMs;
  return runJobsTick(db, registry, {
    workerId: 'uc-w',
    config,
    ownerId: owner,
    planId,
    clock: () => new Date(Date.now() + vt),
    random: () => 0.5,
    submitTimeoutMs: 5000,
    maxJobs: 5,
    credentials: jobCredentials(config, db),
  });
}

async function reviewVariant(body: string): Promise<string> {
  const { content } = await createContent(db, owner, { title: `UC ${randomUUID().slice(0, 6)}`, body });
  const { variant } = await createVariantDraft(db, owner, content.id, { channel: 'threads', baseVersion: 1 });
  await setVariantLifecycle(db, owner, variant.id, { lifecycle: 'review', baseVersion: 1 });
  return variant.id;
}
async function planApproved(body: string, accountId = liveAccount, purpose = 'public_publish'): Promise<{ planId: string; itemId: string }> {
  const variantId = await reviewVariant(body);
  const res = await plansPOST(post('/api/distribution-plans', { items: [{ variant_id: variantId, channel_account_id: accountId }] }));
  expect(res.status, await res.clone().text()).toBe(201);
  const p = (await res.json()) as { plan: { id: string }; items: Array<{ id: string; payload_hash: string }> };
  const it0 = p.items[0]!;
  const ap = await approvePOST(
    post(`/api/distribution-plans/${p.plan.id}/approve`, { item_ids: [it0.id], expected_hashes: { [it0.id]: it0.payload_hash }, confirm: true, purpose }),
    ctx(p.plan.id),
  );
  expect(ap.status, await ap.clone().text()).toBe(200);
  return { planId: p.plan.id, itemId: it0.id };
}
const execute = async (planId: string) => executePOST(post(`/api/distribution-plans/${planId}/execute`, { command_key: `k-${randomUUID()}` }), ctx(planId));
const jobOf = async (itemId: string) => (await db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)).orderBy(asc(schema.jobs.createdAt)))[0]!;
const itemOf = async (itemId: string) => (await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, itemId)))[0]!;
const planOf = async (planId: string) => (await db.select().from(schema.distributionPlans).where(eq(schema.distributionPlans.id, planId)))[0]!;
const pubsOf = (itemId: string) => db.select().from(schema.publications).where(eq(schema.publications.itemId, itemId));
const eventsOf = (jobId: string) => db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId)).orderBy(asc(schema.jobEvents.eventSeq));

/**
 * 실제 흐름으로 결과 불명 실제 게시를 만든다: 게시 시간 초과(표식 뒤) → 목록 재확인.
 * candidate=true 면 목록에 같은 본문이 표식 시각 +30초에 정확히 1개(확인 후보), false 면 다른 글만(후보 없음).
 * until = 'RECONCILING'(재확인 1회 — 후보를 남긴 RECONCILING) | 'UNKNOWN'(확인 한도까지).
 */
async function ambiguousLivePost(text: string, ref: string, opts: { candidate: boolean; until: 'RECONCILING' | 'UNKNOWN' }) {
  const { planId, itemId } = await planApproved(text);
  const config = fullCfg(ref);
  expect((await execute(planId)).status).toBe(200);
  let attemptAt = 0;
  const fx = publishFixture((ids) => ({
    [`POST /v1.0/${PROFILE_ID}/threads`]: () => jsonRes(200, { id: ids.ct }),
    [`GET /v1.0/${ids.ct}`]: () => jsonRes(200, { status: 'FINISHED', id: ids.ct }),
    [`POST /v1.0/${PROFILE_ID}/threads_publish`]: timeoutErr(),
    [`GET /v1.0/${PROFILE_ID}/threads`]: () =>
      jsonRes(200, {
        data: opts.candidate
          ? [
              { id: ids.media, text, timestamp: ts(attemptAt + 30_000), permalink: permalinkOf(ids.media) },
              { id: '18000000000999997', text: '다른 글', timestamp: ts(attemptAt) },
            ]
          : [{ id: '18000000000999996', text: '다른 글', timestamp: ts(attemptAt) }],
      }),
  }));
  const reg = registryWith(fx.fetch, config);
  expect((await tick(reg, config, planId)).results).toEqual({ RECONCILING: 1 });
  attemptAt = (await db.select().from(schema.remoteSteps).where(and(eq(schema.remoteSteps.itemId, itemId), eq(schema.remoteSteps.kind, 'publish_attempt'))))[0]!.createdAt.getTime();
  let last: Record<string, number> = await tick(reg, config, planId, 20 * MIN).then((r) => r.results);
  if (opts.until === 'UNKNOWN') for (let i = 0; i < 4 && !last.UNKNOWN; i++) last = (await tick(reg, config, planId, 20 * MIN)).results;
  expect(last).toEqual({ [opts.until]: 1 });
  expect((await itemOf(itemId)).status).toBe(opts.until);
  expect(await pubsOf(itemId)).toHaveLength(0);
  setGates({}); // 사용자 확인은 실제 게시 조건과 무관(외부 호출 없음) — 잠금 상태(D38 2단계 뒤)와 같게 닫아 둔다
  return { planId, itemId, fx, candidateId: `threads:${fx.ids.media}`, permalink: permalinkOf(fx.ids.media), config };
}

/** 사용자 확인 route 호출 — 그 동안 전역 fetch 는 "부르면 실패"(0회 확인). */
async function confirmJson(itemId: string, candidateId: string | undefined) {
  const spy = vi.fn(async () => {
    throw new Error('사용자 확인은 네트워크를 쓰지 않아야 합니다');
  });
  vi.stubGlobal('fetch', spy);
  try {
    const res = await userConfirmPOST(post(`/api/distribution-items/${itemId}/user-confirm`, candidateId === undefined ? {} : { candidate_external_id: candidateId }), ctx(itemId));
    return { res, body: (await res.clone().json()) as Record<string, unknown>, fetchCalls: spy.mock.calls.length };
  } finally {
    vi.unstubAllGlobals();
  }
}

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
      if (key === `GET ${THREADS_ME_URL}`) return jsonRes(200, { id: PROFILE_ID, username: 'uctester' });
      throw new Error(`fixture 없음: ${key}`);
    }),
  );
  const u = new URL(REDIRECT);
  u.searchParams.set('code', 'FAKE_code_USERCONFIRM_it_cccccccccccc');
  u.searchParams.set('state', state);
  const cb = await callbackGET(new Request(u.toString(), { headers: { accept: 'application/json', ...cookieHeader(token) } }));
  expect(cb.status, await cb.clone().text()).toBe(200);
  vi.unstubAllGlobals();
  for (const k of Object.keys(OAUTH_ENV)) vi.stubEnv(k, '');
  const on = await targetPOST(post(`/api/channel-accounts/${account.id}/publish-target`, { enabled: true }), ctx(account.id));
  expect(on.status, await on.clone().text()).toBe(200);
  return account.id;
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-uc-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('EXPORT_LOCAL_DIR', path.join(tmp, 'exports'));
  vi.stubEnv('SECRETS_MASTER_KEY', KEY);
  vi.stubEnv('SECRETS_KEY_VERSION', '1');
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  db = (await getDb(loadConfig())).db;
  owner = (await seed(db, { allowedIdentity: A })).ownerId;
  Object.assign(mockAcc, Object.fromEntries((await listChannelAccounts(db, owner)).map((a) => [a.platform, a.id])));
  token = await login(A);
  liveAccount = await connectLiveAccount();
});
beforeEach(() => {
  setGates({});
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
  await closeDb();
});

describe('Threads에서 확인함 — 성공', () => {
  it('UNKNOWN + 확인 후보 → 200: 결과(USER_CONFIRMED, VERIFIED 아님)·CONFIRMED·이력 user_confirmed·감사·계획 completed, 네트워크 0, 게시 수 그대로, 그 뒤 재시도·취소·재확인 409', async () => {
    const s = await ambiguousLivePost('사용자 확인 성공 시험 글.', 'UC-ok', { candidate: true, until: 'UNKNOWN' });
    const jobBefore = await jobOf(s.itemId);
    const usageBefore = await liveApprovalUsage(db, 'UC-ok', null);
    const fxBefore = s.fx.calls.length;

    // 화면: 버튼을 보일 조건(서버 판정과 같은 규칙)
    const d0 = (await getPlanDetail(db, owner, s.planId))!.items[0]!;
    expect(userConfirmCandidateForCard(d0)).toEqual({ external_id: s.candidateId, permalink: s.permalink });

    const r = await confirmJson(s.itemId, s.candidateId);
    expect(r.res.status, JSON.stringify(r.body)).toBe(200);
    expect(r.fetchCalls).toBe(0);
    expect(s.fx.calls.length).toBe(fxBefore);
    expect(r.body).toMatchObject({ item_id: s.itemId, job_id: jobBefore.id, state_before: 'UNKNOWN', state: 'CONFIRMED', verification: 'USER_CONFIRMED', external_id: s.candidateId, permalink: s.permalink });

    const pubs = await pubsOf(s.itemId);
    expect(pubs).toHaveLength(1);
    expect(pubs[0]).toMatchObject({
      jobId: jobBefore.id,
      isMock: false,
      verification: 'USER_CONFIRMED',
      verifiedAt: null,
      confirmedBy: 'owner',
      externalId: s.candidateId,
      permalink: s.permalink,
      resultKind: 'PUBLISHED',
      remoteVisibility: 'unknown',
    });
    expect(pubs[0]!.confirmedAt).toBeInstanceOf(Date);

    const job = await jobOf(s.itemId);
    expect(job).toMatchObject({ state: 'CONFIRMED', leaseOwner: null, leaseUntil: null, attempt: jobBefore.attempt });
    expect(job.doneAt).not.toBeNull();
    expect((await itemOf(s.itemId)).status).toBe('CONFIRMED');
    expect((await planOf(s.planId)).status).toBe('completed');
    const events = await eventsOf(job.id);
    const last = events.at(-1)!;
    expect(last).toMatchObject({ stateBefore: 'UNKNOWN', stateAfter: 'CONFIRMED' });
    expect(last.sanitizedDetails).toMatchObject({ event: 'user_confirmed', confirmed_by: 'owner', external_id: s.candidateId, verification: 'USER_CONFIRMED' });
    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.action, 'item.user_confirm'), eq(schema.auditEvents.entityId, s.itemId)));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.sanitizedDetails).toMatchObject({ job_id: job.id, from: 'UNKNOWN', external_id: s.candidateId, verification: 'USER_CONFIRMED' });

    // D38 게시 수: 사용자 확인은 전송 의도를 만들지 않는다(같은 승인 기록의 사용 수 그대로)
    expect(await liveApprovalUsage(db, 'UC-ok', null)).toEqual(usageBefore);
    expect(await db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, job.id))).toHaveLength(job.attempt);
    expect(s.fx.calls.filter((c) => c.endsWith('threads_publish'))).toHaveLength(1);

    // 끝난 항목: 재시도·취소·재확인 모두 409(다시 보내지 않음)
    expect((await retryPOST(post(`/api/distribution-items/${s.itemId}/retry`), ctx(s.itemId))).status).toBe(409);
    expect((await cancelPOST(post(`/api/distribution-items/${s.itemId}/cancel`), ctx(s.itemId))).status).toBe(409);
    const rc = await reconcilePOST(post(`/api/distribution-items/${s.itemId}/reconcile`), ctx(s.itemId));
    expect(rc.status).toBe(409);
    expect(((await rc.json()) as { error: string }).error).toBe('nothing_to_reconcile');
    // 작업 처리기도 다시 집지 않는다
    const cfg = fullCfg('UC-ok');
    expect((await tick(registryWith(s.fx.fetch, cfg), cfg, s.planId, 30 * MIN)).leased).toBe(0);
    expect(s.fx.calls.length).toBe(fxBefore);

    // 화면 문구: "사용자 확인" — VERIFIED 문구 아님, MOCK 아님
    const d = (await getPlanDetail(db, owner, s.planId))!.items[0]!;
    const headline = liveItemHeadline({ status: d.item.status, channel: 'threads', job: d.jobs.at(-1) ?? null, pub: d.publications[0] ?? null, blockReason: null, verification: d.publications[0]!.verification });
    expect(headline).toContain('사용자 확인');
    expect(headline).not.toContain(liveVerificationLabel('VERIFIED', s.permalink));
    expect(headline).not.toContain('MOCK');
    expect(userConfirmCandidateForCard(d)).toBeNull();

    // 두 번째 확인(같은 후보) → 409 이미 결과 있음, 결과는 여전히 1개
    const again = await confirmJson(s.itemId, s.candidateId);
    expect(again.res.status).toBe(409);
    expect(again.body.error).toBe('user_confirm_already_published');
    expect(again.fetchCalls).toBe(0);
    expect(await pubsOf(s.itemId)).toHaveLength(1);
  });

  it('RECONCILING(재확인 1회가 후보를 남김) + 화면 폼 → 303 user_confirmed=1, CONFIRMED·USER_CONFIRMED', async () => {
    const s = await ambiguousLivePost('확인 중 항목 사용자 확인 시험 글.', 'UC-form', { candidate: true, until: 'RECONCILING' });
    const spy = vi.fn(async () => {
      throw new Error('네트워크 금지');
    });
    vi.stubGlobal('fetch', spy);
    const res = await userConfirmPOST(
      new Request(`${BASE}/api/distribution-items/${s.itemId}/user-confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', ...ORIGIN_HEADERS, ...cookieHeader(token) },
        body: new URLSearchParams({ plan_id: s.planId, candidate_external_id: s.candidateId }).toString(),
      }),
      ctx(s.itemId),
    );
    vi.unstubAllGlobals();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/distribute/${s.planId}?user_confirmed=1`);
    expect(spy).not.toHaveBeenCalled();
    expect((await itemOf(s.itemId)).status).toBe('CONFIRMED');
    expect((await pubsOf(s.itemId))[0]).toMatchObject({ verification: 'USER_CONFIRMED', confirmedBy: 'owner' });
    expect((await eventsOf((await jobOf(s.itemId)).id)).at(-1)).toMatchObject({ stateBefore: 'RECONCILING', stateAfter: 'CONFIRMED' });
    expect((await planOf(s.planId)).status).toBe('completed');
  });

  it('동시 두 번 제출(PGlite 한 연결) → 결과 정확히 1개, 하나는 200 하나는 409, user_confirmed 이력 1개', async () => {
    const s = await ambiguousLivePost('동시 사용자 확인 시험 글.', 'UC-race', { candidate: true, until: 'UNKNOWN' });
    const spy = vi.fn(async () => {
      throw new Error('네트워크 금지');
    });
    vi.stubGlobal('fetch', spy);
    const call = () => userConfirmPOST(post(`/api/distribution-items/${s.itemId}/user-confirm`, { candidate_external_id: s.candidateId }), ctx(s.itemId));
    const [a, b] = await Promise.all([call(), call()]);
    vi.unstubAllGlobals();
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(['user_confirm_already_published', 'user_confirm_not_pending']).toContain(((await loser.json()) as { error: string }).error);
    expect(spy).not.toHaveBeenCalled();
    expect(await pubsOf(s.itemId)).toHaveLength(1);
    const events = await eventsOf((await jobOf(s.itemId)).id);
    expect(events.filter((e) => e.sanitizedDetails.event === 'user_confirmed')).toHaveLength(1);
  });

  it('내보내기 → 빈 DB 복원 → 비교(복원 훈련): USER_CONFIRMED 결과·확인자·시각이 묶음 규칙·DB CHECK 를 통과하고 그대로 들어간다', async () => {
    const pubs = await db.select().from(schema.publications).where(eq(schema.publications.verification, 'USER_CONFIRMED'));
    expect(pubs.length).toBeGreaterThan(0);
    // 묶음 무결성: 내보낸 표는 통과, 사용자 확인의 모양을 바꾸면(확인 시각 없음·verified_at 붙임·링크 없음) 거부
    const { tables } = await readOwnerTables(db, owner);
    const ucRow = tables.publications.find((p) => p.verification === 'USER_CONFIRMED')!;
    expect(ucRow).toMatchObject({ confirmed_by: 'owner', is_mock: false, verified_at: null });
    expect(typeof ucRow.confirmed_at).toBe('string');
    expect(() => checkIntegrity(tables)).not.toThrow();
    const tampered = (patch: Record<string, unknown>) => {
      const t = structuredClone(tables);
      Object.assign(t.publications.find((p) => p.id === ucRow.id)!, patch);
      return () => checkIntegrity(t);
    };
    for (const patch of [{ confirmed_at: null }, { confirmed_by: null }, { verified_at: ucRow.confirmed_at }, { permalink: null }, { verification: 'UNVERIFIED' }]) {
      expect(tampered(patch), JSON.stringify(patch)).toThrow(expect.objectContaining({ code: 'integrity' }));
    }
    const r = await runRestoreDrill(db, new LocalStorageAdapter(path.join(tmp, 'assets')), owner, { trigger: 'test', tmpRoot: tmp });
    expect(r.mismatches).toEqual([]);
    expect(r.result).toBe('pass');
  });
});

// FIX-LIVEP1-USERCONFIRM(Codex review-LIVEP1-USERCONFIRM P2 lib/distribution.ts:741): 화면 이력은 최근 10개만 — 후보를 남긴 재확인 이력이 그 밖으로
// 밀려나도 카드의 후보·버튼은 서버(route)와 같은 조회(가장 최근 작업의 가장 최근 재확인 이력)로 정해야 한다.
describe('FIX-LIVEP1-USERCONFIRM: 후보 이력이 화면 이력(최근 10개) 밖으로 밀려나도 카드와 서버가 같은 판단', () => {
  /** 재확인이 아닌 이력(details.reconcile 없음)을 n 개 덧붙인다 — 상태는 그대로. */
  async function addOrdinaryEvents(itemId: string, n: number) {
    const job = await jobOf(itemId);
    const seq = (await db.select({ n: sql<number>`coalesce(max(${schema.jobEvents.eventSeq}), 0)::int` }).from(schema.jobEvents).where(eq(schema.jobEvents.jobId, job.id)))[0]!.n;
    for (let i = 1; i <= n; i++) {
      await db.insert(schema.jobEvents).values({ ownerId: owner, jobId: job.id, eventSeq: seq + i, stateBefore: job.state, stateAfter: job.state, sanitizedDetails: { event: 'note', note: i } });
    }
  }

  it('후보 재확인 뒤 일반 이력 12개 → 카드에 후보·버튼이 그대로 보이고, 서버도 허용(200)', async () => {
    const s = await ambiguousLivePost('후보 이력이 밀려나는 시험 글.', 'UC-scroll', { candidate: true, until: 'UNKNOWN' });
    await addOrdinaryEvents(s.itemId, 12);
    const d = (await getPlanDetail(db, owner, s.planId))!.items[0]!;
    expect(d.events.some((e) => typeof e.sanitizedDetails.reconcile === 'string')).toBe(false); // 화면 이력(최근 10개)에는 재확인 이력이 없다
    expect(userConfirmCandidateForCard(d)).toEqual({ external_id: s.candidateId, permalink: s.permalink });
    expect(liveCandidateForCard(d)).toEqual({ externalId: s.candidateId, permalink: s.permalink });
    const r = await confirmJson(s.itemId, s.candidateId);
    expect(r.res.status, JSON.stringify(r.body)).toBe(200);
    expect(r.fetchCalls).toBe(0);
    expect((await pubsOf(s.itemId))[0]).toMatchObject({ verification: 'USER_CONFIRMED', externalId: s.candidateId });
  });

  it('가장 최근 재확인에 후보가 없으면(그 뒤 일반 이력 12개) 카드에도 후보·버튼 없음, 서버도 409 user_confirm_no_candidate', async () => {
    const s = await ambiguousLivePost('최근 재확인에 후보가 없는 시험 글.', 'UC-scroll-none', { candidate: true, until: 'UNKNOWN' });
    // 후보를 남긴 재확인 뒤에 후보 없는 재확인(예: 목록에 같은 글 0개)이 왔다
    const job = await jobOf(s.itemId);
    const seq = (await db.select({ n: sql<number>`coalesce(max(${schema.jobEvents.eventSeq}), 0)::int` }).from(schema.jobEvents).where(eq(schema.jobEvents.jobId, job.id)))[0]!.n;
    await db.insert(schema.jobEvents).values({ ownerId: owner, jobId: job.id, eventSeq: seq + 1, stateBefore: 'UNKNOWN', stateAfter: 'UNKNOWN', sanitizedDetails: { event: 'reconcile_retry', reconcile: 'unknown', manual: true } });
    await addOrdinaryEvents(s.itemId, 12);
    const d = (await getPlanDetail(db, owner, s.planId))!.items[0]!;
    expect(liveCandidateForCard(d)).toBeNull();
    expect(userConfirmCandidateForCard(d)).toBeNull();
    const r = await confirmJson(s.itemId, s.candidateId);
    expect(r.res.status).toBe(409);
    expect(r.body.error).toBe('user_confirm_no_candidate');
    expect(await pubsOf(s.itemId)).toHaveLength(0);
  });
});

describe('Threads에서 확인함 — 409(아무것도 바꾸지 않음, 네트워크 0)', () => {
  async function expectRefused(itemId: string, candidateId: string | undefined, code: string) {
    const before = { item: await itemOf(itemId), pubs: await pubsOf(itemId), job: await jobOf(itemId).catch(() => null) };
    const r = await confirmJson(itemId, candidateId);
    expect(r.res.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.error).toBe(code);
    expect(r.fetchCalls).toBe(0);
    expect((await itemOf(itemId)).status).toBe(before.item.status);
    expect(await pubsOf(itemId)).toHaveLength(before.pubs.length);
    if (before.job) expect((await jobOf(itemId)).state).toBe(before.job.state);
  }

  it('확인 후보 없음(목록에 같은 글 없음) → user_confirm_no_candidate', async () => {
    const s = await ambiguousLivePost('후보가 없는 결과 불명 글.', 'UC-nocand', { candidate: false, until: 'UNKNOWN' });
    const d = (await getPlanDetail(db, owner, s.planId))!.items[0]!;
    expect(userConfirmCandidateForCard(d)).toBeNull();
    await expectRefused(s.itemId, 'threads:18000000000999996', 'user_confirm_no_candidate');
  });

  it('요청한 후보 ID 가 이력의 후보와 다름(낡은 화면) → user_confirm_candidate_mismatch · 형식이 틀리면 400', async () => {
    const s = await ambiguousLivePost('후보 불일치 시험 글.', 'UC-mismatch', { candidate: true, until: 'UNKNOWN' });
    await expectRefused(s.itemId, 'threads:18000000000999995', 'user_confirm_candidate_mismatch');
    const bad = await confirmJson(s.itemId, 'threads:abc');
    expect(bad.res.status).toBe(400);
    const none = await confirmJson(s.itemId, undefined);
    expect(none.res.status).toBe(400);
    expect(await pubsOf(s.itemId)).toHaveLength(0);
  });

  it('모의 계정 항목(결과 불명 모의 시나리오) → user_confirm_not_live — 모의 결과는 사용자 확인이 될 수 없음', async () => {
    const { planId, itemId } = await planApproved('모의 계정 결과 불명 글.', mockAcc.threads, 'mock_publish');
    const config = fullCfg('UC-mock');
    expect((await execute(planId)).status).toBe(200);
    await setMockScenario(db, owner, itemId, { scenario: 'ambiguous_sent' });
    const fx = publishFixture(() => ({}));
    expect((await tick(registryWith(fx.fetch, config), config, planId)).results).toEqual({ RECONCILING: 1 });
    expect(fx.calls).toHaveLength(0);
    setGates({});
    await expectRefused(itemId, 'threads:18000000000999994', 'user_confirm_not_live');
    const d = (await getPlanDetail(db, owner, planId))!.items[0]!;
    expect(userConfirmCandidateForCard(d)).toBeNull();
  });

  it('이미 결과가 있음(정상 게시 VERIFIED) → user_confirm_already_published', async () => {
    const TEXT = '정상 게시된 글.';
    const { planId, itemId } = await planApproved(TEXT);
    const config = fullCfg('UC-verified');
    expect((await execute(planId)).status).toBe(200);
    const fx = publishFixture((ids) => ({
      [`POST /v1.0/${PROFILE_ID}/threads`]: () => jsonRes(200, { id: ids.ct }),
      [`GET /v1.0/${ids.ct}`]: () => jsonRes(200, { status: 'FINISHED', id: ids.ct }),
      [`POST /v1.0/${PROFILE_ID}/threads_publish`]: () => jsonRes(200, { id: ids.media }),
      [`GET /v1.0/${ids.media}`]: () => jsonRes(200, { id: ids.media, permalink: permalinkOf(ids.media), text: TEXT, timestamp: ts(Date.now()), media_type: 'TEXT_POST' }),
    }));
    expect((await tick(registryWith(fx.fetch, config), config, planId)).results).toEqual({ CONFIRMED: 1 });
    setGates({});
    expect((await pubsOf(itemId))[0]!.verification).toBe('VERIFIED');
    await expectRefused(itemId, `threads:${fx.ids.media}`, 'user_confirm_already_published');
    expect((await pubsOf(itemId))[0]!.verification).toBe('VERIFIED');
  });

  it('UNKNOWN·RECONCILING 이 아님(실행 직후 QUEUED) → user_confirm_not_pending', async () => {
    const { planId, itemId } = await planApproved('대기 중 실제 게시 글.');
    fullCfg('UC-queued');
    expect((await execute(planId)).status).toBe(200);
    setGates({});
    expect((await jobOf(itemId)).state).toBe('QUEUED');
    await expectRefused(itemId, 'threads:18000000000999993', 'user_confirm_not_pending');
  });

  it('게시 시도 표식 없음(후보가 있는 RECONCILING 이지만 threads_publish 를 시도한 적 없음) → user_confirm_no_attempt', async () => {
    const { planId, itemId } = await planApproved('표식 없는 결과 불명 글.');
    fullCfg('UC-nomarker');
    expect((await execute(planId)).status).toBe(200);
    setGates({});
    // 표식 없이 확인 중이 된 작업(예: 표식 전 lease 만료)을 DB 로 직접 만든다 — 이력에는 형식이 맞는 후보까지 남긴다.
    const job = await jobOf(itemId);
    await db.update(schema.jobs).set({ state: 'RECONCILING' }).where(eq(schema.jobs.id, job.id));
    await db.update(schema.distributionItems).set({ status: 'RECONCILING' }).where(eq(schema.distributionItems.id, itemId));
    const seq = (await db.select({ n: sql<number>`coalesce(max(${schema.jobEvents.eventSeq}), 0)::int` }).from(schema.jobEvents).where(eq(schema.jobEvents.jobId, job.id)))[0]!.n;
    const cand = 'threads:18000000000999992';
    await db.insert(schema.jobEvents).values({
      ownerId: owner,
      jobId: job.id,
      eventSeq: seq + 1,
      stateBefore: 'RECONCILING',
      stateAfter: 'RECONCILING',
      sanitizedDetails: { event: 'reconcile_retry', reconcile: 'unknown', candidate_external_id: cand, candidate_permalink: permalinkOf('18000000000999992') },
    });
    const d = (await getPlanDetail(db, owner, planId))!.items[0]!;
    expect(userConfirmCandidateForCard(d)).toBeNull();
    await expectRefused(itemId, cand, 'user_confirm_no_attempt');
  });

  it('같은 출처 확인·로그인 필요: 다른 출처 403, 세션 없음 401(아무것도 바꾸지 않음)', async () => {
    const s = await ambiguousLivePost('출처·로그인 시험 글.', 'UC-auth', { candidate: true, until: 'UNKNOWN' });
    const foreign = await userConfirmPOST(
      new Request(`${BASE}/api/distribution-items/${s.itemId}/user-confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', origin: 'https://evil.example', ...cookieHeader(token) },
        body: JSON.stringify({ candidate_external_id: s.candidateId }),
      }),
      ctx(s.itemId),
    );
    expect(foreign.status).toBe(403);
    const anon = await userConfirmPOST(jsonPost(`/api/distribution-items/${s.itemId}/user-confirm`, { candidate_external_id: s.candidateId }), ctx(s.itemId));
    expect(anon.status).toBe(401);
    const other = await userConfirmPOST(post(`/api/distribution-items/${randomUUID()}/user-confirm`, { candidate_external_id: s.candidateId }), ctx(randomUUID()));
    expect(other.status).toBe(404);
    expect(await pubsOf(s.itemId)).toHaveLength(0);
    expect((await itemOf(s.itemId)).status).toBe('UNKNOWN');
    // 확인 기록이 남은 감사 없음
    const audit = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, 'item.user_confirm'), eq(schema.auditEvents.entityId, s.itemId))).orderBy(desc(schema.auditEvents.at));
    expect(audit).toHaveLength(0);
  });
});
