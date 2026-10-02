/**
 * FIX round 1·3(Codex review-T20 P1, review-FIX-T20 P1·P2): 복원 훈련의 **기대 복원값**. 복원이 안전을 위해 바꾸는 열을 비교에서 빼지 않고,
 * 원본 묶음에서 복원 규칙(D17~D19·FIX-T10/T11)을 독립적으로 적용한 값을 만든다 — 훈련은 모든 열을 이 값과 비교한다.
 * 복원 코드(applyBundle·snapshotProblems·variantReviewBlockers)는 호출하지 않는다. 같은 문서화된 규칙을 묶음 행과 @cs/domain 의 순수 함수
 * (isVariantStale·mediaCompleteness·unconfirmedExperienceClaims·renderVariantText·buildCanonicalPayload·payloadHash)로 다시 계산한다.
 *
 * 규칙:
 *  - variants: review·approved 인데 검토 차단 조건(현재 버전 없음·stale·미디어 부족·미해결 경험 claim)이 있으면 draft(이 집합 = 기대 강등 집합).
 *  - distribution_items: 진행 중(restoredItemStatus) → BLOCKED/UNKNOWN + restored_needs_review=true. CONFIRMED 인데 묶음에 그 항목의 원격 결과
 *    (publications)가 없으면 UNKNOWN + restored_needs_review=true.
 *  - jobs: state = restoredJobState(원본), lease_owner·lease_until·heartbeat_at = null, restored_needs_review = true.
 *    위의 "근거 없는 CONFIRMED" 항목은 그 항목의 (변환 뒤) CONFIRMED 작업 중 가장 최근 것이 UNKNOWN, done_at = null.
 *  - approvals: 활성 승인의 스냅샷 문제(파생본 버전·lifecycle·원고 버전·첨부·계정·재계산 hash·브랜드·예약 시각 ≤ 판정 시각·검토 차단)가 있으면
 *    revoked_at = 판정 시각, revoke_reason = restore_stale(이 집합 = 기대 철회 집합). FIX round 4: 판정 시각은 훈련이 복원에 넘긴 같은 시각이라
 *    철회 여부가 정해진다(모호한 분기 없음).
 *  - variants(이어서): 원본 approved 이고 강등되지 않았는데 기대 활성 승인(그 파생본의 현재 버전을 가리키는 항목)이 없으면 review(updated_at = 원본 또는 복원 시각).
 *  - distribution_plans: 상태 = planStatusFrom(기대 항목 상태·기대 활성 승인). 원본과 다르면 revision + 1, updated_at = 복원 시각.
 *  - transcription_jobs: queued·running → canceled, error 고정 문구, finished_at = 원본 값 또는 복원 시각.
 *  - channel_accounts(T13): credential_state linked → needs_reconnect(연결 정보는 묶음 밖).
 *  - usage_ledger: 그 중단된 전사의 reserved 원장 → settled, actual_amount = reserved_amount, failed = true, settled_at = 복원 시각. 그 밖의 금액은 그대로.
 * 판정 시각(decisionAt)으로 정해지는 값(승인 철회 시각·계획/파생본 updated_at)은 그 시각과 정확히 같아야 한다. DB now() 로 정해지는 값(원장 settled_at·
 * 전사 finished_at)은 실제 복원 호출 직전~직후 구간 안인지 본다. 원래 시각을 보존해야 하는 열은 정확히 비교한다.
 */
import {
  buildCanonicalPayload,
  providerMetadataOf,
  isVariantStale,
  mediaCompleteness,
  payloadHash,
  planStatusFrom,
  renderVariantText,
  restoredItemStatus,
  restoredJobState,
  stableStringify,
  unconfirmedExperienceClaims,
  type BundleTables,
  type Channel,
  type RestoredTable,
  type Visibility,
} from '@cs/domain';
import { claimsOf } from './claims-gate';

/** 값 자리표시: 복원 시각(복원 호출 구간 안의 시각)이어야 한다. */
export const RESTORE_TIME = Symbol('restore_time');
/** 값 자리표시: 원본 값 그대로이거나 복원 시각. 클래스 인스턴스라 일반 JSON 값과 겹치지 않는다(FIX round 3 P2). */
export class SameOrRestoreTime {
  constructor(readonly original: unknown) {}
}

