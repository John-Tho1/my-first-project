/**
 * T20(결정 D22) 복원 훈련(A18 "backup 에서 빈 환경으로 복원 → 본문·관계·asset checksum 일치").
 *
 * 1. owner 를 임시 폴더로 내보낸다(export_runs 에 기록하지 않음 — 훈련 묶음은 백업으로 세지 않는다).
 * 2. 묶음에 인증 비밀이 없는지 확인한다(sessions 표·session 파일·token_hash·식별자 원문 — ZIP 항목을 풀어서 본다).
 * 3. 버리는 메모리 PGlite + 빈 임시 저장소에 empty_only 로 복원한다(운영 DB 파일 잠금과 무관).
 * 4. 복원한 표마다 행 수·ID 집합과 **모든 열**을 기대 복원값과 비교한다(FIX round 1 P1). 기대값은 원본 묶음에 복원 규칙
 *    (restore-expect.ts — 진행 중 작업 → BLOCKED/UNKNOWN·lease 제거·표시, 근거 없는 CONFIRMED → UNKNOWN, 계획 상태 재계산, 선언된 승인 철회·파생본 낮춤,
 *    중단된 전사·예약 원장 정리)을 독립적으로 적용해 만든다. 복원 때 정해지는 시각은 훈련 시작~끝 사이인지 본다.
 * 5. 파일: 복원 저장소의 바이트 sha256 = assets.checksum = 원본 checksum. 원본 파일이 없으면 실패(백업이 불완전).
 * 6. 검색: 원본에서 찾히는 소재 하나를 복원 DB 에서도 같은 검색어로 찾는다(후보가 없으면 skipped — 결과에 남긴다).
 * 어느 단계에서 예외가 나도(FIX round 1 P1) 원본 DB 에 쓸 수 있으면 fail + 정제된 오류 코드로 남기고, 임시 파일은 항상 지운다.
 * 결과는 restore_drills 에 남긴다(불일치 목록에는 표 이름·종류·건수·ID·열 이름만 — 값·본문·식별자 원문 없음). 외부 호출 없음.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { readZip, RESTORED_TABLES, searchQuerySchema, sha256Hex, type RestoredTable } from '@cs/domain';
import { createDb, migrate, type Db } from './client';
import { exportOwner, readOwnerTables, type BlobStore } from './export';
import { ensureOwner, recordAudit } from './queries';
import { deriveRestoreTransforms, expectedRestoredRows, transformedRowCount, valueMatches } from './restore-expect';
import { commitRestore, createRestorePreview, parseBundleZip } from './restore';
import { restoreDrills, users } from './schema';
import { search } from './search';

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
    | 'restore_error'
    | 'declared_transforms'
    | 'drill_error';
  expected?: number | string;
  actual?: number | string;
  sample_ids?: string[];
  /** 기대값과 다른 열 이름(값 없음) */
  columns?: string[];
  code?: string;
}

export interface DrillTableRow {
  table: string;
  expected_rows: number;
  actual_rows: number;
  ids: 'same' | 'different';
  /** same = 모든 열 일치, same(복원 규칙 N행) = 복원 규칙을 적용한 기대값과 일치 */
  content: 'same' | 'different' | `same(복원 규칙 ${number}행)`;
}

export interface RestoreDrillResult {
  drillId: string;
  result: 'pass' | 'fail';
  startedAt: Date;
  finishedAt: Date;
  bundleExportId: string | null;
  bundleSha256: string | null;
  tablesCompared: number;
  rowsCompared: number;
  assetsCompared: number;
  searchProbe: 'found' | 'not_found' | 'skipped';
  /** 원본·복원 모두 0행인 표(검증 범위 표시) */
  emptyTables: string[];
  tables: DrillTableRow[];
  mismatches: DrillMismatch[];
  /** 준비·복원·비교 중 예외로 끝났으면 정제된 오류 코드 */
  errorCode: string | null;
  /** 검증 범위(restore_drills.scope_json 에 저장) — partial 이면 화면에 "부분 검증" */
  scope: DrillScope;
}

export interface DrillScope {
  empty_tables: string[];
  tables_compared: number;
  files_checked: number;
  search_probe: 'found' | 'not_found' | 'skipped';
  /** 파일 0개·검색 skipped·핵심 표(소재·원고·원고 버전) 중 빈 표가 있음 */
  partial: boolean;
  partial_reasons: string[];
}

