/**
 * PGlite 데이터 디렉터리 잠금.
 *
 * PGlite 는 자체 파일 잠금이 없어 두 프로세스가 같은 디렉터리를 열어도 오류 없이 열린다(데이터 손상 위험).
 * 그래서 앱 수준 잠금 파일로 한 번에 한 프로세스·한 연결만 열도록 강제한다.
 *
 * - 잠금 파일 내용은 `<pid>:<nonce>` 다. nonce 는 획득마다 새로 만들어, 해제할 때 "내가 만든 잠금"만 지운다.
 * - 죽은 PID 의 잠금 회수는 별도의 회수 잠금(`.reclaim`, `wx` 생성)으로 직렬화하고, 회수 직전에 파일 내용이
 *   처음 관찰한 죽은 잠금과 같은지 다시 확인한다(read → delete → create 경합으로 살아 있는 잠금을 지우는 일 방지).
 * - 같은 프로세스가 같은 디렉터리를 두 번 여는 것은 허용하지 않는다(web 은 client.ts 의 getDb 싱글턴이 한 연결만 유지한다).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const LOCK_FILE = '.content-studio.lock';
const RECLAIM_SUFFIX = '.reclaim';

/** 내용을 아직 읽을 수 없는(비어 있거나 부분 기록된) 잠금은 이 시간(ms)이 지나야 회수 대상으로 본다. */
const UNREADABLE_STALE_MS = 2_000;
const MAX_ATTEMPTS = 50;
const RETRY_WAIT_MS = 10;

export class DbLockedError extends Error {
  constructor(pid: number) {
    super(
      pid === process.pid
        ? `PGlite 데이터 디렉터리를 이 프로세스(PID ${pid})가 이미 열고 있습니다. 한 프로세스 안에서도 연결은 하나여야 합니다(getDb 를 사용하세요).`
        : `PGlite 데이터 디렉터리를 다른 프로세스(PID ${pid})가 사용 중입니다. PGlite 는 한 번에 한 프로세스만 열 수 있습니다. ` +
            '개발 서버(pnpm dev / pnpm start)를 종료한 뒤 다시 실행하세요.',
    );
    this.name = 'DbLockedError';
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `<pid>:<nonce>` 또는 (구버전) `<pid>` 를 해석한다. 해석 불가면 null. */
function parsePid(raw: string): number | null {
  const pid = Number.parseInt(raw.split(':')[0] ?? '', 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function readLock(file: string): { raw: string; mtimeMs: number } | null {
  try {
    return { raw: readFileSync(/*turbopackIgnore: true*/ file, 'utf8'), mtimeMs: statSync(/*turbopackIgnore: true*/ file).mtimeMs };
  } catch {
    return null; // 방금 사라짐
  }
}

/** 잠금 파일 하나의 상태 판정. */
type Verdict = { kind: 'missing' } | { kind: 'held'; pid: number } | { kind: 'stale'; raw: string } | { kind: 'unknown' };
function judge(file: string): Verdict {
  const cur = readLock(file);
  if (!cur) return { kind: 'missing' };
  const pid = parsePid(cur.raw);
  if (pid !== null) return pid === process.pid || isAlive(pid) ? { kind: 'held', pid } : { kind: 'stale', raw: cur.raw };
  // 비어 있거나 깨진 내용: 다른 프로세스가 방금 만들어 아직 못 읽은 것일 수 있으니 잠시는 기다린다.
  return Date.now() - cur.mtimeMs < UNREADABLE_STALE_MS ? { kind: 'unknown' } : { kind: 'stale', raw: cur.raw };
}

/**
 * 파일 삭제. Windows 에서는 다른 프로세스가 같은 파일을 읽고 있는 순간 EPERM/EBUSY 가 날 수 있다(force 는 ENOENT 만 무시).
 * 그 경우 지우지 못한 채 돌아가고, 호출자의 재시도 루프가 다음 시도에서 다시 판정한다.
 */
function rmQuiet(file: string): void {
  try {
    rmSync(/*turbopackIgnore: true*/ file, { force: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EBUSY" && code !== "ENOENT") throw e;
  }
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * 죽은 잠금을 회수한다. 회수 잠금(`wx`)을 얻은 프로세스만 진행하며, 파일 내용이 관찰한 죽은 잠금(`expectRaw`)과
 * 그대로일 때만 지운다. 회수 잠금을 못 얻으면(다른 프로세스가 회수 중) 아무것도 하지 않는다.
 */
function reclaimStale(file: string, expectRaw: string): void {
  const reclaim = file + RECLAIM_SUFFIX;
  try {
    writeFileSync(/*turbopackIgnore: true*/ reclaim, `${process.pid}:${randomUUID()}`, { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    // 회수 잠금이 이미 있음: 그 소유자가 죽었으면(또는 오래된 깨진 파일이면) 치우고, 아니면 이번 회차는 양보한다.
    const v = judge(reclaim);
    if (v.kind === 'stale') rmSync(/*turbopackIgnore: true*/ reclaim, { force: true });
    return;
  }
  try {
    const cur = readLock(file);
    if (cur && cur.raw === expectRaw) rmQuiet(file);
  } finally {
    rmQuiet(reclaim);
  }
}

/** 이 프로세스가 현재 잡고 있는 디렉터리(절대 경로). hot reload 로 모듈이 다시 평가돼도 유지되도록 globalThis 에 둔다. */
const held = ((globalThis as typeof globalThis & { __contentStudioDirLocks?: Set<string> }).__contentStudioDirLocks ??= new Set<string>());

/** 잠금을 얻고 해제 함수를 반환한다. 다른 살아 있는 프로세스(또는 이 프로세스의 기존 연결)가 잡고 있으면 DbLockedError. */
export function acquireDirLock(dir: string): () => void {
  const key = path.resolve(dir);
  if (held.has(key)) throw new DbLockedError(process.pid);
  const file = path.join(/*turbopackIgnore: true*/ key, LOCK_FILE);
  const token = `${process.pid}:${randomUUID()}`;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      writeFileSync(/*turbopackIgnore: true*/ file, token, { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const v = judge(file);
      if (v.kind === 'held') throw new DbLockedError(v.pid);
      if (v.kind === 'stale') reclaimStale(file, v.raw);
      else sleepSync(RETRY_WAIT_MS); // missing/unknown: 경합 중 → 잠시 뒤 재시도
      continue;
    }
    held.add(key);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      held.delete(key);
      process.off('exit', release);
      try {
        if (readFileSync(/*turbopackIgnore: true*/ file, 'utf8') === token) {
          rmSync(/*turbopackIgnore: true*/ file, { force: true });
        }
      } catch {
        // 이미 없음
      }
    };
    process.on('exit', release);
    return release;
  }
  throw new Error('PGlite 잠금 파일을 만들지 못했습니다(재시도 초과)');
}
