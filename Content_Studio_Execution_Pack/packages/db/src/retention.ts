/**
 * T20(결정 D22) 로컬 보존 정리. 지울 수 있는 것은 정확히 셋(@cs/domain RETENTION_TARGETS):
 *  1. job_events — 끝난 작업(CONFIRMED·FAILED·CANCELED)이면서 **마지막 이력**이 RETENTION_JOB_EVENTS_DAYS 보다 오래된 작업의 이력 전체.
 *     지우기 전에 EXPORT_LOCAL_DIR/retention/<owner>/ 아래 JSONL 로 내보내고(되읽은 내용의 sha256·바이트 수 = 쓴 내용 확인), 같은 트랜잭션에서
 *     set_config('cs.retention_sweep','on', true) 로 0024 트리거의 예외를 켠 뒤 지운다. 진행 중·결과 불명·보류 작업의 이력은 건드리지 않는다.
 *  2. 배포 파일 ZIP(수동 게시용, 다시 만들 수 있음) — 파일 수정 시각이 RETENTION_PACKAGES_DAYS 보다 오래된 것.
 *  3. 내보내기 — owner 마다 **ZIP 이 있는** 정상 백업 중 최근 RETENTION_EXPORT_RUNS_KEEP 개(하한 1)만 남긴다(export_runs 행은 이력으로 남긴다).
 *     ZIP 이 없거나 손상된 실행 기록은 세지 않는다(FIX round 1 P0). 폴더만 남은 기록(ZIP 없음)은 백업으로 세지 않으며,
 *     그보다 최근의 정상 백업이 남을 때만 폴더를 정리한다(FIX round 2 — 정상 백업이 하나도 없으면 폴더도 지우지 않는다).
 * 원문 소재·출처·원고 버전·파생본·승인·결과 등 다른 표는 읽지도 지우지도 않는다. 업로드 세션(24시간)은 기존 worker 만료 정리(D15) 그대로.
 * 미리보기(planRetention)는 아무것도 바꾸지 않는다. 적용(applyRetention)은 confirm === true 일 때만. 같은 입력으로 두 번 돌리면 두 번째는 0건(멱등).
 *
 * FIX round 2(Codex 놓친 케이스):
 *  - 동시 실행: 적용 전체(계획 다시 계산 → 이력 보관·삭제 → 파일 삭제 → 감사)를 한 트랜잭션 안에서 owner 별 advisory lock
 *    (pg_advisory_xact_lock(hashtext('cs.retention:<owner>')))을 잡고 한다. 같은 owner 의 두 번째 정리는 첫 번째가 끝난 뒤 계획을 다시 세우므로
 *    이미 지운 것을 다시 보관·삭제하거나 감사에 두 번 세지 않는다. 파일 삭제는 unlink 결과로 센다(이미 없던 파일 ENOENT 는 세지 않음).
 *  - 일부 파일 삭제 실패: 한 파일이 실패해도(EACCES 등) 나머지는 계속 지우고, 결과·감사에는 개수와 오류 코드만 남긴다. 남은 파일은 다음 미리보기에 다시 나온다.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { AppError, cutoffDays, exportsToPrune, isUuid, packageExpired, TERMINAL_JOB_STATES, type AppConfig } from '@cs/domain';
import type { Db } from './client';
import { displayPath, exportZipPath } from './export';
import { packagesDir } from './packages';
import { recordAudit, type DbOrTx } from './queries';
import { exportRuns, jobEvents, jobs, users } from './schema';

export type RetentionPolicy = Pick<AppConfig, 'RETENTION_JOB_EVENTS_DAYS' | 'RETENTION_PACKAGES_DAYS' | 'RETENTION_EXPORT_RUNS_KEEP'>;

export interface RetentionPlan {
  policy: { jobEventsDays: number; packagesDays: number; exportsKeep: number };
  cutoffs: { jobEvents: Date; packages: Date };
  jobEvents: { jobs: number; events: number; jobIds: string[] };
  packages: Array<{ id: string; contentId: string | null; bytes: number; mtime: Date }>;
  /**
   * 지울 내보내기: kind 'zip' = 최근 keep 개 밖의 정상 백업(ZIP + 폴더), 'dir_only' = ZIP 없이 폴더만 남은 기록 중
   * 남기는 가장 최근 정상 백업보다 오래된 것(폴더만 지운다, zipBytes 0).
   */
  exports: Array<{ id: string; createdAt: Date; zipBytes: number; filePresent: boolean; kind: 'zip' | 'dir_only' }>;
  /** 정상 백업(ZIP 이 있고 읽을 수 있고 크기가 기록과 같음) 수 — 보존 개수는 이것으로 센다 */
  exportsExisting: number;
  /** ZIP 없음·손상(0 바이트·크기 불일치) 기록 — 보존 개수에 세지 않는다. dirPresent = 풀어 둔 폴더는 남아 있음 */
  exportsMissingFile: Array<{ id: string; createdAt: Date; dirPresent: boolean }>;
}

