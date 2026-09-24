/**
 * T07 AI 비용 예약(A15, 결정 D13) — 순수 함수. DB·네트워크 없음.
 *
 * - 금액은 부동소수 오차를 피하려고 micro 단위(1e-6 통화) 정수로 계산한다. DB 에는 numeric(18,6) 문자열로 저장한다.
 * - 토큰 추정: 프롬프트 글자 수 / 3(올림). 한국어·영어가 섞인 글에서 보수적으로(많게) 잡는 경험칙이다 — 실제 토크나이저가 아니다.
 * - 출력 여유분: max(256, 입력 추정의 절반) 토큰.
 * - 예약액 = 입력 추정 × 입력 단가 + 출력 여유분 × 출력 단가(각각 1K 토큰당, 올림).
 * - 가격이 없으면: live 는 차단(liveLlmReadiness), mock 은 0 으로 예약·기록만 한다(한도 검사 없음).
 * - 월 사용액 = 이 owner 의 이번 달(MSK) 원장 합계: reserved 는 예약액, settled 는 실제액, released 는 0.
 */
import type { AppConfig } from './config';
import { AppError } from './errors';

export const TOKEN_CHARS = 3;
export const MIN_OUTPUT_ALLOWANCE_TOKENS = 256;
const MICRO = 1_000_000;

/** "12.345678" → 12345678(micro). 형식은 config 스키마가 이미 검사했다. */
export function toMicro(decimal: string): number {
  const [int, frac = ''] = decimal.split('.');
  return Number(int) * MICRO + Number((frac + '000000').slice(0, 6));
}

/** 12345678 → "12.345678" */
export function fromMicro(micro: number): string {
  const sign = micro < 0 ? '-' : '';
  const abs = Math.abs(Math.round(micro));
  return `${sign}${Math.floor(abs / MICRO)}.${String(abs % MICRO).padStart(6, '0')}`;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_CHARS);
}

export function outputAllowanceTokens(inputTokens: number): number {
  return Math.max(MIN_OUTPUT_ALLOWANCE_TOKENS, Math.ceil(inputTokens / 2));
}

export interface Pricing {
  currency: string;
  inputPer1kMicro: number;
  outputPer1kMicro: number;
}

export interface BudgetPolicy {
  mode: 'mock' | 'live';
  currency: string;
  /** 가격이 없으면 null(mock: 0 원 기록, live: 차단) */
  pricing: Pricing | null;
  monthlyLimitMicro: number | null;
  perRunMaxMicro: number | null;
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
  };
}

export function costMicro(pricing: Pricing | null, tokensIn: number, tokensOut: number): number {
  if (!pricing) return 0;
  return Math.ceil((tokensIn * pricing.inputPer1kMicro) / 1000) + Math.ceil((tokensOut * pricing.outputPer1kMicro) / 1000);
}

export interface Reservation {
  tokensIn: number;
  tokensOutAllowance: number;
  reserveMicro: number;
  /** 원장에 남기는 가격 스냅숏(값만 — 키·비밀 없음) */
  pricingSnapshot: Record<string, unknown>;
}

export function reserveFor(policy: BudgetPolicy, prompt: string): Reservation {
  const tokensIn = estimateTokens(prompt);
  const tokensOutAllowance = outputAllowanceTokens(tokensIn);
  const reserveMicro = costMicro(policy.pricing, tokensIn, tokensOutAllowance);
  const pricingSnapshot = policy.pricing
    ? {
        mode: policy.mode,
        currency: policy.pricing.currency,
        input_per_1k: fromMicro(policy.pricing.inputPer1kMicro),
        output_per_1k: fromMicro(policy.pricing.outputPer1kMicro),
        token_estimate: `chars/${TOKEN_CHARS}`,
        output_allowance_tokens: tokensOutAllowance,
      }
    : { mode: policy.mode, priced: false, token_estimate: `chars/${TOKEN_CHARS}`, output_allowance_tokens: tokensOutAllowance };
  return { tokensIn, tokensOutAllowance, reserveMicro, pricingSnapshot };
}

export type BudgetDecision = { ok: true } | { ok: false; reason: 'per_run_max' | 'monthly_limit' };

/**
 * 예약 가능 여부. 가격이 없으면(mock 전용 — live 는 그 전에 차단) 한도를 검사하지 않는다.
 * usedMicro = 이번 달 원장 합계(예약 중 + 확정). 경계값(합계 = 상한)은 허용한다.
 */
export function checkBudget(policy: BudgetPolicy, usedMicro: number, reserveMicro: number): BudgetDecision {
  if (!policy.pricing) return { ok: true };
  if (policy.perRunMaxMicro !== null && reserveMicro > policy.perRunMaxMicro) return { ok: false, reason: 'per_run_max' };
  if (policy.monthlyLimitMicro !== null && usedMicro + reserveMicro > policy.monthlyLimitMicro) return { ok: false, reason: 'monthly_limit' };
  return { ok: true };
}

/** 이번 달(MSK = UTC+3, 서머타임 없음) 시작 시각(UTC). */
export function mskMonthStart(now: Date): Date {
  const msk = new Date(now.getTime() + 3 * 3600_000);
  return new Date(Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), 1) - 3 * 3600_000);
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

// ---- live 준비 상태(T07: 어댑터가 없으므로 항상 준비 안 됨) ----

export interface LiveReadiness {
  ready: false;
  /** 빠진 조건 이름(값 없음). */
  missing: string[];
}

/**
 * 실제 AI 호출의 전제 조건. 모두 갖춰져도 T07 에는 HTTP 어댑터가 없으므로 ready 는 항상 false 이고
 * 'LIVE_ADAPTER(T07 미구현, D8 결정 후)' 가 목록에 남는다. 값은 절대 넣지 않는다.
 */
export function liveLlmReadiness(config: AppConfig): LiveReadiness {
  const missing: string[] = [];
  if (config.LLM_MODE !== 'live') missing.push('LLM_MODE=live');
  if (!config.LLM_PROVIDER) missing.push('LLM_PROVIDER');
  if (!config.LLM_MODEL) missing.push('LLM_MODEL');
  if (!config.LLM_PRICE_INPUT_PER_1K) missing.push('LLM_PRICE_INPUT_PER_1K');
  if (!config.LLM_PRICE_OUTPUT_PER_1K) missing.push('LLM_PRICE_OUTPUT_PER_1K');
  if (!config.LLM_BUDGET_MONTHLY_LIMIT) missing.push('LLM_BUDGET_MONTHLY_LIMIT');
  if (!config.LLM_LIVE_APPROVAL_REF) missing.push('LLM_LIVE_APPROVAL_REF');
  missing.push('LIVE_ADAPTER(T07 미구현, D8 결정 후)');
  return { ready: false, missing };
}
