/**
 * T08 음성 전사 job·전사 버전(결정 D9·D15). 기본 모의 전사기 — 외부 호출 없음.
 *
 * - 요청: asset 행 잠금 → 형식·검증 상태·진행 중 job 확인 → 비용 예약(T07 과 같은 원장·통화·상한) → job(queued) + 원장(reserved).
 *   예약이 거부되면(409·429) 아무것도 남지 않는다.
 * - worker tick(inline): 한 번에 한 단계 — queued → running(25) → 50 → 75 → 전사 → succeeded(100, transcripts v1, 원장 확정).
 *   전사기는 트랜잭션 밖에서 부르고, 결과는 job 을 다시 잠가 "아직 running" 일 때만 기록한다(그 사이 취소되면 버림).
 *   실패: job failed + 원장은 예약액 전액 확정(failed=true, T07 규칙). asset 은 건드리지 않는다.
 * - 취소: queued → canceled(원장 released, 0) / running → canceled(원장 예약액 확정, failed=true — 이미 처리 중이었을 수 있음).
 * - keep_original=false: 성공 뒤 asset.deleted_at 을 기록하고 파일을 지운다(메타데이터는 남음, 다운로드 410).
 *   채널 초안에 첨부된 파일은 지우지 않는다(요청 시 409, 처리 시에도 다시 확인).
 * - 전사 버전은 불변(추가 전용). 사용자 수정은 base_version 이 최신일 때만 새 버전(아니면 409 stale_transcript).
 * 모든 조회·변경은 owner_id 를 WHERE 에 넣는다(다른 owner → 404).
 */
import { and, asc, desc, eq, inArray, max, sql } from 'drizzle-orm';
import {
  AppError,
  BadRequestError,
  contentHash,
  estimateAudioSeconds,
  GoneError,
  isTranscribableMime,
  isUuid,
  MAX_RAW_TEXT,
  MOCK_TRANSCRIPT_WARNING,
  NotFoundError,
  sttCostMicro,
  sttReserveFor,
  toMicro,
  TRANSCRIPTION_STEP,
  UnsupportedMediaError,
  type SttBudgetPolicy,
  type TranscriptSegment,
} from '@cs/domain';
import type { Db } from './client';
import {
  getSttLedger,
  insertReservedSttLedger,
  releaseLedger,
  reserveMicroOrThrow,
  settleLedgerFailed,
  settleSttLedgerSucceeded,
} from './budget';
import { cleanupPendingDelete } from './asset-cleanup';
import { recordAudit, type DbOrTx } from './queries';
import { assets, captureRevisions, captures, transcriptionJobs, transcripts, variantAssets } from './schema';

export type TranscriptionJobRow = typeof transcriptionJobs.$inferSelect;
export type TranscriptRow = typeof transcripts.$inferSelect;

const JOB_NOT_FOUND = '전사 작업을 찾을 수 없습니다';
const TRANSCRIPT_NOT_FOUND = '전사 본문을 찾을 수 없습니다';
const ASSET_NOT_FOUND = '파일을 찾을 수 없습니다';

/** worker 가 쓰는 전사기(@cs/providers Transcriber 가 만족). */
export interface TranscriberLike {
  readonly name: string;
  readonly mode: 'mock' | 'live';
  readonly model: string;
  transcribe(input: { assetId: string; checksum: string; mime: string; audioSeconds: number }): Promise<{
    text: string;
    segments: TranscriptSegment[];
    audioSeconds: number;
    warnings: string[];
  }>;
}

/** 원본 삭제에 필요한 저장소 부분 */
export interface AssetDeleter {
  delete(key: string): Promise<void>;
}

async function assetInUse(tx: DbOrTx, ownerId: string, assetId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: variantAssets.id })
    .from(variantAssets)
    .where(and(eq(variantAssets.assetId, assetId), eq(variantAssets.ownerId, ownerId)))
    .limit(1);
  return rows.length > 0;
}

// ---- 요청 ----

export interface RequestTranscriptionInput {
  durationSeconds?: number;
  keepOriginal: boolean;
  policy: SttBudgetPolicy;
  model: string;
  now?: Date;
}

