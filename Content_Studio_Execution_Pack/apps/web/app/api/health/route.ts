import { getDb } from '@cs/db';
import { loadConfig } from '@cs/domain';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 공개 상태 확인(로그인 없음) — **생존 여부만**. 응답 키는 정확히 { status, app, time_utc, db_ok }.
 * T21-P3(T21_DEPLOY_REVIEW G4): 공개 요청은 부작용이 없다 — worker tick(업로드 만료 정리·전사·배포 작업·연결 정보 갱신·수집)을
 * 실행하지 않는다. 모드·llm/stt 준비 상태(빠진 조건 이름)·버전·DB 드라이버·migrated·worker 정보도 내보내지 않는다.
 * 그 자세한 상태는 로그인한 owner 만 보는 GET /api/health/details 로 옮겼다(읽기 전용, tick 없음).
 * 별도 경로로 둔 이유: 프록시가 `/api/health` 하나만 외부에 열어도 자세한 정보가 새지 않게(경로 단위로 허용 가능).
 * D23(e)·D30-3 의 운영 숫자는 계속 GET /api/ops/summary(로그인, owner 범위).
 * DB 확인은 앱 공용 연결을 여는 것뿐이다(다른 화면 첫 요청과 같은 연결 — 새로 쓰는 행 없음).
 */
export async function GET(): Promise<Response> {
  const base = { app: 'content-studio', time_utc: new Date().toISOString() };
  const headers = { 'cache-control': 'no-store' };

  let config;
  try {
    config = loadConfig(process.env);
  } catch {
    // 설정 오류의 내용(변수 이름·값)은 공개 응답에 넣지 않는다. 서버 로그에도 종류만.
    console.error('[health] config_invalid');
    return Response.json({ status: 'degraded', ...base, db_ok: false }, { status: 503, headers });
  }
  try {
    await getDb(config);
    return Response.json({ status: 'ok', ...base, db_ok: true }, { headers });
  } catch {
    return Response.json({ status: 'degraded', ...base, db_ok: false }, { status: 503, headers });
  }
}
