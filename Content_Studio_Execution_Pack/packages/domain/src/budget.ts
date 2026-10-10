/**
 * T07 AI 비용 예약(A15, 결정 D13) — 순수 함수. DB·네트워크 없음.
 *
 * - 금액은 micro 단위(1e-6 통화) **bigint** 로 계산한다(FIX-T07 P2 — numeric(18,6) 전체 범위를 정확히). DB 에는 numeric(18,6) 문자열.
 *   numeric(18,6) 을 넘는 값(정수부 13자리 이상·소수 7자리 이상)은 AmountRangeError.
 * - 토큰 추정(mock): 프롬프트 글자 수 / 3(올림). 한국어·영어가 섞인 글에서 보수적으로(많게) 잡는 경험칙이다 — 실제 토크나이저가 아니다.
 * - 출력 여유분(mock): max(256, 입력 추정의 절반) 토큰.
 * - LIVE-L1(D34) live: 입력 = 정확한 프롬프트 UTF-8 바이트 + 시스템 프롬프트·출력 스키마 바이트 + 틀 여유(llm-live.ts),
 *   출력 = LLM_LIVE_MAX_OUTPUT_TOKENS(요청의 max_tokens 와 같은 값). FIX1-LIVEL1: 이것은 **보수적 추정**이지 증명된 비용 상한이 아니다.
 *   FIX2-LIVEL1 초과 동작(정확히):
 *   (1) 실제 사용량은 **공급자가 유효 usage 를 보고한 경우에만** 기록한다(성공·실패 모두, 실패는 max(예약액, usage 비용)). 보고가 없거나 이상하면
 *       예약액으로 확정하고 tokens 는 NULL, 스냅숏 usage_source='none'.
 *   (2) 실제액 > 예약액이면 초과액(overage_amount)을 기록한다 — 그 금액은 월 합계에 들어간다.
 *   (3) 다음 요청은 "월 합계(기록된 초과액 포함) + 그 요청의 예약액 > 월 상한" 이거나 "그 요청의 예약 추정 > 1회 상한" 일 때만 거부된다.
 *       1회 상한은 예약 추정에만 적용된다 — 실제액이 1회 상한을 넘어도 월 잔여가 있으면 다음 요청은 허용된다.
 *   (4) 예약 검사는 진행 중 호출의 **예약액**만 본다 — 동시에 진행 중인 호출들이 각각 예약을 넘으면 초과액이 모두 합쳐져 월 상한을 넘는다.
 *       월 상한 초과가 한 호출분으로 묶이는 것은 같은 승인 기록에 LLM_LIVE_MAX_RUNS=1 일 때뿐이다.
 * - 예약액 = 입력 추정 × 입력 단가 + 출력 여유분 × 출력 단가(각각 1K 토큰당, 올림).
 * - 가격이 없으면: live 는 차단(liveLlmReadiness), mock 은 0 으로 예약·기록만 한다(한도 검사 없음).
 * - 월 사용액 = 이 owner 의 이번 달(MSK) 원장 합계: reserved 는 예약액, settled 는 실제액, released 는 0.
 */
import type { AppConfig } from './config';
import { AppError } from './errors';
import {
  ANTHROPIC_PROVIDER,
  anthropicApiKeyState,
  LIVE_LLM_DEFAULT_MAX_OUTPUT_TOKENS,
  LIVE_LLM_FIXED_INPUT_BYTES,
  LIVE_LLM_FRAMING_OVERHEAD_TOKENS,
  liveInputEstimateTokens,
} from './llm-live';

export const TOKEN_CHARS = 3;
export const MIN_OUTPUT_ALLOWANCE_TOKENS = 256;
const MICRO = 1_000_000n;
/** numeric(18,6) 의 최대값(micro): 999999999999.999999 */
export const MAX_AMOUNT_MICRO = 999_999_999_999_999_999n;
const AMOUNT_RE = /^(\d{1,12})(?:\.(\d{1,6}))?$/;

