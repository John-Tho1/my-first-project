/** T08 서버 전용: inline worker 실행·응답 모양. */
import { type Db } from '@cs/db';
import { type AppConfig } from '@cs/domain';
import { runWorkerTick, type WorkerTick } from '@cs/worker';
import { getStorage, getWorkerTranscriber } from './server';

/** WORKER_MODE=inline 이면 tick 1회(업로드 만료 정리 + 모의 전사 한 단계). separate 면 아무것도 하지 않는다. */
export async function runInlineWorker(config: AppConfig, db: Db): Promise<WorkerTick | null> {
  if (config.WORKER_MODE !== 'inline') return null;
  return runWorkerTick({ config, db, transcriber: getWorkerTranscriber(), files: getStorage(config) });
}

/** 요청 본문 상한(전사 요청·세션 생성 등 작은 JSON) */
export const MAX_SMALL_JSON = 8 * 1024;
/** 전사 수정 본문 상한(200,000자 × UTF-8 최대 4바이트 + 여유) */
export const MAX_TRANSCRIPT_REQUEST = 200_000 * 4 + 4096;
