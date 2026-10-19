/**
 * LIVE-P2(결정 D39): 최근 24시간 실제 게시 상한(PUBLISH_LIVE_DAILY_MAX) + 즉시 중지 스위치(live_publish_controls, migration 0046).
 * 승인 → 실행 → 작업 처리기 → 실제 어댑터(주입한 가짜 Threads fetch) 전체 경로. **실제 네트워크 호출 0**: 계정 연결(OAuth)은 globalThis.fetch 를 fixture 로
 * 잠시 바꾸고(vi.stubGlobal), 게시 어댑터에는 메모리 가짜 Threads 를 주입한다. 그 밖의 Threads·Meta 요청은 setupFiles 가드가 막는다.
 * 토큰·시크릿·code 는 모두 가짜(FAKE_…), ID 는 가짜 숫자. 시계는 작업 처리기에 주입(vt — 시험마다 25시간씩 앞으로 가서 앞 시험의 전송 의도가 창 밖).
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
  getLivePublishPaused,
  listChannelAccounts,
  livePublishDailyUsage,
  livePublishOverview,
  runJobsTick,
  schema,
  seed,
  setLivePublishPaused,
  setVariantLifecycle,
  type Db,
  type DbOrTx,
} from '@cs/db';
import { formatMsk, livePublishDailyLimitMessage, livePublishReadiness, loadConfig, type AppConfig, type Channel } from '@cs/domain';
import { createMockAdapterRegistry, LiveCapableAdapterRegistry, LiveThreadsPublishAdapter, THREADS_LONG_LIVED_URL, THREADS_ME_URL, THREADS_TOKEN_URL } from '@cs/providers';
import { POST as accountsPOST } from '../../apps/web/app/api/channel-accounts/route';
import { POST as connectPOST } from '../../apps/web/app/api/channel-accounts/[id]/connect/route';
import { GET as callbackGET } from '../../apps/web/app/api/oauth/callback/route';
import { POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { POST as approvePOST } from '../../apps/web/app/api/distribution-plans/[id]/approve/route';
import { POST as executePOST } from '../../apps/web/app/api/distribution-plans/[id]/execute/route';
import { POST as retryPOST } from '../../apps/web/app/api/distribution-items/[id]/retry/route';
import { POST as cancelPOST } from '../../apps/web/app/api/distribution-items/[id]/cancel/route';
import { POST as pausePOST } from '../../apps/web/app/api/live-publish/pause/route';
import { POST as resumePOST } from '../../apps/web/app/api/live-publish/resume/route';
import { liveDailyLimitOf, liveItemHeadline } from '../../apps/web/lib/distribution';
import { jobCredentials } from '../../apps/web/lib/oauth';
import { BASE, cookieHeader, jsonPost, login } from './helpers';

const A = 'owner@example.local';
const KEY = randomBytes(32).toString('base64');
const APP_ID = '000000000000002';
const SECRET = 'FAKE_app_secret_LIVEP2_integration_only';
const SHORT = 'FAKE_short_token_LIVEP2_it_ssssssssssss';
const LONG = 'FAKE_long_token_LIVEP2_it_publish_llllllll';
const REDIRECT = `${BASE}/api/oauth/callback`;
const PROFILE_ID = '17841400000000088';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let db: Db;
let owner: string;
let token: string;
let tmp: string;
let liveAccount: string;
const mockAcc = {} as Record<Channel, string>;

const OAUTH_ENV = { OAUTH_MODE: 'live', THREADS_APP_ID: APP_ID, THREADS_APP_SECRET: SECRET, OAUTH_REDIRECT_URI: REDIRECT, OAUTH_LIVE_APPROVAL_REF: 'D31' } as const;
const GATE_KEYS = ['PUBLISH_MODE', 'PUBLISH_LIVE_APPROVAL_REF', 'PUBLISH_LIVE_MAX_POSTS', 'PUBLISH_LIVE_DAILY_MAX'] as const;
const setGates = (g: Partial<Record<(typeof GATE_KEYS)[number], string>>) => {
  for (const k of GATE_KEYS) vi.stubEnv(k, g[k] ?? '');
};
/** 실제 게시 조건 모두 + 일일 상한(daily 가 '' 이면 일일 상한 없음). 승인 기록당 상한은 넉넉히(일일 상한이 실제 제한 — D39). */
const cfg = (daily: string, ref = 'D39-it') => {
  setGates({ PUBLISH_MODE: 'enabled', PUBLISH_LIVE_APPROVAL_REF: ref, PUBLISH_LIVE_MAX_POSTS: '1000', PUBLISH_LIVE_DAILY_MAX: daily });
  return loadConfig();
};
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (p: string, body: unknown = {}) => jsonPost(p, body, cookieHeader(token));
const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ---- 메모리 가짜 Threads(주입 fetch): 컨테이너마다 새 ID, 게시하면 미디어 ID, 읽기는 그 글 ----
interface Call {
  method: string;
  url: URL;
  body: URLSearchParams;
}
let idSeq = 500;
const nextId = () => `18000000000${String(++idSeq).padStart(6, '0')}`;
function fakeThreads(opts: { failCreateOnce?: Set<string>; publishTimeout?: Set<string> } = {}) {
  const containers = new Map<string, { text: string; media: string }>();
  const posted = new Map<string, string>();
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    calls.push({ method, url, body });
    const p = url.pathname;
    if (method === 'POST' && p === `/v1.0/${PROFILE_ID}/threads`) {
      const text = body.get('text') ?? '';
      if (opts.failCreateOnce?.delete(text)) return jsonRes(500, { error: { code: 2, is_transient: true, type: 'OAuthException' } });
      const ct = nextId();
      containers.set(ct, { text, media: nextId() });
      return jsonRes(200, { id: ct });
    }
    if (method === 'POST' && p === `/v1.0/${PROFILE_ID}/threads_publish`) {
      const c = containers.get(body.get('creation_id') ?? '');
      if (!c) return jsonRes(400, { error: { code: 100 } });
      if (opts.publishTimeout?.has(c.text)) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      posted.set(c.media, c.text);
      return jsonRes(200, { id: c.media });
    }
    if (method === 'GET' && p === `/v1.0/${PROFILE_ID}/threads`) return jsonRes(200, { data: [], paging: {} });
    const seg = p.replace('/v1.0/', '');
    if (method === 'GET' && containers.has(seg)) return jsonRes(200, { status: 'FINISHED', id: seg });
    if (method === 'GET' && posted.has(seg)) {
      return jsonRes(200, {
        id: seg,
        permalink: `https://www.threads.com/@livep2tester/post/${seg.slice(-6)}`,
        text: posted.get(seg),
        timestamp: new Date().toISOString().replace(/\.\d+Z$/, '+0000'),
        media_type: 'TEXT_POST',
      });
    }
    throw new Error(`fixture 없음: ${method} ${p}`);
  });
  const publishes = () => calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('threads_publish')).length;
  return { fetch, calls, publishes };
}

