/**
 * DB 연결 계층.
 *
 * PGlite 제약: 한 데이터 디렉터리는 한 프로세스·한 연결만 열 수 있다.
 * PGlite 자체는 이를 막지 않으므로 lock.ts 의 PID 잠금 파일로 강제한다(두 번째 프로세스는 DbLockedError).
 * 따라서 web 과 worker 가 같은 DATABASE_URL 디렉터리를 동시에 열면 안 된다.
 * M0–M2 는 worker 를 web 프로세스 안에서 inline 실행(WORKER_MODE=inline)하고,
 * `pnpm db:seed` / `pnpm worker` 같은 CLI 는 dev 서버를 끈 상태에서 실행한다.
 * M3 의 동시성 검증은 DB_DRIVER=postgres(미구현)로 전환해 수행한다.
 */
import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate as pgliteMigrate } from 'drizzle-orm/pglite/migrator';
import type { AppConfig } from '@cs/domain';
import { acquireDirLock } from './lock';
import { resolveFromRoot } from './paths';
import * as schema from './schema';

export type Db = PgliteDatabase<typeof schema>;

export interface DbHandle {
  driver: 'pglite';
  db: Db;
  client: PGlite;
  migrated: boolean;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  driver: AppConfig['DB_DRIVER'];
  url: string;
}

export class DbDriverNotImplementedError extends Error {
  constructor() {
    super('DB_DRIVER=postgres 는 아직 구현되지 않았습니다(M3에서 추가). 현재는 pglite 만 지원합니다.');
    this.name = 'DbDriverNotImplementedError';
  }
}

/** 커밋된 SQL migration 폴더(packages/db/drizzle). */
export function migrationsFolder(): string {
  return resolveFromRoot('packages/db/drizzle');
}

export function createDb(opts: CreateDbOptions): DbHandle {
  if (opts.driver !== 'pglite') throw new DbDriverNotImplementedError();
  let client: PGlite;
  let release = () => {};
  // T04: 검색 색인용 pg_trgm(0003 migration 의 CREATE EXTENSION)을 메모리·파일 DB 모두에 등록한다.
  const extensions = { pg_trgm };
  if (opts.url === 'memory://') {
    client = new PGlite({ extensions });
  } else {
    const dir = resolveFromRoot(opts.url);
    mkdirSync(/*turbopackIgnore: true*/ dir, { recursive: true });
    release = acquireDirLock(dir);
    try {
      client = new PGlite(dir, { extensions });
    } catch (e) {
      release();
      throw e;
    }
  }
  const db = drizzle({ client, schema });
  return {
    driver: 'pglite',
    db,
    client,
    migrated: false,
    close: async () => {
      try {
        await client.close();
      } finally {
        release();
      }
    },
  };
}

export async function migrate(handle: DbHandle): Promise<void> {
  await pgliteMigrate(handle.db, { migrationsFolder: migrationsFolder() });
  handle.migrated = true;
}

export async function openDb(config: Pick<AppConfig, 'DB_DRIVER' | 'DATABASE_URL'>): Promise<DbHandle> {
  const handle = createDb({ driver: config.DB_DRIVER, url: config.DATABASE_URL });
  try {
    await migrate(handle);
  } catch (e) {
    await handle.close().catch(() => undefined);
    throw e;
  }
  return handle;
}

/** 테스트용: 메모리 PGlite + migration 적용. */
export function createTestDb(): Promise<DbHandle> {
  return openDb({ DB_DRIVER: 'pglite', DATABASE_URL: 'memory://' });
}

const globalForDb = globalThis as typeof globalThis & {
  __contentStudioDb?: { key: string; promise: Promise<DbHandle> };
};

/**
 * web 앱용 싱글턴. Next dev 의 hot reload 에서도 globalThis 캐시로 연결을 하나만 유지한다.
 * 첫 호출에서 migration 을 자동 적용하므로 `pnpm dev` 는 `db:seed` 없이도 동작한다.
 */
export function getDb(config: Pick<AppConfig, 'DB_DRIVER' | 'DATABASE_URL'>): Promise<DbHandle> {
  const key = `${config.DB_DRIVER}:${config.DATABASE_URL}`;
  const cached = globalForDb.__contentStudioDb;
  if (cached && cached.key === key) return cached.promise;
  const promise = openDb(config);
  globalForDb.__contentStudioDb = { key, promise };
  promise.catch(() => {
    if (globalForDb.__contentStudioDb?.promise === promise) globalForDb.__contentStudioDb = undefined;
  });
  return promise;
}

/** getDb 싱글턴을 닫고 캐시를 비운다(테스트 정리·프로세스 종료용). 열려 있지 않으면 아무것도 하지 않는다. */
export async function closeDb(): Promise<void> {
  const cached = globalForDb.__contentStudioDb;
  if (!cached) return;
  globalForDb.__contentStudioDb = undefined;
  const handle = await cached.promise.catch(() => null);
  await handle?.close();
}
