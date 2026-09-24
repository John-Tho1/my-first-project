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
  fromMicro,
  mskMonthStart,
  mskNextMonthStart,
  sumToMicro,
  reserveFor,
  toMicro,
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
 * 예약액은 "최대 가능 비용"(입력 추정 + 출력 상한 tokensOutAllowance)이며, provider 에 maxOutputTokens 로 그 상한을 넘긴다.
 */
export async function reserveOrThrow(tx: DbOrTx, ownerId: string, policy: BudgetPolicy, prompt: string, now: Date): Promise<Reservation> {
  const reservation = reserveFor(policy, prompt);
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
  return reservation;
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

/** 실패한 호출: 예약액 전체를 실제액으로 확정(failed=true, docs/02). owner 잠금 아래에서. */
export async function settleLedgerFailed(tx: DbOrTx, ownerId: string, ledger: UsageLedgerRow, at: Date): Promise<void> {
  await lockOwnerForBudget(tx, ownerId);
  await tx
    .update(usageLedger)
    .set({ state: 'settled', actualAmount: ledger.reservedAmount, failed: true, settledAt: at })
    .where(and(eq(usageLedger.id, ledger.id), eq(usageLedger.ownerId, ownerId), eq(usageLedger.state, 'reserved')));
}

/**
 * 성공한 호출: 실제 토큰 × 단가로 확정 — 예약과 같은 owner 잠금 아래에서.
 * 실제액 > 예약액이면(provider 가 상한을 어겼거나 추정이 모자람) 초과액을 overage_amount 에 그대로 기록하고 over_budget=true.
 * 숨기거나 자르지 않는다. 그 결과 월 합계가 상한을 넘으면 다음 예약이 거부된다.
 */
export async function settleLedgerSucceeded(
  tx: DbOrTx,
  ownerId: string,
  ledger: UsageLedgerRow,
  pricing: BudgetPolicy['pricing'],
  usage: { tokensIn: number; tokensOut: number },
  at: Date,
): Promise<UsageLedgerRow> {
  await lockOwnerForBudget(tx, ownerId);
  const actual = costMicro(pricing, usage.tokensIn, usage.tokensOut);
  if (!isStorableMicro(actual)) throw new AmountRangeError();
  const reserved = toMicro(ledger.reservedAmount);
  const overage = actual > reserved ? actual - reserved : 0n;
  const rows = await tx
    .update(usageLedger)
    .set({
      state: 'settled',
      actualAmount: fromMicro(actual),
      overageAmount: fromMicro(overage),
      overBudget: overage > 0n,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
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
    pricing_snapshot: l.pricingSnapshot,
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
