/**
 * T15(결정 D27): YouTube 재개 업로드 — 모의 어댑터만(VERIFIED 영상을 조각으로 업로드, 세션 URI·받은 바이트 단계 기록, 같은 세션 재개(A14),
 * 응답 유실 확인(A08), 처리 상태, 결과 종류 UPLOADED_PRIVATE·SCHEDULED_REMOTE·PUBLISHED, 미검증 프로젝트 강제 비공개(A12), 할당량, 401·거부·A09).
 * 계정은 Google 형 모의 OAuth 흐름(route)으로 연결한다. 영상은 T08 업로드 API 로 올린 합성 바이트(MP4 서명). **실제 Google/YouTube 호출·네트워크 없음**(fetch 0).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import {
  closeDb,
  createContent,
  createVariantDraft,
  exportOwner,
  getDb,
  parseBundleZip,
  runJobsTick,
  runRestoreDrill,
  schema,
  seed,
  setVariantAssets,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { adapterIdFor, countedAttempts, loadConfig, MIB, WEB_TICK_UPLOAD_SLICE, type MediaReader } from '@cs/domain';
import { createMockAdapterRegistry, LocalStorageAdapter, mockOAuthStore, YOUTUBE_PROVISIONAL_RATE_LIMIT } from '@cs/providers';
import { POST as connectPOST } from '../../apps/web/app/api/channel-accounts/[id]/connect/route';
import { GET as callbackGET } from '../../apps/web/app/api/oauth/callback/route';
import { GET as googleAuthorizeGET } from '../../apps/web/app/api/oauth/mock-google/authorize/route';
import { GET as threadsAuthorizeGET } from '../../apps/web/app/api/oauth/mock-threads/authorize/route';
import { POST as approvePOST } from '../../apps/web/app/api/distribution-plans/[id]/approve/route';
import { POST as executePOST } from '../../apps/web/app/api/distribution-plans/[id]/execute/route';
import { GET as planGET } from '../../apps/web/app/api/distribution-plans/[id]/route';
import { POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { POST as retryPOST } from '../../apps/web/app/api/distribution-items/[id]/retry/route';
import { POST as cancelPOST } from '../../apps/web/app/api/distribution-items/[id]/cancel/route';
import { PUT as scenarioPUT } from '../../apps/web/app/api/distribution-items/[id]/mock-scenario/route';
import { GET as jobGET } from '../../apps/web/app/api/jobs/[id]/route';
import { POST as tickPOST } from '../../apps/web/app/api/worker/tick/route';
import { POST as sessionsPOST } from '../../apps/web/app/api/uploads/sessions/route';
import { PUT as chunkPUT } from '../../apps/web/app/api/uploads/sessions/[id]/chunks/[index]/route';
import { POST as completePOST } from '../../apps/web/app/api/uploads/sessions/[id]/complete/route';
import { itemHeadline, jobStatusText, youtubeProgressLine } from '../../apps/web/lib/distribution';
import { jobCredentials } from '../../apps/web/lib/oauth';
import { runInlineWorker } from '../../apps/web/lib/stt';
import { formatYouTubeDrillTable, runYouTubeDrill, youtubeDrillTableRows } from '../../packages/db/scripts/drill-youtube';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const A = 'owner@example.local';
const KEY = randomBytes(32).toString('base64');
const MIN = 60_000;
/** FIX-T15(Codex missed case): 고정 미래 날짜는 지나면 깨진다 — 지금부터 60일 뒤(UTC 날짜, 09:30 MSK = 06:30Z 같은 날). */
const FUTURE_DAY = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
const KIB = 1024;
const CHUNK = 64 * KIB;
const VIDEO_BYTES = 300 * KIB;
const config = loadConfig({});
const registry = createMockAdapterRegistry();
const yt = registry.youtube;
const api = yt.api;
const thrApi = registry.threads.api;

let db: Db;
let owner: string;
let token: string;
let tmp: string;
let vt = 0;
let fetchCalls = 0;
const logs: string[] = [];
const seen: string[] = [];
/** 미디어 읽기 관찰(조각 크기 이하만 읽는지) */
const reads: number[] = [];
let storage: LocalStorageAdapter;
const media: MediaReader = {
  readRange: async (key, start, end) => {
    reads.push(end - start);
    return storage.readRange(key, start, end);
  },
};

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (p: string) => new Request(`${BASE}${p}`, { headers: { accept: 'application/json', ...cookieHeader(token) } });
const post = (p: string, body: unknown = {}) => jsonPost(p, body, cookieHeader(token));
async function rec(res: Response): Promise<Response> {
  const body = await res.clone().text();
  seen.push(`${[...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${body}`);
  return res;
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** 합성 "영상"(MP4 ftyp 서명 + 결정적 바이트 — 실제 영상 아님) */
let videoSeed = 1;
function syntheticVideo(bytes = VIDEO_BYTES): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes);
  let x = (++videoSeed * 2654435761) >>> 0;
  for (let i = 0; i < bytes; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  out.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 0);
  return out;
}

/** T08 업로드 API 로 VERIFIED 영상 asset 을 만든다(조각 4MiB — 작은 파일은 한 조각). */
async function uploadVideo(): Promise<{ assetId: string; checksum: string; bytes: number }> {
  const file = syntheticVideo();
  const s = await sessionsPOST(jsonPost('/api/uploads/sessions', { kind: 'video', mime: 'video/mp4', bytes: file.byteLength, chunk_size: 4 * MIB }, cookieHeader(token)), undefined as never);
  expect(s.status, await s.clone().text()).toBe(201);
  const id = ((await s.json()) as { session: { id: string } }).session.id;
  const put = await chunkPUT(
    new Request(`${BASE}/api/uploads/sessions/${id}/chunks/0`, {
      method: 'PUT',
      headers: { accept: 'application/json', 'content-type': 'application/octet-stream', ...ORIGIN_HEADERS, ...cookieHeader(token) },
      body: file,
    }),
    { params: Promise.resolve({ id, index: '0' }) },
  );
  expect(put.status).toBe(201);
  const done = await completePOST(new Request(`${BASE}/api/uploads/sessions/${id}/complete`, { method: 'POST', headers: { accept: 'application/json', ...ORIGIN_HEADERS, ...cookieHeader(token) } }), ctx(id));
  expect(done.status, await done.clone().text()).toBe(200);
  const body = (await done.json()) as { asset: { id: string; verification_state?: string } };
  return { assetId: body.asset.id, checksum: sha(file), bytes: file.byteLength };
}

async function connectFully(accountId: string, platform: 'youtube' | 'threads'): Promise<void> {
  const c = await rec(await connectPOST(post(`/api/channel-accounts/${accountId}/connect`), ctx(accountId)));
  expect(c.status, await c.clone().text()).toBe(200);
  const { authorize_url } = (await c.json()) as { authorize_url: string };
  const authorize = platform === 'youtube' ? googleAuthorizeGET : threadsAuthorizeGET;
  const a = await rec(await authorize(new Request(authorize_url, { headers: { accept: 'application/json', ...cookieHeader(token) } })));
  expect(a.status, await a.clone().text()).toBe(303);
  const cb = await rec(await callbackGET(new Request(a.headers.get('location')!, { headers: { accept: 'application/json', ...cookieHeader(token) } })));
  expect(cb.status, await cb.clone().text()).toBe(200);
}

