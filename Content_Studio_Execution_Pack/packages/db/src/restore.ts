/**
 * 복원(T05, 결정 D6). 미리보기 → (사용자 확인) → 커밋.
 *
 * 미리보기(createRestorePreview)
 * - ZIP 을 읽어 @cs/domain parseBundle 로 모든 파일 sha256·형식 버전·migration 호환·행 스키마·묶음 안 참조를 검사한다.
 *   하나라도 어긋나면 BundleError(400) — DB 는 바뀌지 않고 restore_runs 행도 남기지 않는다.
 * - 현재 owner 범위에서 표별 {in_bundle, new, existing_same, existing_different} 를 계산한다.
 *   계산은 커밋과 같은 코드(applyBundle)를 트랜잭션 안에서 실행한 뒤 되돌리는(rollback) 방식이라 커밋 결과와 어긋나지 않는다.
 * - 통과하면 ZIP 을 <restoresDir>/<restore_id>.zip 에 두고 restore_runs(previewed) 를 남긴다.
 *
 * 커밋(commitRestore)
 * - 미리보기를 믿지 않고 저장된 ZIP 을 다시 읽어 검증한다(manifest sha256 이 미리보기 때와 같아야 함, 다르면 rejected).
 * - 한 트랜잭션: empty_only 는 owner 범위가 비어 있고 충돌 0 이어야 한다(아니면 409). add_missing 은 없는 ID 만 넣고
 *   같은 행은 건너뛰며, 다른 행은 **절대 덮어쓰지 않고** 충돌로 보고한다.
 * - owner 재지정: 모든 행의 owner_id = 현재 owner. 엔터티 ID 는 그대로 보존한다.
 * - 파일 바이트는 같은 key(assets/<원래 owner>/<uuid>)로 저장소에 쓰고 sha256 을 다시 확인한다. 접근 권한은 assets.owner_id 가 정한다.
 * - content_versions 는 INSERT 만 한다(불변 트리거). contents.current_version_id 는 버전을 넣은 뒤 채운다.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import {
  AppError,
  isUuid,
  NotFoundError,
  parseBundle,
  readZip,
  restoredItemStatus,
  restoredJobState,
  RESTORED_TABLES,
  rowHash,
  sha256Hex,
  type BundleManifest,
  type ParsedBundle,
  type RestoredTable,
} from '@cs/domain';
import type { Db } from './client';
import { recordAudit, type DbOrTx } from './queries';
import { idIn, insertBundleRow, selectBundleRows } from './bundle-tables';
import { exportZipPath, getExportRun, readMigrationTags, type BlobStore } from './export';
import { variantReviewBlockers } from './variants';
import { recomputePlanStatus, settleApprovedVariants } from './approval-invalidation';
import { snapshotProblems } from './distribution';
import { assets, captures, contents, distributionItems, ideas, jobs, publications, restoreRuns, sources } from './schema';

export type RestoreMode = 'empty_only' | 'add_missing';
export const RESTORE_MODES: readonly RestoreMode[] = ['empty_only', 'add_missing'];

/** 복원 대상 owner 범위가 비어 있지 않음(empty_only) — 409. */
export class RestoreTargetNotEmptyError extends AppError {
  constructor(extra?: Record<string, unknown>) {
    super(
      'conflict',
      'restore_target_not_empty',
      '이 계정에 이미 소재·카드·원고·파일이 있어 "빈 환경에만 복원"을 할 수 없습니다. "없는 항목만 추가"를 고르세요.',
      extra,
    );
  }
}

export class RestoreConflictError extends AppError {
  constructor(extra?: Record<string, unknown>) {
    super('conflict', 'restore_conflict', '같은 ID 의 다른 데이터가 있어 "빈 환경에만 복원"을 할 수 없습니다', extra);
  }
}

export class AlreadyCommittedError extends AppError {
  constructor() {
    super('conflict', 'already_committed', '이미 복원(커밋)한 미리보기입니다. 다시 복원하려면 파일을 새로 올려 미리보기를 만드세요.');
  }
}

export class RestoreNotCommittableError extends AppError {
  constructor(status: string) {
    super('conflict', 'restore_not_committable', `이 미리보기는 복원할 수 없는 상태입니다(${status}). 파일을 새로 올려 미리보기를 만드세요.`);
  }
}

export class RestoreFileMissingError extends AppError {
  constructor() {
    super('not_found', 'restore_file_missing', '미리보기에 쓴 파일이 서버에 없습니다. 파일을 다시 올려 미리보기를 만드세요.');
  }
}

export interface TableCounts {
  in_bundle: number;
  new: number;
  existing_same: number;
  existing_different: number;
}

export interface RestoreConflict {
  table: RestoredTable;
  id: string;
  /** different: 같은 owner 의 같은 ID 가 내용이 다름 / id_in_use: 다른 owner 가 쓰는 ID / dependency: 부모 행이 복원되지 않음 / unique: 다른 unique 값 충돌 / version_exists: 같은 버전의 브랜드 프로필이 다름 */
  reason: 'different' | 'id_in_use' | 'dependency' | 'unique' | 'version_exists' | 'immutable_version';
}

export interface DowngradedVariant {
  variant_id: string;
  channel: string;
  reasons: string[];
}