export class AmountRangeError extends AppError {
  constructor() {
    super('bad_request', 'amount_out_of_range', '금액이 numeric(18,6) 범위를 벗어났거나 형식이 올바르지 않습니다');
  }
}

/** "12.345678" → 12345678n(micro). numeric(18,6) 범위·형식이 아니면 AmountRangeError. */
export function toMicro(decimal: string): bigint {
  const m = AMOUNT_RE.exec(decimal);
  if (!m) throw new AmountRangeError();
  return BigInt(m[1]!) * MICRO + BigInt((m[2] ?? '').padEnd(6, '0'));
}

/** 12345678n → "12.345678"(음수는 '-' 부호). */
export function fromMicro(micro: bigint): string {
  const sign = micro < 0n ? '-' : '';
  const abs = micro < 0n ? -micro : micro;
  return `${sign}${abs / MICRO}.${String(abs % MICRO).padStart(6, '0')}`;
}

/** 저장 가능한 금액인가(0 ≤ x ≤ numeric(18,6) 최대). */
export const isStorableMicro = (micro: bigint) => micro >= 0n && micro <= MAX_AMOUNT_MICRO;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_CHARS);
}

export function outputAllowanceTokens(inputTokens: number): number {
  return Math.max(MIN_OUTPUT_ALLOWANCE_TOKENS, Math.ceil(inputTokens / 2));
}

export interface Pricing {
  currency: string;
  inputPer1kMicro: bigint;
  outputPer1kMicro: bigint;
}

export interface BudgetPolicy {
  mode: 'mock' | 'live';
  currency: string;
  /** 가격이 없으면 null(mock: 0 원 기록, live: 차단) */
  pricing: Pricing | null;
  monthlyLimitMicro: bigint | null;
  perRunMaxMicro: bigint | null;
  /** LIVE-L1(D34): live 1회 출력 토큰 상한(= 요청 max_tokens). 없으면 LIVE_LLM_DEFAULT_MAX_OUTPUT_TOKENS. mock 은 쓰지 않는다. */
  liveMaxOutputTokens?: number;
  /** FIX1-LIVEL1: 승인 기록(LLM_LIVE_APPROVAL_REF)당 실제 호출 횟수 제한. 없으면 제한 없음. */
  liveMaxRuns?: number;
  /** FIX1-LIVEL1: live 원장 스냅숏에 남겨 횟수를 세는 승인 기록 참조(비밀 아님 — 화면·health·사용량 view 에는 내보내지 않는다). */
  liveApprovalRef?: string;
}

export function budgetPolicy(config: AppConfig): BudgetPolicy {
  const pricing =
    config.LLM_PRICE_INPUT_PER_1K !== undefined && config.LLM_PRICE_OUTPUT_PER_1K !== undefined
      ? {
          currency: config.LLM_BUDGET_CURRENCY,
          inputPer1kMicro: toMicro(config.LLM_PRICE_INPUT_PER_1K),
          outputPer1kMicro: toMicro(config.LLM_PRICE_OUTPUT_PER_1K),
        }
      : null;
  return {
    mode: config.LLM_MODE,
    currency: config.LLM_BUDGET_CURRENCY,
    pricing,
    monthlyLimitMicro: config.LLM_BUDGET_MONTHLY_LIMIT !== undefined ? toMicro(config.LLM_BUDGET_MONTHLY_LIMIT) : null,
    perRunMaxMicro: config.LLM_BUDGET_PER_RUN_MAX !== undefined ? toMicro(config.LLM_BUDGET_PER_RUN_MAX) : null,
    liveMaxOutputTokens: config.LLM_LIVE_MAX_OUTPUT_TOKENS,
    liveMaxRuns: config.LLM_LIVE_MAX_RUNS,
    liveApprovalRef: config.LLM_LIVE_APPROVAL_REF,
  };
}

/** ⌈a / b⌉ (a, b ≥ 0, bigint) */
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** 토큰 × 1K 단가(micro) — bigint 로 곱하고 1000 으로 올림 나눗셈(중간값 정밀도 손실 없음). */
export function costMicro(pricing: Pricing | null, tokensIn: number, tokensOut: number): bigint {
  if (!pricing) return 0n;
  return ceilDiv(BigInt(tokensIn) * pricing.inputPer1kMicro, 1000n) + ceilDiv(BigInt(tokensOut) * pricing.outputPer1kMicro, 1000n);
}

