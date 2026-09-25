/**
 * T08 업로드 세션(A14, 결정 D9·D15). 큰 음성·영상 파일을 조각으로 받아 서버가 이어 붙이고 검사한다.
 *
 * - 조각 파일: <STORAGE_LOCAL_DIR>/uploads/<owner uuid>/<session uuid>/<index>. 경로는 UUID·정수만으로 만들고 루트 밖이면 거부한다.
 * - 조각 PUT: 세션 행을 잠근 트랜잭션 안에서 크기 확인 → 파일 쓰기(임시 파일 → rename) → 행 기록. 같은 번호·같은 sha256 은 그대로(멱등),
 *   다른 sha256 은 409 chunk_mismatch(이미 받은 조각을 바꾸지 않는다).
 * - 완료: 잠금 아래 open → completed 로 바꾼 뒤(동시 완료 1건만), 트랜잭션 밖에서 조각을 차례로 스트림으로 이어 붙이며
 *   조각별 sha256 재확인·전체 sha256·앞부분 서명을 계산한다(전체를 메모리에 올리지 않음). 통과 → asset(VERIFIED) + verified,
 *   실패 → rejected(이유 코드) + 조각 삭제. 같은 owner 의 같은 checksum asset 이 있으면 그 asset 을 쓴다(T02 규칙).
 * - 만료(24시간): worker 가 open·completed 세션을 expired 로 바꾸고 조각을 지운다.
 * 모든 조회·변경은 owner_id 를 WHERE 에 넣는다(다른 owner → 404).
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import {
  AppError,
  buildAssetKey,
  chunkCount,
  expectedChunkBytes,
  isUuid,
  mediaMatches,
  missingChunks,
  NotFoundError,
  sniffMedia,
  SNIFF_HEAD_BYTES,
  UPLOAD_SESSION_TTL_MS,
  uploadProgress,
  VERIFICATION_SCOPE,
  type AppConfig,
  type MediaMime,
  type UploadPlan,
} from '@cs/domain';
import type { Db } from './client';
import { resolveFromRoot } from './paths';
import { recordAudit, type AssetRow, type DbOrTx } from './queries';
import { assets, uploadChunks, uploadSessions } from './schema';

export type UploadSessionRow = typeof uploadSessions.$inferSelect;

const NOT_FOUND = '업로드 세션을 찾을 수 없습니다';

/** 파일 저장소 중 업로드 완료에 필요한 부분(@cs/providers StorageAdapter 가 만족). */
export interface AssetFileStore {
  putFile(key: string, srcPath: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export type UploadRejectReason = 'size_mismatch' | 'unsupported_signature' | 'mime_mismatch' | 'checksum_mismatch' | 'assembly_failed';

const REJECT_TEXT: Record<UploadRejectReason, string> = {
  size_mismatch: '받은 파일 크기가 신고한 크기와 다릅니다',
  unsupported_signature: '파일 내용이 지원하는 음성·영상 형식이 아닙니다(형식 서명 불일치)',
  mime_mismatch: '파일 내용의 형식이 신고한 형식(mime)과 다릅니다',
  checksum_mismatch: '파일 sha256 이 신고한 값과 다릅니다',
  assembly_failed: '조각 파일을 이어 붙이지 못했습니다(조각이 없거나 바뀜). 새 세션으로 다시 올리세요.',
};

export class UploadRejectedError extends AppError {
  constructor(reason: UploadRejectReason) {
    super(
      reason === 'unsupported_signature' || reason === 'mime_mismatch' ? 'unsupported_media_type' : 'bad_request',
      'upload_rejected',
      `업로드를 거부했습니다: ${REJECT_TEXT[reason]}. 받은 조각은 삭제했습니다.`,
      { reason },
    );
  }
}

// ---- 조각 파일 저장소 ----

export class UploadStore {
  readonly root: string;
  constructor(root: string) {
    if (!path.isAbsolute(root)) throw new Error('UploadStore 의 root 는 절대 경로여야 합니다');
    this.root = path.resolve(/*turbopackIgnore: true*/ root);
  }

  /** <root>/<owner>/<session>. UUID(소문자)만 허용하고, 결과가 root 밖이면 거부(이중 방어). */
  dirFor(ownerId: string, sessionId: string): string {
    if (!isUuid(ownerId) || !isUuid(sessionId)) throw new Error('업로드 경로 식별자가 올바르지 않습니다');
    const dir = path.resolve(/*turbopackIgnore: true*/ this.root, ownerId, sessionId);
    if (!dir.startsWith(this.root + path.sep)) throw new Error('업로드 경로가 루트를 벗어났습니다');
    return dir;
  }

  chunkPath(ownerId: string, sessionId: string, index: number): string {
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('조각 번호가 올바르지 않습니다');
    return path.join(/*turbopackIgnore: true*/ this.dirFor(ownerId, sessionId), String(index));
  }

  async writeChunk(ownerId: string, sessionId: string, index: number, bytes: Uint8Array): Promise<void> {
    const full = this.chunkPath(ownerId, sessionId, index);
    await mkdir(/*turbopackIgnore: true*/ path.dirname(full), { recursive: true });
    const tmp = `${full}.tmp-${randomUUID()}`;
    try {
      await writeFile(/*turbopackIgnore: true*/ tmp, bytes, { flag: 'wx' });
      await rename(/*turbopackIgnore: true*/ tmp, full);
    } catch (e) {
      await rm(/*turbopackIgnore: true*/ tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  async chunkExists(ownerId: string, sessionId: string, index: number): Promise<boolean> {
    try {
      return (await stat(/*turbopackIgnore: true*/ this.chunkPath(ownerId, sessionId, index))).isFile();
    } catch {
      return false;
    }
  }

  async removeSession(ownerId: string, sessionId: string): Promise<void> {
    await rm(/*turbopackIgnore: true*/ this.dirFor(ownerId, sessionId), { recursive: true, force: true });
  }

  /** 업로드 임시 영역 사용량(health 용 — 파일 수·바이트만) */
  async usage(): Promise<{ sessions: number; files: number; bytes: number }> {
    let sessions = 0;
    let files = 0;
    let bytes = 0;
    const list = (p: string) => readdir(/*turbopackIgnore: true*/ p).catch(() => [] as string[]);
    for (const o of await list(this.root)) {
      for (const d of await list(path.join(/*turbopackIgnore: true*/ this.root, o))) {
        sessions++;
        for (const n of await list(path.join(/*turbopackIgnore: true*/ this.root, o, d))) {
          try {
            const st = await stat(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ this.root, o, d, n));
            if (st.isFile()) {
              files++;
              bytes += st.size;
            }
          } catch {
            // 사이에 지워진 파일
          }
        }
      }
    }
    return { sessions, files, bytes };
  }
}

/** STORAGE_LOCAL_DIR/uploads (워크스페이스 루트 기준) */
export function uploadStoreFor(config: Pick<AppConfig, 'STORAGE_LOCAL_DIR'>): UploadStore {
  return new UploadStore(path.join(/*turbopackIgnore: true*/ resolveFromRoot(config.STORAGE_LOCAL_DIR), 'uploads'));
}

// ---- 조회 ----

export async function getUploadSession(db: DbOrTx, ownerId: string, id: string): Promise<UploadSessionRow | null> {
  if (!isUuid(id)) return null;
  const rows = await db
    .select()
    .from(uploadSessions)
    .where(and(eq(uploadSessions.id, id), eq(uploadSessions.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

async function lockSession(tx: DbOrTx, ownerId: string, id: string): Promise<UploadSessionRow | null> {
  if (!isUuid(id)) return null;
  const rows = await tx
    .select()
    .from(uploadSessions)
    .where(and(eq(uploadSessions.id, id), eq(uploadSessions.ownerId, ownerId)))
    .for('update');
  return rows[0] ?? null;
}

export async function listChunkRows(db: DbOrTx, ownerId: string, sessionId: string) {
  return db
    .select({ index: uploadChunks.chunkIndex, bytes: uploadChunks.bytes, sha256: uploadChunks.sha256 })
    .from(uploadChunks)
    .where(and(eq(uploadChunks.sessionId, sessionId), eq(uploadChunks.ownerId, ownerId)))
    .orderBy(asc(uploadChunks.chunkIndex));
}

export interface UploadSessionView {
  id: string;
  kind: string;
  mime: string;
  bytes: number;
  chunk_size: number;
  chunk_count: number;
  received_bytes: number;
  received_chunks: number;
  next_index: number | null;
  missing_indexes: number[];
  progress: number;
  state: string;
  reject_reason: string | null;
  asset_id: string | null;
  expires_at: string;
  created_at: string;
}

export function uploadSessionView(s: UploadSessionRow, received: readonly number[]): UploadSessionView {
  const total = chunkCount(s.declaredBytes, s.chunkSize);
  const gaps = missingChunks(total, received);
  return {
    id: s.id,
    kind: s.kind,
    mime: s.declaredMime,
    bytes: s.declaredBytes,
    chunk_size: s.chunkSize,
    chunk_count: total,
    received_bytes: s.receivedBytes,
    received_chunks: received.length,
    next_index: s.state === 'open' ? gaps.next : null,
    missing_indexes: s.state === 'open' ? gaps.missing : [],
    progress: uploadProgress(s.receivedBytes, s.declaredBytes),
    state: s.state,
    reject_reason: s.rejectReason,
    asset_id: s.assetId,
    expires_at: s.expiresAt.toISOString(),
    created_at: s.createdAt.toISOString(),
  };
}

export async function getUploadSessionView(db: DbOrTx, ownerId: string, id: string): Promise<UploadSessionView | null> {
  const s = await getUploadSession(db, ownerId, id);
  if (!s) return null;
  const chunks = await listChunkRows(db, ownerId, s.id);
  return uploadSessionView(
    s,
    chunks.map((c) => c.index),
  );
}

// ---- 생성 ----

export async function createUploadSession(db: Db, ownerId: string, plan: UploadPlan, now: Date = new Date()): Promise<UploadSessionRow> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(uploadSessions)
      .values({
        ownerId,
        kind: plan.kind,
        declaredMime: plan.mime,
        declaredBytes: plan.bytes,
        chunkSize: plan.chunkSize,
        checksumExpected: plan.sha256,
        state: 'open',
        expiresAt: new Date(now.getTime() + UPLOAD_SESSION_TTL_MS),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const s = rows[0]!;
    await recordAudit(tx, {
      ownerId,
      action: 'upload.session_create',
      entity: 'upload_session',
      entityId: s.id,
      details: { kind: plan.kind, mime: plan.mime, bytes: plan.bytes, chunks: plan.chunks },
      at: now,
    });
    return s;
  });
}

function assertOpen(s: UploadSessionRow, now: Date): void {
  if (s.state !== 'open') {
    throw new AppError('conflict', 'upload_not_open', `이 업로드 세션은 더 이상 조각을 받지 않습니다(상태: ${s.state})`, { state: s.state });
  }
  if (s.expiresAt.getTime() <= now.getTime()) {
    throw new AppError('conflict', 'upload_expired', '업로드 세션이 만료되었습니다(24시간). 새 세션으로 다시 올리세요.', { state: 'expired' });
  }
}

// ---- 조각 ----

export interface PutChunkResult {
  duplicate: boolean;
  session: UploadSessionRow;
  index: number;
  sha256: string;
}

export async function putUploadChunk(
  db: Db,
  store: UploadStore,
  ownerId: string,
  sessionId: string,
  index: number,
  bytes: Uint8Array,
  now: Date = new Date(),
  /** 기록 전에 sha256 을 확인하는 콜백(예: 클라이언트가 보낸 x-chunk-sha256). 던지면 아무것도 쓰지 않는다. */
  verify?: (sha256: string) => void,
): Promise<PutChunkResult> {
  const sha = createHash('sha256').update(bytes).digest('hex');
  verify?.(sha);
  return db.transaction(async (tx) => {
    const s = await lockSession(tx, ownerId, sessionId);
    if (!s) throw new NotFoundError(NOT_FOUND);
    assertOpen(s, now);
    const expected = expectedChunkBytes(s.declaredBytes, s.chunkSize, index);
    if (expected === null) {
      throw new AppError('bad_request', 'chunk_index_out_of_range', `조각 번호가 범위를 벗어났습니다(0 ~ ${chunkCount(s.declaredBytes, s.chunkSize) - 1})`);
    }
    if (bytes.byteLength !== expected) {
      throw new AppError('bad_request', 'chunk_size_mismatch', `이 조각은 정확히 ${expected} 바이트여야 합니다`, { expected_bytes: expected });
    }
    const existing = (
      await tx
        .select()
        .from(uploadChunks)
        .where(and(eq(uploadChunks.sessionId, s.id), eq(uploadChunks.ownerId, ownerId), eq(uploadChunks.chunkIndex, index)))
        .limit(1)
    )[0];
    if (existing) {
      if (existing.sha256 !== sha) {
        throw new AppError('conflict', 'chunk_mismatch', '같은 번호의 조각을 이미 다른 내용으로 받았습니다. 받은 조각은 바꾸지 않습니다.', {
          index,
        });
      }
      // 멱등 재전송. 파일이 사라졌으면(수동 삭제 등) 같은 내용으로 다시 둔다.
      if (!(await store.chunkExists(ownerId, s.id, index))) await store.writeChunk(ownerId, s.id, index, bytes);
      return { duplicate: true, session: s, index, sha256: sha };
    }
    await store.writeChunk(ownerId, s.id, index, bytes);
    await tx.insert(uploadChunks).values({ ownerId, sessionId: s.id, chunkIndex: index, bytes: bytes.byteLength, sha256: sha, createdAt: now });
    const updated = await tx
      .update(uploadSessions)
      .set({ receivedBytes: sql`${uploadSessions.receivedBytes} + ${bytes.byteLength}`, updatedAt: now })
      .where(and(eq(uploadSessions.id, s.id), eq(uploadSessions.ownerId, ownerId)))
      .returning();
    return { duplicate: false, session: updated[0]!, index, sha256: sha };
  });
}

// ---- 완료 ----

interface Assembled {
  file: string;
  bytes: number;
  sha256: string;
  head: Uint8Array;
}

/** 조각을 번호 순서로 스트림으로 이어 붙인다. 조각 파일이 없거나 조각 sha256 이 기록과 다르면 null. */
async function assemble(
  store: UploadStore,
  ownerId: string,
  sessionId: string,
  chunks: ReadonlyArray<{ index: number; sha256: string }>,
): Promise<Assembled | null> {
  const dir = store.dirFor(ownerId, sessionId);
  const file = path.join(/*turbopackIgnore: true*/ dir, 'assembled.part');
  const whole = createHash('sha256');
  const head = new Uint8Array(SNIFF_HEAD_BYTES);
  let headLen = 0;
  let total = 0;
  const fh = await open(/*turbopackIgnore: true*/ file, 'w');
  try {
    for (const c of chunks) {
      const part = createHash('sha256');
      try {
        for await (const buf of createReadStream(/*turbopackIgnore: true*/ store.chunkPath(ownerId, sessionId, c.index))) {
          const b = buf as Buffer;
          part.update(b);
          whole.update(b);
          if (headLen < SNIFF_HEAD_BYTES) {
            const take = Math.min(SNIFF_HEAD_BYTES - headLen, b.byteLength);
            head.set(b.subarray(0, take), headLen);
            headLen += take;
          }
          total += b.byteLength;
          await fh.write(b);
        }
      } catch {
        return null;
      }
      if (part.digest('hex') !== c.sha256) return null;
    }
  } finally {
    await fh.close();
  }
  return { file, bytes: total, sha256: whole.digest('hex'), head: head.subarray(0, headLen) };
}

export interface CompleteResult {
  session: UploadSessionRow;
  asset: AssetRow;
  duplicate: boolean;
}

async function rejectSession(db: Db, store: UploadStore, s: UploadSessionRow, reason: UploadRejectReason, actual: string | null, now: Date): Promise<never> {
  await db.transaction(async (tx) => {
    await tx.delete(uploadChunks).where(and(eq(uploadChunks.sessionId, s.id), eq(uploadChunks.ownerId, s.ownerId)));
    await tx
      .update(uploadSessions)
      .set({ state: 'rejected', rejectReason: reason, checksumActual: actual, updatedAt: now })
      .where(and(eq(uploadSessions.id, s.id), eq(uploadSessions.ownerId, s.ownerId)));
    await recordAudit(tx, { ownerId: s.ownerId, action: 'upload.reject', entity: 'upload_session', entityId: s.id, versionOrHash: actual, details: { reason }, at: now });
  });
  await store.removeSession(s.ownerId, s.id);
  throw new UploadRejectedError(reason);
}

async function finishVerified(tx: DbOrTx, s: UploadSessionRow, asset: AssetRow, sha: string, now: Date, duplicate: boolean): Promise<UploadSessionRow> {
  await tx.delete(uploadChunks).where(and(eq(uploadChunks.sessionId, s.id), eq(uploadChunks.ownerId, s.ownerId)));
  const rows = await tx
    .update(uploadSessions)
    .set({ state: 'verified', assetId: asset.id, checksumActual: sha, updatedAt: now })
    .where(and(eq(uploadSessions.id, s.id), eq(uploadSessions.ownerId, s.ownerId)))
    .returning();
  await recordAudit(tx, {
    ownerId: s.ownerId,
    action: 'upload.complete',
    entity: 'upload_session',
    entityId: s.id,
    versionOrHash: sha,
    details: { asset_duplicate: duplicate, mime: asset.mime, bytes: asset.bytes },
    at: now,
  });
  return rows[0]!;
}

export async function completeUploadSession(
  db: Db,
  store: UploadStore,
  files: AssetFileStore,
  ownerId: string,
  sessionId: string,
  now: Date = new Date(),
): Promise<CompleteResult> {
  // 1) 잠금 아래 상태 확인·open → completed(동시 완료는 하나만 진행)
  const claimed = await db.transaction(async (tx) => {
    const s = await lockSession(tx, ownerId, sessionId);
    if (!s) throw new NotFoundError(NOT_FOUND);
    if (s.state === 'verified' && s.assetId) {
      const a = (await tx.select().from(assets).where(and(eq(assets.id, s.assetId), eq(assets.ownerId, ownerId))).limit(1))[0]!;
      return { done: { session: s, asset: a, duplicate: false } as CompleteResult };
    }
    if (s.state === 'rejected') {
      throw new AppError('conflict', 'upload_rejected', '이미 거부된 업로드 세션입니다. 새 세션으로 다시 올리세요.', { reason: s.rejectReason });
    }
    if (s.state === 'completed') throw new AppError('conflict', 'upload_in_progress', '이 세션은 이미 완료 처리 중입니다');
    assertOpen(s, now);
    const chunks = await listChunkRows(tx, ownerId, s.id);
    const total = chunkCount(s.declaredBytes, s.chunkSize);
    const gaps = missingChunks(
      total,
      chunks.map((c) => c.index),
    );
    if (gaps.next !== null) {
      throw new AppError('conflict', 'upload_incomplete', `아직 받지 못한 조각이 있습니다(${total - chunks.length}개)`, {
        next_index: gaps.next,
        missing_indexes: gaps.missing,
      });
    }
    const rows = await tx
      .update(uploadSessions)
      .set({ state: 'completed', updatedAt: now })
      .where(and(eq(uploadSessions.id, s.id), eq(uploadSessions.ownerId, ownerId), eq(uploadSessions.state, 'open')))
      .returning();
    return { session: rows[0]!, chunks };
  });
  if ('done' in claimed) return claimed.done!;
  const s = claimed.session!;

  // 2) 트랜잭션 밖에서 스트림 조립·검사
  let built: Assembled | null;
  try {
    built = await assemble(store, ownerId, s.id, claimed.chunks!);
  } catch {
    built = null;
  }
  if (!built) return rejectSession(db, store, s, 'assembly_failed', null, now);
  if (built.bytes !== s.declaredBytes) return rejectSession(db, store, s, 'size_mismatch', built.sha256, now);
  const family = sniffMedia(built.head);
  if (family === null) return rejectSession(db, store, s, 'unsupported_signature', built.sha256, now);
  if (!mediaMatches(s.declaredMime as MediaMime, family)) return rejectSession(db, store, s, 'mime_mismatch', built.sha256, now);
  if (s.checksumExpected && s.checksumExpected !== built.sha256) return rejectSession(db, store, s, 'checksum_mismatch', built.sha256, now);

  // 3) asset: 같은 owner 의 같은 checksum 이 있으면 그 asset(지워진 원본이면 이 파일로 되살림), 없으면 새로 만든다.
  const sha = built.sha256;
  try {
    const existing = (await db.select().from(assets).where(and(eq(assets.ownerId, ownerId), eq(assets.checksum, sha))).limit(1))[0];
    if (existing) {
      const out = await db.transaction(async (tx) => {
        const a = (await tx.select().from(assets).where(and(eq(assets.id, existing.id), eq(assets.ownerId, ownerId))).for('update'))[0]!;
        let asset = a;
        if (a.deletedAt !== null || !(await files.exists(a.key))) {
          await files.putFile(a.key, built.file);
          const rows = await tx.update(assets).set({ deletedAt: null }).where(and(eq(assets.id, a.id), eq(assets.ownerId, ownerId))).returning();
          asset = rows[0]!;
          await recordAudit(tx, { ownerId, action: 'asset.restore', entity: 'asset', entityId: a.id, versionOrHash: sha, details: { via: 'upload_session' }, at: now });
        }
        const session = await finishVerified(tx, s, asset, sha, now, true);
        return { session, asset, duplicate: true };
      });
      return out;
    }
    const id = randomUUID();
    const key = buildAssetKey(ownerId, id);
    await files.putFile(key, built.file);
    try {
      return await db.transaction(async (tx) => {
        const rows = await tx
          .insert(assets)
          .values({
            id,
            ownerId,
            key,
            mime: s.declaredMime,
            bytes: built.bytes,
            checksum: sha,
            rightsStatus: 'unknown',
            verificationState: 'VERIFIED',
            verificationScope: VERIFICATION_SCOPE,
            createdAt: now,
          })
          .returning();
        const asset = rows[0]!;
        await recordAudit(tx, {
          ownerId,
          action: 'asset.upload',
          entity: 'asset',
          entityId: asset.id,
          versionOrHash: sha,
          details: { mime: asset.mime, bytes: asset.bytes, via: 'upload_session' },
          at: now,
        });
        const session = await finishVerified(tx, s, asset, sha, now, false);
        return { session, asset, duplicate: false };
      });
    } catch (e) {
      await files.delete(key).catch(() => undefined);
      throw e;
    }
  } catch (e) {
    // asset 기록에 실패하면 세션을 open 으로 되돌려 같은 조각으로 다시 완료할 수 있게 한다(조각은 그대로).
    await db
      .update(uploadSessions)
      .set({ state: 'open', updatedAt: now })
      .where(and(eq(uploadSessions.id, s.id), eq(uploadSessions.ownerId, ownerId), eq(uploadSessions.state, 'completed')));
    throw e;
  } finally {
    await rm(/*turbopackIgnore: true*/ built.file, { force: true }).catch(() => undefined);
    const after = await getUploadSession(db, ownerId, s.id);
    if (after && after.state === 'verified') await store.removeSession(ownerId, s.id).catch(() => undefined);
  }
}

// ---- 중단·만료 ----

export async function abortUploadSession(db: Db, store: UploadStore, ownerId: string, sessionId: string, now: Date = new Date()): Promise<UploadSessionRow> {
  const s = await db.transaction(async (tx) => {
    const row = await lockSession(tx, ownerId, sessionId);
    if (!row) throw new NotFoundError(NOT_FOUND);
    if (row.state !== 'open') throw new AppError('conflict', 'upload_not_open', `이 업로드 세션은 중단할 수 없습니다(상태: ${row.state})`, { state: row.state });
    await tx.delete(uploadChunks).where(and(eq(uploadChunks.sessionId, row.id), eq(uploadChunks.ownerId, ownerId)));
    const rows = await tx
      .update(uploadSessions)
      .set({ state: 'aborted', updatedAt: now })
      .where(and(eq(uploadSessions.id, row.id), eq(uploadSessions.ownerId, ownerId)))
      .returning();
    await recordAudit(tx, { ownerId, action: 'upload.abort', entity: 'upload_session', entityId: row.id, at: now });
    return rows[0]!;
  });
  await store.removeSession(ownerId, s.id);
  return s;
}

/** worker: 만료된 open·completed 세션을 expired 로 바꾸고 조각(행·파일)을 지운다. 처리한 세션 수. */
export async function expireUploadSessions(db: Db, store: UploadStore, now: Date = new Date(), limit = 100): Promise<number> {
  const due = await db
    .select({ id: uploadSessions.id, ownerId: uploadSessions.ownerId })
    .from(uploadSessions)
    .where(and(inArray(uploadSessions.state, ['open', 'completed']), lte(uploadSessions.expiresAt, now)))
    .orderBy(asc(uploadSessions.expiresAt))
    .limit(limit);
  let n = 0;
  for (const d of due) {
    const changed = await db.transaction(async (tx) => {
      const rows = await tx
        .update(uploadSessions)
        .set({ state: 'expired', updatedAt: now })
        .where(
          and(
            eq(uploadSessions.id, d.id),
            eq(uploadSessions.ownerId, d.ownerId),
            inArray(uploadSessions.state, ['open', 'completed']),
            lte(uploadSessions.expiresAt, now),
          ),
        )
        .returning({ id: uploadSessions.id });
      if (!rows[0]) return false;
      await tx.delete(uploadChunks).where(and(eq(uploadChunks.sessionId, d.id), eq(uploadChunks.ownerId, d.ownerId)));
      await recordAudit(tx, { ownerId: d.ownerId, action: 'upload.expire', entity: 'upload_session', entityId: d.id, at: now });
      return true;
    });
    if (changed) {
      await store.removeSession(d.ownerId, d.id).catch(() => undefined);
      n++;
    }
  }
  return n;
}
