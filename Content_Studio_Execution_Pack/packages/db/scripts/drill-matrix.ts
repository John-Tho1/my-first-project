/**
 * T12(결정 D19) M3 게이트 훈련(drill) — 모의 채널 어댑터로 성공·실패·불명확·부분 성공 행렬을 버리는 메모리 DB 에서 끝까지 돌린다.
 * `pnpm drill:mock`(scripts/drill.ts)이 표로 찍고, tests/integration/m3-gate.test.ts 가 같은 결과를 프로그램으로 확인한다.
 *
 * 불변식(하나라도 어기면 violations):
 * - 확인(CONFIRMED)된 항목의 원격 결과·accepted 전송 의도는 1개뿐(중복 게시 없음)
 * - 원격 결과(publications)는 모두 MOCK(is_mock=true, verification=MOCK, mock: ID, mock:// 링크 또는 없음)
 * - 결과 불명(ambiguous) 뒤 다음 시도는 원격 "없음" 확인(reconciled_not_found) 뒤에만, 원격이 받은 요청은 다시 보내지 않음
 * - CONFIRMED 항목에는 publication 이 있다
 * - fetch 호출 0(네트워크 없음)
 * - 행마다 기대한 최종 상태(작업·항목·intent 수·publication)와 같다
 */
import { randomUUID, createHash } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { loadConfig, type Channel, type JobState, type MockScenarioValue } from '@cs/domain';
import { MockChannelAdapter, MockChannelAdapterRegistry } from '@cs/providers';
import {
  approveItems,
  cancelItem,
  createContent,
  createPlan,
  createTestDb,
  createVariantDraft,
  executePlan,
  insertAsset,
  leaseJobs,
  listChannelAccounts,
  processJob,
  reconcileItem,
  retryItem,
  revokeApproval,
  runJobsTick,
  schema,
  seed,
  setMockScenario,
  setVariantAssets,
  setVariantLifecycle,
  type Db,
} from '../src/index';

export interface DrillRow {
  scenario: string;
  channel: Channel;
  job_state: string;
  item_status: string;
  intents: number;
  publication: string;
  resend: string;
  expected: Partial<Pick<DrillRow, 'job_state' | 'item_status' | 'intents'>> & { publication?: string | null };
  ok: boolean;
}

export interface DrillResult {
  rows: DrillRow[];
  plans: Array<{ name: string; statuses: string[] }>;
  violations: string[];
  fetch_calls: number;
  submits: number;
}

const config = loadConfig({ PUBLISH_MODE: 'disabled' });
const MIN = 60_000;
const ACTIVE_AUTO: readonly string[] = ['QUEUED', 'LEASED', 'SENDING', 'REMOTE_PROCESSING', 'RETRY_WAIT', 'RECONCILING', 'CANCEL_REQUESTED'];
const BODY = '# 해외 영업 첫 분기(모의 훈련)\n\n대리점과 재고 기준을 먼저 합의했다.\n\n가격표는 마지막에 확정했다.';

interface Ctx {
  db: Db;
  /** 가상 시계 오프셋(ms) — 앞으로만 간다 */
  offset: number;
  adapters: MockChannelAdapter[];
}

interface Owner {
  id: string;
  accounts: Record<Channel, string>;
  image: string;
  video: string;
}

const clockOf = (c: Ctx) => () => new Date(Date.now() + c.offset);

async function newOwner(c: Ctx): Promise<Owner> {
  const { ownerId } = await seed(c.db, { allowedIdentity: `drill-${randomUUID().slice(0, 8)}@example.local` });
  const accounts = Object.fromEntries((await listChannelAccounts(c.db, ownerId)).map((a) => [a.platform, a.id])) as Record<Channel, string>;
  const asset = async (mime: string) => {
    const id = randomUUID();
    const bytes = randomUUID();
    await insertAsset(c.db, {
      id,
      ownerId,
      key: `assets/${ownerId}/${id}`,
      mime,
      bytes: bytes.length,
      checksum: createHash('sha256').update(bytes).digest('hex'),
      rightsStatus: 'owned',
      verificationState: 'VERIFIED',
    });
    return id;
  };
  return { id: ownerId, accounts, image: await asset('image/png'), video: await asset('video/mp4') };
}