async function linkedAccount(platform: 'youtube' | 'threads' = 'youtube'): Promise<{ id: string; external: string }> {
  const external = `mock:${platform}:${randomUUID()}`;
  const [row] = await db
    .insert(schema.channelAccounts)
    .values({ ownerId: owner, platform, kind: 'mock', externalAccountId: external, displayName: `MOCK ${platform} T15`, state: 'mock_ready' })
    .returning();
  await connectFully(row!.id, platform);
  return { id: row!.id, external };
}

const BODY = '해외 영업 첫 분기 회고(합성 영상)\n대리점과 재고 기준을 먼저 합의한 이야기.';

async function youtubeVariant(): Promise<{ variantId: string; checksum: string; bytes: number }> {
  const v = await uploadVideo();
  const { content } = await createContent(db, owner, { title: 'T15 youtube', body: BODY });
  const { variant } = await createVariantDraft(db, owner, content.id, { channel: 'youtube', baseVersion: 1 });
  await setVariantAssets(db, owner, variant.id, { baseVersion: 1, assets: [{ assetId: v.assetId, position: 1, role: 'video' }] });
  await setVariantLifecycle(db, owner, variant.id, { lifecycle: 'review', baseVersion: 2 });
  return { variantId: variant.id, checksum: v.checksum, bytes: v.bytes };
}

async function threadsVariant(): Promise<string> {
  const { content } = await createContent(db, owner, { title: 'T15 threads', body: '해외 영업 첫 달, 대리점 재고 기준부터 합의했다.' });
  const { variant } = await createVariantDraft(db, owner, content.id, { channel: 'threads', baseVersion: 1 });
  await setVariantLifecycle(db, owner, variant.id, { lifecycle: 'review', baseVersion: 1 });
  return variant.id;
}

interface PlanItemSpec {
  accountId: string;
  variantId: string;
  requested?: 'upload_private' | 'public_publish' | 'mock_publish';
  visibility?: 'private' | 'unlisted' | 'public';
  publishAt?: { date: string; time: string };
  scenario?: string;
}

interface Planned {
  planId: string;
  items: Array<{ id: string; payload_hash: string; requested_result: string; payload: Record<string, unknown> }>;
}

async function createPlanApi(specs: PlanItemSpec[]): Promise<Response> {
  return plansPOST(
    post('/api/distribution-plans', {
      items: specs.map((s) => ({
        variant_id: s.variantId,
        channel_account_id: s.accountId,
        requested_result: s.requested,
        visibility: s.visibility,
        publish_at: s.publishAt,
      })),
    }),
  );
}

async function plan(specs: PlanItemSpec[], approve = true): Promise<Planned> {
  const res = await rec(await createPlanApi(specs));
  expect(res.status, await res.clone().text()).toBe(201);
  const p = (await res.json()) as { plan: { id: string }; items: Array<Planned['items'][number] & { variant_id: string }> };
  const ordered = specs.map((s) => p.items.find((i) => i.variant_id === s.variantId)!);
  for (let k = 0; k < specs.length; k++) {
    if (specs[k]!.scenario) {
      const r = await setScenario(ordered[k]!.id, specs[k]!.scenario!);
      expect(r.status, await r.clone().text()).toBe(200);
    }
  }
  if (approve) {
    // 목적(purpose)이 다른 항목은 따로 승인한다(승인 = 항목의 requested_result 와 같아야 함).
    for (const purpose of [...new Set(ordered.map((i) => i.requested_result))]) {
      const group = ordered.filter((i) => i.requested_result === purpose);
      const ap = await approvePOST(
        post(`/api/distribution-plans/${p.plan.id}/approve`, {
          item_ids: group.map((i) => i.id),
          expected_hashes: Object.fromEntries(group.map((i) => [i.id, i.payload_hash])),
          confirm: true,
          purpose,
        }),
        ctx(p.plan.id),
      );
      expect(ap.status, await ap.clone().text()).toBe(200);
    }
  }
  return { planId: p.plan.id, items: ordered };
}
const setScenario = (itemId: string, scenario: string) =>
  scenarioPUT(
    new Request(`${BASE}/api/distribution-items/${itemId}/mock-scenario`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...ORIGIN_HEADERS, ...cookieHeader(token) },
      body: JSON.stringify({ scenario }),
    }),
    ctx(itemId),
  );
const execute = async (planId: string) => rec(await executePOST(post(`/api/distribution-plans/${planId}/execute`, { command_key: `k-${randomUUID()}` }), ctx(planId)));

async function tick(advanceMs = 0) {
  vt += advanceMs;
  return runJobsTick(db, registry, {
    workerId: 't15-w',
    config,
    ownerId: owner,
    clock: () => new Date(Date.now() + vt),
    random: () => 0.5,
    submitTimeoutMs: 10_000,
    maxJobs: 20,
    credentials: jobCredentials(config, db),
    media,
  });
}

const jobOf = async (itemId: string) => (await db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)).orderBy(asc(schema.jobs.createdAt)))[0]!;
const itemOf = async (itemId: string) => (await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, itemId)))[0]!;
const intentsOf = (jobId: string) => db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, jobId)).orderBy(asc(schema.sendIntents.attempt));
const stepsOf = (itemId: string) => db.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.itemId, itemId)).orderBy(asc(schema.remoteSteps.stepIndex));
const pubsOf = (itemId: string) => db.select().from(schema.publications).where(eq(schema.publications.itemId, itemId));
const eventsOf = async (jobId: string) => db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId)).orderBy(asc(schema.jobEvents.eventSeq));
const sessionsOf = async (itemId: string) => (await stepsOf(itemId)).filter((s) => s.kind === 'upload_session');

async function drainUntil(itemId: string, states: string[], n = 16, stepMs = 20_000): Promise<string> {
  for (let i = 0; i < n; i++) {
    const j = await jobOf(itemId);
    if (states.includes(j.state)) return j.state;
    await tick(stepMs);
  }
  return (await jobOf(itemId)).state;
}
const DONE = ['CONFIRMED', 'FAILED', 'BLOCKED', 'UNKNOWN', 'CANCELED'];

