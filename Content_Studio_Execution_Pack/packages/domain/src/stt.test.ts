import { describe, expect, it } from 'vitest';
import { checkBudget } from './budget';
import { loadConfig } from './config';
import {
  AUDIO_BYTES_PER_SECOND,
  estimateAudioSeconds,
  LiveSttNotConfiguredError,
  sttBudgetPolicy,
  sttCostMicro,
  sttLiveReadiness,
  sttReserveFor,
  transcribeRequestSchema,
  transcriptEditSchema,
} from './stt';

describe('음성 전사 비용 추정(T08)', () => {
  it('길이: duration_seconds 우선, 없으면 ⌈bytes/16000⌉(최소 1초)', () => {
    expect(estimateAudioSeconds(1_000_000, 90)).toBe(90);
    expect(estimateAudioSeconds(AUDIO_BYTES_PER_SECOND * 10)).toBe(10);
    expect(estimateAudioSeconds(AUDIO_BYTES_PER_SECOND * 10 + 1)).toBe(11);
    expect(estimateAudioSeconds(1)).toBe(1);
  });

  it('비용 = ⌈초 × 1분 가격 / 60⌉ micro, 가격 없으면 0', () => {
    const pricing = { currency: 'USD', perMinuteMicro: 6_000n }; // 0.006 / 분
    expect(sttCostMicro(pricing, 60)).toBe(6_000n);
    expect(sttCostMicro(pricing, 1)).toBe(100n);
    expect(sttCostMicro({ currency: 'USD', perMinuteMicro: 7n }, 1)).toBe(1n); // 7/60 올림
    expect(sttCostMicro(null, 3600)).toBe(0n);
    // 큰 값도 정밀도 손실 없음
    expect(sttCostMicro({ currency: 'USD', perMinuteMicro: 999_999_999_999_999n }, 86_400)).toBe(1_439_999_999_999_998_560n);
  });

  it('정책: 통화·상한은 LLM_BUDGET_* 공용, 가격은 STT_PRICE_PER_MINUTE', () => {
    const p = sttBudgetPolicy(loadConfig({ STT_PRICE_PER_MINUTE: '0.006', LLM_BUDGET_CURRENCY: 'EUR', LLM_BUDGET_MONTHLY_LIMIT: '1', LLM_BUDGET_PER_RUN_MAX: '0.5' }));
    expect(p).toMatchObject({ mode: 'mock', currency: 'EUR', monthlyLimitMicro: 1_000_000n, perRunMaxMicro: 500_000n });
    expect(p.pricing).toEqual({ currency: 'EUR', perMinuteMicro: 6_000n });
    const r = sttReserveFor(p, 120, false);
    expect(r.reserveMicro).toBe(12_000n);
    expect(r.pricingSnapshot).toMatchObject({ kind: 'stt', per_minute: '0.006000', audio_seconds: 120, seconds_source: 'duration_seconds' });
    expect(checkBudget(p, 990_000n, r.reserveMicro)).toEqual({ ok: false, reason: 'monthly_limit' });
    expect(checkBudget(p, 0n, 600_000n)).toEqual({ ok: false, reason: 'per_run_max' });
    const unpriced = sttBudgetPolicy(loadConfig({}));
    expect(unpriced.pricing).toBeNull();
    expect(sttReserveFor(unpriced, 999, true)).toMatchObject({ reserveMicro: 0n, pricingSnapshot: { priced: false, seconds_source: 'bytes/16000' } });
    expect(checkBudget(unpriced, 10n ** 20n, 0n)).toEqual({ ok: true });
  });

  it('live 준비: 모두 채워도 어댑터가 없어 준비 안 됨(이름만, 값 없음)', () => {
    const empty = sttLiveReadiness(loadConfig({}));
    expect(empty.ready).toBe(false);
    expect(empty.missing).toEqual([
      'STT_MODE=live',
      'STT_PROVIDER',
      'STT_MODEL',
      'STT_PRICE_PER_MINUTE',
      'LLM_BUDGET_MONTHLY_LIMIT',
      'STT_LIVE_APPROVAL_REF',
      'LIVE_STT_ADAPTER(T08 미구현, 별도 승인 후)',
    ]);
    const full = loadConfig({
      STT_MODE: 'live',
      STT_PROVIDER: 'secret-provider-name',
      STT_MODEL: 'secret-model',
      STT_PRICE_PER_MINUTE: '0.01',
      LLM_BUDGET_MONTHLY_LIMIT: '5',
      STT_LIVE_APPROVAL_REF: 'D99',
    });
    const r = sttLiveReadiness(full);
    expect(r).toEqual({ ready: false, missing: ['LIVE_STT_ADAPTER(T08 미구현, 별도 승인 후)'] });
    const err = new LiveSttNotConfiguredError(r.missing);
    expect(err.code).toBe('LIVE_STT_NOT_CONFIGURED');
    expect(err.message).not.toContain('secret');
    expect(err.message).not.toContain('D99');
  });

  it('설정 기본값은 mock, 잘못된 값은 거부', () => {
    expect(loadConfig({}).STT_MODE).toBe('mock');
    expect(() => loadConfig({ STT_MODE: 'cloud' })).toThrow(/STT_MODE/);
    expect(() => loadConfig({ STT_PRICE_PER_MINUTE: '-1' })).toThrow(/STT_PRICE_PER_MINUTE/);
  });

  it('요청 입력: 길이 1–86400초, keep_original boolean, 수정 본문은 공백만 불가', () => {
    expect(transcribeRequestSchema.safeParse({}).success).toBe(true);
    expect(transcribeRequestSchema.safeParse({ duration_seconds: 0 }).success).toBe(false);
    expect(transcribeRequestSchema.safeParse({ duration_seconds: 86_401 }).success).toBe(false);
    expect(transcribeRequestSchema.safeParse({ keep_original: 'no' }).success).toBe(false);
    expect(transcribeRequestSchema.safeParse({ extra: 1 }).success).toBe(false);
    expect(transcriptEditSchema.safeParse({ base_version: 1, text: '  ' }).success).toBe(false);
    expect(transcriptEditSchema.safeParse({ base_version: 0, text: 'a' }).success).toBe(false);
    expect(transcriptEditSchema.safeParse({ base_version: 1, text: '고친 문장' }).success).toBe(true);
  });
});
