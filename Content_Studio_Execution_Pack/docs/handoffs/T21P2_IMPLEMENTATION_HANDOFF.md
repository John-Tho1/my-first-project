# Implementation handoff — T21-P2 (G3 inline 주기 tick + G7 배포 산출물)

- Task ID / milestone: T21-P2 (docs/handoffs/T21_DEPLOY_REVIEW.md §2 G3·G7, §4 권고), M4 브랜치 `content-studio/m4`
- Purpose and changed behavior:
  1. **G3 주기 tick** — 새 설정 `WORKER_INLINE_INTERVAL_SECONDS`(정수 문자열, `0` = 끔(기본), 켜면 `5`~`600`). `apps/web/instrumentation.ts` 가 **시작 가드(T21-P1a) 다음에**(가드가 종료시키면 도달하지 않음) `startInlineWorkerTimerFromEnv()` 를 부른다. 조건: nodejs 런타임 + `WORKER_MODE=inline` + 간격 > 0 + `NEXT_PHASE` 가 `phase-production-build` 아님.
     - 제어기 `apps/web/lib/inline-timer.ts`(순수): 직전 tick 이 **끝난 뒤** 간격만큼 쉬고 다음 tick(고정 간격·jitter 없음·따라잡기 없음), 진행 중이면 건너뜀(`skipped_in_flight`), 예외는 잡아서 `[inline-worker] 주기 처리 실패: <이름>(<짧은 코드>)` 한 줄만(메시지·값·스택 없음) 남기고 다음 주기 예약, 로그 함수 실패도 삼킴, 타이머 `unref()`, `stop()` = 예약 제거 + 진행 중 tick 대기, 멈춘 제어기는 재시작 불가. 프로세스당 한 소유자: `globalThis[Symbol.for('content-studio.inline-worker-timer')]` — 모듈이 두 번 읽혀도 두 번째 설치는 `already_running`.
     - 연결부 `apps/web/lib/inline-worker-timer.ts`: tick = `getConfig()` → `getAppDb()`(globalThis 공용 연결) → **`runInlineWorker(config, db)`**(로그인한 `GET /api/transcription-jobs` 가 쓰는 같은 함수). HTTP 자기 호출·인증 우회 없음. 설정 오류면 시작하지 않고 `config_invalid` 경고만(예외 없음). 운영 빌드(`NODE_ENV=production`)에서 간격 0 이면 경고 한 줄.
     - 기본값 결정: **모든 환경에서 기본 끔(0)** — config.ts "기본값은 항상 안전 측" 원칙, `pnpm dev`·vitest 동작 불변, 켜는 것은 운영 환경 파일의 명시적 선택(`deploy/content-studio.env.example` = 30). 끈 채 운영 시작하면 로그 경고로 드러난다. 상한 600초는 아래 60분 규칙보다 충분히 작게.
     - 주의: `POST /api/worker/tick`(화면 버튼)은 owner 범위 `runJobsTick` 만 부른다. 타이머는 inline 경로 전체(`runInlineWorker` — 업로드 만료·전사·배포 작업(전 owner, 최대 5)·연결 정보 갱신·보존 auto·수집 스케줄러)를 부른다. 지시문의 "authenticated route" 는 같은 함수를 쓰는 `GET /api/transcription-jobs` 로 해석했다.
  2. **docs/07 오래 지난 예약 규칙(새로 구현)** — 조사 결과 **기존 코드에는 이 규칙이 없었다**: 실행 시 예약 작업은 `nextRunAt = scheduledAt` 으로 QUEUED 되고, `beginSend` 는 `schedule_passed` 를 걸러 내므로 서버가 며칠 멈췄다 돌아와도 그대로 보냈다. 주기 타이머는 재시작 직후 사용자 없이 이를 실행하게 되므로 최소 가드를 추가했다.
     - `packages/domain/src/jobs.ts`: `SCHEDULE_STALE_GRACE_MS = 60분`(잠정), `isScheduleStale(scheduledAt, now)`(경계값 = 아직 아님).
     - `packages/db/src/jobs.ts` `beginSend`: 승인·스냅숏 재검사 뒤, **`job.attempt === 0`(전송 의도가 한 번도 없음) && 예약 시각 + 60분 < now && 이 작업에 `unblock` 이력(사용자 재시도) 없음** → 보내지 않고 `blocked`(이력 `{reason:'schedule_stale', not_sent:true, late_minutes}`, `lastErrorCode='schedule_stale'`), 항목 BLOCKED, **승인은 유지**. 사용자가 기존 "재시도"(`retryItem` — 감사 기록)로 확인하면 unblock 이력이 생겨 다시 판정하지 않고 보낸다. attempt > 0(재시도·이어 올리기)·예약 없는 작업은 해당 없음. 주기 타이머·화면 버튼·`pnpm worker` 모두 같은 경로.
     - 화면 문구: `apps/web/lib/distribution.ts` BLOCK_REASON_LABEL `schedule_stale` 추가(재시도 버튼은 기존 조건 BLOCKED+활성 승인으로 이미 보임).
  3. **G7 배포 산출물(파일만)**: `deploy/Caddyfile`(`{$APP_DOMAIN}` 자동 HTTPS → `127.0.0.1:3000`, HSTS·nosniff·DENY·Referrer·Permissions-Policy(마이크 self)·COOP, Server/X-Powered-By 제거, CSP 없음 명시), `deploy/content-studio.service`(User=content-studio, `NODE_ENV=production`, `TZ=UTC`, `EnvironmentFile=/etc/content-studio/env`(root 600), WorkingDirectory, `node apps/web/scripts/next.mjs start --hostname 127.0.0.1 --port 3000`, Restart=on-failure, ProtectSystem=strict + ReadWritePaths(data·.next) 등, MemoryDenyWriteExecute 미사용 이유·SystemCallFilter 미적용 명시), `deploy/content-studio.env.example`(§4.2 고정 설정, placeholder 만), `deploy/README_KO.md`(배치·준비·build·환경 파일·시작/확인·Caddy·업그레이드 전 export + 정지 상태 data 복사(G8)·되돌리기·운영 확인·남은 위험, **P1b 전 배포 불가** 명시).
     - Next `output: 'standalone'` **사용 안 함**, `next.config.ts` 무변경 — 서버에서 checkout 그대로 install+build+`next start`. 이유: PGlite WASM 런타임 로드(serverExternalPackages)가 standalone 추적에 포함되는지 미확인, export/migrate CLI 가 같은 checkout 소스를 씀, dev/build 영향 0.
  4. 문서: `README_KO.md`(처리기 실행·PGlite 절, deploy 안내), `docs/04_DATA_AND_API.md`(환경변수 계약), `.env.example`(`WORKER_INLINE_INTERVAL_SECONDS=0`), 주석(`apps/worker/src/index.ts`, `apps/web/lib/stt.ts`).
