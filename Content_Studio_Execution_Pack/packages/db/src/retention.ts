/**
 * T20(결정 D22) 로컬 보존 정리. 지울 수 있는 것은 정확히 셋(@cs/domain RETENTION_TARGETS):
 *  1. job_events — 끝난 작업(CONFIRMED·FAILED·CANCELED)이면서 **마지막 이력**이 RETENTION_JOB_EVENTS_DAYS 보다 오래된 작업의 이력 전체.
 *     지우기 전에 EXPORT_LOCAL_DIR/retention/<owner>/ 아래 JSONL 로 내보내고(되읽은 내용의 sha256·바이트 수 = 쓴 내용 확인), 같은 트랜잭션에서
 *     set_config('cs.retention_sweep','on', true) 로 0024 트리거의 예외를 켠 뒤 지운다. 진행 중·결과 불명·보류 작업의 이력은 건드리지 않는다.
 *  2. 배포 파일 ZIP(수동 게시용, 다시 만들 수 있음) — 파일 수정 시각이 RETENTION_PACKAGES_DAYS 보다 오래된 것.
 *  3. 내보내기 — owner 마다 **검증된** 백업 ZIP 중 최근 RETENTION_EXPORT_RUNS_KEEP 개(하한 1)만 남긴다(export_runs 행은 이력으로 남긴다).
 *
 * 내보내기 ZIP 상태(FIX round 3, Codex review-FIX-T20 P0 · review-FIX2-T20 P1):
 *  - verified: 크기 = zip_bytes 이고, ZIP 을 풀어 manifest·모든 항목 checksum·파일 checksum 을 검사(parseBundleZip)했으며, manifest sha256 =
 *    생성 때 export_runs 에 저장한 manifest_sha256. **이것만 보존 개수에 센다.** 크기가 같아도 내용이 손상되면 verified 가 아니다.
 *  - absent: ZIP 이 없음(ENOENT 확인). 풀어 둔 폴더만 남았으면 dir_only 정리 후보 — 남기는 검증된 백업 중 가장 최근 것보다 (createdAt, id) 순서로
 *    앞선(오래된) 것만.
 *  - damaged(0 바이트·크기 불일치·구조·checksum·manifest 불일치) / unreadable(EACCES 등): 세지 않고, ZIP·폴더 모두 **지우지 않고** 보고한다.
 *  - 검증된 백업이 keep 개보다 적으면 내보내기는 아무것도 지우지 않는다(폴더 포함).
 *
 * 적용 순서(FIX round 3, Codex FIX2 Q11·Q13 — 파일 삭제는 DB 롤백으로 되돌릴 수 없으므로):
 *  ① 한 트랜잭션(owner 별 advisory lock): 계획을 다시 세우고, 이력을 보관·삭제하고, 감사 retention.sweep(지운 이력 수 + 지울 파일 계획 수)을 남긴 뒤 커밋.
 *  ② 파일 삭제(트랜잭션 밖). 개수는 unlink·rm 결과로만 센다(이미 없던 파일 ENOENT 는 세지 않음 — 동시 정리가 같은 파일을 두 번 세지 않는다).
 *  ③ 감사 retention.files(실제 삭제·실패 수, 오류 코드). ③이 실패해도 ①의 계획 기록이 남아 "계획은 있는데 결과 기록이 없음"으로 보인다.
 * 원문 소재·출처·원고 버전·파생본·승인·결과 등 다른 표는 읽지도 지우지도 않는다. 업로드 세션(24시간)은 기존 worker 만료 정리(D15) 그대로.
 * 미리보기(planRetention)는 아무것도 바꾸지 않는다. 적용(applyRetention)은 confirm === true 일 때만. 같은 입력으로 두 번 돌리면 두 번째는 0건(멱등).
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { AppError, cutoffDays, isUuid, packageExpired, TERMINAL_JOB_STATES, type AppConfig } from '@cs/domain';
import type { Db } from './client';
import { displayPath, exportZipPath } from './export';
import { packagesDir } from './packages';
import { recordAudit, type DbOrTx } from './queries';
import { parseBundleZip } from './restore';
import { exportRuns, jobEvents, jobs, users } from './schema';

export type RetentionPolicy = Pick<AppConfig, 'RETENTION_JOB_EVENTS_DAYS' | 'RETENTION_PACKAGES_DAYS' | 'RETENTION_EXPORT_RUNS_KEEP'>;

export type ZipState = 'verified' | 'absent' | 'damaged' | 'unreadable';

export interface RetentionPlan {
  policy: { jobEventsDays: number; packagesDays: number; exportsKeep: number };
  cutoffs: { jobEvents: Date; packages: Date };
  jobEvents: { jobs: number; events: number; jobIds: string[] };
  packages: Array<{ id: string; contentId: string | null; bytes: number; mtime: Date }>;
  /**
   * 지울 내보내기: kind 'zip' = 최근 keep 개 밖의 검증된 백업(ZIP + 폴더), 'dir_only' = ZIP 이 없고(ENOENT) 폴더만 남은 기록 중
   * 남기는 가장 최근 검증된 백업보다 오래된 것(폴더만 지운다, zipBytes 0).
   */
  exports: Array<{ id: string; createdAt: Date; zipBytes: number; filePresent: boolean; kind: 'zip' | 'dir_only' }>;
  /** 검증된 백업 수 — 보존 개수는 이것으로 센다 */
  exportsExisting: number;
  /** 검증되지 않은 기록(ZIP 없음·손상·읽기 실패) — 보존 개수에 세지 않는다. dirPresent = 풀어 둔 폴더는 남아 있음 */
  exportsMissingFile: Array<{ id: string; createdAt: Date; dirPresent: boolean; zipState: Exclude<ZipState, 'verified'> }>;
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

