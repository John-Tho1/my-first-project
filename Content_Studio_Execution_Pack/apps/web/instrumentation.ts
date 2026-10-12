/**
 * Next 서버 시작 훅(요청을 받기 전에 한 번).
 * T21-P1a(G1a): 운영 빌드에서 비밀번호 없는 개발용 로그인(AUTH_MODE=dev 또는 미설정)이면 서버 시작 자체를 거부한다.
 * Node 전용 처리(process.exit)는 nodejs 런타임에서만 동적으로 불러온다(Edge 번들에 넣지 않음).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { refuseDevAuthInProductionAtStartup } = await import('./lib/startup-guard');
  // `process.env.NODE_ENV` 는 빌드가 상수로 고정한다(운영 빌드 = 'production').
  refuseDevAuthInProductionAtStartup({ AUTH_MODE: process.env.AUTH_MODE, NODE_ENV: process.env.NODE_ENV });
}