function headlineOf(item: Awaited<ReturnType<typeof itemOf>>, job: Awaited<ReturnType<typeof jobOf>>, pub: Awaited<ReturnType<typeof pubsOf>>[number] | null) {
  return itemHeadline({
    status: item.status,
    channel: 'youtube',
    job,
    pub,
    blockReason: job.lastErrorCode,
    publishAt: (item.payloadJson as { provider_metadata?: { publish_at?: string } }).provider_metadata?.publish_at ?? null,
    cancelTooLate: !!job.cancelRequestedAt && job.state === 'CONFIRMED',
  });
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-t15-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('EXPORT_LOCAL_DIR', path.join(tmp, 'exports'));
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  vi.stubEnv('SECRETS_MASTER_KEY', KEY);
  vi.stubEnv('SECRETS_KEY_VERSION', '1');
  vi.stubGlobal('fetch', async () => {
    fetchCalls++;
    throw new Error('T15 시험: 네트워크 호출 금지');
  });
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logs.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: Infinity }))).join(' ')));
  }
  storage = new LocalStorageAdapter(path.join(tmp, 'assets'));
  db = (await getDb(loadConfig())).db;
  owner = (await seed(db, { allowedIdentity: A })).ownerId;
  token = await login(A);
  yt.chunkBytes = CHUNK;
});
beforeEach(() => {
  yt.rateLimit = { ...YOUTUBE_PROVISIONAL_RATE_LIMIT };
  api.projectVerified = false;
});
afterAll(async () => {
  await closeDb();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe('Google 형 모의 OAuth 연결 → YouTube 모의 어댑터 선택', () => {
  it('연결한 YouTube 모의 계정은 mock_youtube, seed 계정(연결 없음)은 M3 일반 어댑터 그대로; 연결 정보는 mock_google·자리 표시 scope', async () => {
    const acc = await linkedAccount();
    const row = (await db.select().from(schema.channelAccounts).where(eq(schema.channelAccounts.id, acc.id)))[0]!;
    expect(row.credentialState).toBe('linked');
    expect(adapterIdFor({ kind: 'mock', platform: 'youtube', credential_state: row.credentialState })).toBe('mock_youtube');
    const cred = (await db.select().from(schema.oauthCredentials).where(eq(schema.oauthCredentials.channelAccountId, acc.id)))[0]!;
    expect(cred).toMatchObject({ provider: 'mock_google', isMock: true, scopes: ['youtube.upload(mock)'], status: 'active' });
    expect(cred.encryptedToken).toMatch(/^csk1:/);
    const seededYt = (await db.select().from(schema.channelAccounts).where(eq(schema.channelAccounts.ownerId, owner))).find((a) => a.platform === 'youtube' && a.credentialState === 'none')!;
    expect(adapterIdFor({ kind: 'mock', platform: 'youtube', credential_state: seededYt.credentialState })).toBe('mock_generic');
    // 모의 Google 의 refresh·access 토큰 원문은 응답에 없다
    const store = mockOAuthStore();
    expect([...store.tokens.values()].some((t) => t.provider === 'mock_google' && t.kind === 'refresh')).toBe(true);
  });
});

describe('업로드 → 처리 → 확인', () => {
  it('비공개 업로드 성공: REMOTE_PROCESSING(결과 없음) → CONFIRMED UPLOADED_PRIVATE MOCK, 세션 1·영상 1, 받은 바이트 = 파일(sha256 같음), 조각 읽기 ≤ 64KiB', async () => {
    const acc = await linkedAccount();
    const v = await youtubeVariant();
    const p = await plan([{ accountId: acc.id, variantId: v.variantId, requested: 'upload_private' }]);
    expect(p.items[0]!.requested_result).toBe('upload_private');
    const ex = await execute(p.planId);
    expect(ex.status, await ex.clone().text()).toBe(200);
    reads.length = 0;
    const sent0 = api.bytesSent;
    await tick();
    const itemId = p.items[0]!.id;
    let job = await jobOf(itemId);
    expect(job.state).toBe('REMOTE_PROCESSING');
    expect(await pubsOf(itemId)).toHaveLength(0);
    const sessions = await sessionsOf(itemId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ status: 'finished', receivedBytes: v.bytes, totalBytes: v.bytes, resumeCount: 0 });
    expect(Math.max(...reads)).toBeLessThanOrEqual(CHUNK);
    expect(reads.length).toBe(Math.ceil(v.bytes / CHUNK));
    expect(api.bytesSent - sent0).toBe(v.bytes);
    expect(youtubeProgressLine({ received: sessions[0]!.receivedBytes, total: sessions[0]!.totalBytes, resumes: 0, sessions: 1 })).toBe('업로드 100% (0.3/0.3 MB) · 세션 재개 0회');
    await tick(20_000);
    job = await jobOf(itemId);
    expect(job.state).toBe('CONFIRMED');
    const [pub] = await pubsOf(itemId);
    expect(pub).toMatchObject({ resultKind: 'UPLOADED_PRIVATE', remoteVisibility: 'private', verification: 'MOCK', isMock: true });
    expect(pub!.externalId).toMatch(/^mock:youtube:mockyt_v_/);
    expect(pub!.permalink).toMatch(/^mock:\/\/youtube\/watch\//);
    const videos = api.videosOf(acc.external);
    expect(videos).toHaveLength(1);
    expect(videos[0]!.sha256).toBe(v.checksum);
    expect(api.sessionUris(acc.external)).toHaveLength(1);
    expect((await stepsOf(itemId)).map((s) => `${s.kind}:${s.status}`)).toEqual(['upload_session:finished', 'video:processed']);
    const h = headlineOf(await itemOf(itemId), job, pub!);
    expect(h).toBe('비공개 업로드 완료, 공개 전환 확인 필요');
    expect(h).not.toMatch(/게시 완료/);
    expect(jobStatusText(job, pub!, null, 'youtube')).toMatch(/^CONFIRMED · MOCK 비공개 업로드 확인/);
    // API 응답: 세션 URI 는 `세션 있음` 만, MOCK 표시
    const detail = await rec(await planGET(get(`/api/distribution-plans/${p.planId}`), ctx(p.planId)));
    const json = (await detail.json()) as { items: Array<{ remote_steps: Array<{ kind: string; remote_id: string }>; publications: Array<{ notice: string }> }> };
    const rs = json.items[0]!.remote_steps;
    expect(rs.find((s) => s.kind === 'upload_session')!.remote_id).toBe('세션 있음');
    expect(rs.find((s) => s.kind === 'video')!.remote_id).toMatch(/^mockyt_v_/);
    expect(json.items[0]!.publications[0]!.notice).toMatch(/MOCK — 실제 발행 실적 아님/);
    const jd = await rec(await jobGET(get(`/api/jobs/${job.id}`), ctx(job.id)));
    expect(jd.status).toBe(200);
  });

  it('A14: 50% 지점 끊김 → 다음 시도가 같은 세션의 받은 바이트부터 이어 올림(보낸 바이트 ≈ 파일 + 조각 일부, 2배 아님), 영상 1개', async () => {
    const acc = await linkedAccount();
    const v = await youtubeVariant();
    const p = await plan([{ accountId: acc.id, variantId: v.variantId, scenario: 'youtube_network_drop' }]);
    await execute(p.planId);
    const itemId = p.items[0]!.id;
    const sent0 = api.bytesSent;
    await tick();
    expect((await jobOf(itemId)).state).toBe('RECONCILING');
    const [s1] = await sessionsOf(itemId);
    expect(s1!.receivedBytes).toBe(2 * CHUNK);
    expect(await drainUntil(itemId, DONE)).toBe('CONFIRMED');
    const sessions = await sessionsOf(itemId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.remoteId).toBe(s1!.remoteId);
    expect(sessions[0]!.resumeCount).toBe(1);
    expect(api.sessionUris(acc.external)).toHaveLength(1);
    const sent = api.bytesSent - sent0;
    expect(sent).toBe(v.bytes + CHUNK / 2);
    expect(sent).toBeLessThan(2 * v.bytes);
    expect(api.videosOf(acc.external)).toHaveLength(1);
    expect(api.videosOf(acc.external)[0]!.sha256).toBe(v.checksum);
    const job = await jobOf(itemId);
    expect(await intentsOf(job.id)).toHaveLength(2);
    expect((await eventsOf(job.id)).map((e) => (e.sanitizedDetails as { transition?: string }).transition)).toContain('resume');
    expect(youtubeProgressLine({ received: sessions[0]!.receivedBytes, total: sessions[0]!.totalBytes, resumes: 1, sessions: 1 })).toMatch(/세션 재개 1회/);
  });

  it('A08: 마지막 조각 응답 유실 → RECONCILING → 조회로 영상 확인 → CONFIRMED, 두 번째 세션·업로드 없음', async () => {
    const acc = await linkedAccount();
    const v = await youtubeVariant();
    const p = await plan([{ accountId: acc.id, variantId: v.variantId, scenario: 'youtube_response_lost_after_complete' }]);
    await execute(p.planId);
    const itemId = p.items[0]!.id;
    const init0 = api.calls.initResumable;
    const put0 = api.calls.putChunk;
    await tick();
    expect((await jobOf(itemId)).state).toBe('RECONCILING');
    expect(await drainUntil(itemId, DONE)).toBe('CONFIRMED');
    expect(api.calls.initResumable - init0).toBe(1);
    expect(api.calls.putChunk - put0).toBe(Math.ceil(v.bytes / CHUNK));
    expect(api.videosOf(acc.external)).toHaveLength(1);
    const job = await jobOf(itemId);
    expect(await intentsOf(job.id)).toHaveLength(1);
  });

  it('세션 만료(영상 없음이 확인됨) → 새 세션으로 처음부터(만료 세션 기록 유지), 영상 1개', async () => {
    const acc = await linkedAccount();
    const v = await youtubeVariant();
    const p = await plan([{ accountId: acc.id, variantId: v.variantId, scenario: 'youtube_session_expired_before_complete' }]);
    await execute(p.planId);
    const itemId = p.items[0]!.id;
    await tick();
    expect(await drainUntil(itemId, DONE)).toBe('CONFIRMED');
    const sessions = await sessionsOf(itemId);
    expect(sessions.map((s) => `${s.postIndex}:${s.status}`)).toEqual(['0:expired', '1:finished']);
    expect(api.videosOf(acc.external)).toHaveLength(1);
    expect(api.videosOf(acc.external)[0]!.sha256).toBe(v.checksum);
  });

  it('처리 지연(조회 3회) → REMOTE_PROCESSING 유지, 처리 끝 전 publication 없음 → CONFIRMED', async () => {
    const acc = await linkedAccount();
    const v = await youtubeVariant();
    const p = await plan([{ accountId: acc.id, variantId: v.variantId, scenario: 'youtube_processing_slow' }]);
    await execute(p.planId);
    const itemId = p.items[0]!.id;
    await tick();
    for (let i = 0; i < 3; i++) {
      await tick(20_000);
      expect((await jobOf(itemId)).state).toBe('REMOTE_PROCESSING');
      expect(await pubsOf(itemId)).toHaveLength(0);
      expect(headlineOf(await itemOf(itemId), await jobOf(itemId), null)).toBe('비공개 업로드 처리 중 — 확인 대기');
    }
    await tick(20_000);
    expect((await jobOf(itemId)).state).toBe('CONFIRMED');
  });
});

describe('공개 범위·예약(A12·A13·docs/03 승인 스냅샷)', () => {
  it('A12: public 요청 + 미검증 프로젝트 → CONFIRMED 이지만 원격 private(UPLOADED_PRIVATE), 요청·실제 공개 범위를 함께 기록, 공개 성공이라고 하지 않음', async () => {
    const acc = await linkedAccount();
    const v = await youtubeVariant();
    const p = await plan([{ accountId: acc.id, variantId: v.variantId, requested: 'public_publish', visibility: 'public', scenario: 'youtube_public_unverified_forced_private' }]);
    await execute(p.planId);
    const itemId = p.items[0]!.id;
    expect(await drainUntil(itemId, DONE)).toBe('CONFIRMED');
    const [pub] = await pubsOf(itemId);
    expect(pub).toMatchObject({ resultKind: 'UPLOADED_PRIVATE', remoteVisibility: 'private' });
    expect(api.videosOf(acc.external)[0]).toMatchObject({ requestedPrivacy: 'public', privacyStatus: 'private', forcedPrivate: true });
    const job = await jobOf(itemId);
    const confirmed = (await eventsOf(job.id)).find((e) => e.stateAfter === 'CONFIRMED')!;
    expect(confirmed.sanitizedDetails).toMatchObject({ requested_visibility: 'public', remote_visibility: 'private', result_kind: 'UPLOADED_PRIVATE' });
    const h = headlineOf(await itemOf(itemId), job, pub!);
    expect(h).toBe('비공개 업로드 완료, 공개 전환 확인 필요');
    expect(h).not.toMatch(/공개 게시|게시 완료/);
  });

  it('검증된 프로젝트(시험 전용 시나리오) + public → PUBLISHED/public — 문구는 "공개 게시 확인(MOCK)"', async () => {
    const acc = await linkedAccount();
    const v = await youtubeVariant();
    const p = await plan([{ accountId: acc.id, variantId: v.variantId, requested: 'public_publish', visibility: 'public', scenario: 'youtube_project_verified' }]);
    await execute(p.planId);
    const itemId = p.items[0]!.id;
    expect(await drainUntil(itemId, DONE)).toBe('CONFIRMED');
    const [pub] = await pubsOf(itemId);
    expect(pub).toMatchObject({ resultKind: 'PUBLISHED', remoteVisibility: 'public', verification: 'MOCK' });
    expect(headlineOf(await itemOf(itemId), await jobOf(itemId), pub!)).toBe('공개 게시 확인(MOCK)');
  });

  it('예약 공개: public_publish + private + 미래 publishAt(검증된 프로젝트) → SCHEDULED_REMOTE, 문구에 MSK 예약 시각', async () => {
    const acc = await linkedAccount();
    const v = await youtubeVariant();
    const p = await plan([
      { accountId: acc.id, variantId: v.variantId, requested: 'public_publish', visibility: 'private', publishAt: { date: FUTURE_DAY, time: '09:30' }, scenario: 'youtube_scheduled_private' },
    ]);
    expect((p.items[0]!.payload as { provider_metadata: unknown }).provider_metadata).toEqual({ publish_at: `${FUTURE_DAY}T06:30:00.000Z` });
    await execute(p.planId);
    const itemId = p.items[0]!.id;
    expect(await drainUntil(itemId, DONE)).toBe('CONFIRMED');
    const [pub] = await pubsOf(itemId);
    expect(pub).toMatchObject({ resultKind: 'SCHEDULED_REMOTE', remoteVisibility: 'private' });
    expect(api.videosOf(acc.external)[0]!.publishAt).toBe(`${FUTURE_DAY}T06:30:00.000Z`);
    expect(headlineOf(await itemOf(itemId), await jobOf(itemId), pub!)).toBe(`비공개 업로드 + 예약 공개 ${FUTURE_DAY} 09:30 MSK (원격 예약, 확인 필요)`);
  });

  it('비공개 업로드 승인 + publishAt: 계획 API 가 400, 스냅샷에 섞여 들어와도 어댑터 validate 가 업로드 전에 approval_mismatch', async () => {
    const acc = await linkedAccount();
    const v = await youtubeVariant();
    const bad = await rec(await createPlanApi([{ accountId: acc.id, variantId: v.variantId, requested: 'upload_private', publishAt: { date: FUTURE_DAY, time: '09:30' } }]));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('publish_at_requires_public_publish');
    const past = await createPlanApi([{ accountId: acc.id, variantId: v.variantId, requested: 'public_publish', visibility: 'private', publishAt: { date: '2020-01-01', time: '09:00' } }]);
    expect(past.status).toBe(400);
    expect((await past.json()).error).toBe('schedule_in_past');
    const pubVis = await createPlanApi([{ accountId: acc.id, variantId: v.variantId, requested: 'public_publish', visibility: 'public', publishAt: { date: FUTURE_DAY, time: '09:30' } }]);
    expect((await pubVis.json()).error).toBe('publish_at_requires_private');
    const mockOnly = await createPlanApi([{ accountId: acc.id, variantId: v.variantId, requested: 'mock_publish' }]);
    expect((await mockOnly.json()).error).toBe('requested_result_not_supported');
    // 스냅샷 조작 흉내: upload_private 항목의 payload 에 publish_at 을 넣은 스냅샷 → validate 거부(원격 호출 0)
    const p = await plan([{ accountId: acc.id, variantId: v.variantId, requested: 'upload_private' }], false);
    const item = await itemOf(p.items[0]!.id);
    const accRow = (await db.select().from(schema.channelAccounts).where(eq(schema.channelAccounts.id, acc.id)))[0]!;
    const calls = { ...api.calls };
    const r = yt.validate({
      item_id: item.id,
      channel: 'youtube',
      account: { id: acc.id, kind: 'mock', platform: 'youtube', external_account_id: accRow.externalAccountId, credential_state: accRow.credentialState },
      payload: { ...item.payloadJson, provider_metadata: { publish_at: `${FUTURE_DAY}T06:30:00.000Z` } },
      payload_hash: item.payloadHash,
      visibility: item.visibility,
      requested_result: item.requestedResult,
      scheduled_at_utc: null,
    });
    expect(r).toEqual({ ok: false, error_code: 'approval_mismatch' });
    expect(api.calls).toEqual(calls);
  });
});

describe('할당량·401·거부·부분 성공·연결 정보', () => {
  it('로컬 할당량 소진 → 전송 의도·세션 없이 RETRY_WAIT("할당량 소진 — HH:mm MSK 이후 재시도"), 창이 풀리면 업로드', async () => {
    yt.rateLimit = { ...YOUTUBE_PROVISIONAL_RATE_LIMIT, max_units: 1, window_sec: 3600 };
    const acc = await linkedAccount();
    const v1 = await youtubeVariant();
    const p1 = await plan([{ accountId: acc.id, variantId: v1.variantId }]);
    await execute(p1.planId);
    expect(await drainUntil(p1.items[0]!.id, DONE)).toBe('CONFIRMED');
    const v2 = await youtubeVariant();
    const p2 = await plan([{ accountId: acc.id, variantId: v2.variantId }]);
    await execute(p2.planId);
    const init0 = api.calls.initResumable;
    await tick(1000);
    const job = await jobOf(p2.items[0]!.id);
    expect(job).toMatchObject({ state: 'RETRY_WAIT', lastErrorCode: 'local_rate_limited', attempt: 0 });
    expect(await intentsOf(job.id)).toHaveLength(0);
    expect(api.calls.initResumable).toBe(init0);
    expect(jobStatusText(job, null, null, 'youtube')).toMatch(/^RETRY_WAIT · 할당량 소진 — \d\d:\d\d MSK 이후 재시도$/);
    expect(headlineOf(await itemOf(p2.items[0]!.id), job, null)).toMatch(/^할당량 소진 — \d\d:\d\d MSK 이후 재시도$/);
    await tick(61 * MIN);
    expect(await drainUntil(p2.items[0]!.id, DONE)).toBe('CONFIRMED');
    expect(api.videosOf(acc.external)).toHaveLength(2);
  });

  it('FIX-T15 P1: 한도 1에서 세션 만료 뒤 새 세션 → 만료 세션도 창 안 사용량이라 새 세션은 local_rate_limited(의도·세션 없이), 창이 풀리면 새 세션', async () => {
    yt.rateLimit = { ...YOUTUBE_PROVISIONAL_RATE_LIMIT, max_units: 1, window_sec: 3600 };
    const acc = await linkedAccount();
    const v = await youtubeVariant();
    const p = await plan([{ accountId: acc.id, variantId: v.variantId, scenario: 'youtube_session_expired_before_complete' }]);
    await execute(p.planId);
    const itemId = p.items[0]!.id;
    const init0 = api.calls.initResumable;
    await tick();
    expect((await jobOf(itemId)).state).toBe('RECONCILING');
    // 조회: 만료 확인 → not_found → RETRY_WAIT. 다음 시도는 새 세션이 필요하다(단위 1) — 만료 세션 행이 이를 상계하지 않는다.
    let limited = false;
    for (let i = 0; i < 6 && !limited; i++) {
      await tick(20_000);
      const j = await jobOf(itemId);
      limited = j.state === 'RETRY_WAIT' && j.lastErrorCode === 'local_rate_limited';
    }
    expect(limited).toBe(true);
    const job = await jobOf(itemId);
    expect(await intentsOf(job.id)).toHaveLength(1);
    expect(api.calls.initResumable - init0).toBe(1);
    expect((await sessionsOf(itemId)).map((s) => `${s.postIndex}:${s.status}`)).toEqual(['0:expired']);
    const ev = (await eventsOf(job.id)).find((e) => (e.sanitizedDetails as { transition?: string }).transition === 'local_rate_limited')!;
    expect(ev.sanitizedDetails).toMatchObject({ used: 1, needed: 1, not_sent: true });
    await tick(61 * MIN);
    expect(await drainUntil(itemId, DONE)).toBe('CONFIRMED');
    expect((await sessionsOf(itemId)).map((s) => `${s.postIndex}:${s.status}`)).toEqual(['0:expired', '1:finished']);
    expect(api.videosOf(acc.external)).toHaveLength(1);
  });

  it('FIX-T15 P1: 한도 1에서 유효한 세션 재개는 할당량을 쓰지 않는다(local_rate_limited 없음, 세션 1·의도 2)', async () => {
    yt.rateLimit = { ...YOUTUBE_PROVISIONAL_RATE_LIMIT, max_units: 1, window_sec: 3600 };
    const acc = await linkedAccount();
    const v = await youtubeVariant();
    const p = await plan([{ accountId: acc.id, variantId: v.variantId, scenario: 'youtube_network_drop' }]);
    await execute(p.planId);
    const itemId = p.items[0]!.id;
    await tick();
    expect(await drainUntil(itemId, DONE)).toBe('CONFIRMED');
    const job = await jobOf(itemId);
    const transitions = (await eventsOf(job.id)).map((e) => (e.sanitizedDetails as { transition?: string }).transition);
    expect(transitions).toContain('resume');
    expect(transitions).not.toContain('local_rate_limited');
    expect(await sessionsOf(itemId)).toHaveLength(1);
    expect(await intentsOf(job.id)).toHaveLength(2);
  });

  it('FIX-T15 P1: 사전 검사(재개 — 단위 0) 직후 세션 만료 → 그 시도는 새 세션을 만들지 않음(부작용 없음), 다음 시도가 할당량 재검사 → local_rate_limited', async () => {
    yt.rateLimit = { ...YOUTUBE_PROVISIONAL_RATE_LIMIT, max_units: 1, window_sec: 3600 };
    const acc = await linkedAccount();
    const v = await youtubeVariant();
    const p = await plan([{ accountId: acc.id, variantId: v.variantId, scenario: 'youtube_network_drop' }]);
    await execute(p.planId);
    const itemId = p.items[0]!.id;
    await tick();
    expect((await jobOf(itemId)).state).toBe('RECONCILING');
    await tick(20_000); // 조회 → resumable → RETRY_WAIT(즉시)
    expect((await jobOf(itemId)).state).toBe('RETRY_WAIT');
    // 사전 검사는 유효한 세션(단위 0)을 보지만 원격에서는 이미 만료 — 보낼 때 확인된다
    for (const uri of api.sessionUris(acc.external)) api.expireSession(uri);
    const init0 = api.calls.initResumable;
    await tick(1000);
    let job = await jobOf(itemId);
    expect(job).toMatchObject({ state: 'RETRY_WAIT', lastErrorCode: 'upload_session_requires_quota_check' });
    expect(api.calls.initResumable).toBe(init0);
    expect((await sessionsOf(itemId)).map((s) => s.status)).toEqual(['expired']);
    await tick(5 * MIN);
    job = await jobOf(itemId);
    expect(job).toMatchObject({ state: 'RETRY_WAIT', lastErrorCode: 'local_rate_limited' });
    expect(api.calls.initResumable).toBe(init0);
    await tick(61 * MIN);
    expect(await drainUntil(itemId, DONE)).toBe('CONFIRMED');
    expect(api.videosOf(acc.external)).toHaveLength(1);
  });

  it('원격 403 quotaExceeded → 세션 없이 RETRY_WAIT(초기화 시각까지, Retry-After 1시간 상한으로 FAILED 되지 않음) → 뒤에 업로드', async () => {
    const acc = await linkedAccount();
    const v = await youtubeVariant();
    const p = await plan([{ accountId: acc.id, variantId: v.variantId, scenario: 'youtube_quota_exceeded' }]);
    await execute(p.planId);
    const itemId = p.items[0]!.id;
    await tick();
    const job = await jobOf(itemId);
    expect(job).toMatchObject({ state: 'RETRY_WAIT', lastErrorCode: 'quota_exceeded' });
    expect(api.sessionUris(acc.external)).toHaveLength(0);
    expect(job.nextRunAt.getTime() - (Date.now() + vt)).toBeGreaterThan(50 * MIN);
    await tick(61 * MIN);
    expect(await drainUntil(itemId, DONE)).toBe('CONFIRMED');
    expect(api.sessionUris(acc.external)).toHaveLength(1);
  });

  it('401(토큰 거절) → BLOCKED(세션 0) + T13 연결 확인 1회; 업로드 뒤 거부(rejected) → FAILED(publication 없음, 재시도 없음)', async () => {
    const acc = await linkedAccount();
    const v = await youtubeVariant();
    const p = await plan([{ accountId: acc.id, variantId: v.variantId, scenario: 'youtube_token_invalid' }]);
    await execute(p.planId);
    const itemId = p.items[0]!.id;
    await tick();
    const job = await jobOf(itemId);
    expect(job).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'auth_invalid_token' });
    expect(api.sessionUris(acc.external)).toHaveLength(0);
    const cred = (await db.select().from(schema.oauthCredentials).where(eq(schema.oauthCredentials.channelAccountId, acc.id)))[0]!;
    expect(cred.lastCheckedAt).not.toBeNull();
    expect(headlineOf(await itemOf(itemId), job, null)).toBe('계정 다시 연결 필요');
    const v2 = await youtubeVariant();
    const p2 = await plan([{ accountId: acc.id, variantId: v2.variantId, scenario: 'youtube_rejected' }]);
    await execute(p2.planId);
    expect(await drainUntil(p2.items[0]!.id, DONE)).toBe('FAILED');
    const j2 = await jobOf(p2.items[0]!.id);
    expect(j2.lastErrorCode).toBe('youtube_rejected:mock_rejected');
    expect(await pubsOf(p2.items[0]!.id)).toHaveLength(0);
    expect(await intentsOf(j2.id)).toHaveLength(1);
    expect((await stepsOf(p2.items[0]!.id)).find((s) => s.kind === 'video')!.status).toBe('error');
  });

  it('A09: 한 계획에서 YouTube(401) 보류 + Threads 성공 → partial, YouTube 재시도 성공 뒤에도 Threads 는 다시 보내지 않음', async () => {
    const yAcc = await linkedAccount('youtube');
    const tAcc = await linkedAccount('threads');
    const v = await youtubeVariant();
    const tv = await threadsVariant();
    const p = await plan([
      { accountId: yAcc.id, variantId: v.variantId, requested: 'upload_private', scenario: 'youtube_token_invalid' },
      { accountId: tAcc.id, variantId: tv },
    ]);
    await execute(p.planId);
    await tick();
    await tick(20_000);
    const [yItem, tItem] = p.items;
    expect((await jobOf(yItem!.id)).state).toBe('BLOCKED');
    expect((await jobOf(tItem!.id)).state).toBe('CONFIRMED');
    const planRow = (await db.select().from(schema.distributionPlans).where(eq(schema.distributionPlans.id, p.planId)))[0]!;
    expect(planRow.status).toBe('partial');
    const threadsPosts = thrApi.postsOf(tAcc.external).length;
    const r = await rec(await retryPOST(post(`/api/distribution-items/${yItem!.id}/retry`), ctx(yItem!.id)));
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await drainUntil(yItem!.id, DONE)).toBe('CONFIRMED');
    expect(thrApi.postsOf(tAcc.external)).toHaveLength(threadsPosts);
    expect(await intentsOf((await jobOf(tItem!.id)).id)).toHaveLength(1);
    expect((await db.select().from(schema.distributionPlans).where(eq(schema.distributionPlans.id, p.planId)))[0]!.status).toBe('completed');
  });

  it('연결 정보를 쓸 수 없으면(정리 대기 표시) 세션 없이 BLOCKED — 모의 YouTube 호출 0', async () => {
    const acc = await linkedAccount();
    const v = await youtubeVariant();
    const p = await plan([{ accountId: acc.id, variantId: v.variantId }]);
    await execute(p.planId);
    const cred = (await db.select().from(schema.oauthCredentials).where(eq(schema.oauthCredentials.channelAccountId, acc.id)))[0]!;
    // FIX4-T13: 정리 대기는 oauth_pending_tokens 행
    await db
      .insert(schema.oauthPendingTokens)
      .values({ ownerId: cred.ownerId, channelAccountId: acc.id, kind: 'cleanup_revoke', sealedToken: cred.encryptedToken, keyVersion: cred.keyVersion, source: 'test' });
    const calls = { ...api.calls };
    await tick();
    const job = await jobOf(p.items[0]!.id);
    expect(job.state).toBe('BLOCKED');
    expect(job.lastErrorCode).toMatch(/^credential_/);
    expect(api.calls).toEqual(calls);
    expect(await sessionsOf(p.items[0]!.id)).toHaveLength(0);
  });

  it('access token(1시간)이 지나면 보내기 전에 T13 갱신 경로로 한 번 갱신(세대 +1) 뒤 업로드', async () => {
    const acc = await linkedAccount();
    const v = await youtubeVariant();
    const p = await plan([{ accountId: acc.id, variantId: v.variantId }]);
    await execute(p.planId);
    const before = (await db.select().from(schema.oauthCredentials).where(eq(schema.oauthCredentials.channelAccountId, acc.id)))[0]!;
    vt += 2 * 3600_000;
    expect(await drainUntil(p.items[0]!.id, DONE)).toBe('CONFIRMED');
    const after = (await db.select().from(schema.oauthCredentials).where(eq(schema.oauthCredentials.channelAccountId, acc.id)))[0]!;
    expect(after.tokenGeneration).toBe(before.tokenGeneration + 1);
    expect(after.status).toBe('active');
  });
});

