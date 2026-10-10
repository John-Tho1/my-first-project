/**
 * T07 쿼리(결정 D13): AI 비용 원장(usage_ledger)·허용 출처(source_versions)·claim/claim_sources 저장·조회.
 * 모든 함수는 ownerId 를 WHERE 에 넣는다(A01). 계산은 @cs/domain budget.ts / writing.ts 의 순수 함수.
 * schema·queries 외 다른 모듈을 import 하지 않는다(writing.ts 와의 순환 방지).
 */
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import {
  AmountRangeError,
  BudgetCurrencyMismatchError,
  BudgetExceededError,
  isStorableMicro,
  checkBudget,
  costMicro,
  failedSettlement,
  LiveRunLimitError,
  type TokenUsage,
  type UsageSource,
  fromMicro,
  mskMonthStart,
  mskNextMonthStart,
  sumToMicro,
  reserveFor,
  toMicro,
  type BudgetLimits,
  type BudgetPolicy,
  type FilteredClaim,
  type Reservation,
} from '@cs/domain';
import type { DbOrTx } from './queries';
import {
  captures,
  claimConfirmations,
  claims,
  claimSources,
  contentCaptures,
  sources,
  sourceVersions,
  usageLedger,
  users,
} from './schema';

export type UsageLedgerRow = typeof usageLedger.$inferSelect;
export type ClaimRow = typeof claims.$inferSelect;
export type ClaimSourceRow = typeof claimSources.$inferSelect;

// ---- 원장 ----

/** owner 행 잠금 — 예약 합계 계산과 예약 기록을 직렬화한다(동시 assist 가 상한을 함께 넘지 못하게). 반드시 트랜잭션 안에서. */
export async function lockOwnerForBudget(tx: DbOrTx, ownerId: string): Promise<void> {
  await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).for('update');
}

/** 월 합계 식(micro 가 아니라 numeric): reserved → 예약액, settled → 실제액(없으면 예약액), released → 0. */
const ledgerAmount = sql`case ${usageLedger.state}
        when 'reserved' then ${usageLedger.reservedAmount}
        when 'settled' then coalesce(${usageLedger.actualAmount}, ${usageLedger.reservedAmount})
        else 0 end`;

/**
 * 이번 달(MSK) 사용액(micro, bigint) — **이 통화의 원장만**(FIX-T07 P1: 통화를 섞지 않는다).
 */
export async function monthlyUsedMicro(tx: DbOrTx, ownerId: string, now: Date, currency: string): Promise<bigint> {
  const rows = await tx
    .select({ total: sql<string>`coalesce(sum(${ledgerAmount}), 0)::text` })
    .from(usageLedger)
    .where(and(eq(usageLedger.ownerId, ownerId), eq(usageLedger.currency, currency), gte(usageLedger.createdAt, mskMonthStart(now)), lt(usageLedger.createdAt, mskNextMonthStart(now))));
  return sumToMicro(rows[0]?.total ?? '0');
}

/** 이번 달 원장에 있는 통화 목록(정렬). */
export async function monthlyCurrencies(tx: DbOrTx, ownerId: string, now: Date): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ currency: usageLedger.currency })
    .from(usageLedger)
    .where(and(eq(usageLedger.ownerId, ownerId), gte(usageLedger.createdAt, mskMonthStart(now)), lt(usageLedger.createdAt, mskNextMonthStart(now))));
  return rows.map((r) => r.currency).sort();
}

