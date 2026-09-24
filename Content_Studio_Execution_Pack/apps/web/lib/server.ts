/** 서버 전용 헬퍼(route handler / server component 에서만 import). */
import { getDb, type DbHandle } from '@cs/db';
import { loadConfig, type AppConfig } from '@cs/domain';

export function getConfig(): AppConfig {
  return loadConfig(process.env);
}

export async function getAppDb(config: AppConfig = getConfig()): Promise<DbHandle> {
  return getDb(config);
}