async function reviewVariant(c: Ctx, o: Owner, channel: Channel): Promise<string> {
  const { content } = await createContent(c.db, o.id, { title: `훈련 ${channel}`, body: BODY });
  const { variant } = await createVariantDraft(c.db, o.id, content.id, { channel, baseVersion: 1 });
  let base = 1;
  if (channel === 'instagram') {
    await setVariantAssets(c.db, o.id, variant.id, { baseVersion: 1, assets: [{ assetId: o.image, position: 1, role: 'image' }] });
    base = 2;
  } else if (channel === 'youtube') {
    await setVariantAssets(c.db, o.id, variant.id, { baseVersion: 1, assets: [{ assetId: o.video, position: 1, role: 'video' }] });
    base = 2;
  }
  await setVariantLifecycle(c.db, o.id, variant.id, { lifecycle: 'review', baseVersion: base });
  return variant.id;
}

interface PlanSpec {
  channel: Channel;
  scenario?: MockScenarioValue;
  visibility?: 'private' | 'public';
}

interface Executed {
  planId: string;
  items: Array<{ id: string; channel: Channel }>;
  approvalIds: Record<string, string>;
  commandKey: string;
}

/** 계획(항목마다 채널 1개) → 모의 시나리오 → 전부 승인 → 실행(QUEUED). */
async function executed(c: Ctx, o: Owner, specs: PlanSpec[], opts: { execute?: boolean } = {}): Promise<Executed> {
  const input: Array<{ variant_id: string; channel_account_id: string; visibility?: 'private' | 'public' }> = [];
  for (const s of specs) input.push({ variant_id: await reviewVariant(c, o, s.channel), channel_account_id: o.accounts[s.channel], visibility: s.visibility });
  const { plan, items } = await createPlan(c.db, o.id, { items: input });
  const byVariant = new Map(items.map((i) => [i.variantId, i]));
  const ordered = input.map((x, k) => ({ id: byVariant.get(x.variant_id)!.id, channel: specs[k]!.channel, scenario: specs[k]!.scenario }));
  for (const it of ordered) if (it.scenario) await setMockScenario(c.db, o.id, it.id, { scenario: it.scenario });
  const approved = await approveItems(c.db, o.id, plan.id, {
    item_ids: items.map((i) => i.id),
    expected_hashes: Object.fromEntries(items.map((i) => [i.id, i.payloadHash])),
    confirm: true,
    purpose: 'mock_publish',
  });
  const commandKey = `drill-${randomUUID()}`;
  if (opts.execute !== false) await executePlan(c.db, o.id, plan.id, { commandKey }, config);
  return {
    planId: plan.id,
    items: ordered.map((x) => ({ id: x.id, channel: x.channel })),
    approvalIds: Object.fromEntries(approved.approvals.map((a) => [a.distributionItemId, a.id])),
    commandKey,
  };
}

function registryOf(a: MockChannelAdapter) {
  return new MockChannelAdapterRegistry(a);
}

/** 이 owner 의 작업이 자동으로 더 움직이지 않을 때까지 tick(한 번에 가상 시계 20분 — 재시도 상한 15분 × 1.2 보다 길다). */
async function drain(c: Ctx, o: Owner, adapter: MockChannelAdapter, maxTicks = 16, workerId = 'drill-w'): Promise<number> {
  let ticks = 0;
  for (; ticks < maxTicks; ticks++) {
    await runJobsTick(c.db, registryOf(adapter), {
      workerId,
      config,
      ownerId: o.id,
      clock: clockOf(c),
      random: () => 0.5,
      submitTimeoutMs: 200,
      maxJobs: 20,
    });
    c.offset += 20 * MIN;
    const active = await c.db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.ownerId, o.id), inArray(schema.jobs.state, [...ACTIVE_AUTO])));
    if (active.length === 0) return ticks + 1;
  }
  return ticks;
}

