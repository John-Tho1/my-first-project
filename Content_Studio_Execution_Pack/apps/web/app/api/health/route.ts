import { getDb } from '@cs/db';
import { DISPLAY_TIMEZONE, formatMsk, getModes, liveLlmReadiness, loadConfig, sttLiveReadiness } from '@cs/domain';
import { getLastTick } from '@cs/worker';
import { runInlineWorker } from '../../../lib/stt';
import pkg from '../../../package.json';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 공개 상태 확인 — 생존·준비 상태만. 모드와 DB 상태만 반환하고 환경변수 값(경로·식별자·키)은 노출하지 않는다.
 * WORKER_MODE=inline 이면 요청마다 worker tick 을 1회 실행해 last_tick_utc 를 갱신한다(T08: 업로드 만료 정리 + 모의 전사 한 단계,
 * T11: 배포 작업 최대 5개 — 모의 어댑터).
 * T07/T08: llm·stt 는 모드·live 준비 여부·빠진 조건 이름만(값 없음).
 * D23(e)·D30-3: 운영 숫자(백업 나이·확인 필요 계획·반복 실패·삭제 대기·폴더 바이트, 배포 작업 상태별 수, 업로드 임시 영역 사용량, 소재 수)는
 * 공개 응답에 없다 — 로그인이 필요한 GET /api/ops/summary(owner 범위)로 옮겼다.
 */
export async function GET(): Promise<Response> {
  const now = new Date();
  const base = {
    app: 'content-studio',
    version: pkg.version,
    time_utc: now.toISOString(),
    time_msk: formatMsk(now),
    timezone: DISPLAY_TIMEZONE,
  };

  let config;
  try {
    config = loadConfig(process.env);
  } catch {
    return Response.json({ ...base, status: 'error', error: 'config_invalid' }, { status: 500 });
  }

  const modes = getModes(config);
  // T07: live AI 준비 상태 — 빠진 조건 이름만(값 없음). T07 에는 어댑터가 없어 항상 false.
  const live = liveLlmReadiness(config);
  const llm = { mode: config.LLM_MODE, live_ready: live.ready, missing: live.missing };
  const sttLive = sttLiveReadiness(config);
  const stt = { mode: config.STT_MODE, live_ready: sttLive.ready, missing: sttLive.missing };
  try {
    const handle = await getDb(config);
    await runInlineWorker(config, handle.db);
    const last = getLastTick();
    return Response.json(
      {
        status: 'ok',
        ...base,
        modes,
        llm,
        stt,
        db: { driver: handle.driver, ok: true, migrated: handle.migrated },
        worker: { mode: config.WORKER_MODE, last_tick_utc: last?.ranAt ?? null },
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    return Response.json(
      {
        status: 'degraded',
        ...base,
        modes,
        llm,
        stt,
        db: { driver: config.DB_DRIVER, ok: false, migrated: false },
        worker: { mode: config.WORKER_MODE, last_tick_utc: getLastTick()?.ranAt ?? null },
      },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
