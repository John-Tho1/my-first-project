/**
 * T20(결정 D22) 운영 화면(/ops)·/api/health 의 숫자. 모두 DB 행·파일 시스템에서 센다 — 원천이 없으면 null("측정 없음").
 * 경로는 응답·화면에 내보내지 않는다(바이트·개수만). 외부 호출 없음.
 */
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { ageHours, backupState, budgetPolicy, cutoffDays, type AppConfig, type BackupState } from '@cs/domain';
import { monthlyUsage, type CurrencyUsage } from './budget';
import type { Db } from './client';
import type { DbOrTx } from './queries';
import { resolveFromRoot } from './paths';
import { latestRestoreDrill, type RestoreDrillRow } from './restore-drill';
import { assets, auditEvents, distributionItems, distributionPlans, exportRuns, jobs, sendIntents, uploadSessions, variants } from './schema';

// ---- 파일 용량 ----

export interface DirUsage {
  /** 폴더가 있는가 */
  present: boolean;
  /** 센 바이트. status 가 partial 이면 하한값, unavailable 이면 쓰지 않는다 */
  bytes: number;
  files: number;
  /** complete = 모두 셈, partial = 일부 읽기 실패·항목 상한(하한값), unavailable = 폴더 없음·맨 위 폴더를 못 읽음(측정 불가) */
  status: 'complete' | 'partial' | 'unavailable';
  /** 읽기 실패 수(폴더·파일) */
  errors: number;
  /** 항목이 너무 많아 세다가 멈췄는가(status = partial) */
  truncated: boolean;
  /** 측정 중 하위 폴더가 사라졌는가(status = partial — 한 시점의 정확한 값이 아님) */
  changedDuringScan: boolean;
}

export const DIR_SCAN_MAX_ENTRIES = 50_000;

/** 시험에서 바꿔 끼우는 파일 시스템 부분(node:fs/promises 와 같은 모양). */
export interface DirFs {
  lstat(p: string): Promise<import('node:fs').Stats>;
  readdir(p: string, opts: { withFileTypes: true }): Promise<import('node:fs').Dirent[]>;
}

const nodeFs: DirFs = {
  lstat: (p) => lstat(/*turbopackIgnore: true*/ p),
  readdir: (p, o) => readdir(/*turbopackIgnore: true*/ p, o),
};

const errCode = (e: unknown) => String((e as { code?: unknown } | null)?.code ?? '');

/**
 * 폴더 아래 일반 파일 바이트·개수(심볼릭 링크는 따라가지 않음). excludeTop: 맨 위 단계에서 건너뛸 이름.
 * FIX round 1(Codex review-T20 P2): 읽기 실패를 완전한 측정값처럼 돌려주지 않는다 — 하위 폴더·파일 실패는 partial(하한값),
 * 맨 위 폴더를 못 읽으면 unavailable. 세는 사이 지워진 파일(ENOENT)은 실패로 세지 않는다.
 */
export async function dirUsage(dir: string, opts: { excludeTop?: readonly string[]; maxEntries?: number; fs?: DirFs } = {}): Promise<DirUsage> {
  const fs = opts.fs ?? nodeFs;
  const max = opts.maxEntries ?? DIR_SCAN_MAX_ENTRIES;
  const out: DirUsage = { present: false, bytes: 0, files: 0, status: 'unavailable', errors: 0, truncated: false, changedDuringScan: false };
  try {
    if (!(await fs.lstat(dir)).isDirectory()) return out;
  } catch (e) {
    if (errCode(e) !== 'ENOENT') out.errors++;
    return out;
  }
  out.present = true;
  let seen = 0;
  const stack: Array<{ d: string; top: boolean }> = [{ d: dir, top: true }];
  while (stack.length) {
    const { d, top } = stack.pop()!;
    let names: import('node:fs').Dirent[];
    try {
      names = await fs.readdir(d, { withFileTypes: true });
    } catch (e) {
      if (top) {
        out.errors++;
        out.status = 'unavailable';
        return out;
      }
      // FIX round 3(Codex Q10): 하위 폴더가 측정 중 사라진 것은 접근 실패는 아니지만 완전한 측정도 아니다
      if (errCode(e) === 'ENOENT') out.changedDuringScan = true;
      else out.errors++;
      continue;
    }
    for (const n of names) {
      if (++seen > max) {
        out.truncated = true;
        out.status = 'partial';
        return out;
      }
      if (top && opts.excludeTop?.includes(n.name)) continue;
      const full = path.join(/*turbopackIgnore: true*/ d, n.name);
      if (n.isDirectory()) stack.push({ d: full, top: false });
      else if (n.isFile()) {
        try {
          out.bytes += (await fs.lstat(full)).size;
          out.files++;
        } catch (e) {
          if (errCode(e) !== 'ENOENT') out.errors++;
        }
      }
    }
  }
  out.status = out.errors > 0 || out.changedDuringScan ? 'partial' : 'complete';
  return out;
}

