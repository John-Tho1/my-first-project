import { asc, count, eq } from 'drizzle-orm';
import type { Db } from './client';
import { captures, users } from './schema';

export async function findOwner(db: Db, allowedIdentity: string) {
  const rows = await db.select().from(users).where(eq(users.allowedIdentity, allowedIdentity)).limit(1);
  return rows[0] ?? null;
}

export async function countCaptures(db: Db, ownerId?: string): Promise<number> {
  const q = db.select({ n: count() }).from(captures);
  const rows = ownerId ? await q.where(eq(captures.ownerId, ownerId)) : await q;
  return rows[0]?.n ?? 0;
}

/** 소유자 범위로만 조회한다(owner 제한은 query 에서도 적용). */
export async function listCaptures(db: Db, ownerId: string, limit = 50) {
  return db
    .select()
    .from(captures)
    .where(eq(captures.ownerId, ownerId))
    .orderBy(asc(captures.receivedAt), asc(captures.commandKey))
    .limit(limit);
}
