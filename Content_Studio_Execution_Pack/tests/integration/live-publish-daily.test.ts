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
  listRemoteSteps,
  livePublishDailyUsage,
  livePublishOverview,
  retryItem,
  runJobsTick,
  schema,
  seed,
  setLivePublishPaused,
  setVariantLifecycle,
  type Db,
  type DbOrTx,
} from '@cs/db';
import {
  formatLiveAvailableAt,
  formatMsk,
  livePublishDailyLimitMessage,
  livePublishReadiness,
  liveThreadsStepId,
  liveThreadsStepRaw,
  loadConfig,
  resumeProvenRetryable,
  SCHEDULE_STALE_RETRY_MESSAGE,
  type AppConfig,
  type Channel,
} from '@cs/domain';
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
import { DISTRIBUTE_ERROR_TEXT, liveDailyLimitOf, liveItemHeadline } from '../../apps/web/lib/distribution';
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
/** PGlite 클라이언트(잠금 시험이 실행된 SQL 문장 순서를 관찰 — debug 기록) */
let pg: { debug: number };
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
function fakeThreads(
  opts: {
    failCreateOnce?: Set<string>;
    /** FIX2-LIVEP2(검토 #3): 이 본문의 컨테이너 생성을 남은 횟수만큼 5xx(부작용 없는 일시 실패) */
    failCreateTimes?: Map<string, number>;
    publishTimeout?: Set<string>;
    /** FIX-LIVEP2(C): 이 본문의 컨테이너 상태 읽기를 한 번 5xx — 표식 전 결과 불명(container_status_unreadable) */
    statusFailOnce?: Set<string>;
    /** FIX-LIVEP2(D): 컨테이너 생성 응답 직전(= beginSend 뒤·게시 시도 표식 전)에 부른다 */
    onCreate?: (text: string) => Promise<void>;
    /** FIX-LIVEP2(D): 게시 요청을 받은 뒤(= 표식 뒤) 응답 직전에 부른다 */
    onPublish?: (text: string) => Promise<void>;
  } = {},
) {
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
      const left = opts.failCreateTimes?.get(text) ?? 0;
      if (left > 0) {
        opts.failCreateTimes!.set(text, left - 1);
        return jsonRes(500, { error: { code: 2, is_transient: true, type: 'OAuthException' } });
      }
      const ct = nextId();
      containers.set(ct, { text, media: nextId() });
      await opts.onCreate?.(text);
      return jsonRes(200, { id: ct });
    }
    if (method === 'POST' && p === `/v1.0/${PROFILE_ID}/threads_publish`) {
      const c = containers.get(body.get('creation_id') ?? '');
      if (!c) return jsonRes(400, { error: { code: 100 } });
      if (opts.publishTimeout?.has(c.text)) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      posted.set(c.media, c.text);
      await opts.onPublish?.(c.text);
      return jsonRes(200, { id: c.media });
    }
    if (method === 'GET' && p === `/v1.0/${PROFILE_ID}/threads`) return jsonRes(200, { data: [], paging: {} });
    const seg = p.replace('/v1.0/', '');
    if (method === 'GET' && containers.has(seg) && opts.statusFailOnce?.delete(containers.get(seg)!.text)) {
      return jsonRes(500, { error: { code: 2, is_transient: true, type: 'OAuthException' } });
    }
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
  const creates = () => calls.filter((c) => c.method === 'POST' && c.url.pathname === `/v1.0/${PROFILE_ID}/threads`).length;
  return { fetch, calls, publishes, creates };
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
async function tick(
  registry: LiveCapableAdapterRegistry,
  config: AppConfig,
  extra: { workerId?: string; maxJobs?: number; planId?: string; liveDailyHook?: Parameters<typeof runJobsTick>[2]['liveDailyHook'] } = {},
) {
  return runJobsTick(db, registry, {
    ...(extra.planId ? { planId: extra.planId } : {}),
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
async function planApproved(bodies: string[], accountId = liveAccount, purpose = 'public_publish', schedule?: { date: string; time: string }): Promise<Planned> {
  const items = [];
  for (const b of bodies) items.push({ variant_id: await reviewVariant(b), channel_account_id: accountId, ...(schedule ? { schedule } : {}) });
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
/** FIX-LIVEP2(A): 화면 시각은 분 단위 올림(보이는 시각이 실제로 보낼 수 있는 시각보다 이르지 않게) */
const ceilMin = (t: number) => Math.ceil(t / MIN) * MIN;
/** FIX-LIVEP2(F): UTC 시각 → 계획 입력(모스크바 날짜·시각, MSK = UTC+3 고정) — 분 단위로 올림 */
function mskSchedule(at: number): { date: string; time: string } {
  const iso = new Date(ceilMin(at) + 3 * HOUR).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/**
 * FIX-LIVEP2(G): fn 이 실행한 SQL 문장을 순서대로 모은다(PGlite debug 기록 — "runQuery"/"runExec", 문장, 매개변수). PGlite 는 한 연결이라
 * 이 동안 다른 문장이 끼어들지 않는다. 아무 문장도 모이지 않으면(PGlite 내부가 바뀜) 시험이 실패하도록 호출자가 확인한다.
 */
async function captureSql<T>(fn: () => Promise<T>): Promise<{ result: T; stmts: Array<{ sql: string; params: unknown[] }> }> {
  const stmts: Array<{ sql: string; params: unknown[] }> = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    if (a[0] === 'runQuery' || a[0] === 'runExec') stmts.push({ sql: String(a[1]), params: Array.isArray(a[2]) ? a[2] : [] });
  });
  const prev = pg.debug;
  pg.debug = 1;
  try {
    return { result: await fn(), stmts };
  } finally {
    pg.debug = prev;
    spy.mockRestore();
  }
}
/** 이 트랜잭션이 owner 별 일일 advisory 잠금(cs_live_publish_daily:<owner>, int8 키 = hashtext 부호 확장)을 지금 쥐고 있는가(pg_locks) */
async function holdsDailyLock(tx: DbOrTx): Promise<boolean> {
  const name = `cs_live_publish_daily:${owner}`;
  const r = await tx.execute(sql`
    select count(*)::int as n from pg_locks
     where locktype = 'advisory' and granted and objsubid = 1
       and classid = ((hashtext(${name})::int8 >> 32) & 4294967295)::oid
       and objid = (hashtext(${name})::int8 & 4294967295)::oid`);
  return Number((r as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0) === 1;
}
const isDailyLockStmt = (s: { sql: string; params: unknown[] }) => s.sql.includes('pg_advisory_xact_lock(hashtext(') && s.params[0] === `cs_live_publish_daily:${owner}`;
/**
 * FIX2-LIVEP2(검토 #2·#5): 교착을 막는 advisory 잠금 사이 순서. 배타 형식 `pg_advisory_xact_lock(hashtext(` 는 공유 형식
 * `pg_advisory_xact_lock_shared(hashtext(` 의 부분 문자열이 아니므로 두 판별이 서로 겹치지 않는다. 잠금 이름은 첫 매개변수.
 */
const isRateExclusiveStmt = (s: { sql: string; params: unknown[] }) => s.sql.includes('pg_advisory_xact_lock(hashtext(') && s.params[0] === `cs_rate:${liveAccount}`;
const isRateSharedStmt = (s: { sql: string; params: unknown[] }) => s.sql.includes('pg_advisory_xact_lock_shared(hashtext(') && s.params[0] === `cs_rate:${liveAccount}`;
const isRefLockStmt = (ref: string) => (s: { sql: string; params: unknown[] }) => s.sql.includes('pg_advisory_xact_lock(hashtext(') && s.params[0] === `cs_live_publish:${ref}`;

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
  const handle = await getDb(loadConfig());
  db = handle.db;
  pg = handle.client as unknown as { debug: number };
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
    // FIX-LIVEP2(A, 리뷰 확정 finding "분 단위 버림"): 화면 시각은 분 단위 **올림** — 이전 단언(formatMsk(t0 + DAY), 버림)은 실제보다 최대 59초 이른
    // 시각을 약속하는 틀린 값이었다. 올린 시각에 재시도하면 창(created_at > now − 24h)에서 그 작업이 이미 빠져 있다.
    expect(headline).toContain(`${formatMsk(new Date(ceilMin(t0 + DAY)))} 이후 '재시도'로 다시 보낼 수 있습니다.`);
    // FIX-LIVEP2(H): 모의 전송은 실제 게시 상한과 무관 — 상한이 찬 지금도 모의 계획은 MOCK 으로 처리되고(원격 호출 0), 사용 수는 그대로 3
    const mockPlan = await planApproved(['상한 중 모의 글.'], mockAcc.threads, 'mock_publish');
    await execute(mockPlan.planId);
    expect((await tick(reg, config)).results).toEqual({ CONFIRMED: 1 });
    const mockIntents = await intentsOf((await jobOf(mockPlan.items[0]!.id)).id);
    expect(mockIntents).toHaveLength(1);
    expect(mockIntents[0]!.sanitizedDetails).toMatchObject({ mode: 'MOCK' });
    expect(mockIntents[0]!.sanitizedDetails).not.toHaveProperty('live_approval_ref');
    expect((await livePublishOverview(db, owner, clockNow())).used).toBe(3);
    expect(fake.calls.length).toBe(callsBefore);
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
    // available_at: 각 작업의 **마지막** 실제 전송 의도 시각(A 는 재시도라 마지막 의도가 늦음)을 오름차순으로 놓고 [used − limit] 번째 + 24h —
    // 그 시각이 되어야 창 안 다른 작업 수가 상한 아래로 내려간다(used 3, limit 2 → 두 번째로 이른 것).
    // FIX-LIVEP2(A, 리뷰 확정 finding live-publish.ts:149): 이전 단언은 가장 이른 것(min(B,C)) + 24h 였다 — 그 시각에는 한 작업만 빠져 used 2 ≥ 2 로
    // 다시 보류되는 **틀린 값**이었다(아래에서 그 시각의 재시도가 다시 보류됨을 보인다).
    const bcAt = await Promise.all(bc.items.map(async (i) => (await intentsOf((await jobOf(i.id)).id))[0]!.createdAt.getTime()));
    const aIntents = await intentsOf(aJob.id);
    const aFirst = aIntents[0]!.createdAt.getTime();
    const aLast = aIntents[1]!.createdAt.getTime();
    expect(aFirst).toBeLessThan(Math.min(...bcAt)); // A 의 첫 의도가 가장 이르지만 기준이 아니다
    const lastAts = [...bcAt, aLast].sort((x, y) => x - y);
    expect(lastAts[2]).toBe(aLast);
    const availableAt = lastAts[3 - 2]! + DAY;
    expect((await lastBlocked(dJob.id)).available_at).toBe(new Date(availableAt).toISOString());
    // FIX2-LIVEP2(검토 #4 live-publish.ts:241): 설정 화면 "다음 게시 가능"의 원천 — livePublishOverview 가 받은 상한을 livePublishDailyUsage 에 넘긴다.
    // 설정 화면이 상한(일일 상한 설정값)을 4번째 인자로 넘기는 것은 live-publish-render.test.ts 가 본다. 상한을 버리면(null) 가장 이른 것 + 24h — 그 시각
    // 재시도는 아래처럼 다시 보류되는 틀린 값이다.
    const ov = await livePublishOverview(db, owner, clockNow(), 2);
    expect(ov.used).toBe(3);
    expect(ov.availableAt?.toISOString()).toBe(new Date(availableAt).toISOString());
    expect(formatLiveAvailableAt(ov.availableAt!)).toBe(formatMsk(new Date(ceilMin(availableAt)))); // 설정 화면이 그리는 문자열
    expect((await livePublishOverview(db, owner, clockNow())).availableAt?.toISOString()).toBe(new Date(lastAts[0]! + DAY).toISOString());
    expect((await livePublishOverview(db, owner, clockNow(), 3)).availableAt?.toISOString()).toBe(new Date(lastAts[0]! + DAY).toISOString()); // used == 상한
    const dItem = d.items[0]!.id;
    // 예전 값(가장 이른 것 + 24h)에 재시도 → 아직 다른 작업 2(≥ 상한 2) → 다시 보류(보내지 않음), 이번 available_at 은 같은 올바른 값
    frozen = lastAts[0]! + DAY;
    await retry(dItem);
    expect((await tick(reg2, config2)).results).toEqual({ BLOCKED: 1 });
    expect(await lastBlocked(dJob.id)).toMatchObject({ reason: 'live_publish_daily_limit', used: 2, limit: 2, available_at: new Date(availableAt).toISOString() });
    // 알려 준 시각 1분 전 → 보류, 알려 준 시각 → 게시(창에서 두 번째 작업이 빠져 used 1 < 2)
    frozen = availableAt - MIN;
    await retry(dItem);
    expect((await tick(reg2, config2)).results).toEqual({ BLOCKED: 1 });
    expect(await intentsOf(dJob.id)).toHaveLength(0);
    frozen = availableAt;
    await retry(dItem);
    expect((await tick(reg2, config2)).results).toEqual({ CONFIRMED: 1 });
    expect(await intentsOf(dJob.id)).toHaveLength(1);
    expect(fake.publishes()).toBe(4);
  });

  // FIX2-CODEX(U2 — Codex review-LIVEP2 Q2, 사용자 결정 2026-10-23): D39 의 "같은 작업의 재시도·이어 보내기는 새로 세지 않음"은 최근 24시간 창 안의 중복 제거다 —
  // 그 작업의 가장 최근 실제 전송 의도가 창 밖이 된 뒤 다시 보내면 새 게시로 다시 센다(DECISIONS D39 명확화·README·.env.example 문구의 근거 — 코드 변경 없음).
  it('D39 명확화: 같은 작업의 재시도는 창 안에서는 한 번만 세고(위 시험 — 상한이 차도 막지 않음), 그 작업의 마지막 실제 전송 의도가 창 밖이 되면 다시 센다(상한이면 보류)', async () => {
    const config = cfg('1');
    const fake = fakeThreads({ failCreateOnce: new Set(['창 지난 재시도 A 글.']) });
    const reg = registryWith(fake.fetch, config);
    frozen = clockNow().getTime();
    const a = await planApproved(['창 지난 재시도 A 글.']);
    await execute(a.planId);
    expect((await tick(reg, config, { planId: a.planId })).results).toEqual({ RETRY_WAIT: 1 }); // 컨테이너 생성 5xx — 부작용 없는 일시 실패, 실제 전송 의도 1
    const aJob = await jobOf(a.items[0]!.id);
    const [i1] = await intentsOf(aJob.id);
    expect(i1!.sanitizedDetails).toMatchObject({ mode: 'LIVE', live_approval_ref: 'D39-it' });
    const tA = i1!.createdAt.getTime();
    // 창 안(그 의도 + 24h 직전): A 는 이미 센 작업 — 재시도는 새로 세지 않는다
    expect(await livePublishDailyUsage(db, owner, aJob.id, new Date(tA + DAY - 1))).toMatchObject({ used: 0, thisJobCounted: true });
    // 정확히 + 24h: 창(created_at > now − 24h) 밖 — A 를 다시 보내면 새 게시로 센다
    expect(await livePublishDailyUsage(db, owner, aJob.id, new Date(tA + DAY))).toMatchObject({ used: 0, thisJobCounted: false });
    // 창이 지난 뒤 다른 작업 B 가 상한(1)을 쓰면 A 의 재시도는 보류(창 안이었다면 상한이 차도 보냈다)
    frozen = tA + DAY + MIN;
    const b = await planApproved(['창 지난 재시도 B 글.']);
    await execute(b.planId);
    expect((await tick(reg, config, { planId: b.planId })).results).toEqual({ CONFIRMED: 1 });
    expect((await tick(reg, config, { planId: a.planId })).results).toEqual({ BLOCKED: 1 });
    expect(await lastBlocked(aJob.id)).toMatchObject({ reason: 'live_publish_daily_limit', used: 1, limit: 1 });
    expect(await intentsOf(aJob.id)).toHaveLength(1); // 새 전송 의도 없음
    expect(fake.publishes()).toBe(1);
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

  // FIX-LIVEP2(G, 리뷰 확정 finding test.ts:434): PGlite 는 연결 하나에서 트랜잭션 전체를 직렬화한다(_runExclusiveTransaction) — 이 시험은 그 직렬화
  // 아래에서의 결과(한 건만 게시)만 본다. advisory 잠금을 지워도 통과하므로 **잠금 자체는 이 시험이 증명하지 않는다**(잠금은 아래 '잠금 순서' 시험이 본다).
  it('동시 실행(PGlite 한 연결 — 트랜잭션 직렬화, 판정 안 지연 주입): 상한 − 1 에서 승인 기록이 다른 두 작업 처리기가 동시에 → 한 건만 게시, 나머지는 보류(전송 의도 0)', async () => {
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
    // 관찰된 순서: 한 처리기의 판정(잠금 → 사용량 읽기)이 끝난 뒤 다른 처리기의 판정. PGlite 에서는 트랜잭션 직렬화 때문에도 이렇게 되므로
    // 이 순서는 advisory 잠금의 증거가 아니다(실제 Postgres 다중 연결에서의 상호 배제는 잠금 설계 + 아래 잠금 순서 시험에 기댄다).
    expect(order).toHaveLength(4);
    expect(order[0]!.split(':')[0]).toBe(order[1]!.split(':')[0]);
    expect(order[2]!.split(':')[0]).toBe(order[3]!.split(':')[0]);
    expect(order.map((o) => o.split(':')[1])).toEqual(['after_daily_lock', 'after_daily_usage', 'after_daily_lock', 'after_daily_usage']);
    await cancel(blocked.id);
  });

  // FIX-LIVEP2(G): 잠금을 실제로 잡는지 — 실행된 SQL 문장 순서(PGlite debug 기록)와 판정 시점의 pg_locks 로 본다. 잠금을 지우거나 읽기 뒤로 옮기면 실패한다.
  it('잠금 순서(SQL 문장 관찰 + pg_locks): beginSend 는 owner 별 일일 advisory 잠금을 중지 읽기·사용량 세기·전송 의도 쓰기보다 먼저 같은 트랜잭션에서 잡는다(상한 있음·없음), 게시 시도 표식 기록과 setLivePublishPaused 도 행 읽기·쓰기보다 먼저', async () => {
    const fake = fakeThreads();
    const sql0 = (s: { sql: string }) => s.sql.trim();
    /** i·j 가 같은 트랜잭션(사이에 COMMIT·ROLLBACK 없음, 앞에 BEGIN) 안인가 */
    const sameTx = (stmts: Array<{ sql: string }>, i: number, j: number) => {
      const [lo, hi] = [Math.min(i, j), Math.max(i, j)];
      const begin = stmts.slice(0, lo + 1).map(sql0).lastIndexOf('BEGIN');
      return begin >= 0 && !stmts.slice(begin + 1, hi + 1).some((s) => sql0(s) === 'COMMIT' || sql0(s) === 'ROLLBACK');
    };
    const isPauseRead = (lockMode: 'share' | 'update') => (s: { sql: string }) => s.sql.includes('from "live_publish_controls"') && s.sql.includes(`for ${lockMode}`);
    for (const daily of ['3', '']) {
      const config = cfg(daily);
      const p = await planApproved([`잠금 순서 글 ${daily || '상한 없음'}.`]);
      await execute(p.planId);
      const held: Record<string, boolean> = {};
      const { result, stmts } = await captureSql(() =>
        tick(registryWith(fake.fetch, config), config, {
          liveDailyHook: async (tx, at) => {
            held[at.phase] = await holdsDailyLock(tx);
          },
        }),
      );
      expect(result.results).toEqual({ CONFIRMED: 1 });
      expect(stmts.length).toBeGreaterThan(10); // PGlite 기록을 실제로 모았다
      // beginSend: 잠금 → 중지 읽기(FOR SHARE) → [상한 있으면] 사용량 세기 → 전송 의도 쓰기, 한 트랜잭션
      const lock = stmts.findIndex(isDailyLockStmt);
      const pauseRead = stmts.findIndex(isPauseRead('share'));
      const intentInsert = stmts.findIndex((s) => s.sql.startsWith('insert into "send_intents"'));
      expect(lock).toBeGreaterThan(-1);
      expect(pauseRead).toBeGreaterThan(lock);
      expect(intentInsert).toBeGreaterThan(pauseRead);
      expect(sameTx(stmts, lock, intentInsert)).toBe(true);
      // FIX2-LIVEP2(검토 #2·#5): beginSend 의 advisory 잠금 사이 순서 cs_rate:<계정>(배타) → cs_live_publish:<ref> → 일일 잠금, 모두 같은 트랜잭션.
      // 일일 잠금을 cs_rate·ref 잠금보다 앞에 두면(실제 Postgres 다중 연결에서 표식 트랜잭션과 교착) 여기서 실패한다.
      const rateLock = stmts.slice(0, lock).map(isRateExclusiveStmt).lastIndexOf(true);
      const refLock = stmts.slice(0, lock).map(isRefLockStmt('D39-it')).lastIndexOf(true);
      expect(rateLock).toBeGreaterThan(-1);
      expect(refLock).toBeGreaterThan(rateLock);
      expect(lock).toBeGreaterThan(refLock);
      expect(sameTx(stmts, rateLock, intentInsert)).toBe(true);
      // 같은 트랜잭션 안에서 일일 잠금은 한 번(cs_rate 앞에 일일 잠금을 더 잡는 변형도 잡는다)
      const txBegin = stmts.slice(0, rateLock + 1).map(sql0).lastIndexOf('BEGIN');
      expect(stmts.slice(txBegin, intentInsert).filter(isDailyLockStmt)).toHaveLength(1);
      // 판정 시점에 이 트랜잭션이 잠금을 쥐고 있다(pg_locks — 중지 읽기 전 훅)
      expect(held.after_daily_lock).toBe(true);
      if (daily) {
        const usage = stmts.findIndex((s) => s.sql.includes('from "send_intents"') && s.sql.includes("live_approval_ref' is not null"));
        expect(usage).toBeGreaterThan(pauseRead);
        expect(usage).toBeLessThan(intentInsert);
        expect(held.after_daily_usage).toBe(true);
      } else {
        expect(held.after_daily_usage).toBeUndefined(); // 상한 없음 — 사용량은 세지 않지만 잠금·중지 확인은 그대로
      }
      // 게시 시도 표식(publish_attempt) 기록: 같은 owner 잠금 → 중지 읽기 → 표식 행 쓰기, 한 트랜잭션(FIX-LIVEP2 D)
      const marker = stmts.findIndex((s) => s.sql.startsWith('insert into "remote_steps"') && s.params.includes('publish_attempt'));
      expect(marker).toBeGreaterThan(intentInsert);
      const markerLock = stmts.slice(0, marker).map(isDailyLockStmt).lastIndexOf(true);
      const markerPauseRead = stmts.slice(0, marker).map(isPauseRead('share')).lastIndexOf(true);
      expect(markerLock).toBeGreaterThan(intentInsert);
      expect(markerPauseRead).toBeGreaterThan(markerLock);
      expect(sameTx(stmts, markerLock, marker)).toBe(true);
      // FIX2-LIVEP2(검토 #2·#5): 표식 트랜잭션은 cs_rate:<계정>(공유)을 일일 잠금보다 **먼저** 같은 트랜잭션에서 잡는다(beginSend 와 같은 방향).
      // 순서를 바꾸면 일일 잠금 앞의 마지막 공유 잠금은 앞선 컨테이너 단계 기록(다른, 이미 커밋된 트랜잭션)의 것이 되어 sameTx 가 실패한다.
      const markerRateShared = stmts.slice(0, markerLock).map(isRateSharedStmt).lastIndexOf(true);
      expect(markerRateShared).toBeGreaterThan(intentInsert);
      expect(markerRateShared).toBeLessThan(markerLock);
      expect(sameTx(stmts, markerRateShared, marker)).toBe(true);
      const markerBegin = stmts.slice(0, markerRateShared + 1).map(sql0).lastIndexOf('BEGIN');
      expect(stmts.slice(markerBegin, marker).filter(isDailyLockStmt)).toHaveLength(1);
      expect(stmts.slice(markerBegin, marker).filter(isRateSharedStmt)).toHaveLength(1);
    }
    // setLivePublishPaused: 잠금 → 행 읽기(FOR UPDATE) → 쓰기, 한 트랜잭션
    const { stmts } = await captureSql(() => setLivePublishPaused(db, owner, true));
    const lock = stmts.findIndex(isDailyLockStmt);
    const read = stmts.findIndex(isPauseRead('update'));
    const write = stmts.findIndex((s) => s.sql.startsWith('insert into "live_publish_controls"'));
    expect(lock).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(lock);
    expect(write).toBeGreaterThan(read);
    expect(sameTx(stmts, lock, write)).toBe(true);
    await setLivePublishPaused(db, owner, false);
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

  // FIX-LIVEP2(B, 리뷰 확정 P1 test.ts:444): 중지는 "이미 집계된 작업"(창 안에 실제 전송 의도가 있는 재시도·이어 보내기) 예외와 일일 상한 설정에 상관없이
  // publish_attempt 표식 전의 모든 실제 전송을 막는다 — 상한 예외 안으로 옮기거나(!thisJobCounted) 상한 블록 안으로 옮기는 변형을 잡는다.
  for (const daily of ['', '3']) {
    it(`중지는 창 안에 이미 실제 전송 의도가 있는 작업의 자동 재시도도 막는다(일일 상한 ${daily || '없음'}): 컨테이너 5xx → RETRY_WAIT(의도 1) → 중지 → 다음 시도 BLOCKED live_publish_paused(의도 1 그대로·원격 호출 0) → 재개·재시도 → 게시`, async () => {
      const config = cfg(daily);
      const TEXT = `중지 재시도 글(상한 ${daily || '없음'}).`;
      const fake = fakeThreads({ failCreateOnce: new Set([TEXT]) });
      const reg = registryWith(fake.fetch, config);
      const p = await planApproved([TEXT]);
      await execute(p.planId);
      expect((await tick(reg, config)).results).toEqual({ RETRY_WAIT: 1 }); // 부작용 없는 일시 실패
      const job = await jobOf(p.items[0]!.id);
      expect(await intentsOf(job.id)).toHaveLength(1);
      // 이 작업은 이미 창 안에 집계됨(일일 상한 예외 대상) — 그래도 중지는 막아야 한다
      expect((await livePublishDailyUsage(db, owner, job.id, clockNow())).thisJobCounted).toBe(true);
      await setLivePublishPaused(db, owner, true);
      vt += 30 * MIN; // 자동 재시도 시각(약 30초 뒤) 지남
      const callsBefore = fake.calls.length;
      expect((await tick(reg, config)).results).toEqual({ BLOCKED: 1 });
      expect((await jobOf(p.items[0]!.id)).lastErrorCode).toBe('live_publish_paused');
      expect(await lastBlocked(job.id)).toMatchObject({ reason: 'live_publish_paused', not_sent: true });
      expect(await intentsOf(job.id)).toHaveLength(1);
      expect(fake.calls.length).toBe(callsBefore);
      expect(fake.publishes()).toBe(0);
      await setLivePublishPaused(db, owner, false);
      await retry(p.items[0]!.id);
      expect((await tick(reg, config)).results).toEqual({ CONFIRMED: 1 });
      expect(fake.publishes()).toBe(1);
      expect(await intentsOf(job.id)).toHaveLength(2);
    });
  }

  it('일일 상한 없음(PUBLISH_LIVE_DAILY_MAX 미설정)에서도 중지는 새 실제 작업을 막는다(BLOCKED live_publish_paused·전송 의도 0·원격 호출 0)', async () => {
    const config = cfg('');
    expect(config.PUBLISH_LIVE_DAILY_MAX).toBeUndefined();
    const fake = fakeThreads();
    const reg = registryWith(fake.fetch, config);
    const p = await planApproved(['상한 없음 중지 글.']);
    await execute(p.planId);
    await setLivePublishPaused(db, owner, true);
    expect((await tick(reg, config)).results).toEqual({ BLOCKED: 1 });
    const job = await jobOf(p.items[0]!.id);
    expect(job.lastErrorCode).toBe('live_publish_paused');
    expect(await intentsOf(job.id)).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
    await cancel(p.items[0]!.id);
  });

  // FIX-LIVEP2(C, 리뷰 확정 jobs.ts:1543·Codex Q3): 표식 전 결과 불명 → 조회가 남은 원격 단계가 게시되지 않았음을 증명('resumable' → 'resume') → 이어 보내기가
  // 중지에 막힘(전송 의도 전 not_sent). 마지막 의도는 여전히 ambiguous 지만 재개 뒤 '재시도'로 보낼 수 있어야 한다(자동 전송 없음, 남은 게시만).
  it('결과 불명(표식 전) → 조회 resume → 중지로 보류된 작업: 재개만으로는 보내지 않고, 재시도하면 같은 컨테이너로 남은 게시 1건만(새 컨테이너 0·재게시 0)', async () => {
    const config = cfg('3');
    const TEXT = '이어 보내기 중지 글.';
    const fake = fakeThreads({ statusFailOnce: new Set([TEXT]) });
    const reg = registryWith(fake.fetch, config);
    const p = await planApproved([TEXT]);
    const itemId = p.items[0]!.id;
    await execute(p.planId);
    // 컨테이너 생성 뒤 상태 읽기 실패 — 표식 전 결과 불명(RECONCILING, 의도 ambiguous)
    expect((await tick(reg, config)).results).toEqual({ RECONCILING: 1 });
    const job = await jobOf(itemId);
    expect((await intentsOf(job.id)).map((i) => i.outcome)).toEqual(['ambiguous']);
    expect([fake.creates(), fake.publishes()]).toEqual([1, 0]);
    // 소유자가 결과 불명 글을 보고 중지
    await setLivePublishPaused(db, owner, true);
    vt += 2 * MIN;
    // 조회: 컨테이너 FINISHED · 게시 시도 표식 없음 → resume(RETRY_WAIT) — 의도는 채우지 않는다(ambiguous 그대로)
    expect((await tick(reg, config)).results).toEqual({ RETRY_WAIT: 1 });
    // 이어 보내기 → 중지로 보류(전송 의도 없음)
    expect((await tick(reg, config)).results).toEqual({ BLOCKED: 1 });
    expect((await jobOf(itemId)).lastErrorCode).toBe('live_publish_paused');
    expect((await intentsOf(job.id)).map((i) => i.outcome)).toEqual(['ambiguous']);
    expect([fake.creates(), fake.publishes()]).toEqual([1, 0]);
    // 재개만으로는 보내지 않는다
    await setLivePublishPaused(db, owner, false);
    expect((await tick(reg, config)).results).toEqual({});
    // 재시도(이전: 409 outcome_unknown — 새 계획 말고는 길이 없었다) → beginSend 재검사 → 같은 컨테이너로 게시
    await retry(itemId);
    expect((await tick(reg, config)).results).toEqual({ CONFIRMED: 1 });
    expect([fake.creates(), fake.publishes()]).toEqual([1, 1]);
    expect((await intentsOf(job.id)).map((i) => i.outcome)).toEqual(['ambiguous', 'accepted']);
    expect((await listRemoteSteps(db, owner, job.id)).map((s) => s.kind).sort()).toEqual(['container', 'publish', 'publish_attempt']);
    const unblock = (await eventsOf(job.id)).find((e) => (e.sanitizedDetails as { event?: string }).event === 'unblock');
    expect(unblock?.sanitizedDetails).toMatchObject({ cause: 'user_retry', previous_error: 'live_publish_paused', unresolved_intent_cleared_by: 'reconcile_resume' });
  });

  it('결과 불명 의도가 남은 보류 작업이라도 그 앞에 조회의 resume 증명이 없으면 재시도 거부(409 outcome_unknown, 아무것도 바꾸지 않음) — 직접 만든 상태', async () => {
    const config = cfg('3');
    const TEXT = '증명 없는 보류 글.';
    const fake = fakeThreads({ statusFailOnce: new Set([TEXT]) });
    const p = await planApproved([TEXT]);
    const itemId = p.items[0]!.id;
    await execute(p.planId);
    expect((await tick(registryWith(fake.fetch, config), config)).results).toEqual({ RECONCILING: 1 });
    const job = await jobOf(itemId);
    // 조회(resume) 없이 "중지 보류"가 된 상태를 직접 만든다(코드 경로로는 생기지 않는 상태 — 재시도 판단이 차단 사유만 보지 않고 증명을 요구하는지 고정)
    const n = ((await db.execute(sql`select coalesce(max(event_seq), 0)::int as n from job_events where job_id = ${job.id}`)).rows as Array<{ n: number }>)[0]!.n;
    await db.execute(sql`update jobs set state = 'BLOCKED', lease_owner = null, lease_until = null, last_error_code = 'live_publish_paused' where id = ${job.id}`);
    await db.execute(sql`update distribution_items set status = 'BLOCKED' where id = ${itemId}`);
    await db.execute(sql`insert into job_events (owner_id, job_id, event_seq, state_before, state_after, at, sanitized_details)
      values (${owner}, ${job.id}, ${n + 1}, 'RECONCILING', 'BLOCKED', now(), ${JSON.stringify({ event: 'blocked', transition: 'blocked', reason: 'live_publish_paused', not_sent: true })}::jsonb)`);
    const res = await retryPOST(post(`/api/distribution-items/${itemId}/retry`), ctx(itemId));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('outcome_unknown');
    expect((await jobOf(itemId)).state).toBe('BLOCKED');
    expect(fake.publishes()).toBe(0);
    await cancel(itemId);
  });

  // FIX2-LIVEP2(검토 #1·#6 jobs.ts:1581): resume 증명이 있어도 결과 기록 없는 게시 시도 표식(publish_attempt 만 있고 publish 없음)이 있으면 거부하는 방어선.
  // 정상 경로로는 lease 를 잃은 늦은 제출이 resume 뒤에 표식을 남길 때만 생기므로 표식 행을 SQL 로 넣는다. `|| unresolvedAttempts > 0` 을 지우면 200 이 된다.
  it('resume 증명이 있는 중지 보류라도 게시 결과 없는 게시 시도 표식이 있으면 재시도 거부(409 outcome_unknown) — unblock·새 의도·원격 호출 0', async () => {
    const config = cfg('3');
    const TEXT = '증명 있음 표식 남은 글.';
    const fake = fakeThreads({ statusFailOnce: new Set([TEXT]) });
    const reg = registryWith(fake.fetch, config);
    const p = await planApproved([TEXT]);
    const itemId = p.items[0]!.id;
    await execute(p.planId);
    expect((await tick(reg, config)).results).toEqual({ RECONCILING: 1 });
    const job = await jobOf(itemId);
    await setLivePublishPaused(db, owner, true);
    vt += 2 * MIN;
    expect((await tick(reg, config)).results).toEqual({ RETRY_WAIT: 1 }); // 조회 resume(증명)
    expect((await tick(reg, config)).results).toEqual({ BLOCKED: 1 }); // 이어 보내기 → 중지 보류(전송 의도 전)
    await setLivePublishPaused(db, owner, false);
    expect((await jobOf(itemId)).lastErrorCode).toBe('live_publish_paused');
    // 이 상태 그대로면 재시도 가능(위 시험) — 증명은 있다
    const evsForProof = (await eventsOf(job.id)).map((e) => ({ eventSeq: e.eventSeq, details: e.sanitizedDetails as Record<string, unknown> }));
    expect(resumeProvenRetryable(evsForProof, (await jobOf(itemId)).attempt)).toBe(true);
    // 결과 기록 없는 게시 시도 표식(늦은 제출이 남긴 것과 같은 모양)
    const steps = await listRemoteSteps(db, owner, job.id);
    expect(steps.map((s) => s.kind)).toEqual(['container']);
    const containerId = liveThreadsStepRaw(steps[0]!.remoteId)!;
    const [intent1] = await intentsOf(job.id);
    await db.execute(sql`insert into remote_steps (owner_id, job_id, intent_id, item_id, step_index, kind, post_index, remote_id, status, resume_count, created_at, updated_at)
      values (${owner}, ${job.id}, ${intent1!.id}, ${itemId}, 1, 'publish_attempt', 0, ${liveThreadsStepId.publishAttempt(containerId)}, 'created', 0, now(), now())`);
    const eventsBefore = (await eventsOf(job.id)).length;
    const intentsBefore = (await intentsOf(job.id)).map((i) => [i.attempt, i.outcome]);
    const callsBefore = fake.calls.length;
    const res = await retryPOST(post(`/api/distribution-items/${itemId}/retry`), ctx(itemId));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('outcome_unknown');
    const after = await jobOf(itemId);
    expect(after.state).toBe('BLOCKED');
    expect(after.lastErrorCode).toBe('live_publish_paused');
    expect((await itemOf(itemId)).status).toBe('BLOCKED');
    expect((await eventsOf(job.id)).length).toBe(eventsBefore); // unblock 없음
    expect((await eventsOf(job.id)).some((e) => (e.sanitizedDetails as { event?: string }).event === 'unblock')).toBe(false);
    expect((await intentsOf(job.id)).map((i) => [i.attempt, i.outcome])).toEqual(intentsBefore);
    expect((await tick(reg, config)).results).toEqual({}); // 대기열에 들어가지 않았다
    expect(fake.calls.length).toBe(callsBefore);
    expect(fake.publishes()).toBe(0);
  });

  // FIX-LIVEP2(D, 리뷰 확정 P2 jobs.ts:900): 전송 시작(beginSend) 뒤·게시 시도 표식 전에 커밋된 중지 — 표식 기록 트랜잭션이 같은 잠금 아래에서 다시 보고
  // 표식·게시 없이 멈춘다. 표식 뒤는 기존 결과 규칙 그대로(아래 시험).
  it('중지가 전송 시작 뒤·게시 시도 표식 전에 커밋되면: 표식·게시 없이 BLOCKED live_publish_paused(not_sent·의도 rejected), 컨테이너는 남김 → 재개·재시도 → 같은 컨테이너로 게시 1', async () => {
    const config = cfg('3');
    const TEXT = '표식 전 중지 글.';
    const fake = fakeThreads({
      onCreate: async (t) => {
        if (t === TEXT && !(await getLivePublishPaused(db, owner)).paused) await setLivePublishPaused(db, owner, true);
      },
    });
    const reg = registryWith(fake.fetch, config);
    const p = await planApproved([TEXT]);
    const itemId = p.items[0]!.id;
    await execute(p.planId);
    expect((await tick(reg, config)).results).toEqual({ BLOCKED: 1 });
    const job = await jobOf(itemId);
    expect(job.lastErrorCode).toBe('live_publish_paused');
    expect(await lastBlocked(job.id)).toMatchObject({ reason: 'live_publish_paused', not_sent: true, stage: 'before_publish_attempt', error_code: 'live_publish_paused' });
    expect((await intentsOf(job.id)).map((i) => i.outcome)).toEqual(['rejected']);
    expect((await listRemoteSteps(db, owner, job.id)).map((s) => s.kind)).toEqual(['container']);
    expect([fake.creates(), fake.publishes()]).toEqual([1, 0]);
    await setLivePublishPaused(db, owner, false);
    expect((await tick(reg, config)).results).toEqual({});
    await retry(itemId);
    expect((await tick(reg, config)).results).toEqual({ CONFIRMED: 1 });
    expect([fake.creates(), fake.publishes()]).toEqual([1, 1]);
    expect((await listRemoteSteps(db, owner, job.id)).map((s) => s.kind).sort()).toEqual(['container', 'publish', 'publish_attempt']);
  });

  // FIX2-LIVEP2(검토 #3 jobs.ts:1002): 표식 전 중지 보류는 시도 한도에 세지 않는다 — 마지막 시도(max_attempts)에서 멈춰도 화면이 약속한 "재개 뒤 '재시도'"가
  // 409 attempts_exhausted 막다른 길이 되지 않는다. 자동 재시도는 늘지 않는다(보류는 BLOCKED — 사용자의 중지·재개·재시도가 있어야만 다음 시도).
  it('마지막 시도(5/5)에서 표식 전 중지 → BLOCKED(시도 세지 않음) → 재개만으로는 보내지 않고, 재시도하면 같은 컨테이너로 게시 1회', async () => {
    const config = cfg('3');
    const TEXT = '마지막 시도 표식 전 중지 글.';
    const fake = fakeThreads({
      failCreateTimes: new Map([[TEXT, 4]]), // 시도 1~4: 컨테이너 생성 5xx(부작용 없는 일시 실패 — 시도로 센다)
      onCreate: async (t) => {
        if (t === TEXT && !(await getLivePublishPaused(db, owner)).paused) await setLivePublishPaused(db, owner, true);
      },
    });
    const reg = registryWith(fake.fetch, config);
    const p = await planApproved([TEXT]);
    const itemId = p.items[0]!.id;
    await execute(p.planId);
    for (let i = 0; i < 4; i++) {
      expect((await tick(reg, config)).results).toEqual({ RETRY_WAIT: 1 });
      vt += 30 * MIN; // 다음 자동 시도 시각(최대 15분 + 20%) 지남
    }
    const before = await jobOf(itemId);
    expect([before.attempt, before.maxAttempts, before.resumeCount]).toEqual([4, 5, 0]);
    // 시도 5(마지막): 컨테이너 생성 뒤·표식 전 중지 → 표식·게시 없이 BLOCKED
    expect((await tick(reg, config)).results).toEqual({ BLOCKED: 1 });
    const job = await jobOf(itemId);
    expect(job.lastErrorCode).toBe('live_publish_paused');
    expect(job.attempt).toBe(5);
    expect(await lastBlocked(job.id)).toMatchObject({ reason: 'live_publish_paused', not_sent: true, stage: 'before_publish_attempt', counted: false });
    expect(job.resumeCount).toBe(1); // 이 시도는 시도 한도에 세지 않는다(센 시도 4/5)
    expect((await intentsOf(job.id)).map((i) => i.outcome)).toEqual(['rejected', 'rejected', 'rejected', 'rejected', 'rejected']);
    expect([fake.creates(), fake.publishes()]).toEqual([5, 0]);
    await setLivePublishPaused(db, owner, false);
    expect((await tick(reg, config)).results).toEqual({}); // 재개는 자동으로 보내지 않는다
    // 이전: 409 attempts_exhausted("새 배포 계획을 만드세요") — 보류 문구는 재시도할 수 있다고 했다
    await retry(itemId);
    expect((await tick(reg, config)).results).toEqual({ CONFIRMED: 1 });
    expect([fake.creates(), fake.publishes()]).toEqual([5, 1]); // 새 컨테이너 0 — 기록된 컨테이너로 남은 게시만
    const done = await jobOf(itemId);
    expect([done.state, done.attempt, done.resumeCount]).toEqual(['CONFIRMED', 6, 1]);
    expect((await listRemoteSteps(db, owner, job.id)).map((s) => s.kind).sort()).toEqual(['container', 'publish', 'publish_attempt']);
  });

  it('중지가 게시 시도 표식 뒤(게시 요청 중)에 커밋되면 그 게시는 기존 결과 규칙 그대로 확인된다(보류로 바꾸지 않음)', async () => {
    const config = cfg('3');
    const TEXT = '표식 뒤 중지 글.';
    const fake = fakeThreads({
      onPublish: async (t) => {
        if (t === TEXT) await setLivePublishPaused(db, owner, true);
      },
    });
    const p = await planApproved([TEXT]);
    await execute(p.planId);
    expect((await tick(registryWith(fake.fetch, config), config)).results).toEqual({ CONFIRMED: 1 });
    expect((await getLivePublishPaused(db, owner)).paused).toBe(true);
    const job = await jobOf(p.items[0]!.id);
    expect(job.lastErrorCode).toBeNull();
    expect((await eventsOf(job.id)).some((e) => (e.sanitizedDetails as { reason?: unknown }).reason === 'live_publish_paused')).toBe(false);
    expect(fake.publishes()).toBe(1);
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

// FIX-LIVEP2(F, 리뷰 확정 jobs.ts:730): 승인된 예약 실제 게시가 상한·중지로 보류(attempt 0)된 뒤 예약 시각보다 60분 넘게 지나 재시도하면 D36(오래 지난 예약 자동
// 전송 금지)이 그대로 적용된다 — 다만 첫 재시도가 대기열에 들어갔다가 tick 에서야 schedule_stale 로 다시 보류되는 헛된 한 바퀴 대신, 재시도 자체가 바로
// D36 확인 요청(409 schedule_stale)으로 끝나고, 다음 재시도가 기존 D36 명시 확인이 된다(60분 기준·확인 규칙은 바꾸지 않음).
describe('예약 실제 항목(D36) — 상한·중지 보류 뒤 재시도', () => {
  for (const cause of ['live_publish_daily_limit', 'live_publish_paused'] as const) {
    it(`예약 항목이 ${cause} 로 보류 → 예약 시각보다 60분 넘게 지나 재시도: 첫 재시도는 바로 409 schedule_stale(대기열에 넣지 않음·원격 호출 0), 두 번째 재시도(D36 명시 확인)로 게시`, async () => {
      const config = cfg('1');
      const fake = fakeThreads();
      const reg = registryWith(fake.fetch, config);
      let windowFreeAt = 0;
      if (cause === 'live_publish_daily_limit') {
        const a = await planApproved(['예약 상한 앞선 글.']);
        await execute(a.planId);
        expect((await tick(reg, config, { planId: a.planId })).results).toEqual({ CONFIRMED: 1 }); // 1/1 사용
        windowFreeAt = (await intentsOf((await jobOf(a.items[0]!.id)).id))[0]!.createdAt.getTime() + DAY;
      }
      const s = await planApproved([`예약 글(${cause}).`], liveAccount, 'public_publish', mskSchedule(clockNow().getTime() + 10 * MIN));
      const sItem = s.items[0]!.id;
      const planId = s.planId;
      await execute(s.planId);
      const sched = (await itemOf(sItem)).scheduledAtUtc!.getTime();
      expect((await tick(reg, config, { planId })).results).toEqual({}); // 예약 시각 전
      if (cause === 'live_publish_paused') await setLivePublishPaused(db, owner, true);
      frozen = sched + MIN; // 예약 시각 1분 뒤 — 아직 오래되지 않음(D36 통과), 상한·중지로 보류
      expect((await tick(reg, config, { planId })).results).toEqual({ BLOCKED: 1 });
      const job = await jobOf(sItem);
      expect(job.lastErrorCode).toBe(cause);
      expect(job.attempt).toBe(0);
      if (cause === 'live_publish_paused') await setLivePublishPaused(db, owner, false);
      // 창이 풀린 뒤·재개 뒤 — 예약 시각보다 60분 넘게 지남
      frozen = Math.max(sched + 2 * HOUR, windowFreeAt);
      const callsBefore = fake.calls.length;
      await expect(retryItem(db, owner, sItem, clockNow())).rejects.toMatchObject({ code: 'schedule_stale' });
      const after = await jobOf(sItem);
      expect(after.state).toBe('BLOCKED');
      expect(after.lastErrorCode).toBe('schedule_stale');
      expect(await lastBlocked(job.id)).toMatchObject({ reason: 'schedule_stale', not_sent: true, cause: 'retry_precheck' });
      expect((await itemOf(sItem)).status).toBe('BLOCKED');
      expect((await tick(reg, config, { planId })).results).toEqual({}); // 대기열에 들어가지 않았다
      expect(fake.calls.length).toBe(callsBefore);
      // 두 번째 재시도 = 오래 지난 예약을 지금 보내겠다는 명시적 확인(D36 그대로) → 게시
      expect((await retryItem(db, owner, sItem, clockNow())).state).toBe('QUEUED');
      expect((await tick(reg, config, { planId })).results).toEqual({ CONFIRMED: 1 });
      expect(await intentsOf(job.id)).toHaveLength(1);
      expect(fake.publishes()).toBe(cause === 'live_publish_daily_limit' ? 2 : 1);
    });
  }

  // FIX2-LIVEP2(검토 #7 distribution.ts:126): 위 시험은 retryItem 을 직접 부른다 — 사용자가 실제로 보는 결과(재시도 route 의 409 schedule_stale, 폼의
  // 한국어 문구 "한 번 더 재시도")를 route 로 고정한다. route 는 실제 시계(new Date())를 쓰므로 Date 만 가짜로 돌린다(코드베이스의 auth 시험과 같은 방식).
  it('재시도 route: 중지로 보류된 예약 항목을 60분 넘게 지나 재시도 → JSON 409 schedule_stale(문구·늦은 분), 폼은 303 ?error=schedule_stale → 그 화면 문구 = SCHEDULE_STALE_RETRY_MESSAGE, 두 번째 재시도(폼)로 게시', async () => {
    const config = cfg('3');
    const fake = fakeThreads();
    const reg = registryWith(fake.fetch, config);
    const s = await planApproved(['예약 route JSON 글.', '예약 route 폼 글.'], liveAccount, 'public_publish', mskSchedule(clockNow().getTime() + 10 * MIN));
    const [jsonItem, formItem] = s.items.map((i) => i.id) as [string, string];
    await execute(s.planId);
    const sched = (await itemOf(jsonItem)).scheduledAtUtc!.getTime();
    await setLivePublishPaused(db, owner, true);
    frozen = sched + MIN;
    expect((await tick(reg, config, { planId: s.planId })).results).toEqual({ BLOCKED: 2 });
    await setLivePublishPaused(db, owner, false);
    frozen = sched + 2 * HOUR; // 예약 시각보다 60분 넘게 지남
    const callsBefore = fake.calls.length;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(frozen);
      const t = await login(A); // 가짜 시각 기준 세션
      // JSON: 409 schedule_stale — 대기열에 넣지 않고 보류 이력만 남김
      const res = await retryPOST(jsonPost(`/api/distribution-items/${jsonItem}/retry`, {}, cookieHeader(t)), ctx(jsonItem));
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; message: string; late_minutes: number };
      expect(body.error).toBe('schedule_stale');
      expect(body.message).toBe(SCHEDULE_STALE_RETRY_MESSAGE);
      expect(body.late_minutes).toBeGreaterThanOrEqual(60);
      // 폼(HTML): 303 → 계획 화면 ?error=schedule_stale, 그 코드의 화면 문구가 "한 번 더 재시도" 안내(일반 conflict 문구 아님)
      const form = (itemId: string) =>
        new Request(`${BASE}/api/distribution-items/${itemId}/retry`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', origin: BASE, ...cookieHeader(t) },
          body: new URLSearchParams({ plan_id: s.planId }).toString(),
        });
      const f1 = await retryPOST(form(formItem), ctx(formItem));
      expect(f1.status).toBe(303);
      expect(f1.headers.get('location')).toBe(`/distribute/${s.planId}?error=schedule_stale`);
      const code = new URL(f1.headers.get('location')!, BASE).searchParams.get('error')!;
      expect(DISTRIBUTE_ERROR_TEXT[code]).toBe(SCHEDULE_STALE_RETRY_MESSAGE);
      expect(DISTRIBUTE_ERROR_TEXT[code]).not.toBe(DISTRIBUTE_ERROR_TEXT.conflict);
      for (const id of [jsonItem, formItem]) {
        expect(await jobOf(id)).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'schedule_stale', attempt: 0 });
        expect(await lastBlocked((await jobOf(id)).id)).toMatchObject({ reason: 'schedule_stale', not_sent: true, cause: 'retry_precheck' });
      }
      expect((await tick(reg, config, { planId: s.planId })).results).toEqual({}); // 둘 다 대기열에 없음
      expect(fake.calls.length).toBe(callsBefore);
      // 문구가 약속한 대로: 두 번째 재시도(폼) = D36 명시 확인 → 303 retried=1 → 게시
      const f2 = await retryPOST(form(formItem), ctx(formItem));
      expect(f2.headers.get('location')).toBe(`/distribute/${s.planId}?retried=1`);
    } finally {
      vi.useRealTimers();
    }
    expect((await tick(reg, config, { planId: s.planId })).results).toEqual({ CONFIRMED: 1 });
    expect(fake.publishes()).toBe(1);
    expect((await jobOf(jsonItem)).state).toBe('BLOCKED');
    await cancel(jsonItem);
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
