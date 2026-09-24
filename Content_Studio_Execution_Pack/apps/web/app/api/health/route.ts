import { countCaptures, getDb } from '@cs/db';
import { DISPLAY_TIMEZONE, formatMsk, getModes, liveLlmReadiness, loadConfig } from '@cs/domain';
import { getLastTick, runWorkerTick } from '@cs/worker';
import pkg from '../../../package.json';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * 상태 확인. 모드와 DB 상태만 반환하고 환경변수 값(경로·식별자·키)은 노출하지 않는다.
 * WORKER_MODE=inline 이면 요청마다 worker tick 을 1회 실행해 last_tick_utc 를 갱신한다(M0: DB 확인만).
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
  try {
    const handle = await getDb(config);
    const captures = await countCaptures(handle.db);
    if (config.WORKER_MODE === 'inline') await runWorkerTick({ config, db: handle.db });
    const last = getLastTick();
    return Response.json(
      {
        status: 'ok',
        ...base,
        modes,
        llm,
        db: { driver: handle.driver, ok: true, migrated: handle.migrated, captures },
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
        db: { driver: config.DB_DRIVER, ok: false, migrated: false, captures: null },
        worker: { mode: config.WORKER_MODE, last_tick_utc: getLastTick()?.ranAt ?? null },
      },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