function registryWith(fetch: (input: string, init?: RequestInit) => Promise<Response>, config: AppConfig) {
  const gate = () => livePublishReadiness(config);
  return new LiveCapableAdapterRegistry(createMockAdapterRegistry(), new LiveThreadsPublishAdapter({ gate, fetch, pollIntervalMs: 0 }), gate);
}
/** 주입 시계: 실제 시각 + vt. 시험마다 25시간 앞으로(앞 시험의 실제 전송 의도가 24시간 창 밖) */
let vt = 0;
/** 경계 시험용: 값이 있으면 시계를 이 시각에 고정한다(실제 시간이 흐르지 않음) */
let frozen: number | null = null;
const clockNow = () => new Date(frozen ?? Date.now() + vt);
async function tick(registry: LiveCapableAdapterRegistry, config: AppConfig, extra: { workerId?: string; maxJobs?: number; liveDailyHook?: Parameters<typeof runJobsTick>[2]['liveDailyHook'] } = {}) {
  return runJobsTick(db, registry, {
    workerId: extra.workerId ?? 'livep2-w',
    config,
    ownerId: owner,
    clock: clockNow,
    random: () => 0.5,
    submitTimeoutMs: 5000,
    maxJobs: extra.maxJobs ?? 20,
    credentials: jobCredentials(config, db),
    ...(extra.liveDailyHook ? { liveDailyHook: extra.liveDailyHook } : {}),
  });
}

