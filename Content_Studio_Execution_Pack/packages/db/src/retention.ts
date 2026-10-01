/**
 * T20(결정 D22) 로컬 보존 정리. 지울 수 있는 것은 정확히 셋(@cs/domain RETENTION_TARGETS):
 *  1. job_events — 끝난 작업(CONFIRMED·FAILED·CANCELED)이면서 **마지막 이력**이 RETENTION_JOB_EVENTS_DAYS 보다 오래된 작업의 이력 전체.
 *     지우기 전에 EXPORT_LOCAL_DIR/retention/<owner>/ 아래 JSONL 로 내보내고(쓴 줄 수 = 지울 행 수 확인), 같은 트랜잭션에서
 *     set_config('cs.retention_sweep','on', true) 로 0024 트리거의 예외를 켠 뒤 지운다. 진행 중·결과 불명·보류 작업의 이력은 건드리지 않는다.
 *  2. 배포 파일 ZIP(수동 게시용, 다시 만들 수 있음) — 파일 수정 시각이 RETENTION_PACKAGES_DAYS 보다 오래된 것.
 *  3. 내보내기 ZIP·폴더 — owner 마다 최근 RETENTION_EXPORT_RUNS_KEEP 개만 남긴다(export_runs 행은 이력으로 남긴다).
 * 원문 소재·출처·원고 버전·파생본·승인·결과 등 다른 표는 읽지도 지우지도 않는다. 업로드 세션(24시간)은 기존 worker 만료 정리(D15) 그대로.
 * 미리보기(planRetention)는 아무것도 바꾸지 않는다. 적용(applyRetention)은 confirm === true 일 때만. 같은 입력으로 두 번 돌리면 두 번째는 0건(멱등).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { AppError, cutoffDays, exportsToPrune, isUuid, packageExpired, TERMINAL_JOB_STATES, type AppConfig } from '@cs/domain';
import type { Db } from './client';
import { displayPath, exportZipPath } from './export';
import { packagesDir } from './packages';
import { recordAudit } from './queries';
import { exportRuns, jobEvents, jobs, users } from './schema';

export type RetentionPolicy = Pick<AppConfig, 'RETENTION_JOB_EVENTS_DAYS' | 'RETENTION_PACKAGES_DAYS' | 'RETENTION_EXPORT_RUNS_KEEP'>;

export interface RetentionPlan {
  policy: { jobEventsDays: number; packagesDays: number; exportsKeep: number };
  cutoffs: { jobEvents: Date; packages: Date };
  jobEvents: { jobs: number; events: number; jobIds: string[] };
  packages: Array<{ id: string; contentId: string | null; bytes: number; mtime: Date }>;
  exports: Array<{ id: string; createdAt: Date; zipBytes: number; filePresent: boolean }>;
}

async function eligibleJobIds(db: Db, ownerId: string, cutoff: Date): Promise<Array<{ id: string; n: number }>> {
  const rows = await db
    .select({ id: jobs.id, n: sql<number>`count(${jobEvents.id})::int`, last: sql<string>`max(${jobEvents.at})::text` })
    .from(jobs)
    .innerJoin(jobEvents, and(eq(jobEvents.jobId, jobs.id), eq(jobEvents.ownerId, jobs.ownerId)))
    .where(and(eq(jobs.ownerId, ownerId), inArray(jobs.state, [...TERMINAL_JOB_STATES])))
    .groupBy(jobs.id)
    .having(sql`max(${jobEvents.at}) < ${cutoff.toISOString()}::timestamptz`)
    .orderBy(asc(jobs.id));
  return rows.map((r) => ({ id: r.id, n: Number(r.n) }));
}

async function expiredPackages(exportsDir: string, ownerId: string, now: Date, days: number): Promise<RetentionPlan['packages']> {
  const base = packagesDir(exportsDir, ownerId);
  const out: RetentionPlan['packages'] = [];
  const scan = async (dir: string, contentId: string | null) => {
    let names: string[];
    try {
      names = await readdir(/*turbopackIgnore: true*/ dir);
    } catch {
      return;
    }
    for (const n of names) {
      const full = path.join(/*turbopackIgnore: true*/ dir, n);
      if (contentId === null && isUuid(n)) {
        await scan(full, n);
        continue;
      }
      const id = n.replace(/\.zip$/u, '');
      if (!n.endsWith('.zip') || !isUuid(id)) continue;
      const s = await stat(/*turbopackIgnore: true*/ full).catch(() => null);
      if (s?.isFile() && packageExpired(s.mtime, now, days)) out.push({ id, contentId, bytes: s.size, mtime: s.mtime });
    }
  };
  await scan(base, null);
  return out.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
}