export type ExpectedValue = unknown;
export type ExpectedRow = Record<string, ExpectedValue>;

export interface DerivedTransforms {
  downgradedVariants: Set<string>;
  revokedApprovals: Set<string>;
  /** 판정 시각 — 복원에 넘긴 것과 같은 시각 */
  decisionAt: Date;
}

/** 묶음 행의 시각 형식(마이크로초 6자리, UTC). */
export const bundleTime = (d: Date) => d.toISOString().replace(/\.(\d{3})Z$/u, '.$1000Z');

export const INTERRUPTED_TRANSCRIPTION_ERROR = '복원 시 진행 중이던 작업(중단됨)';

type Row = Record<string, unknown>;
const rows = (t: BundleTables, name: RestoredTable) => t[name] as unknown as Row[];
const byId = (list: readonly Row[]) => new Map(list.map((r) => [String(r.id), r]));
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

/** 묶음 행만으로 복원의 강등·철회 대상 집합을 계산한다(복원 결과를 보지 않는다). */
export function deriveRestoreTransforms(t: BundleTables, decisionAt: Date): DerivedTransforms {
  const variants = byId(rows(t, 'variants'));
  const versions = byId(rows(t, 'variant_versions'));
  const contents = byId(rows(t, 'contents'));
  const contentVersions = byId(rows(t, 'content_versions'));
  const assets = byId(rows(t, 'assets'));
  const accounts = byId(rows(t, 'channel_accounts'));
  const items = byId(rows(t, 'distribution_items'));
  const runs = rows(t, 'generation_runs');
  const confirmations = rows(t, 'claim_confirmations').map((c) => ({
    runId: String(c.run_id),
    claimIndex: Number(c.claim_index),
    resolution: String(c.resolution) as 'confirmed',
  }));
  const attachedOf = (versionId: string) =>
    rows(t, 'variant_assets')
      .filter((va) => va.variant_version_id === versionId)
      .map((va) => ({ va, asset: assets.get(String(va.asset_id)) }))
      .sort((a, b) => Number(a.va.position) - Number(b.va.position));

  const blockers = (v: Row): string[] => {
    const cur = versions.get(String(v.current_version_id));
    if (!cur) return ['no_current_version'];
    const out: string[] = [];
    const content = contents.get(String(v.content_id));
    if (isVariantStale(str(cur.content_version_id), str(content?.current_version_id))) out.push('stale');
    const media = mediaCompleteness(
      v.channel as Channel,
      attachedOf(String(cur.id)).map((a) => ({ role: String(a.va.role), mime: String(a.asset?.mime ?? '') })),
    );
    if (!media.complete) out.push(...media.missing.map((m) => `media_incomplete:${m}`));
    // 원고의 채택된 AI 제안 claim(원고 현재 본문 기준)
    const contentRuns = runs.filter((r) => r.content_id === v.content_id && r.status === 'succeeded');
    const runIds = new Set(contentRuns.map((r) => String(r.id)));
    const adopted = new Set(
      rows(t, 'content_versions')
        .filter((cv) => cv.content_id === v.content_id && cv.created_by === 'owner' && cv.ai_run_id !== null && runIds.has(String(cv.ai_run_id)))
        .map((cv) => String(cv.ai_run_id)),
    );
    const pending: unknown[] = [];
    if (adopted.size > 0) {
      const body = content ? str(contentVersions.get(String(content.current_version_id))?.body) : null;
      pending.push(
        ...unconfirmedExperienceClaims(
          contentRuns.map((r) => ({ runId: String(r.id), adopted: adopted.has(String(r.id)), claims: claimsOf(r.output_json as Record<string, unknown> | null) })),
          confirmations.filter((c) => runIds.has(c.runId)),
          body ?? undefined,
        ),
      );
    }
    // 이 파생본의 채택 AI 제안 claim(나가는 글 전체 기준)
    if (cur.ai_run_id) {
      const run = runs.find((r) => r.id === cur.ai_run_id && r.status === 'succeeded' && r.variant_id === cur.variant_id);
      if (run) {
        pending.push(
          ...unconfirmedExperienceClaims(
            [{ runId: String(run.id), adopted: true, claims: claimsOf(run.output_json as Record<string, unknown> | null) }],
            confirmations.filter((c) => c.runId === String(run.id)),
            renderVariantText(v.channel as Channel, String(cur.body), (cur.metadata_json ?? {}) as Record<string, unknown>),
          ),
        );
      }
    }
    if (pending.length) out.push('unresolved_claims');
    return out;
  };

  const downgradedVariants = new Set<string>();
  const lifecycleAfter = new Map<string, string>();
  const blockersOf = new Map<string, string[]>();
  for (const v of variants.values()) {
    const b = blockers(v);
    blockersOf.set(String(v.id), b);
    if ((v.lifecycle === 'review' || v.lifecycle === 'approved') && b.length) {
      downgradedVariants.add(String(v.id));
      lifecycleAfter.set(String(v.id), 'draft');
    } else lifecycleAfter.set(String(v.id), String(v.lifecycle));
  }

  const brand = [...rows(t, 'brand_profiles')].sort((a, b) => Number(b.version) - Number(a.version))[0];
  const revokedApprovals = new Set<string>();
  for (const a of rows(t, 'approvals')) {
    if (a.revoked_at !== null) continue;
    const item = items.get(String(a.distribution_item_id));
    if (!item) continue;
    const problems: string[] = [];
    const variant = variants.get(String(item.variant_id));
    if (!variant || variant.current_version_id !== item.variant_version_id) problems.push('variant_changed');
    const life = variant ? lifecycleAfter.get(String(variant.id)) : undefined;
    if (variant && life !== 'review' && life !== 'approved') problems.push('variant_not_review');
    const content = variant ? contents.get(String(variant.content_id)) : undefined;
    if (str(content?.current_version_id) !== str(item.content_version_id)) problems.push('content_changed');
    const attached = attachedOf(String(item.variant_version_id));
    const payload = (item.payload_json ?? {}) as { assets?: Array<Record<string, unknown>>; provider_account_id?: unknown };
    const live = attached.map((x) => ({ id: str(x.asset?.id), checksum: str(x.asset?.checksum), role: str(x.va.role), order: Number(x.va.position), mime: str(x.asset?.mime) }));
    const snap = (payload.assets ?? []).map((x) => ({ id: str(x.id), checksum: str(x.checksum), role: str(x.role), order: Number(x.order), mime: str(x.mime) }));
    if (attached.some((x) => !x.asset || x.asset.deleted_at !== null) || JSON.stringify(live) !== JSON.stringify(snap)) problems.push('assets_changed');
    const acc = accounts.get(String(item.channel_account_id));
    const ready = acc ? (acc.kind === 'mock' ? acc.state === 'mock_ready' : acc.state === 'connected') : false;
    if (!acc || !ready || acc.external_account_id !== payload.provider_account_id || (variant && acc.platform !== variant.channel)) problems.push('account_changed');
    if (variant && acc) {
      const vv = versions.get(String(item.variant_version_id));
      if (vv) {
        const recomputed = buildCanonicalPayload({
          contentVersionId: String(item.content_version_id),
          variantVersionId: String(item.variant_version_id),
          brandProfileVersionId: str(item.brand_profile_id),
          channelAccountId: String(item.channel_account_id),
          providerAccountId: String(acc.external_account_id),
          channel: variant.channel as Channel,
          body: String(vv.body),
          metadata: (vv.metadata_json ?? {}) as Record<string, unknown>,
          assets: attached.map((x) => ({ id: String(x.asset?.id), checksum: String(x.asset?.checksum), role: String(x.va.role), position: Number(x.va.position), mime: String(x.asset?.mime) })),
          visibility: item.visibility as Visibility,
          scheduledAtUtc: item.scheduled_at_utc ? new Date(String(item.scheduled_at_utc)) : null,
          timezone: String(item.schedule_timezone),
          providerMetadata: providerMetadataOf(item.payload_json),
        } as Parameters<typeof buildCanonicalPayload>[0]);
        if (payloadHash(recomputed) !== item.payload_hash) problems.push('payload_changed');
      } else problems.push('variant_changed');
    }
    if (payloadHash(item.payload_json as Record<string, unknown>) !== item.payload_hash) problems.push('payload_changed');
    if (str(brand?.id) !== str(item.brand_profile_id)) problems.push('brand_changed');
    if (variant && (blockersOf.get(String(variant.id)) ?? []).length) problems.push('blocked');
    if (item.scheduled_at_utc && Date.parse(String(item.scheduled_at_utc)) <= decisionAt.getTime()) problems.push('schedule_passed');
    const publishAt = providerMetadataOf(item.payload_json).publish_at;
    if (publishAt && Date.parse(publishAt) <= decisionAt.getTime()) problems.push('publish_at_passed');
    if (problems.length) revokedApprovals.add(String(a.id));
  }
  return { downgradedVariants, revokedApprovals, decisionAt };
}

