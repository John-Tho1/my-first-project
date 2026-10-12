/**
 * T21-P2(T21_DEPLOY_REVIEW G3): web 프로세스 안 작업 처리기(inline worker)의 주기 실행 제어기 — 순수 모듈(DB·Next 의존 없음, 단위 시험 대상).
 *
 * 규칙
 * - 겹치지 않음: 직전 tick 이 끝나지 않았으면 이번 실행은 건너뛴다(skipped_in_flight). 타이머 사슬은 하나뿐이다.
 * - 고정 간격: tick 이 **끝난 뒤** intervalMs 만큼 쉬고 다음 tick 을 시작한다(흔들림·jitter 없음, 따라잡기 실행 없음).
 * - 오류: tick 의 예외는 잡아서 로그 한 줄(오류 이름·코드만 — 메시지·값·스택 없음, 비밀 노출 방지)로 남기고 다음 주기를 그대로 예약한다. 서버를 죽이지 않는다.
 * - 타이머는 unref — 이 타이머 때문에 프로세스가 끝나지 못하는 일은 없다.
 * - stop(): 예약된 타이머를 지우고, 진행 중 tick 이 끝날 때까지 기다린다. 멈춘 제어기는 다시 시작하지 않는다(새로 만든다).
 * - 프로세스당 한 소유자: globalThis 의 한 자리(Symbol.for)에 둔다 — 모듈이 두 번 읽혀도(HMR·번들 중복) 두 번째 시작은 기존 것을 그대로 둔다.
 */
import { INLINE_INTERVAL_MAX_SECONDS, INLINE_INTERVAL_MIN_SECONDS, type AppConfig } from '@cs/domain';

export type TimerHandle = { unref?: () => unknown } | number | object;

export interface InlineTickTimerOptions {
  /** tick 이 끝난 뒤 다음 tick 까지 쉬는 시간(ms, 양의 정수) */
  intervalMs: number;
  /** 한 번의 처리. 같은 함수를 로그인한 경로(GET /api/transcription-jobs)도 쓴다 — HTTP 호출·인증 우회 없음. */
  tick: () => Promise<unknown>;
  /** 오류 로그(기본 console.error). 한 줄, 비밀 없음. */
  log?: (line: string) => void;
  /** 시험 주입용(기본 setTimeout/clearTimeout) */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

export type RunOutcome = 'ran' | 'failed' | 'skipped_in_flight' | 'stopped';

export interface InlineTickTimerState {
  started: boolean;
  stopped: boolean;
  inFlight: boolean;
  /** 예약된 다음 실행이 있는가 */
  scheduled: boolean;
  runs: number;
  failures: number;
  skipped: number;
}

export interface InlineTickTimer {
  readonly intervalMs: number;
  /** 첫 tick 을 intervalMs 뒤에 예약한다. 이미 시작했거나 멈췄으면 false(아무것도 하지 않음). */
  start(): boolean;
  /** 지금 한 번 실행(시험·수동). 진행 중이면 건너뛴다. 다음 예약은 바꾸지 않는다. */
  runNow(): Promise<RunOutcome>;
  stop(): Promise<void>;
  state(): InlineTickTimerState;
}

/** 오류를 로그에 남길 이름·코드로만 줄인다(메시지·값·스택 없음). 코드는 짧은 식별자 모양일 때만. */
export function describeTickError(e: unknown): string {
  const name = e instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(e.name) ? e.name : typeof e === 'object' && e !== null ? 'Object' : typeof e;
  const raw = typeof e === 'object' && e !== null && 'code' in e ? (e as { code: unknown }).code : undefined;
  const code = typeof raw === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(raw) ? raw : null;
  return code ? `${name}(${code})` : name;
}

export function createInlineTickTimer(opts: InlineTickTimerOptions): InlineTickTimer {
  const { intervalMs } = opts;
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) throw new RangeError('intervalMs 는 양의 정수여야 합니다');
  const log = opts.log ?? ((line: string) => console.error(line));
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: TimerHandle) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let handle: TimerHandle | null = null;
  let inFlight: Promise<void> | null = null;
  let started = false;
  let stopped = false;
  let runs = 0;
  let failures = 0;
  let skipped = 0;

  const safeLog = (line: string) => {
    try {
      log(line);
    } catch {
      // 로그 실패도 서버를 멈추지 않는다
    }
  };

  const schedule = () => {
    if (stopped) return;
    const h = setTimer(() => {
      handle = null;
      void runOnce().then(schedule, schedule);
    }, intervalMs);
    if (typeof h === 'object' && h !== null && typeof (h as { unref?: unknown }).unref === 'function') (h as { unref: () => unknown }).unref();
    handle = h;
  };

  const runOnce = async (): Promise<RunOutcome> => {
    if (stopped) return 'stopped';
    if (inFlight) {
      skipped += 1;
      return 'skipped_in_flight';
    }
    let failed = false;
    const p = (async () => {
      try {
        await opts.tick();
        runs += 1;
      } catch (e) {
        failed = true;
        failures += 1;
        safeLog(`[inline-worker] 주기 처리 실패: ${describeTickError(e)} — 다음 주기에 다시 시도합니다`);
      }
    })();
    inFlight = p;
    try {
      await p;
    } finally {
      inFlight = null;
    }
    return failed ? 'failed' : 'ran';
  };

  return {
    intervalMs,
    start() {
      if (started || stopped) return false;
      started = true;
      schedule();
      return true;
    },
    runNow: runOnce,
    async stop() {
      stopped = true;
      if (handle !== null) {
        clearTimer(handle);
        handle = null;
      }
      if (inFlight) await inFlight;
    },
    state: () => ({ started, stopped, inFlight: inFlight !== null, scheduled: handle !== null, runs, failures, skipped }),
  };
}