export interface ApplyReport {
  tables: Record<RestoredTable, TableCounts>;
  conflicts: RestoreConflict[];
  /** 이번 실행에서 새로 넣은 assets 행 id */
  insertedAssetIds: string[];
  /** FIX-T09(P1): review 조건(현재 버전·stale 아님·채널 미디어)을 못 채워 draft 로 낮춘 파생본 */
  downgradedVariants: DowngradedVariant[];
  /** T08: 묶음에서 진행 중(queued·running)이던 전사 job — 복원 환경에서 다시 돌리지 않고 canceled 로 넣는다 */
  interruptedTranscriptions: string[];
  /** T10(D17): 묶음에서 보내기 전 대기(QUEUED·RETRY_WAIT)이던 배포 항목 — 작업(jobs)은 복원하지 않으므로 BLOCKED 로 넣는다(맹목 재전송 없음) */
  blockedItems: string[];
  /** FIX-T10(P0): 묶음에서 전송 중·결과 불명이던 항목 — UNKNOWN 그대로(또는 UNKNOWN 으로) 넣는다. BLOCKED·FAILED 로 덮어쓰지 않는다. */
  unknownItems: string[];
  /** FIX-T11(P1): 묶음에서 CONFIRMED 였지만 복원된 원격 결과(publications)가 없는 항목 — 근거 없이 CONFIRMED 로 두지 않고 UNKNOWN(+표시). */
  unverifiedConfirmedItems: string[];
  /** T10(D17): 복원한 행 기준으로 스냅샷이 맞지 않는 활성 승인 — revoke_reason 'restore_stale' 로 철회해 넣는다 */
  revokedApprovals: Array<{ approval_id: string; item_id: string; reasons: string[] }>;
}

const MAX_CONFLICTS_LISTED = 200;

/** 묶음의 부모 참조(같은 owner 에 있어야 삽입 가능). owned=true 는 부모가 "이번에 넣었거나 동일"일 때만(기존 다른 행에 덧붙이지 않음). */
const PARENTS: Partial<Record<RestoredTable, Array<{ col: string; table: RestoredTable; owned?: boolean }>>> = {
  source_versions: [{ col: 'source_id', table: 'sources', owned: true }],
  // T08: 전사에서 만든 소재는 그 전사 버전이 이번에 들어갔거나 같은 행일 때만.
  captures: [
    { col: 'source_id', table: 'sources' },
    { col: 'capture_transcript_id', table: 'transcripts' },
  ],
  transcription_jobs: [{ col: 'asset_id', table: 'assets' }],
  transcripts: [{ col: 'job_id', table: 'transcription_jobs', owned: true }],
  capture_revisions: [{ col: 'capture_id', table: 'captures', owned: true }],
  idea_captures: [
    { col: 'idea_id', table: 'ideas' },
    { col: 'capture_id', table: 'captures' },
  ],
  contents: [{ col: 'idea_id', table: 'ideas' }],
  content_versions: [{ col: 'content_id', table: 'contents', owned: true }],
  content_captures: [
    { col: 'content_id', table: 'contents' },
    { col: 'capture_id', table: 'captures' },
  ],
  // T06: 답변·AI 실행 기록·경험 확인은 부모(원고·버전·브랜드 프로필·run)가 이번에 들어갔거나 같은 행일 때만.
  interview_answers: [{ col: 'content_id', table: 'contents', owned: true }],
  generation_runs: [
    { col: 'content_id', table: 'contents', owned: true },
    { col: 'brand_profile_id', table: 'brand_profiles' },
    { col: 'input_version_id', table: 'content_versions' },
    { col: 'output_ref', table: 'content_versions' },
  ],
  claim_confirmations: [
    { col: 'run_id', table: 'generation_runs', owned: true },
    { col: 'body_version_id', table: 'content_versions' },
  ],
  // T07
  claims: [
    { col: 'content_version_id', table: 'content_versions' },
    { col: 'run_id', table: 'generation_runs', owned: true },
  ],
  claim_sources: [
    { col: 'claim_id', table: 'claims', owned: true },
    { col: 'source_version_id', table: 'source_versions' },
  ],
  usage_ledger: [
    { col: 'run_id', table: 'generation_runs', owned: true },
    { col: 'transcription_job_id', table: 'transcription_jobs', owned: true },
  ],
  // T09
  variants: [{ col: 'content_id', table: 'contents', owned: true }],
  variant_versions: [
    { col: 'variant_id', table: 'variants', owned: true },
    { col: 'content_version_id', table: 'content_versions' },
  ],
  variant_assets: [
    { col: 'variant_version_id', table: 'variant_versions', owned: true },
    { col: 'asset_id', table: 'assets' },
  ],
  // T10: 항목은 계획이 이번에 들어갔거나 같을 때만, 스냅샷이 가리키는 행(계정·파생본·버전·원고 버전·브랜드)이 있을 때만. 승인은 그 항목에만.
  distribution_items: [
    { col: 'plan_id', table: 'distribution_plans', owned: true },
    { col: 'channel_account_id', table: 'channel_accounts' },
    { col: 'variant_id', table: 'variants' },
    { col: 'variant_version_id', table: 'variant_versions' },
    { col: 'content_version_id', table: 'content_versions' },
    { col: 'brand_profile_id', table: 'brand_profiles' },
  ],
  approvals: [{ col: 'distribution_item_id', table: 'distribution_items', owned: true }],
  // FIX-T11: 작업·전송 의도·원격 결과는 읽기 전용 이력 — 그 항목·작업이 이번에 들어갔을 때만(기존 항목에 이력을 덧붙이지 않는다).
  jobs: [{ col: 'item_id', table: 'distribution_items', owned: true }],
  send_intents: [{ col: 'job_id', table: 'jobs', owned: true }],
  publications: [
    { col: 'item_id', table: 'distribution_items', owned: true },
    { col: 'job_id', table: 'jobs', owned: true },
  ],
};

