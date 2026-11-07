/**
 * T21-P2(G3): 서버 시작 훅(instrumentation.ts, nodejs 런타임 전용)이 부르는 주기 tick 연결부(서버 전용).
 * tick 은 로그인한 전사 목록 조회(GET /api/transcription-jobs)와 **같은 함수** runInlineWorker 를 그대로 부른다 —
 * 자기 자신에게 HTTP 요청을 보내지 않고 인증을 우회하는 경로도 만들지 않는다. 기존 가드(PUBLISH_MODE·모의 어댑터만·실행 모드 검사·
 * 오래 지난 예약 BLOCKED·연결 정보 차단·수집 스케줄러 off)는 runInlineWorker → runWorkerTick → runJobsTick 안에서 그대로 적용된다.
 * 설정·DB 는 tick 마다 route 와 같은 방법(getConfig·getAppDb — 프로세스 공용 연결)으로 읽는다.
 */
import { installInlineTimer, planInlineTimer, type InlineTickTimer } from './inline-timer';
import { getAppDb, getConfig } from './server';
import { runInlineWorker } from './stt';

/** tick 한 번 — route 와 같은 설정 읽기·공용 DB 연결·같은 처리 함수. */
export async function inlineWorkerTickOnce(): Promise<void> {
  const config = getConfig();
  const { db } = await getAppDb(config);
  await runInlineWorker(config, db);
}

export type StartOutcome = 'started' | 'already_running' | 'stopping' | 'interval_off' | 'worker_separate' | 'build_phase' | 'config_invalid';

/**
 * 설정을 읽어 주기 tick 을 시작한다(프로세스당 한 번 — 이미 있으면 그대로). 예외를 밖으로 던지지 않는다(서버 시작을 막지 않음).
 * 설정 오류면 시작하지 않고 종류만 로그(값·변수 내용 없음) — 요청 경로의 getConfig 가 같은 오류를 그대로 낸다.
 */
export function startInlineWorkerTimerFromEnv(
  deps: { tick?: () => Promise<unknown>; log?: (line: string) => void; warn?: (line: string) => void; info?: (line: string) => void } = {},
): { outcome: StartOutcome; timer: InlineTickTimer | null } {
  const warn = deps.warn ?? ((l: string) => console.warn(l));
  const info = deps.info ?? ((l: string) => console.info(l));
  let config;
  try {
    config = getConfig();
  } catch {
    warn('[inline-worker] 설정을 읽지 못해 주기 처리를 시작하지 않습니다(config_invalid)');
    return { outcome: 'config_invalid', timer: null };
  }
  // NODE_ENV 는 빌드가 고정한 값(process.env.NODE_ENV 식)을 쓴다 — lib/server.ts getConfig 와 같은 이유(T21-P1a).
  const plan = planInlineTimer(config, { NODE_ENV: process.env.NODE_ENV, NEXT_PHASE: process.env.NEXT_PHASE });
  if (!plan.start) {
    if (plan.warn) warn(plan.warn);
    return { outcome: plan.reason, timer: null };
  }
  const { status, timer } = installInlineTimer({ intervalMs: plan.intervalMs, tick: deps.tick ?? inlineWorkerTickOnce, log: deps.log });
  if (status === 'started') info(`[inline-worker] 주기 처리 시작: ${plan.intervalMs / 1000}초 간격(직전 처리가 끝난 뒤 기준, 겹치지 않음)`);
  return { outcome: status, timer };
}
