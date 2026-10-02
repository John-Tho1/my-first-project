/**
 * T14(결정 D26) Threads 모의 훈련 — `pnpm drill:mock` 이 M3 표 다음에 찍는다. 버리는 메모리 DB, 시험용 난수 키, 프로세스 안 모의 OAuth·모의 Threads.
 * 계정은 T13 모의 OAuth 흐름(startOAuthConnect → 모의 동의 → completeOAuthCallback)으로 연결한다. **외부 호출 0**(fetch 를 막고 센다).
 *
 * 불변식(하나라도 어기면 violations → exit 1):
 * - 게시물마다 컨테이너 단계 ≤ 1·게시 단계 ≤ 1, 시뮬레이터의 컨테이너별 게시 수 ≤ 1(중복 컨테이너·중복 게시 없음)
 * - 시뮬레이터의 그 계정 게시물 수 = 게시 단계 수(기록 없는 게시·재게시 없음)
 * - 스레드 전체가 게시되기 전에는 publication 없음, CONFIRMED 이면 publication 1개(MOCK·mock:threads:·mock://threads/)
 * - 행마다 기대한 최종 상태와 같다, fetch 0
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { loadConfig, requireSecretKeyring, type MockScenarioValue } from '@cs/domain';
import {
  MockChannelAdapter,
  MockChannelAdapterRegistry,
  MockOAuthStore,
  mockOAuthTokenCheck,
  MockThreadsOAuthProvider,
  ThreadsMockApi,
  ThreadsMockChannelAdapter,
  THREADS_PROVISIONAL_RATE_LIMIT,
} from '@cs/providers';
import {
  approveItems,
  completeOAuthCallback,
  createContent,
  createPlan,
  createSession,
  createTestDb,
  createVariantDraft,
  executePlan,
  runJobsTick,
  schema,
  seed,
  setMockScenario,
  setVariantLifecycle,
  startOAuthConnect,
  type Db,
} from '../src/index';

export interface ThreadsDrillRow {
  scenario: string;
  posts: number;
  job_state: string;
  item_status: string;
  intents: number;
  containers: number;
  publishes: number;
  publication: string;
  republish: string;
  ok: boolean;
}

export interface ThreadsDrillResult {
  rows: ThreadsDrillRow[];
  violations: string[];
  fetch_calls: number;
}

const config = loadConfig({ PUBLISH_MODE: 'disabled' });
const MIN = 60_000;
const REDIRECT = 'http://localhost:3000/api/oauth/callback';
const ACTIVE = ['QUEUED', 'LEASED', 'SENDING', 'REMOTE_PROCESSING', 'RETRY_WAIT', 'RECONCILING', 'CANCEL_REQUESTED'];
const ONE = '해외 영업 첫 분기(모의 훈련) — 대리점과 재고 기준을 먼저 합의했다.';
const THREE = '첫째 — 재고 기준을 먼저 합의했다.\n\n둘째 — 가격표는 마지막에 확정했다.\n\n셋째 — 매주 같은 요일에 숫자를 맞췄다.';

interface Ctx {
  db: Db;
  offset: number;
  owner: string;
  sessionId: string;
  keyring: ReturnType<typeof requireSecretKeyring>;
  provider: MockThreadsOAuthProvider;
  api: ThreadsMockApi;
  threads: ThreadsMockChannelAdapter;
  registry: MockChannelAdapterRegistry;
}

const clockOf = (c: Ctx) => () => new Date(Date.now() + c.offset);

async function linkedAccount(c: Ctx): Promise<{ id: string; external: string }> {
  const external = `mock:threads:${randomUUID()}`;
  const [row] = await c.db
    .insert(schema.channelAccounts)
    .values({ ownerId: c.owner, platform: 'threads', kind: 'mock', externalAccountId: external, displayName: 'MOCK Threads 훈련', state: 'mock_ready' })
    .returning();
  const keyring = () => c.keyring;
  const providerFor = () => c.provider;
  const start = await startOAuthConnect(c.db, { ownerId: c.owner, sessionId: c.sessionId, accountId: row!.id, providerFor, keyring, redirectUri: REDIRECT });
  const u = new URL(start.authorizeUrl);
  const q = (k: string) => u.searchParams.get(k);
  const a = c.provider.authorize(
    {
      client_id: q('client_id'),
      redirect_uri: q('redirect_uri'),
      response_type: q('response_type'),
      scope: q('scope'),
      state: q('state'),
      code_challenge: q('code_challenge'),
      code_challenge_method: q('code_challenge_method'),
      login_hint: q('login_hint'),
    },
    new Date(),
  );
  if (!a.ok) throw new Error(`모의 동의 실패: ${a.error}`);
  const back = new URL(a.redirect);
  await completeOAuthCallback(c.db, {
    ownerId: c.owner,
    sessionId: c.sessionId,
    query: { state: back.searchParams.get('state') ?? undefined, code: back.searchParams.get('code') ?? undefined },
    requestTarget: REDIRECT,
    redirectUri: REDIRECT,
    providerFor,
    keyring,
  });
  return { id: row!.id, external };
}

async function executed(c: Ctx, accountId: string, body: string, scenario?: MockScenarioValue): Promise<string> {
  const { content } = await createContent(c.db, c.owner, { title: '훈련 threads', body });
  const { variant } = await createVariantDraft(c.db, c.owner, content.id, { channel: 'threads', baseVersion: 1 });
  await setVariantLifecycle(c.db, c.owner, variant.id, { lifecycle: 'review', baseVersion: 1 });
  const { plan, items } = await createPlan(c.db, c.owner, { items: [{ variant_id: variant.id, channel_account_id: accountId }] });
  const item = items[0]!;
  if (scenario) await setMockScenario(c.db, c.owner, item.id, { scenario });
  await approveItems(c.db, c.owner, plan.id, { item_ids: [item.id], expected_hashes: { [item.id]: item.payloadHash }, confirm: true, purpose: 'mock_publish' });
  await executePlan(c.db, c.owner, plan.id, { commandKey: `drill-thr-${randomUUID()}` }, config);
  return item.id;
}

async function tick(c: Ctx, advanceMs = 20 * MIN): Promise<void> {
  await runJobsTick(c.db, c.registry, {
    workerId: 'drill-thr',
    config,
    ownerId: c.owner,
    clock: clockOf(c),
    random: () => 0.5,
    submitTimeoutMs: 2000,
    maxJobs: 20,
    credentials: { keyring: () => c.keyring },
  });
  c.offset += advanceMs;
}

async function drain(c: Ctx, itemId: string, maxTicks = 16): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    await tick(c);
    const jobs = await c.db.select({ state: schema.jobs.state }).from(schema.jobs).where(eq(schema.jobs.itemId, itemId));
    if (!jobs.some((j) => ACTIVE.includes(j.state))) return;
  }
}

async function record(
  c: Ctx,
  out: ThreadsDrillResult,
  scenario: string,
  itemId: string,
  external: string,
  expected: { job_state: string; item_status: string; intents?: number; publication: boolean },
  /** 계정 하나를 여러 항목이 쓰면 원격 게시물 수 비교는 호출자가 합으로 한다 */
  opts: { accountPosts: boolean } = { accountPosts: true },
): Promise<void> {
  const v = (m: string) => out.violations.push(`${scenario}: ${m}`);
  const item = (await c.db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, itemId)))[0]!;
  const posts = ((item.payloadJson as { text?: { posts?: unknown[] } }).text?.posts ?? []).length;
  const jobs = await c.db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)).orderBy(asc(schema.jobs.createdAt));
  const jobIds = jobs.map((j) => j.id);
  const intents = jobIds.length ? await c.db.select().from(schema.sendIntents).where(inArray(schema.sendIntents.jobId, jobIds)) : [];
  const steps = await c.db.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.itemId, itemId));
  const pubs = await c.db.select().from(schema.publications).where(eq(schema.publications.itemId, itemId));
  const containers = steps.filter((s) => s.kind === 'container');
  const publishes = steps.filter((s) => s.kind === 'publish');
  for (let i = 0; i < posts; i++) {
    if (containers.filter((s) => s.postIndex === i).length > 1) v(`게시물 ${i + 1} 컨테이너 단계 2개 이상`);
    if (publishes.filter((s) => s.postIndex === i).length > 1) v(`게시물 ${i + 1} 게시 단계 2개 이상`);
  }
  for (const ct of containers) if ((c.api.publishCount.get(ct.remoteId) ?? 0) > 1) v(`컨테이너 ${ct.remoteId} 를 두 번 게시`);
  const remotePosts = c.api.postsOf(external);
  if (opts.accountPosts && remotePosts.length !== publishes.length) v(`원격 게시물 ${remotePosts.length}개 ≠ 게시 단계 ${publishes.length}개(기록 없는 게시 또는 재게시)`);
  if (pubs.length > 1) v(`publication ${pubs.length}개`);
  if (pubs.length && publishes.length !== posts) v('스레드 전체가 게시되기 전에 publication 이 생김');
  for (const p of pubs) {
    if (!p.isMock || p.verification !== 'MOCK' || !p.externalId.startsWith('mock:threads:') || !(p.permalink ?? '').startsWith('mock://threads/')) v('MOCK 이 아닌 publication');
  }
  const jobState = jobs.at(-1)?.state ?? '(없음)';
  if (jobState === 'CONFIRMED' && pubs.length !== 1) v('CONFIRMED 인데 publication 없음');
  const mismatch: string[] = [];
  if (jobState !== expected.job_state) mismatch.push(`job ${jobState} ≠ ${expected.job_state}`);
  if (item.status !== expected.item_status) mismatch.push(`항목 ${item.status} ≠ ${expected.item_status}`);
  if (expected.intents !== undefined && intents.length !== expected.intents) mismatch.push(`intent ${intents.length} ≠ ${expected.intents}`);
  if ((pubs.length === 1) !== expected.publication) mismatch.push(`publication ${pubs.length}`);
  if (mismatch.length) v(`기대와 다름: ${mismatch.join(', ')}`);
  const p = pubs[0];
  out.rows.push({
    scenario,
    posts,
    job_state: jobState,
    item_status: item.status,
    intents: intents.length,
    containers: containers.length,
    publishes: publishes.length,
    publication: p ? `MOCK ${p.resultKind}/${p.remoteVisibility}` : '없음',
    republish: [...c.api.publishCount.entries()].some(([id, n]) => n > 1 && containers.some((x) => x.remoteId === id)) ? '위반' : '없음',
    ok: mismatch.length === 0,
  });
}

