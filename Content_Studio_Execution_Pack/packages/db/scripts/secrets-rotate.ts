/**
 * `pnpm secrets:rotate [--confirm]` — T13 FIX(결정 D25-5) 키 교체. 기본은 미리보기(숫자만, 변경 없음), --confirm 일 때만 다시 봉인한다.
 * 키는 환경변수(.env.local)의 SECRETS_MASTER_KEY·SECRETS_KEY_VERSION(+ 교체 기간의 *_PREVIOUS)에서 읽는다. 키·암호문·토큰은 출력하지 않는다.
 * 모든 봉인을 열어 현재 버전 행의 손상·버전 불일치도 센다(열 수 없는 행은 그대로 둔다 — 그 계정은 다시 연결 필요).
 * 파일 DB(DATABASE_URL)를 연다 — dev 서버가 같은 PGlite 폴더를 열고 있으면 잠금 안내와 함께 exit 1. 외부 호출 없음.
 */
import { loadConfig, readSecretKeyring } from '@cs/domain';
import { DbLockedError, formatRotationReport, loadRootEnv, openDb, rotateSecretKeys } from '../src/index';

loadRootEnv();
const confirm = process.argv.slice(2).includes('--confirm');
const ring = readSecretKeyring(process.env);
if (!ring.ok) {
  console.error(`서버 비밀 암호화 키가 설정되지 않았습니다: ${ring.problems.join(', ')}`);
  process.exit(1);
}
const config = loadConfig();
const handle = await openDb(config).catch((e: unknown) => {
  if (e instanceof DbLockedError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
});
try {
  const r = await rotateSecretKeys(handle.db, ring.keyring, { dryRun: !confirm });
  console.log('키 교체(외부 호출 없음)\n');
  console.log(formatRotationReport(r));
  const failed = [r.credentials, r.states].some((c) => Object.keys(c.failed).length > 0);
  if (failed) process.exitCode = 1;
} finally {
  await handle.close();
}
