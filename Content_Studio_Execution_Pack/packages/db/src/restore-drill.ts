/**
 * T20(결정 D22) 복원 훈련(A18 "backup 에서 빈 환경으로 복원 → 본문·관계·asset checksum 일치").
 *
 * 1. owner 를 임시 폴더로 내보낸다(export_runs 에 기록하지 않음 — 훈련 묶음은 백업으로 세지 않는다).
 * 2. 묶음에 인증 비밀이 없는지 확인한다(sessions 표·token_hash·식별자 원문).
 * 3. 버리는 메모리 PGlite + 빈 임시 저장소에 empty_only 로 복원한다(운영 DB 파일 잠금과 무관).
 * 4. 복원한 표마다 행 수·ID 집합·내용 sha256 을 원본 묶음과 비교한다. 복원이 안전을 위해 일부러 바꾸는 열(D17~D19:
 *    진행 중 작업 → BLOCKED/UNKNOWN, 승인 철회, 파생본 검토 → 초안, 중단된 전사 등)은 내용 비교에서 빼고 행 수·ID 로만 본다.
 * 5. 파일: 복원 저장소의 바이트 sha256 = assets.checksum = 원본 checksum. 원본 파일이 없으면 실패(백업이 불완전).
 * 6. 검색: 원본에서 찾히는 소재 하나를 복원 DB 에서도 같은 검색어로 찾는다.
 * 결과는 restore_drills 에 남긴다(불일치 목록에는 표 이름·종류·건수·ID 만 — 본문·식별자 원문 없음). 외부 호출 없음.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { RESTORED_TABLES, searchQuerySchema, sha256Hex, stableStringify, type RestoredTable } from '@cs/domain';
import { createDb, migrate, type Db } from './client';
import { exportOwner, readOwnerTables, type BlobStore } from './export';
import { ensureOwner, recordAudit } from './queries';
import { commitRestore, createRestorePreview, parseBundleZip } from './restore';
import { restoreDrills, users } from './schema';
import { search } from './search';

/**
 * 복원이 안전을 위해 일부러 바꾸는 열(표별). 이 열만 내용 비교에서 뺀다 — 행 수·ID 집합은 그대로 비교한다.
 * (restore.ts applyBundle: 작업·항목 상태와 그에 따른 계획 상태, 승인 철회, 파생본 lifecycle 낮춤, 중단된 전사·예약 원장 정리)
 */
export const RESTORE_TRANSFORM_COLUMNS: Readonly<Partial<Record<RestoredTable, readonly string[]>>> = {
  variants: ['lifecycle', 'updated_at'],
  approvals: ['revoked_at', 'revoke_reason'],
  // 항목 상태가 바뀌면 계획 상태도 같은 규칙(planStatusFrom)으로 다시 계산된다
  distribution_plans: ['status', 'revision', 'updated_at'],
  distribution_items: ['status', 'restored_needs_review', 'updated_at'],
  jobs: ['state', 'lease_owner', 'lease_until', 'heartbeat_at', 'restored_needs_review', 'done_at', 'updated_at'],
  transcription_jobs: ['state', 'error', 'finished_at', 'updated_at'],
  usage_ledger: ['state', 'actual_amount', 'failed', 'settled_at'],
};

export interface DrillMismatch {
  table?: string;
  kind:
    | 'row_count'
    | 'id_set'
    | 'content_sha256'
    | 'asset_checksum'
    | 'asset_missing_in_source'
    | 'search_probe'
    | 'credentials_in_bundle'
    | 'restore_error';
  expected?: number | string;
  actual?: number | string;
  sample_ids?: string[];
  /** 내용이 다른 열 이름(값 없음) */
  columns?: string[];
  code?: string;
}

export interface DrillTableRow {
  table: string;
  expected_rows: number;
  actual_rows: number;
  ids: 'same' | 'different';
  content: 'same' | 'different' | 'same(복원 변환 열 제외)';
}

