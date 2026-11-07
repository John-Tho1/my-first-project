/**
 * `pnpm export`: AUTH_ALLOWED_IDENTITY owner 의 데이터를 EXPORT_LOCAL_DIR 에 묶음(폴더 + ZIP)으로 만든다.
 * dev 서버가 같은 PGlite 디렉터리를 열고 있으면 먼저 종료한다. 출력: JSON 한 줄(경로는 워크스페이스 루트 기준).
 */
import { loadConfig } from '@cs/domain';
import { createStorage } from '@cs/providers';
import { dbCliErrorLine, displayPath, exportOwner, findOwner, loadRootEnv, openDb, resolveFromRoot } from '../src/index';

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
    const r = await exportOwner(handle.db, createStorage(config, resolveFromRoot), owner.id, {
      outDir: resolveFromRoot(config.EXPORT_LOCAL_DIR),
    });
    console.log(
      JSON.stringify({
        ok: true,
        action: 'export',
        export_id: r.exportId,
        zip: displayPath(r.zipPath),
        dir: displayPath(r.dirPath),
        zip_bytes: r.zipBytes,
        manifest_sha256: r.manifestSha256,
        totals: r.manifest.totals,
        tables: r.manifest.tables,
        warnings: r.warnings,
      }),
    );
  }
} catch (e) {
  console.error(dbCliErrorLine('내보내기를 마치지 못했습니다', e));
  process.exitCode = 1;
} finally {
  try {
    await handle.close();
  } catch (e) {
    console.error(dbCliErrorLine('DB 를 닫지 못했습니다', e));
    process.exitCode = 1;
  }
}
