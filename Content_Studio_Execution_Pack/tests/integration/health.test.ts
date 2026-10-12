import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  approveItems,
  createContent,
  createPlan,
  createVariantDraft,
  executePlan,
  getDb,
  listChannelAccounts,
  schema,
  seed,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { loadConfig } from '@cs/domain';
import { getLastTick } from '@cs/worker';
import { GET } from '../../apps/web/app/api/health/route';
import { GET as detailsGET } from '../../apps/web/app/api/health/details/route';
import { GET as transcriptionJobsGET } from '../../apps/web/app/api/transcription-jobs/route';
import { BASE, cookieHeader, login } from './helpers';

/** T21-P3(G4): 공개 health 는 생존 여부만 — 응답 키는 정확히 이것뿐(ok·degraded 모두). */
const PUBLIC_KEYS = ['app', 'db_ok', 'status', 'time_utc'];
/** 공개 응답에 나오면 안 되는 자세한 상태·운영 숫자 키(D23(e)·D30-3·T21-P3) */
const FORBIDDEN = [
  'modes', 'llm', 'stt', 'version', 'driver', 'migrated', 'worker', 'last_tick_utc', 'missing', 'live_ready', 'time_msk', 'timezone',
  'jobs', 'uploads', 'captures', 'attention_plans', 'ops', 'queued', 'sessions', 'bytes',
];
/** 로그인 뒤 GET /api/health/details 의 키 */
const DETAIL_KEYS = ['app', 'db', 'llm', 'modes', 'status', 'stt', 'time_msk', 'time_utc', 'timezone', 'version', 'worker'];

function expectPublicOnly(body: Record<string, unknown>) {
  expect(Object.keys(body).sort()).toEqual(PUBLIC_KEYS);
  expect(typeof body.db_ok).toBe('boolean');
  const text = JSON.stringify(body);
  for (const k of FORBIDDEN) expect(text).not.toContain(`"${k}"`);
}

const config = loadConfig();
let db: Db;
let token: string;
let tmp: string;
let ownerId: string;

const details = (headers: Record<string, string> = {}) =>
  detailsGET(new Request(`${BASE}/api/health/details`, { headers: { accept: 'application/json', ...headers } }), undefined);

/** tick 이 건드릴 수 있는 표 전체(행 그대로). 공개 요청 전후로 같아야 한다. */
async function sideEffectSnapshot(): Promise<string> {
  const [jobs, jobEvents, sendIntents, publications, transcriptionJobs, uploadSessions, usageLedger, auditEvents, oauthCredentials, collectorRuns] =
    await Promise.all([
      db.select().from(schema.jobs),
      db.select().from(schema.jobEvents),
      db.select().from(schema.sendIntents),
      db.select().from(schema.publications),
      db.select().from(schema.transcriptionJobs),
      db.select().from(schema.uploadSessions),
      db.select().from(schema.usageLedger),
      db.select().from(schema.auditEvents),
      db.select().from(schema.oauthCredentials),
      db.select().from(schema.collectorRuns),
    ]);
  // 행 순서에 기대지 않게 표마다 행 JSON 을 정렬해 비교한다.
  const rows = (r: unknown[]) => r.map((x) => JSON.stringify(x)).sort();
  return JSON.stringify(
    Object.fromEntries(
      Object.entries({ jobs, jobEvents, sendIntents, publications, transcriptionJobs, uploadSessions, usageLedger, auditEvents, oauthCredentials, collectorRuns }).map(
        ([k, v]) => [k, rows(v)],
      ),
    ),
  );
}