export interface RestoreDrillResult {
  drillId: string;
  result: 'pass' | 'fail';
  startedAt: Date;
  finishedAt: Date;
  bundleExportId: string;
  bundleSha256: string;
  tablesCompared: number;
  rowsCompared: number;
  assetsCompared: number;
  searchProbe: 'found' | 'not_found' | 'skipped';
  tables: DrillTableRow[];
  mismatches: DrillMismatch[];
}

export interface RestoreDrillOptions {
  trigger: 'cli' | 'api' | 'test';
  now?: Date;
  /** 임시 폴더를 만들 곳(기본 OS 임시 폴더). 훈련 뒤 지운다. */
  tmpRoot?: string;
  /** 시험 전용: 복원 직후·비교 전에 대상 DB 를 바꾼다(변조 감지 확인). */
  afterRestore?: (target: Db, targetOwnerId: string) => Promise<void>;
}

/** 빈 임시 폴더 저장소(복원 대상). key 는 폴더 밖을 가리킬 수 없다. */
class TempDirStore implements BlobStore {
  constructor(private readonly root: string) {}
  private file(key: string): string {
    const f = path.resolve(/*turbopackIgnore: true*/ this.root, ...key.split('/'));
    if (!f.startsWith(this.root + path.sep)) throw new Error('저장소 key 가 폴더를 벗어났습니다');
    return f;
  }
  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(/*turbopackIgnore: true*/ this.file(key)));
    } catch {
      return null;
    }
  }
  async put(key: string, bytes: Uint8Array): Promise<void> {
    const f = this.file(key);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(/*turbopackIgnore: true*/ f, bytes);
  }
}

const byId = (rows: readonly Record<string, unknown>[]) => [...rows].sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
const without = (rows: readonly Record<string, unknown>[], drop: readonly string[]) =>
  rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !drop.includes(k))));
const rowsSha = (rows: readonly Record<string, unknown>[], drop: readonly string[] = []) => sha256Hex(stableStringify(byId(without(rows, drop))));

/** 원본 소재에서 검색어 후보(글자·숫자 2자 이상 낱말). */
function probeTerm(text: string): string | null {
  const m = /[\p{L}\p{N}]{2,}/u.exec(text);
  return m ? m[0] : null;
}

const captureIds = async (db: Db, ownerId: string, q: string) =>
  (await search(db, ownerId, searchQuerySchema.parse({ q, type: 'captures', limit: 50 }))).captures.items.map((i) => i.id);