type Avail = 'inserted' | 'same' | 'different';

/**
 * 묶음 행을 현재 owner 로 넣는다(add_missing 규칙). 미리보기는 이것을 트랜잭션 안에서 실행하고 되돌린다.
 * 기존 행은 UPDATE 하지 않는다 — 유일한 UPDATE 는 이번에 넣은 원고의 current_version_id(null → 버전 id).
 */
export async function applyBundle(tx: DbOrTx, ownerId: string, bundle: ParsedBundle): Promise<ApplyReport> {
  const avail: Record<string, Map<string, Avail>> = {};
  const tables = {} as Record<RestoredTable, TableCounts>;
  const conflicts: RestoreConflict[] = [];
  const insertedAssetIds: string[] = [];
  const insertedContents: Array<{ id: string; currentVersionId: string | null }> = [];
  const insertedVariants: Array<{ id: string; currentVersionId: string | null }> = [];
  const blockedItems: string[] = [];
  const unknownItems: string[] = [];

  for (const name of RESTORED_TABLES) {
    const rows = bundle.tables[name] as unknown as Array<Record<string, unknown> & { id: string }>;
    const counts: TableCounts = { in_bundle: rows.length, new: 0, existing_same: 0, existing_different: 0 };
    const map = new Map<string, Avail>();
    avail[name] = map;
    const existing = new Map<string, { owner: string | null; hash: string }>();
    for (let i = 0; i < rows.length; i += 500) {
      const ids = rows.slice(i, i + 500).map((r) => r.id);
      for (const e of await selectBundleRows(tx, name, idIn(name, ids))) {
        existing.set(String(e.row.id), { owner: e.owner, hash: rowHash(e.row) });
      }
    }
    const conflict = (id: string, reason: RestoreConflict['reason']) => {
      counts.existing_different++;
      conflicts.push({ table: name, id, reason });
    };

    for (const row of rows) {
      const ex = existing.get(row.id);
      if (ex) {
        if (ex.owner !== ownerId) {
          conflict(row.id, 'id_in_use');
        } else if (ex.hash === rowHash(row)) {
          counts.existing_same++;
          map.set(row.id, 'same');
        } else {
          conflict(row.id, 'different');
          map.set(row.id, 'different');
        }
        continue;
      }
      const parentsOk = (PARENTS[name] ?? []).every((p) => {
        const v = row[p.col];
        if (v === null || v === undefined) return true;
        const a = avail[p.table]?.get(String(v));
        // 부모가 묶음과 내용이 다른 기존 행('different')이면 그 밑에 자식·관계를 붙이지 않는다(묶음의 의미적 관계 보존).
        return a !== undefined && a !== 'different';
      });
      if (!parentsOk) {
        conflict(row.id, 'dependency');
        continue;
      }
      // FIX-T09 round 2(P1): 이미 있던(동일) 파생본 버전에 첨부를 새로 붙이지 않는다 — 버전은 불변이고, 붙이면 검토 조건(미디어)이 바뀐다.
      if (name === 'variant_assets' && avail.variant_versions!.get(String(row.variant_version_id)) === 'same') {
        conflict(row.id, 'immutable_version');
        continue;
      }
      if (name === 'brand_profiles') {
        // (owner, version) unique: 같은 버전이 이미 있으면(예: seed) 내용이 같을 때만 "동일", 다르면 충돌. 덮어쓰지 않는다.
        // 같은 (owner, version) 이 다른 ID 로 이미 있으면(예: seed) 내용이 같아도 충돌이다 — 묶음의 ID 가 보존되지 않기 때문(결정 D6: ID 보존).
        // 같은 ID 인 경우는 위의 existing 분기에서 same/different 로 판정된다. 기존 행은 덮어쓰지 않는다.
        const r = row as unknown as { version: number };
        const found = await tx.execute(
          sql`select id from brand_profiles where owner_id = ${ownerId}::uuid and version = ${r.version}`,
        );
        if ((found as unknown as { rows: unknown[] }).rows.length > 0) {
          conflict(row.id, 'version_exists');
          continue;
        }
      }
      const overrides: Record<string, unknown> = name === 'contents' || name === 'variants' ? { current_version_id: null } : {};
      // T10(D17)·FIX-T10(P0): 작업은 복원하지 않는다 — 진행 중이던 항목은 새 환경에서 다시 보내지 않도록 restored_needs_review 를 켠다(자동 실행·재시도 금지).
      // 상태는 결과를 정할 수 있을 때만 바꾼다: 보내기 전 대기(QUEUED·RETRY_WAIT) → BLOCKED, 전송 중·결과 불명 → UNKNOWN(그대로 보존).
      const restoredStatus = name === 'distribution_items' ? restoredItemStatus(String(row.status)) : null;
      if (restoredStatus) {
        overrides.status = restoredStatus;
        overrides.restored_needs_review = true;
      }
      // FIX-T11(P1): 작업은 읽기 전용 이력 — 끝난 상태·BLOCKED·UNKNOWN 으로만, lease 없이, 복원 표시(자동 lease·재시도 없음).
      if (name === 'jobs') {
        overrides.state = restoredJobState(String(row.state));
        overrides.lease_owner = null;
        overrides.lease_until = null;
        overrides.heartbeat_at = null;
        overrides.restored_needs_review = true;
      }
      if (await insertBundleRow(tx, name, row, ownerId, overrides)) {
        if (restoredStatus === 'BLOCKED') blockedItems.push(row.id);
        if (restoredStatus === 'UNKNOWN') unknownItems.push(row.id);
        counts.new++;
        map.set(row.id, 'inserted');
        if (name === 'assets') insertedAssetIds.push(row.id);
        if (name === 'contents') insertedContents.push({ id: row.id, currentVersionId: (row.current_version_id as string | null) ?? null });
        if (name === 'variants') insertedVariants.push({ id: row.id, currentVersionId: (row.current_version_id as string | null) ?? null });
      } else {
        conflict(row.id, 'unique');
      }
    }
    tables[name] = counts;

    if (name === 'content_versions') {
      // 이번에 넣은 원고의 현재 버전을 연결한다. 버전이 들어가지 못했으면 원고가 본문 없이 남으므로 전체를 중단한다.
      for (const c of insertedContents) {
        if (c.currentVersionId === null) continue;
        if (avail.content_versions!.get(c.currentVersionId) !== 'inserted') {
          throw new AppError('conflict', 'restore_conflict', '원고의 현재 버전을 복원할 수 없어 복원을 중단했습니다', {
            conflicts: [{ table: 'contents', id: c.id, reason: 'dependency' }],
          });
        }
        await tx.execute(
          sql`update contents set current_version_id = ${c.currentVersionId}::uuid where id = ${c.id}::uuid and owner_id = ${ownerId}::uuid and current_version_id is null`,
        );
      }
    }
  }

  // T09: 이번에 넣은 파생본의 현재 버전을 연결한다(원고와 같은 규칙 — 버전이 들어가지 못했으면 전체 중단).
  for (const v of insertedVariants) {
    if (v.currentVersionId === null) continue;
    if (avail.variant_versions!.get(v.currentVersionId) !== 'inserted') {
      throw new AppError('conflict', 'restore_conflict', '채널 초안의 현재 버전을 복원할 수 없어 복원을 중단했습니다', {
        conflicts: [{ table: 'variants', id: v.id, reason: 'dependency' }],
      });
    }
    await tx.execute(
      sql`update variants set current_version_id = ${v.currentVersionId}::uuid where id = ${v.id}::uuid and owner_id = ${ownerId}::uuid and current_version_id is null`,
    );
  }

  // FIX-T06(P0): content_versions.ai_run_id ↔ generation_runs(input_version_id/output_ref) 는 서로 참조하는 순환이라 PARENTS 로
  // 표현하지 않고, 모든 표를 적용한 뒤 확인한다. 이번에 넣은 버전의 run 이 "이번에 넣음" 또는 "동일"이 아니면(충돌·의존성 실패로
  // 빠졌거나 내용이 다른 기존 행) 채택 이력이 A03 게이트에서 사라지므로 복원 전체를 중단한다.
  // T09: variant_versions.ai_run_id 도 같은 규칙.
  const orphanOf = (table: 'content_versions' | 'variant_versions') =>
    (bundle.tables[table] as Array<{ id: string; ai_run_id: string | null }>)
      .filter((v) => {
        if (v.ai_run_id === null || avail[table]!.get(v.id) !== 'inserted') return false;
        const a = avail.generation_runs!.get(v.ai_run_id);
        return a !== 'inserted' && a !== 'same';
      })
      .map((v) => ({ table, id: v.id, reason: 'dependency' as const }));
  const orphaned: RestoreConflict[] = [...orphanOf('content_versions'), ...orphanOf('variant_versions')];
  // T08: job 의 첫 전사(transcript_version_id)도 서로 참조하는 순환이라 여기서 확인한다 — 들어간 job 의 전사가 빠졌으면 중단.
  for (const j of bundle.tables.transcription_jobs) {
    if (j.transcript_version_id === null || avail.transcription_jobs!.get(j.id) !== 'inserted') continue;
    const a = avail.transcripts!.get(j.transcript_version_id);
    if (a !== 'inserted' && a !== 'same') orphaned.push({ table: 'transcription_jobs', id: j.id, reason: 'dependency' });
  }
  if (orphaned.length > 0) {
    throw new AppError('conflict', 'restore_conflict', 'AI 제안·채택 버전 또는 전사 작업의 실행 기록을 복원할 수 없어 복원을 중단했습니다', {
      conflicts: orphaned.slice(0, MAX_CONFLICTS_LISTED),
    });
  }
  // FIX-T09(P1): 이번에 넣은 review 파생본을 복원된 행(현재 버전·원고 현재 버전·실제 첨부 관계)으로 다시 검사하고,
  // 조건을 못 채우면 draft 로 낮춘다(검토 상태를 조건 없이 들여오지 않는다). 결과·미리보기에 이유와 함께 남긴다.
  const downgradedVariants: DowngradedVariant[] = [];
  for (const v of bundle.tables.variants) {
    if (avail.variants!.get(v.id) !== 'inserted' || (v.lifecycle !== 'review' && v.lifecycle !== 'approved')) continue;
    // FIX-T09 round 2(P1): 검토 요청과 같은 조건(현재 버전·stale·미디어·원고와 파생본의 미해결 경험 claim — 파생본은 나가는 글 전체 기준)을
    // 복원된 행(claim_confirmations 포함)으로 검사한다.
    const reasons = await variantReviewBlockers(tx, ownerId, v.id);
    if (reasons.length) {
      await tx.execute(sql`update variants set lifecycle = 'draft' where id = ${v.id}::uuid and owner_id = ${ownerId}::uuid`);
      downgradedVariants.push({ variant_id: v.id, channel: v.channel, reasons });
    }
  }
  // T08: 진행 중이던 전사 job 은 복원 환경의 worker 가 다시 처리하지 않도록 canceled 로 바꾸고, 예약 원장은 예약액으로 확정(failed=true)한다.
  const interruptedTranscriptions: string[] = [];
  for (const j of bundle.tables.transcription_jobs) {
    if (avail.transcription_jobs!.get(j.id) !== 'inserted' || (j.state !== 'queued' && j.state !== 'running')) continue;
    await tx.execute(
      sql`update transcription_jobs set state = 'canceled', error = '복원 시 진행 중이던 작업(중단됨)', finished_at = coalesce(finished_at, now()) where id = ${j.id}::uuid and owner_id = ${ownerId}::uuid`,
    );
    await tx.execute(
      sql`update usage_ledger set state = 'settled', actual_amount = reserved_amount, failed = true, settled_at = now() where transcription_job_id = ${j.id}::uuid and owner_id = ${ownerId}::uuid and state = 'reserved'`,
    );
    interruptedTranscriptions.push(j.id);
  }
  // FIX-T11(P1): 묶음에서 CONFIRMED 인데 원격 결과(publications)가 함께 들어오지 않은 항목은 근거가 없으므로 UNKNOWN(+restored_needs_review)으로,
  // 그 항목의 CONFIRMED 작업(가장 최근 것)도 UNKNOWN 으로 — 사용자 재확인(조회만)으로 다시 확인한다. 원격 결과가 있는 항목은 CONFIRMED 그대로.
  const unverifiedConfirmedItems: string[] = [];
  for (const i of bundle.tables.distribution_items) {
    if (avail.distribution_items!.get(i.id) !== 'inserted' || i.status !== 'CONFIRMED') continue;
    const pubs = await tx.select({ id: publications.id }).from(publications).where(and(eq(publications.itemId, i.id), eq(publications.ownerId, ownerId))).limit(1);
    if (pubs.length) continue;
    await tx.execute(
      sql`update distribution_items set status = 'UNKNOWN', restored_needs_review = true where id = ${i.id}::uuid and owner_id = ${ownerId}::uuid`,
    );
    const lastJob = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.itemId, i.id), eq(jobs.ownerId, ownerId), eq(jobs.state, 'CONFIRMED')))
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .limit(1);
    if (lastJob[0]) await tx.execute(sql`update jobs set state = 'UNKNOWN', done_at = null where id = ${lastJob[0].id}::uuid and owner_id = ${ownerId}::uuid`);
    unverifiedConfirmedItems.push(i.id);
  }
  // T10(D17): 이번에 넣은 활성 승인을 복원된 행으로 다시 검사한다(파생본 현재 버전·원고 현재 버전·첨부·계정·재계산 hash·예약 시각).
  // 맞지 않으면 'restore_stale' 로 철회해 둔다(승인 행·hash 는 그대로 보존). 그 뒤 활성 승인이 없는 approved 파생본은 review 로,
  // 이번에 넣은 계획의 상태는 항목·승인으로 다시 계산한다.
  const restoreNow = new Date();
  const revokedApprovals: ApplyReport['revokedApprovals'] = [];
  const itemById = new Map(bundle.tables.distribution_items.map((i) => [i.id, i]));
  for (const a of bundle.tables.approvals) {
    if (avail.approvals!.get(a.id) !== 'inserted' || a.revoked_at !== null) continue;
    const rows = await tx
      .select()
      .from(distributionItems)
      .where(and(eq(distributionItems.id, a.distribution_item_id), eq(distributionItems.ownerId, ownerId)))
      .limit(1);
    const item = rows[0];
    if (!item || !itemById.has(a.distribution_item_id)) continue;
    const reasons = await snapshotProblems(tx, ownerId, item, restoreNow);
    if (reasons.length === 0) continue;
    await tx.execute(
      sql`update approvals set revoked_at = ${restoreNow.toISOString()}::timestamptz, revoke_reason = 'restore_stale' where id = ${a.id}::uuid and owner_id = ${ownerId}::uuid and revoked_at is null`,
    );
    revokedApprovals.push({ approval_id: a.id, item_id: a.distribution_item_id, reasons });
  }
  await settleApprovedVariants(
    tx,
    ownerId,
    bundle.tables.variants.filter((v) => avail.variants!.get(v.id) === 'inserted' && v.lifecycle === 'approved').map((v) => v.id),
    'review',
    restoreNow,
  );
  for (const p of bundle.tables.distribution_plans) {
    if (avail.distribution_plans!.get(p.id) === 'inserted') await recomputePlanStatus(tx, ownerId, p.id, restoreNow);
  }
  return { tables, conflicts, insertedAssetIds, downgradedVariants, interruptedTranscriptions, blockedItems, unknownItems, unverifiedConfirmedItems, revokedApprovals };
}

