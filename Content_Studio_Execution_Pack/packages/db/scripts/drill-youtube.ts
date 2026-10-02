/**
 * T15(결정 D27) YouTube 모의 훈련 — `pnpm drill:mock` 이 Threads 표 다음에 찍는다. 버리는 메모리 DB·임시 저장소, 시험용 난수 키,
 * 프로세스 안 Google 형 모의 OAuth·모의 YouTube. 계정은 모의 OAuth 흐름(startOAuthConnect → 모의 동의 → completeOAuthCallback)으로 연결한다.
 * **외부 호출 0**(fetch 를 막고 센다). 영상 파일은 합성 바이트(실제 영상 아님).
 *
 * 불변식(하나라도 어기면 violations → exit 1):
 * - 항목마다 영상 ≤ 1(시뮬레이터의 그 계정 영상 수 = 영상 단계 수 — 기록 없는 업로드·두 번째 업로드 없음)
 * - 유효한 세션이 있는 동안 새 세션 없음(마지막 세션 앞의 세션은 모두 만료·오류로 기록됨), 시뮬레이터 세션 수 = 세션 단계 수
 * - 보낸 바이트 < 파일 크기 × 2(재개는 처음부터 다시 올리지 않는다), 받은 영상의 sha256 = 승인한 파일 checksum
 * - 미검증 프로젝트에서 PUBLISHED 없음, 처리 끝(processed) 전에는 publication 없음, CONFIRMED 이면 publication 1개(MOCK·mock:youtube:·mock://youtube/)
 * - 행마다 기대한 최종 상태와 같다, fetch 0
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { asc, eq, inArray } from 'drizzle-orm';
import { loadConfig, requireSecretKeyring, scheduleFromMsk, type MockScenarioValue } from '@cs/domain';
import {
  LocalStorageAdapter,
  MockChannelAdapter,
  MockChannelAdapterRegistry,
  MockGoogleOAuthProvider,
  MockOAuthStore,
  mockGoogleTokenCheck,
  ThreadsMockChannelAdapter,
  YOUTUBE_PROVISIONAL_RATE_LIMIT,
  YouTubeMockApi,
  YouTubeMockChannelAdapter,
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
  refreshCredential,
  runJobsTick,
  schema,
  seed,
  setMockScenario,
  setVariantAssets,
  setVariantLifecycle,
  startOAuthConnect,
  type Db,
} from '../src/index';

export interface YouTubeDrillRow {
  scenario: string;
  job_state: string;
  item_status: string;
  intents: number;
  sessions: number;
  resumes: number;
  sent_ratio: string;
  videos: number;
  publication: string;
  reupload: string;
  ok: boolean;
}

export interface YouTubeDrillResult {
  rows: YouTubeDrillRow[];
  violations: string[];
  fetch_calls: number;
}

const config = loadConfig({ PUBLISH_MODE: 'disabled' });
const MIN = 60_000;
const KIB = 1024;
const REDIRECT = 'http://localhost:3000/api/oauth/callback';
const ACTIVE = ['QUEUED', 'LEASED', 'SENDING', 'REMOTE_PROCESSING', 'RETRY_WAIT', 'RECONCILING', 'CANCEL_REQUESTED'];
/** 합성 영상 크기(조각 64KiB × 4 + 44KiB) — 조각 여러 개로 끊김·재개를 본다 */
const VIDEO_BYTES = 300 * KIB;
const CHUNK_BYTES = 64 * KIB;
const BODY = '해외 영업 첫 분기 회고(모의 훈련 영상)\n대리점과 재고 기준을 먼저 합의한 이야기.';

interface Ctx {
  db: Db;
  offset: number;
  owner: string;
  sessionId: string;
  keyring: ReturnType<typeof requireSecretKeyring>;
  provider: MockGoogleOAuthProvider;
  api: YouTubeMockApi;
  youtube: YouTubeMockChannelAdapter;
  registry: MockChannelAdapterRegistry;
  storage: LocalStorageAdapter;
}

