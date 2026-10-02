/**
 * `pnpm worker`: tick 1회(업로드 만료 정리 + 배포 작업 — 모의 채널 어댑터, 외부 호출 없음) 후 종료.
 * `pnpm worker -- --loop 5000`: 5초마다 tick(로컬 시연용). Ctrl-C(SIGINT)·SIGTERM 이면 진행 중 tick 을 마치고 DB 를 닫은 뒤 끝난다.
 * dev 서버가 같은 PGlite 디렉터리를 열고 있으면 먼저 종료한다(한 디렉터리 한 프로세스).
 * 모의 어댑터는 @cs/providers 에서 가져온다(apps/worker/package.json 에 workspace 의존성으로 선언 — CLI 진입점만 쓰고, runWorkerTick 은 레지스트리를 주입받는다).
 */
import { checkCredential, DbLockedError, loadRootEnv, newWorkerId, openDb } from '@cs/db';
import { loadConfig, oauthRedirectUri, requireSecretKeyring } from '@cs/domain';
import { createMockAdapterRegistry, resolveOAuthProvider } from '@cs/providers';
import { assertWorkerModeSupported, runWorkerTick, WorkerModeError } from './index';

function parseLoop(argv: readonly string[]): number | null {
  const i = argv.indexOf('--loop');
  if (i < 0) return null;
  const ms = Number(argv[i + 1] ?? 5000);
  if (!Number.isInteger(ms) || ms < 1000 || ms > 3_600_000) {
    console.error('--loop 값은 1000~3600000(ms) 정수여야 합니다');
    process.exit(2);
  }
  return ms;
}

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
const loopMs = parseLoop(process.argv.slice(2));
const handle = await openDb(config).catch((e: unknown) => {
  if (e instanceof DbLockedError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
});
const workerId = newWorkerId('cli');
const channelAdapters = createMockAdapterRegistry();
// T14(D26): Threads 모의 어댑터의 전송 토큰(서버 안 봉인 해제)과 401 뒤 T13 확인 경로. 키는 환경변수에서만(값 출력 없음).
const keyring = () => requireSecretKeyring(process.env);
const redirectUri = oauthRedirectUri(config);
const jobCredentials = {
  keyring,
  check: (ownerId: string, accountId: string, now: Date) =>
    checkCredential(handle.db, { ownerId, accountId, providerFor: (acc) => resolveOAuthProvider(acc, config, process.env, redirectUri), keyring, now }),
};
let stopping = false;
let wake: (() => void) | null = null;
const stop = () => {
  stopping = true;
  wake?.();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
try {
  do {
    const tick = await runWorkerTick({ config, db: handle.db, channelAdapters, workerId, maxJobs: 20, jobCredentials });
    console.log(JSON.stringify(tick));
    if (loopMs === null || stopping) break;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, loopMs);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
    wake = null;
  } while (!stopping);
} finally {
  await handle.close();
}
