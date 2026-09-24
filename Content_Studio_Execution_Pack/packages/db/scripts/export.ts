/**
 * `pnpm export`: AUTH_ALLOWED_IDENTITY owner 의 데이터를 EXPORT_LOCAL_DIR 에 묶음(폴더 + ZIP)으로 만든다.
 * dev 서버가 같은 PGlite 디렉터리를 열고 있으면 먼저 종료한다. 출력: JSON 한 줄(경로는 워크스페이스 루트 기준).
 */
import { loadConfig } from '@cs/domain';
import { createStorage } from '@cs/providers';
import { DbLockedError, displayPath, exportOwner, findOwner, loadRootEnv, openDb, resolveFromRoot } from '../src/index';

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
} finally {
  await handle.close();
}