async function tickOnce(c: Ctx, o: Owner, adapter: MockChannelAdapter, advanceMs = 20 * MIN, workerId = 'drill-w') {
  const r = await runJobsTick(c.db, registryOf(adapter), { workerId, config, ownerId: o.id, clock: clockOf(c), random: () => 0.5, submitTimeoutMs: 200, maxJobs: 20 });
  c.offset += advanceMs;
  return r;
}

async function planStatus(c: Ctx, planId: string): Promise<string> {
  return (await c.db.select({ s: schema.distributionPlans.status }).from(schema.distributionPlans).where(eq(schema.distributionPlans.id, planId)))[0]!.s;
}

interface ItemFacts {
  jobState: string;
  itemStatus: string;
  intents: Array<typeof schema.sendIntents.$inferSelect>;
  pubs: Array<typeof schema.publications.$inferSelect>;
  events: Array<typeof schema.jobEvents.$inferSelect>;
}

async function factsOf(c: Ctx, itemId: string): Promise<ItemFacts> {
  const item = (await c.db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, itemId)))[0]!;
  const jobs = await c.db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)).orderBy(asc(schema.jobs.createdAt), asc(schema.jobs.id));
  const jobIds = jobs.map((j) => j.id);
  const intents = jobIds.length
    ? await c.db.select().from(schema.sendIntents).where(inArray(schema.sendIntents.jobId, jobIds)).orderBy(asc(schema.sendIntents.createdAt), asc(schema.sendIntents.attempt))
    : [];
  const events = jobIds.length ? await c.db.select().from(schema.jobEvents).where(inArray(schema.jobEvents.jobId, jobIds)).orderBy(asc(schema.jobEvents.at), asc(schema.jobEvents.eventSeq)) : [];
  const pubs = await c.db.select().from(schema.publications).where(eq(schema.publications.itemId, itemId));
  return { jobState: jobs.at(-1)?.state ?? '(없음)', itemStatus: item.status, intents, pubs, events };
}

