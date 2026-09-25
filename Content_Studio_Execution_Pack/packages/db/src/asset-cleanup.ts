/**
 * FIX-T08 round 2(Codex review-FIX-T08): 파일 삭제는 "의도 먼저" — assets.pending_delete_key 를 커밋한 뒤 파일을 지우고 값을 비운다.
 * - 파일 삭제가 실패하거나 프로세스가 죽으면 값이 남고, worker tick(assets.cleanup)이 다시 시도한다(몇 번이든 안전).
 * - 살아 있는 파일은 지우지 않는다: 삭제 대상 key 를 deleted_at 이 없는 asset 이 쓰고 있으면 파일은 두고 표시만 비운다.
 *   재업로드 복구는 항상 새 key 를 쓰므로 정상 경로에서 이 경우는 생기지 않는다.
 * - asset 이 DB 에서 "지워짐"이어도 파일이 없다고 가정하지 않는다 — 지워야 할 key 는 항상 pending_delete_key 로 추적한다.
 */
import { and, asc, eq, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
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

/** FIX-T08 round 3: n 번째 실패 뒤 대기 = min(2^n 분, 6시간) */
export const CLEANUP_MAX_BACKOFF_MS = 6 * 3600_000;
export function cleanupBackoffMs(attempts: number): number {
  return Math.min(CLEANUP_MAX_BACKOFF_MS, 2 ** Math.min(attempts, 30) * 60_000);
}

/** asset 하나의 삭제 의도를 처리한다. 성공(또는 살아 있는 key 라 건너뜀)하면 pending_delete_key 를 비운다(같은 값일 때만). */
export async function cleanupPendingDelete(db: Db, files: AssetFileDeleter, ownerId: string, assetId: string, now: Date = new Date()): Promise<CleanupOutcome> {
  const a = (await db.select().from(assets).where(and(eq(assets.id, assetId), eq(assets.ownerId, ownerId))).limit(1))[0];
  if (!a?.pendingDeleteKey) return 'none';
  const key = a.pendingDeleteKey;
  const live = await keyIsLive(db, key);
  if (!live) {
    try {
      await files.delete(key);
    } catch {
      // 표시는 남는다 — 실패 횟수를 올리고 다음 시도 시각을 늦춘다(같은 key 일 때만)
      const attempts = a.pendingDeleteAttempts + 1;
      await db
        .update(assets)
        .set({ pendingDeleteAttempts: attempts, pendingDeleteNextAt: new Date(now.getTime() + cleanupBackoffMs(attempts)) })
        .where(and(eq(assets.id, a.id), eq(assets.ownerId, ownerId), eq(assets.pendingDeleteKey, key)));
      return 'failed';
    }
  }
  await db.transaction(async (tx) => {
    const cleared = await tx
      .update(assets)
      .set({ pendingDeleteKey: null, pendingDeleteAttempts: 0, pendingDeleteNextAt: null })
      .where(and(eq(assets.id, a.id), eq(assets.ownerId, ownerId), eq(assets.pendingDeleteKey, key)))
      .returning({ id: assets.id });
    if (cleared[0]) {
      await recordAudit(tx, { ownerId, action: 'asset.cleanup', entity: 'asset', entityId: a.id, details: { outcome: live ? 'skipped_live' : 'deleted' }, at: now });
    }
  });
  return live ? 'skipped_live' : 'deleted';
}

/**
 * worker tick: 남은 삭제 의도를 다시 처리한다. FIX-T08 round 3: 다음 시도 시각이 된 것만, 한 번도 실패하지 않은 것(NULL)부터
 * 다음 시도 시각·id 순으로 최대 limit 개 — 계속 실패하는 의도가 배치를 독점하지 않는다.
 */
export async function cleanupPendingDeletes(db: Db, files: AssetFileDeleter, now: Date = new Date(), limit = 50): Promise<{ deleted: number; failed: number }> {
  const due = await db
    .select({ id: assets.id, ownerId: assets.ownerId })
    .from(assets)
    .where(and(isNotNull(assets.pendingDeleteKey), or(isNull(assets.pendingDeleteNextAt), lte(assets.pendingDeleteNextAt, now))))
    .orderBy(sql`${assets.pendingDeleteNextAt} asc nulls first`, asc(assets.id))
    .limit(limit);
  let deleted = 0;
  let failed = 0;
  for (const d of due) {
    const r = await cleanupPendingDelete(db, files, d.ownerId, d.id, now);
    if (r === 'deleted' || r === 'skipped_live') deleted++;
    else if (r === 'failed') failed++;
  }
  return { deleted, failed };
}
