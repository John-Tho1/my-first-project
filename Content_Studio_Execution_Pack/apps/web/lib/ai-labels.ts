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

/** run.provider(작성 보조) 또는 버전 createdBy('ai:mock' | 'ai:live')로 그 결과가 모의였는지. 모르면 모의로 보지 않는다(실제 가능성을 숨기지 않음). */
export function isMockResult(by: { provider?: string | null; createdBy?: string | null }): boolean {
  if (by.provider != null) return by.provider === 'mock';
  if (by.createdBy != null) return by.createdBy === 'ai:mock';
  return false;
}

/** 제안·초안 이름표: "AI 제안(모의)" / "AI 제안(실제 AI)" */
export function resultLabel(kind: '제안' | '초안', mock: boolean): string {
  return `AI ${kind}(${mock ? '모의' : '실제 AI'})`;
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