const errCode = (e: unknown) => String((e as { code?: unknown } | null)?.code ?? '');

/** 시험에서 바꿔 끼우는 ZIP 읽기(기본 node:fs/promises). */
export interface ZipFs {
  stat(file: string): Promise<{ isFile(): boolean; size: number; mtimeMs: number }>;
  readFile(file: string): Promise<Uint8Array>;
}
const nodeZipFs: ZipFs = {
  stat: (f) => stat(/*turbopackIgnore: true*/ f),
  readFile: async (f) => new Uint8Array(await readFile(/*turbopackIgnore: true*/ f)),
};

const globalForZip = globalThis as typeof globalThis & { __csZipVerify?: Map<string, ZipState> };
/** 검증 결과 캐시(같은 실행·같은 크기·같은 수정 시각이면 다시 풀지 않는다 — /ops 미리보기가 렌더마다 ZIP 을 다 읽지 않게). */
const verifyCache = () => (globalForZip.__csZipVerify ??= new Map());

/**
 * ZIP 상태 판정. verified = 크기 일치 + parseBundleZip(구조·manifest·항목 checksum·파일 checksum) 통과 + manifest sha256 = 생성 때 기록한 값.
 * 크기 일치는 무결성 검사가 아니다(같은 길이로 손상된 ZIP 을 걸러낸다).
 */
export async function zipState(exportsDir: string, run: { id: string; zipBytes: number; manifestSha256: string }, fs: ZipFs = nodeZipFs): Promise<ZipState> {
  const file = exportZipPath(exportsDir, run.id);
  let s: { isFile(): boolean; size: number; mtimeMs: number };
  try {
    s = await fs.stat(file);
  } catch (e) {
    return errCode(e) === 'ENOENT' ? 'absent' : 'unreadable';
  }
  if (!s.isFile() || s.size <= 0 || s.size !== run.zipBytes) return 'damaged';
  const key = `${run.id}:${s.size}:${s.mtimeMs}:${run.manifestSha256}`;
  const cached = fs === nodeZipFs ? verifyCache().get(key) : undefined;
  if (cached) return cached;
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(file);
  } catch (e) {
    return errCode(e) === 'ENOENT' ? 'absent' : 'unreadable';
  }
  let state: ZipState;
  try {
    const parsed = await parseBundleZip(bytes);
    state = parsed.manifestSha256 === run.manifestSha256 ? 'verified' : 'damaged';
  } catch {
    state = 'damaged';
  }
  if (fs === nodeZipFs) verifyCache().set(key, state);
  return state;
}