export interface DiskUsage {
  /** 측정 시각 */
  measuredAt: Date;
  /** PGlite 데이터 폴더(메모리 DB 면 null) */
  db: DirUsage | null;
  /** 저장소(STORAGE_LOCAL_DIR, uploads 제외) */
  assets: DirUsage;
  /** 업로드 조각(STORAGE_LOCAL_DIR/uploads) */
  uploads: DirUsage;
  /** 내보내기 ZIP·폴더(EXPORT_LOCAL_DIR, packages·retention 제외) */
  exports: DirUsage;
  packages: DirUsage;
  retention: DirUsage;
}

export async function diskUsage(config: Pick<AppConfig, 'DATABASE_URL' | 'STORAGE_LOCAL_DIR' | 'EXPORT_LOCAL_DIR'>): Promise<DiskUsage> {
  const storage = resolveFromRoot(config.STORAGE_LOCAL_DIR);
  const exportsDir = resolveFromRoot(config.EXPORT_LOCAL_DIR);
  return {
    measuredAt: new Date(),
    db: config.DATABASE_URL === 'memory://' ? null : await dirUsage(resolveFromRoot(config.DATABASE_URL)),
    assets: await dirUsage(storage, { excludeTop: ['uploads'] }),
    uploads: await dirUsage(path.join(/*turbopackIgnore: true*/ storage, 'uploads')),
    exports: await dirUsage(exportsDir, { excludeTop: ['packages', 'retention'] }),
    packages: await dirUsage(path.join(/*turbopackIgnore: true*/ exportsDir, 'packages')),
    retention: await dirUsage(path.join(/*turbopackIgnore: true*/ exportsDir, 'retention')),
  };
}

const globalForOps = globalThis as typeof globalThis & {
  __csDiskCache?: { key: string; value: Promise<DiskUsage>; settledAt: number | null };
};
export const DISK_CACHE_MS = 60_000;

/**
 * /ops·/api/ops/summary 공용: 같은 설정이면 60초 동안 측정값을 다시 쓰고, 측정 중이면 그 Promise 를 같이 기다린다(동시 요청이 폴더를 중복으로 걷지 않게).
 * 측정이 실패하면 캐시에 남기지 않는다.
 */
export function cachedDiskUsage(
  config: Pick<AppConfig, 'DATABASE_URL' | 'STORAGE_LOCAL_DIR' | 'EXPORT_LOCAL_DIR'>,
  nowMs = Date.now(),
  measure: (c: Pick<AppConfig, 'DATABASE_URL' | 'STORAGE_LOCAL_DIR' | 'EXPORT_LOCAL_DIR'>) => Promise<DiskUsage> = diskUsage,
  clock: () => number = Date.now,
): Promise<DiskUsage> {
  const key = `${config.DATABASE_URL}|${config.STORAGE_LOCAL_DIR}|${config.EXPORT_LOCAL_DIR}`;
  const c = globalForOps.__csDiskCache;
  // FIX round 3(Codex review-FIX-T20 P2): 측정 중이면 TTL 과 무관하게 같은 Promise 를 기다리고, TTL 은 끝난 결과에만 적용한다
  if (c && c.key === key && (c.settledAt === null || nowMs - c.settledAt < DISK_CACHE_MS)) return c.value;
  const value = measure(config);
  const entry: { key: string; value: Promise<DiskUsage>; settledAt: number | null } = { key, value, settledAt: null };
  globalForOps.__csDiskCache = entry;
  value.then(
    () => {
      entry.settledAt = clock();
    },
    () => {
      if (globalForOps.__csDiskCache === entry) globalForOps.__csDiskCache = undefined;
    },
  );
  return value;
}

