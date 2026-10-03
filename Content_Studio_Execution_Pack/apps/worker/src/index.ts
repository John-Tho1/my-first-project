/**
 * 작업 처리기(worker).
 *
 * tick 한 번(T08):
 * - 만료된 업로드 세션(24시간) → expired, 조각 파일·행 삭제
 * - 음성 전사 job 을 한 단계씩 진행(transcriber 가 주어졌을 때만): queued → running 25 → 50 → 75 → succeeded 100 | failed.
 *   전사기는 호출자가 넣는다(web: 모의 전사기, 외부 호출 없음). CLI(`pnpm worker`)는 전사기 없이 만료 정리만 한다.
 *
 * - T11(D18): 배포 작업(채널 어댑터가 주어졌을 때만) — lease 만료 복구 → lease(최대 maxJobs) → 전송·원격 조회. 어댑터는 호출자가 넣는다
 *   (web·CLI: 모의 어댑터 레지스트리, 외부 호출 없음). worker 는 @cs/providers 에 의존하지 않는다.
 *
 * WORKER_MODE=inline(기본, M0–M2): web 프로세스 안에서 호출된다(/api/health·전사 목록 조회가 지연 실행).
 * WORKER_MODE=separate + DB_DRIVER=pglite 는 거부한다 — PGlite 는 한 데이터 디렉터리에 한 연결만 허용하므로
 * web 과 별도 프로세스가 같은 DB 를 동시에 열 수 없다.
 */
import {
  advanceTranscriptionJobs,
  cleanupPendingDeletes,
  countCaptures,
  expireUploadSessions,
  maybeAutoRetention,
  resolveFromRoot,
  newWorkerId,
  runDueCollectorSources,
  runJobsTick,
  uploadStoreFor,
  type AssetDeleter,
  type Db,
  type DueRunsResult,
  type JobRunOptions,
  type JobsTickResult,
  type RetentionResult,
  type TranscriberLike,
} from '@cs/db';
import type { AppConfig, ChannelAdapterRegistry, CollectorAdapter, MediaReader } from '@cs/domain';

export interface WorkerTick {
  ranAt: string;
  mode: AppConfig['WORKER_MODE'];
  processed: number;
  captures: number;
  uploadsExpired: number;
  transcription: { advanced: number; succeeded: number; failed: number; originalsDeleted: number } | null;
  /** FIX-T08 round 2: 남은 파일 삭제 의도 재시도(assets.cleanup) — 저장소가 주어졌을 때만 */
  cleanup: { deleted: number; failed: number } | null;
  /** T11: 배포 작업(어댑터가 주어졌을 때만) — 결과 상태별 개수 */
  jobs: JobsTickResult | null;
  /** T20: 보존 정리(RETENTION_SWEEP_MODE=auto 이고 한 시간이 지났을 때만, owner 별 결과). manual 이면 null */
  retention: RetentionResult[] | null;
  /** T13: 만료가 가까운 연결 정보 갱신(갱신기가 주어졌을 때만 — 모의 공급자, 외부 호출 없음) */
  credentials: { refreshed: number; failed: number } | null;
  /**
   * T19(D33 제안): 주기 수집 — COLLECTOR_SCHEDULER=on 이고 COLLECTOR_MODE=mock 일 때만 기한이 된 소스를 모의 수집해 **미리보기만** 만든다(소재 0).
   * 그 밖에는 skipped(scheduler_off | collector_not_mock).
   */
  collector: DueRunsResult;
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
  /** T11: 배포 채널 어댑터(모의). 없으면 배포 작업은 건너뛴다. */
  channelAdapters?: ChannelAdapterRegistry;
  /** T11: 한 tick 에 처리할 배포 작업 수(1~20, 기본 5) */
  maxJobs?: number;
  /** T11: lease 소유자 표시(호스트 이름 금지). 기본 'inline-<8자>' */
  workerId?: string;
  /** T11: 배포 작업을 한 owner 로 제한(POST /api/worker/tick) */
  ownerId?: string;
  /** T11: 시계(테스트 주입). now 가 있으면 그 시각에서 흐르는 시계 */
  clock?: () => Date;
  random?: () => number;
  leaseTtlMs?: number;
  /** T13: 만료 7일 안의 연결 정보 갱신기(호출자가 공급자·키를 넣는다). 없으면 건너뛴다. */
  credentialRefresh?: (now: Date) => Promise<{ refreshed: number; failed: number }>;
  /** T14(D26): 배포 작업의 연결 정보 의존성(키 묶음·401 뒤 확인). 없으면 작업 처리기 기본값(process.env 키, 확인 없음). */
  jobCredentials?: JobRunOptions['credentials'];
  /** T15(D27): 배포 작업이 올릴 미디어 파일 범위 읽기(로컬 저장소). 없으면 미디어가 필요한 어댑터는 원격 호출 없이 닫는다. */
  media?: MediaReader;
  /**
   * FIX-T15(Codex review-T15 P1): 전송 실행 하나의 조각 예산. inline 모드(web 요청 안 — /api/health·목록 조회)는 WEB_TICK_UPLOAD_SLICE 를 넣어
   * 영상 전체를 한 요청에서 올리지 않는다(docs/02). 별도 worker 프로세스(CLI)는 넣지 않는다(제한 없음 — 시간 제한만).
   */
  uploadSlice?: JobRunOptions['uploadSlice'];
  /** T19(D33 제안): 모의 수집 어댑터(COLLECTOR_MODE=mock 일 때 호출자가 넣음). 없으면 주기 수집은 collector_not_mock 으로 건너뛴다. */
  collector?: CollectorAdapter | null;
}