async function reviewVariant(body: string): Promise<string> {
  const { content } = await createContent(db, owner, { title: `LIVE-P2 ${randomUUID().slice(0, 6)}`, body });
  const { variant } = await createVariantDraft(db, owner, content.id, { channel: 'threads', baseVersion: 1 });
  await setVariantLifecycle(db, owner, variant.id, { lifecycle: 'review', baseVersion: 1 });
  return variant.id;
}
interface Planned {
  planId: string;
  items: Array<{ id: string; payload_hash: string }>;
}
async function planApproved(bodies: string[], accountId = liveAccount, purpose = 'public_publish'): Promise<Planned> {
  const items = [];
  for (const b of bodies) items.push({ variant_id: await reviewVariant(b), channel_account_id: accountId });
  const res = await plansPOST(post('/api/distribution-plans', { items }));
  expect(res.status, await res.clone().text()).toBe(201);
  const p = (await res.json()) as { plan: { id: string }; items: Array<{ id: string; payload_hash: string; variant_id: string }> };
  const ordered = items.map((x) => p.items.find((i) => i.variant_id === x.variant_id)!);
  const ap = await approvePOST(
    post(`/api/distribution-plans/${p.plan.id}/approve`, {
      item_ids: ordered.map((i) => i.id),
      expected_hashes: Object.fromEntries(ordered.map((i) => [i.id, i.payload_hash])),
      confirm: true,
      purpose,
    }),
    ctx(p.plan.id),
  );
  expect(ap.status, await ap.clone().text()).toBe(200);
  return { planId: p.plan.id, items: ordered };
}
async function execute(planId: string) {
  const r = await executePOST(post(`/api/distribution-plans/${planId}/execute`, { command_key: `k-${randomUUID()}` }), ctx(planId));
  expect(r.status, await r.clone().text()).toBe(200);
}
const retry = async (itemId: string) => {
  const r = await retryPOST(post(`/api/distribution-items/${itemId}/retry`), ctx(itemId));
  expect(r.status, await r.clone().text()).toBe(200);
};
const cancel = async (itemId: string) => {
  const r = await cancelPOST(post(`/api/distribution-items/${itemId}/cancel`), ctx(itemId));
  expect(await r.json()).toMatchObject({ state: 'CANCELED' });
};
const jobOf = async (itemId: string) => (await db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)).orderBy(asc(schema.jobs.createdAt)))[0]!;
const itemOf = async (itemId: string) => (await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, itemId)))[0]!;
const intentsOf = (jobId: string) => db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, jobId)).orderBy(asc(schema.sendIntents.attempt));
const eventsOf = (jobId: string) => db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId)).orderBy(desc(schema.jobEvents.eventSeq));
async function lastBlocked(jobId: string) {
  const ev = (await eventsOf(jobId)).find((e) => e.stateAfter === 'BLOCKED');
  return (ev?.sanitizedDetails ?? {}) as Record<string, unknown>;
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
      if (key === `GET ${THREADS_ME_URL}`) return jsonRes(200, { id: PROFILE_ID, username: 'livep2tester' });
      throw new Error(`fixture 없음: ${key}`);
    }),
  );
  const u = new URL(REDIRECT);
  u.searchParams.set('code', 'FAKE_code_LIVEP2_it_cccccccccccccc');
  u.searchParams.set('state', state);
  const cb = await callbackGET(new Request(u.toString(), { headers: { accept: 'application/json', ...cookieHeader(token) } }));
  expect(cb.status, await cb.clone().text()).toBe(200);
  vi.unstubAllGlobals();
  for (const k of Object.keys(OAUTH_ENV)) vi.stubEnv(k, '');
  // 실제 게시 계정으로 사용(LIVE-P1 route — 외부 호출 없음)
  const { POST: targetPOST } = await import('../../apps/web/app/api/channel-accounts/[id]/publish-target/route');
  const t = await targetPOST(post(`/api/channel-accounts/${account.id}/publish-target`, { enabled: true }), ctx(account.id));
  expect(t.status, await t.clone().text()).toBe(200);
  return account.id;
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-livep2-it-'));
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
beforeEach(async () => {
  setGates({});
  frozen = null;
  // 앞 시험의 실제 전송 의도는 모두 창 밖: 지금까지의 시계와 가장 늦은 전송 의도보다 25시간 뒤(고정 시계로 앞서 간 의도 포함)
  const [latest] = await db.select({ at: schema.sendIntents.createdAt }).from(schema.sendIntents).orderBy(desc(schema.sendIntents.createdAt)).limit(1);
  vt = Math.max(vt + 25 * HOUR, (latest?.at.getTime() ?? 0) + 25 * HOUR - Date.now());
});
afterEach(async () => {
  vi.unstubAllGlobals();
  // 시험이 남긴 중지 상태는 다음 시험에 넘기지 않는다
  if ((await getLivePublishPaused(db, owner)).paused) await setLivePublishPaused(db, owner, false);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
  await closeDb();
});

