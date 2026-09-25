/**
 * 조회·쓰기 헬퍼. owner 제한(A01)은 route 뿐 아니라 이 query 계층에서도 강제한다:
 * captures/assets 등 owner 소유 데이터를 다루는 함수는 모두 ownerId 를 받아 WHERE 에 넣는다.
 * 다른 owner 의 ID 를 넘기면 "없음(null)" 으로 응답한다(존재 여부를 구분해 드러내지 않음).
 */
import { and, asc, count, desc, eq, gt, isNull } from 'drizzle-orm';
import { isUuid } from '@cs/domain';
import type { Db } from './client';
import { assets, auditEvents, captures, sessions, users } from './schema';

export async function findOwner(db: Db, allowedIdentity: string) {
  const rows = await db.select().from(users).where(eq(users.allowedIdentity, allowedIdentity)).limit(1);
  return rows[0] ?? null;
}

/** 허용 식별자의 users 행을 보장한다(seed 와 같은 방식: 없으면 만들고, 있으면 그대로). */
export async function ensureOwner(db: Db, allowedIdentity: string) {
  await db.insert(users).values({ allowedIdentity }).onConflictDoNothing();
  const owner = await findOwner(db, allowedIdentity);
  if (!owner) throw new Error('owner 생성에 실패했습니다');
  return owner;
}

/** ownerId 를 생략하면 전체 집계(health 용 — 개수만, 내용 없음). */
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

/** 다른 owner 의 capture 이거나 형식이 잘못된 ID 면 null. */
export async function getCaptureById(db: Db, ownerId: string, id: string) {
  if (!isUuid(id)) return null;
  const rows = await db
    .select()
    .from(captures)
    .where(and(eq(captures.id, id), eq(captures.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

// ---- assets ----

export type AssetRow = typeof assets.$inferSelect;

export async function listAssets(db: Db, ownerId: string, limit = 50) {
  return db
    .select()
    .from(assets)
    .where(eq(assets.ownerId, ownerId))
    .orderBy(desc(assets.createdAt), asc(assets.id))
    .limit(limit);
}

export async function getAssetById(db: Db, ownerId: string, id: string): Promise<AssetRow | null> {
  if (!isUuid(id)) return null;
  const rows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, id), eq(assets.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * asset 행을 트랜잭션 안에서 잠근다(SELECT … FOR UPDATE). 같은 asset 의 파일 복구처럼 "확인 → 저장 → 감사" 를
 * 한 요청만 수행하게 직렬화할 때 쓴다. 트랜잭션 밖에서 호출하면 잠금이 즉시 풀리므로 반드시 tx 로 호출한다.
 */
export async function lockAssetRow(tx: DbOrTx, ownerId: string, id: string): Promise<AssetRow | null> {
  const rows = await tx
    .select()
    .from(assets)
    .where(and(eq(assets.id, id), eq(assets.ownerId, ownerId)))
    .for('update');
  return rows[0] ?? null;
}

export async function findAssetByChecksum(db: Db, ownerId: string, checksum: string): Promise<AssetRow | null> {
  const rows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.ownerId, ownerId), eq(assets.checksum, checksum)))
    .limit(1);
  return rows[0] ?? null;
}

export interface NewAsset {
  id: string;
  ownerId: string;
  key: string;
  mime: string;
  bytes: number;
  checksum: string;
  rightsStatus: string;
  verificationState: string;
}

/** (owner_id, checksum) 충돌이면 null(동시 중복 업로드) — 호출자가 기존 asset 을 다시 조회한다. */
export async function insertAsset(db: Db, a: NewAsset): Promise<AssetRow | null> {
  const rows = await db
    .insert(assets)
    .values(a)
    .onConflictDoNothing({ target: [assets.ownerId, assets.checksum] })
    .returning();
  return rows[0] ?? null;
}

// ---- sessions ----

export interface NewSession {
  ownerId: string;
  tokenHash: string;
  expiresAt: Date;
  userAgentHash: string | null;
  now: Date;
}

export async function createSession(db: Db, s: NewSession) {
  const rows = await db
    .insert(sessions)
    .values({
      ownerId: s.ownerId,
      tokenHash: s.tokenHash,
      createdAt: s.now,
      lastSeenAt: s.now,
      expiresAt: s.expiresAt,
      userAgentHash: s.userAgentHash,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('세션 생성에 실패했습니다');
  return row;
}

/**
 * token_hash 로 "유효한" 세션만 찾는다: expires_at > now AND revoked_at IS NULL.
 * owner 의 허용 식별자도 함께 반환해 호출자가 현재 allowlist 와 대조하게 한다.
 */
export async function findActiveSession(db: Db, tokenHash: string, now: Date) {
  const rows = await db
    .select({
      sessionId: sessions.id,
      ownerId: sessions.ownerId,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      identity: users.allowedIdentity,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.ownerId))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now), isNull(sessions.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function touchSession(db: Db, sessionId: string, now: Date): Promise<void> {
  await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, sessionId));
}

/** 아직 폐기되지 않은 세션만 폐기한다. 폐기했으면 true. */
export async function revokeSession(db: Db, ownerId: string, sessionId: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.id, sessionId), eq(sessions.ownerId, ownerId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

// ---- audit ----

/** db 또는 transaction 안의 tx — 같은 쿼리 헬퍼를 둘 다에서 쓴다. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export interface AuditInput {
  /** 인증 전 이벤트(auth.login_denied)만 null */
  ownerId: string | null;
  action:
    | 'auth.login'
    | 'auth.logout'
    | 'auth.login_denied'
    | 'asset.upload'
    | 'asset.download'
    | 'asset.missing'
    | 'asset.restore'
    | 'capture.create'
    | 'capture.update'
    | 'capture.extract_blocked'
    | 'idea.create'
    | 'idea.update'
    | 'content.create'
    | 'content.update'
    | 'content.version_append'
    | 'brand.version_create'
    | 'interview.answer'
    | 'content.assist'
    | 'content.adopt_ai'
    | 'content.claim_confirm'
    | 'variant.version_create'
    | 'variant.assist'
    | 'variant.adopt_ai'
    | 'variant.assets'
    | 'variant.lifecycle'
    | 'content.proposal_dismiss'
    | 'package.create'
    | 'package.download'
    | 'export.create'
    | 'export.download'
    | 'restore.preview'
    | 'restore.commit'
    | 'upload.session_create'
    | 'upload.complete'
    | 'upload.reject'
    | 'upload.abort'
    | 'upload.expire'
    | 'asset.delete_original'
    | 'asset.delete_original_skipped'
    | 'asset.cleanup'
    | 'transcription.request'
    | 'transcription.cancel'
    | 'transcription.succeeded'
    | 'transcription.failed'
    | 'transcript.version_create'
    | 'transcript.to_capture';
  entity: string;
  entityId?: string | null;
  versionOrHash?: string | null;
  /** 정제된 값만(식별자·토큰·경로·환경변수 값 금지) */
  details?: Record<string, string | number | boolean | null>;
  at?: Date;
}

export async function recordAudit(db: DbOrTx, e: AuditInput): Promise<void> {
  await db.insert(auditEvents).values({
    ownerId: e.ownerId,
    action: e.action,
    entity: e.entity,
    entityId: e.entityId ?? null,
    versionOrHash: e.versionOrHash ?? null,
    sanitizedDetails: e.details ?? {},
    ...(e.at ? { at: e.at } : {}),
  });
}
