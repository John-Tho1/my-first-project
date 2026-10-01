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
  runRestoreDrill,
  schema,
  seed,
  setMockScenario,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { buildAssetKey, loadConfig, type AppConfig, type Channel } from '@cs/domain';
import { createMockAdapterRegistry, LocalStorageAdapter } from '@cs/providers';
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
    expect(s.jobs.attention.map((j) => [j.jobId, j.state, j.planId])).toEqual([[blockedA.jobId, 'BLOCKED', blockedA.planId]]);
    expect(s.jobs.repeatedFailures).toEqual([{ itemId: items[0]!.id, planId: plan.id, failures: 3 }]);
    expect(s.pendingDeletes.count).toBe(1);
    expect(s.pendingDeletes.oldestAt).toBeInstanceOf(Date);
    const attention = Number(
      (await db.select({ n: count() }).from(schema.distributionPlans).where(and(eq(schema.distributionPlans.ownerId, A.id), eq(schema.distributionPlans.status, 'attention'))))[0]!.n,
    );
    expect(s.jobs.attentionPlans).toHaveLength(attention);
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
    expect(again).toEqual({ jobEvents: { jobs: 0, deleted: 0, archive: null }, packages: { deleted: 0, bytes: 0 }, exports: { deleted: 0, bytes: 0 } });
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
    expect(Object.keys(body.ops).sort()).toEqual(['attention_plans', 'backup_age_hours', 'disk', 'pending_deletes', 'repeated_failures']);
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
