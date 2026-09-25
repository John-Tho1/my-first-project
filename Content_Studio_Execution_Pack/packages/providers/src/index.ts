import { LiveProviderNotConfiguredError, type AppConfig } from '@cs/domain';
import { createMockAdapterRegistry, type MockChannelAdapterRegistry } from './channel-adapter';
import { DisabledCollector, type Collector } from './collector';
import { MockLlmProvider, type LlmProvider } from './llm';
import { DisabledPublisher, type Publisher } from './publisher';

export * from './channel-adapter';
export * from './collector';
export * from './llm';
export * from './publisher';
export * from './storage';
export * from './stt';

export interface Providers {
  llm: LlmProvider;
  publisher: Publisher;
  collector: Collector;
  /** T11: 배포 채널 어댑터. M3 은 모의만 — live 계정은 getAdapterFor 가 LiveChannelNotConfiguredError. */
  channelAdapters: MockChannelAdapterRegistry;
}

/**
 * 설정으로부터 provider 묶음을 만든다.
 * M0: 모의 LLM + 비활성 publisher + 비활성 collector. live LLM 은 구현이 없으므로 거부한다.
 * T11: 채널 어댑터는 모의만(프로세스 싱글턴). 실제 채널 어댑터는 없다.
 */
export function createProviders(config: AppConfig): Providers {
  if (config.LLM_MODE === 'live') throw new LiveProviderNotConfiguredError();
  return {
    llm: new MockLlmProvider(),
    publisher: new DisabledPublisher(config),
    collector: new DisabledCollector(config),
    channelAdapters: createMockAdapterRegistry(),
  };
}