/** owner 범위가 비었는지(소재·카드·원고·파일·출처 0건). 브랜드 프로필(seed)은 세지 않는다. */
export async function ownerScopeCounts(db: DbOrTx, ownerId: string) {
  const n = async (t: typeof captures | typeof ideas | typeof contents | typeof assets | typeof sources) =>
    (await db.select({ n: count() }).from(t).where(eq(t.ownerId, ownerId)))[0]?.n ?? 0;
  const counts = {
    captures: await n(captures),
    ideas: await n(ideas),
    contents: await n(contents),
    assets: await n(assets),
    sources: await n(sources),
  };
  return { counts, empty: Object.values(counts).every((v) => v === 0) };
}

class DryRunRollback extends Error {}

export interface RestorePreview {
  format: string;
  format_version: number;
  export_id: string;
  exported_at: string;
  app_version: string;
  schema_migrations: string[];
  manifest_sha256: string;
  owner_remap: { from: string; to: string };
  bundle_owner_identity_masked: string;
  files_verified: number;
  tables: Record<string, TableCounts & { restored: boolean }>;
  conflicts: RestoreConflict[];
  conflicts_total: number;
  assets: { total: number; included: number; missing: number; verified: number };
  target: { empty: boolean; counts: Record<string, number> };
  can_commit_empty_only: boolean;
  can_commit_add_missing: boolean;
  warnings: BundleManifest['warnings'];
  /** FIX-T09: 복원하면 draft 로 낮아질 review 파생본 */
  downgraded_variants: DowngradedVariant[];
  /** T08: 복원하면 canceled 로 들어갈 진행 중 전사 job */
  interrupted_transcriptions: string[];
  /** T10: 복원하면 BLOCKED 로 들어갈 보내기 전 대기 배포 항목(작업은 복원하지 않음) */
  blocked_items: string[];
  /** FIX-T10: 복원하면 UNKNOWN 으로 들어갈(결과 불명 보존) 배포 항목 */
  unknown_items: string[];
  /** FIX-T11: CONFIRMED 였지만 원격 결과 근거가 없어 UNKNOWN 으로 들어갈 항목 */
  unverified_confirmed_items: string[];
  /** T10: 복원하면 'restore_stale' 로 철회될 승인 */
  revoked_approvals: ApplyReport['revokedApprovals'];
}

