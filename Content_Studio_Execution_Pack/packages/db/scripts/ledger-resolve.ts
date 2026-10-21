/**
 * `pnpm ledger:resolve` — FIX4-LIVEL1H2 provider_unstorable 수동 해결(인계 LIVEL1 절차 2·4~6). 손으로 쓴 SQL 대신 이 명령을 쓴다.
 * `--list [--owner <id>]`(읽기 전용) · `--owner … --ledger … --source provider|none --actual … --settled … --by … --reason … [--correct] [--confirm]`
 * (기본 미리보기 — 아무것도 바꾸지 않음, --confirm 일 때만 한 트랜잭션으로 적용 + 감사 기록).
 * 파일 DB(DATABASE_URL)를 연다 — dev 서버가 같은 PGlite 폴더를 열고 있으면 잠금 안내와 함께 exit 1. 종료 코드 0/1/2.
 * 본체: packages/db/src/ledger-resolve-cli.ts(runLedgerResolveCli). 외부 호출 없음.
 */
import { loadRootEnv, openDb, runLedgerResolveCli } from '../src/index';

loadRootEnv();
process.exitCode = await runLedgerResolveCli({
  argv: process.argv.slice(2),
  env: process.env,
  openDb,
  out: (l) => console.log(l),
  err: (l) => console.error(l),
});
