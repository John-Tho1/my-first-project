/** 서버 전용 헬퍼(route handler / server component 에서만 import). */
import { getDb, resolveFromRoot, type DbHandle } from '@cs/db';
import { loadConfig, type AppConfig } from '@cs/domain';
import { createStorage, type StorageAdapter } from '@cs/providers';

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