/** 검증된 묶음을 현재 owner 에 대해 미리 계산한다(DB 변경 없음 — 계산 후 rollback). */
/**
 * FIX-T07(P1): 묶음의 비용 원장 통화가 현재 설정 통화와 다르면 미리보기 경고(복원은 허용 — 데이터이므로).
 * 복원 뒤 그 달에 다른 통화 원장이 있으면 AI 예약이 budget_currency_mismatch 로 거부된다.
 */
export function ledgerCurrencyWarnings(bundle: ParsedBundle, budgetCurrency: string | undefined): BundleManifest['warnings'] {
  if (!budgetCurrency) return [];
  const others = [...new Set(bundle.tables.usage_ledger.map((l) => l.currency))].filter((c) => c !== budgetCurrency).sort();
  return others.length
    ? [
        {
          code: 'ledger_currency_mismatch',
          message: `묶음의 AI 비용 원장 통화(${others.join(', ')})가 설정 통화(${budgetCurrency})와 다릅니다. 복원은 되지만, 같은 달에는 AI 호출이 통화 불일치로 거부됩니다.`,
        },
      ]
    : [];
}

export async function previewRestore(db: Db, ownerId: string, bundle: ParsedBundle, budgetCurrency?: string): Promise<RestorePreview> {
  const target = await ownerScopeCounts(db, ownerId);
  let report: ApplyReport | null = null;
  try {
    await db.transaction(async (tx) => {
      report = await applyBundle(tx, ownerId, bundle);
      throw new DryRunRollback();
    });
  } catch (e) {
    if (!(e instanceof DryRunRollback)) throw e;
  }
  const r = report as unknown as ApplyReport;
  const m = bundle.manifest;
  const tables: RestorePreview['tables'] = {};
  for (const [name, meta] of Object.entries(m.tables)) {
    const counts = r.tables[name as RestoredTable];
    tables[name] = counts
      ? { ...counts, restored: true }
      : { in_bundle: meta.rows, new: 0, existing_same: 0, existing_different: 0, restored: false };
  }
  const included = m.assets.filter((a) => !a.missing).length;
  return {
    format: m.format,
    format_version: m.format_version,
    export_id: m.export_id,
    exported_at: m.exported_at,
    app_version: m.app_version,
    schema_migrations: m.schema_migrations,
    manifest_sha256: bundle.manifestSha256,
    owner_remap: { from: m.owner.id, to: ownerId },
    bundle_owner_identity_masked: m.owner.identity_masked,
    files_verified: bundle.files.length,
    tables,
    conflicts: r.conflicts.slice(0, MAX_CONFLICTS_LISTED),
    conflicts_total: r.conflicts.length,
    downgraded_variants: r.downgradedVariants,
    interrupted_transcriptions: r.interruptedTranscriptions,
    blocked_items: r.blockedItems,
    unknown_items: r.unknownItems,
    unverified_confirmed_items: r.unverifiedConfirmedItems,
    revoked_approvals: r.revokedApprovals,
    assets: { total: m.assets.length, included, missing: m.assets.length - included, verified: bundle.assetBytes.size },
    target,
    can_commit_empty_only: target.empty && r.conflicts.length === 0,
    can_commit_add_missing: true,
    warnings: [...m.warnings, ...ledgerCurrencyWarnings(bundle, budgetCurrency)],
  };
}

