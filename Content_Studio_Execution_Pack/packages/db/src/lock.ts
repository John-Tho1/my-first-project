/**
 * PGlite 데이터 디렉터리 잠금.
 *
 * PGlite 는 자체 파일 잠금이 없어 두 프로세스가 같은 디렉터리를 열어도 오류 없이 열린다(데이터 손상 위험).
 * 그래서 앱 수준 잠금 파일(PID 기록)로 한 번에 한 프로세스만 열도록 강제한다.
 * 죽은 PID 의 잠금은 회수한다. 같은 프로세스 안의 재열기(Next dev hot reload 등)는 허용한다.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const LOCK_FILE = '.content-studio.lock';

export class DbLockedError extends Error {
  constructor(pid: number) {
    super(
      `PGlite 데이터 디렉터리를 다른 프로세스(PID ${pid})가 사용 중입니다. PGlite 는 한 번에 한 프로세스만 열 수 있습니다. ` +
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

/** 잠금을 얻고 해제 함수를 반환한다. 다른 살아 있는 프로세스가 잡고 있으면 DbLockedError. */
export function acquireDirLock(dir: string): () => void {
  const file = path.join(/*turbopackIgnore: true*/ dir, LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(/*turbopackIgnore: true*/ file, String(process.pid), { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let pid: number;
      try {
        pid = Number.parseInt(readFileSync(/*turbopackIgnore: true*/ file, 'utf8'), 10);
      } catch {
        continue; // 경합으로 방금 삭제됨 → 재시도
      }
      if (Number.isInteger(pid) && pid !== process.pid && isAlive(pid)) throw new DbLockedError(pid);
      rmSync(/*turbopackIgnore: true*/ file, { force: true }); // 죽은 프로세스/같은 프로세스의 이전 잠금 회수
      continue;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      process.off('exit', release);
      try {
        if (readFileSync(/*turbopackIgnore: true*/ file, 'utf8') === String(process.pid)) {
          rmSync(/*turbopackIgnore: true*/ file, { force: true });
        }
      } catch {
        // 이미 없음
      }
    };
    process.on('exit', release);
    return release;
  }
  throw new Error('PGlite 잠금 파일을 만들지 못했습니다');
}
