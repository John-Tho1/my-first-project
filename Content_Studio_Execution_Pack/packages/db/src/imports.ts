/**
 * T18(제안 결정 D32) Notion·Drive 선택 가져오기 — 미리보기(원장만 기록) → 선택 확정(소재·출처·출처 버전 생성) | 취소.
 *
 * 불변식
 * - 미리보기는 captures·sources·source_versions·capture_revisions 에 쓰지 않는다(원장 import_runs·import_items 만).
 * - 확정은 미리보기를 믿지 않는다: 원본(올린 ZIP·모의 커넥터)을 다시 읽어 항목 checksum 이 미리보기와 같은지 보고, 판정도 트랜잭션 안에서 다시 한다.
 * - 기존 소재의 원문·제목·메모를 바꾸지 않는다. 같은 외부 항목을 다시 가져오면 동일(checksum 같음)은 건너뛰고(멱등),
 *   내용이 다르면 충돌 — 사용자가 그 항목을 "새 버전"으로 고른 때만 기존 출처에 source_version + 새 소재(그 출처에 연결)를 만든다. 덮어쓰기 없음.
 * - 모든 조회·변경은 owner 조건을 건다(A01). 원장에는 본문·자격 증명을 넣지 않는다.
 * - FIX-T18 round 1(Codex review-T18):
 *   (P0 :293) 확정한 항목의 원본 파일은 바이트 그대로 source_version_originals 에 남는다(출처 버전마다 하나, sha256 = raw_hash). 소재 원문은 파생 값(.html 은 추출 텍스트).
 *   (P1 :244) 확정 트랜잭션은 owner·공급자 단위 advisory lock 을 잡은 뒤 출처를 다시 읽어 판정한다 — 다른 실행의 동시 확정과 직렬화.
 *            그래도 부분 unique(sources_owner_import_external_uq) 에 걸리면(잠금 밖의 쓰기) savepoint 로 되돌리고 다시 읽어 동일·충돌로 판정한다(500 아님).
 *   (P1 web :122) 원장 기준으로 실제 쓰기를 일으키는 선택이 하나도 없으면 상태를 바꾸기 전에 400 import_nothing_selected. version_ids 는 충돌 항목만.
 * - FIX-T18 round 2(Codex review-FIX-T18 P1 captures/[id]:123): 0039 이전에 확정한 가져오기는 출처 버전에 원본 행이 없다. 같은 파일을 다시 올리면
 *   동일(identical) 항목 중 원본이 빠진 것만 "원본 보충"(backfill_ids)으로 고를 수 있고, 확정 때 잠금 뒤 다시 확인해 올린 바이트의
 *   sha256 = 그 버전 raw_hash 일 때만 source_version_originals 에 **추가**한다(트리거가 raw_hash·owner 를 다시 확인, 이후 UPDATE·DELETE 금지).
 *   소재·출처·출처 버전은 바꾸지 않는다. 원장 outcome = original_backfilled(target = 기존 출처·버전, 소재 없음).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  AppError,
  BadRequestError,
  contentHash,
  decideImportItem,
  effectiveImportChoice,
  isUuid,
  NotFoundError,
  originalBytes,
  type ExistingImportSource,
  type ImportOutcome,
  type ImportSelection,
  type ImportSourceKind,
  type ParsedImportItem,
  sha256Bytes,
} from '@cs/domain';
import type { Db } from './client';
import { recordAudit, type DbOrTx } from './queries';
import { captureRevisions, captures, importItems, importRuns, sources, sourceVersionOriginals, sourceVersions } from './schema';

export type ImportRunRow = typeof importRuns.$inferSelect;
export type ImportItemRow = typeof importItems.$inferSelect;

export class ImportAlreadyCommittedError extends AppError {
  constructor() {
    super('conflict', 'import_already_committed', '이미 확정한 가져오기입니다');
  }
}

export class ImportNotCommittableError extends AppError {
  constructor(status: string) {
    super('conflict', 'import_not_committable', '이 가져오기는 확정할 수 없는 상태입니다', { status });
  }
}

export class ImportFileMissingError extends AppError {
  constructor() {
    super('conflict', 'import_file_missing', '미리보기에 쓴 파일이 서버에 없습니다. 파일을 다시 올리세요.');
  }
}

export class ImportFileChangedError extends AppError {
  constructor() {
    super('conflict', 'import_file_changed', '미리보기 뒤 파일이 바뀌었습니다(checksum 불일치). 파일을 다시 올리세요.');
  }
}

/** 원장 판정용: (공급자, 외부 ID) → 기존 출처와 그 모든 버전 checksum. */
export async function findExistingImportSources(
  db: DbOrTx,
  ownerId: string,
  provider: ImportSourceKind,
  externalIds: readonly string[],
): Promise<Map<string, ExistingImportSource>> {
  const out = new Map<string, { sourceId: string; versionChecksums: Set<string> }>();
  for (let i = 0; i < externalIds.length; i += 500) {
    const ids = externalIds.slice(i, i + 500);
    if (!ids.length) continue;
    const rows = await db
      .select({ sourceId: sources.id, externalId: sources.externalId, rawHash: sourceVersions.rawHash })
      .from(sources)
      .leftJoin(sourceVersions, eq(sourceVersions.sourceId, sources.id))
      .where(and(eq(sources.ownerId, ownerId), eq(sources.externalProvider, provider), inArray(sources.externalId, ids)));
    for (const r of rows) {
      const key = r.externalId!;
      const e = out.get(key) ?? { sourceId: r.sourceId, versionChecksums: new Set<string>() };
      if (r.rawHash) e.versionChecksums.add(r.rawHash);
      out.set(key, e);
    }
  }
  return out;
}