export async function requestTranscription(db: Db, ownerId: string, assetId: string, input: RequestTranscriptionInput): Promise<TranscriptionJobRow> {
  if (!isUuid(assetId)) throw new NotFoundError(ASSET_NOT_FOUND);
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const asset = (await tx.select().from(assets).where(and(eq(assets.id, assetId), eq(assets.ownerId, ownerId))).for('update'))[0];
    if (!asset) throw new NotFoundError(ASSET_NOT_FOUND);
    if (asset.deletedAt !== null) throw new GoneError();
    if (!isTranscribableMime(asset.mime)) throw new UnsupportedMediaError('전사할 수 있는 음성·영상 파일이 아닙니다');
    if (asset.verificationState !== 'VERIFIED') {
      throw new AppError('conflict', 'asset_not_verified', '서버 확인(VERIFIED)이 끝난 파일만 전사할 수 있습니다');
    }
    if (!input.keepOriginal && (await assetInUse(tx, ownerId, asset.id))) {
      throw new AppError('conflict', 'asset_in_use', '채널 초안에 첨부된 파일은 원본을 지울 수 없습니다. 원음 보존을 켜고 다시 요청하세요.');
    }
    const active = await tx
      .select({ id: transcriptionJobs.id })
      .from(transcriptionJobs)
      .where(and(eq(transcriptionJobs.assetId, asset.id), eq(transcriptionJobs.ownerId, ownerId), inArray(transcriptionJobs.state, ['queued', 'running'])))
      .limit(1);
    if (active[0]) {
      throw new AppError('conflict', 'transcription_in_progress', '이 파일의 전사 작업이 이미 진행 중입니다', { job_id: active[0].id });
    }
    const seconds = estimateAudioSeconds(asset.bytes, input.durationSeconds);
    const reservation = sttReserveFor(input.policy, seconds, input.durationSeconds === undefined);
    await reserveMicroOrThrow(tx, ownerId, input.policy, reservation.reserveMicro, now);
    const rows = await tx
      .insert(transcriptionJobs)
      .values({
        ownerId,
        assetId: asset.id,
        state: 'queued',
        provider: input.policy.mode === 'mock' ? 'mock' : 'live',
        model: input.model,
        progress: 0,
        keepOriginal: input.keepOriginal,
        audioSeconds: seconds,
        createdAt: now,
      })
      .returning();
    const job = rows[0]!;
    await insertReservedSttLedger(tx, ownerId, job.id, input.policy.currency, reservation, now);
    await recordAudit(tx, {
      ownerId,
      action: 'transcription.request',
      entity: 'transcription_job',
      entityId: job.id,
      versionOrHash: asset.checksum,
      details: { provider: job.provider, audio_seconds: seconds, keep_original: input.keepOriginal },
      at: now,
    });
    return job;
  });
}

// ---- 조회 ----