describe('migration 0046 — live_publish_controls', () => {
  it('행이 없으면 중지 아님 · changed_by 는 owner 만(CHECK) · owner FK · owner 당 한 행', async () => {
    expect(await getLivePublishPaused(db, owner)).toEqual({ paused: false, changedAt: null });
    await expect(db.execute(sql`insert into live_publish_controls (owner_id, paused, changed_by) values (${owner}, true, 'admin')`)).rejects.toThrow();
    await expect(db.execute(sql`insert into live_publish_controls (owner_id, paused, changed_by) values (${randomUUID()}, true, 'owner')`)).rejects.toThrow();
    const r = await setLivePublishPaused(db, owner, true, new Date('2020-01-01T09:00:00Z'));
    expect(r).toEqual({ paused: true, changed: true, changedAt: new Date('2020-01-01T09:00:00Z') });
    await expect(db.execute(sql`insert into live_publish_controls (owner_id, paused, changed_by) values (${owner}, false, 'owner')`)).rejects.toThrow();
    // 같은 상태로 다시 → 바뀌지 않고 감사도 남기지 않음
    expect((await setLivePublishPaused(db, owner, true)).changed).toBe(false);
    const rows = await db.select().from(schema.livePublishControls);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ownerId: owner, paused: true, changedBy: 'owner' });
    const audits = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'live_publish_paused'));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.sanitizedDetails).toEqual({ by: 'owner' });
  });
});

