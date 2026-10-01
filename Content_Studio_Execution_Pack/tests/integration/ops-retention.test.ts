/**
 * T20(결정 D22): 운영 화면 숫자(opsSnapshot)·/api/health ops·복원 훈련(pass / 변조 → fail)·보존 정리(미리보기 무변경, 내보낸 뒤 삭제,
 * 끝난 작업 이력만, 배포 파일·내보내기 ZIP 정책, 원문 표 불변, owner 격리, confirm 필수). 외부 호출 없음(모의 어댑터).
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, count, eq, sql } from 'drizzle-orm';
import {
  applyRetention,
  approveItems,
  closeDb,
  ensureOwner,
  createTestDb,
  createRestorePreview,
  commitRestore,
  drillErrorCode,
  createContent,
  createPlan,
  createVariantDraft,
  executePlan,
  exportOwner,
  getDb,
  insertAsset,
  listChannelAccounts,
  opsSnapshot,
  ownerScope,
  planRetention,
  runJobsTick,
  runAssist,
  runRestoreDrill,
  schema,
  seed,
  setMockScenario,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { buildAssetKey, loadConfig, type AppConfig, type Channel } from '@cs/domain';
import { createMockAdapterRegistry, LocalStorageAdapter, MockLlmProvider } from '@cs/providers';
import { GET as healthGET } from '../../apps/web/app/api/health/route';
import { POST as drillPOST } from '../../apps/web/app/api/ops/restore-drill/route';
import { POST as retentionPOST } from '../../apps/web/app/api/ops/retention/route';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const BODY = '# 해외 영업 첫 분기\n\n대리점과 재고 기준을 먼저 합의했다.\n\n가격표는 마지막에 확정했다.';
const DAY = 24 * 3600_000;

let db: Db;
let tmp: string;
let storage: LocalStorageAdapter;
let exportsDir: string;
const registry = createMockAdapterRegistry();
const as = (identity: string) => vi.stubEnv('AUTH_ALLOWED_IDENTITY', identity);
const cfg = (): AppConfig => loadConfig(process.env);

interface Owner {
  id: string;
  identity: string;
  token: string;
  accounts: Record<Channel, string>;
}

async function newOwner(prefix: string): Promise<Owner> {
  const identity = `${prefix}-${randomUUID().slice(0, 8)}@example.local`;
  const { ownerId } = await seed(db, { allowedIdentity: identity });
  const accounts = Object.fromEntries((await listChannelAccounts(db, ownerId)).map((a) => [a.platform, a.id])) as Record<Channel, string>;
  as(identity);
  return { id: ownerId, identity, token: await login(identity), accounts };
}

async function putAsset(ownerId: string) {
  const id = randomUUID();
  const bytes = new TextEncoder().encode(`image/png:${id}`);
  const key = buildAssetKey(ownerId, id);
  await storage.put(key, bytes);
  await insertAsset(db, { id, ownerId, key, mime: 'image/png', bytes: bytes.byteLength, checksum: createHash('sha256').update(bytes).digest('hex'), rightsStatus: 'owned', verificationState: 'VERIFIED' });
  return id;
}

/** 모의 배포 하나: 승인 → 실행 → (시나리오) → tick. */
async function distribute(o: Owner, scenario: string | null) {
  const { content } = await createContent(db, o.id, { title: `운영 ${randomUUID().slice(0, 4)}`, body: BODY });
  const { variant } = await createVariantDraft(db, o.id, content.id, { channel: 'threads', baseVersion: 1 });
  await setVariantLifecycle(db, o.id, variant.id, { lifecycle: 'review', baseVersion: 1 });
  const { plan, items } = await createPlan(db, o.id, { items: [{ variant_id: variant.id, channel_account_id: o.accounts.threads }] });
  await approveItems(db, o.id, plan.id, { item_ids: [items[0]!.id], expected_hashes: { [items[0]!.id]: items[0]!.payloadHash }, confirm: true, purpose: 'mock_publish' });
  const ex = await executePlan(db, o.id, plan.id, { commandKey: `ops-${randomUUID()}` }, cfg());
  if (scenario) await setMockScenario(db, o.id, items[0]!.id, { scenario: scenario as 'success' });
  await runJobsTick(db, registry, { workerId: 'ops-w', config: cfg(), ownerId: o.id, random: () => 0.5, submitTimeoutMs: 500, maxJobs: 10 });
  return { planId: plan.id, itemId: items[0]!.id, jobId: ex.queued[0]!.job_id, contentId: content.id };
}

const jobState = async (id: string) => (await db.select().from(schema.jobs).where(eq(schema.jobs.id, id)))[0]!.state;
const eventCount = async (jobId: string) => Number((await db.select({ n: count() }).from(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId)))[0]!.n);
async function protectedCounts(ownerId: string) {
  const out: Record<string, number> = {};
  for (const name of ['captures', 'capture_revisions', 'sources', 'source_versions', 'contents', 'content_versions', 'assets', 'jobs', 'send_intents'] as const) {
    const res = await db.execute(sql`select count(*)::int as n from ${sql.identifier(name)} where ${ownerScope(name, ownerId)}`);
    out[name] = Number((res as unknown as { rows: Array<{ n: number }> }).rows[0]!.n);
  }
  out.export_runs = Number((await db.select({ n: count() }).from(schema.exportRuns).where(eq(schema.exportRuns.ownerId, ownerId)))[0]!.n);
  return out;
}