export async function getTranscriptionJob(db: DbOrTx, ownerId: string, id: string): Promise<TranscriptionJobRow | null> {
  if (!isUuid(id)) return null;
  const rows = await db
    .select()
    .from(transcriptionJobs)
    .where(and(eq(transcriptionJobs.id, id), eq(transcriptionJobs.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listTranscriptionJobs(db: DbOrTx, ownerId: string, opts: { assetId?: string; limit?: number } = {}): Promise<TranscriptionJobRow[]> {
  const where = opts.assetId
    ? and(eq(transcriptionJobs.ownerId, ownerId), eq(transcriptionJobs.assetId, opts.assetId))
    : eq(transcriptionJobs.ownerId, ownerId);
  return db
    .select()
    .from(transcriptionJobs)
    .where(where)
    .orderBy(desc(transcriptionJobs.createdAt), asc(transcriptionJobs.id))
    .limit(opts.limit ?? 50);
}

export async function listTranscriptVersions(db: DbOrTx, ownerId: string, jobId: string): Promise<TranscriptRow[]> {
  return db
    .select()
    .from(transcripts)
    .where(and(eq(transcripts.jobId, jobId), eq(transcripts.ownerId, ownerId)))
    .orderBy(asc(transcripts.version));
}

export async function getTranscript(db: DbOrTx, ownerId: string, id: string): Promise<TranscriptRow | null> {
  if (!isUuid(id)) return null;
  const rows = await db
    .select()
    .from(transcripts)
    .where(and(eq(transcripts.id, id), eq(transcripts.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

export function transcriptView(t: TranscriptRow) {
  return {
    id: t.id,
    job_id: t.jobId,
    version: t.version,
    text: t.text,
    segments: t.segments,
    created_by: t.createdBy,
    created_at: t.createdAt.toISOString(),
  };
}

export async function transcriptionJobView(db: DbOrTx, ownerId: string, j: TranscriptionJobRow) {
  const versions = await listTranscriptVersions(db, ownerId, j.id);
  const latest = versions.at(-1) ?? null;
  return {
    id: j.id,
    asset_id: j.assetId,
    state: j.state,
    provider: j.provider,
    model: j.model,
    progress: j.progress,
    audio_seconds: j.audioSeconds,
    keep_original: j.keepOriginal,
    attempts: j.attempts,
    error: j.error,
    transcript_version_id: j.transcriptVersionId,
    latest_transcript: latest ? transcriptView(latest) : null,
    versions: versions.map((v) => ({ id: v.id, version: v.version, created_by: v.createdBy, created_at: v.createdAt.toISOString() })),
    mock: j.provider === 'mock',
    /** 모의 전사는 실제 음성 인식이 아니다 — 화면·응답에 항상 표시 */
    mock_warning: j.provider === 'mock' ? MOCK_TRANSCRIPT_WARNING : null,
    created_at: j.createdAt.toISOString(),
    started_at: j.startedAt?.toISOString() ?? null,
    finished_at: j.finishedAt?.toISOString() ?? null,
  };
}

// ---- 취소 ----

export async function cancelTranscriptionJob(db: Db, ownerId: string, id: string, now: Date = new Date()): Promise<TranscriptionJobRow> {
  if (!isUuid(id)) throw new NotFoundError(JOB_NOT_FOUND);
  return db.transaction(async (tx) => {
    const job = (await tx.select().from(transcriptionJobs).where(and(eq(transcriptionJobs.id, id), eq(transcriptionJobs.ownerId, ownerId))).for('update'))[0];
    if (!job) throw new NotFoundError(JOB_NOT_FOUND);
    if (job.state !== 'queued' && job.state !== 'running') {
      throw new AppError('conflict', 'job_not_cancelable', `이미 끝난 전사 작업입니다(상태: ${job.state})`, { state: job.state });
    }
    const ledger = await getSttLedger(tx, ownerId, job.id);
    if (ledger && ledger.state === 'reserved') {
      if (job.state === 'queued') await releaseLedger(tx, ownerId, ledger, now);
      else await settleLedgerFailed(tx, ownerId, ledger, now);
    }
    const rows = await tx
      .update(transcriptionJobs)
      .set({ state: 'canceled', finishedAt: now, error: job.state === 'running' ? '처리 중 취소됨' : '시작 전 취소됨' })
      .where(and(eq(transcriptionJobs.id, job.id), eq(transcriptionJobs.ownerId, ownerId)))
      .returning();
    await recordAudit(tx, {
      ownerId,
      action: 'transcription.cancel',
      entity: 'transcription_job',
      entityId: job.id,
      details: { from: job.state, ledger: job.state === 'queued' ? 'released' : 'settled_reserved' },
      at: now,
    });
    return rows[0]!;
  });
}

// ---- worker ----

export interface AdvanceResult {
  advanced: number;
  succeeded: number;
  failed: number;
  originalsDeleted: number;
}

function failureMessage(e: unknown): string {
  const name = e instanceof Error ? e.name : 'Error';
  return name === 'MockTranscriberFailure' ? '전사 실패(모의 실패 주입)' : `전사 실패(${name})`;
}

/** 원장 스냅숏의 1분 가격으로 실제액 계산(설정이 바뀌어도 예약 때 가격으로 확정). */
function actualFromSnapshot(snapshot: Record<string, unknown>, currency: string, seconds: number): bigint {
  const per = snapshot.per_minute;
  if (typeof per !== 'string') return 0n;
  return sttCostMicro({ currency, perMinuteMicro: toMicro(per) }, seconds);
}

/**
 * FIX-T08 round 2(P0): **의도 먼저**. asset 행 잠금 아래 첨부 없음을 다시 확인하고 deleted_at + pending_delete_key(=현재 key)를
 * 커밋한 뒤, 커밋 밖에서 그 key 의 파일을 지우고 표시를 비운다(cleanupPendingDelete). 파일 삭제가 실패하거나 프로세스가 죽으면
 * 표시가 남아 worker(assets.cleanup)가 다시 지운다 — "파일은 없는데 asset 은 정상"인 상태가 생기지 않는다(다운로드는 deleted_at 으로 410).
 * 재업로드 복구는 같은 행 잠금 아래 **새 key** 로 쓰므로 늦은 삭제가 복구한 파일에 닿을 수 없다.
 * 첨부(setVariantAssets)도 같은 asset 행을 잠그고 deleted_at 을 다시 보므로 첨부와 삭제는 직렬화된다.
 * hooks.afterIntent: 테스트 주입(의도 커밋 직후, 파일 삭제 전 — 프로세스 중단 재현).
 */
export async function deleteOriginal(
  db: Db,
  files: AssetDeleter,
  job: Pick<TranscriptionJobRow, 'id' | 'ownerId' | 'assetId'>,
  now: Date,
  hooks: { afterIntent?: () => Promise<void> } = {},
): Promise<boolean> {
  // 앞선 삭제 의도(예: 복구로 바뀐 옛 key)가 남아 있으면 먼저 처리한다 — 표시 칸은 하나다.
  await cleanupPendingDelete(db, files, job.ownerId, job.assetId, now);
  const done = await db.transaction(async (tx) => {
    const a = (await tx.select().from(assets).where(and(eq(assets.id, job.assetId), eq(assets.ownerId, job.ownerId))).for('update'))[0];
    if (!a || a.deletedAt !== null) return null;
    if (a.pendingDeleteKey !== null && a.pendingDeleteKey !== a.key) {
      await recordAudit(tx, {
        ownerId: job.ownerId,
        action: 'asset.delete_original_skipped',
        entity: 'asset',
        entityId: a.id,
        details: { reason: 'cleanup_pending', job_id: job.id },
        at: now,
      });
      return null;
    }
    if (await assetInUse(tx, job.ownerId, a.id)) {
      await recordAudit(tx, {
        ownerId: job.ownerId,
        action: 'asset.delete_original_skipped',
        entity: 'asset',
        entityId: a.id,
        details: { reason: 'attached_to_variant', job_id: job.id },
        at: now,
      });
      return null;
    }
    await tx.update(assets).set({ deletedAt: now, pendingDeleteKey: a.key }).where(and(eq(assets.id, a.id), eq(assets.ownerId, job.ownerId)));
    await recordAudit(tx, { ownerId: job.ownerId, action: 'asset.delete_original', entity: 'asset', entityId: a.id, versionOrHash: a.checksum, details: { job_id: job.id }, at: now });
    return true;
  });
  if (done !== true) return false;
  await hooks.afterIntent?.();
  // 커밋 뒤 파일 삭제(실패해도 표시가 남아 worker 가 다시 시도)
  await cleanupPendingDelete(db, files, job.ownerId, job.assetId, now);
  return true;
}

/**
 * inline worker 한 번: 진행 중 job 을 한 단계씩 진행한다. transcriber.mode 와 provider 가 같은 job 만 처리(T08: mock).
 */
export async function advanceTranscriptionJobs(
  db: Db,
  opts: { transcriber: TranscriberLike; files?: AssetDeleter; now?: Date; limit?: number },
): Promise<AdvanceResult> {
  const now = opts.now ?? new Date();
  const res: AdvanceResult = { advanced: 0, succeeded: 0, failed: 0, originalsDeleted: 0 };
  const provider = opts.transcriber.mode === 'mock' ? 'mock' : 'live';
  const jobs = await db
    .select()
    .from(transcriptionJobs)
    .where(and(inArray(transcriptionJobs.state, ['queued', 'running']), eq(transcriptionJobs.provider, provider)))
    .orderBy(asc(transcriptionJobs.createdAt), asc(transcriptionJobs.id))
    .limit(opts.limit ?? 20);

  for (const job of jobs) {
    if (job.state === 'queued') {
      const r = await db
        .update(transcriptionJobs)
        .set({ state: 'running', progress: TRANSCRIPTION_STEP, startedAt: now, attempts: sql`${transcriptionJobs.attempts} + 1` })
        .where(and(eq(transcriptionJobs.id, job.id), eq(transcriptionJobs.ownerId, job.ownerId), eq(transcriptionJobs.state, 'queued')))
        .returning({ id: transcriptionJobs.id });
      if (r[0]) res.advanced++;
      continue;
    }
    if (job.progress < 100 - TRANSCRIPTION_STEP) {
      const r = await db
        .update(transcriptionJobs)
        .set({ progress: job.progress + TRANSCRIPTION_STEP })
        .where(
          and(
            eq(transcriptionJobs.id, job.id),
            eq(transcriptionJobs.ownerId, job.ownerId),
            eq(transcriptionJobs.state, 'running'),
            eq(transcriptionJobs.progress, job.progress),
          ),
        )
        .returning({ id: transcriptionJobs.id });
      if (r[0]) res.advanced++;
      continue;
    }

    // 마지막 단계: 전사(트랜잭션 밖)
    const asset = (await db.select().from(assets).where(and(eq(assets.id, job.assetId), eq(assets.ownerId, job.ownerId))).limit(1))[0];
    let output: Awaited<ReturnType<TranscriberLike['transcribe']>> | null = null;
    let error: unknown = null;
    try {
      if (!asset) throw new Error('asset 없음');
      output = await opts.transcriber.transcribe({ assetId: asset.id, checksum: asset.checksum, mime: asset.mime, audioSeconds: job.audioSeconds });
    } catch (e) {
      error = e;
    }
    const outcome = await db.transaction(async (tx) => {
      const cur = (await tx.select().from(transcriptionJobs).where(and(eq(transcriptionJobs.id, job.id), eq(transcriptionJobs.ownerId, job.ownerId))).for('update'))[0];
      if (!cur || cur.state !== 'running') return 'skipped' as const; // 그 사이 취소됨 → 결과를 버린다
      const ledger = await getSttLedger(tx, job.ownerId, job.id);
      if (output) {
        const inserted = await tx
          .insert(transcripts)
          .values({
            ownerId: job.ownerId,
            jobId: job.id,
            version: 1,
            text: output.text,
            segments: output.segments,
            createdBy: 'mock', // T08: 전사기는 모의뿐(live 어댑터 없음)
            createdAt: now,
          })
          .returning();
        const t = inserted[0]!;
        await tx
          .update(transcriptionJobs)
          .set({ state: 'succeeded', progress: 100, transcriptVersionId: t.id, finishedAt: now, error: null })
          .where(and(eq(transcriptionJobs.id, job.id), eq(transcriptionJobs.ownerId, job.ownerId)));
        if (ledger && ledger.state === 'reserved') {
          const actual = actualFromSnapshot(ledger.pricingSnapshot, ledger.currency, output.audioSeconds);
          await settleSttLedgerSucceeded(tx, job.ownerId, ledger, actual, output.audioSeconds, now);
        }
        await recordAudit(tx, {
          ownerId: job.ownerId,
          action: 'transcription.succeeded',
          entity: 'transcription_job',
          entityId: job.id,
          versionOrHash: t.id,
          details: { provider: job.provider, segments: output.segments.length },
          at: now,
        });
        return 'succeeded' as const;
      }
      await tx
        .update(transcriptionJobs)
        .set({ state: 'failed', finishedAt: now, error: failureMessage(error) })
        .where(and(eq(transcriptionJobs.id, job.id), eq(transcriptionJobs.ownerId, job.ownerId)));
      if (ledger && ledger.state === 'reserved') await settleLedgerFailed(tx, job.ownerId, ledger, now);
      await recordAudit(tx, {
        ownerId: job.ownerId,
        action: 'transcription.failed',
        entity: 'transcription_job',
        entityId: job.id,
        details: { provider: job.provider, error: error instanceof Error ? error.name : 'Error' },
        at: now,
      });
      return 'failed' as const;
    });
    if (outcome === 'succeeded') {
      res.succeeded++;
      // 원본 삭제의 파일 단계 실패는 pending_delete_key 로 남아 worker 가 다시 지운다(전사 결과와 별개).
      if (!job.keepOriginal && opts.files && (await deleteOriginal(db, opts.files, job, now).catch(() => false))) res.originalsDeleted++;
    } else if (outcome === 'failed') {
      res.failed++;
    }
  }
  return res;
}

// ---- 사용자 수정 ----

export async function createTranscriptVersion(
  db: Db,
  ownerId: string,
  transcriptId: string,
  input: { baseVersion: number; text: string },
  now: Date = new Date(),
): Promise<TranscriptRow> {
  if (!isUuid(transcriptId)) throw new NotFoundError(TRANSCRIPT_NOT_FOUND);
  return db.transaction(async (tx) => {
    const t = (await tx.select().from(transcripts).where(and(eq(transcripts.id, transcriptId), eq(transcripts.ownerId, ownerId))).limit(1))[0];
    if (!t) throw new NotFoundError(TRANSCRIPT_NOT_FOUND);
    // job 행을 잠가 같은 job 의 버전 추가를 직렬화한다.
    await tx.select({ id: transcriptionJobs.id }).from(transcriptionJobs).where(and(eq(transcriptionJobs.id, t.jobId), eq(transcriptionJobs.ownerId, ownerId))).for('update');
    const latest = (await tx.select({ v: max(transcripts.version) }).from(transcripts).where(and(eq(transcripts.jobId, t.jobId), eq(transcripts.ownerId, ownerId))))[0]?.v ?? 0;
    if (input.baseVersion !== latest) {
      throw new AppError('conflict', 'stale_transcript', '그 사이 전사 본문이 바뀌었습니다. 최신 버전을 불러와 다시 수정하세요.', {
        current_version: latest,
      });
    }
    const rows = await tx
      .insert(transcripts)
      .values({ ownerId, jobId: t.jobId, version: latest + 1, text: input.text, segments: [], createdBy: 'owner', createdAt: now })
      .returning();
    const created = rows[0]!;
    await recordAudit(tx, {
      ownerId,
      action: 'transcript.version_create',
      entity: 'transcript',
      entityId: created.id,
      versionOrHash: String(created.version),
      details: { job_id: t.jobId, chars: input.text.length },
      at: now,
    });
    return created;
  });
}

// ---- 소재로 보내기 ----

export async function transcriptToCapture(
  db: Db,
  ownerId: string,
  transcriptId: string,
  now: Date = new Date(),
): Promise<{ capture: typeof captures.$inferSelect; created: boolean }> {
  const t = await getTranscript(db, ownerId, transcriptId);
  if (!t) throw new NotFoundError(TRANSCRIPT_NOT_FOUND);
  if (t.text.length > MAX_RAW_TEXT) {
    throw new BadRequestError(`전사 본문이 소재 원문 한도(${MAX_RAW_TEXT}자)를 넘습니다. 나눠서 저장하세요.`);
  }
  const job = await getTranscriptionJob(db, ownerId, t.jobId);
  const commandKey = `transcript-${t.id}`;
  const find = async () =>
    (await db.select().from(captures).where(and(eq(captures.ownerId, ownerId), eq(captures.commandKey, commandKey))).limit(1))[0] ?? null;
  const existing = await find();
  if (existing) return { capture: existing, created: false };
  const hash = contentHash(t.text);
  const note = job?.provider === 'mock' ? '음성 전사(모의)' : '음성 전사';
  const created = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(captures)
      .values({
        ownerId,
        rawText: t.text,
        inputType: 'text',
        userNote: note,
        commandKey,
        contentHash: hash,
        captureTranscriptId: t.id,
        receivedAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [captures.ownerId, captures.commandKey] })
      .returning();
    const c = rows[0];
    if (!c) return null;
    await tx.insert(captureRevisions).values({
      captureId: c.id,
      ownerId,
      revision: c.revision,
      userNote: c.userNote,
      risk: c.risk,
      title: c.title,
      changedAt: c.updatedAt,
      changedBy: 'owner',
    });
    await recordAudit(tx, {
      ownerId,
      action: 'capture.create',
      entity: 'capture',
      entityId: c.id,
      versionOrHash: hash,
      details: { input_type: 'text', has_source: false, from_transcript: true },
      at: now,
    });
    await recordAudit(tx, { ownerId, action: 'transcript.to_capture', entity: 'transcript', entityId: t.id, details: { version: t.version }, at: now });
    return c;
  });
  if (created) return { capture: created, created: true };
  const winner = await find();
  if (!winner) throw new Error('전사 → 소재 저장 실패');
  return { capture: winner, created: false };
}