// ---- 시작 판정(순수) ----

export type InlineTimerPlan =
  | { start: true; intervalMs: number }
  | { start: false; reason: 'interval_off' | 'worker_separate' | 'build_phase'; warn: string | null };

/**
 * 설정·실행 환경에서 주기 tick 을 시작할지 정한다.
 * - `next build` 중(NEXT_PHASE=phase-production-build)에는 시작하지 않는다(빌드가 DB 를 열지 않게).
 * - WORKER_MODE=separate 면 web 은 tick 을 돌리지 않는다(별도 worker 프로세스의 일).
 * - 간격 0(기본) = 끔. 운영 빌드(NODE_ENV=production)에서 끈 채면 경고 한 줄(예약·만료 정리·수집이 요청이 있을 때만 진행된다).
 */
export function planInlineTimer(
  config: Pick<AppConfig, 'WORKER_MODE' | 'WORKER_INLINE_INTERVAL_SECONDS'>,
  env: { NODE_ENV?: string; NEXT_PHASE?: string },
): InlineTimerPlan {
  if (env.NEXT_PHASE === 'phase-production-build') return { start: false, reason: 'build_phase', warn: null };
  if (config.WORKER_MODE !== 'inline') return { start: false, reason: 'worker_separate', warn: null };
  const sec = config.WORKER_INLINE_INTERVAL_SECONDS;
  if (sec === 0) {
    return {
      start: false,
      reason: 'interval_off',
      warn:
        env.NODE_ENV === 'production'
          ? '[inline-worker] WORKER_INLINE_INTERVAL_SECONDS=0 — 주기 처리가 꺼져 있습니다. 예약 작업·업로드 만료 정리·주기 수집은 로그인한 요청이 있을 때만 진행됩니다(deploy/README_KO.md)'
          : null,
    };
  }
  // 설정 스키마가 이미 범위를 강제한다 — 여기서는 방어적으로 한 번 더(범위 밖이면 시작하지 않음).
  if (!Number.isInteger(sec) || sec < INLINE_INTERVAL_MIN_SECONDS || sec > INLINE_INTERVAL_MAX_SECONDS) return { start: false, reason: 'interval_off', warn: null };
  return { start: true, intervalMs: sec * 1000 };
}

// ---- 프로세스당 한 소유자 ----

const OWNER_KEY = Symbol.for('content-studio.inline-worker-timer');
type GlobalWithTimer = typeof globalThis & { [OWNER_KEY]?: InlineTickTimer };

export function currentInlineTimer(): InlineTickTimer | null {
  return (globalThis as GlobalWithTimer)[OWNER_KEY] ?? null;
}

/** 이미 이 프로세스에 타이머가 있으면 그대로 두고 'already_running'. 없으면 만들어 시작하고 'started'. */
export function installInlineTimer(opts: InlineTickTimerOptions): { status: 'started' | 'already_running'; timer: InlineTickTimer } {
  const g = globalThis as GlobalWithTimer;
  const existing = g[OWNER_KEY];
  if (existing && !existing.state().stopped) return { status: 'already_running', timer: existing };
  const timer = createInlineTickTimer(opts);
  g[OWNER_KEY] = timer;
  timer.start();
  return { status: 'started', timer };
}

/** 이 프로세스의 타이머를 멈추고 자리를 비운다(진행 중 tick 이 끝날 때까지 기다림). 없으면 false. */
export async function uninstallInlineTimer(): Promise<boolean> {
  const g = globalThis as GlobalWithTimer;
  const t = g[OWNER_KEY];
  if (!t) return false;
  await t.stop();
  if (g[OWNER_KEY] === t) delete g[OWNER_KEY];
  return true;
}