/** DB 오류는 drizzle 이 감싼다 — 원인 메시지까지 본다. */
async function expectDbReject(p: Promise<unknown>, re: RegExp) {
  const e = await p.then(
    () => null,
    (x: unknown) => x as { message?: string; cause?: { message?: string } },
  );
  expect(e, 'DB 가 거부해야 합니다').not.toBeNull();
  expect(`${e!.message ?? ''} ${e!.cause?.message ?? ''}`).toMatch(re);
}

let A: Owner;
let B: Owner;
let confirmedA: Awaited<ReturnType<typeof distribute>>;
let blockedA: Awaited<ReturnType<typeof distribute>>;
let confirmedB: Awaited<ReturnType<typeof distribute>>;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-t20-it-'));
  exportsDir = path.join(tmp, 'exports');
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('EXPORT_LOCAL_DIR', exportsDir);
  storage = new LocalStorageAdapter(path.join(tmp, 'assets'));
  db = (await getDb(loadConfig())).db;
  A = await newOwner('ops-a');
  B = await newOwner('ops-b');
  await putAsset(A.id);
  confirmedA = await distribute(A, 'success');
  blockedA = await distribute(A, 'auth');
  confirmedB = await distribute(B, 'success');
}, 60_000);
beforeEach(() => {
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('EXPORT_LOCAL_DIR', exportsDir);
  as(A.identity);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('opsSnapshot — 숫자는 저장된 상태에서', () => {
  it('작업 상태별 개수·확인 필요 작업(링크용 계획 ID)·반복 실패·삭제 대기·백업 없음·모드', async () => {
    expect(await jobState(confirmedA.jobId)).toBe('CONFIRMED');
    expect(await jobState(blockedA.jobId)).toBe('BLOCKED');
    // 반복 실패: 실행만 한(QUEUED) 작업에 거부된 전송 의도 3개를 직접 기록(지난 7일)
    const { content } = await createContent(db, A.id, { title: '실패 반복', body: BODY });
    const { variant } = await createVariantDraft(db, A.id, content.id, { channel: 'threads', baseVersion: 1 });
    await setVariantLifecycle(db, A.id, variant.id, { lifecycle: 'review', baseVersion: 1 });
    const { plan, items } = await createPlan(db, A.id, { items: [{ variant_id: variant.id, channel_account_id: A.accounts.threads }] });
    await approveItems(db, A.id, plan.id, { item_ids: [items[0]!.id], expected_hashes: { [items[0]!.id]: items[0]!.payloadHash }, confirm: true, purpose: 'mock_publish' });
    const ex = await executePlan(db, A.id, plan.id, { commandKey: `ops-${randomUUID()}` }, cfg());
    const jid = ex.queued[0]!.job_id;
    for (const n of [1, 2, 3]) {
      await db.insert(schema.sendIntents).values({ ownerId: A.id, jobId: jid, attempt: n, intentKey: `${jid}:${n}`, outcome: n === 3 ? 'ambiguous' : 'rejected' });
    }
    // 파일 삭제 대기 하나
    const pendingAsset = await putAsset(A.id);
    await db.update(schema.assets).set({ pendingDeleteKey: 'x/y', pendingDeleteNextAt: new Date() }).where(eq(schema.assets.id, pendingAsset));

    const s = await opsSnapshot(db, A.id, cfg());
    expect(s.jobs.byState).toMatchObject({ CONFIRMED: 1, BLOCKED: 1, QUEUED: 1 });
    expect(s.jobs.total).toBe(3);
    expect(s.jobs.attention.items.map((j) => [j.jobId, j.state, j.planId])).toEqual([[blockedA.jobId, 'BLOCKED', blockedA.planId]]);
    expect(s.jobs.repeatedFailures).toEqual({ total: 1, truncated: false, items: [{ itemId: items[0]!.id, planId: plan.id, failures: 3 }] });
    expect(s.jobs.attention.total).toBe(1);
    expect(s.pendingDeletes.count).toBe(1);
    expect(s.pendingDeletes.oldestAt).toBeInstanceOf(Date);
    const attention = Number(
      (await db.select({ n: count() }).from(schema.distributionPlans).where(and(eq(schema.distributionPlans.ownerId, A.id), eq(schema.distributionPlans.status, 'attention'))))[0]!.n,
    );
    expect(s.jobs.attentionPlans.total).toBe(attention);
    expect(s.jobs.attentionPlans.items).toHaveLength(attention);
    expect(s.intents.pending).toBe(0);
    // 백업: 내보내기 기록 없음 → none(나이 없음), 훈련 기록 없음
    expect(s.backup).toMatchObject({ lastExport: null, state: 'none', maxAgeHours: 24, lastDrill: null });
    // 용량: 메모리 DB → null, 저장소는 실제 파일 수
    expect(s.disk.db).toBeNull();
    expect(s.disk.assets).toMatchObject({ present: true, files: 2 });
    expect(s.disk.exports.present).toBe(false);
    // 다른 owner 의 작업은 보이지 않는다
    expect((await opsSnapshot(db, B.id, cfg())).jobs.byState).toEqual({ CONFIRMED: 1 });
    // 정리
    await db.update(schema.assets).set({ pendingDeleteKey: null, pendingDeleteNextAt: null }).where(eq(schema.assets.id, pendingAsset));
  });

  it('내보내기 뒤 백업 나이: 기준 안 recent, 기준(1시간)보다 오래되면 stale', async () => {
    await exportOwner(db, storage, A.id, { outDir: exportsDir });
    const s = await opsSnapshot(db, A.id, cfg());
    expect(s.backup.state).toBe('recent');
    expect(s.backup.lastExport!.ageHours).toBeLessThan(1);
    const later = new Date(Date.now() + 3 * 3600_000);
    vi.stubEnv('BACKUP_MAX_AGE_HOURS', '1');
    const s2 = await opsSnapshot(db, A.id, cfg(), later);
    expect(s2.backup).toMatchObject({ state: 'stale', maxAgeHours: 1 });
    expect(s2.backup.lastExport!.ageHours).toBeGreaterThanOrEqual(3);
    vi.stubEnv('BACKUP_MAX_AGE_HOURS', '');
  });
});

describe('복원 훈련', () => {
  it('배포 이력(확정·보류·실패 의도)까지 있는 owner: 빈 메모리 DB 복원 → PASS, 기록 1줄, 훈련 묶음은 export_runs 에 없음, 인증 비밀 없음', async () => {
    const runsBefore = Number((await db.select({ n: count() }).from(schema.exportRuns).where(eq(schema.exportRuns.ownerId, A.id)))[0]!.n);
    const r = await runRestoreDrill(db, storage, A.id, { trigger: 'test', tmpRoot: tmp });
    expect(r.mismatches).toEqual([]);
    expect(r.result).toBe('pass');
    expect(r.tablesCompared).toBeGreaterThan(20);
    expect(r.rowsCompared).toBeGreaterThan(10);
    expect(r.assetsCompared).toBe(2);
    expect(r.searchProbe).toBe('found');
    // 복원이 일부러 바꾸는 표(작업 → 보류/결과 불명 등)는 내용 비교에서 그 열만 뺐다
    expect(r.tables.find((t) => t.table === 'jobs')).toMatchObject({ expected_rows: 3, actual_rows: 3, ids: 'same' });
    const rows = await db.select().from(schema.restoreDrills).where(eq(schema.restoreDrills.id, r.drillId));
    expect(rows[0]).toMatchObject({ ownerId: A.id, result: 'pass', trigger: 'test', exportRunId: r.bundleExportId, bundleSha256: r.bundleSha256 });
    expect(Number((await db.select({ n: count() }).from(schema.exportRuns).where(eq(schema.exportRuns.ownerId, A.id)))[0]!.n)).toBe(runsBefore);
    // 임시 폴더는 지웠다
    expect(readdirSync(tmp).filter((n) => n.startsWith('cs-restore-drill-'))).toEqual([]);
    expect((await opsSnapshot(db, A.id, cfg())).backup.lastDrill!.id).toBe(r.drillId);
  }, 60_000);

  it('복원한 행 하나를 바꾸면(변조) FAIL — content_sha256 불일치를 표·ID 로 남긴다(본문 없음)', async () => {
    const r = await runRestoreDrill(db, storage, A.id, {
      trigger: 'test',
      tmpRoot: tmp,
      afterRestore: async (target, owner) => {
        await target.execute(sql`update captures set raw_text = raw_text || ' 변조' where id = (select id from captures where owner_id = ${owner}::uuid order by id limit 1)`);
      },
    });
    expect(r.result).toBe('fail');
    expect(r.mismatches).toEqual([expect.objectContaining({ table: 'captures', kind: 'content_sha256', expected: 1 })]);
    const [row] = await db.select().from(schema.restoreDrills).where(eq(schema.restoreDrills.id, r.drillId));
    expect(row!.result).toBe('fail');
    expect(JSON.stringify(row!.mismatchJson)).not.toMatch(/변조|대리점/u);
  }, 60_000);

  it('원본 파일이 저장소에서 사라졌으면 FAIL(asset_missing_in_source) — 백업이 불완전', async () => {
    const o = await newOwner('ops-c');
    const id = await putAsset(o.id);
    const [a] = await db.select().from(schema.assets).where(eq(schema.assets.id, id));
    rmSync(path.join(tmp, 'assets', ...a!.key.split('/')));
    const r = await runRestoreDrill(db, storage, o.id, { trigger: 'test', tmpRoot: tmp });
    expect(r.result).toBe('fail');
    expect(r.mismatches.map((m) => m.kind)).toContain('asset_missing_in_source');
  }, 60_000);

  it('POST /api/ops/restore-drill: 폼 → 303 /ops?drill=<id>, JSON → 200 결과, Origin 없음 → 403', async () => {
    const form = await drillPOST(
      new Request(`${BASE}/api/ops/restore-drill`, { method: 'POST', headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded', ...ORIGIN_HEADERS, ...cookieHeader(A.token) }, body: '' }),
    );
    expect(form.status).toBe(303);
    expect(form.headers.get('location')).toMatch(/^\/ops\?drill=[0-9a-f-]{36}#backup$/u);
    const res = await drillPOST(jsonPost('/api/ops/restore-drill', {}, cookieHeader(A.token)));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: 'pass', mismatches: [] });
    const noOrigin = await drillPOST(new Request(`${BASE}/api/ops/restore-drill`, { method: 'POST', headers: { 'content-type': 'application/json', ...cookieHeader(A.token) }, body: '{}' }));
    expect(noOrigin.status).toBe(403);
  }, 60_000);
});

describe('보존 정리', () => {
  const future = () => new Date(Date.now() + 200 * DAY);
  const policy = (keep = 1) => ({ ...cfg(), RETENTION_EXPORT_RUNS_KEEP: keep });

  it('미리보기는 아무것도 바꾸지 않고, 적용은 confirm 이 있어야 한다', async () => {
    const before = await protectedCounts(A.id);
    const evBefore = await eventCount(confirmedA.jobId);
    const plan = await planRetention(db, A.id, policy(), exportsDir, future());
    expect(plan.jobEvents.jobIds).toEqual([confirmedA.jobId]); // 끝난 작업만(BLOCKED·QUEUED 작업 제외)
    expect(plan.jobEvents.events).toBe(evBefore);
    expect(await eventCount(confirmedA.jobId)).toBe(evBefore);
    expect(await protectedCounts(A.id)).toEqual(before);
    await expect(applyRetention(db, A.id, policy(), exportsDir, { confirm: false as unknown as true, now: future() })).rejects.toMatchObject({ code: 'confirm_required' });
    expect(await eventCount(confirmedA.jobId)).toBe(evBefore);
  });

  it('적용: 끝난 작업 이력은 JSONL 로 내보낸 뒤 삭제, 보류 작업 이력·다른 owner·원문 표는 그대로, 오래된 배포 파일·keep 밖 내보내기 ZIP 삭제, 두 번째는 0건', async () => {
    // 내보내기 ZIP 2개 더(총 3개) → keep 1 이면 2개 정리 대상
    await exportOwner(db, storage, A.id, { outDir: exportsDir });
    await exportOwner(db, storage, A.id, { outDir: exportsDir });
    // 배포 파일: 오래된 것 1개(수정 시각 40일 전), 새 것 1개
    const pkgDir = path.join(exportsDir, 'packages', A.id, confirmedA.contentId);
    mkdirSync(pkgDir, { recursive: true });
    const oldPkg = path.join(pkgDir, `${randomUUID()}.zip`);
    const newPkg = path.join(pkgDir, `${randomUUID()}.zip`);
    writeFileSync(oldPkg, 'old');
    writeFileSync(newPkg, 'new');
    const now = new Date();
    utimesSync(oldPkg, new Date(now.getTime() - 40 * DAY), new Date(now.getTime() - 40 * DAY));

    const before = await protectedCounts(A.id);
    const evConfirmed = await eventCount(confirmedA.jobId);
    const evBlocked = await eventCount(blockedA.jobId);
    const evB = await eventCount(confirmedB.jobId);
    // 이력은 "200일 뒤" 기준으로, 파일은 지금 기준으로(배포 파일 30일)
    const r = await applyRetention(db, A.id, policy(1), exportsDir, { confirm: true, now: future() });
    expect(r.jobEvents).toMatchObject({ jobs: 1, deleted: evConfirmed });
    expect(await eventCount(confirmedA.jobId)).toBe(0);
    expect(await eventCount(blockedA.jobId)).toBe(evBlocked);
    expect(await eventCount(confirmedB.jobId)).toBe(evB);
    // 내보낸 파일: 지운 행이 모두 들어 있다
    const archive = path.join(exportsDir, 'retention', A.id);
    const files = readdirSync(archive);
    expect(files).toHaveLength(1);
    const lines = readFileSync(path.join(archive, files[0]!), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(evConfirmed);
    expect(lines.every((l) => l.table === 'job_events' && l.job_id === confirmedA.jobId)).toBe(true);
    // 200일 뒤 기준이라 배포 파일 둘 다 30일보다 오래됨 → 둘 다 정리. 내보내기 ZIP 은 최근 1개만 남음
    expect(r.packages.deleted).toBe(2);
    expect(existsSync(oldPkg) || existsSync(newPkg)).toBe(false);
    expect(r.exports.deleted).toBe(2);
    expect(readdirSync(exportsDir).filter((n) => n.endsWith('.zip'))).toHaveLength(1);
    // 원문·작업·의도·실행 기록 행은 그대로(export_runs 행도 이력으로 남김)
    expect(await protectedCounts(A.id)).toEqual(before);
    // 감사 기록(개수만)
    const audit = await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.ownerId, A.id), eq(schema.auditEvents.action, 'retention.sweep')));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.sanitizedDetails).toMatchObject({ job_events_deleted: evConfirmed, packages_deleted: 2, exports_deleted: 2 });
    // 멱등
    const again = await applyRetention(db, A.id, policy(1), exportsDir, { confirm: true, now: future() });
    expect(again).toEqual({
      jobEvents: { jobs: 0, deleted: 0, archive: null, archiveSha256: null, archiveBytes: 0 },
      packages: { deleted: 0, failed: 0, bytes: 0, errorCodes: [] },
      exports: { deleted: 0, failed: 0, bytes: 0, errorCodes: [] },
    });
  });

  it('트리거: 정리 표시 없이·끝나지 않은 작업의 이력은 DB 가 삭제를 거부한다', async () => {
    await expectDbReject(db.execute(sql`delete from job_events where job_id = ${confirmedB.jobId}::uuid`), /append_only_immutable/u);
    await expectDbReject(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('cs.retention_sweep', 'on', true)`);
        await tx.execute(sql`delete from job_events where job_id = ${blockedA.jobId}::uuid`);
      }),
      /append_only_immutable/u,
    );
    await expectDbReject(db.execute(sql`update job_events set state_after = 'X' where job_id = ${confirmedB.jobId}::uuid`), /append_only_immutable/u);
  });

  it('POST /api/ops/retention: dry_run → 200 미리보기, confirm 없음 → 400 confirm_required, 폼 confirm 없음 → /ops?error=confirm_required, confirm=yes → 200', async () => {
    const dry = await retentionPOST(jsonPost('/api/ops/retention', { dry_run: true }, cookieHeader(A.token)));
    expect(dry.status).toBe(200);
    expect(await dry.json()).toMatchObject({ dry_run: true, policy: { job_events_days: 180, packages_days: 30, exports_keep: 10 }, job_events: { jobs: 0 } });
    const bad = await retentionPOST(jsonPost('/api/ops/retention', { confirm: true }, cookieHeader(A.token)));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('confirm_required');
    const form = await retentionPOST(
      new Request(`${BASE}/api/ops/retention`, { method: 'POST', headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded', ...ORIGIN_HEADERS, ...cookieHeader(A.token) }, body: '' }),
    );
    expect(form.headers.get('location')).toBe('/ops?error=confirm_required');
    const ok = await retentionPOST(jsonPost('/api/ops/retention', { confirm: 'yes' }, cookieHeader(A.token)));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ dry_run: false, job_events: { deleted: 0 } });
  });
});

describe('/api/health ops', () => {
  it('숫자만(경로·ID 없음): 백업 나이·확인 필요 계획·반복 실패·삭제 대기·폴더 바이트(메모리 DB 는 null)', async () => {
    const res = await healthGET();
    const body = await res.json();
    expect(Object.keys(body.ops).sort()).toEqual(['attention_plans', 'backup_age_hours', 'disk', 'disk_partial', 'pending_deletes', 'repeated_failures']);
    expect(body.ops.disk_partial).toBe(false);
    expect(typeof body.ops.backup_age_hours).toBe('number');
    expect(body.ops.repeated_failures).toBe(1);
    expect(body.ops.pending_deletes).toBe(0);
    expect(body.ops.disk.db).toBeNull();
    expect(typeof body.ops.disk.assets).toBe('number');
    const text = JSON.stringify(body.ops);
    expect(text).not.toContain(tmp);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
  });
});

describe('FIX round 1 (Codex review-T20) P0 — 내보내기 보존은 실제로 있는 백업 기준', () => {
  it('keep=1, 최신 실행의 ZIP·폴더가 사라지고 이전 ZIP 만 남음 → 아무것도 지우지 않고, 파일 없는 기록은 따로 보고', async () => {
    const o = await newOwner('ops-p0');
    const older = await exportOwner(db, storage, o.id, { outDir: exportsDir, now: new Date(Date.now() - 3600_000) });
    const newer = await exportOwner(db, storage, o.id, { outDir: exportsDir });
    rmSync(newer.zipPath);
    rmSync(newer.dirPath, { recursive: true, force: true });
    const pol = { ...cfg(), RETENTION_EXPORT_RUNS_KEEP: 1 };
    const plan = await planRetention(db, o.id, pol, exportsDir);
    expect(plan.exports).toEqual([]);
    expect(plan.exportsMissingFile.map((m) => m.id)).toEqual([newer.exportId]);
    expect(plan.exportsExisting).toBe(1);
    const r = await applyRetention(db, o.id, pol, exportsDir, { confirm: true });
    expect(r.exports.deleted).toBe(0);
    expect(existsSync(older.zipPath)).toBe(true);
  });

  it('비어 있거나 크기가 기록과 다른 ZIP 은 백업으로 세지 않는다 — 남은 정상 백업이 keep 이하면 지우지 않음', async () => {
    const o = await newOwner('ops-p0b');
    const a = await exportOwner(db, storage, o.id, { outDir: exportsDir, now: new Date(Date.now() - 7200_000) });
    const b = await exportOwner(db, storage, o.id, { outDir: exportsDir, now: new Date(Date.now() - 3600_000) });
    const c = await exportOwner(db, storage, o.id, { outDir: exportsDir });
    writeFileSync(c.zipPath, ''); // 최신 ZIP 이 0 바이트(손상)
    const pol = { ...cfg(), RETENTION_EXPORT_RUNS_KEEP: 2 };
    const plan = await planRetention(db, o.id, pol, exportsDir);
    expect(plan.exportsExisting).toBe(2);
    expect(plan.exports).toEqual([]);
    expect(plan.exportsMissingFile.map((m) => m.id)).toEqual([c.exportId]);
    // keep=1 이면 정상 백업 2개 중 오래된 a 만 대상(손상된 c 는 지우지도 세지도 않음)
    const plan1 = await planRetention(db, o.id, { ...pol, RETENTION_EXPORT_RUNS_KEEP: 1 }, exportsDir);
    expect(plan1.exports.map((e) => e.id)).toEqual([a.exportId]);
    await applyRetention(db, o.id, { ...pol, RETENTION_EXPORT_RUNS_KEEP: 1 }, exportsDir, { confirm: true });
    expect(existsSync(a.zipPath)).toBe(false);
    expect(existsSync(b.zipPath)).toBe(true);
    expect(existsSync(c.zipPath)).toBe(true);
  });

  it('하한: 설정이 무엇이든 가장 최근의 정상 백업 ZIP 은 지우지 않는다', async () => {
    const o = await newOwner('ops-p0c');
    await exportOwner(db, storage, o.id, { outDir: exportsDir, now: new Date(Date.now() - 3600_000) });
    const newest = await exportOwner(db, storage, o.id, { outDir: exportsDir });
    const plan = await planRetention(db, o.id, { ...cfg(), RETENTION_EXPORT_RUNS_KEEP: 0 }, exportsDir);
    expect(plan.exports.map((e) => e.id)).not.toContain(newest.exportId);
    expect(plan.exports).toHaveLength(1);
  });
});

describe('FIX round 1 (Codex review-T20) P1 — 복원이 바꾸는 열도 기대값과 비교', () => {
  beforeAll(async () => {
    // usage_ledger 행(모의 AI 실행 — 금액 0 확정)을 하나 만든다
    await runAssist(db, A.id, confirmedA.contentId, { mode: 'draft', baseVersion: 1, brandProfileVersion: 1, answerIds: [] }, new MockLlmProvider());
  }, 60_000);

  it('기대값 비교로도 PASS(작업·항목·계획·승인·파생본·원장 열 전부)', async () => {
    const r = await runRestoreDrill(db, storage, A.id, { trigger: 'test', tmpRoot: tmp });
    expect(r.mismatches).toEqual([]);
    expect(r.result).toBe('pass');
    expect(r.tables.find((t) => t.table === 'usage_ledger')!.expected_rows).toBeGreaterThanOrEqual(1);
  }, 60_000);

  const corruptions: Array<[string, string, (owner: string) => ReturnType<typeof sql>]> = [
    ['jobs', 'state', (o) => sql`update jobs set state = 'FAILED' where owner_id = ${o}::uuid and state = 'CONFIRMED'`],
    ['jobs', 'lease_owner', (o) => sql`update jobs set lease_owner = 'x', lease_until = now() where owner_id = ${o}::uuid`],
    ['approvals', 'revoked_at', (o) => sql`update approvals set revoked_at = now(), revoke_reason = 'x' where owner_id = ${o}::uuid and revoked_at is null`],
    ['variants', 'lifecycle', (o) => sql`update variants set lifecycle = 'draft' where owner_id = ${o}::uuid and lifecycle = 'approved'`],
    ['distribution_items', 'status', (o) => sql`update distribution_items set status = 'FAILED' where owner_id = ${o}::uuid and status = 'CONFIRMED'`],
    ['distribution_plans', 'revision', (o) => sql`update distribution_plans set revision = revision + 5 where owner_id = ${o}::uuid`],
    ['usage_ledger', 'actual_amount', (o) => sql`update usage_ledger set actual_amount = 1.5 where owner_id = ${o}::uuid`],
  ];
  for (const [table, column, q] of corruptions) {
    it(`대상 DB 의 ${table}.${column} 만 바꾸면 FAIL — 열 이름이 mismatch_json 에 남는다`, async () => {
      const r = await runRestoreDrill(db, storage, A.id, {
        trigger: 'test',
        tmpRoot: tmp,
        afterRestore: async (target, owner) => {
          await target.execute(sql`set session_replication_role = replica`);
          await target.execute(q(owner));
          await target.execute(sql`set session_replication_role = origin`);
        },
      });
      expect(r.result).toBe('fail');
      const m = r.mismatches.find((x) => x.table === table);
      expect(m, JSON.stringify(r.mismatches)).toBeDefined();
      expect(m!.columns).toContain(column);
      const [row] = await db.select().from(schema.restoreDrills).where(eq(schema.restoreDrills.id, r.drillId));
      expect(JSON.stringify(row!.mismatchJson)).toContain(column);
    }, 60_000);
  }
});

describe('FIX round 1 (Codex review-T20) P1 — 준비·비교 중 예외도 FAIL 로 기록', () => {
  for (const at of ['export', 'compare'] as const) {
    it(`${at} 단계 예외 → restore_drills 에 fail + error_code, 임시 파일 정리, /ops 마지막 훈련이 FAIL`, async () => {
      const r = await runRestoreDrill(db, storage, A.id, { trigger: 'test', tmpRoot: tmp, faultInjection: at });
      expect(r.result).toBe('fail');
      expect(r.errorCode).toBe('injected_fault');
      const [row] = await db.select().from(schema.restoreDrills).where(eq(schema.restoreDrills.id, r.drillId));
      expect(row).toMatchObject({ result: 'fail', errorCode: 'injected_fault' });
      expect(readdirSync(tmp).filter((n) => n.startsWith('cs-restore-drill-'))).toEqual([]);
      expect((await opsSnapshot(db, A.id, cfg())).backup.lastDrill).toMatchObject({ id: r.drillId, result: 'fail', errorCode: 'injected_fault' });
    }, 60_000);
  }
  it('오류 코드는 정제된다(경로·메시지 없음)', () => {
    expect(drillErrorCode(Object.assign(new Error('C:\\secret\\path failed'), { code: 'ENOSPC' }))).toBe('ENOSPC');
    expect(drillErrorCode(new TypeError('/home/x/y bad'))).toBe('TypeError');
    expect(drillErrorCode(Object.assign(new Error('x'), { code: 'bad code/with path' }))).toBe('Error');
    expect(drillErrorCode('string thrown')).toBe('unknown_error');
  });
});

describe('FIX round 1 (Codex review-T20) P2 — 50개 상한은 전체 개수와 따로', () => {
  it('확인 필요 계획 51개 → total 51, 화면 목록 50, truncated; health 는 전체 개수', async () => {
    const o = await newOwner('ops-cap');
    await db.insert(schema.distributionPlans).values(Array.from({ length: 51 }, (_, k) => ({ ownerId: o.id, targetSummary: `계획 ${k}`, status: 'attention' })));
    const s = await opsSnapshot(db, o.id, cfg());
    expect(s.jobs.attentionPlans.total).toBe(51);
    expect(s.jobs.attentionPlans.items).toHaveLength(50);
    expect(s.jobs.attentionPlans.truncated).toBe(true);
    expect(s.jobs.attention).toMatchObject({ total: 0, items: [], truncated: false });
    expect(s.jobs.repeatedFailures).toMatchObject({ total: 0, items: [], truncated: false });
    const body = await (await healthGET()).json();
    expect(body.ops.attention_plans).toBeGreaterThanOrEqual(51);
    expect(typeof body.ops.disk_partial).toBe('boolean');
  });
});

describe('FIX round 2 (Codex 놓친 케이스) — 보존 정리', () => {
  const later = () => new Date(Date.now() + 200 * DAY);
  const pol = (keep = 1) => ({ ...cfg(), RETENTION_EXPORT_RUNS_KEEP: keep });
  const oldPackage = (owner: string, contentId: string) => {
    const dir = path.join(exportsDir, 'packages', owner, contentId);
    mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${randomUUID()}.zip`);
    writeFileSync(f, 'pkg');
    const t = new Date(Date.now() - 40 * DAY);
    utimesSync(f, t, t);
    return f;
  };
  const sweepAudits = async (owner: string) =>
    (await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.ownerId, owner), eq(schema.auditEvents.action, 'retention.sweep')))).map(
      (a) => a.sanitizedDetails as Record<string, unknown>,
    );

  it('동시 실행 두 번: 이력·파일을 두 번 보관·삭제하지 않고, 감사 합계 = 실제 삭제 수', async () => {
    const o = await newOwner('ops-conc');
    const d = await distribute(o, 'success');
    const events = await eventCount(d.jobId);
    expect(events).toBeGreaterThan(0);
    oldPackage(o.id, d.contentId);
    oldPackage(o.id, d.contentId);
    for (const k of [3, 2, 1]) await exportOwner(db, storage, o.id, { outDir: exportsDir, now: new Date(Date.now() - k * 3600_000) });
    const [r1, r2] = await Promise.all([
      applyRetention(db, o.id, pol(1), exportsDir, { confirm: true, now: later() }),
      applyRetention(db, o.id, pol(1), exportsDir, { confirm: true, now: later() }),
    ]);
    expect(r1.jobEvents.deleted + r2.jobEvents.deleted).toBe(events);
    expect(r1.packages.deleted + r2.packages.deleted).toBe(2);
    expect(r1.exports.deleted + r2.exports.deleted).toBe(2);
    expect(readdirSync(path.join(exportsDir, 'retention', o.id))).toHaveLength(1);
    const audits = await sweepAudits(o.id);
    expect(audits.reduce((n, a) => n + Number(a.job_events_deleted), 0)).toBe(events);
    expect(audits.reduce((n, a) => n + Number(a.packages_deleted), 0)).toBe(2);
    expect(audits.reduce((n, a) => n + Number(a.exports_deleted), 0)).toBe(2);
  });

  it('보관 파일 sha256 확인: 되읽은 내용이 다르면 삭제를 멈추고 이력은 그대로, 정상이면 감사에 sha256·바이트 수(경로·본문 없음)', async () => {
    const o = await newOwner('ops-sha');
    const d = await distribute(o, 'success');
    const events = await eventCount(d.jobId);
    await expect(
      applyRetention(db, o.id, pol(), exportsDir, {
        confirm: true,
        now: later(),
        fs: { readFile: async (f) => Buffer.concat([readFileSync(f), Buffer.from('x')]) },
      }),
    ).rejects.toMatchObject({ code: 'retention_archive_mismatch' });
    expect(await eventCount(d.jobId)).toBe(events);
    expect(await sweepAudits(o.id)).toEqual([]);
    // 같은 줄 수인데 내용만 바뀐 경우도 멈춘다
    await expect(
      applyRetention(db, o.id, pol(), exportsDir, {
        confirm: true,
        now: later(),
        fs: { readFile: async (f) => Buffer.from(readFileSync(f, 'utf8').replace(/"job_events"/u, '"job_eventz"')) },
      }),
    ).rejects.toMatchObject({ code: 'retention_archive_mismatch' });
    expect(await eventCount(d.jobId)).toBe(events);
    const r = await applyRetention(db, o.id, pol(), exportsDir, { confirm: true, now: later() });
    expect(r.jobEvents.deleted).toBe(events);
    const [a] = await sweepAudits(o.id);
    expect(a!.archive_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(Number(a!.archive_bytes)).toBeGreaterThan(0);
    const file = readdirSync(path.join(exportsDir, 'retention', o.id)).find((n) => {
      const b = readFileSync(path.join(exportsDir, 'retention', o.id, n));
      return createHash('sha256').update(b).digest('hex') === a!.archive_sha256;
    });
    expect(file).toBeDefined();
    expect(JSON.stringify(a)).not.toMatch(/[\\/]|state_after|sanitized_details/u);
  });

  it('파일 하나 삭제 실패(EACCES): 나머지는 지우고 실패 수·오류 코드만 결과·감사에 남기며, 다음 미리보기에 다시 나온다', async () => {
    const o = await newOwner('ops-unlink');
    const { content } = await createContent(db, o.id, { title: '배포 파일', body: BODY });
    const bad = oldPackage(o.id, content.id);
    oldPackage(o.id, content.id);
    oldPackage(o.id, content.id);
    const r = await applyRetention(db, o.id, pol(), exportsDir, {
      confirm: true,
      fs: {
        unlink: async (f) => {
          if (path.resolve(f) === path.resolve(bad)) throw Object.assign(new Error('denied C:\\x'), { code: 'EACCES' });
          rmSync(f);
        },
      },
    });
    expect(r.packages).toMatchObject({ deleted: 2, failed: 1, errorCodes: ['EACCES'] });
    expect(existsSync(bad)).toBe(true);
    const [a] = await sweepAudits(o.id);
    expect(a).toMatchObject({ packages_deleted: 2, packages_failed: 1, error_codes: 'EACCES' });
    const next = await planRetention(db, o.id, pol(), exportsDir);
    expect(next.packages.map((p) => p.id)).toEqual([path.basename(bad, '.zip')]);
  });

  describe('내보내기 파일 상태(ZIP 만 백업으로 센다)', () => {
    it('ZIP 은 있고 폴더가 없음 → 정상 백업으로 셈', async () => {
      const o = await newOwner('ops-zip');
      const a = await exportOwner(db, storage, o.id, { outDir: exportsDir, now: new Date(Date.now() - 3600_000) });
      const b = await exportOwner(db, storage, o.id, { outDir: exportsDir });
      rmSync(b.dirPath, { recursive: true, force: true });
      const plan = await planRetention(db, o.id, pol(1), exportsDir);
      expect(plan.exportsExisting).toBe(2);
      expect(plan.exports.map((e) => [e.id, e.kind])).toEqual([[a.exportId, 'zip']]);
      expect(plan.exportsMissingFile).toEqual([]);
    });
    it('폴더만 있고 ZIP 이 없음 → 세지 않음, 파일 없음 기록(폴더 있음)으로 보고, 더 최근 정상 백업이 있을 때만 폴더 정리 대상', async () => {
      const o = await newOwner('ops-dir');
      const old = await exportOwner(db, storage, o.id, { outDir: exportsDir, now: new Date(Date.now() - 7200_000) });
      const kept = await exportOwner(db, storage, o.id, { outDir: exportsDir, now: new Date(Date.now() - 3600_000) });
      const newest = await exportOwner(db, storage, o.id, { outDir: exportsDir });
      rmSync(old.zipPath);
      rmSync(newest.zipPath);
      const plan = await planRetention(db, o.id, pol(5), exportsDir);
      expect(plan.exportsExisting).toBe(1);
      expect(plan.exportsMissingFile.map((m) => [m.id, m.dirPresent]).sort()).toEqual(
        [
          [old.exportId, true],
          [newest.exportId, true],
        ].sort(),
      );
      // old 폴더는 더 최근 정상 백업(kept)보다 오래되어 정리 대상, newest 폴더는 kept 보다 최근이라 남긴다
      expect(plan.exports.map((e) => [e.id, e.kind])).toEqual([[old.exportId, 'dir_only']]);
      const r = await applyRetention(db, o.id, pol(5), exportsDir, { confirm: true });
      expect(r.exports).toMatchObject({ deleted: 1, failed: 0 });
      expect(existsSync(old.dirPath)).toBe(false);
      expect(existsSync(newest.dirPath)).toBe(true);
      expect(existsSync(kept.zipPath)).toBe(true);
    });
    it('모든 백업 ZIP 이 없음 → 아무것도 지우지 않고 전부 파일 없음 기록', async () => {
      const o = await newOwner('ops-none');
      const runs = [];
      for (const k of [2, 1, 0]) runs.push(await exportOwner(db, storage, o.id, { outDir: exportsDir, now: new Date(Date.now() - k * 3600_000) }));
      for (const r of runs) rmSync(r.zipPath);
      const plan = await planRetention(db, o.id, pol(1), exportsDir);
      expect(plan.exportsExisting).toBe(0);
      expect(plan.exports).toEqual([]);
      expect(plan.exportsMissingFile.map((m) => m.id).sort()).toEqual(runs.map((r) => r.exportId).sort());
      const r = await applyRetention(db, o.id, pol(1), exportsDir, { confirm: true });
      expect(r.exports).toMatchObject({ deleted: 0, failed: 0 });
      for (const x of runs) expect(existsSync(x.dirPath)).toBe(true);
    });
  });

  it('정리 직후 내보내기 → 빈 메모리 DB 복원: 이력을 지운 작업도 복원되고(restored_needs_review) 이력은 없다', async () => {
    const o = await newOwner('ops-after');
    const d = await distribute(o, 'success');
    const r = await applyRetention(db, o.id, pol(), exportsDir, { confirm: true, now: later() });
    expect(r.jobEvents.deleted).toBeGreaterThan(0);
    expect(await eventCount(d.jobId)).toBe(0);
    const ex = await exportOwner(db, storage, o.id, { outDir: exportsDir });
    const target = await createTestDb();
    try {
      const t = await ensureOwner(target.db, 'after-sweep@example.local');
      const zip = new Uint8Array(readFileSync(ex.zipPath));
      const restores = path.join(tmp, 'after-sweep-restores');
      const { restoreId } = await createRestorePreview(target.db, t.id, zip, { restoresDir: restores, source: 'upload' });
      await commitRestore(target.db, new LocalStorageAdapter(path.join(tmp, 'after-sweep-assets')), t.id, restoreId, {
        mode: 'empty_only',
        confirm: true,
        restoresDir: restores,
      });
      const [job] = await target.db.select().from(schema.jobs).where(eq(schema.jobs.id, d.jobId));
      expect(job).toMatchObject({ state: 'CONFIRMED', restoredNeedsReview: true, leaseOwner: null });
      expect(Number((await target.db.select({ n: count() }).from(schema.jobEvents).where(eq(schema.jobEvents.jobId, d.jobId)))[0]!.n)).toBe(0);
    } finally {
      await target.close();
    }
  });
});