export interface Reservation {
  tokensIn: number;
  /** 출력 상한(토큰). provider 에 maxOutputTokens 로 넘겨 이보다 많이 쓰지 못하게 한다(FIX-T07 P1). */
  tokensOutAllowance: number;
  reserveMicro: bigint;
  /** 원장에 남기는 가격 스냅숏(값만 — 키·비밀 없음) */
  pricingSnapshot: Record<string, unknown>;
}

/** LIVE-L1: 원장 스냅숏의 live 추정식 표기(값만). */
export const LIVE_TOKEN_ESTIMATE_LABEL = 'utf8_bytes+fixed+overhead';

export function reserveFor(policy: BudgetPolicy, prompt: string): Reservation {
  const live = policy.mode === 'live';
  // LIVE-L1(D34): live 는 보수적 추정(바이트 + 고정 + 틀 여유)과 설정한 출력 상한. mock 은 기존 글자/3 그대로(D13).
  const tokensIn = live ? liveInputEstimateTokens(prompt) : estimateTokens(prompt);
  const tokensOutAllowance = live ? (policy.liveMaxOutputTokens ?? LIVE_LLM_DEFAULT_MAX_OUTPUT_TOKENS) : outputAllowanceTokens(tokensIn);
  const reserveMicro = costMicro(policy.pricing, tokensIn, tokensOutAllowance);
  const tokenEstimate = live ? LIVE_TOKEN_ESTIMATE_LABEL : `chars/${TOKEN_CHARS}`;
  const liveExtra = live
    ? {
        fixed_input_bytes: LIVE_LLM_FIXED_INPUT_BYTES,
        overhead_tokens: LIVE_LLM_FRAMING_OVERHEAD_TOKENS,
        // FIX1-LIVEL1: LLM_LIVE_MAX_RUNS 계산용(승인 기록당 실제 호출 수)
        ...(policy.liveApprovalRef ? { approval_ref: policy.liveApprovalRef } : {}),
      }
    : {};
  const pricingSnapshot = policy.pricing
    ? {
        mode: policy.mode,
        currency: policy.pricing.currency,
        input_per_1k: fromMicro(policy.pricing.inputPer1kMicro),
        output_per_1k: fromMicro(policy.pricing.outputPer1kMicro),
        token_estimate: tokenEstimate,
        output_allowance_tokens: tokensOutAllowance,
        ...liveExtra,
      }
    : { mode: policy.mode, priced: false, token_estimate: tokenEstimate, output_allowance_tokens: tokensOutAllowance, ...liveExtra };
  return { tokensIn, tokensOutAllowance, reserveMicro, pricingSnapshot };
}

/** 한도 검사에 필요한 값(LLM·STT 공용, T08). pricing 이 null 이면 모의 전용 — 한도를 검사하지 않는다. */
export interface BudgetLimits {
  pricing: object | null;
  monthlyLimitMicro: bigint | null;
  perRunMaxMicro: bigint | null;
}

export type BudgetDecision = { ok: true } | { ok: false; reason: 'per_run_max' | 'monthly_limit' };

/**
 * 예약 가능 여부. 가격이 없으면(mock 전용 — live 는 그 전에 차단) 한도를 검사하지 않는다.
 * usedMicro = 이번 달 원장 합계(예약 중 + 확정). 경계값(합계 = 상한)은 허용한다.
 */
export function checkBudget(policy: BudgetLimits, usedMicro: bigint, reserveMicro: bigint): BudgetDecision {
  if (!policy.pricing) return { ok: true };
  if (policy.perRunMaxMicro !== null && reserveMicro > policy.perRunMaxMicro) return { ok: false, reason: 'per_run_max' };
  if (policy.monthlyLimitMicro !== null && usedMicro + reserveMicro > policy.monthlyLimitMicro) return { ok: false, reason: 'monthly_limit' };
  return { ok: true };
}