/** inline tick 이 처리할 일감: 승인·실행된 배포 작업 1개(QUEUED, 모의 어댑터). */
async function queuedJob(ownerId: string): Promise<string> {
  const accounts = await listChannelAccounts(db, ownerId);
  const threads = accounts.find((a) => a.platform === 'threads')!;
  const { content } = await createContent(db, ownerId, { title: 'health 부작용 확인', body: '# 제목\n\n본문 한 줄.' });
  const { variant } = await createVariantDraft(db, ownerId, content.id, { channel: 'threads', baseVersion: 1 });
  await setVariantLifecycle(db, ownerId, variant.id, { lifecycle: 'review', baseVersion: 1 });
  const { plan, items } = await createPlan(db, ownerId, { items: [{ variant_id: variant.id, channel_account_id: threads.id }] });
  await approveItems(db, ownerId, plan.id, {
    item_ids: items.map((r) => r.id),
    expected_hashes: Object.fromEntries(items.map((r) => [r.id, r.payloadHash])),
    confirm: true,
    purpose: 'mock_publish',
  });
  const ex = await executePlan(db, ownerId, plan.id, { commandKey: 'health-no-tick' }, config);
  return ex.queued[0]!.job_id;
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-health-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  expect(config.DATABASE_URL).toBe('memory://');
  db = (await getDb(config)).db;
  ({ ownerId } = await seed(db, { allowedIdentity: config.AUTH_ALLOWED_IDENTITY }));
  token = await login(config.AUTH_ALLOWED_IDENTITY);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  const h = await getDb(loadConfig());
  await h.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('GET /api/health (공개, 로그인 없음)', () => {
  it('200 생존 여부만: 키는 정확히 {status, app, time_utc, db_ok}, no-store', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toEqual({ status: 'ok', app: 'content-studio', time_utc: expect.any(String), db_ok: true });
    expect(new Date(body.time_utc).toISOString()).toBe(body.time_utc);
    expectPublicOnly(body);
  });

  it('환경변수 값(DB 경로·허용 식별자)·모드·빠진 조건 이름을 노출하지 않는다', async () => {
    const text = await (await GET()).text();
    expect(text).not.toContain('memory://');
    expect(text).not.toContain(config.AUTH_ALLOWED_IDENTITY);
    expect(text).not.toContain('DATABASE_URL');
    expect(text).not.toContain('mock');
    expect(text).not.toContain('pglite');
    expect(text).not.toContain('inline');
    expect(text).not.toContain('LLM_');
  });

  it('T21-P3: 공개 health 는 worker tick 을 돌리지 않는다 — 대기 작업·이력·원장·감사·last tick 그대로, 로그인한 처리 경로는 tick 을 돌린다(대조)', async () => {
    const jobId = await queuedJob(ownerId);
    const before = await sideEffectSnapshot();
    const tickBefore = getLastTick();
    for (let i = 0; i < 3; i++) expect((await GET()).status).toBe(200);
    expect(getLastTick()).toEqual(tickBefore);
    expect(await sideEffectSnapshot()).toBe(before);
    const job = (await db.select().from(schema.jobs)).find((j) => j.id === jobId)!;
    expect(job.state).toBe('QUEUED');

    // 로그인한 details 도 읽기 전용(tick 없음)
    expect((await details(cookieHeader(token))).status).toBe(200);
    expect(getLastTick()).toEqual(tickBefore);
    expect(await sideEffectSnapshot()).toBe(before);

    // 대조: 로그인한 전사 목록 조회(inline 처리 주기)는 tick 을 돌리고 같은 스냅숏이 달라진다 — 스냅숏이 변화를 잡는다는 증거
    const res = await transcriptionJobsGET(new Request(`${BASE}/api/transcription-jobs`, { headers: cookieHeader(token) }), undefined);
    expect(res.status).toBe(200);
    const tickAfter = getLastTick();
    expect(tickAfter).not.toBeNull();
    expect(tickAfter).not.toEqual(tickBefore);
    expect(await sideEffectSnapshot()).not.toBe(before);
  });

  it('degraded(DB 열기 실패 → 503)도 같은 4개 키만, 오류 내용 없음', async () => {
    vi.resetModules();
    vi.doMock('@cs/db', async (orig) => ({ ...(await orig<typeof import('@cs/db')>()), getDb: () => Promise.reject(new Error('db down')) }));
    try {
      const { GET: degradedGET } = await import('../../apps/web/app/api/health/route');
      const res = await degradedGET();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toEqual({ status: 'degraded', app: 'content-studio', time_utc: expect.any(String), db_ok: false });
      expectPublicOnly(body);
      expect(JSON.stringify(body)).not.toContain('db down');
    } finally {
      vi.doUnmock('@cs/db');
      vi.resetModules();
    }
  });

  it('설정 오류도 503 degraded 4개 키만(변수 이름·값 없음)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      vi.stubEnv('LLM_MODE', 'not-a-mode');
      const res = await GET();
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ status: 'degraded', app: 'content-studio', time_utc: expect.any(String), db_ok: false });
      expect(text).not.toContain('LLM_MODE');
      expect(text).not.toContain('not-a-mode');
    } finally {
      vi.stubEnv('LLM_MODE', 'mock');
      err.mockRestore();
    }
  });
});

describe('GET /api/health/details (로그인한 owner 만)', () => {
  it('세션 없음·잘못된 세션 → 401, 자세한 상태 키 미노출', async () => {
    for (const res of [await details(), await details(cookieHeader('not-a-real-token'))]) {
      expect(res.status).toBe(401);
      const text = await res.text();
      for (const k of ['modes', 'llm', 'stt', 'driver', 'migrated', 'worker', 'version', 'missing']) expect(text).not.toContain(`"${k}"`);
    }
  });

  it('로그인: 기본 모드(mock/disabled/disabled)·DB·worker 상태, 운영 숫자 키 없음', async () => {
    const res = await details(cookieHeader(token));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(DETAIL_KEYS);
    expect(body).toMatchObject({
      status: 'ok',
      app: 'content-studio',
      timezone: 'Europe/Moscow',
      modes: { llm: 'mock', publish: 'disabled', collectors: 'disabled' },
      db: { driver: 'pglite', ok: true, migrated: true },
      worker: { mode: 'inline' },
    });
    expect(Object.keys(body.db).sort()).toEqual(['driver', 'migrated', 'ok']);
    expect(Object.keys(body.worker).sort()).toEqual(['last_tick_utc', 'mode']);
    expect(body.time_msk).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(MSK\)$/);
    expect(typeof body.version).toBe('string');
    // 앞 시험의 로그인한 처리 경로가 tick 을 돌렸다 — details 는 그 시각을 보여 준다(자기가 tick 을 돌리지는 않음)
    expect(body.worker.last_tick_utc).toBe(getLastTick()?.ranAt ?? null);
    const text = JSON.stringify(body);
    for (const k of ['jobs', 'uploads', 'captures', 'attention_plans', 'ops', 'queued', 'sessions', 'bytes']) expect(text).not.toContain(`"${k}"`);
    expect(text).not.toContain('memory://');
    expect(text).not.toContain(config.AUTH_ALLOWED_IDENTITY);
  });
});