- BASE_SHA: 6406e2f
- HEAD_SHA: b73fc657d7a1fc3b7a4194b0b942770a547dff24 (code only, D28 — 오케스트레이터 커밋)
- Clean tracked tree confirmed: 아니오 — 아래 변경이 미커밋. `.claude/` 는 손대지 않음(원래 untracked).
- Relevant acceptance IDs: T21_DEPLOY_REVIEW G3·G7(·G8 절차), docs/07 장애별 처리 "서버/worker 종료", T21 "예약 복구", A10(승인 철회 경로 불변), D23·D30(health 계약 불변)
- Changed files:
  - 수정: `packages/domain/src/config.ts`, `packages/domain/src/jobs.ts`, `packages/db/src/jobs.ts`, `apps/web/instrumentation.ts`, `apps/web/lib/distribution.ts`, `apps/web/lib/stt.ts`(주석), `apps/worker/src/index.ts`(주석), `README_KO.md`, `docs/04_DATA_AND_API.md`, `.env.example`, `packages/domain/src/config.test.ts`, `packages/domain/src/jobs.test.ts`
  - 신규: `apps/web/lib/inline-timer.ts`, `apps/web/lib/inline-worker-timer.ts`, `apps/web/lib/inline-timer.test.ts`, `apps/web/instrumentation.test.ts`, `tests/integration/inline-worker-timer.test.ts`, `deploy/Caddyfile`, `deploy/content-studio.service`, `deploy/content-studio.env.example`, `deploy/README_KO.md`