const CONF = (intents: number) => ({ job_state: 'CONFIRMED', item_status: 'CONFIRMED', intents, publication: true });

export async function runThreadsDrill(): Promise<ThreadsDrillResult> {
  const handle = await createTestDb();
  const out: ThreadsDrillResult = { rows: [], violations: [], fetch_calls: 0 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    out.fetch_calls++;
    throw new Error('drill: 네트워크 호출 금지');
  }) as typeof fetch;
  try {
    const keyring = requireSecretKeyring({ SECRETS_MASTER_KEY: randomBytes(32).toString('base64'), SECRETS_KEY_VERSION: '1' });
    const store = new MockOAuthStore();
    const provider = new MockThreadsOAuthProvider({ registeredRedirectUri: REDIRECT, appBaseUrl: 'http://localhost:3000', store });
    const api = new ThreadsMockApi({ tokenCheck: mockOAuthTokenCheck(store) });
    const threads = new ThreadsMockChannelAdapter({ api });
    const { ownerId } = await seed(handle.db, { allowedIdentity: `drill-thr-${randomUUID().slice(0, 8)}@example.local` });
    const session = await createSession(handle.db, {
      ownerId,
      tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
      expiresAt: new Date(Date.now() + 30 * 24 * 3600_000),
      userAgentHash: null,
      now: new Date(),
    });
    const c: Ctx = {
      db: handle.db,
      offset: 0,
      owner: ownerId,
      sessionId: session.id,
      keyring,
      provider,
      api,
      threads,
      registry: new MockChannelAdapterRegistry(new MockChannelAdapter({ readEnv: false }), threads),
    };

    const single: Array<{ label: string; body: string; scenario?: MockScenarioValue; expected: Parameters<typeof record>[5] }> = [
      { label: 'threads_success · 1개', body: ONE, scenario: 'threads_success', expected: CONF(1) },
      { label: 'threads_success · 스레드 3개', body: THREE, scenario: 'threads_success', expected: CONF(1) },
      { label: 'threads_container_slow → 같은 컨테이너', body: ONE, scenario: 'threads_container_slow', expected: CONF(2) },
      { label: 'threads_publish_timeout_sent → 조회로 확인', body: ONE, scenario: 'threads_publish_timeout_sent', expected: CONF(1) },
      { label: 'threads_publish_timeout_not_sent → 같은 컨테이너로 게시', body: ONE, scenario: 'threads_publish_timeout_not_sent', expected: CONF(2) },
      { label: 'threads_thread_partial → 3번째부터 이어서', body: THREE, scenario: 'threads_thread_partial', expected: CONF(2) },
      { label: 'threads_rate_limited(429) → 재시도', body: ONE, scenario: 'threads_rate_limited', expected: CONF(2) },
      { label: 'threads_token_invalid(401)', body: ONE, scenario: 'threads_token_invalid', expected: { job_state: 'BLOCKED', item_status: 'BLOCKED', intents: 1, publication: false } },
      { label: 'threads_text_too_long(400)', body: ONE, scenario: 'threads_text_too_long', expected: { job_state: 'FAILED', item_status: 'FAILED', intents: 1, publication: false } },
    ];
    for (const s of single) {
      const acc = await linkedAccount(c);
      const itemId = await executed(c, acc.id, s.body, s.scenario);
      await drain(c, itemId);
      await record(c, out, s.label, itemId, acc.external, s.expected);
    }

    // 로컬 요청 제한(잠정값을 1개/1시간으로 낮춤): 두 번째 항목은 전송 의도 없이 기다렸다가 창이 풀린 뒤 보낸다.
    {
      threads.rateLimit = { ...THREADS_PROVISIONAL_RATE_LIMIT, max_units: 1, window_sec: 3600 };
      const acc = await linkedAccount(c);
      const first = await executed(c, acc.id, ONE);
      await tick(c, MIN);
      const second = await executed(c, acc.id, ONE);
      await tick(c, MIN);
      const waiting = (await c.db.select().from(schema.jobs).where(eq(schema.jobs.itemId, second)))[0]!;
      const waitingIntents = await c.db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, waiting.id));
      if (waiting.state !== 'RETRY_WAIT' || waiting.lastErrorCode !== 'local_rate_limited' || waitingIntents.length !== 0) {
        out.violations.push(`로컬 요청 제한: ${waiting.state}/${waiting.lastErrorCode}/의도 ${waitingIntents.length} ≠ RETRY_WAIT/local_rate_limited/0`);
      }
      await drain(c, second);
      // 같은 계정 — 원격 게시물 수 비교는 두 항목 합으로 아래에서 한다
      await record(c, out, '로컬 요청 제한 · 1번째', first, acc.external, CONF(1), { accountPosts: false });
      await record(c, out, '로컬 요청 제한 · 2번째(창 뒤, 의도 없이 대기)', second, acc.external, CONF(1), { accountPosts: false });
      const both = await c.db
        .select()
        .from(schema.remoteSteps)
        .where(and(inArray(schema.remoteSteps.itemId, [first, second]), eq(schema.remoteSteps.kind, 'publish')));
      if (api.postsOf(acc.external).length !== both.length) out.violations.push(`로컬 요청 제한: 원격 게시물 ${api.postsOf(acc.external).length} ≠ 게시 단계 ${both.length}`);
      threads.rateLimit = { ...THREADS_PROVISIONAL_RATE_LIMIT };
    }

    // 재시작: 응답 유실 뒤 모의 Threads 가 기록을 잃음(재시작) → 확인 불가 3회 → UNKNOWN, 다시 게시하지 않음
    {
      const acc = await linkedAccount(c);
      const itemId = await executed(c, acc.id, ONE, 'threads_publish_timeout_sent');
      await tick(c, 20 * MIN);
      const publishes = api.calls.publish;
      api.reset();
      await drain(c, itemId);
      if (api.calls.publish !== 0 || publishes === 0) out.violations.push('재시작: 기록을 잃은 원격에 다시 게시함');
      const job = (await c.db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)))[0]!;
      const steps = await c.db.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.itemId, itemId));
      const pubs = await c.db.select().from(schema.publications).where(eq(schema.publications.itemId, itemId));
      const ok = job.state === 'UNKNOWN' && pubs.length === 0;
      if (!ok) out.violations.push(`재시작: ${job.state}/publication ${pubs.length} ≠ UNKNOWN/0`);
      const intents = await c.db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, job.id));
      out.rows.push({
        scenario: '재시작(모의 Threads 기록 유실) → UNKNOWN',
        posts: 1,
        job_state: job.state,
        item_status: (await c.db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, itemId)))[0]!.status,
        intents: intents.length,
        containers: steps.filter((s) => s.kind === 'container').length,
        publishes: steps.filter((s) => s.kind === 'publish').length,
        publication: pubs.length ? 'MOCK' : '없음',
        republish: api.calls.publish === 0 ? '없음' : '위반',
        ok,
      });
    }
    if (out.fetch_calls > 0) out.violations.push(`fetch 호출 ${out.fetch_calls}회`);
    return out;
  } finally {
    globalThis.fetch = realFetch;
    await handle.close();
  }
}

export const THREADS_DRILL_HEADER = ['시나리오(Threads 모의)', '게시물', '최종 job 상태', '항목 상태', 'intent 수', '컨테이너', '게시', 'publication(MOCK)', '재게시'] as const;

export function threadsDrillTableRows(r: ThreadsDrillResult): string[][] {
  return r.rows.map((x) => [x.scenario, String(x.posts), x.job_state, x.item_status, String(x.intents), String(x.containers), String(x.publishes), x.publication, x.republish]);
}

export function formatThreadsDrillTable(r: ThreadsDrillResult): string {
  const rows = [THREADS_DRILL_HEADER as readonly string[], ...threadsDrillTableRows(r)];
  const lines = rows.map((cols) => `| ${cols.join(' | ')} |`);
  lines.splice(1, 0, `|${THREADS_DRILL_HEADER.map(() => '---').join('|')}|`);
  return lines.join('\n');
}