export async function runWorkerTick(input: WorkerTickInput): Promise<WorkerTick> {
  const { config, db, transcriber, files, now } = input;
  assertWorkerModeSupported(config);
  const at = now ?? input.clock?.() ?? new Date();
  const captures = await countCaptures(db);
  const uploadsExpired = await expireUploadSessions(db, uploadStoreFor(config), at);
  const transcription = transcriber ? await advanceTranscriptionJobs(db, { transcriber, files, now: at }) : null;
  const cleanup = files ? await cleanupPendingDeletes(db, files, at) : null;
  let jobs: JobsTickResult | null = null;
  if (input.channelAdapters) {
    const offset = at.getTime() - Date.now();
    const clock = input.clock ?? (now ? () => new Date(Date.now() + offset) : () => new Date());
    jobs = await runJobsTick(db, input.channelAdapters, {
      workerId: input.workerId ?? newWorkerId('inline'),
      config,
      clock,
      random: input.random,
      leaseTtlMs: input.leaseTtlMs,
      submitTimeoutMs: config.JOB_SUBMIT_TIMEOUT_MS,
      maxJobs: Math.min(Math.max(input.maxJobs ?? 5, 1), 20),
      ownerId: input.ownerId,
      credentials: input.jobCredentials,
      media: input.media,
      uploadSlice: input.uploadSlice,
    });
  }
  const retention = await maybeAutoRetention(db, config, resolveFromRoot(config.EXPORT_LOCAL_DIR), at);
  const credentials = input.credentialRefresh ? await input.credentialRefresh(at) : null;
  const collector = await runDueCollectorSources(db, config, input.collector ?? null, at);
  const tick: WorkerTick = {
    ranAt: at.toISOString(),
    mode: config.WORKER_MODE,
    processed:
      uploadsExpired + (transcription ? transcription.advanced + transcription.succeeded + transcription.failed : 0) + (jobs ? jobs.leased + jobs.recovered : 0),
    captures,
    uploadsExpired,
    transcription,
    cleanup,
    jobs,
    retention,
    credentials,
    collector,
    note:
      (transcriber
        ? `T08: 업로드 만료 정리 + 전사 job 진행(${transcriber.mode === 'mock' ? '모의 전사기, 외부 호출 없음' : 'live'})`
        : 'T08: 업로드 만료 정리만(전사기 없음), 외부 호출 없음') + (jobs ? ' · T11: 배포 작업(모의 어댑터, MOCK — 외부 호출 없음)' : ''),
  };
  globalForWorker.__contentStudioLastTick = tick;
  return tick;
}
