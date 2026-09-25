import { loadConfig } from '@cs/domain';
import { DbLockedError, loadRootEnv, openDb, seed } from '../src/index';

// migrate + seed. dev 서버(PGlite 연결 보유)가 켜져 있으면 같은 데이터 디렉터리를 열지 못하므로 먼저 종료한다.
loadRootEnv();
const config = loadConfig();
const handle = await openDb(config).catch((e: unknown) => {
  if (e instanceof DbLockedError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
});
try {
  const result = await seed(handle.db, { allowedIdentity: config.AUTH_ALLOWED_IDENTITY });
  console.log(
    JSON.stringify({
      ok: true,
      action: 'seed',
      database: config.DATABASE_URL,
      captures_inserted: result.capturesInserted,
      captures_total: result.capturesTotal,
      mock_accounts_inserted: result.mockAccountsInserted,
    }),
  );
} finally {
  await handle.close();
}