/** ZIP 바이트 → 검증된 묶음(migration 호환 포함). 실패는 ZipFormatError/BundleError(400). */
export async function parseBundleZip(zip: Uint8Array): Promise<ParsedBundle> {
  return parseBundle(readZip(zip), { migrations: await readMigrationTags() });
}

export type RestoreRunRow = typeof restoreRuns.$inferSelect;

export interface CreatePreviewOptions {
  restoresDir: string;
  source: 'upload' | 'export_run';
  now?: Date;
  /** FIX-T07: 현재 설정 통화(LLM_BUDGET_CURRENCY) — 다른 통화 원장이 있으면 미리보기 경고 */
  budgetCurrency?: string;
}

/**
 * 미리보기를 만들고 restore_runs(previewed) 를 남긴다. zip 은 검증을 통과한 뒤에만 <restoresDir>/<id>.zip 에 둔다.
 * 이미 파일로 받아 둔 경우 zipFile 을 넘기면 그 파일을 옮긴다(업로드 임시 파일).
 */
export async function createRestorePreview(
  db: Db,
  ownerId: string,
  zip: Uint8Array,
  opts: CreatePreviewOptions,
): Promise<{ restoreId: string; preview: RestorePreview }> {
  const bundle = await parseBundleZip(zip);
  const preview = await previewRestore(db, ownerId, bundle, opts.budgetCurrency);
  const restoreId = randomUUID();
  await mkdir(opts.restoresDir, { recursive: true });
  const file = restoreZipPath(opts.restoresDir, restoreId);
  await writeFile(file, zip, { flag: 'wx' });
  try {
    await db.transaction(async (tx) => {
      await tx.insert(restoreRuns).values({
        id: restoreId,
        ownerId,
        createdAt: opts.now ?? new Date(),
        source: opts.source,
        manifestSha256: bundle.manifestSha256,
        preview: preview as unknown as Record<string, unknown>,
        status: 'previewed',
      });
      await recordAudit(tx, {
        ownerId,
        action: 'restore.preview',
        entity: 'restore',
        entityId: restoreId,
        versionOrHash: bundle.manifestSha256,
        details: {
          source: opts.source,
          conflicts: preview.conflicts_total,
          can_commit_empty_only: preview.can_commit_empty_only,
        },
        at: opts.now,
      });
    });
  } catch (e) {
    await rm(file, { force: true }).catch(() => undefined);
    throw e;
  }
  return { restoreId, preview };
}

