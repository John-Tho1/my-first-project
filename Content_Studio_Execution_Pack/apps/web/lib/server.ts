/** 서버 전용 헬퍼(route handler / server component 에서만 import). */
import { getDb, resolveFromRoot, uploadStoreFor, type DbHandle, type UploadStore } from '@cs/db';
import { assertLiveLlmAllowed, loadConfig, type AppConfig } from '@cs/domain';
import {
  createChannelAdapterRegistry,
  createStorage,
  LiveTranscriber,
  MockLlmProvider,
  MockTranscriber,
  resolveLiveLlmProvider,
  type LlmProvider,
  type LiveCapableAdapterRegistry,
  type StorageAdapter,
  type Transcriber,
} from '@cs/providers';

/**
 * T21-P1a(G1a): NODE_ENV 는 `process.env.NODE_ENV` 식으로 따로 넘긴다 — Next 빌드가 이 식을 상수로 고정하므로
 * 운영 빌드(`next start`)는 실행할 때 NODE_ENV 를 다른 값으로 줘도 production 으로 판정된다(dev 로그인 설정이면 loadConfig 가 거부).
 */
export function getConfig(): AppConfig {
  return loadConfig({ ...process.env, NODE_ENV: process.env.NODE_ENV });
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
 * LLM_MODE=live 는 assertLiveLlmAllowed(fail-closed)를 먼저 통과해야 하고, LIVE-L1(D34): 그다음 화면과 같은 준비 판정(liveLlmReadiness —
 * 공급자 anthropic·모델·가격·월 상한·승인 기록·서버 환경의 ANTHROPIC_API_KEY)이 모두 갖춰졌을 때만 실제 Claude provider 를 돌려준다.
 * 아니면 LiveProviderNotConfiguredError(503, 빠진 이름만). 키는 이 시점에 process.env 에서 읽는다(서버 전용, 값은 어디에도 내보내지 않음).
 * 실패 주입: NODE_ENV=test 이고 LLM_MOCK_FAIL_NEXT=1 일 때만 모의 provider 가 실패한다(운영 빌드에서는 무시).
 */
export function getLlm(config: AppConfig = getConfig()): LlmProvider {
  if (config.LLM_MODE === 'live') {
    assertLiveLlmAllowed(config);
    return resolveLiveLlmProvider(config, process.env);
  }
  const fail = process.env.NODE_ENV === 'test' && process.env.LLM_MOCK_FAIL_NEXT === '1';
  return new MockLlmProvider({ fail });
}

/** T08: 업로드 조각 저장소(STORAGE_LOCAL_DIR/uploads). */
export function getUploadStore(config: AppConfig = getConfig()): UploadStore {
  return uploadStoreFor(config);
}

/**
 * T08: 전사 요청 전 확인. STT_MODE=live 는 승인 기록·공급자·모델·가격이 있어도 어댑터가 없어 항상 거부(503, 기록 없음).
 */
export function assertTranscriptionAllowed(config: AppConfig = getConfig()): void {
  if (config.STT_MODE === 'live') new LiveTranscriber(config).assertReady();
}

/**
 * T08: inline worker 가 쓰는 전사기 — 항상 모의(provider='mock' job 만 처리). 외부 호출 없음.
 * 실패 주입: NODE_ENV=test 이고 STT_MOCK_FAIL_NEXT=1 일 때만(운영 빌드에서는 무시).
 */
export function getWorkerTranscriber(): Transcriber {
  const fail = process.env.NODE_ENV === 'test' && process.env.STT_MOCK_FAIL_NEXT === '1';
  return new MockTranscriber({ fail });
}

/**
 * T11: 배포 채널 어댑터 — 모의 어댑터(프로세스 싱글턴, web 과 inline worker 가 같은 모의 "원격"을 공유).
 * 모의 결과 시나리오는 개발·테스트에서만 MOCK_CHANNEL_SCENARIO 로 바꿀 수 있다(운영 빌드에서는 무시).
 * LIVE-P1(D38 1단계): + 실제 Threads 텍스트 게시 어댑터. 실제 계정 + 실제 게시 환경 조건(PUBLISH_MODE=enabled·PUBLISH_LIVE_APPROVAL_REF·
 * PUBLISH_LIVE_MAX_POSTS)이 모두 있을 때만 선택된다(@cs/providers LiveCapableAdapterRegistry). 기본 설정에서는 실제 호출 경로가 열리지 않는다.
 */
export function getChannelAdapters(config: AppConfig = getConfig()): LiveCapableAdapterRegistry {
  return createChannelAdapterRegistry(config);
}
