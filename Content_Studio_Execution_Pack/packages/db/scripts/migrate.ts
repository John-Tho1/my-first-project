import { loadConfig } from '@cs/domain';
import { DbLockedError, loadRootEnv, openDb } from '../src/index';

loadRootEnv();
const config = loadConfig();
const handle = await openDb(config).catch((e: unknown) => {
  if (e instanceof DbLockedError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
});
await handle.close();
console.log(JSON.stringify({ ok: true, action: 'migrate', driver: config.DB_DRIVER, database: config.DATABASE_URL }));
