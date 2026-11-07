import { loadConfig } from '@cs/domain';
import { databaseLabel, dbCliErrorLine, loadRootEnv, openDb, seed } from '../src/index';

// migrate + seed. dev 서버(PGlite 연결 보유)가 켜져 있으면 같은 데이터 디렉터리를 열지 못하므로 먼저 종료한다.
// FULLREV3 남은 위험: DATABASE_URL·오류 메시지 본문을 그대로 찍지 않는다(databaseLabel, 오류는 dbCliErrorLine — migrate.ts 와 같음).
loadRootEnv();
const config = loadConfig();
const handle = await openDb(config).catch((e: unknown) => {
  console.error(dbCliErrorLine('DB 를 열지 못했습니다', e));
  process.exit(1);
});
try {
  const result = await seed(handle.db, { allowedIdentity: config.AUTH_ALLOWED_IDENTITY });
  console.log(
    JSON.stringify({
      ok: true,
      action: 'seed',
      database: databaseLabel(config.DATABASE_URL),
      captures_inserted: result.capturesInserted,
      captures_total: result.capturesTotal,
      mock_accounts_inserted: result.mockAccountsInserted,
    }),
  );
} catch (e) {
  console.error(dbCliErrorLine('seed 를 마치지 못했습니다', e));
  process.exitCode = 1;
} finally {
  try {
    await handle.close();
  } catch (e) {
    console.error(dbCliErrorLine('DB 를 닫지 못했습니다', e));
    process.exitCode = 1;
  }
}