/**
 * 결과가 partial(일부만 처리 — 내보내기 중단·실패·남긴 후보)인 정리 실행(최근 것부터)과 전체 수. 뒤의 complete 실행이 가리지 않는다(FIX round 6).
 */
export async function partialRetentionSweeps(
  db: DbOrTx,
  ownerId: string,
  limit = 5,
): Promise<{ total: number; items: Array<{ sweepId: string | null; at: Date }> }> {
  const where = sql`f.owner_id = ${ownerId}::uuid and f.action = 'retention.files' and f.sanitized_details->>'outcome' = 'partial'`;
  const c = await db.execute(sql`select count(*)::int as n from audit_events f where ${where}`);
  const total = Number((c as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0);
  if (!total) return { total: 0, items: [] };
  const l = await db.execute(sql`select f.sanitized_details->>'sweep_id' as sweep_id, f.at::text as at from audit_events f where ${where} order by f.at desc, f.id desc limit ${limit}`);
  const rows = (l as unknown as { rows: Array<{ sweep_id: string | null; at: string }> }).rows;
  return { total, items: rows.map((r) => ({ sweepId: r.sweep_id, at: new Date(r.at) })) };
}

/** 시험 전용: 캐시 비우기. */
export function resetDiskCache(): void {
  globalForOps.__csDiskCache = undefined;
}

// ---- 작업·의도·삭제 대기 ----

export const REPEATED_FAILURE_MIN = 3;
export const REPEATED_FAILURE_DAYS = 7;
const FAILED_OUTCOMES = ['rejected', 'ambiguous'] as const;
const ATTENTION_JOB_STATES = ['RECONCILING', 'UNKNOWN', 'BLOCKED'] as const;

export interface AttentionJob {
  jobId: string;
  itemId: string | null;
  planId: string | null;
  channel: string | null;
  state: string;
  lastErrorCode: string | null;
  updatedAt: Date;
}

export interface RepeatedFailure {
  itemId: string;
  planId: string | null;
  failures: number;
}

/** 지난 7일 실패(거부·결과 불명) 전송 의도가 3번 이상인 항목. ownerId 가 null 이면 모든 owner(건강 확인 — 개수만 쓴다). */
export async function repeatedFailures(db: DbOrTx, ownerId: string | null, now: Date): Promise<RepeatedFailure[]> {
  const since = cutoffDays(now, REPEATED_FAILURE_DAYS);
  const rows = await db
    .select({ itemId: jobs.itemId, planId: distributionItems.planId, n: sql<number>`count(*)::int` })
    .from(sendIntents)
    .innerJoin(jobs, and(eq(jobs.id, sendIntents.jobId), eq(jobs.ownerId, sendIntents.ownerId)))
    .leftJoin(distributionItems, and(eq(distributionItems.id, jobs.itemId), eq(distributionItems.ownerId, jobs.ownerId)))
    .where(
      and(
        ownerId ? eq(sendIntents.ownerId, ownerId) : undefined,
        inArray(sendIntents.outcome, [...FAILED_OUTCOMES]),
        gte(sendIntents.createdAt, since),
        isNotNull(jobs.itemId),
      ),
    )
    .groupBy(jobs.itemId, distributionItems.planId)
    .having(sql`count(*) >= ${REPEATED_FAILURE_MIN}`)
    .orderBy(desc(sql`count(*)`));
  return rows.map((r) => ({ itemId: r.itemId!, planId: r.planId ?? null, failures: Number(r.n) }));
}

async function countAttentionPlans(db: DbOrTx, ownerId: string | null): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(distributionPlans)
    .where(and(ownerId ? eq(distributionPlans.ownerId, ownerId) : undefined, eq(distributionPlans.status, 'attention')));
  return Number(r?.n ?? 0);
}