/**
 * 호출 전 예약 검사(A15). owner 행을 잠그고(동시 예약·정산 직렬화)
 * - 이번 달 원장에 설정과 다른 통화가 있으면 409 budget_currency_mismatch(통화를 섞어 비교하지 않는다)
 * - 이번 달 사용액(같은 통화) + 예약액이 상한을 넘으면 429 budget_exceeded
 * 반드시 run·원장을 쓰는 트랜잭션 안에서 호출한다 — 거부되면 그 트랜잭션 전체가 되돌아가 아무것도 남지 않는다.
 * 예약액은 입력 추정 + 출력 상한 tokensOutAllowance(provider 에 maxOutputTokens 로 넘김)의 비용이다. FIX1-LIVEL1: live 의 입력 추정은
 * 보수적 추정일 뿐 증명된 상한이 아니다 — 확인된 실제액이 더 크면 정산이 초과액을 남기고, 그 금액이 다음 예약의 월 합계에 들어간다.
 * 이 검사는 진행 중 호출의 예약액만 보므로 동시에 진행 중인 호출들의 초과액은 합쳐질 수 있다(LLM_LIVE_MAX_RUNS=1 이면 한 건).
 * FIX1-LIVEL1(D34 2단계 범위): live + LLM_LIVE_MAX_RUNS 면 같은 owner 잠금 아래에서 같은 승인 기록의 live 원장 행 수를 세어
 * 한도에 닿았으면 429 live_run_limit(예산 검사보다 먼저 — 아무것도 쓰지 않음). 행은 같은 트랜잭션에서 곧바로 쓰이므로 동시 요청도 직렬화된다.
 */
export async function reserveOrThrow(tx: DbOrTx, ownerId: string, policy: BudgetPolicy, prompt: string, now: Date): Promise<Reservation> {
  const reservation = reserveFor(policy, prompt);
  if (policy.mode === 'live' && policy.liveMaxRuns !== undefined) {
    await lockOwnerForBudget(tx, ownerId);
    const used = await liveRunsUsed(tx, ownerId, policy.liveApprovalRef ?? null);
    if (used >= policy.liveMaxRuns) throw new LiveRunLimitError({ limit: policy.liveMaxRuns, used });
  }
  await reserveMicroOrThrow(tx, ownerId, policy, reservation.reserveMicro, now);
  return reservation;
}

/**
 * FIX1-LIVEL1: 이 owner 의 live 원장 행 중 스냅숏 approval_ref 가 같은 것의 수(상태 무관 — 실패·예약 중 포함, 기간 무관).
 * 승인 기록이 없으면(이론상 live 준비 전) approval_ref 가 없는 live 행을 센다.
 */
export async function liveRunsUsed(tx: DbOrTx, ownerId: string, approvalRef: string | null): Promise<number> {
  const refCond =
    approvalRef === null
      ? sql`${usageLedger.pricingSnapshot} ->> 'approval_ref' is null`
      : sql`${usageLedger.pricingSnapshot} ->> 'approval_ref' = ${approvalRef}`;
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(usageLedger)
    .where(and(eq(usageLedger.ownerId, ownerId), sql`${usageLedger.pricingSnapshot} ->> 'mode' = 'live'`, refCond));
  return Number(rows[0]?.n ?? 0);
}

/**
 * T08: 예약액(micro)만으로 같은 검사(LLM·STT 공용). owner 잠금 → 통화 불일치 409 → 한도 429.
 * 반드시 job·원장을 쓰는 트랜잭션 안에서 호출한다.
 */
export async function reserveMicroOrThrow(
  tx: DbOrTx,
  ownerId: string,
  policy: BudgetLimits & { currency: string },
  reserveMicro: bigint,
  now: Date,
): Promise<void> {
  const reservation = { reserveMicro };
  if (!isStorableMicro(reservation.reserveMicro)) throw new AmountRangeError();
  await lockOwnerForBudget(tx, ownerId);
  const others = (await monthlyCurrencies(tx, ownerId, now)).filter((c) => c !== policy.currency);
  if (others.length > 0) throw new BudgetCurrencyMismatchError({ configured: policy.currency, found: others });
  const used = await monthlyUsedMicro(tx, ownerId, now, policy.currency);
  const decision = checkBudget(policy, used, reservation.reserveMicro);
  if (!decision.ok) {
    throw new BudgetExceededError({
      reason: decision.reason,
      currency: policy.currency,
      used: fromMicro(used),
      reserve: fromMicro(reservation.reserveMicro),
      limit:
        decision.reason === 'per_run_max'
          ? fromMicro(policy.perRunMaxMicro ?? 0n)
          : policy.monthlyLimitMicro !== null
            ? fromMicro(policy.monthlyLimitMicro)
            : null,
    });
  }
}

