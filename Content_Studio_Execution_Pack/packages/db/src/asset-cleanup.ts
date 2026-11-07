/**
 * FIX-T08 round 2(Codex review-FIX-T08): 파일 삭제는 "의도 먼저" — assets.pending_delete_key 를 커밋한 뒤 파일을 지우고 값을 비운다.
 * - 파일 삭제가 실패하거나 프로세스가 죽으면 값이 남고, worker tick(assets.cleanup)이 다시 시도한다(몇 번이든 안전).
 * - 살아 있는 파일은 지우지 않는다: 삭제 대상 key 를 deleted_at 이 없는 asset 이 쓰고 있으면 파일은 두고 표시만 비운다.
 *   재업로드 복구는 항상 새 key 를 쓰므로 정상 경로에서 이 경우는 생기지 않는다.
 * - asset 이 DB 에서 "지워짐"이어도 파일이 없다고 가정하지 않는다 — 지워야 할 key 는 항상 pending_delete_key 로 추적한다.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from './client';
import { recordAudit, type DbOrTx } from './queries';
import { assets } from './schema';

/** 파일 삭제에 필요한 저장소 부분 */
export interface AssetFileDeleter {
  delete(key: string): Promise<void>;
}

/** 이 key 를 지금 쓰는(지워지지 않은) asset 이 있는가 — owner 와 무관하게(key 는 전역 unique) */
export async function keyIsLive(db: DbOrTx, key: string): Promise<boolean> {
  const rows = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.key, key), isNull(assets.deletedAt)))
    .limit(1);
  return rows.length > 0;
}

export type CleanupOutcome = 'none' | 'deleted' | 'skipped_live' | 'failed';

/** FIX-T08 round 3: n 번째 실패 뒤 대기 = min(2^n 분, 6시간) — SQL(failSql)과 같은 식 */
export const CLEANUP_MAX_BACKOFF_MS = 6 * 3600_000;
export function cleanupBackoffMs(attempts: number): number {
  return Math.min(CLEANUP_MAX_BACKOFF_MS, 2 ** Math.min(attempts, 30) * 60_000);
}
/** FIX-T08 round 4: 처리 중 표시(lease) — 가져간 의도의 다음 시도 시각을 잠시 미뤄 다른 tick 이 같은 의도를 동시에 처리하지 않게 한다. */
export const CLEANUP_LEASE_MS = 60_000;

interface Claimed {
  id: string;
  ownerId: string;
  key: string;
}

/**
 * FIX-T08 round 4: 처리할 의도를 가져간다(claim). 한 트랜잭션에서 다음 시도 시각이 된 행을 `FOR UPDATE SKIP LOCKED` 로 잠그고
 * 다음 시도 시각을 now + lease 로 미룬 뒤 커밋한다 — 동시에 도는 다른 tick 은 잠긴 행을 건너뛰고, 커밋 뒤에는 아직 때가 아니라서
 * 가져가지 않는다. 순서는 다음 시도 시각·id 하나의 시간축(새 의도는 만든 시각, 실패한 의도는 backoff 시각).
 */
async function claimDue(db: Db, now: Date, limit: number, only?: { ownerId: string; assetId: string }): Promise<Claimed[]> {
  return db.transaction(async (tx) => {
    const res = await tx.execute(sql`
      select id, owner_id, pending_delete_key from assets
      where pending_delete_key is not null
        and coalesce(pending_delete_next_at, '-infinity'::timestamptz) <= ${now.toISOString()}::timestamptz
        ${only ? sql`and id = ${only.assetId}::uuid and owner_id = ${only.ownerId}::uuid` : sql``}
      order by coalesce(pending_delete_next_at, '-infinity'::timestamptz), id
      limit ${limit}
      for update skip locked`);
    const rows = (res as unknown as { rows: Array<{ id: string; owner_id: string; pending_delete_key: string }> }).rows;
    for (const r of rows) {
      await tx.execute(
        sql`update assets set pending_delete_next_at = ${new Date(now.getTime() + CLEANUP_LEASE_MS).toISOString()}::timestamptz where id = ${r.id}::uuid and pending_delete_key = ${r.pending_delete_key}`,
      );
    }
    return rows.map((r) => ({ id: r.id, ownerId: r.owner_id, key: r.pending_delete_key }));
  });
}

/**
 * 실패 기록 — SQL 한 문장으로 원자적·단조: 횟수 +1, 다음 시도 = GREATEST(현재 값, now + min(2^(횟수+1) 분, 6시간)).
 * 같은 key 일 때만(그 사이 의도가 바뀌었으면 아무것도 하지 않음).
 */
async function recordFailure(db: Db, c: Claimed, now: Date): Promise<void> {
  await db.execute(sql`
    update assets set
      pending_delete_attempts = pending_delete_attempts + 1,
      pending_delete_next_at = greatest(
        coalesce(pending_delete_next_at, '-infinity'::timestamptz),
        ${now.toISOString()}::timestamptz + least(power(2, least(pending_delete_attempts + 1, 30)) * interval '1 minute', interval '6 hours')
      )
    where id = ${c.id}::uuid and owner_id = ${c.ownerId}::uuid and pending_delete_key = ${c.key}`);
}

async function processClaimed(db: Db, files: AssetFileDeleter, c: Claimed, now: Date): Promise<CleanupOutcome> {
  const live = await keyIsLive(db, c.key);
  if (!live) {
    try {
      await files.delete(c.key);
    } catch {
      await recordFailure(db, c, now);
      return 'failed';
    }
  }
  await db.transaction(async (tx) => {
    const cleared = await tx
      .update(assets)
      .set({ pendingDeleteKey: null, pendingDeleteAttempts: 0, pendingDeleteNextAt: null })
      .where(and(eq(assets.id, c.id), eq(assets.ownerId, c.ownerId), eq(assets.pendingDeleteKey, c.key)))
      .returning({ id: assets.id });
    if (cleared[0]) {
      await recordAudit(tx, { ownerId: c.ownerId, action: 'asset.cleanup', entity: 'asset', entityId: c.id, details: { outcome: live ? 'skipped_live' : 'deleted' }, at: now });
    }
  });
  return live ? 'skipped_live' : 'deleted';
}

/**
 * asset 하나의 삭제 의도를 처리한다(때가 된 경우만 — 다른 tick 이 처리 중이면 'none').
 * 성공(또는 살아 있는 key 라 건너뜀)하면 표시를 비운다(같은 key 일 때만).
 */
export async function cleanupPendingDelete(db: Db, files: AssetFileDeleter, ownerId: string, assetId: string, now: Date = new Date()): Promise<CleanupOutcome> {
  const [c] = await claimDue(db, now, 1, { ownerId, assetId });
  if (!c) return 'none';
  return processClaimed(db, files, c, now);
}

/**
 * worker tick: 때가 된 삭제 의도를 다음 시도 시각·id 순으로 최대 limit 개 가져가(claim) 처리한다.
 * 계속 실패하는 의도는 backoff 로 뒤로 밀리고, 새 의도는 만든 시각에 줄을 선다 — 어느 쪽도 다른 쪽을 굶기지 않는다.
 */
export async function cleanupPendingDeletes(db: Db, files: AssetFileDeleter, now: Date = new Date(), limit = 50): Promise<{ deleted: number; failed: number }> {
  const claimed = await claimDue(db, now, limit);
  let deleted = 0;
  let failed = 0;
  for (const c of claimed) {
    const r = await processClaimed(db, files, c, now);
    if (r === 'deleted' || r === 'skipped_live') deleted++;
    else if (r === 'failed') failed++;
  }
  return { deleted, failed };
}
