import { loadConfig } from '@cs/domain';
import { databaseLabel, dbCliErrorLine, loadRootEnv, openDb } from '../src/index';

// FULLREV3 남은 위험: DATABASE_URL 을 그대로 찍지 않는다(databaseLabel — postgres URL 의 사용자·비밀번호·query 제거).
// 오류도 다시 던지지 않는다 — Node 가 메시지·스택(파일 오류는 경로 = DATABASE_URL 이 들어감)을 찍기 때문. 종류·코드만(dbCliErrorLine).
loadRootEnv();
const config = loadConfig();
const handle = await openDb(config).catch((e: unknown) => {
  console.error(dbCliErrorLine('DB migration 을 마치지 못했습니다', e));
  process.exit(1);
});
try {
  await handle.close();
} catch (e) {
  console.error(dbCliErrorLine('DB 를 닫지 못했습니다', e));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, action: 'migrate', driver: config.DB_DRIVER, database: databaseLabel(config.DATABASE_URL) }));