/** T08: 전사 job 의 예약 원장(run_id 없음). */
export async function insertReservedSttLedger(
  tx: DbOrTx,
  ownerId: string,
  jobId: string,
  currency: string,
  reservation: { reserveMicro: bigint; audioSeconds: number; pricingSnapshot: Record<string, unknown> },
  now: Date,
): Promise<UsageLedgerRow> {
  const rows = await tx
    .insert(usageLedger)
    .values({
      ownerId,
      runId: null,
      transcriptionJobId: jobId,
      audioSeconds: reservation.audioSeconds,
      reservedAmount: fromMicro(reservation.reserveMicro),
      currency,
      pricingSnapshot: reservation.pricingSnapshot,
      state: 'reserved',
      createdAt: now,
    })
    .returning();
  return rows[0]!;
}

export async function getSttLedger(tx: DbOrTx, ownerId: string, jobId: string): Promise<UsageLedgerRow | null> {
  const rows = await tx
    .select()
    .from(usageLedger)
    .where(and(eq(usageLedger.ownerId, ownerId), eq(usageLedger.transcriptionJobId, jobId)))
    .limit(1);
  return rows[0] ?? null;
}

/** T08: 시작 전 취소 — 예약을 풀어 0 으로(released). */
export async function releaseLedger(tx: DbOrTx, ownerId: string, ledger: UsageLedgerRow, at: Date): Promise<void> {
  await lockOwnerForBudget(tx, ownerId);
  await tx
    .update(usageLedger)
    .set({ state: 'released', actualAmount: '0.000000', settledAt: at })
    .where(and(eq(usageLedger.id, ledger.id), eq(usageLedger.ownerId, ownerId), eq(usageLedger.state, 'reserved')));
}

/** T08: 전사 성공 — 실제 처리 길이 × 1분 가격으로 확정(초과는 기록, 숨기지 않음). */
export async function settleSttLedgerSucceeded(
  tx: DbOrTx,
  ownerId: string,
  ledger: UsageLedgerRow,
  actualMicro: bigint,
  audioSeconds: number,
  at: Date,
): Promise<void> {
  await lockOwnerForBudget(tx, ownerId);
  if (!isStorableMicro(actualMicro)) throw new AmountRangeError();
  const reserved = toMicro(ledger.reservedAmount);
  const overage = actualMicro > reserved ? actualMicro - reserved : 0n;
  await tx
    .update(usageLedger)
    .set({
      state: 'settled',
      actualAmount: fromMicro(actualMicro),
      overageAmount: fromMicro(overage),
      overBudget: overage > 0n,
      audioSeconds,
      settledAt: at,
    })
    .where(and(eq(usageLedger.id, ledger.id), eq(usageLedger.ownerId, ownerId), eq(usageLedger.state, 'reserved')));
}

export async function insertReservedLedger(
  tx: DbOrTx,
  ownerId: string,
  runId: string,
  policy: BudgetPolicy,
  reservation: Reservation,
  now: Date,
): Promise<UsageLedgerRow> {
  const rows = await tx
    .insert(usageLedger)
    .values({
      ownerId,
      runId,
      reservedAmount: fromMicro(reservation.reserveMicro),
      currency: policy.currency,
      tokensIn: null,
      tokensOut: null,
      pricingSnapshot: reservation.pricingSnapshot,
      state: 'reserved',
      createdAt: now,
    })
    .returning();
  return rows[0]!;
}

/**
 * FIX2-LIVEL1: 확정에 쓸 사용량을 고른다. provider 가 보고한 usage 라도 그 비용이 numeric(18,6) 에 담기지 않으면(또는 usage 가 없으면)
 * 확인된 usage 로 쓰지 않는다 → null(예약액, tokens NULL, usage_source none). 모의 추정(estimate)은 기존대로 범위 밖이면 AmountRangeError.
 */
function storableUsage(pricing: BudgetPolicy['pricing'], usage: TokenUsage | null, source: UsageSource): { usage: TokenUsage | null; cost: bigint | null } {
  if (!usage) return { usage: null, cost: null };
  const cost = costMicro(pricing, usage.tokensIn, usage.tokensOut);
  if (isStorableMicro(cost)) return { usage, cost };
  if (source === 'estimate') throw new AmountRangeError();
  return { usage: null, cost: null };
}

