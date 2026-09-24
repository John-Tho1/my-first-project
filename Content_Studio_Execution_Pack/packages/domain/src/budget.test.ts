import { describe, expect, it } from 'vitest';
import {
  budgetPolicy,
  checkBudget,
  costMicro,
  estimateTokens,
  fromMicro,
  liveLlmReadiness,
  mskMonthStart,
  outputAllowanceTokens,
  reserveFor,
  toMicro,
} from './budget';
import { loadConfig } from './config';
import { filterClaimSources } from './writing';

const priced = (extra: Record<string, string> = {}) =>
  budgetPolicy(loadConfig({ LLM_PRICE_INPUT_PER_1K: '0.5', LLM_PRICE_OUTPUT_PER_1K: '1.5', ...extra }));

describe('금액·토큰 계산(T07, D13)', () => {
  it('toMicro/fromMicro 는 소수 6자리까지 오차 없이 왕복', () => {
    expect(toMicro('0')).toBe(0);
    expect(toMicro('12.5')).toBe(12_500_000);
    expect(toMicro('0.000001')).toBe(1);
    expect(fromMicro(12_500_000)).toBe('12.500000');
    expect(fromMicro(toMicro('123456789.123456'))).toBe('123456789.123456');
  });

  it('토큰 추정 = 글자/3 올림, 출력 여유분 = max(256, 입력/2)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(2);
    expect(estimateTokens('가'.repeat(3000))).toBe(1000);
    expect(outputAllowanceTokens(100)).toBe(256);
    expect(outputAllowanceTokens(1000)).toBe(500);
  });

  it('예약액 = 입력 추정 × 입력 단가 + 출력 여유분 × 출력 단가(1K 토큰당, 올림)', () => {
    const r = reserveFor(priced(), 'x'.repeat(3000)); // 1000 tokens in, 500 out
    expect(r.tokensIn).toBe(1000);
    expect(r.tokensOutAllowance).toBe(500);
    expect(r.reserveMicro).toBe(toMicro('0.5') + toMicro('0.75'));
    expect(r.pricingSnapshot).toMatchObject({ currency: 'USD', input_per_1k: '0.500000', output_per_1k: '1.500000' });
    expect(costMicro(priced().pricing, 1, 0)).toBe(500); // 0.0005 → 올림 없이 정확
    expect(costMicro(null, 1000, 1000)).toBe(0);
  });

  it('가격 없음(mock) → 예약 0, 스냅숏 priced=false, 한도 검사 없음', () => {
    const p = budgetPolicy(loadConfig({ LLM_BUDGET_MONTHLY_LIMIT: '0.000001' }));
    const r = reserveFor(p, 'x'.repeat(3000));
    expect(r.reserveMicro).toBe(0);
    expect(r.pricingSnapshot).toMatchObject({ mode: 'mock', priced: false });
    expect(checkBudget(p, 10 ** 12, 10 ** 9)).toEqual({ ok: true });
  });

  it('상한: 1회 상한 초과 → per_run_max, 월 합계 초과 → monthly_limit, 경계값(=상한)은 허용', () => {
    const p = priced({ LLM_BUDGET_MONTHLY_LIMIT: '2', LLM_BUDGET_PER_RUN_MAX: '1' });
    expect(checkBudget(p, 0, toMicro('1.000001'))).toEqual({ ok: false, reason: 'per_run_max' });
    expect(checkBudget(p, toMicro('1.5'), toMicro('0.5'))).toEqual({ ok: true });
    expect(checkBudget(p, toMicro('1.5'), toMicro('0.500001'))).toEqual({ ok: false, reason: 'monthly_limit' });
    expect(checkBudget(priced(), 10 ** 12, 1)).toEqual({ ok: true }); // 상한 미설정
  });

  it('월 시작은 MSK(UTC+3) 기준', () => {
    expect(mskMonthStart(new Date('2026-09-30T21:30:00Z')).toISOString()).toBe('2026-09-30T21:00:00.000Z'); // MSK 10-01 00:30
    expect(mskMonthStart(new Date('2026-09-30T20:59:00Z')).toISOString()).toBe('2026-08-31T21:00:00.000Z');
  });

  it('잘못된 금액 형식은 설정 오류', () => {
    expect(() => loadConfig({ LLM_PRICE_INPUT_PER_1K: '-1' })).toThrow();
    expect(() => loadConfig({ LLM_BUDGET_MONTHLY_LIMIT: '1e3' })).toThrow();
    expect(() => loadConfig({ LLM_BUDGET_CURRENCY: 'usd' })).toThrow();
  });
});

