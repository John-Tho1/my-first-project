import { LiveProviderNotConfiguredError, type AppConfig } from '@cs/domain';
import { DisabledCollector, type Collector } from './collector';
import { MockLlmProvider, type LlmProvider } from './llm';
import { DisabledPublisher, type Publisher } from './publisher';

export * from './collector';
export * from './llm';
export * from './publisher';
export * from './storage';

export interface Providers {
  llm: LlmProvider;
  publisher: Publisher;
  collector: Collector;
}

/**
 * 설정으로부터 provider 묶음을 만든다.
 * M0: 모의 LLM + 비활성 publisher + 비활성 collector. live LLM 은 구현이 없으므로 거부한다.
 */
export function createProviders(config: AppConfig): Providers {
  if (config.LLM_MODE === 'live') throw new LiveProviderNotConfiguredError();
  return {
    llm: new MockLlmProvider(),
    publisher: new DisabledPublisher(config),
    collector: new DisabledCollector(config),
  };
}
