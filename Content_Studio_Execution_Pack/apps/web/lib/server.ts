/** 서버 전용 헬퍼(route handler / server component 에서만 import). */
import { getDb, resolveFromRoot, type DbHandle } from '@cs/db';
import { assertLiveLlmAllowed, loadConfig, type AppConfig } from '@cs/domain';
import { createStorage, LiveLlmProvider, MockLlmProvider, type LlmProvider, type StorageAdapter } from '@cs/providers';

export function getConfig(): AppConfig {
  return loadConfig(process.env);
}

export async function getAppDb(config: AppConfig = getConfig()): Promise<DbHandle> {
  return getDb(config);
}

/** STORAGE_LOCAL_DIR 은 DATABASE_URL 과 같이 워크스페이스 루트 기준으로 해석한다. */
export function getStorage(config: AppConfig = getConfig()): StorageAdapter {
  return createStorage(config, resolveFromRoot);
}

/**
 * T06: 작성 보조용 LLM provider. 기본은 모의(결정 D7).
 * LLM_MODE=live 는 assertLiveLlmAllowed(fail-closed)를 먼저 통과해야 하고, 통과해도 live provider 가 아직 없으므로
 * LiveProviderNotConfiguredError 로 거부한다(T07 에서 승인 후 연결). 외부 호출은 일어나지 않는다.
 * 실패 주입: NODE_ENV=test 이고 LLM_MOCK_FAIL_NEXT=1 일 때만 모의 provider 가 실패한다(운영 빌드에서는 무시).
 */
export function getLlm(config: AppConfig = getConfig()): LlmProvider {
  if (config.LLM_MODE === 'live') {
    assertLiveLlmAllowed(config);
    // T07: live provider 경계. 승인 기록·가격·상한이 모두 있어도 어댑터가 없어 assertReady 가 항상 거부한다(외부 호출 0).
    const live = new LiveLlmProvider(config);
    live.assertReady();
    return live;
  }
  const fail = process.env.NODE_ENV === 'test' && process.env.LLM_MOCK_FAIL_NEXT === '1';
  return new MockLlmProvider({ fail });
}