describe('최근 24시간 실제 게시 상한(PUBLISH_LIVE_DAILY_MAX)', () => {
  it('상한 3: 서로 다른 작업 3건은 게시, 24시간 안의 4번째 작업은 보내지 않고 BLOCKED(전송 의도 0·원격 호출 0) — 사용 수·상한·다시 보낼 시각(가장 이른 작업 + 24h)·모스크바 문구', async () => {
    const config = cfg('3');
    const fake = fakeThreads();
    const reg = registryWith(fake.fetch, config);
    const sent: Planned[] = [];
    for (const [k, text] of ['상한 첫째 글.', '상한 둘째 글.', '상한 셋째 글.'].entries()) {
      const p = await planApproved([text]);
      await execute(p.planId);
      expect((await tick(reg, config)).results).toEqual({ CONFIRMED: 1 });
      sent.push(p);
      if (k < 2) vt += HOUR;
    }
    expect(fake.publishes()).toBe(3);
    // 표시용 요약도 같은 수
    expect((await livePublishOverview(db, owner, clockNow())).used).toBe(3);
    vt += HOUR;
    const fourth = await planApproved(['상한 넷째 글.']);
    await execute(fourth.planId);
    const callsBefore = fake.calls.length;
    expect((await tick(reg, config)).results).toEqual({ BLOCKED: 1 });
    const job = await jobOf(fourth.items[0]!.id);
    expect(job.lastErrorCode).toBe('live_publish_daily_limit');
    expect(await intentsOf(job.id)).toHaveLength(0);
    expect(fake.calls.length).toBe(callsBefore);
    expect((await itemOf(fourth.items[0]!.id)).status).toBe('BLOCKED');
    // 가장 이른 작업(첫 글)의 실제 전송 의도 시각 + 24h
    const t0 = (await intentsOf((await jobOf(sent[0]!.items[0]!.id)).id))[0]!.createdAt.getTime();
    const d = await lastBlocked(job.id);
    expect(d).toMatchObject({ reason: 'live_publish_daily_limit', not_sent: true, used: 3, limit: 3, available_at: new Date(t0 + DAY).toISOString() });
    // 화면 문구(모스크바 시각) — 계획 화면과 같은 도우미
    const events = await eventsOf(job.id);
    const info = liveDailyLimitOf(events);
    expect(info).toEqual({ limit: 3, availableAt: new Date(t0 + DAY).toISOString() });
    const headline = liveItemHeadline({ status: 'BLOCKED', channel: 'threads', job, pub: null, blockReason: 'live_publish_daily_limit', liveDaily: info });
    expect(headline).toBe(`보류 — ${livePublishDailyLimitMessage(3, new Date(t0 + DAY))}`);
    expect(headline).toContain(`${formatMsk(new Date(t0 + DAY))} 이후 '재시도'로 다시 보낼 수 있습니다.`);
    await cancel(fourth.items[0]!.id);
  });

  it('창이 풀리면(주입 시계 24시간) 기존 재시도 경로로 게시: 창이 풀리기 1분 전 재시도는 다시 보류, 정확히 가장 이른 작업 + 24h 에는 게시', async () => {
    const config = cfg('1');
    const fake = fakeThreads();
    const reg = registryWith(fake.fetch, config);
    const a = await planApproved(['창 시험 첫 글.']);
    await execute(a.planId);
    expect((await tick(reg, config)).results).toEqual({ CONFIRMED: 1 });
    const tA = (await intentsOf((await jobOf(a.items[0]!.id)).id))[0]!.createdAt.getTime();
    vt += HOUR;
    const b = await planApproved(['창 시험 둘째 글.']);
    await execute(b.planId);
    expect((await tick(reg, config)).results).toEqual({ BLOCKED: 1 });
    const bItem = b.items[0]!.id;
    expect(await lastBlocked((await jobOf(bItem)).id)).toMatchObject({ used: 1, limit: 1, available_at: new Date(tA + DAY).toISOString() });
    // 창이 풀리기 1분 전: 재시도 → 다시 보류(보내지 않음)
    frozen = tA + DAY - MIN;
    await retry(bItem);
    expect((await tick(reg, config)).results).toEqual({ BLOCKED: 1 });
    expect((await jobOf(bItem)).lastErrorCode).toBe('live_publish_daily_limit');
    expect(await intentsOf((await jobOf(bItem)).id)).toHaveLength(0);
    expect(fake.publishes()).toBe(1);
    // 정확히 available_at: 창(created_at > now − 24h)에서 첫 작업이 빠진다 → 재시도로 게시
    frozen = tA + DAY;
    await retry(bItem);
    expect((await tick(reg, config)).results).toEqual({ CONFIRMED: 1 });
    expect(fake.publishes()).toBe(2);
    const intents = await intentsOf((await jobOf(bItem)).id);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.sanitizedDetails).toMatchObject({ mode: 'LIVE', live_approval_ref: 'D39-it' });
  });

  it('같은 작업의 재시도는 새로 세지 않는다: 일시 실패한 작업 A 는 창 안에서 다시 보내도 1건, 상한이 줄어도(A 포함 3건 사용 중, 상한 2) A 의 재시도는 게시, 새 작업 D 는 used 3 으로 보류', async () => {
    const config3 = cfg('3');
    const fake = fakeThreads({ failCreateOnce: new Set(['재시도 A 글.']) });
    const reg3 = registryWith(fake.fetch, config3);
    const a = await planApproved(['재시도 A 글.']);
    await execute(a.planId);
    expect((await tick(reg3, config3)).results).toEqual({ RETRY_WAIT: 1 }); // 컨테이너 생성 5xx — 부작용 없는 일시 실패
    const aJob = await jobOf(a.items[0]!.id);
    expect(await intentsOf(aJob.id)).toHaveLength(1);
    vt += 10_000; // A 의 다음 시도(약 30초 뒤) 전
    const bc = await planApproved(['재시도 B 글.', '재시도 C 글.']);
    await execute(bc.planId);
    // A 는 아직 RETRY_WAIT(다음 시각 전) — B·C 만 처리: A(1) + B + C = 3
    const r1 = await tick(reg3, config3);
    expect(r1.results).toEqual({ CONFIRMED: 2 });
    expect((await livePublishDailyUsage(db, owner, null, clockNow())).used).toBe(3);
    // 상한을 2 로 줄인 뒤 A 의 다음 시도: 다른 작업 2(B·C) ≥ 2 지만 A 는 이미 창 안에 전송 의도가 있어 새 게시가 아님 → 게시
    const config2 = cfg('2');
    const reg2 = registryWith(fake.fetch, config2);
    vt += 30 * MIN;
    expect((await tick(reg2, config2)).results).toEqual({ CONFIRMED: 1 });
    expect((await jobOf(a.items[0]!.id)).state).toBe('CONFIRMED');
    expect(await intentsOf(aJob.id)).toHaveLength(2);
    expect(fake.publishes()).toBe(3);
    // 서로 다른 작업 수는 3(A 의 의도 2개를 두 번 세지 않음)
    expect((await livePublishDailyUsage(db, owner, null, clockNow())).used).toBe(3);
    const d = await planApproved(['재시도 D 글.']);
    await execute(d.planId);
    expect((await tick(reg2, config2)).results).toEqual({ BLOCKED: 1 });
    const dJob = await jobOf(d.items[0]!.id);
    expect(await lastBlocked(dJob.id)).toMatchObject({ reason: 'live_publish_daily_limit', used: 3, limit: 2 });
    expect(await intentsOf(dJob.id)).toHaveLength(0);
    // available_at = 각 작업의 **마지막** 실제 전송 의도 중 가장 이른 것 + 24h — A 는 재시도(마지막 의도가 늦음)라 B·C 의 시각이 기준
    const bcAt = await Promise.all(bc.items.map(async (i) => (await intentsOf((await jobOf(i.id)).id))[0]!.createdAt.getTime()));
    const aFirst = (await intentsOf(aJob.id))[0]!.createdAt.getTime();
    expect(aFirst).toBeLessThan(Math.min(...bcAt)); // A 의 첫 의도가 가장 이르지만 기준이 아니다
    expect((await lastBlocked(dJob.id)).available_at).toBe(new Date(Math.min(...bcAt) + DAY).toISOString());
    await cancel(d.items[0]!.id);
  });

  it('PUBLISH_LIVE_DAILY_MAX 없음 = 일일 상한 없음(이전 동작): 24시간 안에 4건 모두 게시', async () => {
    const config = cfg('');
    expect(config.PUBLISH_LIVE_DAILY_MAX).toBeUndefined();
    const fake = fakeThreads();
    const reg = registryWith(fake.fetch, config);
    const p = await planApproved(['상한 없음 1.', '상한 없음 2.', '상한 없음 3.', '상한 없음 4.']);
    await execute(p.planId);
    expect((await tick(reg, config)).results).toEqual({ CONFIRMED: 4 });
    expect(fake.publishes()).toBe(4);
  });

  it('동시 실행(PGlite 한 연결, 판정 안 지연 주입): 상한 − 1 에서 두 작업을 승인 기록이 다른 두 작업 처리기가 동시에 → 한 건만 게시, 나머지는 보류(전송 의도 0)', async () => {
    const configA = cfg('2', 'D39-conc-a');
    const fake = fakeThreads();
    const first = await planApproved(['동시 앞선 글.']);
    await execute(first.planId);
    expect((await tick(registryWith(fake.fetch, configA), configA)).results).toEqual({ CONFIRMED: 1 }); // 1/2 사용
    const two = await planApproved(['동시 첫째 글.', '동시 둘째 글.']);
    await execute(two.planId);
    const configB = cfg('2', 'D39-conc-b'); // 승인 기록 잠금이 서로 다르다 — owner 별 일일 잠금만이 두 판정을 줄 세운다
    const order: string[] = [];
    // 순서 주입: 판정(일일 잠금 안)에서 사용량을 읽은 직후 잠시 쉰다 — 다른 작업 처리기가 끼어들 틈을 준다
    const hook = (w: string) => async (_tx: DbOrTx, at: { phase: string; jobId: string }) => {
      order.push(`${w}:${at.phase}`);
      if (at.phase === 'after_daily_usage') await new Promise((r) => setTimeout(r, 30));
    };
    const [ra, rb] = await Promise.all([
      tick(registryWith(fake.fetch, configA), configA, { workerId: 'conc-a', maxJobs: 1, liveDailyHook: hook('a') }),
      tick(registryWith(fake.fetch, configB), configB, { workerId: 'conc-b', maxJobs: 1, liveDailyHook: hook('b') }),
    ]);
    expect((ra.results.CONFIRMED ?? 0) + (rb.results.CONFIRMED ?? 0)).toBe(1);
    expect((ra.results.BLOCKED ?? 0) + (rb.results.BLOCKED ?? 0)).toBe(1);
    expect(fake.publishes()).toBe(2);
    const codes = await Promise.all(two.items.map(async (i) => (await jobOf(i.id)).lastErrorCode));
    expect(codes.filter((c) => c === 'live_publish_daily_limit')).toHaveLength(1);
    const blocked = two.items[codes.indexOf('live_publish_daily_limit')]!;
    expect(await intentsOf((await jobOf(blocked.id)).id)).toHaveLength(0);
    expect(await lastBlocked((await jobOf(blocked.id)).id)).toMatchObject({ used: 2, limit: 2 });
    // 두 판정은 겹치지 않았다: 한 처리기의 잠금 → 사용량 읽기가 끝난 뒤에야 다른 처리기가 잠금을 얻음
    expect(order).toHaveLength(4);
    expect(order[0]!.split(':')[0]).toBe(order[1]!.split(':')[0]);
    expect(order[2]!.split(':')[0]).toBe(order[3]!.split(':')[0]);
    expect(order.map((o) => o.split(':')[1])).toEqual(['after_daily_lock', 'after_daily_usage', 'after_daily_lock', 'after_daily_usage']);
    await cancel(blocked.id);
  });
});

