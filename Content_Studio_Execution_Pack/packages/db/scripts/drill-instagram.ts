/**
 * T16(제안 결정 D29) Instagram 모의 훈련 — `pnpm drill:mock` 이 YouTube 표 다음에 찍는다. 버리는 메모리 DB·임시 저장소, 시험용 난수 키,
 * 프로세스 안 Meta 형 모의 OAuth·모의 Instagram·모의 공개 미디어 URL. 계정은 모의 OAuth 흐름(startOAuthConnect → 모의 동의 →
 * completeOAuthCallback)으로 연결한다. **외부 호출 0**(fetch 를 막고 센다). 이미지는 헤더만 맞는 합성 JPEG(실제 사진 아님).
 *
 * 불변식(하나라도 어기면 violations → exit 1):
 * - 항목마다 컨테이너 단계는 순번(post_index)마다 1개·게시 단계 ≤ 1, 시뮬레이터의 컨테이너별 게시 수 ≤ 1(중복 게시 없음)
 * - 시뮬레이터의 그 계정 미디어 수 = 게시 단계 수(기록 없는 게시·재게시 없음), 받은 이미지 sha256(순서대로) = 승인한 첨부 checksum
 * - CONFIRMED 이면 publication 1개(MOCK·PUBLISHED/public·mock:instagram:·mock://instagram/p/), 게시 단계 전에는 publication 없음
 * - 공개 미디어 URL: 행이 끝나면 살아 있는 URL 0, DB(작업 이력·전송 의도·단계·감사)에 `mock://public-media/` 0
 * - 승인 전 규격 위반(비율 밖)은 승인 거절(작업·의도 0), 행마다 기대한 최종 상태와 같다, fetch 0
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { AppError, loadConfig, MOCK_PUBLIC_MEDIA_PREFIX, requireSecretKeyring, type MockScenarioValue } from '@cs/domain';
import {
  INSTAGRAM_PROVISIONAL_RATE_LIMIT,
  InstagramMockApi,
  InstagramMockChannelAdapter,
  LocalStorageAdapter,
  MockChannelAdapter,
  MockChannelAdapterRegistry,
  MockInstagramOAuthProvider,
  mockInstagramTokenCheck,
  MockOAuthStore,
  MockPublicMediaUrlProvider,
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
  setVariantAssets,
  setVariantLifecycle,
  startOAuthConnect,
  type Db,
} from '../src/index';

export interface InstagramDrillRow {
  scenario: string;
  images: number;
  job_state: string;
  item_status: string;
  intents: number;
  containers: number;
  publishes: number;
  publication: string;
  republish: string;
  ok: boolean;
}

export interface InstagramDrillResult {
  rows: InstagramDrillRow[];
  violations: string[];
  fetch_calls: number;
}

const config = loadConfig({ PUBLISH_MODE: 'disabled' });
const MIN = 60_000;
const REDIRECT = 'http://localhost:3000/api/oauth/callback';
const ACTIVE = ['QUEUED', 'LEASED', 'SENDING', 'REMOTE_PROCESSING', 'RETRY_WAIT', 'RECONCILING', 'CANCEL_REQUESTED'];
const BODY = '해외 영업 첫 분기 회고(모의 훈련 이미지) #해외영업\n\n대리점과 재고 기준을 먼저 합의한 이야기.';

interface Ctx {
  db: Db;
  offset: number;
  owner: string;
  sessionId: string;
  keyring: ReturnType<typeof requireSecretKeyring>;
  provider: MockInstagramOAuthProvider;
  api: InstagramMockApi;
  publicMedia: MockPublicMediaUrlProvider;
  instagram: InstagramMockChannelAdapter;
  registry: MockChannelAdapterRegistry;
  storage: LocalStorageAdapter;
}

const clockOf = (c: Ctx) => () => new Date(Date.now() + c.offset);

/** 합성 JPEG(SOI + APP0 + SOF0(가로·세로) + SOS + 결정적 채움 + EOI) — 헤더만 맞는 바이트, 실제 사진 아님. */
export function syntheticJpeg(width: number, height: number, seedNo: number, totalBytes = 8 * 1024): Uint8Array {
  const head = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  const sos = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];
  const out = new Uint8Array(totalBytes);
  out.set([...head, ...sof, ...sos], 0);
  let x = (seedNo * 2654435761) >>> 0;
  for (let i = head.length + sof.length + sos.length; i < out.length - 2; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = (x >>> 24) % 250; // 0xFF 없음(표식으로 읽히지 않게)
  }
  out.set([0xff, 0xd9], out.length - 2);
  return out;
}