describe('취소', () => {
  it('끊긴 뒤(영상 없음) 취소 → CANCELED, 영상 없음·다시 올리지 않음', async () => {
    const acc = await linkedAccount();
    const v = await youtubeVariant();
    const p = await plan([{ accountId: acc.id, variantId: v.variantId, scenario: 'youtube_network_drop' }]);
    await execute(p.planId);
    const itemId = p.items[0]!.id;
    await tick();
    expect((await jobOf(itemId)).state).toBe('RECONCILING');
    const c = await rec(await cancelPOST(post(`/api/distribution-items/${itemId}/cancel`), ctx(itemId)));
    expect(c.status).toBe(200);
    expect(await drainUntil(itemId, DONE)).toBe('CANCELED');
    expect(api.videosOf(acc.external)).toHaveLength(0);
  });

  it('업로드 뒤(처리 중) 취소 → 삭제는 범위 밖: 원격 확인 후 CONFIRMED + "업로드됨 — 삭제는 별도 동작(범위 밖)"', async () => {
    const acc = await linkedAccount();
    const v = await youtubeVariant();
    const p = await plan([{ accountId: acc.id, variantId: v.variantId, scenario: 'youtube_processing_slow' }]);
    await execute(p.planId);
    const itemId = p.items[0]!.id;
    await tick();
    expect((await jobOf(itemId)).state).toBe('REMOTE_PROCESSING');
    const c = await rec(await cancelPOST(post(`/api/distribution-items/${itemId}/cancel`), ctx(itemId)));
    expect((await c.json()).cancel_requested).toBe(true);
    expect(await drainUntil(itemId, DONE)).toBe('CONFIRMED');
    const job = await jobOf(itemId);
    const [pub] = await pubsOf(itemId);
    expect(headlineOf(await itemOf(itemId), job, pub!)).toBe('비공개 업로드 완료, 공개 전환 확인 필요 · 업로드됨 — 삭제는 별도 동작(범위 밖)');
    expect((await eventsOf(job.id)).at(-1)!.sanitizedDetails).toMatchObject({ transition: 'cancel_too_late' });
  });
});

