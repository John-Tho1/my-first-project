/**
 * 내보내기(T05, 결정 D6). owner 한 명의 데이터를 `content-studio-export` v1 묶음으로 만든다:
 * `<exportsDir>/<export_id>/`(풀어 둔 파일) + `<exportsDir>/<export_id>.zip`(store-only ZIP).
 *
 * - 모든 표를 한 읽기 트랜잭션(REPEATABLE READ, READ ONLY)에서 읽는다 — 표 사이 일관성.
 *   PGlite 는 연결이 하나라 다른 쓰기가 끼어들 수 없지만, PostgreSQL(M3)에서도 같은 코드가 스냅샷을 보장한다.
 * - 파일 바이트는 저장소 adapter 로 읽는다. 없으면 manifest.assets[].missing + warnings 에 남기고 실패하지 않는다.
 * - sessions·export_runs·restore_runs 는 넣지 않는다(@cs/domain EXCLUDED_TABLES). 식별자는 가린 형태만.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import {
  buildBundle,
  EXPORTED_TABLES,
  isUuid,
  sha256Hex,
  writeZip,
  type BundleManifest,
  type BundleTables,
  type BundleWarning,
} from '@cs/domain';
import { migrationsFolder, type Db } from './client';
import { findWorkspaceRoot } from './paths';
import { recordAudit } from './queries';
import { ownerScope, selectBundleRows } from './bundle-tables';
import { exportRuns } from './schema';

/** 저장소 adapter 중 내보내기·복원이 쓰는 부분(@cs/providers StorageAdapter 와 구조적으로 호환). */
export interface BlobStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
}

/** 적용된 migration 태그(journal 순서). openDb 가 항상 전체 journal 을 적용하므로 journal = 적용 목록. */
export async function readMigrationTags(): Promise<string[]> {
  const raw = JSON.parse(await readFile(path.join(migrationsFolder(), 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  return [...raw.entries].sort((a, b) => a.idx - b.idx).map((e) => e.tag);
}

export async function readAppVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(path.join(findWorkspaceRoot(), 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 워크스페이스 루트 기준 상대 경로(루트 밖이면 파일 이름만) — DB·응답에 절대 경로를 남기지 않는다. */
export function displayPath(file: string): string {
  let root: string;
  try {
    root = findWorkspaceRoot();
  } catch {
    return path.basename(file);
  }
  const rel = path.relative(root, file);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return path.basename(file);
  return rel.split(path.sep).join('/');
}

export interface ExportOptions {
  /** 절대 경로. 이 아래에 <export_id>/ 와 <export_id>.zip 을 만든다. */
  outDir: string;
  now?: Date;
}

export interface ExportResult {
  exportId: string;
  manifest: BundleManifest;
  manifestSha256: string;
  zipPath: string;
  dirPath: string;
  zipBytes: number;
  warnings: BundleWarning[];
}

/** owner 의 묶음 표 전체를 읽는다(트랜잭션 안에서 호출). */
export async function readOwnerTables(tx: Parameters<Parameters<Db['transaction']>[0]>[0] | Db, ownerId: string) {
  const tables = {} as BundleTables;
  let identity = '';
  for (const name of EXPORTED_TABLES) {
    const rows = await selectBundleRows(tx, name, ownerScope(name, ownerId));
    if (name === 'users') identity = String(rows[0]?.row.identity_masked ?? '');
    (tables as Record<string, unknown[]>)[name] = rows.map((r) => r.row);
  }
  return { tables, identityMasked: identity };
}

export async function exportOwner(db: Db, storage: BlobStore, ownerId: string, opts: ExportOptions): Promise<ExportResult> {
  if (!path.isAbsolute(opts.outDir)) throw new Error('outDir 는 절대 경로여야 합니다');
  const exportId = randomUUID();
  const now = opts.now ?? new Date();
  const migrations = await readMigrationTags();
  const appVersion = await readAppVersion();

  const { built } = await db.transaction(
    async (tx) => {
      const { tables, identityMasked } = await readOwnerTables(tx, ownerId);
      if (tables.users.length !== 1) throw new Error('owner 를 찾을 수 없습니다');
      const assetBytes = new Map<string, Uint8Array | null>();
      for (const a of tables.assets) assetBytes.set(a.id, await storage.get(a.key));
      const bundle = buildBundle({
        exportId,
        exportedAt: now.toISOString(),
        appVersion,
        migrations,
        owner: { id: ownerId, identityMasked },
        tables,
        assetBytes,
      });
      return { built: bundle };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );

  const zip = writeZip(built.entries, now);
  const dirPath = path.join(opts.outDir, exportId);
  const zipPath = path.join(opts.outDir, `${exportId}.zip`);
  await mkdir(opts.outDir, { recursive: true });
  try {
    for (const e of built.entries) {
      const full = path.join(dirPath, ...e.path.split('/'));
      if (!full.startsWith(dirPath + path.sep)) throw new Error('묶음 경로가 폴더를 벗어났습니다');
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, e.bytes, { flag: 'wx' });
    }
    await writeFile(zipPath, zip, { flag: 'wx' });
  } catch (e) {
    await rm(dirPath, { recursive: true, force: true }).catch(() => undefined);
    await rm(zipPath, { force: true }).catch(() => undefined);
    throw e;
  }

  const manifestSha256 = sha256Hex(built.manifestBytes);
  await db.transaction(async (tx) => {
    await tx.insert(exportRuns).values({
      id: exportId,
      ownerId,
      createdAt: now,
      formatVersion: built.manifest.format_version,
      manifestSha256,
      zipBytes: zip.byteLength,
      path: displayPath(zipPath),
      status: 'completed',
      totals: built.manifest.totals,
    });
    await recordAudit(tx, {
      ownerId,
      action: 'export.create',
      entity: 'export',
      entityId: exportId,
      versionOrHash: manifestSha256,
      details: {
        zip_bytes: zip.byteLength,
        rows: built.manifest.totals.restorable_rows ?? 0,
        assets: built.manifest.totals.assets ?? 0,
        warnings: built.manifest.warnings.length,
      },
      at: now,
    });
  });

  return {
    exportId,
    manifest: built.manifest,
    manifestSha256,
    zipPath,
    dirPath,
    zipBytes: zip.byteLength,
    warnings: built.manifest.warnings,
  };
}

export type ExportRunRow = typeof exportRuns.$inferSelect;

export async function listExportRuns(db: Db, ownerId: string, limit = 20): Promise<ExportRunRow[]> {
  return db
    .select()
    .from(exportRuns)
    .where(eq(exportRuns.ownerId, ownerId))
    .orderBy(desc(exportRuns.createdAt), desc(exportRuns.id))
    .limit(limit);
}

/** 다른 owner·없는 ID·형식이 틀린 ID 는 null(404). */
export async function getExportRun(db: Db, ownerId: string, id: string): Promise<ExportRunRow | null> {
  if (!isUuid(id)) return null;
  const rows = await db
    .select()
    .from(exportRuns)
    .where(and(eq(exportRuns.id, id), eq(exportRuns.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

/** 내보내기 ZIP 의 실제 위치(export_runs.path 는 표시용 — 파일은 항상 <exportsDir>/<id>.zip). */
export function exportZipPath(exportsDir: string, exportId: string): string {
  if (!isUuid(exportId)) throw new Error('잘못된 내보내기 ID');
  return path.join(exportsDir, `${exportId}.zip`);
}