/** 이 표가 비어 있으면 그 PASS 는 "부분 검증"이다. */
export const DRILL_CORE_TABLES = ['captures', 'contents', 'content_versions'] as const;

export function drillScope(emptyTables: readonly string[], tablesCompared: number, filesChecked: number, searchProbe: DrillScope['search_probe']): DrillScope {
  const reasons: string[] = [];
  if (filesChecked === 0) reasons.push('no_files');
  if (searchProbe === 'skipped') reasons.push('search_skipped');
  for (const t of DRILL_CORE_TABLES) if (emptyTables.includes(t)) reasons.push(`empty:${t}`);
  return { empty_tables: [...emptyTables], tables_compared: tablesCompared, files_checked: filesChecked, search_probe: searchProbe, partial: reasons.length > 0, partial_reasons: reasons };
}

export interface RestoreDrillOptions {
  trigger: 'cli' | 'api' | 'test';
  now?: Date;
  /** 임시 폴더를 만들 곳(기본 OS 임시 폴더). 훈련 뒤 지운다. */
  tmpRoot?: string;
  /** 시험 전용: 복원 직후·비교 전에 대상 DB 를 바꾼다(변조 감지 확인). */
  afterRestore?: (target: Db, targetOwnerId: string) => Promise<void>;
  /** 시험 전용: 그 단계에서 예외를 낸다(실패 기록·정리 확인). */
  faultInjection?: 'export' | 'restore' | 'compare';
  /** 시험 전용: 복원이 알린 변환 목록(커밋 결과)을 바꾼다(복원 회귀 흉내 — 행과 선언이 함께 틀린 경우). */
  tamperCommit?: (c: Awaited<ReturnType<typeof commitRestore>>) => Awaited<ReturnType<typeof commitRestore>>;
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

const SAFE_CODE = /^[A-Za-z0-9_]{1,64}$/u;

/** 예외 → 정제된 오류 코드(코드 또는 오류 클래스 이름만 — 메시지·경로는 남기지 않는다). */
export function drillErrorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && SAFE_CODE.test(code)) return code;
  if (e instanceof Error && SAFE_CODE.test(e.name)) return e.name;
  return 'unknown_error';
}

const injected = () => Object.assign(new Error('injected fault'), { code: 'injected_fault' });

/** 원본 소재에서 검색어 후보(글자·숫자 2자 이상 낱말). */
function probeTerm(text: string): string | null {
  const m = /[\p{L}\p{N}]{2,}/u.exec(text);
  return m ? m[0] : null;
}

const captureIds = async (db: Db, ownerId: string, q: string) =>
  (await search(db, ownerId, searchQuerySchema.parse({ q, type: 'captures', limit: 50 }))).captures.items.map((i) => i.id);

const byIdStr = (rows: readonly Record<string, unknown>[]) => [...rows].sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));