/** 다음 달(MSK) 시작 시각(UTC) — 월 조회의 상한(미만). FIX-T07 round 2. */
export function mskNextMonthStart(now: Date): Date {
  const msk = new Date(now.getTime() + 3 * 3600_000);
  return new Date(Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth() + 1, 1) - 3 * 3600_000);
}

/**
 * 합계 문자열 → micro(bigint). 행 하나의 numeric(18,6) 범위(toMicro)를 적용하지 않는다 — 합계는 그보다 클 수 있다(FIX-T07 round 2).
 * 형식: 음이 아닌 10진수, 소수 6자리 이하.
 */
export function sumToMicro(decimal: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(decimal);
  if (!m) throw new AmountRangeError();
  return BigInt(m[1]!) * MICRO + BigInt((m[2] ?? '').padEnd(6, '0'));
}

/** 이번 달(MSK = UTC+3, 서머타임 없음) 시작 시각(UTC). */
export function mskMonthStart(now: Date): Date {
  const msk = new Date(now.getTime() + 3 * 3600_000);
  return new Date(Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), 1) - 3 * 3600_000);
}

/** 이번 달 원장에 설정과 다른 통화가 있으면 예약을 거부한다(통화를 섞어 합산·비교하지 않는다, FIX-T07 P1). */
export class BudgetCurrencyMismatchError extends AppError {
  constructor(extra: { configured: string; found: string[] }) {
    super(
      'conflict',
      'budget_currency_mismatch',
      `이번 달 비용 원장에 설정 통화(${extra.configured})와 다른 통화(${extra.found.join(', ')})가 있어 AI 를 호출하지 않았습니다. 통화 설정을 확인하세요.`,
      extra,
    );
  }
}

export class BudgetExceededError extends AppError {
  constructor(extra: { reason: 'per_run_max' | 'monthly_limit'; currency: string; used: string; reserve: string; limit: string | null }) {
    super(
      'budget_exceeded',
      'budget_exceeded',
      extra.reason === 'per_run_max'
        ? '이번 요청의 예상 비용이 1회 상한(LLM_BUDGET_PER_RUN_MAX)을 넘어 AI 를 호출하지 않았습니다.'
        : '이번 달 AI 예산 상한(LLM_BUDGET_MONTHLY_LIMIT)을 넘게 되어 AI 를 호출하지 않았습니다.',
      extra,
    );
  }
}

/** FIX1-LIVEL1(D34 2단계 범위): 같은 승인 기록으로 허용한 실제 호출 횟수(LLM_LIVE_MAX_RUNS)를 다 썼다 → 429, 아무것도 쓰지 않고 호출하지 않음. */
export class LiveRunLimitError extends AppError {
  constructor(extra: { limit: number; used: number }) {
    super(
      'budget_exceeded',
      'live_run_limit',
      '승인된 실제 AI 호출 횟수(LLM_LIVE_MAX_RUNS)를 모두 써서 AI 를 호출하지 않았습니다. 새 승인 뒤에만 다시 호출할 수 있습니다.',
      extra,
    );
  }
}

// ---- 실패 호출 정산(FIX1-LIVEL1) ----

export interface TokenUsage {
  tokensIn: number;
  tokensOut: number;
}

/**
 * FIX2-LIVEL1: 원장 토큰 열(usage_ledger.tokens_in/out, PostgreSQL integer)의 최대값. 이보다 큰 usage 는 저장할 수 없으므로
 * "확인된 usage 아님"으로 보고 보수적 경로(예약액, tokens NULL, usage_source none)로 간다.
 */
export const MAX_TOKEN_COLUMN = 2_147_483_647;

/** FIX2-LIVEL1: 원장 확정의 사용량 출처 — provider(공급자가 보고한 유효 usage) · estimate(모의의 결정적 추정) · none(모름 → 예약액, tokens NULL). */
export type UsageSource = 'provider' | 'estimate' | 'none';

const isUsageInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_TOKEN_COLUMN;