export async function runRestoreDrill(source: Db, sourceStorage: BlobStore, ownerId: string, opts: RestoreDrillOptions): Promise<RestoreDrillResult> {
  const startedAt = opts.now ?? new Date();
  const tmp = await mkdtemp(path.join(opts.tmpRoot ?? os.tmpdir(), 'cs-restore-drill-'));
  const mismatches: DrillMismatch[] = [];
  const tables: DrillTableRow[] = [];
  let rowsCompared = 0;
  let tablesCompared = 0;
  let assetsCompared = 0;
  let searchProbe: RestoreDrillResult['searchProbe'] = 'skipped';
  let bundleExportId: string;
  let bundleSha256: string;
  const target = createDb({ driver: 'pglite', url: 'memory://' });
  try {
    // 1. 임시 묶음(기록 없음)
    const exported = await exportOwner(source, sourceStorage, ownerId, { outDir: path.join(tmp, 'export'), now: startedAt, record: false });
    bundleExportId = exported.exportId;
    bundleSha256 = exported.manifestSha256;
    const zip = new Uint8Array(await readFile(/*turbopackIgnore: true*/ exported.zipPath));
    const bundle = await parseBundleZip(zip);

    // 2. 인증 비밀 없음
    const [owner] = await source.select({ identity: users.allowedIdentity }).from(users).where(eq(users.id, ownerId)).limit(1);
    const text = Buffer.from(zip).toString('utf8');
    const leaks: string[] = [];
    if (Object.keys(bundle.manifest.tables).includes('sessions')) leaks.push('sessions_table');
    if (bundle.files.some((f) => /session/iu.test(f))) leaks.push('session_file');
    if (text.includes('token_hash')) leaks.push('token_hash');
    if (owner?.identity && text.includes(owner.identity)) leaks.push('identity_plain');
    if (leaks.length) mismatches.push({ kind: 'credentials_in_bundle', code: leaks.join(',') });

    // 3. 버리는 메모리 DB + 빈 저장소에 empty_only 복원
    await migrate(target);
    const targetOwner = await ensureOwner(target.db, 'restore-drill@drill.invalid');
    const targetStorage = new TempDirStore(path.join(tmp, 'storage'));
    await mkdir(path.join(tmp, 'storage'), { recursive: true });
    const restoresDir = path.join(tmp, 'restores');
    let restored = false;
    try {
      const { restoreId } = await createRestorePreview(target.db, targetOwner.id, zip, { restoresDir, source: 'upload' });
      await commitRestore(target.db, targetStorage, targetOwner.id, restoreId, { mode: 'empty_only', confirm: true, restoresDir });
      restored = true;
    } catch (e) {
      mismatches.push({ kind: 'restore_error', code: (e as { code?: string }).code ?? 'error' });
    }

    if (restored) {
      if (opts.afterRestore) await opts.afterRestore(target.db, targetOwner.id);
      // 4. 표 비교
      const { tables: got } = await readOwnerTables(target.db, targetOwner.id);
      for (const t of RESTORED_TABLES) {
        const src = bundle.tables[t] as unknown as Record<string, unknown>[];
        const dst = got[t] as unknown as Record<string, unknown>[];
        tablesCompared++;
        rowsCompared += src.length;
        const srcIds = src.map((r) => String(r.id)).sort();
        const dstIds = dst.map((r) => String(r.id)).sort();
        const sameIds = srcIds.length === dstIds.length && srcIds.every((x, i) => x === dstIds[i]);
        const drop = RESTORE_TRANSFORM_COLUMNS[t] ?? [];
        const sameContent = rowsSha(src, drop) === rowsSha(dst, drop);
        if (src.length !== dst.length) mismatches.push({ table: t, kind: 'row_count', expected: src.length, actual: dst.length });
        if (!sameIds) {
          const missing = srcIds.filter((x) => !dstIds.includes(x));
          const extra = dstIds.filter((x) => !srcIds.includes(x));
          mismatches.push({ table: t, kind: 'id_set', sample_ids: [...missing, ...extra].slice(0, 5) });
        } else if (!sameContent) {
          const srcById = new Map(src.map((r) => [String(r.id), rowsSha([r], drop)]));
          const diff = dst.filter((r) => srcById.get(String(r.id)) !== rowsSha([r], drop)).map((r) => String(r.id));
          // 다른 열 이름만(값은 남기지 않는다) — 첫 행 기준
          const first = dst.find((r) => String(r.id) === diff[0]);
          const orig = src.find((r) => String(r.id) === diff[0]);
          const columns = first && orig ? Object.keys(first).filter((k) => !drop.includes(k) && stableStringify(first[k]) !== stableStringify(orig[k])) : [];
          mismatches.push({ table: t, kind: 'content_sha256', expected: diff.length, sample_ids: diff.slice(0, 5), columns });
        }
        tables.push({
          table: t,
          expected_rows: src.length,
          actual_rows: dst.length,
          ids: sameIds ? 'same' : 'different',
          content: !sameContent ? 'different' : drop.length && rowsSha(src) !== rowsSha(dst) ? 'same(복원 변환 열 제외)' : 'same',
        });
      }

      // 5. 파일 checksum
      const srcAssets = new Map(bundle.manifest.assets.map((a) => [a.id, a]));
      for (const a of got.assets as unknown as Array<{ id: string; key: string; checksum: string; deleted_at: string | null }>) {
        if (a.deleted_at !== null) continue; // 의도적으로 지운 원본(메타데이터만) — 비교 대상 아님
        assetsCompared++;
        const s = srcAssets.get(a.id);
        if (!s || s.missing) {
          mismatches.push({ table: 'assets', kind: 'asset_missing_in_source', sample_ids: [a.id] });
          continue;
        }
        const bytes = await targetStorage.get(a.key);
        if (!bytes || sha256Hex(bytes) !== a.checksum || a.checksum !== s.checksum) {
          mismatches.push({ table: 'assets', kind: 'asset_checksum', sample_ids: [a.id] });
        }
      }

      // 6. 검색 확인 — 원본에서 찾히는 소재를 복원 DB 에서도 찾는가
      const caps = byId(bundle.tables.captures as unknown as Record<string, unknown>[]);
      for (const c of caps.slice(0, 20)) {
        const term = probeTerm(String(c.raw_text ?? ''));
        if (!term) continue;
        if (!(await captureIds(source, ownerId, term)).includes(String(c.id))) continue;
        const found = (await captureIds(target.db, targetOwner.id, term)).includes(String(c.id));
        searchProbe = found ? 'found' : 'not_found';
        if (!found) mismatches.push({ table: 'captures', kind: 'search_probe', sample_ids: [String(c.id)] });
        break;
      }
    }
  } finally {
    await target.close().catch(() => undefined);
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }

  const finishedAt = new Date(Math.max(Date.now(), startedAt.getTime()));
  const result: 'pass' | 'fail' = mismatches.length === 0 && tablesCompared > 0 ? 'pass' : 'fail';
  const [row] = await source
    .insert(restoreDrills)
    .values({
      ownerId,
      startedAt,
      finishedAt,
      exportRunId: bundleExportId || null,
      trigger: opts.trigger,
      tablesCompared,
      rowsCompared,
      assetsCompared,
      result,
      mismatchJson: mismatches as unknown as Array<Record<string, unknown>>,
      bundleSha256: bundleSha256 || null,
    })
    .returning({ id: restoreDrills.id });
  await recordAudit(source, {
    ownerId,
    action: 'restore_drill.run',
    entity: 'restore_drill',
    entityId: row!.id,
    versionOrHash: bundleSha256 || null,
    details: { result, trigger: opts.trigger, tables: tablesCompared, rows: rowsCompared, assets: assetsCompared, mismatches: mismatches.length, search_probe: searchProbe },
    at: finishedAt,
  });
  return {
    drillId: row!.id,
    result,
    startedAt,
    finishedAt,
    bundleExportId,
    bundleSha256,
    tablesCompared,
    rowsCompared,
    assetsCompared,
    searchProbe,
    tables,
    mismatches,
  };
}