export async function runRestoreDrill(source: Db, sourceStorage: BlobStore, ownerId: string, opts: RestoreDrillOptions): Promise<RestoreDrillResult> {
  const startedAt = opts.now ?? new Date();
  const mismatches: DrillMismatch[] = [];
  const tables: DrillTableRow[] = [];
  const emptyTables: string[] = [];
  let rowsCompared = 0;
  let tablesCompared = 0;
  let assetsCompared = 0;
  let searchProbe: RestoreDrillResult['searchProbe'] = 'skipped';
  let bundleExportId: string | null = null;
  let bundleSha256: string | null = null;
  let errorCode: string | null = null;
  let tmp: string | null = null;
  let target: ReturnType<typeof createDb> | null = null;
  try {
    tmp = await mkdtemp(path.join(opts.tmpRoot ?? os.tmpdir(), 'cs-restore-drill-'));
    // 1. 임시 묶음(기록 없음)
    if (opts.faultInjection === 'export') throw injected();
    const exported = await exportOwner(source, sourceStorage, ownerId, { outDir: path.join(tmp, 'export'), now: startedAt, record: false });
    bundleExportId = exported.exportId;
    bundleSha256 = exported.manifestSha256;
    const zip = new Uint8Array(await readFile(/*turbopackIgnore: true*/ exported.zipPath));
    const bundle = await parseBundleZip(zip);

    // 2. 인증 비밀 없음(ZIP 항목을 풀어서 본다)
    const [owner] = await source.select({ identity: users.allowedIdentity }).from(users).where(eq(users.id, ownerId)).limit(1);
    const text = readZip(zip)
      .map((e) => Buffer.from(e.bytes).toString('utf8'))
      .join('\n');
    const leaks: string[] = [];
    if (Object.keys(bundle.manifest.tables).includes('sessions')) leaks.push('sessions_table');
    if (bundle.files.some((f) => /session/iu.test(f))) leaks.push('session_file');
    if (text.includes('token_hash')) leaks.push('token_hash');
    if (owner?.identity && text.includes(owner.identity)) leaks.push('identity_plain');
    if (leaks.length) mismatches.push({ kind: 'credentials_in_bundle', code: leaks.join(',') });

    // 3. 버리는 메모리 DB + 빈 저장소에 empty_only 복원
    target = createDb({ driver: 'pglite', url: 'memory://' });
    await migrate(target);
    const targetOwner = await ensureOwner(target.db, 'restore-drill@drill.invalid');
    const targetStorage = new TempDirStore(path.join(tmp, 'storage'));
    await mkdir(path.join(tmp, 'storage'), { recursive: true });
    const restoresDir = path.join(tmp, 'restores');
    let committed: Awaited<ReturnType<typeof commitRestore>> | null = null;
    let restoreFrom = new Date();
    let restoreTo = restoreFrom;
    try {
      if (opts.faultInjection === 'restore') throw injected();
      const { restoreId } = await createRestorePreview(target.db, targetOwner.id, zip, { restoresDir, source: 'upload' });
      restoreFrom = new Date();
      committed = await commitRestore(target.db, targetStorage, targetOwner.id, restoreId, { mode: 'empty_only', confirm: true, restoresDir });
      restoreTo = new Date();
      if (opts.tamperCommit) committed = opts.tamperCommit(committed);
    } catch (e) {
      // FIX round 3: 복원 단계 실패도 최상위 오류 코드로 남긴다
      errorCode = drillErrorCode(e);
      mismatches.push({ kind: 'restore_error', code: errorCode });
    }

    if (committed) {
      if (opts.afterRestore) await opts.afterRestore(target.db, targetOwner.id);
      // 4. 표 비교 — 모든 열을 기대 복원값과
      // FIX round 3(Q8): 복원 때 정해지는 시각은 실제 복원 호출 직전~직후 구간 안이어야 한다
      const window = { from: restoreFrom, to: restoreTo };
      // FIX round 3(P1): 강등·철회 대상은 묶음 행에서 독립적으로 계산하고, 복원이 알린 목록과도 대조한다
      const derived = deriveRestoreTransforms(bundle.tables, window);
      const declaredRevoked = new Set(committed.revoked_approvals.map((a) => a.approval_id));
      const declaredDowngraded = new Set(committed.downgraded_variants.map((v) => v.variant_id));
      const revokedDiff = [
        ...[...derived.revokedApprovals].filter((id) => !declaredRevoked.has(id)),
        ...[...declaredRevoked].filter((id) => !derived.revokedApprovals.has(id) && !derived.ambiguousApprovals.has(id)),
      ];
      if (revokedDiff.length) mismatches.push({ table: 'approvals', kind: 'declared_transforms', code: 'revoked_approvals', sample_ids: revokedDiff.slice(0, 5) });
      const downgradedDiff = [
        ...[...derived.downgradedVariants].filter((id) => !declaredDowngraded.has(id)),
        ...[...declaredDowngraded].filter((id) => !derived.downgradedVariants.has(id)),
      ];
      if (downgradedDiff.length) mismatches.push({ table: 'variants', kind: 'declared_transforms', code: 'downgraded_variants', sample_ids: downgradedDiff.slice(0, 5) });
      const expected = expectedRestoredRows(bundle.tables, derived);
      const { tables: got } = await readOwnerTables(target.db, targetOwner.id);
      for (const t of RESTORED_TABLES) {
        if (opts.faultInjection === 'compare') throw injected();
        const src = bundle.tables[t] as unknown as Record<string, unknown>[];
        const dst = got[t] as unknown as Record<string, unknown>[];
        const exp = expected[t as RestoredTable];
        tablesCompared++;
        rowsCompared += src.length;
        if (src.length === 0 && dst.length === 0) emptyTables.push(t);
        const srcIds = src.map((r) => String(r.id)).sort();
        const dstIds = dst.map((r) => String(r.id)).sort();
        const sameIds = srcIds.length === dstIds.length && srcIds.every((x, i) => x === dstIds[i]);
        if (src.length !== dst.length) mismatches.push({ table: t, kind: 'row_count', expected: src.length, actual: dst.length });
        const diffIds: string[] = [];
        const diffCols = new Set<string>();
        if (!sameIds) {
          const missing = srcIds.filter((x) => !dstIds.includes(x));
          const extra = dstIds.filter((x) => !srcIds.includes(x));
          mismatches.push({ table: t, kind: 'id_set', sample_ids: [...missing, ...extra].slice(0, 5) });
        } else {
          for (const d of byIdStr(dst)) {
            const e = exp.get(String(d.id));
            if (!e) continue;
            const cols = [...new Set([...Object.keys(e), ...Object.keys(d)])].filter((k) => !valueMatches(e[k], d[k], window));
            if (cols.length) {
              diffIds.push(String(d.id));
              for (const c of cols) diffCols.add(c);
            }
          }
          if (diffIds.length) mismatches.push({ table: t, kind: 'content_sha256', expected: diffIds.length, sample_ids: diffIds.slice(0, 5), columns: [...diffCols].sort() });
        }
        const transformed = transformedRowCount(src, exp);
        tables.push({
          table: t,
          expected_rows: src.length,
          actual_rows: dst.length,
          ids: sameIds ? 'same' : 'different',
          content: !sameIds || diffIds.length ? 'different' : transformed ? `same(복원 규칙 ${transformed}행)` : 'same',
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
      const caps = byIdStr(bundle.tables.captures as unknown as Record<string, unknown>[]);
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
  } catch (e) {
    errorCode = drillErrorCode(e);
    mismatches.push({ kind: 'drill_error', code: errorCode });
  } finally {
    if (target) await target.close().catch(() => undefined);
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }

  const finishedAt = new Date(Math.max(Date.now(), startedAt.getTime()));
  const result: 'pass' | 'fail' = mismatches.length === 0 && errorCode === null && tablesCompared > 0 ? 'pass' : 'fail';
  const scope = drillScope(emptyTables, tablesCompared, assetsCompared, searchProbe);
  const [row] = await source
    .insert(restoreDrills)
    .values({
      ownerId,
      startedAt,
      finishedAt,
      exportRunId: bundleExportId,
      trigger: opts.trigger,
      tablesCompared,
      rowsCompared,
      assetsCompared,
      result,
      mismatchJson: mismatches as unknown as Array<Record<string, unknown>>,
      bundleSha256,
      errorCode,
      scopeJson: scope as unknown as Record<string, unknown>,
    })
    .returning({ id: restoreDrills.id });
  await recordAudit(source, {
    ownerId,
    action: 'restore_drill.run',
    entity: 'restore_drill',
    entityId: row!.id,
    versionOrHash: bundleSha256,
    details: {
      result,
      trigger: opts.trigger,
      tables: tablesCompared,
      rows: rowsCompared,
      assets: assetsCompared,
      mismatches: mismatches.length,
      search_probe: searchProbe,
      empty_tables: emptyTables.length,
      error_code: errorCode,
      partial: scope.partial,
    },
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
    emptyTables,
    tables,
    mismatches,
    errorCode,
    scope,
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
  lines.push(
    `파일 비교 ${r.assetsCompared}개 · 검색 확인 ${r.searchProbe} · 행 ${r.rowsCompared} · 표 ${r.tablesCompared}(빈 표 ${r.emptyTables.length}개${r.emptyTables.length ? `: ${r.emptyTables.join(', ')}` : ''})`,
  );
  if (r.mismatches.length) {
    lines.push(`불일치 ${r.mismatches.length}건:`);
    for (const m of r.mismatches) {
      lines.push(
        `- ${m.kind}${m.table ? ` (${m.table})` : ''}${m.code ? ` ${m.code}` : ''}${m.columns?.length ? ` 열=${m.columns.join(',')}` : ''}${m.sample_ids?.length ? ` ids=${m.sample_ids.join(',')}` : ''}`,
      );
    }
  }
  lines.push(
    `결과: ${
      r.result === 'pass'
        ? `PASS${r.scope.partial ? `(부분 검증: ${r.scope.partial_reasons.join(', ')})` : ''} — 복원한 빈 환경이 원본 묶음(복원 규칙 적용)과 일치`
        : `FAIL${r.errorCode ? `(${r.errorCode})` : ''}`
    }`,
  );
  return lines.join('\n');
}