- 변경 → 시험 대응:

| 변경 | 시험 |
| --- | --- |
| 설정 파싱(기본 0, 0·5~600, 빈 값=0, 범위 밖·소수·접미사·공백 거부, 오류에 이름만) | config.test "T21-P2: WORKER_INLINE_INTERVAL_SECONDS…" |
| 고정 간격(끝난 뒤 기준)·첫 실행은 간격 뒤·start 두 번 무시 | inline-timer.test "start 직후에는 실행하지 않고…"(5000→13000→21000) |
| 겹치지 않음 / 수동 실행 중 타이머 차례 건너뜀 | "겹치지 않음…"(동시 최대 1), "수동 실행(runNow) 중…" |
| 오류 로그 이름·코드만, 계속 진행 / 로그 함수 실패 | "오류: 로그는 이름·코드만…", "로그 함수가 실패해도…", describeTickError |
| unref | 주입 타이머 unref 3회 + 기본 setTimeout `hasRef()===false` |
| stop(진행 중 대기·이후 실행 없음·재시작 불가·타이머 0) | "stop: 예약을 지우고…" |
| 단일 소유자·HMR 흉내(vi.resetModules 두 인스턴스) | installInlineTimer 두 시험 |
| 시작 판정(기본 끔·vitest 끔·운영 경고·separate·build 단계·방어적 범위) | planInlineTimer 4개 시험 |
| 시작 훅 순서(가드 → 타이머, 가드 종료 시 타이머 없음, edge 무동작) | instrumentation.test 3개 |
| 꺼짐: 타이머 없음, 6초 뒤에도 QUEUED·의도 0 / separate / 설정 오류 경고만 | inline-worker-timer.test "주기 처리 꺼짐" 3개 |
| 켜짐(5초 실제 시계): fetch 0·오류 로그 0, 보통·최근 예약 → CONFIRMED + MOCK publication(`isMock`, `verification:'MOCK'`, `mock:` ID), PUBLISH_MODE disabled, 2시간 지난 예약 → BLOCKED(`schedule_stale`, attempt 0, 의도·publication 0, 승인 유지) 이후 주기에도 그대로, 재시도 → 다음 주기 CONFIRMED, uninstall 뒤 새 작업 QUEUED 유지 | "주기 처리 켜짐(5초, HTTP 없음)" |
| 규칙 경계값(+60분 정각 보냄, +60분 1ms BLOCKED)·예약 전 lease 없음·예약 없는 작업 무관·attempt>0 무관·재시도 뒤 보냄 | "오래 지난 예약 규칙(runJobsTick, 시계 주입)" 4개 |
| isScheduleStale 순수 | jobs.test "T21-P2 isScheduleStale" |

