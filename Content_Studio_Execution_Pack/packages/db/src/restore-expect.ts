/**
 * FIX round 1(Codex review-T20 P1): 복원 훈련의 **기대 복원값**. 복원이 안전을 위해 바꾸는 열을 비교에서 빼지 않고,
 * 원본 묶음에서 복원 규칙(D17~D19·FIX-T10/T11)을 독립적으로 적용한 값을 만든다 — 훈련은 모든 열을 이 값과 비교한다.
 *
 * 규칙(restore.ts applyBundle 과 같은 문서화된 규칙을 여기서 다시 계산한다 — 복원 코드를 호출하지 않는다):
 *  - distribution_items: 진행 중(restoredItemStatus) → BLOCKED/UNKNOWN + restored_needs_review=true. CONFIRMED 인데 묶음에 그 항목의 원격 결과
 *    (publications)가 없으면 UNKNOWN + restored_needs_review=true.
 *  - jobs: state = restoredJobState(원본), lease_owner·lease_until·heartbeat_at = null, restored_needs_review = true.
 *    위의 "근거 없는 CONFIRMED" 항목은 그 항목의 (변환 뒤) CONFIRMED 작업 중 가장 최근 것이 UNKNOWN, done_at = null.
 *  - approvals: 그대로. 복원이 "restore_stale" 로 철회했다고 **선언한**(커밋 결과 revoked_approvals) 승인만 revoked_at = 복원 시각, revoke_reason = restore_stale.
 *  - variants: 커밋 결과 downgraded_variants 에 선언된 것은 draft. 원본이 approved 인데 기대 활성 승인(그 파생본의 현재 버전을 가리키는 항목)이
 *    없으면 review(updated_at = 복원 시각). 그 밖은 그대로.
 *  - distribution_plans: 상태 = planStatusFrom(기대 항목 상태·기대 활성 승인). 원본과 다르면 revision + 1, updated_at = 복원 시각.
 *  - transcription_jobs: queued·running → canceled, error 고정 문구, finished_at = 원본 값 또는 복원 시각.
 *  - usage_ledger: 그 중단된 전사의 reserved 원장 → settled, actual_amount = reserved_amount, failed = true, settled_at = 복원 시각. 그 밖의 금액은 그대로.
 * 시각처럼 복원 때 정해지는 값은 "훈련 시작 ~ 끝 사이"인지로 확인한다(RESTORE_TIME).
 */
import { planStatusFrom, restoredItemStatus, restoredJobState, stableStringify, type BundleTables, type RestoredTable } from '@cs/domain';

/** 값 자리표시: 복원 시각(훈련 시작~끝 사이의 시각)이어야 한다. */
export const RESTORE_TIME = Symbol('restore_time');
/** 값 자리표시: 원본 값 그대로이거나 복원 시각. */
export interface SameOrRestoreTime {
  sameOrRestoreTime: unknown;
}

export type ExpectedValue = unknown | typeof RESTORE_TIME | SameOrRestoreTime;
export type ExpectedRow = Record<string, ExpectedValue>;

export interface DeclaredTransforms {
  downgradedVariants: readonly string[];
  revokedApprovals: readonly string[];
}

export const INTERRUPTED_TRANSCRIPTION_ERROR = '복원 시 진행 중이던 작업(중단됨)';

type Row = Record<string, unknown>;
const rows = (t: BundleTables, name: RestoredTable) => t[name] as unknown as Row[];
const isSameOrTime = (v: unknown): v is SameOrRestoreTime => typeof v === 'object' && v !== null && 'sameOrRestoreTime' in (v as object);

