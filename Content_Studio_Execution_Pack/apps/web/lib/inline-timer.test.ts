/**
 * T21-P2(G3): 주기 tick 제어기 단위 시험 — 가짜 타이머만(DB·네트워크 없음).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@cs/domain';
import {
  createInlineTickTimer,
  currentInlineTimer,
  describeTickError,
  installInlineTimer,
  planInlineTimer,
  uninstallInlineTimer,
  type TimerHandle,
} from './inline-timer';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** 가짜 시계에서 stop: 진행 중 처리(가짜 sleep)가 끝나도록 시계를 앞당긴 뒤 기다린다. */
async function stopFake(timer: { stop(): Promise<void> }): Promise<void> {
  const p = timer.stop();
  await vi.advanceTimersByTimeAsync(60_000);
  await p;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  await uninstallInlineTimer();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createInlineTickTimer', () => {
  it('간격은 양의 정수(ms)만', () => {
    for (const intervalMs of [0, -1, 1.5, Number.NaN]) expect(() => createInlineTickTimer({ intervalMs, tick: async () => {} })).toThrow(RangeError);
  });

  it('start 직후에는 실행하지 않고 간격 뒤 첫 실행, 처리가 끝난 뒤 간격만큼 쉬고 다음 실행(고정 간격·흔들림 없음)', async () => {
    const starts: number[] = [];
    const t0 = Date.now();
    const timer = createInlineTickTimer({
      intervalMs: 5000,
      tick: async () => {
        starts.push(Date.now() - t0);
        await sleep(3000); // 처리에 3초 걸림
      },
    });
    expect(timer.start()).toBe(true);
    expect(timer.start()).toBe(false); // 두 번째 start 는 아무것도 하지 않는다(사슬은 하나)
    await vi.advanceTimersByTimeAsync(4999);
    expect(starts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([5000]);
    // 5000 시작 → 8000 끝 → 13000 다음 시작 → 16000 끝 → 21000
    await vi.advanceTimersByTimeAsync(16_000);
    expect(starts).toEqual([5000, 13_000, 21_000]);
    expect(timer.state()).toMatchObject({ started: true, stopped: false, runs: 2, failures: 0, skipped: 0 });
    await stopFake(timer);
  });

  it('겹치지 않음: 처리 중에 다시 실행하려 하면 건너뛴다(동시 실행 최대 1)', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let calls = 0;
    const timer = createInlineTickTimer({
      intervalMs: 1000,
      tick: async () => {
        calls += 1;
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(10_000); // 간격보다 훨씬 긴 처리
        concurrent -= 1;
      },
    });
    timer.start();
    await vi.advanceTimersByTimeAsync(1000); // 첫 실행 시작
    expect(timer.state().inFlight).toBe(true);
    expect(await timer.runNow()).toBe('skipped_in_flight');
    expect(await timer.runNow()).toBe('skipped_in_flight');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(maxConcurrent).toBe(1);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(timer.state().skipped).toBe(2);
    await stopFake(timer);
  });

  it('수동 실행(runNow) 중 타이머 차례가 오면 타이머 쪽이 건너뛰고, 다음 예약은 그대로 이어진다', async () => {
    let calls = 0;
    const timer = createInlineTickTimer({
      intervalMs: 1000,
      tick: async () => {
        calls += 1;
        await sleep(1500);
      },
    });
    timer.start();
    const manual = timer.runNow(); // t=0 시작, 1500 끝
    await vi.advanceTimersByTimeAsync(1000); // 타이머 차례 → 진행 중이라 건너뜀, 다음 예약 2000
    expect(timer.state().skipped).toBe(1);
    await vi.advanceTimersByTimeAsync(500); // t=1500 수동 실행 끝
    expect(await manual).toBe('ran');
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(500); // t=2000 타이머 실행
    expect(calls).toBe(2);
    expect(timer.state().scheduled || timer.state().inFlight).toBe(true);
    await stopFake(timer);
  });

  it('오류: 로그는 이름·코드만(메시지·값 없음), 서버를 멈추지 않고 다음 주기에 다시 실행', async () => {
    const lines: string[] = [];
    let n = 0;
    const timer = createInlineTickTimer({
      intervalMs: 1000,
      log: (l) => lines.push(l),
      tick: async () => {
        n += 1;
        if (n === 1) throw Object.assign(new Error('SECRET_TOKEN=abc123 postgres://user:pw@host/db'), { code: 'db_unavailable' });
        if (n === 2) throw 'raw string secret';
        if (n === 3) throw Object.assign(new TypeError('x'), { code: 'has space secret' });
      },
    });
    timer.start();
    await vi.advanceTimersByTimeAsync(4000);
    expect(n).toBe(4);
    expect(timer.state()).toMatchObject({ runs: 1, failures: 3 });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Error(db_unavailable)');
    expect(lines[1]).toContain('string');
    expect(lines[2]).toContain('TypeError');
    for (const l of lines) {
      expect(l).not.toMatch(/SECRET|abc123|postgres|pw@|raw string|has space/);
      expect(l).toContain('[inline-worker]');
    }
    await stopFake(timer);
  });

  it('로그 함수가 실패해도 다음 주기는 이어진다', async () => {
    let n = 0;
    const timer = createInlineTickTimer({
      intervalMs: 1000,
      log: () => {
        throw new Error('log down');
      },
      tick: async () => {
        n += 1;
        throw new Error('boom');
      },
    });
    timer.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(n).toBe(3);
    await stopFake(timer);
  });

  it('타이머는 unref 된다(이 타이머 때문에 프로세스가 끝나지 못하지 않음)', async () => {
    const unref = vi.fn();
    const handles: TimerHandle[] = [];
    const timer = createInlineTickTimer({
      intervalMs: 1000,
      tick: async () => {},
      setTimer: (fn, ms) => {
        const h = { unref, id: setTimeout(fn, ms) };
        handles.push(h);
        return h;
      },
      clearTimer: (h) => clearTimeout((h as { id: ReturnType<typeof setTimeout> }).id),
    });
    timer.start();
    await vi.advanceTimersByTimeAsync(2500);
    expect(handles.length).toBe(3); // 처음 + 2번의 재예약
    expect(unref).toHaveBeenCalledTimes(3);
    await stopFake(timer);
  });

  it('기본 setTimeout 타이머도 unref 된다(Node Timeout)', () => {
    vi.useRealTimers();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const timer = createInlineTickTimer({ intervalMs: 60_000, tick: async () => {} });
    timer.start();
    const h = spy.mock.results[0]!.value as NodeJS.Timeout;
    expect(h.hasRef()).toBe(false);
    void timer.stop();
  });

  it('stop: 예약을 지우고 진행 중 처리가 끝날 때까지 기다린다. 멈춘 뒤에는 더 실행하지 않고 다시 시작하지 않는다', async () => {
    let calls = 0;
    let finished = false;
    const timer = createInlineTickTimer({
      intervalMs: 1000,
      tick: async () => {
        calls += 1;
        await sleep(5000);
        finished = true;
      },
    });
    timer.start();
    await vi.advanceTimersByTimeAsync(1000);
    let stopped = false;
    const p = timer.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(finished).toBe(true);
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(1);
    expect(timer.state()).toMatchObject({ stopped: true, scheduled: false, inFlight: false });
    expect(timer.start()).toBe(false);
    expect(await timer.runNow()).toBe('stopped');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('describeTickError', () => {
  it('이름·짧은 코드만', () => {
    expect(describeTickError(new RangeError('secret'))).toBe('RangeError');
    expect(describeTickError(Object.assign(new Error('secret'), { code: 'ECONNRESET' }))).toBe('Error(ECONNRESET)');
    expect(describeTickError(Object.assign(new Error('secret'), { code: 'x'.repeat(65) }))).toBe('Error');
    expect(describeTickError(Object.assign(new Error('m'), { name: 'bad name with secret' }))).toBe('Object');
    expect(describeTickError(42)).toBe('number');
    expect(describeTickError(null)).toBe('object');
    expect(describeTickError({ code: 'oops' })).toBe('Object(oops)');
  });
});

describe('planInlineTimer (시작 판정)', () => {
  it('기본(빈 환경) = 간격 0 = 끔. 개발·시험에서는 경고 없음, 운영 빌드에서는 경고 한 줄', () => {
    const c = loadConfig({});
    expect(c.WORKER_INLINE_INTERVAL_SECONDS).toBe(0);
    expect(planInlineTimer(c, { NODE_ENV: 'development' })).toEqual({ start: false, reason: 'interval_off', warn: null });
    expect(planInlineTimer(c, { NODE_ENV: 'test' })).toEqual({ start: false, reason: 'interval_off', warn: null });
    const prod = planInlineTimer(c, { NODE_ENV: 'production' });
    expect(prod).toMatchObject({ start: false, reason: 'interval_off' });
    expect(prod.start === false && prod.warn).toContain('WORKER_INLINE_INTERVAL_SECONDS=0');
  });

  it('vitest 실행 환경(process.env)에서도 끔', () => {
    expect(loadConfig(process.env).WORKER_INLINE_INTERVAL_SECONDS).toBe(0);
    expect(planInlineTimer(loadConfig(process.env), { NODE_ENV: process.env.NODE_ENV }).start).toBe(false);
  });

  it('inline + 간격 → 시작(ms), separate 면 시작하지 않음, next build 중이면 시작하지 않음', () => {
    const c = loadConfig({ WORKER_INLINE_INTERVAL_SECONDS: '30' });
    expect(planInlineTimer(c, { NODE_ENV: 'production' })).toEqual({ start: true, intervalMs: 30_000 });
    expect(planInlineTimer({ ...c, WORKER_MODE: 'separate' }, { NODE_ENV: 'production' })).toEqual({ start: false, reason: 'worker_separate', warn: null });
    expect(planInlineTimer(c, { NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build' })).toEqual({ start: false, reason: 'build_phase', warn: null });
  });

  it('범위 밖 값이 설정 객체로 들어와도(방어) 시작하지 않는다', () => {
    const c = loadConfig({});
    for (const v of [4, 601, 2.5, -5]) expect(planInlineTimer({ ...c, WORKER_INLINE_INTERVAL_SECONDS: v }, {}).start).toBe(false);
  });
});

describe('installInlineTimer (프로세스당 한 소유자)', () => {
  it('두 번째 설치는 기존 타이머를 그대로 두고 already_running, 제거 뒤에는 새로 설치', async () => {
    const tickA = vi.fn(async () => {});
    const tickB = vi.fn(async () => {});
    const a = installInlineTimer({ intervalMs: 1000, tick: tickA });
    const b = installInlineTimer({ intervalMs: 1000, tick: tickB });
    expect(a.status).toBe('started');
    expect(b.status).toBe('already_running');
    expect(b.timer).toBe(a.timer);
    expect(currentInlineTimer()).toBe(a.timer);
    await vi.advanceTimersByTimeAsync(3000);
    expect(tickA).toHaveBeenCalledTimes(3);
    expect(tickB).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1); // 사슬 하나
    expect(await uninstallInlineTimer()).toBe(true);
    expect(currentInlineTimer()).toBeNull();
    expect(await uninstallInlineTimer()).toBe(false);
    const c = installInlineTimer({ intervalMs: 1000, tick: tickB });
    expect(c.status).toBe('started');
    await vi.advanceTimersByTimeAsync(1000);
    expect(tickB).toHaveBeenCalledTimes(1);
  });

  it('모듈을 다시 읽어도(HMR·번들 중복 흉내) 같은 소유자 자리를 본다', async () => {
    vi.resetModules();
    const m1 = await import('./inline-timer');
    vi.resetModules();
    const m2 = await import('./inline-timer');
    expect(m1).not.toBe(m2);
    const tick1 = vi.fn(async () => {});
    const tick2 = vi.fn(async () => {});
    expect(m1.installInlineTimer({ intervalMs: 1000, tick: tick1 }).status).toBe('started');
    expect(m2.installInlineTimer({ intervalMs: 1000, tick: tick2 }).status).toBe('already_running');
    await vi.advanceTimersByTimeAsync(2000);
    expect(tick1).toHaveBeenCalledTimes(2);
    expect(tick2).not.toHaveBeenCalled();
    expect(await m2.uninstallInlineTimer()).toBe(true);
    expect(m1.currentInlineTimer()).toBeNull();
  });
});
