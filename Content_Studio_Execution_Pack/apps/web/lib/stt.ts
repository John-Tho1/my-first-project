/** T08 서버 전용: inline worker 실행·응답 모양. */
import { refreshExpiringCredentials, type Db } from '@cs/db';
import { readSecretKeyring, WEB_TICK_UPLOAD_SLICE, type AppConfig } from '@cs/domain';
import { runWorkerTick, type WorkerTick } from '@cs/worker';
import { ensureMockOAuthReady, jobCredentials, oauthDeps } from './oauth';
import { getChannelAdapters, getStorage, getWorkerTranscriber } from './server';

/**
 * WORKER_MODE=inline 이면 tick 1회(업로드 만료 정리 + 모의 전사 한 단계 + T11 배포 작업 최대 5개 — 모의 어댑터, 외부 호출 없음).
 * separate 면 아무것도 하지 않는다.
 * FIX-T15(Codex review-T15 P1, docs/02): web 요청 안이므로 영상 업로드는 작업당 조각 1개(WEB_TICK_UPLOAD_SLICE)만 보내고 양보한다 — 남은 조각은
 * 다음 tick 이 같은 세션으로 이어 올린다(inline 개발 모드에서도 업로드는 끝까지 진행되지만 한 요청이 영상 전체를 처리하지 않는다).
 */
export async function runInlineWorker(config: AppConfig, db: Db): Promise<WorkerTick | null> {
  if (config.WORKER_MODE !== 'inline') return null;
  // M4-DEV1: 만료 임박 갱신·작업 처리 전에(재시작 뒤 첫 tick 이면) DB 의 모의 연결 정보로 모의 공급자 메모리를 다시 채운다(프로세스당 한 번, 모의 모드만)
  await ensureMockOAuthReady(config, db);
  // T13: 마스터 키가 있을 때만 만료가 가까운 연결 정보를 갱신한다(모의 공급자 — 외부 호출 없음). 키가 없으면 건너뛴다(앱은 그대로).
  const deps = oauthDeps(config);
  const credentialRefresh = readSecretKeyring(process.env).ok
    ? (now: Date) => refreshExpiringCredentials(db, { providerFor: deps.providerFor, keyring: deps.keyring, now })
    : undefined;
  return runWorkerTick({
    config,
    db,
    transcriber: getWorkerTranscriber(),
    files: getStorage(config),
    channelAdapters: getChannelAdapters(),
    maxJobs: 5,
    credentialRefresh,
    jobCredentials: jobCredentials(config, db),
    media: getStorage(config),
    uploadSlice: WEB_TICK_UPLOAD_SLICE,
  });
}

/** 요청 본문 상한(전사 요청·세션 생성 등 작은 JSON) */
export const MAX_SMALL_JSON = 8 * 1024;
/** 전사 수정 본문 상한(200,000자 × UTF-8 최대 4바이트 + 여유) */
export const MAX_TRANSCRIPT_REQUEST = 200_000 * 4 + 4096;