describe('DB 규칙·앱 경로', () => {
  it('remote_steps: 받은 바이트 감소·전체 크기 변경·처리 끝 상태 변경·삭제 거부', async () => {
    const acc = await linkedAccount();
    const v = await youtubeVariant();
    const p = await plan([{ accountId: acc.id, variantId: v.variantId }]);
    await execute(p.planId);
    await tick();
    await tick(20_000);
    const [s, vid] = await stepsOf(p.items[0]!.id);
    await expect(db.execute(sql`update remote_steps set received_bytes = 10 where id = ${s!.id}::uuid`)).rejects.toThrow();
    await expect(db.execute(sql`update remote_steps set total_bytes = 999 where id = ${s!.id}::uuid`)).rejects.toThrow();
    await expect(db.execute(sql`update remote_steps set resume_count = 0, received_bytes = null where id = ${s!.id}::uuid`)).rejects.toThrow();
    await expect(db.execute(sql`update remote_steps set status = 'uploaded' where id = ${vid!.id}::uuid`)).rejects.toThrow();
    await expect(db.execute(sql`delete from remote_steps where id = ${s!.id}::uuid`)).rejects.toThrow();
    await expect(db.execute(sql`update remote_steps set status = 'published' where id = ${s!.id}::uuid`)).rejects.toThrow();
  });

  it('FIX-T15 P1(docs/02): web tick route 는 요청마다 조각 1개만 올리고 양보(RETRY_WAIT upload_slice_yield) — 다음 요청이 같은 세션으로 이어 올려 끝까지, 합계 = 파일', async () => {
    const acc = await linkedAccount();
    const v = await youtubeVariant();
    const p = await plan([{ accountId: acc.id, variantId: v.variantId }]);
    await execute(p.planId);
    const itemId = p.items[0]!.id;
    const chunks = Math.ceil(v.bytes / CHUNK);
    expect(chunks).toBeGreaterThan(2);
    const sent0 = api.bytesSent;
    const init0 = api.calls.initResumable;
    for (let i = 1; i <= chunks; i++) {
      const put0 = api.calls.putChunk;
      const res = await rec(await tickPOST(post('/api/worker/tick', { max_jobs: 5 })));
      expect(res.status).toBe(200);
      expect((await res.json()).mode).toBe('MOCK');
      expect(api.calls.putChunk - put0).toBe(1);
      const job = await jobOf(itemId);
      const [session] = await sessionsOf(itemId);
      if (i < chunks) {
        expect(job).toMatchObject({ state: 'RETRY_WAIT', lastErrorCode: 'upload_slice_yield' });
        expect(session!.receivedBytes).toBe(i * CHUNK);
        expect(jobStatusText(job, null, null, 'youtube')).toBe('RETRY_WAIT · 업로드 진행 중 — 다음 처리에서 같은 세션으로 이어 올림');
        expect(await pubsOf(itemId)).toHaveLength(0);
      } else {
        expect(job.state).toBe('REMOTE_PROCESSING');
        expect(session).toMatchObject({ status: 'finished', receivedBytes: v.bytes });
      }
    }
    expect(api.bytesSent - sent0).toBe(v.bytes);
    expect(api.calls.initResumable - init0).toBe(1);
    const job = await jobOf(itemId);
    // 양보는 장애가 아니다 — 시도 한도에 넣지 않는다(의도는 조각마다, 센 시도 1)
    expect(await intentsOf(job.id)).toHaveLength(chunks);
    expect(countedAttempts(job)).toBe(1);
    expect((await eventsOf(job.id)).filter((e) => (e.sanitizedDetails as { transition?: string }).transition === 'upload_yield')).toHaveLength(chunks - 1);
    expect(await drainUntil(itemId, DONE)).toBe('CONFIRMED');
    expect(api.videosOf(acc.external)).toHaveLength(1);
    expect(api.videosOf(acc.external)[0]!.sha256).toBe(v.checksum);
  });

  it('FIX-T15 P1: inline worker(web 요청 안 — health·목록)도 같은 조각 예산(작업당 조각 1개)', async () => {
    // 실행 환경 설정(시험용 저장소 위치 — beforeAll 의 env)으로 web 과 같은 inline 경로를 부른다
    const live = loadConfig();
    expect(live.WORKER_MODE).toBe('inline');
    expect(WEB_TICK_UPLOAD_SLICE.max_bytes).toBeLessThanOrEqual(CHUNK);
    const acc = await linkedAccount();
    const v = await youtubeVariant();
    const p = await plan([{ accountId: acc.id, variantId: v.variantId }]);
    await execute(p.planId);
    const itemId = p.items[0]!.id;
    const put0 = api.calls.putChunk;
    const t = await runInlineWorker(live, db);
    expect(t).not.toBeNull();
    expect(api.calls.putChunk - put0).toBe(1);
    expect(await jobOf(itemId)).toMatchObject({ state: 'RETRY_WAIT', lastErrorCode: 'upload_slice_yield' });
    expect((await sessionsOf(itemId))[0]!.receivedBytes).toBe(CHUNK);
    // 별도 worker 처리(예산 없음)가 나머지를 한 번에 이어 올린다
    expect(await drainUntil(itemId, DONE)).toBe('CONFIRMED');
    expect(await sessionsOf(itemId)).toHaveLength(1);
  });
});