let imageSeed = 5000;

/** VERIFIED 이미지 asset(저장소 파일 + 행). 훈련은 업로드 경로 대신 같은 결과(VERIFIED·checksum)를 직접 만든다. */
async function verifiedImage(c: Ctx, width: number, height: number): Promise<{ id: string; checksum: string }> {
  const bytes = syntheticJpeg(width, height, ++imageSeed);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const key = `assets/${randomUUID()}/${randomUUID()}`;
  await c.storage.put(key, bytes);
  const [row] = await c.db.insert(schema.assets).values({ ownerId: c.owner, key, mime: 'image/jpeg', bytes: bytes.byteLength, checksum, verificationState: 'VERIFIED' }).returning();
  return { id: row!.id, checksum };
}

async function linkedAccount(c: Ctx): Promise<{ id: string; external: string }> {
  const external = `mock:instagram:${randomUUID()}`;
  const [row] = await c.db
    .insert(schema.channelAccounts)
    .values({ ownerId: c.owner, platform: 'instagram', kind: 'mock', externalAccountId: external, displayName: 'MOCK Instagram 훈련', state: 'mock_ready' })
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

interface Run {
  itemId: string;
  planId: string;
  checksums: string[];
  approved: boolean;
  refusedReasons: string[];
}

/** 원고 → instagram 파생본(이미지 첨부) → 계획(public) → (시나리오) → 승인(규격 검사 포함) → 실행. 승인이 거절되면 실행하지 않는다. */
async function executed(c: Ctx, accountId: string, dims: Array<[number, number]>, scenario?: MockScenarioValue): Promise<Run> {
  const images = [];
  for (const [w, h] of dims) images.push(await verifiedImage(c, w, h));
  const { content } = await createContent(c.db, c.owner, { title: '훈련 instagram', body: BODY });
  const { variant } = await createVariantDraft(c.db, c.owner, content.id, { channel: 'instagram', baseVersion: 1 });
  await setVariantAssets(c.db, c.owner, variant.id, { baseVersion: 1, assets: images.map((im, i) => ({ assetId: im.id, position: i + 1, role: 'image' as const })) });
  await setVariantLifecycle(c.db, c.owner, variant.id, { lifecycle: 'review', baseVersion: 2 });
  const { plan, items } = await createPlan(c.db, c.owner, { items: [{ variant_id: variant.id, channel_account_id: accountId }] });
  const item = items[0]!;
  if (scenario) await setMockScenario(c.db, c.owner, item.id, { scenario });
  try {
    await approveItems(c.db, c.owner, plan.id, { item_ids: [item.id], expected_hashes: { [item.id]: item.payloadHash }, confirm: true, purpose: 'mock_publish' }, undefined, { media: c.storage });
  } catch (e) {
    const refused = e instanceof AppError ? ((e.extra as { items?: Array<{ reasons: string[] }> } | undefined)?.items?.[0]?.reasons ?? [e.code]) : [String(e)];
    return { itemId: item.id, planId: plan.id, checksums: images.map((i) => i.checksum), approved: false, refusedReasons: refused };
  }
  await executePlan(c.db, c.owner, plan.id, { commandKey: `drill-ig-${randomUUID()}` }, config);
  return { itemId: item.id, planId: plan.id, checksums: images.map((i) => i.checksum), approved: true, refusedReasons: [] };
}

async function tick(c: Ctx, advanceMs = 20 * MIN): Promise<void> {
  await runJobsTick(c.db, c.registry, {
    workerId: 'drill-ig',
    config,
    ownerId: c.owner,
    clock: clockOf(c),
    random: () => 0.5,
    submitTimeoutMs: 5000,
    maxJobs: 20,
    credentials: { keyring: () => c.keyring },
    media: c.storage,
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

/** DB 의 작업 이력·전송 의도·단계·감사에 공개 미디어 URL 이 남았는가(남으면 안 된다). */
async function publicUrlLeaks(c: Ctx): Promise<number> {
  const like = `%${MOCK_PUBLIC_MEDIA_PREFIX}%`;
  const q = async (s: ReturnType<typeof sql>) => Number(((await c.db.execute(s)) as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0);
  return (
    (await q(sql`select count(*)::int as n from job_events where sanitized_details::text like ${like}`)) +
    (await q(sql`select count(*)::int as n from send_intents where coalesce(sanitized_details::text, '') like ${like}`)) +
    (await q(sql`select count(*)::int as n from remote_steps where remote_id like ${like}`)) +
    (await q(sql`select count(*)::int as n from audit_events where sanitized_details::text like ${like}`)) +
    (await q(sql`select count(*)::int as n from publications where coalesce(permalink, '') like ${like} or external_id like ${like}`))
  );
}

async function record(
  c: Ctx,
  out: InstagramDrillResult,
  scenario: string,
  run: Run,
  external: string,
  expected: { job_state: string; item_status: string; intents?: number; publication: boolean },
  opts: { accountMedia: boolean } = { accountMedia: true },
): Promise<void> {
  const v = (m: string) => out.violations.push(`${scenario}: ${m}`);
  const item = (await c.db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, run.itemId)))[0]!;
  const jobs = await c.db.select().from(schema.jobs).where(eq(schema.jobs.itemId, run.itemId)).orderBy(asc(schema.jobs.createdAt));
  const jobIds = jobs.map((j) => j.id);
  const intents = jobIds.length ? await c.db.select().from(schema.sendIntents).where(inArray(schema.sendIntents.jobId, jobIds)) : [];
  const steps = await c.db.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.itemId, run.itemId));
  const pubs = await c.db.select().from(schema.publications).where(eq(schema.publications.itemId, run.itemId));
  const containers = steps.filter((s) => s.kind === 'ig_container');
  const publishes = steps.filter((s) => s.kind === 'ig_publish');
  for (const i of new Set(containers.map((s) => s.postIndex))) if (containers.filter((s) => s.postIndex === i).length > 1) v(`컨테이너 순번 ${i} 단계 2개 이상`);
  if (publishes.length > 1) v(`게시 단계 ${publishes.length}개`);
  for (const ct of containers) if ((c.api.publishCount.get(ct.remoteId) ?? 0) > 1) v(`컨테이너 ${ct.remoteId} 를 두 번 게시`);
  const remote = c.api.mediaOf(external);
  if (opts.accountMedia && remote.length !== publishes.length) v(`원격 미디어 ${remote.length}개 ≠ 게시 단계 ${publishes.length}개(기록 없는 게시 또는 재게시)`);
  const sim = remote.find((m) => publishes.some((p) => p.remoteId === m.id));
  if (sim && JSON.stringify(sim.imageSha256) !== JSON.stringify(run.checksums)) v('받은 이미지 sha256(순서) ≠ 승인한 첨부 checksum');
  if (pubs.length > 1) v(`publication ${pubs.length}개`);
  if (pubs.length && publishes.length === 0) v('게시 단계 전에 publication 이 생김');
  for (const p of pubs) {
    if (!p.isMock || p.verification !== 'MOCK' || !p.externalId.startsWith('mock:instagram:') || !(p.permalink ?? '').startsWith('mock://instagram/p/')) v('MOCK 이 아닌 publication');
    if (p.resultKind !== 'PUBLISHED' || p.remoteVisibility !== 'public') v(`Instagram 결과가 PUBLISHED/public 이 아님(${p.resultKind}/${p.remoteVisibility})`);
  }
  const jobState = jobs.at(-1)?.state ?? '(없음)';
  if (jobState === 'CONFIRMED' && pubs.length !== 1) v('CONFIRMED 인데 publication 없음');
  if (c.publicMedia.activeCount(clockOf(c)()) !== 0) v(`살아 있는 공개 URL ${c.publicMedia.activeCount(clockOf(c)())}개(보낸 뒤 철회되지 않음)`);
  const mismatch: string[] = [];
  if (jobState !== expected.job_state) mismatch.push(`job ${jobState} ≠ ${expected.job_state}`);
  if (item.status !== expected.item_status) mismatch.push(`항목 ${item.status} ≠ ${expected.item_status}`);
  if (expected.intents !== undefined && intents.length !== expected.intents) mismatch.push(`intent ${intents.length} ≠ ${expected.intents}`);
  if ((pubs.length === 1) !== expected.publication) mismatch.push(`publication ${pubs.length}`);
  if (mismatch.length) v(`기대와 다름: ${mismatch.join(', ')}`);
  const p = pubs[0];
  out.rows.push({
    scenario,
    images: run.checksums.length,
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
const SQUARE: Array<[number, number]> = [[1080, 1080]];
const CAROUSEL: Array<[number, number]> = [
  [1080, 1080],
  [1080, 1350],
  [1080, 566],
];

export async function runInstagramDrill(): Promise<InstagramDrillResult> {
  const handle = await createTestDb();
  const dir = mkdtempSync(path.join(tmpdir(), 'cs-drill-ig-'));
  const out: InstagramDrillResult = { rows: [], violations: [], fetch_calls: 0 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    out.fetch_calls++;
    throw new Error('drill: 네트워크 호출 금지');
  }) as typeof fetch;
  try {
    const keyring = requireSecretKeyring({ SECRETS_MASTER_KEY: randomBytes(32).toString('base64'), SECRETS_KEY_VERSION: '1' });
    const store = new MockOAuthStore();
    const provider = new MockInstagramOAuthProvider({ registeredRedirectUri: REDIRECT, appBaseUrl: 'http://localhost:3000', store });
    const publicMedia = new MockPublicMediaUrlProvider();
    const api = new InstagramMockApi({ tokenCheck: mockInstagramTokenCheck(store), publicMedia });
    const instagram = new InstagramMockChannelAdapter({ api });
    const { ownerId } = await seed(handle.db, { allowedIdentity: `drill-ig-${randomUUID().slice(0, 8)}@example.local` });
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
      publicMedia,
      instagram,
      registry: new MockChannelAdapterRegistry(new MockChannelAdapter({ readEnv: false }), undefined, undefined, instagram),
      storage: new LocalStorageAdapter(dir),
    };

    const single: Array<{ label: string; dims: Array<[number, number]>; scenario?: MockScenarioValue; expected: Parameters<typeof record>[5] }> = [
      { label: 'instagram_success · 이미지 1장', dims: SQUARE, scenario: 'instagram_success', expected: CONF(1) },
      { label: 'instagram_success · 캐러셀 3장', dims: CAROUSEL, scenario: 'instagram_success', expected: CONF(1) },
      { label: 'instagram_container_slow → 같은 컨테이너로 게시', dims: SQUARE, scenario: 'instagram_container_slow', expected: CONF(2) },
      { label: 'instagram_container_slow · 캐러셀 → 부모 지연 뒤 게시', dims: CAROUSEL, scenario: 'instagram_container_slow', expected: CONF(2) },
      { label: 'instagram_publish_timeout_sent(응답 유실) → 조회로 확인', dims: SQUARE, scenario: 'instagram_publish_timeout_sent', expected: CONF(1) },
      { label: 'instagram_publish_timeout_not_sent → 같은 컨테이너로 게시', dims: SQUARE, scenario: 'instagram_publish_timeout_not_sent', expected: CONF(2) },
      { label: 'instagram_rate_limited(429) → 재시도', dims: SQUARE, scenario: 'instagram_rate_limited', expected: CONF(2) },
      { label: 'instagram_token_invalid(401)', dims: SQUARE, scenario: 'instagram_token_invalid', expected: { job_state: 'BLOCKED', item_status: 'BLOCKED', intents: 1, publication: false } },
      { label: 'instagram_invalid_spec_remote(400)', dims: SQUARE, scenario: 'instagram_invalid_spec_remote', expected: { job_state: 'FAILED', item_status: 'FAILED', intents: 1, publication: false } },
      { label: 'instagram_container_error(ERROR)', dims: CAROUSEL, scenario: 'instagram_container_error', expected: { job_state: 'FAILED', item_status: 'FAILED', intents: 1, publication: false } },
    ];
    for (const s of single) {
      const acc = await linkedAccount(c);
      const run = await executed(c, acc.id, s.dims, s.scenario);
      if (!run.approved) {
        out.violations.push(`${s.label}: 승인 거절(${run.refusedReasons.join(',')})`);
        continue;
      }
      await drain(c, run.itemId);
      await record(c, out, s.label, run, acc.external, s.expected);
    }

    // 승인 전 규격 위반(잠정 비율 4:5~1.91:1 밖 — 9:16 세로): 승인 거절(snapshot_stale + media_spec), 작업·전송 의도·원격 호출 0
    {
      const acc = await linkedAccount(c);
      const before = api.calls.createImageContainer;
      const run = await executed(c, acc.id, [[1080, 1920]]);
      const jobs = await c.db.select().from(schema.jobs).where(eq(schema.jobs.itemId, run.itemId));
      const ok = !run.approved && run.refusedReasons.includes('media_spec:aspect_out_of_range:1') && jobs.length === 0 && api.calls.createImageContainer === before;
      if (!ok) out.violations.push(`승인 전 규격 위반: 승인 ${run.approved}·사유 ${run.refusedReasons.join(',')}·작업 ${jobs.length}`);
      const item = (await c.db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, run.itemId)))[0]!;
      out.rows.push({
        scenario: '승인 전 규격 위반(9:16 세로) → 승인 거절',
        images: 1,
        job_state: '(없음)',
        item_status: item.status,
        intents: 0,
        containers: 0,
        publishes: 0,
        publication: '없음',
        republish: '없음',
        ok,
      });
    }

    // 로컬 요청 제한(잠정값을 1개/1시간으로 낮춤): 두 번째 항목은 전송 의도 없이 기다렸다가 창이 풀린 뒤 보낸다.
    {
      instagram.rateLimit = { ...INSTAGRAM_PROVISIONAL_RATE_LIMIT, max_units: 1, window_sec: 3600 };
      const acc = await linkedAccount(c);
      const first = await executed(c, acc.id, SQUARE);
      await tick(c, MIN);
      const second = await executed(c, acc.id, SQUARE);
      await tick(c, MIN);
      const waiting = (await c.db.select().from(schema.jobs).where(eq(schema.jobs.itemId, second.itemId)))[0]!;
      const waitingIntents = await c.db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, waiting.id));
      if (waiting.state !== 'RETRY_WAIT' || waiting.lastErrorCode !== 'local_rate_limited' || waitingIntents.length !== 0) {
        out.violations.push(`로컬 요청 제한: ${waiting.state}/${waiting.lastErrorCode}/의도 ${waitingIntents.length} ≠ RETRY_WAIT/local_rate_limited/0`);
      }
      await drain(c, second.itemId);
      await record(c, out, '로컬 요청 제한 · 1번째', first, acc.external, CONF(1), { accountMedia: false });
      await record(c, out, '로컬 요청 제한 · 2번째(창 뒤, 의도 없이 대기)', second, acc.external, CONF(1), { accountMedia: false });
      const both = await c.db
        .select()
        .from(schema.remoteSteps)
        .where(and(inArray(schema.remoteSteps.itemId, [first.itemId, second.itemId]), eq(schema.remoteSteps.kind, 'ig_publish')));
      if (api.mediaOf(acc.external).length !== both.length) out.violations.push(`로컬 요청 제한: 원격 미디어 ${api.mediaOf(acc.external).length} ≠ 게시 단계 ${both.length}`);
      instagram.rateLimit = { ...INSTAGRAM_PROVISIONAL_RATE_LIMIT };
    }

    // 재시작: 게시 응답 유실 뒤 모의 Instagram 이 기록을 잃음(재시작) → 확인 불가 3회 → UNKNOWN, 다시 게시하지 않음
    {
      const acc = await linkedAccount(c);
      const run = await executed(c, acc.id, SQUARE, 'instagram_publish_timeout_sent');
      await tick(c, 20 * MIN);
      const publishes = api.calls.publish;
      api.reset();
      await drain(c, run.itemId);
      if (api.calls.publish !== 0 || publishes === 0) out.violations.push('재시작: 기록을 잃은 원격에 다시 게시함');
      const job = (await c.db.select().from(schema.jobs).where(eq(schema.jobs.itemId, run.itemId)))[0]!;
      const steps = await c.db.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.itemId, run.itemId));
      const pubs = await c.db.select().from(schema.publications).where(eq(schema.publications.itemId, run.itemId));
      const ok = job.state === 'UNKNOWN' && pubs.length === 0;
      if (!ok) out.violations.push(`재시작: ${job.state}/publication ${pubs.length} ≠ UNKNOWN/0`);
      const intents = await c.db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, job.id));
      out.rows.push({
        scenario: '재시작(모의 Instagram 기록 유실) → UNKNOWN',
        images: 1,
        job_state: job.state,
        item_status: (await c.db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, run.itemId)))[0]!.status,
        intents: intents.length,
        containers: steps.filter((s) => s.kind === 'ig_container').length,
        publishes: steps.filter((s) => s.kind === 'ig_publish').length,
        publication: pubs.length ? 'MOCK' : '없음',
        republish: api.calls.publish === 0 ? '없음' : '위반',
        ok,
      });
    }
    const leaks = await publicUrlLeaks(c);
    if (leaks > 0) out.violations.push(`DB 에 공개 미디어 URL ${leaks}건`);
    if (publicMedia.activeCount(clockOf(c)()) !== 0) out.violations.push('끝난 뒤 살아 있는 공개 URL 이 있음');
    if (out.fetch_calls > 0) out.violations.push(`fetch 호출 ${out.fetch_calls}회`);
    return out;
  } finally {
    globalThis.fetch = realFetch;
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export const INSTAGRAM_DRILL_HEADER = ['시나리오(Instagram 모의)', '이미지', '최종 job 상태', '항목 상태', 'intent 수', '컨테이너', '게시', 'publication(MOCK)', '재게시'] as const;

export function instagramDrillTableRows(r: InstagramDrillResult): string[][] {
  return r.rows.map((x) => [x.scenario, String(x.images), x.job_state, x.item_status, String(x.intents), String(x.containers), String(x.publishes), x.publication, x.republish]);
}

export function formatInstagramDrillTable(r: InstagramDrillResult): string {
  const rows = [INSTAGRAM_DRILL_HEADER as readonly string[], ...instagramDrillTableRows(r)];
  const lines = rows.map((cols) => `| ${cols.join(' | ')} |`);
  lines.splice(1, 0, `|${INSTAGRAM_DRILL_HEADER.map(() => '---').join('|')}|`);
  return lines.join('\n');
}