const clockOf = (c: Ctx) => () => new Date(Date.now() + c.offset);

/** 합성 "영상": MP4 ftyp 서명 + 결정적 채움 바이트(실제 영상 아님) */
export function syntheticVideo(bytes: number, seedNo: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let x = (seedNo * 2654435761) >>> 0;
  for (let i = 0; i < bytes; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  out.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 0);
  return out;
}

let videoSeed = 1000;

/** VERIFIED 영상 asset(저장소 파일 + 행). 훈련은 T08 업로드 경로 대신 같은 결과(VERIFIED·checksum)를 직접 만든다. */
async function verifiedVideo(c: Ctx): Promise<{ id: string; checksum: string; bytes: number }> {
  const bytes = syntheticVideo(VIDEO_BYTES, ++videoSeed);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const key = `assets/${randomUUID()}/${randomUUID()}`;
  await c.storage.put(key, bytes);
  const [row] = await c.db
    .insert(schema.assets)
    .values({ ownerId: c.owner, key, mime: 'video/mp4', bytes: bytes.byteLength, checksum, verificationState: 'VERIFIED' })
    .returning();
  return { id: row!.id, checksum, bytes: bytes.byteLength };
}

async function linkedAccount(c: Ctx): Promise<{ id: string; external: string }> {
  const external = `mock:youtube:${randomUUID()}`;
  const [row] = await c.db
    .insert(schema.channelAccounts)
    .values({ ownerId: c.owner, platform: 'youtube', kind: 'mock', externalAccountId: external, displayName: 'MOCK YouTube 훈련', state: 'mock_ready' })
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

interface Spec {
  requested?: 'upload_private' | 'public_publish';
  visibility?: 'private' | 'unlisted' | 'public';
  publishAtDays?: number;
  scenario?: MockScenarioValue;
}

async function executed(c: Ctx, accountId: string, spec: Spec): Promise<{ itemId: string; checksum: string; bytes: number }> {
  const video = await verifiedVideo(c);
  const { content } = await createContent(c.db, c.owner, { title: '훈련 youtube', body: BODY });
  const { variant } = await createVariantDraft(c.db, c.owner, content.id, { channel: 'youtube', baseVersion: 1 });
  await setVariantAssets(c.db, c.owner, variant.id, { baseVersion: 1, assets: [{ assetId: video.id, position: 1, role: 'video' }] });
  await setVariantLifecycle(c.db, c.owner, variant.id, { lifecycle: 'review', baseVersion: 2 });
  let publishAt: { date: string; time: string } | undefined;
  if (spec.publishAtDays) {
    const d = new Date(Date.now() + spec.publishAtDays * 24 * 3600_000);
    const msk = new Date(d.getTime() + 3 * 3600_000);
    publishAt = { date: msk.toISOString().slice(0, 10), time: '12:00' };
    scheduleFromMsk(publishAt.date, publishAt.time); // 형식 확인(미래)
  }
  const requested = spec.requested ?? 'upload_private';
  const { plan, items } = await createPlan(c.db, c.owner, {
    items: [{ variant_id: variant.id, channel_account_id: accountId, requested_result: requested, visibility: spec.visibility ?? 'private', publish_at: publishAt }],
  });
  const item = items[0]!;
  if (spec.scenario) await setMockScenario(c.db, c.owner, item.id, { scenario: spec.scenario });
  await approveItems(c.db, c.owner, plan.id, { item_ids: [item.id], expected_hashes: { [item.id]: item.payloadHash }, confirm: true, purpose: requested });
  await executePlan(c.db, c.owner, plan.id, { commandKey: `drill-yt-${randomUUID()}` }, config);
  return { itemId: item.id, checksum: video.checksum, bytes: video.bytes };
}

async function tick(c: Ctx, advanceMs = MIN): Promise<void> {
  const providerFor = () => c.provider;
  await runJobsTick(c.db, c.registry, {
    workerId: 'drill-yt',
    config,
    ownerId: c.owner,
    clock: clockOf(c),
    random: () => 0.5,
    submitTimeoutMs: 5000,
    maxJobs: 20,
    credentials: {
      keyring: () => c.keyring,
      refresh: (ownerId, accountId, now) => refreshCredential(c.db, { ownerId, accountId, providerFor, keyring: () => c.keyring, now, trigger: 'auto' }),
    },
    media: c.storage,
  });
  c.offset += advanceMs;
}

async function drain(c: Ctx, itemId: string, maxTicks = 24): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    await tick(c);
    const jobs = await c.db.select({ state: schema.jobs.state }).from(schema.jobs).where(eq(schema.jobs.itemId, itemId));
    if (!jobs.some((j) => ACTIVE.includes(j.state))) return;
  }
}