export interface CreateImportPreviewInput {
  sourceKind: ImportSourceKind;
  fileName: string | null;
  fileChecksum: string | null;
  fileBytes: number | null;
  items: readonly ParsedImportItem[];
  attachments: number;
  /** 확정 전까지 둘 원본 파일(ZIP) 저장 — 원장 행과 같은 ID 로. 모의 커넥터는 없음. */
  saveFile?: (runId: string) => Promise<void>;
  removeFile?: (runId: string) => Promise<void>;
}

/** 미리보기: 원장(import_runs·import_items)만 쓴다. 소재·출처는 만들지 않는다. */
export async function createImportPreview(
  db: Db,
  ownerId: string,
  input: CreateImportPreviewInput,
): Promise<{ run: ImportRunRow; items: ImportItemRow[] }> {
  const existing = await findExistingImportSources(
    db,
    ownerId,
    input.sourceKind,
    input.items.map((i) => i.externalId),
  );
  const decided = input.items.map((i) => ({ item: i, decision: decideImportItem(i, existing.get(i.externalId)) }));
  const counts = { total: decided.length, new: 0, identical: 0, conflict: 0, skipped: 0, attachments: input.attachments };
  for (const d of decided) counts[d.decision]++;

  const id = randomUUID();
  if (input.saveFile) await input.saveFile(id);
  try {
    return await db.transaction(async (tx) => {
      const [run] = await tx
        .insert(importRuns)
        .values({
          id,
          ownerId,
          sourceKind: input.sourceKind,
          fileName: input.fileName,
          fileChecksum: input.fileChecksum,
          fileBytes: input.fileBytes,
          status: 'preview',
          counts,
        })
        .returning();
      const rows: ImportItemRow[] = [];
      for (let i = 0; i < decided.length; i += 200) {
        const chunk = decided.slice(i, i + 200).map(({ item, decision }) => ({
          ownerId,
          runId: id,
          externalId: item.externalId,
          externalPath: item.externalPath,
          folder: item.folder,
          title: item.title,
          format: item.format,
          contentChecksum: item.contentChecksum,
          byteSize: item.byteSize,
          externalCreatedText: item.externalCreatedText,
          decision,
          skipReason: decision === 'skipped' ? (item.skipReason ?? 'unsupported_type') : null,
          matchedSourceId: decision === 'identical' || decision === 'conflict' ? existing.get(item.externalId)!.sourceId : null,
        }));
        if (chunk.length) rows.push(...(await tx.insert(importItems).values(chunk).returning()));
      }
      await recordAudit(tx, {
        ownerId,
        action: 'import.preview',
        entity: 'import_run',
        entityId: id,
        versionOrHash: input.fileChecksum,
        // 파일 이름·경로·제목·본문은 기록하지 않는다(건수만).
        details: { source_kind: input.sourceKind, ...counts },
      });
      return { run: run!, items: rows };
    });
  } catch (e) {
    if (input.removeFile) await input.removeFile(id).catch(() => undefined);
    throw e;
  }
}

