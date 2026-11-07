/**
 * Next 서버 시작 훅(프로세스당 한 번). 요청 처리와의 정확한 순서는 확인하지 않았다 — 보장은 route·설정 읽기의 거부다.
 * T21-P1a(G1a): 운영 빌드에서 비밀번호 없는 개발용 로그인(AUTH_MODE=dev 또는 미설정)이면 서버 시작 자체를 거부한다.
 * T21-P2(G3): 그다음(가드를 통과한 경우에만) WORKER_MODE=inline 이고 WORKER_INLINE_INTERVAL_SECONDS > 0 이면 web 안 작업 처리기를 주기 실행한다
 *   (기본 0 = 끔. lib/inline-timer.ts — 겹치지 않음·고정 간격·unref·프로세스당 한 소유자).
 * Node 전용 처리(process.exit·DB)는 nodejs 런타임에서만 동적으로 불러온다(Edge 번들에 넣지 않음).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { refuseDevAuthInProductionAtStartup } = await import('./lib/startup-guard');
  // `process.env.NODE_ENV` 는 빌드가 상수로 고정한다(운영 빌드 = 'production').
  refuseDevAuthInProductionAtStartup({ AUTH_MODE: process.env.AUTH_MODE, NODE_ENV: process.env.NODE_ENV });
  const { startInlineWorkerTimerFromEnv } = await import('./lib/inline-worker-timer');
  startInlineWorkerTimerFromEnv();
}