/**
 * 실패한 호출: 예약액 전체를 실제액으로 확정(failed=true, docs/02, D13). owner 잠금 아래에서.
 * FIX1-LIVEL1: 공급자가 보고한 유효 usage 를 알면 max(예약액, usage 비용) + 초과액·tokens(숫자만).
 * FIX2-LIVEL1: `known` 이 있으면(LLM 경로) 스냅숏에 usage_source(provider|none)를 남기고, usage 를 모르면 tokens 는 NULL 그대로.
 */
export async function settleLedgerFailed(
  tx: DbOrTx,
  ownerId: string,
  ledger: UsageLedgerRow,
  at: Date,
  known?: { pricing: BudgetPolicy['pricing']; usage: TokenUsage | null },
): Promise<void> {
  await lockOwnerForBudget(tx, ownerId);
  const { usage } = storableUsage(known?.pricing ?? null, known?.usage ?? null, 'provider');
  const { actualMicro, overageMicro } = failedSettlement(known?.pricing ?? null, toMicro(ledger.reservedAmount), usage);
  await tx
    .update(usageLedger)
    .set({
      state: 'settled',
      actualAmount: usage ? fromMicro(actualMicro) : ledger.reservedAmount,
      failed: true,
      settledAt: at,
      ...(usage
        ? { tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, overageAmount: fromMicro(overageMicro), overBudget: overageMicro > 0n }
        : {}),
      ...(known ? { pricingSnapshot: { ...ledger.pricingSnapshot, usage_source: usage ? 'provider' : 'none' } } : {}),
    })
    .where(and(eq(usageLedger.id, ledger.id), eq(usageLedger.ownerId, ownerId), eq(usageLedger.state, 'reserved')));
}

/**
 * 성공한 호출의 확정 — 예약과 같은 owner 잠금 아래에서.
 * - usage 가 있으면 실제 토큰 × 단가. 실제액 > 예약액이면(예약 추정이 모자람) 초과액을 overage_amount 에 그대로 기록하고 over_budget=true
 *   (숨기거나 자르지 않는다). 그 금액이 월 합계에 들어가 다음 예약의 월 상한 검사에 반영된다.
 * - FIX2-LIVEL1: usage 가 null(live 에서 공급자가 유효 usage 를 보고하지 않음, 또는 그 비용이 저장 범위 밖)이면 예약액으로 확정하고
 *   tokens 는 NULL — 추정을 실제 사용량처럼 기록하지 않는다. 스냅숏 usage_source 로 출처(provider|estimate|none)를 남긴다.
 */
export async function settleLedgerSucceeded(
  tx: DbOrTx,
  ownerId: string,
  ledger: UsageLedgerRow,
  pricing: BudgetPolicy['pricing'],
  usageIn: TokenUsage | null,
  at: Date,
  source: UsageSource = 'estimate',
): Promise<UsageLedgerRow> {
  await lockOwnerForBudget(tx, ownerId);
  const { usage, cost } = storableUsage(pricing, usageIn, source);
  const reserved = toMicro(ledger.reservedAmount);
  const actual = cost ?? reserved;
  const overage = actual > reserved ? actual - reserved : 0n;
  const rows = await tx
    .update(usageLedger)
    .set({
      state: 'settled',
      actualAmount: fromMicro(actual),
      overageAmount: fromMicro(overage),
      overBudget: overage > 0n,
      tokensIn: usage ? usage.tokensIn : null,
      tokensOut: usage ? usage.tokensOut : null,
      pricingSnapshot: { ...ledger.pricingSnapshot, usage_source: usage ? source : 'none' },
      settledAt: at,
    })
    .where(and(eq(usageLedger.id, ledger.id), eq(usageLedger.ownerId, ownerId), eq(usageLedger.state, 'reserved')))
    .returning();
  if (!rows[0]) throw new Error('비용 원장 확정에 실패했습니다');
  return rows[0];
}

export interface CurrencyUsage {
  currency: string;
  used: string;
  usedMicro: bigint;
  overage: string;
  runs: number;
  pending: number;
  overBudgetRuns: number;
}

