import { describe, expect, it } from 'vitest';
import {
  budgetPolicy,
  failedSettlement,
  failureUsageOf,
  checkBudget,
  costMicro,
  estimateTokens,
  fromMicro,
  liveLlmReadiness,
  mskMonthStart,
  mskNextMonthStart,
  sumToMicro,
  outputAllowanceTokens,
  reserveFor,
  toMicro,
} from './budget';
import { loadConfig } from './config';
import {
  LIVE_LLM_DEFAULT_MAX_OUTPUT_TOKENS,
  LIVE_LLM_FIXED_INPUT_BYTES,
  LIVE_LLM_FRAMING_OVERHEAD_TOKENS,
  LIVE_LLM_OUTPUT_JSON_SCHEMA,
  LIVE_LLM_SYSTEM_PROMPT,
  liveInputEstimateTokens,
  utf8ByteLength,
} from './llm-live';
import { filterClaimSources } from './writing';

const priced = (extra: Record<string, string> = {}) =>
  budgetPolicy(loadConfig({ LLM_PRICE_INPUT_PER_1K: '0.5', LLM_PRICE_OUTPUT_PER_1K: '1.5', ...extra }));

describe('금액·토큰 계산(T07, D13)', () => {
  it('toMicro/fromMicro 는 소수 6자리까지 오차 없이 왕복', () => {
    expect(toMicro('0')).toBe(0n);
    expect(toMicro('12.5')).toBe(12_500_000n);
    expect(toMicro('0.000001')).toBe(1n);
    expect(fromMicro(12_500_000n)).toBe('12.500000');
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
    expect(costMicro(priced().pricing, 1, 0)).toBe(500n); // 0.0005 → 올림 없이 정확
    expect(costMicro(null, 1000, 1000)).toBe(0n);
  });

  it('가격 없음(mock) → 예약 0, 스냅숏 priced=false, 한도 검사 없음', () => {
    const p = budgetPolicy(loadConfig({ LLM_BUDGET_MONTHLY_LIMIT: '0.000001' }));
    const r = reserveFor(p, 'x'.repeat(3000));
    expect(r.reserveMicro).toBe(0n);
    expect(r.pricingSnapshot).toMatchObject({ mode: 'mock', priced: false });
    expect(checkBudget(p, 10n ** 12n, 10n ** 9n)).toEqual({ ok: true });
  });

  it('상한: 1회 상한 초과 → per_run_max, 월 합계 초과 → monthly_limit, 경계값(=상한)은 허용', () => {
    const p = priced({ LLM_BUDGET_MONTHLY_LIMIT: '2', LLM_BUDGET_PER_RUN_MAX: '1' });
    expect(checkBudget(p, 0n, toMicro('1.000001'))).toEqual({ ok: false, reason: 'per_run_max' });
    expect(checkBudget(p, toMicro('1.5'), toMicro('0.5'))).toEqual({ ok: true });
    expect(checkBudget(p, toMicro('1.5'), toMicro('0.500001'))).toEqual({ ok: false, reason: 'monthly_limit' });
    expect(checkBudget(priced(), 10n ** 12n, 1n)).toEqual({ ok: true }); // 상한 미설정
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

describe('live 준비 상태(LIVE-L1, D34 — 빠진 조건 이름만, 모두 있으면 ready)', () => {
  const KEY = 'sk-ant-FAKE-sentinel-key-never-real-0123456789';
  const full = {
    LLM_MODE: 'live',
    LLM_PROVIDER: 'anthropic',
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

  it('모두 있으면 ready=true, missing 없음, 값·키(길이 포함)는 결과에 없다', () => {
    const r = liveLlmReadiness(loadConfig(full), { ANTHROPIC_API_KEY: KEY });
    expect(r).toEqual({ ready: true, missing: [] });
    expect(JSON.stringify(r)).not.toMatch(/model-y|D99-approval|sk-ant|sentinel/);
    expect(JSON.stringify(r)).not.toContain(String(KEY.length));
  });

  it.each(keys)('%s 가 빠지면 ready=false, 목록에 그 이름만', (key, name) => {
    const env: Record<string, string> = { ...full };
    delete env[key];
    const r = liveLlmReadiness(loadConfig(env), { ANTHROPIC_API_KEY: KEY });
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual([name]);
  });

  it.each([
    ['없음', {}, 'ANTHROPIC_API_KEY'],
    ['빈 값', { ANTHROPIC_API_KEY: '' }, 'ANTHROPIC_API_KEY'],
    ['공백뿐', { ANTHROPIC_API_KEY: '   ' }, 'ANTHROPIC_API_KEY'],
    ['중간 공백', { ANTHROPIC_API_KEY: 'sk-ant FAKE' }, 'ANTHROPIC_API_KEY(형식)'],
    ['513자', { ANTHROPIC_API_KEY: 'x'.repeat(513) }, 'ANTHROPIC_API_KEY(형식)'],
  ])('ANTHROPIC_API_KEY %s → ready=false, %s', (_l, env, name) => {
    const r = liveLlmReadiness(loadConfig(full), env);
    expect(r).toEqual({ ready: false, missing: [name] });
    expect(JSON.stringify(r)).not.toContain('FAKE');
  });

  it('키 앞뒤 공백은 떼고 본다(서버도 뗀 값을 쓴다)', () => {
    expect(liveLlmReadiness(loadConfig(full), { ANTHROPIC_API_KEY: `  ${KEY}  ` }).ready).toBe(true);
  });

  it.each(['openai', 'Anthropic', 'anthropic-x', 'provider-placeholder'])('LLM_PROVIDER=%s(anthropic 아님) → 준비 안 됨 LLM_PROVIDER=anthropic', (p) => {
    const r = liveLlmReadiness(loadConfig({ ...full, LLM_PROVIDER: p }), { ANTHROPIC_API_KEY: KEY });
    expect(r).toEqual({ ready: false, missing: ['LLM_PROVIDER=anthropic'] });
  });

  it('기본(mock, 아무것도 없음) → 모든 이름, LIVE_ADAPTER 표식은 더 없다', () => {
    const r = liveLlmReadiness(loadConfig({}), {});
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual([
      'LLM_MODE=live',
      'LLM_PROVIDER',
      'LLM_MODEL',
      'LLM_PRICE_INPUT_PER_1K',
      'LLM_PRICE_OUTPUT_PER_1K',
      'LLM_BUDGET_MONTHLY_LIMIT',
      'LLM_LIVE_APPROVAL_REF',
      'ANTHROPIC_API_KEY',
    ]);
    expect(r.missing.join(',')).not.toContain('LIVE_ADAPTER');
  });
});

describe('live 예약(LIVE-L1, D34 — 보수적 추정, 증명된 상한 아님)', () => {
  const live = (extra: Record<string, string> = {}) =>
    budgetPolicy(loadConfig({ LLM_MODE: 'live', LLM_PRICE_INPUT_PER_1K: '0.004', LLM_PRICE_OUTPUT_PER_1K: '0.02', ...extra }));

  it('입력 = 프롬프트 UTF-8 바이트 + 시스템·스키마 바이트 + 틀 여유, 출력 = LLM_LIVE_MAX_OUTPUT_TOKENS(기본 4096)', () => {
    const prompt = '가'.repeat(1000) + 'abc'; // 3003 바이트
    const r = reserveFor(live(), prompt);
    expect(utf8ByteLength(prompt)).toBe(3003);
    expect(r.tokensIn).toBe(3003 + LIVE_LLM_FIXED_INPUT_BYTES + LIVE_LLM_FRAMING_OVERHEAD_TOKENS);
    expect(r.tokensIn).toBe(liveInputEstimateTokens(prompt));
    expect(r.tokensOutAllowance).toBe(LIVE_LLM_DEFAULT_MAX_OUTPUT_TOKENS);
    expect(LIVE_LLM_DEFAULT_MAX_OUTPUT_TOKENS).toBe(4096);
    expect(r.reserveMicro).toBe(costMicro(live().pricing, r.tokensIn, 4096));
    expect(r.pricingSnapshot).toMatchObject({
      mode: 'live',
      token_estimate: 'utf8_bytes+fixed+overhead',
      output_allowance_tokens: 4096,
      fixed_input_bytes: LIVE_LLM_FIXED_INPUT_BYTES,
      overhead_tokens: LIVE_LLM_FRAMING_OVERHEAD_TOKENS,
    });
  });

  it('고정분 = 실제로 보내는 시스템 프롬프트 + 직렬화한 출력 스키마의 바이트(같은 상수에서)', () => {
    expect(LIVE_LLM_FIXED_INPUT_BYTES).toBe(utf8ByteLength(LIVE_LLM_SYSTEM_PROMPT) + utf8ByteLength(JSON.stringify(LIVE_LLM_OUTPUT_JSON_SCHEMA)));
  });

  it('한국어에서 live 입력 추정은 글자/3 보다 항상 크다(바이트 ≥ 글자, 상한 쪽)', () => {
    for (const s of ['가나다라마바사', 'mixed 한국어 text 123', '😀 이모지', '']) {
      expect(liveInputEstimateTokens(s)).toBeGreaterThan(estimateTokens(s));
      expect(utf8ByteLength(s)).toBeGreaterThanOrEqual(s.length);
    }
  });

  it('LLM_LIVE_MAX_OUTPUT_TOKENS: 설정값을 쓰고, 범위(1024~16000)·형식 밖은 설정 오류', () => {
    expect(reserveFor(live({ LLM_LIVE_MAX_OUTPUT_TOKENS: '8000' }), 'x').tokensOutAllowance).toBe(8000);
    expect(reserveFor(live({ LLM_LIVE_MAX_OUTPUT_TOKENS: '1024' }), 'x').tokensOutAllowance).toBe(1024);
    expect(reserveFor(live({ LLM_LIVE_MAX_OUTPUT_TOKENS: '16000' }), 'x').tokensOutAllowance).toBe(16000);
    for (const bad of ['1023', '16001', '-1', '4096.5', 'abc', '1e4']) expect(() => loadConfig({ LLM_LIVE_MAX_OUTPUT_TOKENS: bad })).toThrow();
  });

  it('mock 경로의 숫자는 그대로(글자/3, max(256, 입력/2)) — LLM_LIVE_MAX_OUTPUT_TOKENS 를 바꿔도 영향 없음', () => {
    const r = reserveFor(priced({ LLM_LIVE_MAX_OUTPUT_TOKENS: '9000' }), 'x'.repeat(3000));
    expect([r.tokensIn, r.tokensOutAllowance]).toEqual([1000, 500]);
    expect(r.pricingSnapshot).toMatchObject({ mode: 'mock', token_estimate: 'chars/3', output_allowance_tokens: 500 });
    expect(r.pricingSnapshot).not.toHaveProperty('overhead_tokens');
  });

  it('제안 1회 상한 0.5 USD: 보통 원고(한글 4천 자 프롬프트)는 통과, 한글 4만 자는 per_run_max', () => {
    const p = live({ LLM_BUDGET_PER_RUN_MAX: '0.5', LLM_BUDGET_MONTHLY_LIMIT: '10' });
    const typical = reserveFor(p, '가'.repeat(4000));
    expect(typical.reserveMicro).toBeLessThan(toMicro('0.2'));
    expect(checkBudget(p, 0n, typical.reserveMicro)).toEqual({ ok: true });
    expect(checkBudget(p, 0n, reserveFor(p, '가'.repeat(40000)).reserveMicro)).toEqual({ ok: false, reason: 'per_run_max' });
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

describe('FIX-T07 P2: bigint 금액', () => {
  it('Codex 경계값 9007199254.740993 를 정확히 왕복(Number 로는 불가)', () => {
    expect(toMicro('9007199254.740993')).toBe(9_007_199_254_740_993n);
    expect(fromMicro(toMicro('9007199254.740993'))).toBe('9007199254.740993');
    expect(Number.isSafeInteger(Number('9007199254740993'))).toBe(false); // Number 로는 정확히 표현 불가
  });
  it('numeric(18,6) 최대값까지 허용, 넘거나 형식이 틀리면 거부', () => {
    expect(fromMicro(toMicro('999999999999.999999'))).toBe('999999999999.999999');
    for (const bad of ['1000000000000', '1.0000001', '-1', '1e3', '', '.5', '1.']) expect(() => toMicro(bad), bad).toThrow();
  });
  it('가격 × 토큰 곱을 중간 정밀도 손실 없이 올림', () => {
    const p = { currency: 'USD', inputPer1kMicro: toMicro('999999999.999999'), outputPer1kMicro: 1n };
    // 1_000_003 토큰 × 999999999999999 micro / 1000 → 정확한 올림
    expect(costMicro(p, 1_000_003, 0)).toBe((1_000_003n * 999_999_999_999_999n + 999n) / 1000n);
    expect(costMicro(p, 0, 1)).toBe(1n); // 0.001 micro → 1 micro 로 올림
  });
});

describe('FIX-T07 round 2: 합계 범위·월 상한', () => {
  it('합계는 행 범위(numeric(18,6))를 넘어도 정확히 읽는다', () => {
    expect(sumToMicro('1200000000000.000000')).toBe(1_200_000_000_000_000_000n);
    expect(() => toMicro('1200000000000.000000')).toThrow(); // 행 하나로는 저장 불가
    expect(sumToMicro('0')).toBe(0n);
    expect(() => sumToMicro('1.0000001')).toThrow();
  });
  it('다음 달 시작(MSK)', () => {
    expect(mskNextMonthStart(new Date('2026-09-15T00:00:00Z')).toISOString()).toBe('2026-09-30T21:00:00.000Z');
    expect(mskNextMonthStart(new Date('2026-12-31T21:30:00Z')).toISOString()).toBe('2027-01-31T21:00:00.000Z'); // MSK 1월 1일
  });
});

describe('FIX1(Codex review-LIVEL1) — 실패 정산·실제 호출 횟수 설정', () => {
  const live = (extra: Record<string, string> = {}) =>
    budgetPolicy(loadConfig({ LLM_MODE: 'live', LLM_PRICE_INPUT_PER_1K: '0.004', LLM_PRICE_OUTPUT_PER_1K: '0.02', LLM_LIVE_APPROVAL_REF: 'D34-x', ...extra }));

  it('failedSettlement = max(예약액, usage 비용), 초과액 = 그 차이, usage 없으면 예약액(D13)', () => {
    const p = live();
    const reserved = toMicro('0.1');
    expect(failedSettlement(p.pricing, reserved, null)).toEqual({ actualMicro: reserved, overageMicro: 0n });
    expect(failedSettlement(p.pricing, reserved, { tokensIn: 10, tokensOut: 10 })).toEqual({ actualMicro: reserved, overageMicro: 0n });
    const big = costMicro(p.pricing, 200_000, 4096);
    expect(failedSettlement(p.pricing, reserved, { tokensIn: 200_000, tokensOut: 4096 })).toEqual({ actualMicro: big, overageMicro: big - reserved });
  });

  it('failureUsageOf: 오류의 usage 가 안전한 음이 아닌 정수 둘일 때만', () => {
    expect(failureUsageOf({ usage: { tokensIn: 1, tokensOut: 2 } })).toEqual({ tokensIn: 1, tokensOut: 2 });
    for (const bad of [null, undefined, new Error('x'), { usage: null }, { usage: { tokensIn: -1, tokensOut: 2 } }, { usage: { tokensIn: '1', tokensOut: 2 } }, { usage: { tokensIn: 2 ** 53, tokensOut: 0 } }, { usage: { tokensIn: 1.5, tokensOut: 0 } }]) {
      expect(failureUsageOf(bad)).toBeNull();
    }
  });

  it('LLM_LIVE_MAX_RUNS: 양의 정수(1~1000000), 없으면 제한 없음, 형식 밖은 설정 오류', () => {
    expect(live().liveMaxRuns).toBeUndefined();
    expect(live({ LLM_LIVE_MAX_RUNS: '1' }).liveMaxRuns).toBe(1);
    expect(live({ LLM_LIVE_MAX_RUNS: '1000000' }).liveMaxRuns).toBe(1000000);
    for (const bad of ['0', '-1', '1.5', 'abc', '1000001', '1e3']) expect(() => loadConfig({ LLM_LIVE_MAX_RUNS: bad })).toThrow();
  });

  it('live 예약 스냅숏에 승인 기록(approval_ref)을 남긴다(횟수 계산용) — mock 에는 없음', () => {
    expect(reserveFor(live(), 'x').pricingSnapshot).toMatchObject({ mode: 'live', approval_ref: 'D34-x' });
    expect(reserveFor(budgetPolicy(loadConfig({ LLM_LIVE_APPROVAL_REF: 'D34-x' })), 'x').pricingSnapshot).not.toHaveProperty('approval_ref');
  });
});