async function record(
  c: Ctx,
  out: YouTubeDrillResult,
  scenario: string,
  run: { itemId: string; checksum: string; bytes: number; external: string; sentBefore: number; sentAfter?: number; verified: boolean },
  expected: { job_state: string; item_status: string; intents?: number; sessions?: number; publication: string | null },
  opts: { accountVideos: boolean } = { accountVideos: true },
): Promise<void> {
  const v = (m: string) => out.violations.push(`${scenario}: ${m}`);
  const item = (await c.db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, run.itemId)))[0]!;
  const jobs = await c.db.select().from(schema.jobs).where(eq(schema.jobs.itemId, run.itemId)).orderBy(asc(schema.jobs.createdAt));
  const jobIds = jobs.map((j) => j.id);
  const intents = jobIds.length ? await c.db.select().from(schema.sendIntents).where(inArray(schema.sendIntents.jobId, jobIds)) : [];
  const steps = await c.db.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.itemId, run.itemId));
  const pubs = await c.db.select().from(schema.publications).where(eq(schema.publications.itemId, run.itemId));
  const sessions = steps.filter((s) => s.kind === 'upload_session').sort((a, b) => a.postIndex - b.postIndex);
  const videos = steps.filter((s) => s.kind === 'video');
  if (videos.length > 1) v(`영상 단계 ${videos.length}개`);
  for (const s of sessions.slice(0, -1)) if (s.status !== 'expired' && s.status !== 'error') v(`유효할 수 있는 세션(${s.status})이 있는데 새 세션을 만듦`);
  const simVideos = c.api.videosOf(run.external);
  if (opts.accountVideos && simVideos.length !== videos.length) v(`원격 영상 ${simVideos.length}개 ≠ 영상 단계 ${videos.length}개(기록 없는 업로드 또는 두 번째 업로드)`);
  if (opts.accountVideos && c.api.sessionUris(run.external).length !== sessions.length) v(`원격 세션 ${c.api.sessionUris(run.external).length}개 ≠ 세션 단계 ${sessions.length}개`);
  const sent = (run.sentAfter ?? c.api.bytesSent) - run.sentBefore;
  if (sent >= run.bytes * 2) v(`보낸 바이트 ${sent} ≥ 파일 × 2(${run.bytes * 2}) — 처음부터 다시 올림`);
  const sim = simVideos.find((x) => videos.some((s) => s.remoteId === x.id));
  if (sim && sim.sha256 !== run.checksum) v('받은 영상 sha256 ≠ 승인한 파일 checksum');
  if (pubs.length > 1) v(`publication ${pubs.length}개`);
  if (pubs.length && !videos.some((s) => s.status === 'processed')) v('처리 끝(processed) 전에 publication 이 생김');
  for (const p of pubs) {
    if (!p.isMock || p.verification !== 'MOCK' || !p.externalId.startsWith('mock:youtube:') || !(p.permalink ?? '').startsWith('mock://youtube/')) v('MOCK 이 아닌 publication');
    if (p.resultKind === 'PUBLISHED' && !run.verified) v('미검증 프로젝트인데 PUBLISHED');
    if (p.resultKind === 'PUBLISHED' && sim && sim.privacyStatus === 'private') v('원격은 비공개인데 PUBLISHED');
  }
  const jobState = jobs.at(-1)?.state ?? '(없음)';
  if (jobState === 'CONFIRMED' && pubs.length !== 1) v('CONFIRMED 인데 publication 없음');
  const mismatch: string[] = [];
  if (jobState !== expected.job_state) mismatch.push(`job ${jobState} ≠ ${expected.job_state}`);
  if (item.status !== expected.item_status) mismatch.push(`항목 ${item.status} ≠ ${expected.item_status}`);
  if (expected.intents !== undefined && intents.length !== expected.intents) mismatch.push(`intent ${intents.length} ≠ ${expected.intents}`);
  if (expected.sessions !== undefined && sessions.length !== expected.sessions) mismatch.push(`세션 ${sessions.length} ≠ ${expected.sessions}`);
  const pubLabel = pubs[0] ? `MOCK ${pubs[0].resultKind}/${pubs[0].remoteVisibility}` : '없음';
  if (pubLabel !== (expected.publication ?? '없음')) mismatch.push(`publication ${pubLabel} ≠ ${expected.publication ?? '없음'}`);
  if (mismatch.length) v(`기대와 다름: ${mismatch.join(', ')}`);
  out.rows.push({
    scenario,
    job_state: jobState,
    item_status: item.status,
    intents: intents.length,
    sessions: sessions.length,
    resumes: sessions.reduce((n, s) => n + s.resumeCount, 0),
    sent_ratio: `${(sent / run.bytes).toFixed(2)}×`,
    videos: videos.length,
    publication: pubLabel,
    reupload: videos.length > 1 || (opts.accountVideos && simVideos.length > 1) ? '위반' : '없음',
    ok: mismatch.length === 0,
  });
}

