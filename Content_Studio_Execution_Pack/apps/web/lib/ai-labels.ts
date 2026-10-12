/**
 * LIVE-UI(D34 2단계 준비): AI 작성 보조·채널 초안 화면 문구를 실제 모드에 맞춘다.
 * LLM_MODE=live 에서 "모의"라고 표시하면 실제 호출·과금을 숨기게 된다 — 요청 버튼은 설정 모드, 결과 표시는 그 run 이 실제로 쓴 provider 로 정한다.
 */
import { MOCK_WARNING } from '@cs/providers';

export type LlmMode = 'mock' | 'live';

export interface AssistModeText {
  /** 작성 보조 영역 맨 위 안내 */
  notice: string;
  /** 제안 요청 버튼(버전 번호는 호출자가 붙인다) */
  assistButton: string;
  /** 채널 초안의 AI 초안 버튼 */
  variantButton: string;
}

export function assistModeText(mode: LlmMode): AssistModeText {
  if (mode === 'live') {
    return {
      notice:
        '실제 AI(Claude) 모드입니다 — 요청할 때마다 Anthropic 으로 실제 호출하고 비용이 기록됩니다(결정 D34). 제안은 현재 본문을 바꾸지 않고 "AI 제안" 버전으로만 저장됩니다.',
      assistButton: '실제 AI 제안 요청(호출·과금)',
      variantButton: 'AI 초안(실제 호출·과금)',
    };
  }
  return {
    notice: `${MOCK_WARNING} — 지금은 모의 AI 만 동작합니다(결정 D7). 제안은 현재 본문을 바꾸지 않고 "AI 제안" 버전으로만 저장됩니다.`,
    assistButton: '모의 제안 만들기',
    variantButton: 'AI 초안(모의)',
  };
}

export type ResultOrigin = 'mock' | 'live' | 'unknown';

/** 실제 AI 로 확인된 provider 이름(ClaudeLlmProvider.name). 그 밖의 값은 출처 미확인. */
const LIVE_PROVIDERS = new Set(['anthropic']);

/**
 * FIX-LIVEUI: 그 결과의 출처. run.provider(작성 보조) 또는 버전 createdBy('ai:mock' | 'ai:live')로만 정한다.
 * 확인된 값만 mock/live 로 보고, 없음·빈 값·모르는 값은 unknown(모의라고도 실제라고도 단정하지 않는다).
 */
export function resultOrigin(by: { provider?: string | null; createdBy?: string | null }): ResultOrigin {
  if (by.provider != null && by.provider !== '') {
    if (by.provider === 'mock') return 'mock';
    return LIVE_PROVIDERS.has(by.provider) ? 'live' : 'unknown';
  }
  if (by.createdBy === 'ai:mock') return 'mock';
  if (by.createdBy === 'ai:live') return 'live';
  return 'unknown';
}

const ORIGIN_TEXT: Record<ResultOrigin, string> = { mock: '모의', live: '실제 AI', unknown: '출처 미확인' };

/** 제안·초안 이름표: "AI 제안(모의)" / "AI 제안(실제 AI)" / "AI 제안(출처 미확인)" */
export function resultLabel(kind: '제안' | '초안', origin: ResultOrigin): string {
  return `AI ${kind}(${ORIGIN_TEXT[origin]})`;
}

/** 가격 미설정 원장 표시 — "모의"는 모의 결과일 때만 붙인다. */
export function unpricedLabel(origin: ResultOrigin): string {
  return origin === 'mock' ? '가격 미설정(모의 0)' : '가격 미설정(0 으로 기록)';
}

/** 원장 토큰 출처 표시(스냅숏 usage_source). 키 없음 = LIVE-L1 이전 행(모의 추정). */
export function usageSourceLabel(snapshot: unknown): string {
  const src = snapshot && typeof snapshot === 'object' ? (snapshot as { usage_source?: unknown }).usage_source : undefined;
  switch (src) {
    case 'provider':
      return '공급자 보고';
    case 'none':
      return '사용량 모름 — 예약액으로 확정';
    case 'provider_unstorable':
      return '보고값이 기록 범위 밖 — 운영자 확인 필요';
    case 'estimate':
    default:
      return '추정';
  }
}

/** 실패 run 의 확정 방식 문구(FIX2-LIVEL1 규칙: 보고 usage 가 있으면 max(예약, 보고 비용), 없으면 예약액). */
export function failedSettlementLabel(snapshot: unknown): string {
  const src = snapshot && typeof snapshot === 'object' ? (snapshot as { usage_source?: unknown }).usage_source : undefined;
  return src === 'provider' ? '실패(예약액과 보고 비용 중 큰 값으로 확정)' : '실패(예약액으로 확정)';
}