/** 이번 달(MSK) 사용량 — 통화별(섞어 합산하지 않는다). */
export async function monthlyUsage(db: DbOrTx, ownerId: string, now: Date = new Date()): Promise<{ since: Date; byCurrency: CurrencyUsage[] }> {
  const since = mskMonthStart(now);
  const rows = await db
    .select({
      currency: usageLedger.currency,
      total: sql<string>`coalesce(sum(${ledgerAmount}), 0)::text`,
      overage: sql<string>`coalesce(sum(${usageLedger.overageAmount}), 0)::text`,
      n: sql<number>`count(*)::int`,
      reserved: sql<number>`count(*) filter (where ${usageLedger.state} = 'reserved')::int`,
      over: sql<number>`count(*) filter (where ${usageLedger.overBudget})::int`,
    })
    .from(usageLedger)
    .where(and(eq(usageLedger.ownerId, ownerId), gte(usageLedger.createdAt, since), lt(usageLedger.createdAt, mskNextMonthStart(now))))
    .groupBy(usageLedger.currency)
    .orderBy(asc(usageLedger.currency));
  return {
    since,
    byCurrency: rows.map((r) => ({
      currency: r.currency,
      used: fromMicro(sumToMicro(r.total)),
      usedMicro: sumToMicro(r.total),
      overage: fromMicro(sumToMicro(r.overage)),
      runs: r.n,
      pending: r.reserved,
      overBudgetRuns: r.over,
    })),
  };
}

export async function getLedgerForRun(db: DbOrTx, ownerId: string, runId: string): Promise<UsageLedgerRow | null> {
  const rows = await db
    .select()
    .from(usageLedger)
    .where(and(eq(usageLedger.ownerId, ownerId), eq(usageLedger.runId, runId)))
    .limit(1);
  return rows[0] ?? null;
}

function withoutApprovalRef(snapshot: UsageLedgerRow['pricingSnapshot']): UsageLedgerRow['pricingSnapshot'] {
  if (!snapshot || typeof snapshot !== 'object' || !('approval_ref' in snapshot)) return snapshot;
  const { approval_ref: _ref, ...rest } = snapshot as Record<string, unknown>;
  void _ref;
  return rest as UsageLedgerRow['pricingSnapshot'];
}

export function usageLedgerView(l: UsageLedgerRow) {
  return {
    id: l.id,
    run_id: l.runId,
    state: l.state,
    currency: l.currency,
    reserved_amount: l.reservedAmount,
    actual_amount: l.actualAmount,
    tokens_in: l.tokensIn,
    tokens_out: l.tokensOut,
    failed: l.failed,
    overage_amount: l.overageAmount,
    over_budget: l.overBudget,
    // FIX1-LIVEL1: 승인 기록 참조(approval_ref)는 횟수 계산용 — 화면·API 응답에는 내보내지 않는다(health·설정과 같은 원칙)
    pricing_snapshot: withoutApprovalRef(l.pricingSnapshot),
    created_at: l.createdAt.toISOString(),
    settled_at: l.settledAt ? l.settledAt.toISOString() : null,
  };
}

// ---- 허용 출처 ----

export interface AllowedSource {
  id: string;
  sourceId: string;
  locator: string | null;
  excerpt: string | null;
  extractionState: string;
  fetchedAt: Date;
}

/**
 * 이 원고에 연결된 소재(content_captures, owner 일치)의 출처(sources, owner 일치)에 속한 source_versions.
 * 이 목록 밖의 source_version 은 assist 근거로 쓸 수 없다.
 */
