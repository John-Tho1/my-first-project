/**
 * T21-P1a(G1a): 서버 시작 때의 설정 거부(instrumentation.ts 에서만 부른다, nodejs 런타임 전용).
 * 운영 빌드 + dev 로그인 설정이면 한국어 안내(설정 이름만, 값 없음)를 남기고 종료 코드 1 로 끝낸다. Next 는 "Ready" 를 먼저 출력하므로 종료 직전 요청이 처리되지 않는다고는 단정하지 않는다(미확인).
 * 보장은 getConfig(loadConfig)·로그인 route 의 같은 판정이다(시작 훅 실행 여부·순서와 무관하게 거부).
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