describe('즉시 중지 스위치(live_publish_controls)', () => {
  it('중지(route, 확인 없음) → 실제 게시는 보내지 않고 BLOCKED live_publish_paused(전송 의도 0·원격 호출 0), 모의 게시는 그대로 → 재개(확인 문구) → 재시도로 게시', async () => {
    const config = cfg('3');
    const fake = fakeThreads();
    const reg = registryWith(fake.fetch, config);
    const live = await planApproved(['중지 시험 실제 글.']);
    await execute(live.planId);
    const mock = await planApproved(['중지 시험 모의 글.'], mockAcc.threads, 'mock_publish');
    await execute(mock.planId);
    // 중지: 서버 재시작 없이 다음 전송부터
    const p = await pausePOST(jsonPost('/api/live-publish/pause', {}, cookieHeader(token)));
    expect(p.status, await p.clone().text()).toBe(200);
    expect(await p.json()).toMatchObject({ paused: true, changed: true });
    let globalCalls = 0;
    vi.stubGlobal('fetch', async () => {
      globalCalls++;
      throw new Error('network forbidden');
    });
    const t = await tick(reg, config);
    expect(t.results).toEqual({ BLOCKED: 1, CONFIRMED: 1 });
    const liveJob = await jobOf(live.items[0]!.id);
    expect(liveJob.lastErrorCode).toBe('live_publish_paused');
    expect(await lastBlocked(liveJob.id)).toMatchObject({ reason: 'live_publish_paused', not_sent: true });
    expect(await intentsOf(liveJob.id)).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
    expect(globalCalls).toBe(0);
    // 모의 항목은 영향 없음(MOCK 결과)
    expect((await itemOf(mock.items[0]!.id)).status).toBe('CONFIRMED');
    const mockIntent = (await intentsOf((await jobOf(mock.items[0]!.id)).id))[0]!;
    expect(mockIntent.sanitizedDetails).toMatchObject({ mode: 'MOCK' });
    expect(mockIntent.sanitizedDetails).not.toHaveProperty('live_approval_ref');
    // 중지 중 재시도해도 다시 보류
    await retry(live.items[0]!.id);
    expect((await tick(reg, config)).results).toEqual({ BLOCKED: 1 });
    expect(fake.calls).toHaveLength(0);
    vi.unstubAllGlobals();
    // 재개: 확인 문구가 없거나 다르면 400·그대로 중지
    for (const body of [{}, { confirm_text: '' }, { confirm_text: '재 개' }, { confirm_text: 'resume' }, { confirm_text: true }]) {
      const bad = await resumePOST(jsonPost('/api/live-publish/resume', body, cookieHeader(token)));
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toBe('live_resume_confirm_required');
    }
    expect((await getLivePublishPaused(db, owner)).paused).toBe(true);
    const ok = await resumePOST(jsonPost('/api/live-publish/resume', { confirm_text: '재개' }, cookieHeader(token)));
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).toMatchObject({ paused: false, changed: true });
    // 재개는 보류 항목을 자동으로 보내지 않는다 — 재시도해야 게시
    expect((await tick(reg, config)).results).toEqual({});
    expect(fake.publishes()).toBe(0);
    await retry(live.items[0]!.id);
    expect((await tick(reg, config)).results).toEqual({ CONFIRMED: 1 });
    expect(fake.publishes()).toBe(1);
    // 감사: 누가(owner)·언제만
    const audits = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.ownerId, owner), sql`${schema.auditEvents.action} in ('live_publish_paused', 'live_publish_resumed')`))
      .orderBy(desc(schema.auditEvents.at));
    expect(audits[0]!.action).toBe('live_publish_resumed');
    for (const a of audits) expect(a.sanitizedDetails).toEqual({ by: 'owner' });
  });

  it('중지는 게시 시도 표식을 지난 작업을 바꾸지 않는다: 게시 시간 초과(RECONCILING) 뒤 중지 → 조회 경로 그대로(보류 아님, 재게시 0)', async () => {
    const config = cfg('3');
    const TEXT = '중지 전 결과 불명 글.';
    const fake = fakeThreads({ publishTimeout: new Set([TEXT]) });
    const reg = registryWith(fake.fetch, config);
    const p = await planApproved([TEXT]);
    await execute(p.planId);
    expect((await tick(reg, config)).results).toEqual({ RECONCILING: 1 });
    expect(fake.publishes()).toBe(1);
    await setLivePublishPaused(db, owner, true);
    for (let i = 0; i < 6; i++) {
      vt += 2 * HOUR;
      await tick(reg, config);
    }
    const job = await jobOf(p.items[0]!.id);
    expect(job.state).toBe('UNKNOWN'); // 결과 불명 규칙 그대로(확인 3회 뒤 UNKNOWN) — 중지 때문에 보류되지 않음
    expect(job.lastErrorCode).not.toBe('live_publish_paused');
    const evs = await eventsOf(job.id);
    expect(evs.some((e) => (e.sanitizedDetails as { reason?: unknown }).reason === 'live_publish_paused')).toBe(false);
    expect(fake.publishes()).toBe(1);
  });

  it('표시용 요약(livePublishOverview): 실제 계정 있음·중지 여부·최근 24시간 작업 수', async () => {
    const config = cfg('3');
    const fake = fakeThreads();
    const p = await planApproved(['요약 시험 글.']);
    await execute(p.planId);
    expect((await tick(registryWith(fake.fetch, config), config)).results).toEqual({ CONFIRMED: 1 });
    expect(await livePublishOverview(db, owner, clockNow())).toMatchObject({ hasLiveAccount: true, paused: false, used: 1 });
    await setLivePublishPaused(db, owner, true);
    expect(await livePublishOverview(db, owner, clockNow())).toMatchObject({ paused: true, used: 1 });
    expect((await livePublishOverview(db, owner, new Date(clockNow().getTime() + DAY + MIN))).used).toBe(0);
  });
});