/** 불변식 검사 + 표 한 줄. */
async function record(
  c: Ctx,
  out: DrillResult,
  scenario: string,
  channel: Channel,
  itemId: string,
  expected: DrillRow['expected'],
): Promise<DrillRow> {
  const f = await factsOf(c, itemId);
  const v = (msg: string) => out.violations.push(`${scenario}: ${msg}`);
  // 원격 지도(모든 모의 원격) — 이 항목의 의도 key 중 원격이 받은 것
  const remoteKeys = new Set(c.adapters.flatMap((a) => a.remoteEntries().map((e) => e.intentKey)));
  const received = f.intents.filter((i) => remoteKeys.has(i.intentKey));
  const accepted = f.intents.filter((i) => i.outcome === 'accepted');
  if (received.length > 1) v(`원격이 받은 요청 ${received.length}개(중복 side effect)`);
  if (f.itemStatus === 'CONFIRMED' && accepted.length > 1) v(`확인된 항목의 accepted 의도 ${accepted.length}개`);
  if (f.pubs.length > 1) v(`publication ${f.pubs.length}개`);
  for (const p of f.pubs) {
    if (!p.isMock || p.verification !== 'MOCK' || !p.externalId.startsWith('mock:') || (p.permalink !== null && !p.permalink.startsWith('mock://'))) {
      v('MOCK 이 아닌 publication');
    }
  }
  if (f.itemStatus === 'CONFIRMED' && f.pubs.length === 0) v('CONFIRMED 인데 publication 없음');
  // 결과 불명 뒤 재전송: 원격이 받은 의도 뒤에 다음 의도가 있으면 위반, ambiguous 뒤 다음 시도는 reconciled_not_found 가 있어야 한다
  let resendNote = '없음';
  const byJob = new Map<string, typeof f.intents>();
  for (const i of f.intents) byJob.set(i.jobId, [...(byJob.get(i.jobId) ?? []), i]);
  let retries = 0;
  for (const [jobId, list] of byJob) {
    const notFound = f.events.filter((e) => e.jobId === jobId && (e.sanitizedDetails as { transition?: string }).transition === 'reconciled_not_found').length;
    let ambiguousFollowed = 0;
    for (let k = 0; k + 1 < list.length; k++) {
      retries++;
      if (remoteKeys.has(list[k]!.intentKey)) v(`원격이 받은 요청(${list[k]!.attempt}) 뒤 다시 보냄`);
      if (list[k]!.outcome === 'ambiguous' || list[k]!.outcome === 'pending') ambiguousFollowed++;
    }
    if (ambiguousFollowed > notFound) v(`결과 불명 뒤 재전송 ${ambiguousFollowed}회(원격 없음 확인 ${notFound}회)`);
  }
  if (f.intents.length > byJob.size) resendNote = `재시도 ${retries}회(보내지 않음 확인 뒤)`;
  if (byJob.size > 1) resendNote = `새 작업 ${byJob.size - 1}개(재승인·재실행)${retries ? ` + 재시도 ${retries}회` : ''}`;
  const p = f.pubs[0];
  const publication = p ? `${p.isMock ? 'MOCK' : 'REAL?'} ${p.resultKind}/${p.remoteVisibility}` : '없음';
  const row: DrillRow = {
    scenario,
    channel,
    job_state: f.jobState,
    item_status: f.itemStatus,
    intents: f.intents.length,
    publication,
    resend: resendNote,
    expected,
    ok: true,
  };
  const mismatch: string[] = [];
  if (expected.job_state !== undefined && expected.job_state !== row.job_state) mismatch.push(`job ${row.job_state} ≠ ${expected.job_state}`);
  if (expected.item_status !== undefined && expected.item_status !== row.item_status) mismatch.push(`항목 ${row.item_status} ≠ ${expected.item_status}`);
  if (expected.intents !== undefined && expected.intents !== row.intents) mismatch.push(`intent ${row.intents} ≠ ${expected.intents}`);
  if (expected.publication !== undefined && (expected.publication ?? '없음') !== row.publication) mismatch.push(`publication ${row.publication} ≠ ${expected.publication ?? '없음'}`);
  if (mismatch.length) {
    row.ok = false;
    v(`기대와 다름: ${mismatch.join(', ')}`);
  }
  out.rows.push(row);
  return row;
}

type Exp = DrillRow['expected'];
const CONF = (intents: number, publication: string): Exp => ({ job_state: 'CONFIRMED', item_status: 'CONFIRMED', intents, publication });
const PRIV = 'MOCK UPLOADED_PRIVATE/private';

/** 시나리오 × 항목 1개(threads — YouTube·공개 결과는 따로). */
const SINGLE: Array<{ label: string; scenario: MockScenarioValue; channel?: Channel; visibility?: 'private' | 'public'; expected: Exp; cancelAfterFirstTick?: boolean }> = [
  { label: 'success', scenario: 'success', expected: CONF(1, PRIV) },
  { label: 'success · YouTube(A12 비공개 업로드)', scenario: 'success', channel: 'youtube', expected: CONF(1, PRIV) },
  { label: 'success_public · 공개 승인', scenario: 'success_public', visibility: 'public', expected: CONF(1, 'MOCK PUBLISHED/public') },
  { label: 'success_public · 비공개 승인(공개 전환 거부)', scenario: 'success_public', expected: { job_state: 'FAILED', item_status: 'FAILED', intents: 1, publication: null } },
  { label: 'processing_then_confirm', scenario: 'processing_then_confirm', expected: CONF(1, PRIV) },
  { label: 'transient(503 반복)', scenario: 'transient', expected: { job_state: 'FAILED', item_status: 'FAILED', intents: 5, publication: null } },
  { label: 'transient_then_success', scenario: 'transient_then_success', expected: CONF(2, PRIV) },
  { label: 'rate_limited(429·Retry-After)', scenario: 'rate_limited', expected: { job_state: 'FAILED', item_status: 'FAILED', intents: 5, publication: null } },
  { label: 'server_error_no_side_effect', scenario: 'server_error_no_side_effect', expected: { job_state: 'FAILED', item_status: 'FAILED', intents: 5, publication: null } },
  { label: 'server_error_side_effect_unknown', scenario: 'server_error_side_effect_unknown', expected: CONF(1, PRIV) },
  { label: 'permanent(400)', scenario: 'permanent', expected: { job_state: 'FAILED', item_status: 'FAILED', intents: 1, publication: null } },
  { label: 'auth(401)', scenario: 'auth', expected: { job_state: 'BLOCKED', item_status: 'BLOCKED', intents: 1, publication: null } },
  { label: 'ambiguous_sent', scenario: 'ambiguous_sent', expected: CONF(1, PRIV) },
  { label: 'ambiguous_not_sent', scenario: 'ambiguous_not_sent', expected: { job_state: 'FAILED', item_status: 'FAILED', intents: 5, publication: null } },
  { label: 'hang(시간 초과)', scenario: 'hang', expected: { job_state: 'FAILED', item_status: 'FAILED', intents: 5, publication: null } },
  { label: 'cancel_supported + 사용자 취소', scenario: 'cancel_supported', cancelAfterFirstTick: true, expected: { job_state: 'CANCELED', item_status: 'CANCELED', intents: 1, publication: null } },
  { label: 'reconcile_unsupported', scenario: 'reconcile_unsupported', expected: { job_state: 'UNKNOWN', item_status: 'UNKNOWN', intents: 1, publication: null } },
];