- 변이 확인: `beginSend` 가드를 `false &&` 로 끈 상태에서 통합 시험 실행 → 오래 지난 예약 관련 3개 실패 확인 후 원복(원복 후 grep 0건).
- Migrations / restore implications: 없음(스키마 무변경). 새 BLOCKED 사유는 기존 job_events/lastErrorCode 문자열로만 기록 — export/restore 형식 불변.
- Actual commands and results (port 3000 LISTEN 없음 확인 후):
  - 개발 중: `vitest run --project unit apps/web/lib/inline-timer.test.ts apps/web/instrumentation.test.ts` → 19 passed; `vitest run --project integration tests/integration/inline-worker-timer.test.ts` → 8 passed(50s); 변이 실행 → 3 failed(예상), 원복.
  - `corepack pnpm lint` 0, `corepack pnpm typecheck` 0(개별 실행).
  - `bash .handoffs/run-checks.sh T21P2` → `.handoffs/checks-T21P2.log`: LINT=0, TYPECHECK=0, BUILD=0, **UNIT=1**(61 files / 1458 중 3 실패 — 모두 **미변경** `packages/domain/src/imports-fix1.test.ts` 1개·`imports-fix3.test.ts` 2개의 5000ms 시간 초과, 부하 중 성능 시험), INTEG=0(42 files / 824 passed), DRILL=0(불변식 위반 0건), MIGRATE=0, DRILL_RESTORE=0(PASS), CHECKS-DONE.
  - 시간 초과 파일 단독 재실행(파일 미변경 `git diff --quiet` 확인): `vitest run --project unit packages/domain/src/imports-fix1.test.ts` → 34 passed(exit 0), `…imports-fix3.test.ts` → 86 passed(exit 0). 로그 `.handoffs/checks-T21P2.unit-rerun-fix1.log`·`-fix3.log`.
  - 운영 빌드 스모크(검사 스크립트의 build 결과, 포트 3123, 임시 scratchpad 데이터 폴더, `AUTH_MODE=oidc`·모든 모드 mock/disabled·비밀 빈 값, `WORKER_INLINE_INTERVAL_SECONDS=5`): `next start` 로그에 `[inline-worker] 주기 처리 시작: 5초 간격(…)` 출력, 약 20초(여러 주기) 동안 오류 줄 없음, `GET /api/health` → `{"status":"ok",…,"db_ok":true}`(instrumentation 번들의 타이머와 route 가 PGlite 잠금 충돌 없이 같은 연결을 씀). 그 뒤 그 PID(3788, 명령줄 확인)만 종료. tick 결과 자체(작업 처리)는 이 스모크에서 관찰하지 않았다(빈 DB) — 처리 증거는 통합 시험.
- Demo route / local start steps: `.env.local` 에 `WORKER_INLINE_INTERVAL_SECONDS=10` 을 넣고 `pnpm dev` → 서버 로그 `[inline-worker] 주기 처리 시작`. 모의 계획 실행 후 화면을 열어 두지 않아도 작업이 처리되는지 `/distribute/{id}` 로 확인. (이번 작업에서 dev 서버·화면 관찰은 하지 않았다.)
- External calls performed: 없음(배포·가입·DNS·인증서 없음, 네트워크 호출 없음).
- Mock-only functionality: 배포 작업 처리는 여전히 모의 어댑터만. 배포 산출물은 파일뿐.
- Known risks / not run:
  1. **docs/07 규칙을 새로 구현**(지시는 "기존 시험 확인 또는 타이머 경로 시험 추가"였으나 규칙 자체가 코드에 없었다). 60분은 잠정값 — 사용자 결정 대상. 동작 변경: 예전에는 늦게 처리된 예약도 그대로 (모의) 전송했다. 이제 60분 넘게 늦은 첫 전송은 BLOCKED → 재시도 필요. 로컬 레이트 리밋으로 attempt 0 인 채 60분 넘게 RETRY_WAIT 였던 예약 작업도 BLOCKED 된다(의도한 보수 쪽).
  2. 사용자 확인 판정은 job_events 의 `event='unblock'` 존재로 한다(현재 unblock 은 retryItem 만 씀). 앞으로 자동 unblock 경로가 생기면 이 판정이 느슨해진다.
  3. lease 뒤·전송 의도 전 프로세스가 죽고 오래 멈췄다면, 복구가 QUEUED 로 되돌린 뒤 같은 가드가 다시 판정한다(scheduledAt 기준이라 막힘) — 시험은 안 했다.
  4. tick 이 끝나지 않으면(어댑터 hang 등) 다음 주기가 오지 않는다 — 전송 시간 제한(JOB_SUBMIT_TIMEOUT_MS)·조각 예산에 의존, 별도 watchdog 없음.
  5. 타이머는 web 요청과 같은 프로세스·같은 PGlite 연결에서 돈다. 로그인한 전사 목록 조회와 동시에 `runInlineWorker` 가 겹칠 수 있다(이전에도 여러 요청 사이에 있던 상황, lease 는 SKIP LOCKED). 부하 지연 미측정.
  6. SIGTERM 처리기를 따로 달지 않았다(Next 기본 종료에 맡김, 타이머 unref). 종료 중 진행 중 tick 은 끊길 수 있다 — 기존 lease 만료 복구 규칙(A20)에 의존.
  7. deploy 파일은 실제 Linux·systemd·Caddy 에서 실행하지 않았다(not_run). `ProtectSystem=strict`+ReadWritePaths 가 Next 런타임 쓰기(.next/cache 외)와 맞는지, `systemd-run … corepack pnpm export` 절차, Caddy 헤더 문법은 미검증. Caddyfile 은 `caddy validate` 를 돌리지 않았다(이 PC 에 Caddy 없음).
  8. 단위 검사 1차에서 미변경 성능 시험 3개가 부하 시간 초과(단독 재실행 통과) — 기존 불안정성으로 기록.
  9. `docs/DECISIONS.md`·`docs/handoffs/*` 는 지시대로 수정하지 않았다(규칙 신설·60분 값 결정 기록은 오케스트레이터 몫).
