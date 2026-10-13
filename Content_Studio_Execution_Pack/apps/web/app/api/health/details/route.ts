import { DISPLAY_TIMEZONE, formatMsk, getModes, liveLlmReadiness, sttLiveReadiness } from '@cs/domain';
import { getLastTick } from '@cs/worker';
import { apiHandler, json } from '../../../../lib/api';
import { getAppDb } from '../../../../lib/server';
import { oidcReadinessView } from '../../../../lib/oidc';
import { requireOwner } from '../../../../lib/session';
import pkg from '../../../../package.json';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/health/details — 자세한 상태(로그인한 owner 만, 세션 없음·만료·폐기 → 401). T21-P3(G4): 공개 /api/health 에서 옮겼다.
 * { status:'ok', app, version, time_utc, time_msk, timezone, modes, llm{mode,live_ready,missing}, stt{mode,live_ready,missing},
 *   db{driver, ok, migrated}, worker{mode, last_tick_utc} }
 * - 읽기 전용: worker tick 을 실행하지 않는다(GET 은 상태를 바꾸지 않음). last_tick_utc 는 이 프로세스에서 마지막으로 돈 tick 시각(없으면 null).
 *   inline 모드의 처리는 POST /api/worker/tick(로그인·같은 출처, 화면 "작업 처리 실행")·GET /api/transcription-jobs(로그인, 진행률 조회)에서만 돈다.
 * - T07/T08·LIVE-L1(D34): llm·stt 는 모드·준비 여부·빠진 조건 **이름**만(값·키·승인 기록 참조 없음). 환경변수 값(경로·식별자)은 넣지 않는다.
 * - T21-P1b: auth 는 로그인 방식·OIDC 준비 여부·빠진 설정 **이름**만(IdP URL·클라이언트 ID·시크릿·허용 계정 값 없음).
 * - 운영 숫자(D23(e)·D30-3)는 여기에도 없다 — GET /api/ops/summary.
 * - 세션 검증에 DB 가 필요하므로 DB 를 열 수 없으면 이 경로는 500(일반 문구)이고, 생존 여부는 공개 /api/health(db_ok)가 알린다.
 */
export const GET = apiHandler(async (request) => {
  const owner = await requireOwner(request);
  const { config } = owner;
  const handle = await getAppDb(config);
  const now = new Date();
  const live = liveLlmReadiness(config, process.env);
  const sttLive = sttLiveReadiness(config);
  return json({
    status: 'ok',
    app: 'content-studio',
    version: pkg.version,
    time_utc: now.toISOString(),
    time_msk: formatMsk(now),
    timezone: DISPLAY_TIMEZONE,
    modes: getModes(config),
    llm: { mode: config.LLM_MODE, live_ready: live.ready, missing: live.missing },
    stt: { mode: config.STT_MODE, live_ready: sttLive.ready, missing: sttLive.missing },
    auth: (({ mode, ready, missing }) => ({ mode, oidc_ready: ready, missing }))(oidcReadinessView(config)),
    db: { driver: handle.driver, ok: true, migrated: handle.migrated },
    worker: { mode: config.WORKER_MODE, last_tick_utc: getLastTick()?.ranAt ?? null },
  });
});
