/**
 * 작업 처리기(worker).
 *
 * tick 한 번(T08):
 * - 만료된 업로드 세션(24시간) → expired, 조각 파일·행 삭제
 * - 음성 전사 job 을 한 단계씩 진행(transcriber 가 주어졌을 때만): queued → running 25 → 50 → 75 → succeeded 100 | failed.
 *   전사기는 호출자가 넣는다(web: 모의 전사기, 외부 호출 없음). CLI(`pnpm worker`)는 전사기 없이 만료 정리만 한다.
 *
 * WORKER_MODE=inline(기본, M0–M2): web 프로세스 안에서 호출된다(/api/health·전사 목록 조회가 지연 실행).
 * WORKER_MODE=separate + DB_DRIVER=pglite 는 거부한다 — PGlite 는 한 데이터 디렉터리에 한 연결만 허용하므로
 * web 과 별도 프로세스가 같은 DB 를 동시에 열 수 없다.
 */
import { advanceTranscriptionJobs, countCaptures, expireUploadSessions, uploadStoreFor, type AssetDeleter, type Db, type TranscriberLike } from '@cs/db';
import type { AppConfig } from '@cs/domain';

export interface WorkerTick {
  ranAt: string;
  mode: AppConfig['WORKER_MODE'];
  processed: number;
  captures: number;
  uploadsExpired: number;
  transcription: { advanced: number; succeeded: number; failed: number; originalsDeleted: number } | null;
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

export interface WorkerTickInput {
  config: AppConfig;
  db: Db;
  /** 전사기(모의). 없으면 전사 job 은 건너뛴다. */
  transcriber?: TranscriberLike;
  /** 원음 보존을 끈 job 의 원본 삭제에 쓰는 저장소 */
  files?: AssetDeleter;
  now?: Date;
}

export async function runWorkerTick({ config, db, transcriber, files, now }: WorkerTickInput): Promise<WorkerTick> {
  assertWorkerModeSupported(config);
  const at = now ?? new Date();
  const captures = await countCaptures(db);
  const uploadsExpired = await expireUploadSessions(db, uploadStoreFor(config), at);
  const transcription = transcriber ? await advanceTranscriptionJobs(db, { transcriber, files, now: at }) : null;
  const tick: WorkerTick = {
    ranAt: at.toISOString(),
    mode: config.WORKER_MODE,
    processed: uploadsExpired + (transcription ? transcription.advanced + transcription.succeeded + transcription.failed : 0),
    captures,
    uploadsExpired,
    transcription,
    note: transcriber
      ? `T08: 업로드 만료 정리 + 전사 job 진행(${transcriber.mode === 'mock' ? '모의 전사기, 외부 호출 없음' : 'live'})`
      : 'T08: 업로드 만료 정리만(전사기 없음), 외부 호출 없음',
  };
  globalForWorker.__contentStudioLastTick = tick;
  return tick;
}