export async function allowedSourceVersions(tx: DbOrTx, ownerId: string, contentId: string): Promise<AllowedSource[]> {
  const rows = await tx
    .selectDistinct({
      id: sourceVersions.id,
      sourceId: sourceVersions.sourceId,
      locator: sources.canonicalUrl,
      excerpt: sourceVersions.excerpt,
      extractionState: sourceVersions.extractionState,
      fetchedAt: sourceVersions.fetchedAt,
    })
    .from(contentCaptures)
    .innerJoin(captures, and(eq(captures.id, contentCaptures.captureId), eq(captures.ownerId, contentCaptures.ownerId)))
    .innerJoin(sources, and(eq(sources.id, captures.sourceId), eq(sources.ownerId, captures.ownerId)))
    .innerJoin(sourceVersions, eq(sourceVersions.sourceId, sources.id))
    .where(and(eq(contentCaptures.contentId, contentId), eq(contentCaptures.ownerId, ownerId)))
    .orderBy(asc(sourceVersions.id));
  return rows;
}

// ---- claims ----

/** 제안 버전의 claim 을 저장한다(불변). 허용 목록 밖 출처는 이미 filterClaimSources 가 버렸다. */
export async function insertClaims(
  tx: DbOrTx,
  ownerId: string,
  runId: string,
  contentVersionId: string,
  filtered: ReadonlyArray<Pick<FilteredClaim, 'text' | 'kind' | 'evidence_grade' | 'needs_check' | 'source_refs'>>,
  locators: ReadonlyMap<string, string | null>,
  now: Date,
  /** T09: 채널 초안 run 이면 그 제안 variant_version(contentVersionId 는 파생 기준 원고 버전) */
  variantVersionId: string | null = null,
): Promise<void> {
  for (const [index, c] of filtered.entries()) {
    const inserted = await tx
      .insert(claims)
      .values({
        ownerId,
        contentVersionId,
        runId,
        variantVersionId,
        claimIndex: index,
        statement: c.text,
        kind: c.kind,
        evidenceGrade: c.evidence_grade,
        personalExperienceConfirmed: false,
        needsCheck: c.needs_check,
        createdAt: now,
      })
      .returning({ id: claims.id });
    const claimId = inserted[0]!.id;
    for (const sv of c.source_refs) {
      await tx.insert(claimSources).values({ ownerId, claimId, sourceVersionId: sv, locator: locators.get(sv) ?? null, supportNote: null });
    }
  }
}

export interface ClaimView {
  id: string;
  claim_index: number;
  statement: string;
  kind: string;
  /** 저장값 + 파생: 확인(resolution='confirmed')이 있으면 'user_confirmed' */
  evidence_grade: string;
  personal_experience_confirmed: boolean;
  needs_check: boolean;
  sources: Array<{ source_version_id: string; locator: string | null }>;
}

/** run 의 claim(출처 포함). evidence_grade 'user_confirmed' 와 personal_experience_confirmed 는 claim_confirmations 에서 파생. */
export async function listClaimsForRun(db: DbOrTx, ownerId: string, runId: string): Promise<ClaimView[]> {
  const rows = await db
    .select()
    .from(claims)
    .where(and(eq(claims.ownerId, ownerId), eq(claims.runId, runId)))
    .orderBy(asc(claims.claimIndex));
  if (rows.length === 0) return [];
  const srcs = await db
    .select()
    .from(claimSources)
    .where(and(eq(claimSources.ownerId, ownerId), inArray(claimSources.claimId, rows.map((r) => r.id))));
  const confirmed = await db
    .select({ claimIndex: claimConfirmations.claimIndex })
    .from(claimConfirmations)
    .where(and(eq(claimConfirmations.ownerId, ownerId), eq(claimConfirmations.runId, runId), eq(claimConfirmations.resolution, 'confirmed')));
  const confirmedIdx = new Set(confirmed.map((c) => c.claimIndex));
  return rows.map((r) => {
    const userConfirmed = confirmedIdx.has(r.claimIndex);
    return {
      id: r.id,
      claim_index: r.claimIndex,
      statement: r.statement,
      kind: r.kind,
      evidence_grade: userConfirmed ? 'user_confirmed' : r.evidenceGrade,
      personal_experience_confirmed: userConfirmed && r.kind === 'experience',
      needs_check: r.needsCheck && !userConfirmed,
      sources: srcs
        .filter((s) => s.claimId === r.id)
        .map((s) => ({ source_version_id: s.sourceVersionId, locator: s.locator }))
        .sort((a, b) => (a.source_version_id < b.source_version_id ? -1 : 1)),
    };
  });
}