/** owner 자신의 내보내기(export_runs)로 미리보기. 다른 owner·없는 ID → 404. */
export async function createRestorePreviewFromExport(
  db: Db,
  ownerId: string,
  exportId: string,
  opts: { exportsDir: string; restoresDir: string; now?: Date; budgetCurrency?: string },
): Promise<{ restoreId: string; preview: RestorePreview }> {
  const run = await getExportRun(db, ownerId, exportId.toLowerCase());
  if (!run || run.status !== 'completed') throw new NotFoundError('내보내기를 찾을 수 없습니다');
  let zip: Uint8Array;
  try {
    zip = new Uint8Array(await readFile(exportZipPath(opts.exportsDir, run.id)));
  } catch {
    throw new NotFoundError('내보내기 파일이 서버에 없습니다');
  }
  return createRestorePreview(db, ownerId, zip, {
    restoresDir: opts.restoresDir,
    source: 'export_run',
    now: opts.now,
    budgetCurrency: opts.budgetCurrency,
  });
}

export function restoreZipPath(restoresDir: string, restoreId: string): string {
  if (!isUuid(restoreId)) throw new Error('잘못된 복원 ID');
  return path.join(restoresDir, `${restoreId}.zip`);
}

export async function getRestoreRun(db: DbOrTx, ownerId: string, id: string): Promise<RestoreRunRow | null> {
  if (!isUuid(id)) return null;
  const rows = await db
    .select()
    .from(restoreRuns)
    .where(and(eq(restoreRuns.id, id), eq(restoreRuns.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

export interface CommitOptions {
  mode: RestoreMode;
  confirm: true;
  restoresDir: string;
  now?: Date;
}

export interface CommitResult {
  restore_id: string;
  mode: RestoreMode;
  restored: Record<string, number>;
  skipped_identical: Record<string, number>;
  conflicts: RestoreConflict[];
  conflicts_total: number;
  assets_written: number;
  assets_verified: number;
  assets_missing: number;
  committed_at: string;
  downgraded_variants: DowngradedVariant[];
  /** T08 */
  interrupted_transcriptions: string[];
  /** T10 */
  blocked_items: string[];
  /** FIX-T10 */
  unknown_items: string[];
  /** FIX-T11 */
  unverified_confirmed_items: string[];
  revoked_approvals: ApplyReport['revokedApprovals'];
}

async function markRun(db: Db, ownerId: string, id: string, status: 'rejected' | 'failed') {
  await db
    .update(restoreRuns)
    .set({ status })
    .where(and(eq(restoreRuns.id, id), eq(restoreRuns.ownerId, ownerId), eq(restoreRuns.status, 'previewed')));
}

/**
 * 커밋. confirm 이 true 가 아니면 400. 다른 owner·없는 ID → 404. 이미 커밋 → 409 already_committed.
 * empty_only 인데 비어 있지 않음 → 409 restore_target_not_empty(상태는 previewed 로 남아 add_missing 으로 다시 시도 가능).
 */
export async function commitRestore(
  db: Db,
  storage: BlobStore,
  ownerId: string,
  restoreId: string,
  opts: CommitOptions,
): Promise<CommitResult> {
  if (opts.confirm !== true) throw new AppError('bad_request', 'confirm_required', '내용을 확인했다는 표시(confirm)가 필요합니다');
  if (!RESTORE_MODES.includes(opts.mode)) throw new AppError('bad_request', 'bad_request', 'mode 는 empty_only 또는 add_missing 입니다');
  const run = await getRestoreRun(db, ownerId, restoreId.toLowerCase());
  if (!run) throw new NotFoundError('복원 미리보기를 찾을 수 없습니다');
  if (run.status === 'committed') throw new AlreadyCommittedError();
  if (run.status !== 'previewed') throw new RestoreNotCommittableError(run.status);

  // 미리보기를 믿지 않는다: 저장된 ZIP 을 다시 읽고 검증한다.
  let zip: Uint8Array;
  try {
    zip = new Uint8Array(await readFile(restoreZipPath(opts.restoresDir, run.id)));
  } catch {
    throw new RestoreFileMissingError();
  }
  let bundle: ParsedBundle;
  try {
    bundle = await parseBundleZip(zip);
    if (bundle.manifestSha256 !== run.manifestSha256) {
      throw new AppError('bad_request', 'manifest_mismatch', '미리보기 이후 복원 파일이 바뀌었습니다. 파일을 다시 올려 미리보기를 만드세요.');
    }
  } catch (e) {
    await markRun(db, ownerId, run.id, 'rejected');
    throw e;
  }

  const now = opts.now ?? new Date();
  try {
    return await db.transaction(async (tx) => {
      const locked = await tx
        .select({ status: restoreRuns.status })
        .from(restoreRuns)
        .where(and(eq(restoreRuns.id, run.id), eq(restoreRuns.ownerId, ownerId)))
        .for('update');
      if (locked[0]?.status === 'committed') throw new AlreadyCommittedError();
      if (locked[0]?.status !== 'previewed') throw new RestoreNotCommittableError(locked[0]?.status ?? 'unknown');

      if (opts.mode === 'empty_only') {
        const scope = await ownerScopeCounts(tx, ownerId);
        if (!scope.empty) throw new RestoreTargetNotEmptyError({ target: scope.counts });
      }
      const report = await applyBundle(tx, ownerId, bundle);
      if (opts.mode === 'empty_only' && report.conflicts.length > 0) {
        throw new RestoreConflictError({ conflicts: report.conflicts.slice(0, MAX_CONFLICTS_LISTED), conflicts_total: report.conflicts.length });
      }

      // 파일 바이트: 같은 key 로 쓰고 다시 읽어 sha256 확인. 실패하면 트랜잭션 전체를 되돌린다(이미 쓴 파일은 고아로 남을 수 있음).
      let written = 0;
      let verified = 0;
      let missing = 0;
      const assetById = new Map(bundle.tables.assets.map((a) => [a.id, a]));
      for (const id of report.insertedAssetIds) {
        const a = assetById.get(id)!;
        const bytes = bundle.assetBytes.get(id);
        if (!bytes) {
          missing++;
          continue;
        }
        await storage.put(a.key, bytes);
        written++;
        const back = await storage.get(a.key);
        if (!back || sha256Hex(back) !== a.checksum) {
          throw new Error('복원한 파일의 checksum 이 일치하지 않습니다');
        }
        verified++;
      }

      const restored: Record<string, number> = {};
      const skipped: Record<string, number> = {};
      for (const [name, c] of Object.entries(report.tables)) {
        restored[name] = c.new;
        skipped[name] = c.existing_same;
      }
      const result: CommitResult = {
        restore_id: run.id,
        mode: opts.mode,
        restored,
        skipped_identical: skipped,
        conflicts: report.conflicts.slice(0, MAX_CONFLICTS_LISTED),
        conflicts_total: report.conflicts.length,
        downgraded_variants: report.downgradedVariants,
        interrupted_transcriptions: report.interruptedTranscriptions,
        blocked_items: report.blockedItems,
        unknown_items: report.unknownItems,
        unverified_confirmed_items: report.unverifiedConfirmedItems,
        revoked_approvals: report.revokedApprovals,
        assets_written: written,
        assets_verified: verified,
        assets_missing: missing,
        committed_at: now.toISOString(),
      };
      const updated = await tx
        .update(restoreRuns)
        .set({ status: 'committed', committedAt: now, mode: opts.mode, result: result as unknown as Record<string, unknown> })
        .where(and(eq(restoreRuns.id, run.id), eq(restoreRuns.ownerId, ownerId), eq(restoreRuns.status, 'previewed')))
        .returning({ id: restoreRuns.id });
      if (!updated[0]) throw new AlreadyCommittedError();
      await recordAudit(tx, {
        ownerId,
        action: 'restore.commit',
        entity: 'restore',
        entityId: run.id,
        versionOrHash: run.manifestSha256,
        details: {
          mode: opts.mode,
          rows: Object.values(restored).reduce((n, v) => n + v, 0),
          skipped: Object.values(skipped).reduce((n, v) => n + v, 0),
          conflicts: report.conflicts.length,
          assets_written: written,
          assets_verified: verified,
        },
        at: now,
      });
      return result;
    });
  } catch (e) {
    if (!(e instanceof AppError)) await markRun(db, ownerId, run.id, 'failed').catch(() => undefined);
    throw e;
  }
}

/** 화면 표시용 목록. */
export async function listRestoreRuns(db: Db, ownerId: string, limit = 20): Promise<RestoreRunRow[]> {
  return db
    .select()
    .from(restoreRuns)
    .where(eq(restoreRuns.ownerId, ownerId))
    .orderBy(sql`${restoreRuns.createdAt} desc`, sql`${restoreRuns.id} desc`)
    .limit(limit);
}
