/**
 * `pnpm worker`: tick 1회(업로드 만료 정리 + 배포 작업 — 모의 채널 어댑터, 외부 호출 없음) 후 종료.
 * `pnpm worker -- --loop 5000`: 5초마다 tick(로컬 시연용). Ctrl-C(SIGINT)·SIGTERM 이면 진행 중 tick 을 마치고 DB 를 닫은 뒤 끝난다.
 * dev 서버가 같은 PGlite 디렉터리를 열고 있으면 먼저 종료한다(한 디렉터리 한 프로세스).
 * 모의 어댑터는 @cs/providers 에서 가져온다(apps/worker/package.json 에 workspace 의존성으로 선언 — CLI 진입점만 쓰고, runWorkerTick 은 레지스트리를 주입받는다).
 */
import { checkCredential, DbLockedError, loadMockCredentialsForRehydration, loadRootEnv, newWorkerId, openDb, refreshCredential, resolveFromRoot } from '@cs/db';
import { loadConfig, oauthRedirectUri, readSecretKeyring, requireSecretKeyring } from '@cs/domain';
import { createCollectorAdapter, createMockAdapterRegistry, createStorage, ensureMockOAuthRehydrated, mockCredentialWorkAllowed, resolveOAuthProvider } from '@cs/providers';
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
const providerFor = (acc: Parameters<typeof resolveOAuthProvider>[0]) => resolveOAuthProvider(acc, config, process.env, redirectUri);
const jobCredentials = {
  keyring,
  check: (ownerId: string, accountId: string, now: Date) => checkCredential(handle.db, { ownerId, accountId, providerFor, keyring, now }),
  // T15(D27): 짧은 access token(Google 형 모의)은 보내기 전에 T13 갱신 경로로 한 번 갱신
  refresh: (ownerId: string, accountId: string, now: Date) => refreshCredential(handle.db, { ownerId, accountId, providerFor, keyring, now, trigger: 'auto' }),
};
// T15(D27): YouTube 모의 업로드가 VERIFIED 영상 파일을 조각으로 읽는 로컬 저장소
const media = createStorage(config, resolveFromRoot);
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
    // M4-DEV1: 이 프로세스의 첫 tick 이면 DB 의 모의 연결 정보로 모의 공급자 메모리를 다시 채운다(프로세스당 한 번, OAUTH_MODE=mock·키 있음만).
    // 토큰은 모의 공급자 메모리로만 — 출력은 tick JSON 그대로(토큰·개수 없음).
    // FIX1-M4DEV1(Codex review-M4DEV1 P1): 다시 채우기가 실패하면 이번 tick 은 배포 작업(연결 정보 사용)을 건너뛴다 — 상태를 바꾸지 않고 다음 tick 이 다시 읽는다.
    const ring = readSecretKeyring(process.env);
    const rehydrated = ring.ok
      ? await ensureMockOAuthRehydrated({ oauthMode: config.OAUTH_MODE, load: () => loadMockCredentialsForRehydration(handle.db, { keyring: ring.keyring }) })
      : null;
    const credWork = mockCredentialWorkAllowed(rehydrated);
    const tick = await runWorkerTick({ config, db: handle.db, channelAdapters: credWork ? channelAdapters : undefined, workerId, maxJobs: 20, jobCredentials, media, collector: createCollectorAdapter(config) });
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