export async function runDrill(): Promise<DrillResult> {
  const handle = await createTestDb();
  const c: Ctx = { db: handle.db, offset: 0, adapters: [] };
  const out: DrillResult = { rows: [], plans: [], violations: [], fetch_calls: 0, submits: 0 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    out.fetch_calls++;
    throw new Error('drill: 네트워크 호출 금지');
  }) as typeof fetch;
  const adapter = new MockChannelAdapter({ readEnv: false });
  c.adapters.push(adapter);
  try {
    // 1) 시나리오 × 항목 1개
    for (const s of SINGLE) {
      const o = await newOwner(c);
      const channel = s.channel ?? 'threads';
      const x = await executed(c, o, [{ channel, scenario: s.scenario, visibility: s.visibility }]);
      if (s.cancelAfterFirstTick) {
        await tickOnce(c, o, adapter);
        await cancelItem(c.db, o.id, x.items[0]!.id);
      }
      await drain(c, o, adapter);
      if (s.scenario === 'reconcile_unsupported') {
        // 사용자 재확인도 조회만 — 여전히 확인 불가면 UNKNOWN 그대로(재전송 없음)
        await reconcileItem(c.db, registryOf(adapter), o.id, x.items[0]!.id, { timeoutMs: 200 });
      }
      await record(c, out, s.label, channel, x.items[0]!.id, s.expected);
    }

    // 2) PARTIAL(A09): threads success · instagram auth · youtube 처리 중 → 확인 · blog 일시 오류 → 성공
    {
      const o = await newOwner(c);
      const x = await executed(c, o, [
        { channel: 'threads', scenario: 'success' },
        { channel: 'instagram', scenario: 'auth' },
        { channel: 'youtube', scenario: 'processing_then_confirm' },
        { channel: 'blog', scenario: 'transient_then_success' },
      ]);
      await drain(c, o, adapter);
      const first = await planStatus(c, x.planId);
      // 성공한 항목은 더 돌려도·수동 tick·재확인 시도에도 다시 보내지 않는다
      await tickOnce(c, o, adapter);
      for (const it of x.items) await reconcileItem(c.db, registryOf(adapter), o.id, it.id, { timeoutMs: 200 }).catch(() => null);
      const ig = x.items.find((i) => i.channel === 'instagram')!;
      await record(c, out, 'PARTIAL · instagram(401) 1차', 'instagram', ig.id, { job_state: 'BLOCKED', item_status: 'BLOCKED', intents: 1, publication: null });
      out.rows.pop(); // 1차 상태는 계획 요약으로만 남기고 표에는 최종 상태를 쓴다
      // 계정 다시 연결(모의: 시나리오를 success 로) → 재시도(같은 작업, 새 시도·새 의도)
      await setMockScenario(c.db, o.id, ig.id, { scenario: 'success' });
      await retryItem(c.db, o.id, ig.id);
      await drain(c, o, adapter);
      const second = await planStatus(c, x.planId);
      out.plans.push({ name: 'PARTIAL 계획(threads·instagram·youtube·blog)', statuses: [first, second] });
      if (first !== 'partial') out.violations.push(`PARTIAL 계획: 1차 계획 상태 ${first} ≠ partial`);
      if (second !== 'completed') out.violations.push(`PARTIAL 계획: 재시도 뒤 계획 상태 ${second} ≠ completed`);
      await record(c, out, 'PARTIAL · threads success', 'threads', x.items[0]!.id, CONF(1, PRIV));
      await record(c, out, 'PARTIAL · instagram 401 → 재시도', 'instagram', ig.id, CONF(2, PRIV));
      await record(c, out, 'PARTIAL · youtube 처리 중 → 확인', 'youtube', x.items[2]!.id, CONF(1, PRIV));
      await record(c, out, 'PARTIAL · blog 일시 오류 → 성공', 'blog', x.items[3]!.id, CONF(2, PRIV));
    }

    // 3) 더블 실행(A07): 같은 key 재실행(replay)·다른 key(409) → 작업·의도·결과 1개
    {
      const o = await newOwner(c);
      const x = await executed(c, o, [{ channel: 'threads', scenario: 'success' }]);
      await executePlan(c.db, o.id, x.planId, { commandKey: x.commandKey }, config);
      await executePlan(c.db, o.id, x.planId, { commandKey: `drill-${randomUUID()}` }, config).catch(() => null);
      await drain(c, o, adapter);
      await drain(c, o, adapter, 2, 'drill-w2');
      await record(c, out, '더블 실행(같은 key·다른 key)', 'threads', x.items[0]!.id, CONF(1, PRIV));
    }

    // 4) worker 2개(A07): A 가 lease → B 는 0건, B 가 A 의 행으로 처리해도 lease_lost
    {
      const o = await newOwner(c);
      const x = await executed(c, o, [{ channel: 'threads', scenario: 'success' }]);
      const [leased] = await leaseJobs(c.db, { workerId: 'worker-a', now: clockOf(c)(), limit: 1, ownerId: o.id });
      const b = await tickOnce(c, o, adapter, 0, 'worker-b');
      if (b.leased !== 0) out.violations.push('worker 2개: B 가 A 의 작업을 lease 함');
      await processJob(c.db, registryOf(adapter), leased!, { workerId: 'worker-a', config, clock: clockOf(c), submitTimeoutMs: 200 });
      const pb = await processJob(c.db, registryOf(adapter), { ...leased! }, { workerId: 'worker-b', config, clock: clockOf(c) });
      if (pb.state !== 'lease_lost') out.violations.push(`worker 2개: B 처리 결과 ${pb.state} ≠ lease_lost`);
      await record(c, out, 'worker 2개 동시', 'threads', x.items[0]!.id, CONF(1, PRIV));
    }

    // 5) lease 만료(A20): 의도 기록 뒤 worker 가 죽음(원격은 받음) → RECONCILING → 재전송 없이 CONFIRMED
    {
      const o = await newOwner(c);
      const x = await executed(c, o, [{ channel: 'threads', scenario: 'success' }]);
      const [leased] = await leaseJobs(c.db, { workerId: 'dead-worker', now: clockOf(c)(), limit: 1, ownerId: o.id });
      await c.db.update(schema.jobs).set({ state: 'SENDING', leaseUntil: new Date(clockOf(c)().getTime() - 1000) }).where(eq(schema.jobs.id, leased!.id));
      await c.db.insert(schema.sendIntents).values({ ownerId: o.id, jobId: leased!.id, attempt: 1, intentKey: `${leased!.id}:1` });
      adapter.plantRemote(`${leased!.id}:1`, 'threads');
      const before = adapter.calls.submit;
      await drain(c, o, adapter);
      if (adapter.calls.submit !== before) out.violations.push('lease 만료: 원격이 받은 요청을 다시 보냄');
      await record(c, out, 'lease 만료(의도 뒤) → 조회', 'threads', x.items[0]!.id, CONF(1, PRIV));
    }

    // 6) 재시작(D19 C8): 응답 유실 뒤 새 모의 원격(빈 지도) → 3회 확인 불가 → UNKNOWN(재전송 없음) → 옛 원격으로 사용자 재확인 → CONFIRMED
    {
      const o = await newOwner(c);
      const before = new MockChannelAdapter({ readEnv: false });
      c.adapters.push(before);
      const x = await executed(c, o, [{ channel: 'threads', scenario: 'ambiguous_sent' }]);
      await tickOnce(c, o, before);
      const fresh = new MockChannelAdapter({ readEnv: false });
      c.adapters.push(fresh);
      await drain(c, o, fresh);
      const mid = await factsOf(c, x.items[0]!.id);
      if (mid.jobState !== 'UNKNOWN') out.violations.push(`재시작: 새 원격 조회 뒤 ${mid.jobState} ≠ UNKNOWN`);
      if (fresh.calls.submit !== 0) out.violations.push('재시작: 새 원격에 다시 보냄');
      await reconcileItem(c.db, registryOf(before), o.id, x.items[0]!.id, { timeoutMs: 200 });
      await record(c, out, '재시작 → UNKNOWN → 재확인', 'threads', x.items[0]!.id, CONF(1, PRIV));
    }

    // 7) A10(D19): 재시도 대기 중 승인 철회 → 즉시 BLOCKED·항목 PLANNED → 다시 승인 → 새 실행 키로 이 항목만 → CONFIRMED
    {
      const o = await newOwner(c);
      const x = await executed(c, o, [{ channel: 'threads', scenario: 'transient' }]);
      await tickOnce(c, o, adapter, 0);
      const itemId = x.items[0]!.id;
      await revokeApproval(c.db, o.id, x.approvalIds[itemId]!, 'drill');
      const mid = await factsOf(c, itemId);
      if (mid.jobState !== 'BLOCKED' || mid.itemStatus !== 'PLANNED') out.violations.push(`A10: 철회 직후 ${mid.jobState}/${mid.itemStatus} ≠ BLOCKED/PLANNED`);
      await setMockScenario(c.db, o.id, itemId, { scenario: 'success' });
      const item = (await c.db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, itemId)))[0]!;
      await approveItems(c.db, o.id, x.planId, { item_ids: [itemId], expected_hashes: { [itemId]: item.payloadHash }, confirm: true, purpose: 'mock_publish' });
      await executePlan(c.db, o.id, x.planId, { commandKey: `drill-${randomUUID()}` }, config);
      await drain(c, o, adapter);
      await record(c, out, 'A10 철회 → 재승인·재실행', 'threads', itemId, CONF(2, PRIV));
    }
    out.submits = c.adapters.reduce((n, a) => n + a.calls.submit, 0);
    if (out.fetch_calls > 0) out.violations.push(`fetch 호출 ${out.fetch_calls}회`);
    return out;
  } finally {
    globalThis.fetch = realFetch;
    await handle.close();
  }
}

export const DRILL_HEADER = ['시나리오', '최종 job 상태', '항목 상태', 'intent 수', 'publication(MOCK)', '재전송 여부'] as const;

export function drillTableRows(r: DrillResult): string[][] {
  return r.rows.map((x) => [x.scenario, x.job_state as JobState | string, x.item_status, String(x.intents), x.publication, x.resend]);
}

/** 사람이 읽는 표(Markdown 형식). */
export function formatDrillTable(r: DrillResult): string {
  const rows = [DRILL_HEADER as readonly string[], ...drillTableRows(r)];
  const lines = rows.map((cols) => `| ${cols.join(' | ')} |`);
  lines.splice(1, 0, `|${DRILL_HEADER.map(() => '---').join('|')}|`);
  return lines.join('\n');
}