describe('비밀 — 토큰·세션 URI 는 어디에도 나가지 않는다', () => {
  it('콘솔·응답·감사·작업 이력·전송 의도·결과에 토큰·세션 URI 없음, 내보내기 묶음의 세션 URI 는 가림, fetch 0', async () => {
    const tokens = [...mockOAuthStore().tokens.values()].length;
    expect(tokens).toBeGreaterThan(0);
    const sessionUris = api.sessionUris();
    expect(sessionUris.length).toBeGreaterThan(0);
    const dump = async (t: unknown) => JSON.stringify(await db.select().from(t as typeof schema.auditEvents));
    const tables = [schema.auditEvents, schema.jobEvents, schema.sendIntents, schema.publications, schema.jobs, schema.mockScenarios];
    for (const t of tables) {
      const d = await dump(t);
      expect(d).not.toMatch(/mockyt_at_|mockyt_rt_|mock:\/\/youtube\/upload\//);
    }
    for (const s of seen) expect(s).not.toMatch(/mockyt_at_|mockyt_rt_|mock:\/\/youtube\/upload\//);
    for (const l of logs) expect(l).not.toMatch(/mockyt_at_|mockyt_rt_|mock:\/\/youtube\/upload\//);
    const ex = await exportOwner(db, new LocalStorageAdapter(path.join(tmp, 'assets')), owner, { outDir: path.join(tmp, 'exports') });
    const raw = readFileSync(ex.zipPath);
    for (const uri of sessionUris) expect(raw.includes(Buffer.from(uri))).toBe(false);
    const parsed = await parseBundleZip(raw);
    const sessions = parsed.tables.remote_steps.filter((r) => r.kind === 'upload_session');
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((r) => /^mock-redacted:session:[0-9a-f]{16}$/.test(String(r.remote_id)))).toBe(true);
    expect(fetchCalls).toBe(0);
  });

  it('업로드 세션이 있는 owner 의 복원 훈련 PASS — 이미 가린 세션 값을 다시 가리지 않는다(내보내기→복원→내보내기 같은 값)', async () => {
    const before = await exportOwner(db, storage, owner, { outDir: path.join(tmp, 'exports-drill'), record: false });
    const masked = (await parseBundleZip(readFileSync(before.zipPath))).tables.remote_steps.filter((r) => r.kind === 'upload_session');
    expect(masked.length).toBeGreaterThan(0);
    let reExported: string[] = [];
    const r = await runRestoreDrill(db, storage, owner, {
      trigger: 'test',
      tmpRoot: tmp,
      afterRestore: async (target, targetOwnerId) => {
        const ex2 = await exportOwner(target, new LocalStorageAdapter(path.join(tmp, 'assets-drill-target')), targetOwnerId, { outDir: path.join(tmp, 'exports-drill-2'), record: false });
        reExported = (await parseBundleZip(readFileSync(ex2.zipPath))).tables.remote_steps.filter((x) => x.kind === 'upload_session').map((x) => String(x.remote_id)).sort();
      },
    });
    expect(r.mismatches).toEqual([]);
    expect(r.result).toBe('pass');
    expect(reExported).toEqual(masked.map((x) => String(x.remote_id)).sort());
  }, 120_000);
});

describe('drill:mock 의 YouTube 행(같은 표)', () => {
  it('불변식 위반 0·fetch 0, 표가 기대와 같다(영상 1개·세션 재사용·보낸 바이트 < 2×·미검증 PUBLISHED 없음)', async () => {
    const r = await runYouTubeDrill();
    expect(r.violations).toEqual([]);
    expect(r.fetch_calls).toBe(0);
    expect(r.rows.every((x) => x.ok)).toBe(true);
    const table = Object.fromEntries(youtubeDrillTableRows(r).map((c) => [c[0], c.slice(1)]));
    const P = 'MOCK UPLOADED_PRIVATE/private';
    expect(table).toEqual({
      'youtube_scheduled_private · 예약 공개(검증된 프로젝트)': ['CONFIRMED', 'CONFIRMED', '1', '1', '0', '1.00×', '1', 'MOCK SCHEDULED_REMOTE/private', '없음'],
      'youtube_success_private · upload_private': ['CONFIRMED', 'CONFIRMED', '1', '1', '0', '1.00×', '1', P, '없음'],
      'youtube_processing_slow → 처리 대기': ['CONFIRMED', 'CONFIRMED', '1', '1', '0', '1.00×', '1', P, '없음'],
      'youtube_network_drop(50%) → 같은 세션 재개': ['CONFIRMED', 'CONFIRMED', '2', '1', '1', '1.11×', '1', P, '없음'],
      'youtube_response_lost_after_complete → 조회로 확인': ['CONFIRMED', 'CONFIRMED', '1', '1', '0', '1.00×', '1', P, '없음'],
      'youtube_session_expired_before_complete → 새 세션': ['CONFIRMED', 'CONFIRMED', '2', '2', '0', '1.64×', '1', P, '없음'],
      'youtube_token_invalid(401)': ['BLOCKED', 'BLOCKED', '1', '0', '0', '0.00×', '0', '없음', '없음'],
      'youtube_rejected → FAILED': ['FAILED', 'FAILED', '1', '1', '0', '1.00×', '1', '없음', '없음'],
      'public 요청 + 미검증 프로젝트 → 비공개 강제': ['CONFIRMED', 'CONFIRMED', '1', '1', '0', '1.00×', '1', P, '없음'],
      'public 요청 + 검증된 프로젝트(시험 전용)': ['CONFIRMED', 'CONFIRMED', '1', '1', '0', '1.00×', '1', 'MOCK PUBLISHED/public', '없음'],
      'youtube_quota_exceeded(403) → 초기화 뒤 업로드': ['CONFIRMED', 'CONFIRMED', '2', '1', '0', '1.00×', '1', P, '없음'],
      '로컬 할당량 · 1번째': ['CONFIRMED', 'CONFIRMED', '1', '1', '0', '1.00×', '1', P, '없음'],
      '로컬 할당량 · 2번째(창 뒤, 의도·세션 없이 대기)': ['CONFIRMED', 'CONFIRMED', '1', '1', '0', '1.00×', '1', P, '없음'],
      '재시작(모의 YouTube 기록 유실) → UNKNOWN': ['UNKNOWN', 'UNKNOWN', '1', '1', '0', '—', '0', '없음', '없음'],
    });
    expect(formatYouTubeDrillTable(r)).not.toMatch(/게시 완료|공개 게시 성공/);
  }, 120_000);
});