async function eligibleJobIds(db: DbOrTx, ownerId: string, cutoff: Date): Promise<Array<{ id: string; n: number }>> {
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

/**
 * FIX round 1(Codex review-T20 P0): 보존 개수는 **실제로 쓸 수 있는 백업**만 센다 — ZIP 이 일반 파일로 있고, 읽을 수 있고, 0 바이트가 아니며,
 * 크기가 실행 기록의 zip_bytes 와 같음. 풀어 둔 폴더는 백업으로 세지 않는다(FIX round 2: ZIP 만 백업).
 */
async function usableBackup(exportsDir: string, run: { id: string; zipBytes: number }): Promise<boolean> {
  const file = exportZipPath(exportsDir, run.id);
  try {
    const s = await stat(/*turbopackIgnore: true*/ file);
    if (!s.isFile() || s.size <= 0 || s.size !== run.zipBytes) return false;
    await access(/*turbopackIgnore: true*/ file, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function dirPresent(dir: string): Promise<boolean> {
  return (await stat(/*turbopackIgnore: true*/ dir).catch(() => null))?.isDirectory() ?? false;
}

async function exportsBeyondKeep(
  db: DbOrTx,
  exportsDir: string,
  ownerId: string,
  keep: number,
): Promise<{ prune: RetentionPlan['exports']; existing: number; missing: RetentionPlan['exportsMissingFile'] }> {
  const runs = await db
    .select({ id: exportRuns.id, createdAt: exportRuns.createdAt, zipBytes: exportRuns.zipBytes })
    .from(exportRuns)
    .where(and(eq(exportRuns.ownerId, ownerId), eq(exportRuns.status, 'completed')))
    .orderBy(desc(exportRuns.createdAt), desc(exportRuns.id));
  const usable: typeof runs = [];
  const missing: RetentionPlan['exportsMissingFile'] = [];
  for (const r of runs) {
    if (await usableBackup(exportsDir, r)) usable.push(r);
    else missing.push({ id: r.id, createdAt: r.createdAt, dirPresent: await dirPresent(path.join(exportsDir, r.id)) });
  }
  const effectiveKeep = Math.max(1, keep);
  const prune: RetentionPlan['exports'] = exportsToPrune(usable, effectiveKeep).map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    zipBytes: r.zipBytes,
    filePresent: true,
    kind: 'zip' as const,
  }));
  // 폴더만 남은 기록: 남기는 정상 백업 중 가장 최근 것보다 오래되었을 때만 폴더 정리(정상 백업이 없으면 아무것도 지우지 않는다)
  const newestKept = usable[0];
  if (newestKept) {
    for (const m of missing) {
      if (m.dirPresent && m.createdAt.getTime() < newestKept.createdAt.getTime()) {
        prune.push({ id: m.id, createdAt: m.createdAt, zipBytes: 0, filePresent: true, kind: 'dir_only' });
      }
    }
  }
  return { prune, existing: usable.length, missing };
}

/** 미리보기(dry-run): 무엇을 지울지 계산만 한다 — DB·파일 변화 없음. */
export async function planRetention(db: DbOrTx, ownerId: string, policy: RetentionPolicy, exportsDir: string, now: Date = new Date()): Promise<RetentionPlan> {
  const jobCut = cutoffDays(now, policy.RETENTION_JOB_EVENTS_DAYS);
  const eligible = await eligibleJobIds(db, ownerId, jobCut);
  const ex = await exportsBeyondKeep(db, exportsDir, ownerId, policy.RETENTION_EXPORT_RUNS_KEEP);
  return {
    policy: { jobEventsDays: policy.RETENTION_JOB_EVENTS_DAYS, packagesDays: policy.RETENTION_PACKAGES_DAYS, exportsKeep: policy.RETENTION_EXPORT_RUNS_KEEP },
    cutoffs: { jobEvents: jobCut, packages: cutoffDays(now, policy.RETENTION_PACKAGES_DAYS) },
    jobEvents: { jobs: eligible.length, events: eligible.reduce((a, b) => a + b.n, 0), jobIds: eligible.map((e) => e.id) },
    packages: await expiredPackages(exportsDir, ownerId, now, policy.RETENTION_PACKAGES_DAYS),
    exports: ex.prune,
    exportsExisting: ex.existing,
    exportsMissingFile: ex.missing,
  };
}

export interface FileDeleteResult {
  deleted: number;
  /** 지우려 했지만 실패한 파일 수(남아 있음 — 다음 미리보기에 다시 나온다) */
  failed: number;
  bytes: number;
  /** 실패 오류 코드(정렬·중복 제거, 경로·메시지 없음) */
  errorCodes: string[];
}

export interface RetentionResult {
  jobEvents: { jobs: number; deleted: number; archive: string | null; archiveSha256: string | null; archiveBytes: number };
  packages: FileDeleteResult;
  exports: FileDeleteResult;
}

/** 시험에서 바꿔 끼우는 파일 연산(기본 node:fs/promises). */
export interface RetentionFs {
  readFile(file: string): Promise<Buffer>;
  unlink(file: string): Promise<void>;
  rmDir(dir: string): Promise<void>;
}

const nodeRetentionFs: RetentionFs = {
  readFile: (f) => readFile(/*turbopackIgnore: true*/ f),
  unlink: (f) => unlink(/*turbopackIgnore: true*/ f),
  rmDir: (d) => rm(/*turbopackIgnore: true*/ d, { recursive: true }),
};

export function retentionArchiveDir(exportsDir: string, ownerId: string): string {
  if (!isUuid(ownerId)) throw new Error('잘못된 owner');
  return path.join(exportsDir, 'retention', ownerId);
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z');
const SAFE_CODE = /^[A-Z0-9_]{1,32}$/u;
const fsCode = (e: unknown) => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && SAFE_CODE.test(c) ? c : 'UNKNOWN';
};

export class RetentionArchiveMismatchError extends Error {
  readonly code = 'retention_archive_mismatch';
  constructor() {
    super('보존 내보내기 파일을 되읽은 내용이 쓴 내용과 달라 이력을 지우지 않았습니다');
    this.name = 'RetentionArchiveMismatchError';
  }
}

/** 파일 하나 삭제: 지움 → 'deleted', 이미 없음(ENOENT) → 'absent', 그 밖 실패 → 오류 코드. */
async function removeOne(op: () => Promise<void>): Promise<'deleted' | 'absent' | { code: string }> {
  try {
    await op();
    return 'deleted';
  } catch (e) {
    return fsCode(e) === 'ENOENT' ? 'absent' : { code: fsCode(e) };
  }
}

const emptyFiles = (): FileDeleteResult => ({ deleted: 0, failed: 0, bytes: 0, errorCodes: [] });

/**
 * 적용. confirm 이 true 가 아니면 400 confirm_required. 이력은 내보낸 뒤에만 지운다 — 파일 쓰기·되읽기(sha256) 확인이 실패하면 트랜잭션을 되돌린다.
 * 전체가 owner 별 advisory lock 을 잡은 한 트랜잭션이다(동시 실행 직렬화). 그 안에서 계획을 다시 세우고 작업 행을 잠근 뒤 대상을 다시 확인한다.
 */
export async function applyRetention(
  db: Db,
  ownerId: string,
  policy: RetentionPolicy,
  exportsDir: string,
  opts: { confirm: boolean; now?: Date; trigger?: 'ui' | 'api' | 'worker'; fs?: Partial<RetentionFs> },
): Promise<RetentionResult> {
  if (opts.confirm !== true) throw new AppError('bad_request', 'confirm_required', '보존 정리는 미리보기를 확인한 뒤 confirm=yes 로만 적용합니다');
  if (!isUuid(ownerId)) throw new Error('잘못된 owner');
  const now = opts.now ?? new Date();
  const fs: RetentionFs = { ...nodeRetentionFs, ...opts.fs };
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cs.retention:${ownerId}`}))`);
    const plan = await planRetention(tx, ownerId, policy, exportsDir, now);
    const result: RetentionResult = {
      jobEvents: { jobs: 0, deleted: 0, archive: null, archiveSha256: null, archiveBytes: 0 },
      packages: emptyFiles(),
      exports: emptyFiles(),
    };

    // 1. job_events: 내보내고(sha256 확인) 지운다
    if (plan.jobEvents.jobIds.length) {
      const cut = plan.cutoffs.jobEvents;
      await tx.execute(
        sql`select id from jobs where owner_id = ${ownerId}::uuid and id in (${sql.join(plan.jobEvents.jobIds.map((id) => sql`${id}::uuid`), sql`, `)}) order by id for update`,
      );
      const recheck = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .innerJoin(jobEvents, and(eq(jobEvents.jobId, jobs.id), eq(jobEvents.ownerId, jobs.ownerId)))
        .where(and(eq(jobs.ownerId, ownerId), inArray(jobs.id, plan.jobEvents.jobIds), inArray(jobs.state, [...TERMINAL_JOB_STATES])))
        .groupBy(jobs.id)
        .having(sql`max(${jobEvents.at}) < ${cut.toISOString()}::timestamptz`);
      const ids = recheck.map((r) => r.id);
      if (ids.length) {
        const rows = await tx
          .select()
          .from(jobEvents)
          .where(and(eq(jobEvents.ownerId, ownerId), inArray(jobEvents.jobId, ids)))
          .orderBy(asc(jobEvents.jobId), asc(jobEvents.eventSeq));
        const dir = retentionArchiveDir(exportsDir, ownerId);
        await mkdir(dir, { recursive: true });
        const file = path.join(/*turbopackIgnore: true*/ dir, `job-events-${stamp(now)}-${randomUUID().slice(0, 8)}.jsonl`);
        const body = `${rows
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
          .join('\n')}\n`;
        const written = Buffer.from(body, 'utf8');
        const sha = createHash('sha256').update(written).digest('hex');
        await writeFile(/*turbopackIgnore: true*/ file, written, { flag: 'wx' });
        const back = await fs.readFile(file);
        const backSha = createHash('sha256').update(back).digest('hex');
        const lines = back.toString('utf8').split('\n').filter(Boolean).length;
        if (back.byteLength !== written.byteLength || backSha !== sha || lines !== rows.length) throw new RetentionArchiveMismatchError();
        await tx.execute(sql`select set_config('cs.retention_sweep', 'on', true)`);
        const del = await tx.delete(jobEvents).where(and(eq(jobEvents.ownerId, ownerId), inArray(jobEvents.jobId, ids))).returning({ id: jobEvents.id });
        await tx.execute(sql`select set_config('cs.retention_sweep', '', true)`);
        if (del.length !== rows.length) throw new Error('지운 행 수가 내보낸 행 수와 다릅니다');
        result.jobEvents = { jobs: ids.length, deleted: del.length, archive: displayPath(file), archiveSha256: sha, archiveBytes: written.byteLength };
      }
    }

    const tally = (r: FileDeleteResult, outcome: Awaited<ReturnType<typeof removeOne>>, bytes: number) => {
      if (outcome === 'deleted') {
        r.deleted++;
        r.bytes += bytes;
      } else if (outcome !== 'absent') {
        r.failed++;
        if (!r.errorCodes.includes(outcome.code)) r.errorCodes.push(outcome.code);
      }
    };

    // 2. 배포 파일 — 하나가 실패해도 나머지는 계속
    for (const p of plan.packages) {
      const file = p.contentId
        ? path.join(/*turbopackIgnore: true*/ packagesDir(exportsDir, ownerId, p.contentId), `${p.id}.zip`)
        : path.join(/*turbopackIgnore: true*/ packagesDir(exportsDir, ownerId), `${p.id}.zip`);
      tally(result.packages, await removeOne(() => fs.unlink(file)), p.bytes);
    }

    // 3. 내보내기(실행 기록은 남김). ZIP 을 먼저 지우고, 성공했거나 이미 없을 때만 폴더를 지운다.
    for (const e of plan.exports) {
      const dir = path.join(exportsDir, e.id);
      if (e.kind === 'zip') {
        const z = await removeOne(() => fs.unlink(exportZipPath(exportsDir, e.id)));
        if (z !== 'deleted' && z !== 'absent') {
          tally(result.exports, z, 0);
          continue;
        }
        const d = await removeOne(() => fs.rmDir(dir));
        tally(result.exports, d === 'absent' ? z : d === 'deleted' ? 'deleted' : d, e.zipBytes);
      } else {
        tally(result.exports, await removeOne(() => fs.rmDir(dir)), 0);
      }
    }
    result.packages.errorCodes.sort();
    result.exports.errorCodes.sort();

    const changed = result.jobEvents.deleted || result.packages.deleted || result.exports.deleted || result.packages.failed || result.exports.failed;
    if (changed) {
      await recordAudit(tx, {
        ownerId,
        action: 'retention.sweep',
        entity: 'retention',
        details: {
          trigger: opts.trigger ?? 'ui',
          job_events_deleted: result.jobEvents.deleted,
          job_event_jobs: result.jobEvents.jobs,
          archive_sha256: result.jobEvents.archiveSha256,
          archive_bytes: result.jobEvents.archiveBytes,
          packages_deleted: result.packages.deleted,
          packages_failed: result.packages.failed,
          exports_deleted: result.exports.deleted,
          exports_failed: result.exports.failed,
          error_codes: [...new Set([...result.packages.errorCodes, ...result.exports.errorCodes])].sort().join(',') || null,
          job_events_days: plan.policy.jobEventsDays,
          packages_days: plan.policy.packagesDays,
          exports_keep: plan.policy.exportsKeep,
        },
        at: now,
      });
    }
    return result;
  });
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