describe('중지·재개 route — 로그인·같은 출처', () => {
  const pauseReq = (headers: Record<string, string>, accept = 'application/json') =>
    new Request(`${BASE}/api/live-publish/pause`, { method: 'POST', headers: { 'content-type': 'application/json', accept, ...headers }, body: '{}' });
  const resumeReq = (headers: Record<string, string>, body: unknown = { confirm_text: '재개' }, accept = 'application/json') =>
    new Request(`${BASE}/api/live-publish/resume`, { method: 'POST', headers: { 'content-type': 'application/json', accept, ...headers }, body: JSON.stringify(body) });

  it('세션 없음 → 401, 다른 출처·출처 없음 → 403 csrf — 상태·감사 변화 없음', async () => {
    const auditsBefore = (await db.select().from(schema.auditEvents).where(sql`${schema.auditEvents.action} in ('live_publish_paused', 'live_publish_resumed')`)).length;
    expect((await pausePOST(pauseReq({ origin: BASE }))).status).toBe(401);
    const evil = await pausePOST(pauseReq({ origin: 'https://evil.example', ...cookieHeader(token) }));
    expect(evil.status).toBe(403);
    expect(((await evil.json()) as { error: string }).error).toBe('csrf');
    expect((await pausePOST(pauseReq({ ...cookieHeader(token) }))).status).toBe(403);
    expect((await pausePOST(pauseReq({ origin: BASE, 'sec-fetch-site': 'cross-site', ...cookieHeader(token) }))).status).toBe(403);
    expect((await getLivePublishPaused(db, owner)).paused).toBe(false);
    // 재개도 같은 검사(중지 상태에서)
    await setLivePublishPaused(db, owner, true);
    const n0 = (await db.select().from(schema.auditEvents).where(sql`${schema.auditEvents.action} in ('live_publish_paused', 'live_publish_resumed')`)).length;
    expect((await resumePOST(resumeReq({ origin: BASE }))).status).toBe(401);
    expect((await resumePOST(resumeReq({ origin: 'https://evil.example', ...cookieHeader(token) }))).status).toBe(403);
    expect((await resumePOST(resumeReq({ origin: 'null', ...cookieHeader(token) }))).status).toBe(403);
    expect((await getLivePublishPaused(db, owner)).paused).toBe(true);
    expect((await db.select().from(schema.auditEvents).where(sql`${schema.auditEvents.action} in ('live_publish_paused', 'live_publish_resumed')`)).length).toBe(n0);
    expect(n0).toBe(auditsBefore + 1);
  });

  it('폼(HTML): 중지 → 303 설정 화면 "실제 게시" 구역, 다른 출처 → 303 오류 코드만(상태 그대로), 로그인 없음 → 로그인 화면, 재개 확인 틀림 → 오류 코드', async () => {
    const form = (p: string, headers: Record<string, string>, fields: Record<string, string> = {}) =>
      new Request(`${BASE}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', ...headers },
        body: new URLSearchParams(fields).toString(),
      });
    const csrf = await pausePOST(form('/api/live-publish/pause', { origin: 'https://evil.example', ...cookieHeader(token) }));
    expect(csrf.status).toBe(303);
    expect(csrf.headers.get('location')).toBe('/settings?live_error=csrf#live-publish');
    const anon = await pausePOST(form('/api/live-publish/pause', { origin: BASE }));
    expect(anon.status).toBe(303);
    expect(anon.headers.get('location')).toBe('/login');
    expect((await getLivePublishPaused(db, owner)).paused).toBe(false);
    const ok = await pausePOST(form('/api/live-publish/pause', { origin: BASE, ...cookieHeader(token) }));
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/settings?live_publish=paused#live-publish');
    expect((await getLivePublishPaused(db, owner)).paused).toBe(true);
    const wrong = await resumePOST(form('/api/live-publish/resume', { origin: BASE, ...cookieHeader(token) }, { confirm_text: '네' }));
    expect(wrong.headers.get('location')).toBe('/settings?live_error=live_resume_confirm_required#live-publish');
    expect((await getLivePublishPaused(db, owner)).paused).toBe(true);
    const resumed = await resumePOST(form('/api/live-publish/resume', { origin: BASE, ...cookieHeader(token) }, { confirm_text: ' 재개 ' }));
    expect(resumed.headers.get('location')).toBe('/settings?live_publish=resumed#live-publish');
    expect((await getLivePublishPaused(db, owner)).paused).toBe(false);
  });
});