async function exportsBeyondKeep(db: Db, exportsDir: string, ownerId: string, keep: number): Promise<RetentionPlan['exports']> {
  const runs = await db
    .select({ id: exportRuns.id, createdAt: exportRuns.createdAt, zipBytes: exportRuns.zipBytes })
    .from(exportRuns)
    .where(and(eq(exportRuns.ownerId, ownerId), eq(exportRuns.status, 'completed')))
    .orderBy(desc(exportRuns.createdAt), desc(exportRuns.id));
  const out: RetentionPlan['exports'] = [];
  for (const r of exportsToPrune(runs, keep)) {
    const zip = await stat(/*turbopackIgnore: true*/ exportZipPath(exportsDir, r.id)).catch(() => null);
    const dir = await stat(/*turbopackIgnore: true*/ path.join(exportsDir, r.id)).catch(() => null);
    const filePresent = Boolean(zip?.isFile() || dir?.isDirectory());
    if (filePresent) out.push({ id: r.id, createdAt: r.createdAt, zipBytes: r.zipBytes, filePresent });
  }
  return out;
}

/** 미리보기(dry-run): 무엇을 지울지 계산만 한다 — DB·파일 변화 없음. */
export async function planRetention(db: Db, ownerId: string, policy: RetentionPolicy, exportsDir: string, now: Date = new Date()): Promise<RetentionPlan> {
  const jobCut = cutoffDays(now, policy.RETENTION_JOB_EVENTS_DAYS);
  const eligible = await eligibleJobIds(db, ownerId, jobCut);
  return {
    policy: { jobEventsDays: policy.RETENTION_JOB_EVENTS_DAYS, packagesDays: policy.RETENTION_PACKAGES_DAYS, exportsKeep: policy.RETENTION_EXPORT_RUNS_KEEP },
    cutoffs: { jobEvents: jobCut, packages: cutoffDays(now, policy.RETENTION_PACKAGES_DAYS) },
    jobEvents: { jobs: eligible.length, events: eligible.reduce((a, b) => a + b.n, 0), jobIds: eligible.map((e) => e.id) },
    packages: await expiredPackages(exportsDir, ownerId, now, policy.RETENTION_PACKAGES_DAYS),
    exports: await exportsBeyondKeep(db, exportsDir, ownerId, policy.RETENTION_EXPORT_RUNS_KEEP),
  };
}

export interface RetentionResult {
  jobEvents: { jobs: number; deleted: number; archive: string | null };
  packages: { deleted: number; bytes: number };
  exports: { deleted: number; bytes: number };
}