- Questions specifically for Codex:
  1. `beginSend` 의 오래 지난 예약 가드 위치(승인·스냅숏 재검사 뒤, 계정·연결 정보 검사 앞)와 조건(`attempt===0`, `unblock` 이력)이 docs/07 의도와 맞고, 기존 상태 기계(BLOCKED → retryItem → QUEUED)와 A10·A11·A20 규칙을 깨지 않는가? 항목 상태를 PLANNED 가 아닌 BLOCKED 로, 승인을 유지한 선택이 맞는가?
  2. `userRetriedJob` 의 job_events JSON 조회(`sanitized_details->>'event' = 'unblock'`)가 복원(restore)된 작업이나 다른 이벤트 모양에서 잘못 참이 될 경로가 있는가?
  3. 제어기의 겹침 방지·고정 간격·stop 대기 구현에 경쟁 조건이 있는가(특히 timer 콜백에서 `runOnce().then(schedule, schedule)` 와 stop 사이, runNow 와의 상호작용)?
  4. instrumentation 번들에서 `@cs/db`·`@cs/providers` 를 불러도 route 번들과 싱글턴이 갈라지지 않는가? 확인한 것: DB(`__contentStudioDb`)·모의 어댑터·모의 OAuth 저장소는 globalThis. `collector-mock`·`import-connector` 는 모듈 변수 싱글턴(고정 자료라 영향 없다고 판단) — 놓친 모듈 상태가 있으면 지적 바람.
  5. 기본값 "모든 환경 끔"(운영은 환경 파일에서 명시적으로 켬 + 끈 채면 경고) 선택이 타당한가, 아니면 운영 빌드 기본값을 켜야 하는가?
  6. 오류 로그(`describeTickError`)가 비밀을 남길 경로가 없는가(오류 `name` 을 사용자 정의 값으로 바꾼 경우 등)?
  7. 통합 시험이 실제 시계 5초 간격을 써서 느리다(약 50초). 시험 판단이 시간 의존으로 불안정해질 부분이 있는가?
  8. deploy unit·Caddyfile·README 절차에서 보안상 빠진 것(예: `ReadWritePaths` 범위, HSTS, 백업 사본 권한) 또는 PGlite 단일 프로세스 규칙과 어긋나는 단계가 있는가?
- Next authorized task: 오케스트레이터 지시 대기(T21-P1b OIDC / P4 백업 위치 결정 등).

## 오케스트레이터 재검사(커밋 전)
- 단위만 다시 실행: 2 실패 / 1456 통과 — 실패는 손대지 않은 `imports-fix1.test.ts`·`imports-fix3.test.ts` 의 2MB 선형성 시험 5초 시간 초과(단독 실행은 통과). 전체 실행 부하에서 반복되므로 별도 시험 전용 작업으로 처리 예정(걸음 수 단언은 유지).
- 60분 기준은 D36(잠정)으로 DECISIONS.md 에 기록.