/**
 * 표마다 기대 복원 행(id → 행). 변환이 없는 표는 원본 행 그대로.
 * declaredRevoked: 복원이 철회했다고 알린 승인 — 모호한(예약 시각이 복원 구간 안) 승인에만 쓴다. 그 밖에는 독립 계산 결과만 쓴다.
 */
export function expectedRestoredRows(t: BundleTables, derived: DerivedTransforms): Record<RestoredTable, Map<string, ExpectedRow>> {
  const out = {} as Record<RestoredTable, Map<string, ExpectedRow>>;
  const copy = (name: RestoredTable) => new Map(rows(t, name).map((r) => [String(r.id), { ...r } as ExpectedRow]));
  for (const name of Object.keys(t) as RestoredTable[]) out[name] = copy(name);

  // 파생본 강등(검토 차단)
  for (const v of out.variants?.values() ?? []) if (derived.downgradedVariants.has(String(v.id))) v.lifecycle = 'draft';
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
  // T13(D24): 연결했던 계정은 연결 정보 없이 들어오므로 "다시 연결 필요"
  for (const a of out.channel_accounts?.values() ?? []) if (a.credential_state === 'linked') a.credential_state = 'needs_reconnect';
  const at = bundleTime(derived.decisionAt);
  // 승인 철회(독립 계산, 판정 시각으로 확정)
  for (const a of out.approvals?.values() ?? []) {
    if (derived.revokedApprovals.has(String(a.id))) {
      a.revoked_at = at;
      a.revoke_reason = 'restore_stale';
    }
  }
  const activeByItem = new Map<string, boolean>();
  for (const a of out.approvals?.values() ?? []) if (a.revoked_at === null) activeByItem.set(String(a.distribution_item_id), true);
  // approved → review(활성 승인이 현재 버전을 가리키지 않음)
  for (const v of out.variants?.values() ?? []) {
    if (v.lifecycle !== 'approved') continue;
    const still = [...(out.distribution_items?.values() ?? [])].some(
      (i) => i.variant_id === v.id && i.variant_version_id === v.current_version_id && activeByItem.get(String(i.id)) === true,
    );
    if (!still) {
      v.lifecycle = 'review';
      v.updated_at = at;
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
      p.updated_at = at;
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

const isMarker = (v: unknown) => v === RESTORE_TIME || v instanceof SameOrRestoreTime;

/** 원본과 기대값이 다른(복원 규칙이 적용된) 행 수 — 화면 요약용. */
export function transformedRowCount(src: readonly Row[], expected: Map<string, ExpectedRow>): number {
  let n = 0;
  for (const r of src) {
    const e = expected.get(String(r.id));
    if (e && Object.keys(e).some((k) => isMarker(e[k]) || stableStringify(e[k] as unknown) !== stableStringify(r[k]))) n++;
  }
  return n;
}

/** 한 칸이 기대값과 맞는가. 시각 자리표시는 [from, to](복원 호출 구간) 안의 ISO 시각이어야 한다. */
export function valueMatches(expected: ExpectedValue, actual: unknown, window: { from: Date; to: Date }): boolean {
  const inWindow = (v: unknown) => {
    if (typeof v !== 'string') return false;
    const t = Date.parse(v);
    return Number.isFinite(t) && t >= window.from.getTime() && t <= window.to.getTime();
  };
  if (expected === RESTORE_TIME) return inWindow(actual);
  if (expected instanceof SameOrRestoreTime) return stableStringify(expected.original) === stableStringify(actual) || inWindow(actual);
  return stableStringify(expected) === stableStringify(actual);
}