async function dirPresent(dir: string): Promise<boolean> {
  return (await stat(/*turbopackIgnore: true*/ dir).catch(() => null))?.isDirectory() ?? false;
}

/** (createdAt, id) 내림차순 비교 — 같은 시각의 실행도 안정적으로 정렬한다. a 가 b 보다 오래되었으면 true. */
const olderThan = (a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }) =>
  a.createdAt.getTime() < b.createdAt.getTime() || (a.createdAt.getTime() === b.createdAt.getTime() && a.id < b.id);

async function exportsBeyondKeep(
  db: DbOrTx,
  exportsDir: string,
  ownerId: string,
  keep: number,
  fs?: ZipFs,
): Promise<{ prune: RetentionPlan['exports']; existing: number; missing: RetentionPlan['exportsMissingFile'] }> {
  const runs = await db
    .select({ id: exportRuns.id, createdAt: exportRuns.createdAt, zipBytes: exportRuns.zipBytes, manifestSha256: exportRuns.manifestSha256 })
    .from(exportRuns)
    .where(and(eq(exportRuns.ownerId, ownerId), eq(exportRuns.status, 'completed')))
    .orderBy(desc(exportRuns.createdAt), desc(exportRuns.id));
  const verified: typeof runs = [];
  const missing: RetentionPlan['exportsMissingFile'] = [];
  for (const r of runs) {
    const st = await zipState(exportsDir, r, fs);
    if (st === 'verified') verified.push(r);
    else missing.push({ id: r.id, createdAt: r.createdAt, dirPresent: await dirPresent(path.join(exportsDir, r.id)), zipState: st });
  }
  const effectiveKeep = Math.max(1, keep);
  // 검증된 백업이 keep 보다 적으면 내보내기는 아무것도 지우지 않는다
  if (verified.length < effectiveKeep) return { prune: [], existing: verified.length, missing };
  const prune: RetentionPlan['exports'] = verified.slice(effectiveKeep).map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    zipBytes: r.zipBytes,
    filePresent: true,
    kind: 'zip' as const,
  }));
  const newestKept = verified[0]!;
  for (const m of missing) {
    // ZIP 이 없다고 확인된(absent) 기록의 폴더만. 손상·읽기 실패 ZIP 의 폴더는 마지막으로 읽을 수 있는 사본일 수 있어 남긴다.
    if (m.zipState === 'absent' && m.dirPresent && olderThan(m, newestKept)) {
      prune.push({ id: m.id, createdAt: m.createdAt, zipBytes: 0, filePresent: true, kind: 'dir_only' });
    }
  }
  return { prune, existing: verified.length, missing };
}