export async function getImportRun(db: DbOrTx, ownerId: string, id: string): Promise<ImportRunRow | null> {
  if (!isUuid(id)) return null;
  const rows = await db
    .select()
    .from(importRuns)
    .where(and(eq(importRuns.id, id), eq(importRuns.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listImportItems(db: DbOrTx, ownerId: string, runId: string): Promise<ImportItemRow[]> {
  if (!isUuid(runId)) return [];
  return db
    .select()
    .from(importItems)
    .where(and(eq(importItems.runId, runId), eq(importItems.ownerId, ownerId)))
    .orderBy(asc(importItems.externalPath), asc(importItems.id));
}

export async function listImportRuns(db: DbOrTx, ownerId: string, limit = 50): Promise<ImportRunRow[]> {
  return db
    .select()
    .from(importRuns)
    .where(eq(importRuns.ownerId, ownerId))
    .orderBy(desc(importRuns.createdAt), desc(importRuns.id))
    .limit(Math.min(Math.max(limit, 1), 200));
}

/** 미리보기 취소(원장에 canceled 로 남긴다). 소재·출처는 바뀌지 않는다. 파일 삭제는 호출자. */
export async function cancelImportRun(db: Db, ownerId: string, id: string, now: Date = new Date()): Promise<ImportRunRow> {
  const run = await getImportRun(db, ownerId, id.toLowerCase());
  if (!run) throw new NotFoundError('가져오기를 찾을 수 없습니다');
  if (run.status === 'committed') throw new ImportAlreadyCommittedError();
  if (run.status !== 'preview') throw new ImportNotCommittableError(run.status);
  const [row] = await db
    .update(importRuns)
    .set({ status: 'canceled', canceledAt: now })
    .where(and(eq(importRuns.id, run.id), eq(importRuns.ownerId, ownerId), eq(importRuns.status, 'preview')))
    .returning();
  if (!row) throw new ImportNotCommittableError('changed');
  await recordAudit(db, { ownerId, action: 'import.cancel', entity: 'import_run', entityId: run.id, details: { source_kind: run.sourceKind } });
  return row;
}

export type ImportCommitResult = Record<ImportOutcome, number> & { total: number };

/**
 * FIX-T18 round 2: 원본 행이 없는 출처 버전(owner 의 출처, 주어진 (출처, raw_hash) 쌍). 키 `<출처 ID>:<raw_hash>` → 버전 ID(오래된 순).
 */
async function versionsMissingOriginal(
  db: DbOrTx,
  ownerId: string,
  pairs: ReadonlyArray<{ sourceId: string; rawHash: string }>,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < pairs.length; i += 500) {
    const chunk = pairs.slice(i, i + 500);
    if (!chunk.length) continue;
    const wanted = new Set(chunk.map((p) => `${p.sourceId}:${p.rawHash}`));
    const rows = await db
      .select({ id: sourceVersions.id, sourceId: sourceVersions.sourceId, rawHash: sourceVersions.rawHash, original: sourceVersionOriginals.id })
      .from(sourceVersions)
      .innerJoin(sources, and(eq(sources.id, sourceVersions.sourceId), eq(sources.ownerId, ownerId)))
      .leftJoin(sourceVersionOriginals, eq(sourceVersionOriginals.sourceVersionId, sourceVersions.id))
      .where(
        and(
          inArray(sourceVersions.sourceId, [...new Set(chunk.map((p) => p.sourceId))]),
          inArray(sourceVersions.rawHash, [...new Set(chunk.map((p) => p.rawHash))]),
        ),
      )
      .orderBy(asc(sourceVersions.fetchedAt), asc(sourceVersions.id));
    for (const r of rows) {
      const key = `${r.sourceId}:${r.rawHash}`;
      if (r.original !== null || !wanted.has(key)) continue;
      out.set(key, [...(out.get(key) ?? []), r.id]);
    }
  }
  return out;
}

/**
 * FIX-T18 round 2: "원본 보충" 을 고를 수 있는 원장 항목 ID — 동일(identical) 판정이고, 맞는 출처의 같은 raw_hash 버전에 원본 행이 없는 것.
 * 미리보기 화면(체크 상자)과 확정 전 검사가 같은 함수를 쓴다.
 */
export async function listBackfillableImportItemIds(db: DbOrTx, ownerId: string, items: readonly ImportItemRow[]): Promise<Set<string>> {
  const cand = items.filter((i) => i.ownerId === ownerId && i.decision === 'identical' && i.matchedSourceId !== null && i.contentChecksum !== null);
  if (!cand.length) return new Set();
  const missing = await versionsMissingOriginal(
    db,
    ownerId,
    cand.map((i) => ({ sourceId: i.matchedSourceId!, rawHash: i.contentChecksum! })),
  );
  return new Set(cand.filter((i) => missing.has(`${i.matchedSourceId}:${i.contentChecksum}`)).map((i) => i.id));
}

/** 시험 전용 훅(운영 경로는 넘기지 않는다). */
export interface CommitImportHooks {
  /**
   * 새 출처 INSERT 직전(같은 트랜잭션, savepoint 밖). 다른 연결의 동시 확정이 같은 외부 항목의 출처를 먼저 커밋한 상황을
   * 흉내 내어 부분 unique 충돌 → 재판정 경로를 시험한다.
   */
  beforeSourceInsert?: (tx: DbOrTx, externalId: string) => Promise<void>;
}

const IMPORT_SOURCE_UNIQUE = 'sources_owner_import_external_uq';

/** PostgreSQL unique 위반(23505)의 제약 이름(드라이버·drizzle 오류의 cause 를 따라간다). */
function uniqueViolationConstraint(e: unknown): string | null {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    const c = cur as { code?: unknown; constraint?: unknown; cause?: unknown; message?: unknown };
    if (c.code === '23505') {
      if (typeof c.constraint === 'string') return c.constraint;
      if (typeof c.message === 'string' && c.message.includes(IMPORT_SOURCE_UNIQUE)) return IMPORT_SOURCE_UNIQUE;
      return '';
    }
    cur = c.cause;
  }
  return null;
}

/**
 * 선택 확정. loadItems 는 원본을 다시 읽어 항목(본문 포함)을 돌려준다(ZIP: 저장한 파일 + checksum 확인, 모의: 커넥터 재조회).
 * 선택: selection.itemIds ∪ (selection.folders 안의 항목). 충돌 항목은 selection.versionIds 에 있을 때만 새 버전.
 */
export async function commitImportRun(
  db: Db,
  ownerId: string,
  runId: string,
  selection: ImportSelection,
  loadItems: (run: ImportRunRow) => Promise<readonly ParsedImportItem[]>,
  now: Date = new Date(),
  hooks: CommitImportHooks = {},
): Promise<{ run: ImportRunRow; items: ImportItemRow[]; result: ImportCommitResult }> {
  const run = await getImportRun(db, ownerId, runId.toLowerCase());
  if (!run) throw new NotFoundError('가져오기를 찾을 수 없습니다');
  if (run.status === 'committed') throw new ImportAlreadyCommittedError();
  if (run.status !== 'preview') throw new ImportNotCommittableError(run.status);
  const ledger = await listImportItems(db, ownerId, run.id);
  const ledgerById = new Map(ledger.map((i) => [i.id, i]));
  for (const id of [...selection.itemIds, ...selection.versionIds]) {
    if (!ledgerById.has(id)) throw new BadRequestError('이 가져오기에 없는 항목을 골랐습니다');
  }
  // FIX-T18 round 1(Codex review-T18 P1 web :122): "새 버전" 은 충돌 항목만 고를 수 있다.
  for (const id of selection.versionIds) {
    if (ledgerById.get(id)!.decision !== 'conflict') {
      throw new AppError('bad_request', 'import_invalid_selection', '"새 버전으로 추가" 는 충돌 항목만 고를 수 있습니다');
    }
  }
  // FIX-T18 round 2(P1): "원본 보충" 은 원본이 빠진 동일 항목만 — 아니면 상태를 바꾸기 전에 400.
  const backfillIds = selection.backfillIds ?? new Set<string>();
  if (backfillIds.size) {
    for (const id of backfillIds) {
      if (!ledgerById.has(id)) throw new BadRequestError('이 가져오기에 없는 항목을 골랐습니다');
    }
    const ok = await listBackfillableImportItemIds(db, ownerId, ledger.filter((i) => backfillIds.has(i.id)));
    for (const id of backfillIds) {
      if (!ok.has(id)) throw new AppError('bad_request', 'import_invalid_selection', '"원본 보충" 은 원본 파일이 빠진 동일 항목만 고를 수 있습니다');
    }
  }
  // 원장 기준으로 실제 쓰기를 일으키는 선택이 하나도 없으면(없는 폴더·동일·건너뜀만 고름) 상태를 바꾸지 않고 거부한다 — 실행은 미리보기로 남고 ZIP 도 남는다.
  if (!ledger.some((i) => effectiveImportChoice(i, selection) !== null)) {
    throw new AppError('bad_request', 'import_nothing_selected', '가져올 항목을 하나 이상 고르세요(새 항목 또는 "새 버전으로 추가" 를 고른 충돌 항목)');
  }
  const parsed = new Map((await loadItems(run)).map((p) => [p.externalId, p]));

  const result = await db.transaction(async (tx) => {
    // 한 번만 확정: preview → committed 를 먼저 차지한다(동시 확정은 0행 → 409).
    const [claimed] = await tx
      .update(importRuns)
      .set({ status: 'committed', committedAt: now })
      .where(and(eq(importRuns.id, run.id), eq(importRuns.ownerId, ownerId), eq(importRuns.status, 'preview')))
      .returning();
    if (!claimed) throw new ImportAlreadyCommittedError();

    const provider = run.sourceKind as ImportSourceKind;
    // FIX-T18 round 1(P1 :244): 같은 owner·공급자의 확정을 직렬화한다. 잠금 뒤의 조회는 먼저 커밋된 다른 실행의 출처를 본다(READ COMMITTED 의 문장 스냅샷).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cs.import:${ownerId}:${provider}`}))`);
    const existing = await findExistingImportSources(tx, ownerId, provider, ledger.map((i) => i.externalId));
    const counts = {
      total: ledger.length,
      imported: 0,
      versioned: 0,
      skipped_identical: 0,
      skipped_unselected: 0,
      skipped_conflict: 0,
      skipped_unsupported: 0,
      failed_changed: 0,
      original_backfilled: 0,
    } satisfies ImportCommitResult;

    for (const item of ledger) {
      const choice = effectiveImportChoice(item, selection);
      const selected = selection.itemIds.has(item.id) || choice === 'import';
      const versionChosen = choice === 'version';
      let outcome: ImportOutcome;
      let target: { captureId: string | null; sourceId: string; sourceVersionId: string } | null = null;
      const p = parsed.get(item.externalId);
      if (item.decision === 'skipped') {
        outcome = 'skipped_unsupported';
      } else if (!p || p.contentChecksum !== item.contentChecksum || p.body === null || p.original === null) {
        outcome = 'failed_changed';
      } else {
        const cur = decideImportItem(p, existing.get(item.externalId));
        if (cur === 'skipped') outcome = 'skipped_unsupported';
        else if (cur === 'identical') outcome = choice === 'backfill' ? 'original_backfilled' : 'skipped_identical';
        else if (cur === 'new') outcome = selected ? 'imported' : 'skipped_unselected';
        else outcome = versionChosen ? 'versioned' : selected ? 'skipped_conflict' : 'skipped_unselected';

        let sourceId: string | null = null;
        if (outcome === 'original_backfilled') {
          // FIX-T18 round 2(P1): 잠금 뒤 다시 확인 — 그사이 다른 확정이 채웠으면 동일 건너뜀. 올린 바이트의 sha256 이 raw_hash 와 다르면 바뀜.
          const src = existing.get(item.externalId)!.sourceId;
          const raw = originalBytes(p.original);
          const missing = (await versionsMissingOriginal(tx, ownerId, [{ sourceId: src, rawHash: p.contentChecksum! }])).get(`${src}:${p.contentChecksum}`) ?? [];
          if (!missing.length) outcome = 'skipped_identical';
          else if (sha256Bytes(raw) !== p.contentChecksum) outcome = 'failed_changed';
          else {
            for (const versionId of missing) {
              // 추가만(0039 트리거: sha256 = 버전 raw_hash·owner = 출처 owner, 이후 UPDATE·DELETE 금지).
              await tx.insert(sourceVersionOriginals).values({
                sourceVersionId: versionId,
                ownerId,
                format: p.format,
                byteSize: raw.byteLength,
                sha256: p.contentChecksum!,
                contentBase64: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('base64'),
              });
            }
            target = { captureId: null, sourceId: src, sourceVersionId: missing[0]! };
          }
        } else if (outcome === 'imported') {
          await hooks.beforeSourceInsert?.(tx, item.externalId);
          try {
            // savepoint: unique 충돌이면 이 INSERT 만 되돌리고 트랜잭션은 이어 간다.
            const [src] = await tx.transaction(async (sp) =>
              sp
                .insert(sources)
                .values({
                  ownerId,
                  kind: provider,
                  externalProvider: provider,
                  externalId: item.externalId,
                  checkedAt: now,
                  contentHash: p.contentChecksum,
                })
                .returning(),
            );
            sourceId = src!.id;
          } catch (e) {
            if (uniqueViolationConstraint(e) !== IMPORT_SOURCE_UNIQUE) throw e;
            // 다른 쓰기가 같은 외부 항목의 출처를 먼저 만들었다 — 다시 읽어 판정(동일 → 건너뜀, 다르면 충돌 — 사용자가 고르지 않았으므로 덮어쓰지 않음).
            const again = (await findExistingImportSources(tx, ownerId, provider, [item.externalId])).get(item.externalId);
            if (again) existing.set(item.externalId, again);
            outcome = decideImportItem(p, again) === 'identical' ? 'skipped_identical' : 'skipped_conflict';
          }
        } else if (outcome === 'versioned') {
          sourceId = existing.get(item.externalId)!.sourceId;
        }
        if ((outcome === 'imported' || outcome === 'versioned') && sourceId !== null) {
          const [ver] = await tx
            .insert(sourceVersions)
            .values({ sourceId, rawHash: p.contentChecksum, fetchedAt: now, excerpt: null, extractionState: 'imported' })
            .returning();
          // FIX-T18 round 1(P0 :293): 원본 파일 그대로(바이트 = UTF-8(original), base64 로 보관, sha256 = raw_hash — DB CHECK·트리거가 다시 확인).
          const raw = originalBytes(p.original);
          await tx.insert(sourceVersionOriginals).values({
            sourceVersionId: ver!.id,
            ownerId,
            format: p.format,
            byteSize: raw.byteLength,
            sha256: p.contentChecksum!,
            contentBase64: Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('base64'),
          });
          const [cap] = await tx
            .insert(captures)
            .values({
              ownerId,
              rawText: p.body,
              inputType: 'file',
              sourceId,
              receivedAt: now,
              title: p.title,
              commandKey: `import-${item.id}`,
              contentHash: contentHash(p.body),
              updatedAt: now,
            })
            .returning();
          await tx.insert(captureRevisions).values({
            captureId: cap!.id,
            ownerId,
            revision: cap!.revision,
            userNote: null,
            risk: cap!.risk,
            title: cap!.title,
            changedAt: cap!.updatedAt,
            changedBy: 'owner',
          });
          await recordAudit(tx, {
            ownerId,
            action: 'capture.create',
            entity: 'capture',
            entityId: cap!.id,
            versionOrHash: cap!.contentHash,
            details: { input_type: 'file', has_source: true, import_run_id: run.id, import_outcome: outcome },
          });
          target = { captureId: cap!.id, sourceId, sourceVersionId: ver!.id };
          const e = existing.get(item.externalId);
          if (e) (e.versionChecksums as Set<string>).add(p.contentChecksum!);
          else existing.set(item.externalId, { sourceId, versionChecksums: new Set([p.contentChecksum!]) });
        }
      }
      counts[outcome]++;
      await tx
        .update(importItems)
        .set({
          outcome,
          targetCaptureId: target?.captureId ?? null,
          targetSourceId: target?.sourceId ?? null,
          targetSourceVersionId: target?.sourceVersionId ?? null,
        })
        .where(and(eq(importItems.id, item.id), eq(importItems.ownerId, ownerId)));
    }
    const [done] = await tx
      .update(importRuns)
      .set({ result: counts })
      .where(and(eq(importRuns.id, run.id), eq(importRuns.ownerId, ownerId)))
      .returning();
    await recordAudit(tx, {
      ownerId,
      action: 'import.commit',
      entity: 'import_run',
      entityId: run.id,
      versionOrHash: run.fileChecksum,
      details: { source_kind: run.sourceKind, ...counts },
    });
    return { run: done!, result: counts };
  });
  return { ...result, items: await listImportItems(db, ownerId, run.id) };
}

/** FIX-T18 round 1: 가져온 원본(출처 버전 하나). owner 조건 — 다른 owner 의 버전이면 null. */
export async function getSourceVersionOriginal(
  db: DbOrTx,
  ownerId: string,
  sourceVersionId: string,
): Promise<typeof sourceVersionOriginals.$inferSelect | null> {
  if (!isUuid(sourceVersionId)) return null;
  const rows = await db
    .select()
    .from(sourceVersionOriginals)
    .where(and(eq(sourceVersionOriginals.sourceVersionId, sourceVersionId), eq(sourceVersionOriginals.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

/** 소재 상세 표시용: 이 소재를 만든 가져오기(있으면). */
export async function getImportOriginForCapture(
  db: DbOrTx,
  ownerId: string,
  captureId: string,
): Promise<{
  runId: string;
  sourceKind: string;
  externalPath: string;
  externalCreatedText: string | null;
  outcome: string;
  committedAt: Date | null;
  sourceVersionId: string | null;
  format: string;
  /** FIX-T18 round 2(P1 captures/[id]:123): 그 출처 버전에 원본 행이 실제로 있는지(0039 이전 가져오기는 없음) — 받기 링크는 이때만. */
  hasOriginal: boolean;
} | null> {
  if (!isUuid(captureId)) return null;
  const rows = await db
    .select({
      runId: importItems.runId,
      sourceKind: importRuns.sourceKind,
      externalPath: importItems.externalPath,
      externalCreatedText: importItems.externalCreatedText,
      outcome: importItems.outcome,
      committedAt: importRuns.committedAt,
      sourceVersionId: importItems.targetSourceVersionId,
      format: importItems.format,
      originalId: sourceVersionOriginals.id,
    })
    .from(importItems)
    .innerJoin(importRuns, and(eq(importRuns.id, importItems.runId), eq(importRuns.ownerId, importItems.ownerId)))
    .leftJoin(
      sourceVersionOriginals,
      and(eq(sourceVersionOriginals.sourceVersionId, importItems.targetSourceVersionId), eq(sourceVersionOriginals.ownerId, importItems.ownerId)),
    )
    .where(and(eq(importItems.ownerId, ownerId), eq(importItems.targetCaptureId, captureId)))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const { originalId, ...rest } = r;
  return { ...rest, outcome: r.outcome ?? '', hasOriginal: originalId !== null };
}
