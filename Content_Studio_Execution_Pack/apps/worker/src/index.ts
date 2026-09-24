/**
 * 작업 처리기(worker). M0 에는 jobs 테이블이 없으므로 tick 은 DB 연결만 확인한다.
 *
 * WORKER_MODE=inline(기본, M0–M2): web 프로세스 안에서 호출된다(/api/health 가 지연 실행).
 * WORKER_MODE=separate + DB_DRIVER=pglite 는 거부한다 — PGlite 는 한 데이터 디렉터리에 한 연결만 허용하므로
 * web 과 별도 프로세스가 같은 DB 를 동시에 열 수 없다.
 */
import { countCaptures, type Db } from '@cs/db';
import type { AppConfig } from '@cs/domain';

export interface WorkerTick {
  ranAt: string;
  mode: AppConfig['WORKER_MODE'];
  processed: number;
  captures: number;
  note: string;
}

const globalForWorker = globalThis as typeof globalThis & { __contentStudioLastTick?: WorkerTick };

export function getLastTick(): WorkerTick | null {
  return globalForWorker.__contentStudioLastTick ?? null;
}

export class WorkerModeError extends Error {
  constructor() {
    super(
      'WORKER_MODE=separate 는 DB_DRIVER=pglite 와 함께 쓸 수 없습니다. PGlite 는 한 데이터 디렉터리에 한 연결만 허용하므로 ' +
        'web 과 별도 worker 프로세스가 같은 DB 를 동시에 열 수 없습니다. WORKER_MODE=inline 을 쓰거나 DB_DRIVER=postgres(M3)로 전환하세요.',
    );
    this.name = 'WorkerModeError';
  }
}

export function assertWorkerModeSupported(config: AppConfig): void {
  if (config.WORKER_MODE === 'separate' && config.DB_DRIVER === 'pglite') throw new WorkerModeError();
}

export async function runWorkerTick({ config, db }: { config: AppConfig; db: Db }): Promise<WorkerTick> {
  assertWorkerModeSupported(config);
  const captures = await countCaptures(db);
  const tick: WorkerTick = {
    ranAt: new Date().toISOString(),
    mode: config.WORKER_MODE,
    processed: 0,
    captures,
    note: 'M0: jobs 테이블 없음 — DB 연결 확인만 수행, 외부 호출 없음',
  };
  globalForWorker.__contentStudioLastTick = tick;
  return tick;
}
