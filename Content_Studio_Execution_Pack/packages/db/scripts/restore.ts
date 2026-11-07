/**
 * `pnpm restore:preview <zip>` / `pnpm restore:commit <zip> --mode empty_only|add_missing --confirm`
 * 대상 owner = AUTH_ALLOWED_IDENTITY(없으면 만든다). commit 은 --confirm 없이는 거부한다.
 * commit 도 먼저 미리보기(restore_runs)를 만들고, 그 파일을 다시 읽어 검증한 뒤 한 트랜잭션으로 복원한다.
 * dev 서버가 같은 PGlite 디렉터리를 열고 있으면 먼저 종료한다.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError, loadConfig } from '@cs/domain';
import { createStorage } from '@cs/providers';
import {
  commitRestore,
  createRestorePreview,
  dbCliErrorLine,
  ensureOwner,
  loadRootEnv,
  openDb,
  RESTORE_MODES,
  resolveFromRoot,
  type RestoreMode,
} from '../src/index';

const [action, file, ...rest] = process.argv.slice(2);
const usage =
  '사용법: pnpm restore:preview <zip>  |  pnpm restore:commit <zip> --mode empty_only|add_missing --confirm';
if ((action !== 'preview' && action !== 'commit') || !file) {
  console.error(usage);
  process.exit(2);
}
let mode: RestoreMode = 'empty_only';
let confirm = false;
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '--confirm') confirm = true;
  else if (a === '--mode') mode = rest[++i] as RestoreMode;
  else if (a?.startsWith('--mode=')) mode = a.slice('--mode='.length) as RestoreMode;
  else {
    console.error(`알 수 없는 인자: ${a}\n${usage}`);
    process.exit(2);
  }
}
if (action === 'commit') {
  if (!RESTORE_MODES.includes(mode)) {
    console.error(`--mode 는 empty_only 또는 add_missing 입니다\n${usage}`);
    process.exit(2);
  }
  if (!confirm) {
    console.error('복원(commit)은 --confirm 이 있어야 실행합니다. 먼저 pnpm restore:preview 로 결과를 확인하세요.');
    process.exit(2);
  }
}

loadRootEnv();
const config = loadConfig();
// 인자 경로는 호출한 위치(pnpm 은 루트) 기준. 상대 경로는 워크스페이스 루트 기준으로 해석한다.
const zipPath = resolveFromRoot(file);
let zip: Uint8Array;
try {
  zip = new Uint8Array(await readFile(zipPath));
} catch {
  console.error(`파일을 읽을 수 없습니다: ${path.basename(zipPath)}`);
  process.exit(1);
}

// FULLREV3 후속(DB CLI 출력): 열기 오류를 다시 던지지 않는다 — Node 가 메시지·스택(파일 오류는 경로 = DATABASE_URL)을 찍기 때문. 잠금·드라이버 미구현은 고정 안내, 그 밖은 종류·코드만.
const handle = await openDb(config).catch((e: unknown) => {
  console.error(dbCliErrorLine('DB 를 열지 못했습니다', e));
  process.exit(1);
});
try {
  const owner = await ensureOwner(handle.db, config.AUTH_ALLOWED_IDENTITY);
  const restoresDir = resolveFromRoot(config.RESTORE_LOCAL_DIR);
  const { restoreId, preview } = await createRestorePreview(handle.db, owner.id, zip, { restoresDir, source: 'upload', budgetCurrency: config.LLM_BUDGET_CURRENCY });
  if (action === 'preview') {
    console.log(JSON.stringify({ ok: true, action: 'restore.preview', restore_id: restoreId, preview }));
  } else {
    const result = await commitRestore(handle.db, createStorage(config, resolveFromRoot), owner.id, restoreId, {
      mode,
      confirm: true,
      restoresDir,
    });
    console.log(JSON.stringify({ ok: true, action: 'restore.commit', ...result }));
  }
} catch (e) {
  if (e instanceof AppError) {
    console.error(JSON.stringify({ ok: false, error: e.code, message: e.message, ...(e.extra ?? {}) }));
    process.exitCode = 1;
  } else {
    console.error(dbCliErrorLine('복원을 마치지 못했습니다', e));
    process.exitCode = 1;
  }
} finally {
  try {
    await handle.close();
  } catch (e) {
    console.error(dbCliErrorLine('DB 를 닫지 못했습니다', e));
    process.exitCode = 1;
  }
}
