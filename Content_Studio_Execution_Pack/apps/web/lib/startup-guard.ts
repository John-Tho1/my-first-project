/**
 * T21-P1a(G1a): 서버 시작 때의 설정 거부(instrumentation.ts 에서만 부른다, nodejs 런타임 전용).
 * 운영 빌드 + dev 로그인 설정이면 한국어 안내(설정 이름만, 값 없음)를 남기고 종료 코드 1 로 끝낸다 — 요청을 하나도 받지 않는다.
 * 시작 훅을 거치지 않는 경로가 있더라도 getConfig(loadConfig)·로그인 route 가 같은 판정으로 다시 거부한다.
 */
import { DEV_AUTH_REFUSED_CONFIG_MESSAGE, devAuthRefusedByRuntime } from '@cs/domain';

export function refuseDevAuthInProductionAtStartup(
  env: { AUTH_MODE: string | undefined; NODE_ENV: string | undefined },
  exit: (code: number) => never = (code) => process.exit(code),
): void {
  if (!devAuthRefusedByRuntime(env)) return;
  console.error(`[startup] 서버를 시작하지 않습니다.\n${DEV_AUTH_REFUSED_CONFIG_MESSAGE}`);
  exit(1);
}
