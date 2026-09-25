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
  LiveChannelNotConfiguredError,
  LiveLlmNotAllowedError,
  PublishDisabledError,
} from './errors';

/** 게시 의도(외부 게시 경로). approvalId·payloadHash 는 입력일 뿐 승인으로 인정하지 않는다. */
export interface PublishIntent {
  platform: string;
  payloadHash?: string;
  approvalId?: string;
}

/**
 * 서버가 DB 에서 읽은 활성 승인(T10). 클라이언트·LLM 입력으로 만들지 않는다 — distribution.ts 가 approvals 행에서만 만든다.
 */
export interface ServerApproval {
  id: string;
  payloadHash: string;
  revokedAt: Date | null;
}

export interface ExecutionContext {
  accountKind: 'mock' | 'live';
  /** 실행할 항목의 저장된 payload hash */
  payloadHash: string;
  approval: ServerApproval | null;
}

/**
 * T10(결정 D17): 배포 실행 허용 여부.
 * - mock 계정: PUBLISH_MODE 와 무관하게 `{ mode: 'MOCK' }` — 모의 실행은 프로세스 밖으로 나가지 않고 결과는 반드시 MOCK 이다.
 * - live 계정: PUBLISH_MODE=enabled 가 아니면 PublishDisabledError, 서버가 읽은 활성 승인(hash 일치)이 없으면 ApprovalRequiredError,
 *   둘 다 있어도 M3 에는 live 채널 어댑터가 없으므로 LiveChannelNotConfiguredError(503).
 */
export function assertExecutionAllowed(config: AppConfig, ctx: ExecutionContext): { mode: 'MOCK' } {
  if (ctx.accountKind === 'mock') return { mode: 'MOCK' };
  if (config.PUBLISH_MODE !== 'enabled') throw new PublishDisabledError();
  const a = ctx.approval;
  if (!a || a.revokedAt !== null || a.payloadHash !== ctx.payloadHash) throw new ApprovalRequiredError();
  throw new LiveChannelNotConfiguredError();
}

/**
 * 외부 게시(Publisher) 경로의 가드. 서버 승인 객체를 받지 않으므로 live 로 보고 항상 거부한다
 * (기본: PublishDisabledError, PUBLISH_MODE=enabled: ApprovalRequiredError). intent 의 approvalId 는 신뢰하지 않는다.
 */
export function assertPublishAllowed(config: AppConfig, intent: PublishIntent): never {
  assertExecutionAllowed(config, { accountKind: 'live', payloadHash: intent.payloadHash ?? '', approval: null });
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
