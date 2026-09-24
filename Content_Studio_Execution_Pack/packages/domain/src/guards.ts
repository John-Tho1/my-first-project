/**
 * 서버/worker 전용 가드 — 외부 효과(게시·수집·실제 AI 호출)의 단일 강제 지점.
 * 클라이언트 컴포넌트에서 import 하지 않는다. UI 버튼 비활성화만으로 막지 않는다.
 *
 * 모든 가드는 "기본 거부"다. 명시적으로 허용 조건이 모두 충족될 때만 통과한다.
 */
import type { AppConfig } from './config';
import {
  ApprovalRequiredError,
  CollectorDisabledError,
  LiveLlmNotAllowedError,
  PublishDisabledError,
} from './errors';

/** 게시 의도. M3에서 승인 ID·payload hash 검증이 추가된다. */
export interface PublishIntent {
  platform: string;
  payloadHash?: string;
  approvalId?: string;
}

/**
 * 게시 허용 여부. M0에는 서버가 검증할 승인 저장소가 없으므로
 * PUBLISH_MODE=enabled 여도 항상 ApprovalRequiredError 로 거부한다.
 * intent 에 approvalId 가 들어 있어도 신뢰하지 않는다(LLM·클라이언트 입력은 승인이 아님).
 */
export function assertPublishAllowed(config: AppConfig, intent: PublishIntent): never {
  void intent;
  if (config.PUBLISH_MODE !== 'enabled') throw new PublishDisabledError();
  throw new ApprovalRequiredError();
}

export function assertCollectorAllowed(config: AppConfig): void {
  if (config.COLLECTOR_MODE !== 'enabled') throw new CollectorDisabledError();
}

export function assertLiveLlmAllowed(config: AppConfig): void {
  if (config.LLM_MODE !== 'live') throw new LiveLlmNotAllowedError('LLM_MODE=mock 입니다');
  if (!config.LLM_PROVIDER || !config.LLM_MODEL) {
    throw new LiveLlmNotAllowedError('LLM_PROVIDER 와 LLM_MODEL 이 설정되지 않았습니다');
  }
}
