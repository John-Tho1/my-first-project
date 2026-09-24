/** `pnpm worker`: tick 1회 실행 후 종료. dev 서버가 같은 PGlite 디렉터리를 열고 있으면 먼저 종료한다. */
import { DbLockedError, loadRootEnv, openDb } from '@cs/db';
import { loadConfig } from '@cs/domain';
import { assertWorkerModeSupported, runWorkerTick, WorkerModeError } from './index';

loadRootEnv();
const config = loadConfig();
try {
  assertWorkerModeSupported(config);
} catch (e) {
  if (e instanceof WorkerModeError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
const handle = await openDb(config).catch((e: unknown) => {
  if (e instanceof DbLockedError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
});
try {
  const tick = await runWorkerTick({ config, db: handle.db });
  console.log(JSON.stringify(tick));
} finally {
  await handle.close();
}