/** 표마다 기대 복원 행(id → 행). 변환이 없는 표는 원본 행 그대로. */
export function expectedRestoredRows(t: BundleTables, declared: DeclaredTransforms): Record<RestoredTable, Map<string, ExpectedRow>> {
  const out = {} as Record<RestoredTable, Map<string, ExpectedRow>>;
  const copy = (name: RestoredTable) => new Map(rows(t, name).map((r) => [String(r.id), { ...r } as ExpectedRow]));
  for (const name of Object.keys(t) as RestoredTable[]) out[name] = copy(name);

  // 항목
  const pubItems = new Set(rows(t, 'publications').map((p) => String(p.item_id)));
  const unverified = new Set<string>();
  for (const i of out.distribution_items?.values() ?? []) {
    const s = restoredItemStatus(String(i.status));
    if (s) {
      i.status = s;
      i.restored_needs_review = true;
    } else if (i.status === 'CONFIRMED' && !pubItems.has(String(i.id))) {
      i.status = 'UNKNOWN';
      i.restored_needs_review = true;
      unverified.add(String(i.id));
    }
  }
  // 작업
  for (const j of out.jobs?.values() ?? []) {
    j.state = restoredJobState(String(j.state));
    j.lease_owner = null;
    j.lease_until = null;
    j.heartbeat_at = null;
    j.restored_needs_review = true;
  }
  for (const itemId of unverified) {
    const confirmed = [...(out.jobs?.values() ?? [])]
      .filter((j) => j.item_id === itemId && j.state === 'CONFIRMED')
      .sort((a, b) => (String(b.created_at) < String(a.created_at) ? -1 : String(b.created_at) > String(a.created_at) ? 1 : String(b.id) < String(a.id) ? -1 : 1));
    if (confirmed[0]) {
      confirmed[0].state = 'UNKNOWN';
      confirmed[0].done_at = null;
    }
  }
  // 승인(선언된 철회만)
  const revoked = new Set(declared.revokedApprovals);
  for (const a of out.approvals?.values() ?? []) {
    if (revoked.has(String(a.id))) {
      a.revoked_at = RESTORE_TIME;
      a.revoke_reason = 'restore_stale';
    }
  }
  const activeByItem = new Map<string, boolean>();
  for (const a of out.approvals?.values() ?? []) if (a.revoked_at === null) activeByItem.set(String(a.distribution_item_id), true);
  // 파생본
  const downgraded = new Set(declared.downgradedVariants);
  for (const v of out.variants?.values() ?? []) {
    if (downgraded.has(String(v.id))) {
      v.lifecycle = 'draft';
      continue;
    }
    if (v.lifecycle !== 'approved') continue;
    const still = [...(out.distribution_items?.values() ?? [])].some(
      (i) => i.variant_id === v.id && i.variant_version_id === v.current_version_id && activeByItem.get(String(i.id)) === true,
    );
    if (!still) {
      v.lifecycle = 'review';
      v.updated_at = { sameOrRestoreTime: v.updated_at } satisfies SameOrRestoreTime;
    }
  }
  // 계획
  for (const p of out.distribution_plans?.values() ?? []) {
    const items = [...(out.distribution_items?.values() ?? [])]
      .filter((i) => i.plan_id === p.id)
      .map((i) => ({ status: String(i.status), activeApproval: activeByItem.get(String(i.id)) === true }));
    const status = planStatusFrom(items);
    if (status !== p.status) {
      p.status = status;
      p.revision = Number(p.revision) + 1;
      p.updated_at = RESTORE_TIME;
    }
  }
  // 전사·원장
  const interrupted = new Set<string>();
  for (const j of out.transcription_jobs?.values() ?? []) {
    if (j.state !== 'queued' && j.state !== 'running') continue;
    interrupted.add(String(j.id));
    j.state = 'canceled';
    j.error = INTERRUPTED_TRANSCRIPTION_ERROR;
    j.finished_at = j.finished_at === null ? RESTORE_TIME : j.finished_at;
  }
  for (const l of out.usage_ledger?.values() ?? []) {
    if (l.transcription_job_id === null || !interrupted.has(String(l.transcription_job_id)) || l.state !== 'reserved') continue;
    l.state = 'settled';
    l.actual_amount = l.reserved_amount;
    l.failed = true;
    l.settled_at = RESTORE_TIME;
  }
  return out;
}

/** 원본과 기대값이 다른(복원 규칙이 적용된) 행 수 — 화면 요약용. */
export function transformedRowCount(src: readonly Row[], expected: Map<string, ExpectedRow>): number {
  let n = 0;
  for (const r of src) {
    const e = expected.get(String(r.id));
    if (e && Object.keys(e).some((k) => e[k] === RESTORE_TIME || isSameOrTime(e[k]) || stableStringify(e[k] as unknown) !== stableStringify(r[k]))) n++;
  }
  return n;
}

/** 한 칸이 기대값과 맞는가. 시각 자리표시는 [from, to] 안의 ISO 시각이어야 한다. */
export function valueMatches(expected: ExpectedValue, actual: unknown, window: { from: Date; to: Date }): boolean {
  const inWindow = (v: unknown) => {
    if (typeof v !== 'string') return false;
    const t = Date.parse(v);
    return Number.isFinite(t) && t >= window.from.getTime() && t <= window.to.getTime();
  };
  if (expected === RESTORE_TIME) return inWindow(actual);
  if (isSameOrTime(expected)) return stableStringify(expected.sameOrRestoreTime) === stableStringify(actual) || inWindow(actual);
  return stableStringify(expected) === stableStringify(actual);
}