/** 미리보기(dry-run): 무엇을 지울지 계산만 한다 — DB·파일 변화 없음. */
export async function planRetention(
  db: DbOrTx,
  ownerId: string,
  policy: RetentionPolicy,
  exportsDir: string,
  now: Date = new Date(),
  opts: { zipFs?: ZipFs } = {},
): Promise<RetentionPlan> {
  const jobCut = cutoffDays(now, policy.RETENTION_JOB_EVENTS_DAYS);
  const eligible = await eligibleJobIds(db, ownerId, jobCut);
  const ex = await exportsBeyondKeep(db, exportsDir, ownerId, policy.RETENTION_EXPORT_RUNS_KEEP, opts.zipFs);
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

/** 내보내기: ZIP 삭제(deleted·failed·bytes)와 폴더 정리(dirsDeleted·dirsFailed)를 따로 센다(FIX round 3, review-FIX2-T20 P2). */
export interface ExportDeleteResult extends FileDeleteResult {
  dirsDeleted: number;
  dirsFailed: number;
}

export interface RetentionResult {
  jobEvents: { jobs: number; deleted: number; archive: string | null; archiveSha256: string | null; archiveBytes: number };
  packages: FileDeleteResult;
  exports: ExportDeleteResult;
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
  rmDir: async (d) => {
    // 이미 없는 폴더는 ENOENT 로 알린다(rm 은 force 없이 ENOENT 를 던진다)
    await rm(/*turbopackIgnore: true*/ d, { recursive: true });
  },
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

const addCode = (codes: string[], c: string) => {
  if (!codes.includes(c)) codes.push(c);
};

/** 남은 파일을 fsync 해 보관 파일이 디스크에 닿은 뒤에 이력을 지운다. */
async function syncFile(file: string): Promise<void> {
  // Windows 는 읽기 전용 핸들의 fsync 를 거부(EPERM)하므로 r+ 로 연다(내용은 바꾸지 않음)
  const fh = await open(/*turbopackIgnore: true*/ file, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * 적용. confirm 이 true 가 아니면 400 confirm_required.
 * ① 트랜잭션(owner advisory lock): 계획 → 작업 행 잠금·재확인 → 보관(fsync·sha256 되읽기 확인) → 이력 삭제 → 감사 retention.sweep(계획 포함) → 커밋.
 * ② 파일 삭제(트랜잭션 밖, 하나 실패해도 계속). ③ 감사 retention.files(실제 결과).
 */
type ApplyOpts = { confirm: boolean; now?: Date; trigger?: 'ui' | 'api' | 'worker'; fs?: Partial<RetentionFs>; zipFs?: ZipFs };

const globalForSweep = globalThis as typeof globalThis & { __csRetentionLocks?: Map<string, Promise<unknown>> };

/**
 * 같은 프로세스 안의 같은 owner 정리는 끝까지(① DB 단계 + ② 파일 삭제 + ③ 결과 기록) 차례로 실행한다.
 * ① 은 DB advisory lock 으로도 직렬화되지만 ② 는 트랜잭션 밖이라, 두 정리가 같은 파일을 겹쳐 지우면 삭제를 두 번 셀 수 있다(시험에서 내보내기
 * 삭제 합계 3/2 로 관찰 — 원인은 동시 unlink·검증 경합으로 추정) — 프로세스 안 잠금으로 막는다. 다른 프로세스(PostgreSQL 다중 worker)의 ② 동시 실행은 남은 위험(인계 문서).
 */
export async function applyRetention(db: Db, ownerId: string, policy: RetentionPolicy, exportsDir: string, opts: ApplyOpts): Promise<RetentionResult> {
  if (opts.confirm !== true) throw new AppError('bad_request', 'confirm_required', '보존 정리는 미리보기를 확인한 뒤 confirm=yes 로만 적용합니다');
  if (!isUuid(ownerId)) throw new Error('잘못된 owner');
  const locks = (globalForSweep.__csRetentionLocks ??= new Map());
  const prev = locks.get(ownerId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => applyRetentionLocked(db, ownerId, policy, exportsDir, opts));
  const tail = run.catch(() => undefined);
  locks.set(ownerId, tail);
  try {
    return await run;
  } finally {
    if (locks.get(ownerId) === tail) locks.delete(ownerId);
  }
}

async function applyRetentionLocked(db: Db, ownerId: string, policy: RetentionPolicy, exportsDir: string, opts: ApplyOpts): Promise<RetentionResult> {
  const now = opts.now ?? new Date();
  const fs: RetentionFs = { ...nodeRetentionFs, ...opts.fs };
  const result: RetentionResult = {
    jobEvents: { jobs: 0, deleted: 0, archive: null, archiveSha256: null, archiveBytes: 0 },
    packages: { deleted: 0, failed: 0, bytes: 0, errorCodes: [] },
    exports: { deleted: 0, failed: 0, bytes: 0, errorCodes: [], dirsDeleted: 0, dirsFailed: 0 },
  };

  // ① DB 단계(계획 기록 포함) — 커밋된 뒤에만 파일을 지운다
  const plan = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cs.retention:${ownerId}`}))`);
    const p = await planRetention(tx, ownerId, policy, exportsDir, now, { zipFs: opts.zipFs });
    if (p.jobEvents.jobIds.length) {
      const cut = p.cutoffs.jobEvents;
      await tx.execute(
        sql`select id from jobs where owner_id = ${ownerId}::uuid and id in (${sql.join(p.jobEvents.jobIds.map((id) => sql`${id}::uuid`), sql`, `)}) order by id for update`,
      );
      const recheck = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .innerJoin(jobEvents, and(eq(jobEvents.jobId, jobs.id), eq(jobEvents.ownerId, jobs.ownerId)))
        .where(and(eq(jobs.ownerId, ownerId), inArray(jobs.id, p.jobEvents.jobIds), inArray(jobs.state, [...TERMINAL_JOB_STATES])))
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
        await syncFile(file);
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
    const plannedZips = p.exports.filter((e) => e.kind === 'zip').length;
    const plannedDirs = p.exports.filter((e) => e.kind === 'dir_only').length;
    if (result.jobEvents.deleted || p.packages.length || p.exports.length) {
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
          planned_packages: p.packages.length,
          planned_export_zips: plannedZips,
          planned_export_dirs: plannedDirs,
          job_events_days: p.policy.jobEventsDays,
          packages_days: p.policy.packagesDays,
          exports_keep: p.policy.exportsKeep,
        },
        at: now,
      });
    }
    return p;
  });

  // ② 파일 삭제 — 하나가 실패해도 나머지는 계속, 개수는 실제 결과로만
  for (const p of plan.packages) {
    const file = p.contentId
      ? path.join(/*turbopackIgnore: true*/ packagesDir(exportsDir, ownerId, p.contentId), `${p.id}.zip`)
      : path.join(/*turbopackIgnore: true*/ packagesDir(exportsDir, ownerId), `${p.id}.zip`);
    const r = await removeOne(() => fs.unlink(file));
    if (r === 'deleted') {
      result.packages.deleted++;
      result.packages.bytes += p.bytes;
    } else if (r !== 'absent') {
      result.packages.failed++;
      addCode(result.packages.errorCodes, r.code);
    }
  }
  for (const e of plan.exports) {
    const dir = path.join(exportsDir, e.id);
    if (e.kind === 'zip') {
      const z = await removeOne(() => fs.unlink(exportZipPath(exportsDir, e.id)));
      if (z === 'deleted') {
        result.exports.deleted++;
        result.exports.bytes += e.zipBytes;
      } else if (z !== 'absent') {
        result.exports.failed++;
        addCode(result.exports.errorCodes, z.code);
        continue; // ZIP 을 못 지웠으면 폴더도 그대로
      }
    }
    const d = await removeOne(() => fs.rmDir(dir));
    if (d === 'deleted') result.exports.dirsDeleted++;
    else if (d !== 'absent') {
      result.exports.dirsFailed++;
      addCode(result.exports.errorCodes, d.code);
    }
  }
  result.packages.errorCodes.sort();
  result.exports.errorCodes.sort();

  // ③ 실제 결과 기록
  const touched =
    result.packages.deleted + result.packages.failed + result.exports.deleted + result.exports.failed + result.exports.dirsDeleted + result.exports.dirsFailed;
  if (touched > 0) {
    await recordAudit(db, {
      ownerId,
      action: 'retention.files',
      entity: 'retention',
      details: {
        trigger: opts.trigger ?? 'ui',
        packages_deleted: result.packages.deleted,
        packages_failed: result.packages.failed,
        packages_bytes: result.packages.bytes,
        exports_deleted: result.exports.deleted,
        exports_failed: result.exports.failed,
        exports_bytes: result.exports.bytes,
        export_dirs_deleted: result.exports.dirsDeleted,
        export_dirs_failed: result.exports.dirsFailed,
        error_codes: [...new Set([...result.packages.errorCodes, ...result.exports.errorCodes])].sort().join(',') || null,
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