async function pendingDeleteStats(db: DbOrTx, ownerId: string | null): Promise<{ count: number; oldestAt: Date | null }> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int`, oldest: sql<string | null>`min(coalesce(${assets.deletedAt}, ${assets.pendingDeleteNextAt}))::text` })
    .from(assets)
    .where(and(ownerId ? eq(assets.ownerId, ownerId) : undefined, isNotNull(assets.pendingDeleteKey)));
  return { count: Number(r?.n ?? 0), oldestAt: r?.oldest ? new Date(r.oldest) : null };
}

async function lastExportAt(db: DbOrTx, ownerId: string | null) {
  const rows = await db
    .select()
    .from(exportRuns)
    .where(and(ownerId ? eq(exportRuns.ownerId, ownerId) : undefined, eq(exportRuns.status, 'completed')))
    .orderBy(desc(exportRuns.createdAt), desc(exportRuns.id))
    .limit(1);
  return rows[0] ?? null;
}

// ---- /ops 화면 ----

/** FIX round 1(Codex review-T20 P2): 화면 목록은 OPS_LIST_LIMIT 개까지, 전체 개수는 따로 센다. */
export const OPS_LIST_LIMIT = 50;
export interface Listed<T> {
  total: number;
  items: T[];
  /** total > items.length */
  truncated: boolean;
}
const listed = <T>(total: number, items: T[]): Listed<T> => ({ total, items, truncated: total > items.length });

export interface OpsSnapshot {
  measuredAt: Date;
  jobs: {
    byState: Record<string, number>;
    total: number;
    /** 처리할 때가 된 QUEUED 중 가장 오래 기다린 시간(시간). 없으면 null */
    oldestQueuedHours: number | null;
    /** RETRY_WAIT 중 가장 이른 다음 시도 시각 */
    nextRetryAt: Date | null;
    attention: Listed<AttentionJob>;
    repeatedFailures: Listed<RepeatedFailure>;
    attentionPlans: Listed<{ id: string; targetSummary: string; updatedAt: Date }>;
  };
  intents: { pending: number; oldestPendingAt: Date | null };
  pendingDeletes: { count: number; oldestAt: Date | null };
  uploads: { expiredSessions: number; openPastExpiry: number };
  disk: DiskUsage;
  cost: { currency: string; monthlyLimit: string | null; byCurrency: CurrencyUsage[]; overBudgetRuns: number; since: Date };
  backup: {
    maxAgeHours: number;
    lastExport: { id: string; at: Date; ageHours: number; zipBytes: number } | null;
    state: BackupState;
    lastDrill: RestoreDrillRow | null;
  };
  /** 마지막 보존 정리(감사 기록 retention.sweep — 지운 개수만) */
  lastRetention: { at: Date; details: Record<string, unknown>; resultMissing: boolean; sweepId: string | null } | null;
  /** 결과 기록이 없는 정리 실행(실행 ID 기준) */
  incompleteRetention: { total: number; items: Array<{ sweepId: string; at: Date; planned: number }> };
  /** 결과가 partial 인 정리 실행(뒤의 성공이 가리지 않음) */
  partialRetention: { total: number; items: Array<{ sweepId: string | null; at: Date }> };
}

export async function opsSnapshot(
  db: Db,
  ownerId: string,
  config: AppConfig,
  now: Date = new Date(),
): Promise<OpsSnapshot> {
  const states = await db
    .select({ state: jobs.state, n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(eq(jobs.ownerId, ownerId))
    .groupBy(jobs.state)
    .orderBy(asc(jobs.state));
  const byState = Object.fromEntries(states.map((s) => [s.state, Number(s.n)]));
  const [queued] = await db
    .select({ oldest: sql<string | null>`min(${jobs.nextRunAt})::text` })
    .from(jobs)
    .where(and(eq(jobs.ownerId, ownerId), eq(jobs.state, 'QUEUED'), lt(jobs.nextRunAt, now)));
  const [retry] = await db
    .select({ next: sql<string | null>`min(${jobs.nextRunAt})::text` })
    .from(jobs)
    .where(and(eq(jobs.ownerId, ownerId), eq(jobs.state, 'RETRY_WAIT')));
  const attention = await db
    .select({
      jobId: jobs.id,
      itemId: jobs.itemId,
      planId: distributionItems.planId,
      channel: variants.channel,
      state: jobs.state,
      lastErrorCode: jobs.lastErrorCode,
      updatedAt: jobs.updatedAt,
    })
    .from(jobs)
    .leftJoin(distributionItems, and(eq(distributionItems.id, jobs.itemId), eq(distributionItems.ownerId, jobs.ownerId)))
    .leftJoin(variants, and(eq(variants.id, distributionItems.variantId), eq(variants.ownerId, distributionItems.ownerId)))
    .where(and(eq(jobs.ownerId, ownerId), inArray(jobs.state, [...ATTENTION_JOB_STATES])))
    .orderBy(asc(jobs.updatedAt), asc(jobs.id))
    .limit(OPS_LIST_LIMIT);
  const [attentionTotal] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(eq(jobs.ownerId, ownerId), inArray(jobs.state, [...ATTENTION_JOB_STATES])));
  const plans = await db
    .select({ id: distributionPlans.id, targetSummary: distributionPlans.targetSummary, updatedAt: distributionPlans.updatedAt })
    .from(distributionPlans)
    .where(and(eq(distributionPlans.ownerId, ownerId), eq(distributionPlans.status, 'attention')))
    .orderBy(desc(distributionPlans.updatedAt), desc(distributionPlans.id))
    .limit(OPS_LIST_LIMIT);
  const failures = await repeatedFailures(db, ownerId, now);
  const [intent] = await db
    .select({ n: sql<number>`count(*)::int`, oldest: sql<string | null>`min(${sendIntents.createdAt})::text` })
    .from(sendIntents)
    .where(and(eq(sendIntents.ownerId, ownerId), eq(sendIntents.outcome, 'pending')));
  const [up] = await db
    .select({
      expired: sql<number>`count(*) filter (where ${uploadSessions.state} = 'expired')::int`,
      openPast: sql<number>`count(*) filter (where ${uploadSessions.state} = 'open' and ${uploadSessions.expiresAt} < ${now.toISOString()}::timestamptz)::int`,
    })
    .from(uploadSessions)
    .where(eq(uploadSessions.ownerId, ownerId));
  const usage = await monthlyUsage(db, ownerId, now);
  const policy = budgetPolicy(config);
  const last = await lastExportAt(db, ownerId);
  const age = last ? ageHours(last.createdAt, now) : null;
  return {
    measuredAt: now,
    jobs: {
      byState,
      total: Object.values(byState).reduce((a, b) => a + b, 0),
      oldestQueuedHours: queued?.oldest ? ageHours(new Date(queued.oldest), now) : null,
      nextRetryAt: retry?.next ? new Date(retry.next) : null,
      attention: listed(
        Number(attentionTotal?.n ?? 0),
        attention.map((a) => ({ ...a, itemId: a.itemId ?? null, planId: a.planId ?? null, channel: a.channel ?? null })),
      ),
      repeatedFailures: listed(failures.length, failures.slice(0, OPS_LIST_LIMIT)),
      attentionPlans: listed(await countAttentionPlans(db, ownerId), plans),
    },
    intents: { pending: Number(intent?.n ?? 0), oldestPendingAt: intent?.oldest ? new Date(intent.oldest) : null },
    pendingDeletes: await pendingDeleteStats(db, ownerId),
    uploads: { expiredSessions: Number(up?.expired ?? 0), openPastExpiry: Number(up?.openPast ?? 0) },
    disk: await cachedDiskUsage(config, now.getTime()),
    cost: {
      currency: policy.currency,
      monthlyLimit: config.LLM_BUDGET_MONTHLY_LIMIT ?? null,
      byCurrency: usage.byCurrency,
      overBudgetRuns: usage.byCurrency.reduce((n, u) => n + u.overBudgetRuns, 0),
      since: usage.since,
    },
    backup: {
      maxAgeHours: config.BACKUP_MAX_AGE_HOURS,
      lastExport: last && age !== null ? { id: last.id, at: last.createdAt, ageHours: age, zipBytes: last.zipBytes } : null,
      state: backupState(age, config.BACKUP_MAX_AGE_HOURS),
      lastDrill: await latestRestoreDrill(db, ownerId),
    },
    lastRetention: await lastRetentionSweep(db, ownerId),
    incompleteRetention: await incompleteRetentionSweeps(db, ownerId),
    partialRetention: await partialRetentionSweeps(db, ownerId),
  };
}

/**
 * 보존 정리 기록(FIX round 4, Codex review-FIX3-T20 P1): 계획 감사(retention.sweep)와 결과 감사(retention.files)를 시각이 아니라
 * 실행 ID(details.sweep_id)로 잇는다. lastRetentionSweep = 가장 최근 계획 + 같은 ID 의 결과. incompleteRetentionSweeps = 파일 계획이 있었는데
 * 같은 ID 의 결과가 없는 실행 전부(뒤의 성공한 실행이 가리지 않는다). sweep_id 가 없는 옛 기록(round 4 이전)은 짝을 지을 수 없어 미완료로 세지 않는다.
 */
type SweepAudit = { id: string; at: Date; details: Record<string, unknown> };
const plannedFiles = (d: Record<string, unknown>) => Number(d.planned_packages ?? 0) + Number(d.planned_export_zips ?? 0) + Number(d.planned_export_dirs ?? 0);

async function sweepAudits(db: DbOrTx, ownerId: string, action: 'retention.sweep' | 'retention.files', limit = 200): Promise<SweepAudit[]> {
  const rows = await db
    .select({ id: auditEvents.id, at: auditEvents.at, details: auditEvents.sanitizedDetails })
    .from(auditEvents)
    .where(and(eq(auditEvents.ownerId, ownerId), eq(auditEvents.action, action)))
    .orderBy(desc(auditEvents.at), desc(auditEvents.id))
    .limit(limit);
  return rows.map((r) => ({ id: r.id, at: r.at, details: (r.details ?? {}) as Record<string, unknown> }));
}

export async function lastRetentionSweep(
  db: DbOrTx,
  ownerId: string,
): Promise<{ at: Date; details: Record<string, unknown>; resultMissing: boolean; sweepId: string | null } | null> {
  const [sweep] = await sweepAudits(db, ownerId, 'retention.sweep', 1);
  if (!sweep) return null;
  const sweepId = typeof sweep.details.sweep_id === 'string' ? sweep.details.sweep_id : null;
  const files = sweepId
    ? ((
        await db
          .select({ at: auditEvents.at, details: auditEvents.sanitizedDetails })
          .from(auditEvents)
          .where(and(eq(auditEvents.ownerId, ownerId), eq(auditEvents.action, 'retention.files'), sql`${auditEvents.sanitizedDetails}->>'sweep_id' = ${sweepId}`))
          .limit(1)
      )[0] ?? null)
    : null;
  return {
    at: (files ?? sweep).at,
    details: { ...sweep.details, ...((files?.details ?? {}) as Record<string, unknown>) },
    resultMissing: sweepId !== null && plannedFiles(sweep.details) > 0 && !files,
    sweepId,
  };
}

/**
 * 파일 계획이 있었는데 같은 실행 ID 의 결과 기록이 없는 정리 실행(최근 것부터, 최대 limit 개)과 전체 수.
 * FIX round 5(Codex review-FIX4-T20 P1): 최근 N 개만 보지 않고 owner 의 **모든** 계획 감사를 SQL NOT EXISTS 로 본다 — 완료된 실행이 아무리 쌓여도
 * 옛 미완료 실행이 사라지지 않는다. 전체 수는 따로 세고, limit 은 표시 목록에만 적용한다.
 */
export async function incompleteRetentionSweeps(
  db: DbOrTx,
  ownerId: string,
  limit = 20,
): Promise<{ total: number; items: Array<{ sweepId: string; at: Date; planned: number }> }> {
  // FIX round 6: JSON 값이 숫자가 아니거나 sweep_id 가 문자열이 아니면(손상·옛 형식) 오류 없이 미완료로 세지 않는다
  const num = (k: string) => sql`(case when jsonb_typeof(p.sanitized_details->${k}) = 'number' then (p.sanitized_details->>${k})::numeric else 0 end)`;
  const planned = sql`(${num('planned_packages')} + ${num('planned_export_zips')} + ${num('planned_export_dirs')})`;
  const where = sql`p.owner_id = ${ownerId}::uuid and p.action = 'retention.sweep' and jsonb_typeof(p.sanitized_details->'sweep_id') = 'string' and ${planned} > 0
    and not exists (select 1 from audit_events f where f.owner_id = p.owner_id and f.action = 'retention.files' and f.sanitized_details->>'sweep_id' = p.sanitized_details->>'sweep_id')`;
  const countRes = await db.execute(sql`select count(*)::int as n from audit_events p where ${where}`);
  const total = Number((countRes as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0);
  if (total === 0) return { total: 0, items: [] };
  const listRes = await db.execute(
    sql`select p.sanitized_details->>'sweep_id' as sweep_id, p.at::text as at, ${planned} as planned from audit_events p where ${where} order by p.at desc, p.id desc limit ${limit}`,
  );
  const rows = (listRes as unknown as { rows: Array<{ sweep_id: string; at: string; planned: number }> }).rows;
  return { total, items: rows.map((r) => ({ sweepId: r.sweep_id, at: new Date(r.at), planned: Number(r.planned) })) };
}

// ---- GET /api/ops/summary (로그인한 owner 범위, 숫자만) ----
// D23(e): 공개 /api/health 에서 옮겼다. 폴더 바이트는 이 PC 의 폴더 전체 측정(owner 구분 없음)이라 owner 범위가 아니다.

export interface OpsSummary {
  backup_age_hours: number | null;
  attention_plans: number;
  repeated_failures: number;
  pending_deletes: number;
  /** unavailable(폴더 없음·읽기 실패)이면 null. partial 이면 하한값이고 disk_partial = true */
  disk: { db: number | null; assets: number | null; uploads: number | null; exports: number | null };
  disk_partial: boolean;
}

export async function opsSummary(db: Db, ownerId: string, config: AppConfig, now: Date = new Date()): Promise<OpsSummary> {
  const last = await lastExportAt(db, ownerId);
  const disk = await cachedDiskUsage(config, now.getTime());
  const bytes = (u: DirUsage | null) => (u && u.present && u.status !== 'unavailable' ? u.bytes : null);
  const partial = [disk.db, disk.assets, disk.uploads, disk.exports].some((u) => u?.status === 'partial');
  return {
    backup_age_hours: last ? ageHours(last.createdAt, now) : null,
    attention_plans: await countAttentionPlans(db, ownerId),
    repeated_failures: (await repeatedFailures(db, ownerId, now)).length,
    pending_deletes: (await pendingDeleteStats(db, ownerId)).count,
    disk: { db: bytes(disk.db), assets: bytes(disk.assets), uploads: bytes(disk.uploads), exports: bytes(disk.exports) },
    disk_partial: partial,
  };
}
