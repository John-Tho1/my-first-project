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
  /** 폴더가 있는가(없으면 bytes·files 는 0 이고 화면에는 "측정 없음") */
  present: boolean;
  bytes: number;
  files: number;
  /** 항목이 너무 많아 세다가 멈췄는가(그때 bytes 는 하한) */
  truncated: boolean;
}

export const DIR_SCAN_MAX_ENTRIES = 50_000;

/** 폴더 아래 일반 파일 바이트·개수(심볼릭 링크는 따라가지 않음). excludeTop: 맨 위 단계에서 건너뛸 이름. */
export async function dirUsage(dir: string, opts: { excludeTop?: readonly string[]; maxEntries?: number } = {}): Promise<DirUsage> {
  const max = opts.maxEntries ?? DIR_SCAN_MAX_ENTRIES;
  const out: DirUsage = { present: false, bytes: 0, files: 0, truncated: false };
  try {
    if (!(await lstat(/*turbopackIgnore: true*/ dir)).isDirectory()) return out;
  } catch {
    return out;
  }
  out.present = true;
  let seen = 0;
  const stack: Array<{ d: string; top: boolean }> = [{ d: dir, top: true }];
  while (stack.length) {
    const { d, top } = stack.pop()!;
    let names: import('node:fs').Dirent[];
    try {
      names = await readdir(/*turbopackIgnore: true*/ d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const n of names) {
      if (++seen > max) {
        out.truncated = true;
        return out;
      }
      if (top && opts.excludeTop?.includes(n.name)) continue;
      const full = path.join(/*turbopackIgnore: true*/ d, n.name);
      if (n.isDirectory()) stack.push({ d: full, top: false });
      else if (n.isFile()) {
        try {
          out.bytes += (await lstat(/*turbopackIgnore: true*/ full)).size;
          out.files++;
        } catch {
          // 세는 사이 지워진 파일
        }
      }
    }
  }
  return out;
}

export interface DiskUsage {
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
    db: config.DATABASE_URL === 'memory://' ? null : await dirUsage(resolveFromRoot(config.DATABASE_URL)),
    assets: await dirUsage(storage, { excludeTop: ['uploads'] }),
    uploads: await dirUsage(path.join(/*turbopackIgnore: true*/ storage, 'uploads')),
    exports: await dirUsage(exportsDir, { excludeTop: ['packages', 'retention'] }),
    packages: await dirUsage(path.join(/*turbopackIgnore: true*/ exportsDir, 'packages')),
    retention: await dirUsage(path.join(/*turbopackIgnore: true*/ exportsDir, 'retention')),
  };
}

const globalForOps = globalThis as typeof globalThis & { __csDiskCache?: { key: string; at: number; value: DiskUsage } };
export const DISK_CACHE_MS = 60_000;

/** /api/health 용: 같은 설정이면 60초 동안 측정값을 다시 쓴다(요청마다 폴더 전체를 걷지 않게). */
export async function cachedDiskUsage(config: Pick<AppConfig, 'DATABASE_URL' | 'STORAGE_LOCAL_DIR' | 'EXPORT_LOCAL_DIR'>, nowMs = Date.now()): Promise<DiskUsage> {
  const key = `${config.DATABASE_URL}|${config.STORAGE_LOCAL_DIR}|${config.EXPORT_LOCAL_DIR}`;
  const c = globalForOps.__csDiskCache;
  if (c && c.key === key && nowMs - c.at < DISK_CACHE_MS) return c.value;
  const value = await diskUsage(config);
  globalForOps.__csDiskCache = { key, at: nowMs, value };
  return value;
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

export interface OpsSnapshot {
  measuredAt: Date;
  jobs: {
    byState: Record<string, number>;
    total: number;
    /** 처리할 때가 된 QUEUED 중 가장 오래 기다린 시간(시간). 없으면 null */
    oldestQueuedHours: number | null;
    /** RETRY_WAIT 중 가장 이른 다음 시도 시각 */
    nextRetryAt: Date | null;
    attention: AttentionJob[];
    repeatedFailures: RepeatedFailure[];
    attentionPlans: Array<{ id: string; targetSummary: string; updatedAt: Date }>;
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
  lastRetention: { at: Date; details: Record<string, unknown> } | null;
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
    .limit(50);
  const plans = await db
    .select({ id: distributionPlans.id, targetSummary: distributionPlans.targetSummary, updatedAt: distributionPlans.updatedAt })
    .from(distributionPlans)
    .where(and(eq(distributionPlans.ownerId, ownerId), eq(distributionPlans.status, 'attention')))
    .orderBy(desc(distributionPlans.updatedAt))
    .limit(50);
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
      attention: attention.map((a) => ({ ...a, itemId: a.itemId ?? null, planId: a.planId ?? null, channel: a.channel ?? null })),
      repeatedFailures: await repeatedFailures(db, ownerId, now),
      attentionPlans: plans,
    },
    intents: { pending: Number(intent?.n ?? 0), oldestPendingAt: intent?.oldest ? new Date(intent.oldest) : null },
    pendingDeletes: await pendingDeleteStats(db, ownerId),
    uploads: { expiredSessions: Number(up?.expired ?? 0), openPastExpiry: Number(up?.openPast ?? 0) },
    disk: await diskUsage(config),
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
  };
}

export async function lastRetentionSweep(db: DbOrTx, ownerId: string): Promise<{ at: Date; details: Record<string, unknown> } | null> {
  const [r] = await db
    .select({ at: auditEvents.at, details: auditEvents.sanitizedDetails })
    .from(auditEvents)
    .where(and(eq(auditEvents.ownerId, ownerId), eq(auditEvents.action, 'retention.sweep')))
    .orderBy(desc(auditEvents.at))
    .limit(1);
  return r ? { at: r.at, details: (r.details ?? {}) as Record<string, unknown> } : null;
}

// ---- /api/health (모든 owner 합계, 숫자만) ----

export interface HealthOps {
  backup_age_hours: number | null;
  attention_plans: number;
  repeated_failures: number;
  pending_deletes: number;
  disk: { db: number | null; assets: number | null; uploads: number | null; exports: number | null };
}

export async function healthOps(db: Db, config: AppConfig, now: Date = new Date()): Promise<HealthOps> {
  const last = await lastExportAt(db, null);
  const disk = await cachedDiskUsage(config, now.getTime());
  const bytes = (u: DirUsage | null) => (u && u.present ? u.bytes : null);
  return {
    backup_age_hours: last ? ageHours(last.createdAt, now) : null,
    attention_plans: await countAttentionPlans(db, null),
    repeated_failures: (await repeatedFailures(db, null, now)).length,
    pending_deletes: (await pendingDeleteStats(db, null)).count,
    disk: { db: bytes(disk.db), assets: bytes(disk.assets), uploads: bytes(disk.uploads), exports: bytes(disk.exports) },
  };
}