const CONF = (intents: number, sessions: number, publication = 'MOCK UPLOADED_PRIVATE/private') => ({
  job_state: 'CONFIRMED',
  item_status: 'CONFIRMED',
  intents,
  sessions,
  publication,
});

export async function runYouTubeDrill(): Promise<YouTubeDrillResult> {
  const handle = await createTestDb();
  const dir = mkdtempSync(path.join(tmpdir(), 'cs-drill-yt-'));
  const out: YouTubeDrillResult = { rows: [], violations: [], fetch_calls: 0 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    out.fetch_calls++;
    throw new Error('drill: 네트워크 호출 금지');
  }) as typeof fetch;
  try {
    const keyring = requireSecretKeyring({ SECRETS_MASTER_KEY: randomBytes(32).toString('base64'), SECRETS_KEY_VERSION: '1' });
    const store = new MockOAuthStore();
    const provider = new MockGoogleOAuthProvider({ registeredRedirectUri: REDIRECT, appBaseUrl: 'http://localhost:3000', store });
    const api = new YouTubeMockApi({ tokenCheck: mockGoogleTokenCheck(store) });
    const youtube = new YouTubeMockChannelAdapter({ api, chunkBytes: CHUNK_BYTES });
    const { ownerId } = await seed(handle.db, { allowedIdentity: `drill-yt-${randomUUID().slice(0, 8)}@example.local` });
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
      youtube,
      registry: new MockChannelAdapterRegistry(new MockChannelAdapter({ readEnv: false }), new ThreadsMockChannelAdapter(), youtube),
      storage: new LocalStorageAdapter(dir),
    };

    const single: Array<{ label: string; spec: Spec; verified?: boolean; expected: Parameters<typeof record>[4] }> = [
      {
        label: 'youtube_scheduled_private · 예약 공개(검증된 프로젝트)',
        spec: { requested: 'public_publish', visibility: 'private', publishAtDays: 7, scenario: 'youtube_scheduled_private' },
        verified: true,
        expected: CONF(1, 1, 'MOCK SCHEDULED_REMOTE/private'),
      },
      { label: 'youtube_success_private · upload_private', spec: { scenario: 'youtube_success_private' }, expected: CONF(1, 1) },
      { label: 'youtube_processing_slow → 처리 대기', spec: { scenario: 'youtube_processing_slow' }, expected: CONF(1, 1) },
      { label: 'youtube_network_drop(50%) → 같은 세션 재개', spec: { scenario: 'youtube_network_drop' }, expected: CONF(2, 1) },
      { label: 'youtube_response_lost_after_complete → 조회로 확인', spec: { scenario: 'youtube_response_lost_after_complete' }, expected: CONF(1, 1) },
      { label: 'youtube_session_expired_before_complete → 새 세션', spec: { scenario: 'youtube_session_expired_before_complete' }, expected: CONF(2, 2) },
      {
        label: 'youtube_token_invalid(401)',
        spec: { scenario: 'youtube_token_invalid' },
        expected: { job_state: 'BLOCKED', item_status: 'BLOCKED', intents: 1, sessions: 0, publication: null },
      },
      {
        label: 'youtube_rejected → FAILED',
        spec: { scenario: 'youtube_rejected' },
        expected: { job_state: 'FAILED', item_status: 'FAILED', intents: 1, sessions: 1, publication: null },
      },
      {
        label: 'public 요청 + 미검증 프로젝트 → 비공개 강제',
        spec: { requested: 'public_publish', visibility: 'public', scenario: 'youtube_public_unverified_forced_private' },
        expected: CONF(1, 1),
      },
      {
        label: 'public 요청 + 검증된 프로젝트(시험 전용)',
        spec: { requested: 'public_publish', visibility: 'public', scenario: 'youtube_project_verified' },
        verified: true,
        expected: CONF(1, 1, 'MOCK PUBLISHED/public'),
      },
    ];
    for (const s of single) {
      const acc = await linkedAccount(c);
      const sentBefore = api.bytesSent;
      const run = await executed(c, acc.id, s.spec);
      await drain(c, run.itemId);
      await record(c, out, s.label, { ...run, external: acc.external, sentBefore, verified: s.verified ?? false }, s.expected);
    }

    // 원격 할당량 초과(403 quotaExceeded): 세션 없이 RETRY_WAIT → 초기화 시각(모의 1시간) 뒤 업로드
    {
      const acc = await linkedAccount(c);
      const sentBefore = api.bytesSent;
      const run = await executed(c, acc.id, { scenario: 'youtube_quota_exceeded' });
      await tick(c);
      const waiting = (await c.db.select().from(schema.jobs).where(eq(schema.jobs.itemId, run.itemId)))[0]!;
      if (waiting.state !== 'RETRY_WAIT' || waiting.lastErrorCode !== 'quota_exceeded' || api.sessionUris(acc.external).length !== 0) {
        out.violations.push(`원격 할당량: ${waiting.state}/${waiting.lastErrorCode}/세션 ${api.sessionUris(acc.external).length} ≠ RETRY_WAIT/quota_exceeded/0`);
      }
      await tick(c, 61 * MIN);
      await drain(c, run.itemId);
      await record(c, out, 'youtube_quota_exceeded(403) → 초기화 뒤 업로드', { ...run, external: acc.external, sentBefore, verified: false }, CONF(2, 1));
    }

    // 로컬 할당량(잠정값을 1회/1시간으로 낮춤): 두 번째 항목은 전송 의도·세션 없이 기다렸다가 창이 풀린 뒤 올린다.
    {
      youtube.rateLimit = { ...YOUTUBE_PROVISIONAL_RATE_LIMIT, max_units: 1, window_sec: 3600 };
      const acc = await linkedAccount(c);
      const sent0 = api.bytesSent;
      const first = await executed(c, acc.id, {});
      await drain(c, first.itemId);
      const sent1 = api.bytesSent;
      const second = await executed(c, acc.id, {});
      await tick(c);
      const waiting = (await c.db.select().from(schema.jobs).where(eq(schema.jobs.itemId, second.itemId)))[0]!;
      const waitingIntents = await c.db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, waiting.id));
      if (waiting.state !== 'RETRY_WAIT' || waiting.lastErrorCode !== 'local_rate_limited' || waitingIntents.length !== 0 || api.sessionUris(acc.external).length !== 1) {
        out.violations.push(`로컬 할당량: ${waiting.state}/${waiting.lastErrorCode}/의도 ${waitingIntents.length} ≠ RETRY_WAIT/local_rate_limited/0`);
      }
      await tick(c, 61 * MIN);
      await drain(c, second.itemId);
      await record(c, out, '로컬 할당량 · 1번째', { ...first, external: acc.external, sentBefore: sent0, sentAfter: sent1, verified: false }, CONF(1, 1), {
        accountVideos: false,
      });
      await record(c, out, '로컬 할당량 · 2번째(창 뒤, 의도·세션 없이 대기)', { ...second, external: acc.external, sentBefore: sent1, verified: false }, CONF(1, 1), {
        accountVideos: false,
      });
      if (api.videosOf(acc.external).length !== 2) out.violations.push(`로컬 할당량: 원격 영상 ${api.videosOf(acc.external).length} ≠ 2`);
      youtube.rateLimit = { ...YOUTUBE_PROVISIONAL_RATE_LIMIT };
    }

    // 재시작: 마지막 조각 응답 유실 뒤 모의 YouTube 가 기록을 잃음 → 확인 불가 3회 → UNKNOWN, 다시 올리지 않음
    {
      const acc = await linkedAccount(c);
      const run = await executed(c, acc.id, { scenario: 'youtube_response_lost_after_complete' });
      await tick(c);
      const before = api.calls.initResumable;
      api.reset();
      await drain(c, run.itemId);
      const job = (await c.db.select().from(schema.jobs).where(eq(schema.jobs.itemId, run.itemId)))[0]!;
      const steps = await c.db.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.itemId, run.itemId));
      const pubs = await c.db.select().from(schema.publications).where(eq(schema.publications.itemId, run.itemId));
      const intents = await c.db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, job.id));
      const ok = job.state === 'UNKNOWN' && pubs.length === 0 && api.calls.initResumable === 0 && api.calls.putChunk === 0 && before > 0;
      if (!ok) out.violations.push(`재시작: ${job.state}/publication ${pubs.length}/새 세션 ${api.calls.initResumable}·조각 ${api.calls.putChunk} ≠ UNKNOWN/0/0·0`);
      out.rows.push({
        scenario: '재시작(모의 YouTube 기록 유실) → UNKNOWN',
        job_state: job.state,
        item_status: (await c.db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, run.itemId)))[0]!.status,
        intents: intents.length,
        sessions: steps.filter((s) => s.kind === 'upload_session').length,
        resumes: steps.reduce((n, s) => n + s.resumeCount, 0),
        sent_ratio: '—',
        videos: steps.filter((s) => s.kind === 'video').length,
        publication: pubs.length ? 'MOCK' : '없음',
        reupload: api.calls.initResumable === 0 && api.calls.putChunk === 0 ? '없음' : '위반',
        ok,
      });
    }
    if (out.fetch_calls > 0) out.violations.push(`fetch 호출 ${out.fetch_calls}회`);
    return out;
  } finally {
    globalThis.fetch = realFetch;
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export const YOUTUBE_DRILL_HEADER = ['시나리오(YouTube 모의)', '최종 job 상태', '항목 상태', 'intent 수', '세션', '재개', '보낸/파일', '영상', 'publication(MOCK)', '재업로드'] as const;

export function youtubeDrillTableRows(r: YouTubeDrillResult): string[][] {
  return r.rows.map((x) => [x.scenario, x.job_state, x.item_status, String(x.intents), String(x.sessions), String(x.resumes), x.sent_ratio, String(x.videos), x.publication, x.reupload]);
}

export function formatYouTubeDrillTable(r: YouTubeDrillResult): string {
  const rows = [YOUTUBE_DRILL_HEADER as readonly string[], ...youtubeDrillTableRows(r)];
  const lines = rows.map((cols) => `| ${cols.join(' | ')} |`);
  lines.splice(1, 0, `|${YOUTUBE_DRILL_HEADER.map(() => '---').join('|')}|`);
  return lines.join('\n');
}
