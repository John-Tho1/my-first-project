/**
 * `pnpm drill:restore` — T20(결정 D22) 복원 훈련(A18). AUTH_ALLOWED_IDENTITY owner 를 임시 폴더로 내보내고, 버리는 메모리 DB + 빈 임시 저장소에
 * empty_only 로 복원한 뒤 표별 행 수·ID·내용 sha256·파일 checksum·검색을 비교해 표로 찍는다. 불일치가 하나라도 있으면 exit 1.
 * 운영 DB(DATABASE_URL)는 읽기 + restore_drills 한 줄 추가만 한다. dev 서버가 같은 PGlite 폴더를 열고 있으면 잠금 안내와 함께 exit 1 —
 * 서버를 켠 채로는 화면(/ops)의 "복원 훈련 실행"을 쓴다. 외부 호출 없음.
 */
import { loadConfig } from '@cs/domain';
import { createStorage } from '@cs/providers';
import { dbCliErrorLine, findOwner, formatDrillResult, loadRootEnv, openDb, resolveFromRoot, runRestoreDrill } from '../src/index';

loadRootEnv();
const config = loadConfig();
// FULLREV3 후속(DB CLI 출력): 열기 오류를 다시 던지지 않는다 — Node 가 메시지·스택(파일 오류는 경로 = DATABASE_URL)을 찍기 때문. 잠금·드라이버 미구현은 고정 안내, 그 밖은 종류·코드만.
const handle = await openDb(config).catch((e: unknown) => {
  console.error(dbCliErrorLine('DB 를 열지 못했습니다', e));
  process.exit(1);
});
try {
  const owner = await findOwner(handle.db, config.AUTH_ALLOWED_IDENTITY);
  if (!owner) {
    console.error('허용 사용자(AUTH_ALLOWED_IDENTITY)의 데이터가 없습니다. 먼저 pnpm db:seed 또는 로그인으로 사용자를 만드세요.');
    process.exitCode = 1;
  } else {
    const r = await runRestoreDrill(handle.db, createStorage(config, resolveFromRoot), owner.id, { trigger: 'cli' });
    console.log('복원 훈련(임시 내보내기 → 빈 메모리 DB 에 empty_only 복원 → 비교, 외부 호출 없음)\n');
    console.log(formatDrillResult(r));
    if (r.result !== 'pass') process.exitCode = 1;
  }
} catch (e) {
  console.error(dbCliErrorLine('복원 훈련을 마치지 못했습니다', e));
  process.exitCode = 1;
} finally {
  try {
    await handle.close();
  } catch (e) {
    console.error(dbCliErrorLine('DB 를 닫지 못했습니다', e));
    process.exitCode = 1;
  }
}
