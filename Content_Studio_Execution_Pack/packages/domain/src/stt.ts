/**
 * T08 음성 전사(결정 D9·D15) — 순수 함수. DB·네트워크 없음.
 *
 * - 기본은 모의 전사(STT_MODE=mock): 파일 checksum 으로 정해지는 자리표시 문장. 실제 음성 인식이 아니다.
 * - live 는 승인 기록(STT_LIVE_APPROVAL_REF)·공급자·모델·가격이 모두 있어도 T08 에는 어댑터(HTTP 호출)가 없어 항상 거부된다.
 * - 비용: T07 과 같은 원장(usage_ledger)·통화(LLM_BUDGET_CURRENCY)·상한(LLM_BUDGET_MONTHLY_LIMIT·PER_RUN_MAX)을 쓴다.
 *   예약액 = ⌈음성 초 × 1분 가격 / 60⌉(micro). 길이는 요청의 duration_seconds, 없으면 ⌈bytes / 16000⌉(≈128kbps 가정)초.
 *   가격이 없으면 mock 은 0 으로 예약·기록만(한도 검사 없음).
 */
import { z } from 'zod';
import { fromMicro, toMicro } from './budget';
import type { AppConfig } from './config';
import { GuardError } from './errors';

export const MOCK_TRANSCRIPT_WARNING = '모의 전사: 실제 음성 인식 결과가 아닙니다(자리표시 문장)';
/** 길이를 모를 때의 추정 기준(바이트/초, ≈128kbps) */
export const AUDIO_BYTES_PER_SECOND = 16_000;
export const MAX_AUDIO_SECONDS = 86_400;
export const MAX_TRANSCRIPT_CHARS = 200_000;

export const TRANSCRIPTION_STATES = ['queued', 'running', 'succeeded', 'failed', 'canceled'] as const;
export type TranscriptionState = (typeof TRANSCRIPTION_STATES)[number];
/** inline worker 한 번(tick)에 올라가는 진행률 단계 */
export const TRANSCRIPTION_STEP = 25;

export function estimateAudioSeconds(bytes: number, durationSeconds?: number): number {
  if (durationSeconds !== undefined) return durationSeconds;
  return Math.max(1, Math.ceil(bytes / AUDIO_BYTES_PER_SECOND));
}

export interface SttPricing {
  currency: string;
  perMinuteMicro: bigint;
}

export interface SttBudgetPolicy {
  mode: 'mock' | 'live';
  currency: string;
  pricing: SttPricing | null;
  monthlyLimitMicro: bigint | null;
  perRunMaxMicro: bigint | null;
}

export function sttBudgetPolicy(config: AppConfig): SttBudgetPolicy {
  return {
    mode: config.STT_MODE,
    currency: config.LLM_BUDGET_CURRENCY,
    pricing:
      config.STT_PRICE_PER_MINUTE !== undefined
        ? { currency: config.LLM_BUDGET_CURRENCY, perMinuteMicro: toMicro(config.STT_PRICE_PER_MINUTE) }
        : null,
    monthlyLimitMicro: config.LLM_BUDGET_MONTHLY_LIMIT !== undefined ? toMicro(config.LLM_BUDGET_MONTHLY_LIMIT) : null,
    perRunMaxMicro: config.LLM_BUDGET_PER_RUN_MAX !== undefined ? toMicro(config.LLM_BUDGET_PER_RUN_MAX) : null,
  };
}

/** ⌈초 × 1분 가격 / 60⌉ (bigint, 정밀도 손실 없음) */
export function sttCostMicro(pricing: SttPricing | null, seconds: number): bigint {
  if (!pricing) return 0n;
  return (BigInt(seconds) * pricing.perMinuteMicro + 59n) / 60n;
}

export interface SttReservation {
  audioSeconds: number;
  reserveMicro: bigint;
  pricingSnapshot: Record<string, unknown>;
}

export function sttReserveFor(policy: SttBudgetPolicy, audioSeconds: number, estimated: boolean): SttReservation {
  const reserveMicro = sttCostMicro(policy.pricing, audioSeconds);
  const base = { kind: 'stt', mode: policy.mode, audio_seconds: audioSeconds, seconds_source: estimated ? `bytes/${AUDIO_BYTES_PER_SECOND}` : 'duration_seconds' };
  return {
    audioSeconds,
    reserveMicro,
    pricingSnapshot: policy.pricing
      ? { ...base, currency: policy.pricing.currency, per_minute: fromMicro(policy.pricing.perMinuteMicro) }
      : { ...base, priced: false },
  };
}

export interface SttLiveReadiness {
  ready: false;
  missing: string[];
}

/** 실제 전사의 전제 조건(이름만, 값 없음). T08 에는 어댑터가 없어 ready 는 항상 false. */
export function sttLiveReadiness(config: AppConfig): SttLiveReadiness {
  const missing: string[] = [];
  if (config.STT_MODE !== 'live') missing.push('STT_MODE=live');
  if (!config.STT_PROVIDER) missing.push('STT_PROVIDER');
  if (!config.STT_MODEL) missing.push('STT_MODEL');
  if (!config.STT_PRICE_PER_MINUTE) missing.push('STT_PRICE_PER_MINUTE');
  if (!config.LLM_BUDGET_MONTHLY_LIMIT) missing.push('LLM_BUDGET_MONTHLY_LIMIT');
  if (!config.STT_LIVE_APPROVAL_REF) missing.push('STT_LIVE_APPROVAL_REF');
  missing.push('LIVE_STT_ADAPTER(T08 미구현, 별도 승인 후)');
  return { ready: false, missing };
}

export class LiveSttNotConfiguredError extends GuardError {
  readonly missing: string[];
  constructor(missing: string[] = []) {
    super(
      'LIVE_STT_NOT_CONFIGURED',
      `실제 음성 전사 공급자가 구현·승인되어 있지 않습니다. STT_MODE=mock 으로 실행하세요.${missing.length ? ` (준비 안 됨: ${missing.join(', ')})` : ''}`,
    );
    this.missing = missing;
  }
}

// ---- 입력 ----

export const transcriptSegmentSchema = z.strictObject({ start_ms: z.int().min(0), end_ms: z.int().min(0), text: z.string() });
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

export const transcribeRequestSchema = z
  .object({
    duration_seconds: z.int().min(1).max(MAX_AUDIO_SECONDS).optional(),
    keep_original: z.boolean().optional(),
  })
  .strict();

export const transcriptEditSchema = z
  .object({
    base_version: z.int().min(1),
    text: z
      .string()
      .max(MAX_TRANSCRIPT_CHARS)
      .refine((t) => t.trim() !== '', { message: '전사 본문이 비어 있습니다' }),
  })
  .strict();
