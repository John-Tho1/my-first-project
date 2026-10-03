/**
 * T18(제안 결정 D32) Notion·Drive 선택 가져오기 — 미리보기(원장만 기록) → 선택 확정(소재·출처·출처 버전 생성) | 취소.
 *
 * 불변식
 * - 미리보기는 captures·sources·source_versions·capture_revisions 에 쓰지 않는다(원장 import_runs·import_items 만).
 * - 확정은 미리보기를 믿지 않는다: 원본(올린 ZIP·모의 커넥터)을 다시 읽어 항목 checksum 이 미리보기와 같은지 보고, 판정도 트랜잭션 안에서 다시 한다.
 * - 기존 소재의 원문·제목·메모를 바꾸지 않는다. 같은 외부 항목을 다시 가져오면 동일(checksum 같음)은 건너뛰고(멱등),
 *   내용이 다르면 충돌 — 사용자가 그 항목을 "새 버전"으로 고른 때만 기존 출처에 source_version + 새 소재(그 출처에 연결)를 만든다. 덮어쓰기 없음.
 * - 모든 조회·변경은 owner 조건을 건다(A01). 원장에는 본문·자격 증명을 넣지 않는다.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  AppError,
  BadRequestError,
  contentHash,
  decideImportItem,
  inSelectedFolder,
  isUuid,
  NotFoundError,
  type ExistingImportSource,
  type ImportOutcome,
  type ImportSelection,
  type ImportSourceKind,
  type ParsedImportItem,
} from '@cs/domain';
import type { Db } from './client';
import { recordAudit, type DbOrTx } from './queries';
import { captureRevisions, captures, importItems, importRuns, sources, sourceVersions } from './schema';

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
): Promise<{ run: ImportRunRow; items: ImportItemRow[]; result: ImportCommitResult }> {
  const run = await getImportRun(db, ownerId, runId.toLowerCase());
  if (!run) throw new NotFoundError('가져오기를 찾을 수 없습니다');
  if (run.status === 'committed') throw new ImportAlreadyCommittedError();
  if (run.status !== 'preview') throw new ImportNotCommittableError(run.status);
  const ledger = await listImportItems(db, ownerId, run.id);
  const ledgerIds = new Set(ledger.map((i) => i.id));
  for (const id of [...selection.itemIds, ...selection.versionIds]) {
    if (!ledgerIds.has(id)) throw new BadRequestError('이 가져오기에 없는 항목을 골랐습니다');
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
    } satisfies ImportCommitResult;

    for (const item of ledger) {
      const selected = selection.itemIds.has(item.id) || (item.decision === 'new' && inSelectedFolder(item.folder, selection.folders));
      const versionChosen = selection.versionIds.has(item.id);
      let outcome: ImportOutcome;
      let target: { captureId: string; sourceId: string; sourceVersionId: string } | null = null;
      const p = parsed.get(item.externalId);
      if (item.decision === 'skipped') {
        outcome = 'skipped_unsupported';
      } else if (!p || p.contentChecksum !== item.contentChecksum || p.body === null) {
        outcome = 'failed_changed';
      } else {
        const cur = decideImportItem(p, existing.get(item.externalId));
        if (cur === 'skipped') outcome = 'skipped_unsupported';
        else if (cur === 'identical') outcome = 'skipped_identical';
        else if (cur === 'new') outcome = selected ? 'imported' : 'skipped_unselected';
        else outcome = versionChosen ? 'versioned' : selected ? 'skipped_conflict' : 'skipped_unselected';

        if (outcome === 'imported' || outcome === 'versioned') {
          let sourceId: string;
          if (outcome === 'imported') {
            const [src] = await tx
              .insert(sources)
              .values({
                ownerId,
                kind: provider,
                externalProvider: provider,
                externalId: item.externalId,
                checkedAt: now,
                contentHash: p.contentChecksum,
              })
              .returning();
            sourceId = src!.id;
          } else {
            sourceId = existing.get(item.externalId)!.sourceId;
          }
          const [ver] = await tx
            .insert(sourceVersions)
            .values({ sourceId, rawHash: p.contentChecksum, fetchedAt: now, excerpt: null, extractionState: 'imported' })
            .returning();
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

/** 소재 상세 표시용: 이 소재를 만든 가져오기(있으면). */
export async function getImportOriginForCapture(
  db: DbOrTx,
  ownerId: string,
  captureId: string,
): Promise<{ runId: string; sourceKind: string; externalPath: string; externalCreatedText: string | null; outcome: string; committedAt: Date | null } | null> {
  if (!isUuid(captureId)) return null;
  const rows = await db
    .select({
      runId: importItems.runId,
      sourceKind: importRuns.sourceKind,
      externalPath: importItems.externalPath,
      externalCreatedText: importItems.externalCreatedText,
      outcome: importItems.outcome,
      committedAt: importRuns.committedAt,
    })
    .from(importItems)
    .innerJoin(importRuns, and(eq(importRuns.id, importItems.runId), eq(importRuns.ownerId, importItems.ownerId)))
    .where(and(eq(importItems.ownerId, ownerId), eq(importItems.targetCaptureId, captureId)))
    .limit(1);
  const r = rows[0];
  return r ? { ...r, outcome: r.outcome ?? '' } : null;
}