export function retentionArchiveDir(exportsDir: string, ownerId: string): string {
  if (!isUuid(ownerId)) throw new Error('잘못된 owner');
  return path.join(exportsDir, 'retention', ownerId);
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');

/**
 * 적용. confirm 이 true 가 아니면 400 confirm_required. 이력은 내보낸 뒤에만 지운다 — 파일 쓰기·되읽기 확인이 실패하면 트랜잭션을 되돌린다.
 * 같은 트랜잭션에서 작업 행을 잠그고 대상(끝난 상태·마지막 이력이 기준보다 오래됨)을 다시 확인한다(미리보기와 적용 사이 변경 반영).
 */
export async function applyRetention(
  db: Db,
  ownerId: string,
  policy: RetentionPolicy,
  exportsDir: string,
  opts: { confirm: boolean; now?: Date; trigger?: 'ui' | 'api' | 'worker' },
): Promise<RetentionResult> {
  if (opts.confirm !== true) throw new AppError('bad_request', 'confirm_required', '보존 정리는 미리보기를 확인한 뒤 confirm=yes 로만 적용합니다');
  const now = opts.now ?? new Date();
  const plan = await planRetention(db, ownerId, policy, exportsDir, now);
  const result: RetentionResult = { jobEvents: { jobs: 0, deleted: 0, archive: null }, packages: { deleted: 0, bytes: 0 }, exports: { deleted: 0, bytes: 0 } };

  // 1. job_events: 내보낸 뒤 삭제(한 트랜잭션)
  if (plan.jobEvents.jobIds.length) {
    const cut = plan.cutoffs.jobEvents;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select id from jobs where owner_id = ${ownerId}::uuid and id in (${sql.join(plan.jobEvents.jobIds.map((id) => sql`${id}::uuid`), sql`, `)}) order by id for update`);
      const recheck = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .innerJoin(jobEvents, and(eq(jobEvents.jobId, jobs.id), eq(jobEvents.ownerId, jobs.ownerId)))
        .where(and(eq(jobs.ownerId, ownerId), inArray(jobs.id, plan.jobEvents.jobIds), inArray(jobs.state, [...TERMINAL_JOB_STATES])))
        .groupBy(jobs.id)
        .having(sql`max(${jobEvents.at}) < ${cut.toISOString()}::timestamptz`);
      const ids = recheck.map((r) => r.id);
      if (!ids.length) return;
      const rows = await tx
        .select()
        .from(jobEvents)
        .where(and(eq(jobEvents.ownerId, ownerId), inArray(jobEvents.jobId, ids)))
        .orderBy(asc(jobEvents.jobId), asc(jobEvents.eventSeq));
      const dir = retentionArchiveDir(exportsDir, ownerId);
      await mkdir(dir, { recursive: true });
      const file = path.join(/*turbopackIgnore: true*/ dir, `job-events-${stamp(now)}-${randomUUID().slice(0, 8)}.jsonl`);
      const body = rows
        .map((r) =>
          JSON.stringify({
            table: 'job_events',
            id: r.id,
            job_id: r.jobId,
            event_seq: r.eventSeq,
            state_before: r.stateBefore,
            state_after: r.stateAfter,
            at: r.at.toISOString(),
            sanitized_details: r.sanitizedDetails,
          }),
        )
        .join('\n');
      await writeFile(/*turbopackIgnore: true*/ file, `${body}\n`, { flag: 'wx' });
      const back = (await readFile(/*turbopackIgnore: true*/ file, 'utf8')).split('\n').filter(Boolean);
      if (back.length !== rows.length) throw new Error('보존 내보내기 파일을 확인하지 못해 이력을 지우지 않았습니다');
      await tx.execute(sql`select set_config('cs.retention_sweep', 'on', true)`);
      const del = await tx.delete(jobEvents).where(and(eq(jobEvents.ownerId, ownerId), inArray(jobEvents.jobId, ids))).returning({ id: jobEvents.id });
      await tx.execute(sql`select set_config('cs.retention_sweep', '', true)`);
      if (del.length !== rows.length) throw new Error('지운 행 수가 내보낸 행 수와 다릅니다');
      result.jobEvents = { jobs: ids.length, deleted: del.length, archive: displayPath(file) };
    });
  }

  // 2. 배포 파일
  for (const p of plan.packages) {
    const file = p.contentId
      ? path.join(/*turbopackIgnore: true*/ packagesDir(exportsDir, ownerId, p.contentId), `${p.id}.zip`)
      : path.join(/*turbopackIgnore: true*/ packagesDir(exportsDir, ownerId), `${p.id}.zip`);
    await rm(/*turbopackIgnore: true*/ file, { force: true });
    result.packages.deleted++;
    result.packages.bytes += p.bytes;
  }

  // 3. 내보내기 ZIP·폴더(오래된 것, 실행 기록은 남김)
  for (const e of plan.exports) {
    await rm(/*turbopackIgnore: true*/ exportZipPath(exportsDir, e.id), { force: true });
    await rm(/*turbopackIgnore: true*/ path.join(exportsDir, e.id), { recursive: true, force: true });
    result.exports.deleted++;
    result.exports.bytes += e.zipBytes;
  }

  if (result.jobEvents.deleted || result.packages.deleted || result.exports.deleted) {
    await recordAudit(db, {
      ownerId,
      action: 'retention.sweep',
      entity: 'retention',
      details: {
        trigger: opts.trigger ?? 'ui',
        job_events_deleted: result.jobEvents.deleted,
        job_event_jobs: result.jobEvents.jobs,
        archive_file: result.jobEvents.archive ? path.basename(result.jobEvents.archive) : null,
        packages_deleted: result.packages.deleted,
        exports_deleted: result.exports.deleted,
        job_events_days: plan.policy.jobEventsDays,
        packages_days: plan.policy.packagesDays,
        exports_keep: plan.policy.exportsKeep,
      },
      at: now,
    });
  }
  return result;
}

const globalForRetention = globalThis as typeof globalThis & { __csRetentionSweepAt?: number };
export const RETENTION_AUTO_INTERVAL_MS = 3600_000;

/** worker tick(RETENTION_SWEEP_MODE=auto): 한 시간에 한 번, 모든 owner 에 적용. manual 이면 아무것도 하지 않는다. */
export async function maybeAutoRetention(db: Db, config: AppConfig, exportsDir: string, now: Date = new Date()): Promise<RetentionResult[] | null> {
  if (config.RETENTION_SWEEP_MODE !== 'auto') return null;
  const last = globalForRetention.__csRetentionSweepAt ?? 0;
  if (now.getTime() - last < RETENTION_AUTO_INTERVAL_MS) return null;
  globalForRetention.__csRetentionSweepAt = now.getTime();
  const owners = await db.select({ id: users.id }).from(users).orderBy(asc(users.id));
  const out: RetentionResult[] = [];
  for (const o of owners) out.push(await applyRetention(db, o.id, config, exportsDir, { confirm: true, now, trigger: 'worker' }));
  return out;
}