/**
 * provider 실패 오류에 실린 숫자 사용량(예: LiveLlmError.usage — 원문 없음). 두 값이 모두 0 ~ MAX_TOKEN_COLUMN 정수일 때만, 아니면 null.
 * db 층은 provider 구현을 모르므로 구조로만 읽는다.
 */
export function failureUsageOf(e: unknown): TokenUsage | null {
  if (!e || typeof e !== 'object') return null;
  const u = (e as { usage?: unknown }).usage;
  if (!u || typeof u !== 'object') return null;
  const { tokensIn, tokensOut } = u as { tokensIn?: unknown; tokensOut?: unknown };
  return isUsageInt(tokensIn) && isUsageInt(tokensOut) ? { tokensIn, tokensOut } : null;
}

/**
 * 실패 호출의 확정액: D13 은 예약액 전액, FIX1-LIVEL1 은 응답 usage 를 알면 max(예약액, usage 비용) — 확인된 비용이 예약보다 크면
 * 그 차이를 초과액으로 남긴다(숨기지 않음). usage 를 모르면 예약액 그대로.
 */
export function failedSettlement(pricing: Pricing | null, reservedMicro: bigint, usage: TokenUsage | null): { actualMicro: bigint; overageMicro: bigint } {
  if (!usage) return { actualMicro: reservedMicro, overageMicro: 0n };
  const cost = costMicro(pricing, usage.tokensIn, usage.tokensOut);
  return cost > reservedMicro ? { actualMicro: cost, overageMicro: cost - reservedMicro } : { actualMicro: reservedMicro, overageMicro: 0n };
}

// ---- live 준비 상태(LIVE-L1, D34) ----

export interface LiveReadiness {
  /** 실제 Claude 호출을 열 수 있는가 — true 일 때만 getLlm 이 ClaudeLlmProvider 를 돌려준다. */
  ready: boolean;
  /** 빠진 조건 이름(값 없음). */
  missing: string[];
}

/**
 * 실제 AI 호출의 전제 조건(이름만 — 값·길이 없음). LIVE-L1(D34): 모두 갖춰지면 ready=true.
 * 조건: LLM_MODE=live · LLM_PROVIDER=anthropic(없으면 'LLM_PROVIDER', 다른 값이면 'LLM_PROVIDER=anthropic') · LLM_MODEL · 입력·출력 단가 ·
 * 월 상한 · 승인 기록 LLM_LIVE_APPROVAL_REF · 서버 환경의 ANTHROPIC_API_KEY(존재·형식 — env 에서만 읽고 값은 돌려주지 않는다).
 * 화면(health·설정·/ops)과 공급자 선택(web getLlm)이 **같은 함수**를 쓴다(표시와 실제 선택이 어긋나지 않게).
 */
export function liveLlmReadiness(config: AppConfig, env: Record<string, string | undefined>): LiveReadiness {
  const missing: string[] = [];
  if (config.LLM_MODE !== 'live') missing.push('LLM_MODE=live');
  if (!config.LLM_PROVIDER) missing.push('LLM_PROVIDER');
  else if (config.LLM_PROVIDER !== ANTHROPIC_PROVIDER) missing.push(`LLM_PROVIDER=${ANTHROPIC_PROVIDER}`);
  if (!config.LLM_MODEL) missing.push('LLM_MODEL');
  if (!config.LLM_PRICE_INPUT_PER_1K) missing.push('LLM_PRICE_INPUT_PER_1K');
  if (!config.LLM_PRICE_OUTPUT_PER_1K) missing.push('LLM_PRICE_OUTPUT_PER_1K');
  if (!config.LLM_BUDGET_MONTHLY_LIMIT) missing.push('LLM_BUDGET_MONTHLY_LIMIT');
  if (!config.LLM_LIVE_APPROVAL_REF) missing.push('LLM_LIVE_APPROVAL_REF');
  const key = anthropicApiKeyState(env);
  if (key === 'missing') missing.push('ANTHROPIC_API_KEY');
  else if (key === 'invalid') missing.push('ANTHROPIC_API_KEY(형식)');
  return { ready: missing.length === 0, missing };
}