export type RestoreDrillRow = typeof restoreDrills.$inferSelect;

export async function latestRestoreDrill(db: Db, ownerId: string): Promise<RestoreDrillRow | null> {
  const rows = await db.select().from(restoreDrills).where(eq(restoreDrills.ownerId, ownerId)).orderBy(desc(restoreDrills.startedAt), desc(restoreDrills.id)).limit(1);
  return rows[0] ?? null;
}

/** 표 형태 출력(CLI). 본문·식별자 없음. */
export function formatDrillResult(r: RestoreDrillResult): string {
  const lines = ['| 표 | 원본 행 | 복원 행 | ID | 내용 |', '| --- | --- | --- | --- | --- |'];
  for (const t of r.tables) lines.push(`| ${t.table} | ${t.expected_rows} | ${t.actual_rows} | ${t.ids} | ${t.content} |`);
  lines.push('');
  lines.push(`파일 비교 ${r.assetsCompared}개 · 검색 확인 ${r.searchProbe} · 행 ${r.rowsCompared} · 표 ${r.tablesCompared}`);
  if (r.mismatches.length) {
    lines.push(`불일치 ${r.mismatches.length}건:`);
    for (const m of r.mismatches) lines.push(`- ${m.kind}${m.table ? ` (${m.table})` : ''}${m.code ? ` ${m.code}` : ''}${m.sample_ids?.length ? ` ids=${m.sample_ids.join(',')}` : ''}`);
  }
  lines.push(`결과: ${r.result === 'pass' ? 'PASS — 복원한 빈 환경이 원본 묶음과 일치' : 'FAIL'}`);
  return lines.join('\n');
}