describe('live 준비 상태(항상 false, 빠진 조건 이름만)', () => {
  const full = {
    LLM_MODE: 'live',
    LLM_PROVIDER: 'provider-x',
    LLM_MODEL: 'model-y',
    LLM_PRICE_INPUT_PER_1K: '1',
    LLM_PRICE_OUTPUT_PER_1K: '1',
    LLM_BUDGET_MONTHLY_LIMIT: '10',
    LLM_LIVE_APPROVAL_REF: 'D99-approval',
  };
  const keys: Array<[keyof typeof full, string]> = [
    ['LLM_MODE', 'LLM_MODE=live'],
    ['LLM_PROVIDER', 'LLM_PROVIDER'],
    ['LLM_MODEL', 'LLM_MODEL'],
    ['LLM_PRICE_INPUT_PER_1K', 'LLM_PRICE_INPUT_PER_1K'],
    ['LLM_PRICE_OUTPUT_PER_1K', 'LLM_PRICE_OUTPUT_PER_1K'],
    ['LLM_BUDGET_MONTHLY_LIMIT', 'LLM_BUDGET_MONTHLY_LIMIT'],
    ['LLM_LIVE_APPROVAL_REF', 'LLM_LIVE_APPROVAL_REF'],
  ];

  it('모두 있어도 어댑터가 없어 ready=false(LIVE_ADAPTER 만 남음), 값은 목록에 없다', () => {
    const r = liveLlmReadiness(loadConfig(full));
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual(['LIVE_ADAPTER(T07 미구현, D8 결정 후)']);
    expect(JSON.stringify(r)).not.toMatch(/provider-x|model-y|D99-approval/);
  });

  it.each(keys)('%s 가 빠지면 목록에 이름이 나온다', (key, name) => {
    const env: Record<string, string> = { ...full };
    delete env[key];
    const r = liveLlmReadiness(loadConfig(env));
    expect(r.ready).toBe(false);
    expect(r.missing).toContain(name);
  });
});

describe('filterClaimSources(모델이 만든 출처 거르기)', () => {
  const SV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  it('허용 목록 밖은 버리고 개수만 남기며 needs_check', () => {
    const [a, b, c, d] = filterClaimSources(
      [
        { text: '시장 규모는 커졌다.', kind: 'fact', source_refs: [SV.toUpperCase(), SV, 'https://invented.example/report'], needs_user_confirmation: false },
        { text: '의견이다.', kind: 'opinion', source_refs: [], needs_user_confirmation: false },
        { text: '근거 없는 사실.', kind: 'fact', source_refs: [], needs_user_confirmation: false },
        { text: '제가 했습니다.', kind: 'experience', source_refs: [SV], needs_user_confirmation: true },
      ],
      [SV],
    );
    expect(a).toMatchObject({ source_refs: [SV], dropped_source_refs: 1, evidence_grade: 'source', needs_check: true });
    expect(JSON.stringify(a)).not.toContain('invented');
    expect(b).toMatchObject({ source_refs: [], dropped_source_refs: 0, evidence_grade: 'none', needs_check: false });
    expect(c).toMatchObject({ evidence_grade: 'none', needs_check: true });
    expect(d).toMatchObject({ source_refs: [SV], evidence_grade: 'source', needs_check: true });
  });
  it('허용 목록이 비면 모든 출처를 버린다', () => {
    const [a] = filterClaimSources([{ text: 't', kind: 'opinion', source_refs: [SV], needs_user_confirmation: false }], []);
    expect(a).toMatchObject({ source_refs: [], dropped_source_refs: 1, needs_check: true });
  });
});
