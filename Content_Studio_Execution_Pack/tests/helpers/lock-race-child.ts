/**
 * lock.test.ts 의 다중 프로세스 경합 테스트용 자식 프로세스.
 *   node --import tsx tests/helpers/lock-race-child.ts <dir> <holdMs>
 * 시작하면 <dir>/ready-<pid> 를 만들고 <dir>/go 가 생길 때까지 기다린 뒤(모든 자식이 동시에 출발하도록) 잠금을 시도한다.
 * 잠금을 얻으면 "OK" 를 출력하고 holdMs 동안 유지한 뒤 해제한다. 다른 프로세스가 잡고 있으면 "LOCKED".
 */
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { acquireDirLock, DbLockedError } from '../../packages/db/src/lock';

const dir = process.argv[2];
const holdMs = Number(process.argv[3] ?? '1000');
if (!dir) throw new Error('dir 인자가 필요합니다');

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
writeFileSync(path.join(dir, `ready-${process.pid}`), '');
const deadline = Date.now() + 90_000;
while (!existsSync(path.join(dir, 'go'))) {
  if (Date.now() > deadline) throw new Error('go 신호를 받지 못했습니다');
  sleepSync(5);
}
try {
  const release = acquireDirLock(dir);
  console.log('OK');
  setTimeout(release, holdMs);
} catch (e) {
  console.log(e instanceof DbLockedError ? 'LOCKED' : `ERR ${(e as Error).message}`);
}
