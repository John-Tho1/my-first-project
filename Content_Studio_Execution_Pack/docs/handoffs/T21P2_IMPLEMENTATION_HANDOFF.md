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


---

# FIX round 1 — Codex review-T21P2(CHANGES_REQUESTED, 리뷰 대상 b73fc65) 반영

- 리뷰: `.handoffs/review-T21P2.md`(P0 1 · P1 3 · P2 3). 지시: `prompts/CLAUDE_FIX.md` — 코드 지적은 먼저 b73fc65 코드(작업 트리의 코드 = b73fc65, 그 뒤 커밋은 docs·시험 시간 제한뿐)에서 실패하는 시험으로 재현한 뒤 고쳤다.
- BASE_SHA: 8ce1044(리뷰 대상 코드 HEAD b73fc65 + docs 9afaedd + TEST-TIMEOUT f71f7ad/8ce1044)
- HEAD_SHA: **없음(미커밋)** — 지시대로 커밋하지 않았다(`git add -A` 안 함). `.claude/` 손대지 않음. docs/handoffs/*·DECISIONS.md 수정 없음.

## 재현(수정 전 코드에서 실패)
| 지적 | 재현 시험 | 수정 전 결과 |
| --- | --- | --- |
| P0 inline-timer.ts:53 | inline-timer.test `describeTickError` 4개(식별자 모양 비밀 name `SECRET_TOKEN_abc123`·code `api_key_123`·`sk_live_…`·`ghp_…`·`Bearer_…`, 던지는 접근자·Proxy, 제어기 로그) + 기존 오류 로그 시험 기대값 갱신 | 5개 실패(이름·코드가 그대로 로그에 남음 / 접근자 예외) |
| P2 inline-timer.ts:185(재설치 경쟁) | "이전 타이머가 멈추는 중(진행 중 tick)이면 새 설치는 거부…" | 실패(`started` 반환 → 두 tick 겹칠 수 있음) |
| P2(Codex 답 3, runNow 예약) | "runNow 는 예약을 다시 잡는다 — 수동 실행이 끝난 뒤에도 간격만큼…" | 실패(기존 예약이 남아 수동 실행 직후 다시 실행) |
| P1 jobs.ts:623 | inline-worker-timer.test `FIX1-T21P2(Codex P1 …)` 의 ① 다른 사유 재시도 뒤 장시간 중단 ② 확인 기록 내용 ③ 복원·위조 이력 | 3개 실패(① 일반 unblock 때문에 오래 지난 예약을 그대로 전송 ② 확인 필드 없음 ③ 위조된 일반 unblock 으로 전송). 로그 `.handoffs/fix1-t21p2-repro-p1.log` |
| 놓친 케이스(확인 뒤 승인 철회, lease 만료 복구) | 같은 describe 의 ④ ⑤ | 수정 전에도 통과(승인 재검사가 앞에 있고, 복구 뒤에도 같은 판정) — 회귀 방지로 유지 |

(P0·P2 단위 재현 실행 결과는 이 세션 콘솔에서 7 failed / 15 passed 로 관찰. 파일로 남기지 않았다.)

## 지적 → 변경 → 시험
| 지적 | 변경 | 시험 |
| --- | --- | --- |
| **P0** :53 정규식은 비밀을 못 막음 | `describeTickError` 를 **허용 목록**으로: 이름은 `LOGGABLE_ERROR_NAMES`(JS 표준 10개 + tick 경로 앱 오류 14개)만, 코드는 `LOGGABLE_ERROR_CODES`(Node 시스템 코드 13개 + 확인한 앱 코드 5개: `job_state_changed`·`lease_lost`·`mock_rehydration_unavailable`·`secrets_not_configured`·`credential_refresh_failed`)만. 목록 밖 이름 → `UnknownError`, Error 가 아닌 값 → `NonErrorThrown`, 목록 밖 코드는 생략. `instanceof`·속성 읽기 모두 try 로 감싸 접근자·Proxy 예외도 고정 문자열 | `describeTickError (FIX1-T21P2 P0 :53 — 허용 목록만)` 4개 + 오류 로그 시험 |
| **P1** jobs.ts:623 아무 unblock 이나 확인으로 인정 | `retryItem`: 막힌 사유가 `schedule_stale` 일 때만 unblock 이력에 `stale_schedule_confirmed: true`·`approval_id`·`confirmed_payload_hash`·`confirmed_scheduled_at_utc` 를 남기고 감사 기록에도 `stale_schedule_confirmed: true`. `beginSend`: 순수 함수 `staleScheduleConfirmedBy`(domain) — 이 작업의 **마지막 schedule_stale 차단 뒤**에 cause `user_retry` + 확인 플래그가 있고 승인 ID·내용 hash·예약 시각이 **지금의 활성 승인·항목과 모두 같을 때만** 통과. `restored_needs_review` 작업은 확인을 인정하지 않음. 이전 `userRetriedJob`(아무 unblock) 삭제 | 통합 ①~⑤ + domain `staleScheduleConfirmedBy` 2개(인정 2가지·불인정 9가지: 차단 없음·일반 unblock·다른 승인/hash/예약·플래그 문자열·cause 다름·확인 뒤 다시 stale 차단) |
| **P1** README:40 저장소 루트·앱 루트 혼동 | 저장소 루트 `/srv/content-studio/repo`, 앱 루트 `…/repo/Content_Studio_Execution_Pack` 로 분리. unit `WorkingDirectory`=앱 루트, `ReadWritePaths` 를 실제 빌드 출력 **`<앱 루트>/apps/web/.next`** 로 고침(이전 `/app/.next` 는 틀렸다 — 로컬 build 결과가 `apps/web/.next/BUILD_ID` 에 있음을 확인). 복사 명령은 모두 `$APP_ROOT/deploy/...` | 경로 표(README §1), 로컬 `apps/web/.next` 확인 |
| **P1** README:42 실패 뒤 계속 진행 | `deploy/scripts/build-release.sh`(`set -euo pipefail`): 40자리 SHA·서비스 사용자·서비스 정지·추적 변경 없음·fetch·커밋 존재·checkout·**`git rev-parse HEAD` == 요청 SHA**·`.env` 없음·`install --frozen-lockfile`·build·`BUILD_ID` 를 단계마다 확인하고 실패 즉시 exit 1. `check-env.sh`(root): 환경 파일 존재·`root:root 600`·고정 설정·데이터 절대 경로·간격 범위·비어 있어야 할 키(값 출력 없음). `backup-data.sh`(root): 서비스 정지 확인, `/srv/content-studio-backup` 를 `install -d -o root -g root -m 700` 로 생성, `umask 077`·파일 600, 다시 읽기 확인. README 블록은 `set -eu`·개별 명령, 실패 시 다음 단계 금지 명시 | `bash -n` 3개 OK. 인수 검사 실행: 인수 없음·짧은 SHA·다른 사용자·origin 없는 임시 저장소(fetch 실패)·SHA 형식 오류·환경 파일 없음·예시 env(소유자/권한·예시 도메인 지적) → 모두 exit 1. shellcheck 는 이 PC 에 없음(not_run) |
| **P2** README:78 caddy validate 에 APP_DOMAIN 없음 | 도메인을 `/etc/caddy/content-studio.env` 한 파일에 두고 Caddy 서비스(`EnvironmentFile=`)와 검증(`sh -c 'set -a; . file; set +a; test -n "$APP_DOMAIN" && exec caddy validate --config … --adapter caddyfile'`)이 같은 파일을 읽게 함. Caddyfile 머리 주석도 같게 | 문서만(Caddy 미설치 — not_run) |
| **P2** inline-timer.ts:185 멈추는 중 재설치 | `installInlineTimer`: 기존 타이머가 멈췄더라도 **진행 중 tick 이 있으면 `stopping` 으로 거부**(자리 유지 — `uninstallInlineTimer` 가 stop 완료 뒤 비움). 완전히 멈춘 타이머가 남아 있으면 교체. `StartOutcome` 에 `stopping` 추가 | 재설치 경쟁 시험(동시 실행 최대 1) + "멈춘 타이머가 자리에 남아 있어도…" |
| (Codex 답 3) runNow 와 고정 간격 | `runNow()`: 시작한 제어기면 기존 예약을 지우고 실행이 끝난 뒤 다시 intervalMs 예약(진행 중이면 건너뜀, 시작 전이면 예약 안 함). 인터페이스 주석에 명시 | runNow 시험 2개(이전 "수동 실행 중 타이머 차례" 시험은 새 동작과 맞지 않아 교체 — 같은 성질(겹침 없음)을 더 엄격히 확인) |
| **P2** 통합 :171 대기 조건 | 단언 전에 plain·recent CONFIRMED·stale BLOCKED **그리고** `runs ≥ 1 && !inFlight` 를 함께 기다림. "다음 주기에도 그대로"는 6초 고정 대기 대신 완료 tick 수 +2 를 기다림. 재시도 뒤 CONFIRMED 도 `runs` 증가·`!inFlight` 와 함께. 이 시험만 시간 제한 240초(대기 상한 합계 수용) | 통합 13개 통과(약 54초). 꺼짐·uninstall 뒤 "처리하지 않음"은 부재 확인이라 고정 대기(6초)를 유지 |

## 바뀐 파일(FIX1)
- 코드: `apps/web/lib/inline-timer.ts`, `apps/web/lib/inline-worker-timer.ts`(StartOutcome), `packages/domain/src/jobs.ts`(`staleScheduleConfirmedBy`·`StaleScheduleConfirmTarget`), `packages/db/src/jobs.ts`(`staleScheduleConfirmed`·beginSend 조건·retryItem 확인 기록·감사 세부)
- 시험: `apps/web/lib/inline-timer.test.ts`, `packages/domain/src/jobs.test.ts`, `tests/integration/inline-worker-timer.test.ts`
- 배포·문서: `deploy/README_KO.md`(재작성), `deploy/content-studio.service`, `deploy/Caddyfile`(주석), 신규 `deploy/scripts/build-release.sh`·`check-env.sh`·`backup-data.sh`, `README_KO.md`(deploy 안내·확인 규칙 한 줄)
- migration·export/restore 형식: 변화 없음(확인 정보는 기존 job_events·audit JSON 에만).

## 실행한 명령과 결과(port 3000 LISTEN 없음 확인 후)
- 재현: 위 표. 수정 후 `vitest run --project unit apps/web/lib/inline-timer.test.ts` 22 passed, `… packages/domain/src/jobs.test.ts apps/web/lib/inline-timer.test.ts apps/web/instrumentation.test.ts` 116 passed, `vitest run --project integration tests/integration/inline-worker-timer.test.ts` 13 passed.
- `bash -n deploy/scripts/*.sh` 3개 OK, 인수·실패 경로 실행 7가지 모두 exit 1(위 표).
- `bash .handoffs/run-checks.sh FIX-T21P2` → `.handoffs/checks-FIX-T21P2.log`: LINT=0, TYPECHECK=0, BUILD=0, UNIT=0(61 files / 1466 passed), **INTEG=1**(워커 종료 2147483651 — `tests/integration/youtube.test.ts`(미변경)에서 fork 가 죽음, 41/42 files·801/829 실행), DRILL=0(불변식 위반 0건), MIGRATE=0, DRILL_RESTORE=0(PASS), CHECKS-DONE.
- 규칙대로 통합만 재실행: `corepack pnpm exec vitest run --project integration --maxWorkers=2` → **42 files / 829 passed, exit 0**(`.handoffs/checks-FIX-T21P2.integ2.log`).

## 남은 위험·미검증(FIX1)
1. 허용 목록 밖의 오류는 `UnknownError` 로만 보인다 — 운영 진단 정보가 줄어든다(의도). 새 앱 오류를 로그에 보이게 하려면 목록에 추가해야 한다.
2. 확인 일치 판정은 job_events JSON 의 문자열 비교다. 예약 시각 ISO 표기가 바뀌면(같은 시각 다른 표기) 확인이 무효가 되는 쪽으로 실패한다(fail closed).
3. 확인 뒤 다른 사유로 다시 막혔다가 일반 재시도하면, 승인·내용·예약이 같으므로 이전 확인이 유효하다(시험으로 고정). 이것이 너무 느슨하면 "확인 뒤 첫 차단 이후에는 무효"로 좁힐 수 있다 — Codex 판단 요청.
4. 복원된 작업은 `restored_needs_review` 로만 거른다. 복원 경로가 이 표시 없이 작업을 실행 가능 상태로 만드는 일은 코드상 없다고 보았으나(restore.ts 347~364행) 실제 복원 후 오래 지난 예약 조합은 위조 이력 시험으로만 확인했다.
5. deploy 스크립트·절차는 실제 Linux·systemd·Caddy 에서 실행하지 않았다. shellcheck 미실행. `ReadWritePaths` 가 Next 런타임 쓰기 전부를 덮는지 실측하지 않았다(README §5 에 확인 방법). Windows 작업 트리는 CRLF 로 체크아웃되지만 저장소에는 LF 로 들어가므로 Linux checkout 은 LF 라고 가정했다(미확인).
6. 통합 1차 실행의 워커 종료(2147483651)는 이 PC 의 알려진 PGlite 메모리 문제로 보고 재실행으로 처리했다 — 변경 파일이 아닌 youtube.test.ts 에서 발생.

## Codex 재검증 질문
1. 허용 목록(이름 24·코드 18)에 비밀이 될 수 있는 값이 있는가, 또는 tick 경로에서 자주 나는데 빠진 안전한 이름·코드가 있는가?
2. `staleScheduleConfirmedBy` 의 조건(마지막 schedule_stale 차단 뒤, cause user_retry, 플래그 true, 승인 ID·hash·예약 시각 일치)과 `restored_needs_review` 제외가 지적한 놓친 케이스를 모두 막는가? 위험 3(확인 뒤 다른 사유 재차단)은 허용해도 되는가?
3. `retryItem` 이 `job.lastErrorCode === 'schedule_stale'` 로 확인 여부를 정하는 것이 충분한가(같은 작업의 마지막 차단 사유를 lastErrorCode 로 판단)?
4. `installInlineTimer` 의 `stopping` 거부와 `runNow` 재예약에 남은 경쟁(예: runNow 실행 중 stop, 타이머 콜백과 runNow 의 순서)이 있는가?
5. build-release.sh 의 단계 순서(서비스 정지 확인 → 변경 없음 → fetch → 존재 → checkout → HEAD 비교 → .env 없음 → install → build → BUILD_ID)와 check-env.sh·backup-data.sh 의 검사가 충분한가? `systemctl is-active` 를 서비스 사용자 권한으로 부르는 것이 문제 되는가?
6. 통합 시험의 대기 조건(상태 + `runs`·`inFlight`)에 남은 시간 의존이 있는가?


### FIX round 1 — 오케스트레이터 기록
- FIX HEAD: f351b7a923b5945d920304339ead39db0863770c (code only). BASE 8ce1044(+ docs 2065e1d·650dc9a).
- checks-FIX-T21P2: lint·typecheck·build 0 · unit 1466 · integration 1회차 1(손대지 않은 youtube.test.ts 워커 exit 2147483651 — 메모리) → maxWorkers=2 재실행 42 파일 · 829 통과 · drill · migrate · restore PASS.


---

# FIX round 2 — Codex review-FIX-T21P2(CHANGES_REQUESTED, 리뷰 대상 f351b7a) 반영

- 리뷰: `.handoffs/review-FIX-T21P2.md` — 코드 지적은 해결됨, 배포 스크립트·문서 P1 4개 + 놓친 케이스.
- BASE_SHA: 8e1e8e4(f351b7a + docs). HEAD_SHA: **없음(미커밋)** — 커밋·`git add -A` 안 함. `.claude/`·docs/handoffs/*·DECISIONS.md 수정 없음.

## 재현(수정 전 스크립트에서 실패)
새 시험 실행기 `deploy/scripts/tests/run-all.sh`(일반 bash, pnpm·node 불필요. 임시 폴더의 가짜 `systemctl`·`mountpoint`·`id` 를 PATH 앞에 둠)를 **수정 전** 스크립트에 먼저 돌렸다 → `DEPLOY-SCRIPT-TESTS: FAIL`, `test-check-env` 19 실패 · `test-restore-data` 10 실패 · `test-service-state` 16 실패. 로그 `.handoffs/fix2-t21p2-repro-deploy.log`.
- 서비스 상태: build-release 는 `activating`·`reloading`·빈 값·systemctl 없음·미등록에서 진행, backup-data 는 `active`·`activating`·조회 실패·systemctl 없음·미등록에서 진행(데이터 폴더 단계까지 감).
- check-env: 앞 공백·탭·중복 키·export·연속 행·따옴표·소문자 키·`=` 주변 공백 등에 "지원하지 않는 줄" 판정이 없음, `..` 경로를 데이터 루트 기준으로 가리지 못함.
- restore: 마운트 지점을 구분하는 스크립트 없음(README 는 마운트 지점을 `mv`).

## 지적 → 변경 → 시험
| 지적 | 변경 | 시험(`deploy/scripts/tests/`) |
| --- | --- | --- |
| **P1** build-release.sh:25 · backup-data.sh:21 조회 실패를 정지로 취급 | 공용 `deploy/scripts/lib/common.sh` `require_service_stopped <unit> <first_install>`: `systemctl show -p LoadState` 와 `-p ActiveState` 를 **각각 종료 코드까지 확인**. `LoadState=loaded` + `ActiveState ∈ {inactive, failed}` 일 때만 진행. 조회 실패·systemctl 없음·`active`·`activating`·`deactivating`·`reloading`·빈 값·masked 등은 중단. `not-found` 는 `--first-install` 일 때만, 그리고 `list-unit-files --type=service` 가 **성공**하고 목록에 unit 이 **없을** 때만 진행(이미 등록됐는데 `--first-install` 이면 중단). build-release 에 `--first-install` 인수 추가. backup-data 는 최초 설치 예외 없음, 서비스 확인을 데이터 폴더 확인보다 먼저 | `test-service-state.sh` 43개(진행 2·중단 상태 5·버스 오류·명령 없음·미등록·first-install 성공/목록 실패/목록에 있음/이미 등록·masked, backup 쪽 같은 조합) |
| **P1** check-env.sh:22 systemd 와 다른 해석 | 문법을 좁게: 빈 줄 / `#` 로 시작하는 줄 / `^[A-Z][A-Z0-9_]*=값$`(앞 공백·export·`=` 주변 공백 없음, 값에 `" ' \ $`·제어 문자(CR 포함)·앞뒤 공백 없음) 만. 같은 KEY 두 번이면 거부. 나머지 줄은 모두 "지원하지 않는 줄(N행)" — 값은 출력하지 않음. 따옴표는 **거부**로 정함(systemd 의 따옴표·이스케이프 해석을 흉내 내지 않음). 값은 한 번 읽어 연관 배열로 판정(grep 마지막 값 방식 제거). `deploy/content-studio.env.example` 이 새 문법을 통과함을 확인 | `test-check-env.sh`: 앞 공백 재할당 ` LLM_MODE=live`·탭·중복 키·export·줄 끝 `\`·큰/작은따옴표·소문자 키·`=` 주변 공백·값 끝 공백·`${HOME}`·CRLF·앞 공백 주석 → 모두 거부, 거부 메시지에 값 없음 |
| **P1** check-env.sh:43 문자열 접두사 경로 검사 | 데이터 루트 `CS_DATA_ROOT`(기본 `/srv/content-studio/data`)를 `realpath -e` 로 정규화(없으면 실패). 각 경로는 절대 경로여야 하고 `realpath -m`(`..`·기존 링크 해석)이 루트 **아래**(루트 자체 아님)여야 하며, 가장 가까운 **기존 부모**의 `realpath -e` 도 루트 안이어야 함 | `..` 탈출·루트 자체(`exports/..`)·상대 경로·이름이 비슷한 형제 폴더(`data-evil`)→ 거부, 아직 없는 하위 경로 → 허용, 루트 없음 → 거부, **실제 심볼릭 링크**(이 PC 에서 native symlink 생성 성공)로 밖을 가리키면 거부·안을 가리키면 허용 |
| **P1** README:132 마운트 지점에서 mv 실패 | 새 `deploy/scripts/restore-data.sh`: root·서비스 정지 확인 → 사본 안 경로가 모두 `data/` 아래(절대 경로·`..` 거부) → `mountpoint -q`(종료 코드 0=마운트, 32=아님, 그 밖·명령 없음=중단) → 바꾸기 전 지금 내용을 `data-before-restore-<시각>.tar.gz`(600) → **마운트 지점이면 폴더는 두고 내용만 지운 뒤 풀기**, 일반 폴더면 `data.replaced-<시각>` 으로 mv 후 풀기 → 소유자·700. README §8 을 일반 폴더/마운트 지점 표 + 공급자 볼륨 스냅숏 절차(정지 → 스냅숏 복구 → `findmnt` 확인 → 시작)로 다시 씀. backup-data 는 mv·삭제를 하지 않음(주석 명시) | `test-restore-data.sh` 27개: 일반 폴더(교체·이전 폴더 보존·사전 사본), 마운트 지점(mv 없음·내용 교체·사전 사본), 서비스 실행 중·조회 실패·mountpoint 없음·mountpoint 오류(1)·`../` 사본·최상위가 data 아님 → 중단하고 데이터 그대로, backup-data 정상(마운트 지점 그대로) |
| 덧붙임(Codex 답 1) `EROFS` | 허용 코드에 `EROFS`·`EIO`·`EDQUOT` 추가(`ENOSPC`·`EACCES`·`EPERM` 은 이미 있음) → 이름 24·코드 21개 | inline-timer.test 허용 목록 시험에 6개 코드 단언 |
| 덧붙임(Codex 답 3) 다른 사유 차단 뒤 lastErrorCode | 코드 변경 없음(확인 결과 모든 `blocked` 경로가 자기 코드를 쓰고, 재시도는 `lastErrorCode=null`) | 통합 `FIX2-T21P2` ① 확인 → 원격 401(실제 경로) → BLOCKED, `lastErrorCode` ≠ schedule_stale, 그 재시도는 확인 플래그 없음·`previous_error` 일치 ② 확인 → 승인 철회 → `approval_revoked`(A10 즉시 BLOCKED), 의도 0 |
| 덧붙임(놓친 케이스) 계정·내용 변경이 확인을 무효화 | 코드 변경 없음(승인 무효화가 먼저 막고, 확인은 승인 ID·hash·예약 시각에 묶임) | ③ 확인 → 계정 `disconnected`(승인 철회 확인) → 다시 `mock_ready` → tick: 의도 0·CONFIRMED 아님 ④ 확인 → 본문 새 버전(`appendVariantVersion`) → 승인 0 → tick: 의도 0. 공개 범위·예약 시각은 계획 생성 뒤 바꾸는 경로가 없어(새 계획 필요) 위조 확인 시험(FIX1, 다른 예약 시각)으로만 덮음 |

## 바뀐 파일(FIX2)
- 신규: `deploy/scripts/lib/common.sh`, `deploy/scripts/restore-data.sh`, `deploy/scripts/tests/{lib.sh,run-all.sh,test-service-state.sh,test-check-env.sh,test-restore-data.sh}`
- 수정: `deploy/scripts/build-release.sh`(`--first-install`, 공용 상태 확인), `deploy/scripts/backup-data.sh`(공용 상태 확인·순서), `deploy/scripts/check-env.sh`(문법·정규 경로, `CS_DATA_ROOT`·`CS_ENV_OWNER_MODE` 시험용 바꿔치기), `deploy/README_KO.md`(§3 first-install·상태 판정, §4 문법, §8 되돌리기 재작성, §10), `apps/web/lib/inline-timer.ts`(코드 3개), `apps/web/lib/inline-timer.test.ts`, `tests/integration/inline-worker-timer.test.ts`(FIX2 describe 4개)
- 시험 전용 바꿔치기 변수(운영에서 설정하지 않음): `CS_SYSTEMCTL`, `CS_MOUNTPOINT_CMD`, `CS_TEST_SKIP_CHOWN`, `CS_ENV_OWNER_MODE`, `CS_DATA_ROOT`/`CS_DATA_PARENT`/`CS_BACKUP_DIR`/`CS_REPO_ROOT`/`CS_SERVICE_USER`. `CS_TEST_SKIP_CHOWN=1` 은 root 소유자 지정을 건너뛴다 — Windows Git Bash 에서 `install -d -m 700` 이 실패해 그 분기만 `mkdir`+`chmod` 를 쓴다.

## 실행한 명령과 결과
- 재현: 위 절(수정 전 스크립트 45 실패, `.handoffs/fix2-t21p2-repro-deploy.log`).
- 개발 중: `vitest run --project integration tests/integration/inline-worker-timer.test.ts` → 17 passed(약 57초; FIX2 describe 4개 포함. 처음 승인 철회 시험이 `approval_missing` 을 기대해 실패 → 실제는 A10 즉시 BLOCKED 의 `approval_revoked` 라 기대값을 고침, 코드 변경 없음). `vitest run --project unit apps/web/lib/inline-timer.test.ts` → 22 passed. `deploy/content-studio.env.example` 을 시험 경로로 바꿔 check-env 실행 → OK.
- `bash deploy/scripts/tests/run-all.sh` → `.handoffs/checks-FIX2-T21P2.deploy-tests.log`: bash -n 전부 ok, test-check-env 46 passed(심볼릭 링크 시험 포함 — SKIP 없음), test-restore-data 27 passed, test-service-state 43 passed, **DEPLOY-SCRIPT-TESTS: PASS**(exit 0, 약 8분).
- `bash .handoffs/run-checks.sh FIX2-T21P2` → `.handoffs/checks-FIX2-T21P2.log`: LINT=0, TYPECHECK=0, BUILD=0, UNIT=0(61 files / 1466 passed), **INTEG=1**(워커 종료 2147483651 — 미변경 `threads.test.ts`·`collector.test.ts`·`migration-0003-guard.test.ts`, 39/42 files), DRILL=0(불변식 위반 0건), MIGRATE=0, DRILL_RESTORE=0(PASS), CHECKS-DONE.
- 규칙대로 통합만 재실행: `corepack pnpm exec vitest run --project integration --maxWorkers=2` → **42 files / 833 passed, exit 0**(`.handoffs/checks-FIX2-T21P2.integ2.log`).

## 남은 위험·미검증(FIX2)
1. 스크립트는 가짜 systemctl·mountpoint·id 로만 시험했다. 실제 systemd(`show --value` 출력, `list-unit-files --type=service` 형식)와 util-linux `mountpoint` 종료 코드(32)는 문서 기준이며 실 Linux 에서 확인하지 않았다. shellcheck 미실행(설치 안 됨).
2. check-env 의 좁은 문법은 systemd 가 받아들이는 일부 정상 형식(따옴표 값 등)도 거부한다 — 의도(검사기와 systemd 가 다르게 읽을 여지를 없앰). systemd 버전별 EnvironmentFile 해석 차이는 조사하지 않았다.
3. restore-data 의 마운트 지점 경로는 내용을 지운 뒤 사본을 푼다. 풀기가 중간에 실패하면 폴더가 일부만 남는다 — 바로 앞에 만든 `data-before-restore-*.tar.gz` 로 다시 restore-data 를 돌려야 한다(README 에 명시하지 않음 → Codex 판단 요청).
4. 이 PC 에서 deploy 시험 전체가 약 8분 걸린다(Git Bash 프로세스 생성 비용). Linux 에서는 짧을 것으로 보지만 측정하지 않았다.
5. 공급자 볼륨 스냅숏 절차는 공급자를 정하지 않아 일반 단계만 적었다.

## Codex 재검증 질문
1. `require_service_stopped` 의 판정(LoadState·ActiveState 각각 조회 성공 확인, inactive/failed 만 진행, not-found 는 `--first-install` + list-unit-files 성공·부재)이 놓치는 상태가 있는가(예: `maintenance`, 템플릿 unit)?
2. check-env 문법 제한이 systemd 가 적용하는데 검사기는 무시하는 할당을 모두 막는가? 주석 줄(`#` 시작만 허용, `;` 주석은 거부)의 처리는 적절한가?
3. 정규 경로 검사(루트 `realpath -e`, 값 `realpath -m`, 기존 부모 `realpath -e`)에 남은 우회(검사 후 링크 교체 같은 TOCTOU 제외)가 있는가?
4. restore-data 의 마운트 지점 처리(내용 삭제 → 풀기)와 사본 경로 검사(`data/` 아래·`..`·절대 경로 거부)가 충분한가? 위험 3 을 문서화만 할지, 풀기를 임시 폴더에 먼저 하고 옮기는 방식으로 바꿔야 하는가?
5. 시험 전용 바꿔치기 변수가 운영에서 잘못 설정될 때의 위험(특히 `CS_TEST_SKIP_CHOWN`, `CS_ENV_OWNER_MODE`)을 막아야 하는가?


### FIX round 2 — 오케스트레이터 기록
- FIX2 HEAD: 69bf4b01933163fcf778a5667e725b8c1cc08f20 (code only). BASE 8e1e8e4(+ docs eae0d1e).
- checks-FIX2-T21P2: lint·typecheck·build 0 · unit 1466 · integration 1회차 1(손대지 않은 파일 워커 exit 2147483651) → maxWorkers=2 재실행 42 파일 · 833 통과 · drill · migrate · restore PASS. 배포 스크립트 bash 시험 116/116(가짜 명령, 실제 Linux 미실행).
- 오케스트레이터 추가: deploy/README_KO.md §8 에 "복원 도중 실패" 시 직전 tar 로 restore-data.sh 재실행 안내 1줄.


---

# FIX round 3 — Codex review-FIX2-T21P2(CHANGES_REQUESTED, 리뷰 대상 69bf4b0) 반영

- 리뷰: `.handoffs/review-FIX2-T21P2.md`(P0 2 · P1 1 · P2 1 + 질문 답의 데이터 루트 링크·시험용 변수). 오케스트레이터 지시 6항목.
- BASE_SHA: 9d107ab(69bf4b0 + docs). HEAD_SHA: **없음(미커밋)** — 커밋·`git add -A` 안 함. `.claude/`·docs/handoffs/*·DECISIONS.md 수정 없음. 앱 코드(TypeScript) 변경 없음 — 배포 스크립트·시험·README 만.

## 재현(수정 전 스크립트에서 실패)
새·고친 bash 시험을 **수정 전** 스크립트에 먼저 돌렸다 → `test-fix3.sh` 21 실패, `test-restore-data.sh` 19 실패(로그 `.handoffs/fix3-t21p2-repro-deploy.log`).
- (4) 큰 unit 목록(20만 줄) 맨 앞에 `content-studio.service` 가 있어도 `--first-install` 이 **진행**됨 — `printf | awk | grep -Fqx` 가 pipefail 에서 SIGPIPE 로 실패해 "없음"이 됨(지적 그대로 재현).
- (5) 데이터 루트·데이터 폴더가 링크여도 check-env OK, backup-data 가 링크만 담은 사본 생성, restore-data 가 링크 대상에 복원.
- (6) 표식 없이 `CS_ENV_FILE`·`CS_ENV_OWNER_MODE`·`CS_TEST_SKIP_CHOWN`·`CS_SERVICE_USER` 등을 주면 그대로 적용(check-env OK, backup·restore 실행).
- (1) 사본 안 심볼릭 링크(`data/link → 밖`)·최상위 `data` 링크·하드링크 항목을 복원함.
- (3) 교체 도중 실패를 흉내 내도(가짜 mv) 성공으로 끝남(되돌림 없음), `--data-missing-ok` 없음.
- (2) "같은 초 두 번" 시험은 수정 전에도 통과했다 — Git Bash 가 느려 두 실행이 다른 초에 걸렸기 때문(결정적 재현 아님). 새 코드는 시각과 무관하게 `mktemp` 로 보장.

## 지적 → 변경 → 시험
| 지적 | 변경 | 시험 |
| --- | --- | --- |
| **P0** restore-data.sh:31 링크·특수 항목 복원 | 재설계: ① `tar -tzf`(이름)·`tar -tvzf | cut -c1`(형식)을 받아 항목 수가 같은지 확인, 형식은 `-`·`d` 만(링크 `l`·하드링크 `h`·장치·FIFO 거부), 이름은 `data` 또는 `data/…`, 각 경로 칸이 비거나 `.`·`..` 이면 거부, 최상위 `data` 는 `d` — 아무것도 바꾸기 전. ② 같은 파일 시스템의 새 임시 폴더(`mktemp -d`: 일반 폴더면 데이터 부모 안, 마운트 지점이면 마운트 안)에 `--no-same-owner` 로 풀기. ③ 풀고 나서 `find ! -type f ! -type d` 0개·최상위는 실제 폴더 `data` 하나인지 다시 확인. ④ 소유자(`chown -R -h`)·700 은 이 확인 뒤에만. 데이터 폴더·부모가 링크면 시작 전에 거부 | `test-restore-data.sh`: 사본 안 심볼릭 링크 → 풀기 전 거부·링크 대상 권한·내용 그대로·임시 폴더 없음, 최상위 data 링크 → 거부, 하드링크 항목(이 PC 에서 `h` 항목 생성 확인) → 거부, `data/` 밖 경로·최상위가 data 아님 → 거부 |
| **P0** restore-data.sh:45 직전 사본 덮어쓰기 | 직전 사본을 `mktemp --suffix=.tar.gz "$BACKUP_DIR/data-before-restore-<시각>.XXXXXX"` 로 **배타적 생성**(0600), 입력 사본과 정규 경로가 같으면 중단. backup-data 사본도 같은 방식(`data-<시각>-<SHA>.XXXXXX.tar.gz`). 사본에는 남은 임시 폴더(`data/.restore-stage.*`·`.restore-rollback.*`)를 넣지 않음 | 연속 두 번 → 직전 사본 2개, 첫 직전 사본을 입력으로 세 번째 실행 → 입력 파일 cksum 그대로·old 내용으로 복원·직전 사본 3개. backup-data 두 번 → 사본 2개 |
| **P1** restore-data.sh:26 실패 후 재실행 불가 | 일반 폴더: `data` → `data.replaced-<시각>.<고유>/data`(mktemp -d 안) → 임시 `data` 를 `mv -T` 로 제자리. 둘째 단계 실패 시 **옮겨 둔 폴더를 되돌리고** 실패 종료(메시지 "되돌렸습니다"). 마운트 지점: 확인이 끝난 뒤에만 내용(임시 폴더 제외) 삭제 → 임시 `data` 내용 이동, 실패하면 **직전 사본을 임시 폴더에 풀고 검증한 뒤 자동 복구**("직전 사본으로 복구했습니다"). 데이터 폴더가 없는 상태는 `--data-missing-ok` 로만(폴더가 있으면 그 표시를 거부). 임시 폴더는 trap 으로 항상 정리. README §8 을 단계 표 + 실패 시 재실행·`--data-missing-ok` 절차로 다시 씀 | 가짜 mv(`STUB_MV_FAIL_ON=.restore-stage`)로 일반 폴더 교체 실패 → 이전 데이터로 되돌림·임시 폴더 정리, 마운트 지점 채우기 실패 → 직전 사본으로 복구·하위 폴더 복구, 데이터 폴더 없음 + 표시 없음 → 중단(안내에 `--data-missing-ok`), 표시 있음 → `mode=missing` 복원, 폴더가 있는데 표시 → 중단 |
| **P2** common.sh:34 `grep -q` + pipefail | `list-unit-files` 출력 전체를 먼저 받아 그 명령의 종료 코드로 "조회 실패"(중단)를 가르고, 줄 맨 앞 정확 일치는 bash 패턴(`$'\n'"$list" == *$'\n'"$unit"[[:space:]]*`)으로 — 파이프 없음. ActiveState 조회만 실패해도 중단(기존 동작, 시험 추가) | `test-fix3.sh`: 20만 줄 목록 맨 앞에 있으면 중단("unit 파일이 있습니다"), 목록에 없으면 진행, LoadState 성공 + ActiveState 실패 → 중단 |
| 데이터 루트 링크(Codex 질문 3) | check-env: 데이터 루트 자체가 링크면 거부. backup-data·restore-data: 데이터 폴더가 링크면 거부 | `test-fix3.sh`(5): check-env 링크 루트 거부 / 같은 내용 실제 폴더는 OK(대조), backup-data 거부·사본 없음, restore-data 거부·링크 대상 그대로 |
| 시험용 변수(Codex 질문 5) | `lib/common.sh` `cs_test_mode`: `CS_DEPLOY_TEST_HARNESS=1`(정확히 1) **그리고** `$EUID ≠ 0`(bash 내장 — PATH 의 가짜 id 로 속일 수 없음)일 때만 `cs_opt` 가 `CS_*` 를 적용. 운영(표식 없음 또는 root)에서는 운영 기본값. `require_root` 도 같은 규칙(시험 실행에서만 건너뜀). 모든 스크립트의 `${CS_…:-…}` 를 `cs_opt` 로 바꿈(grep 으로 남은 것 0 확인). 표식은 `tests/lib.sh` 가 export | `test-fix3.sh`(6): 표식 있으면 check-env OK(대조) / 표식 없으면 `/etc/content-studio/env` 를 봄 / 표식 값 `yes` 도 무시 / backup-data·restore-data 표식 없으면 "root 로 실행"·사본 없음·데이터 그대로 / build-release 표식 없으면 운영 사용자 `content-studio` 요구 |

## 바뀐 파일(FIX3)
- `deploy/scripts/lib/common.sh`(cs_test_mode·cs_opt·require_root·make_backup_dir, 목록 검색), `deploy/scripts/restore-data.sh`(재작성), `deploy/scripts/backup-data.sh`(링크 거부·고유 이름·cs_opt), `deploy/scripts/check-env.sh`(common.sh 사용·cs_opt·루트 링크 거부), `deploy/scripts/build-release.sh`(cs_opt)
- 시험: `deploy/scripts/tests/lib.sh`(표식 export, 가짜 mv·큰 목록·ActiveState 실패 옵션), `test-restore-data.sh`(재작성), 신규 `test-fix3.sh`
- 문서: `deploy/README_KO.md`(§4 루트 링크, §7-2 사본 이름, §8 재작성)

## 실행한 명령과 결과
- 재현: 위 절(수정 전 스크립트 40 실패, `.handoffs/fix3-t21p2-repro-deploy.log`).
- 개발 중: `bash deploy/scripts/tests/test-restore-data.sh` 64 passed, `bash deploy/scripts/tests/test-fix3.sh` 30 passed(심볼릭 링크·하드링크 시험 실제 실행 — SKIP 없음). 모든 스크립트 `bash -n` OK, 스크립트에 남은 `${CS_…}` 직접 참조 0(grep).
- `bash deploy/scripts/tests/run-all.sh` → `.handoffs/checks-FIX3-T21P2.deploy-tests.log`: test-check-env 46 · test-fix3 30 · test-restore-data 64 · test-service-state 43 = **183 passed, 0 failed, SKIP 없음**, `DEPLOY-SCRIPT-TESTS: PASS`(exit 0).
- `bash .handoffs/run-checks.sh FIX3-T21P2` → `.handoffs/checks-FIX3-T21P2.log`: LINT=0, TYPECHECK=0, BUILD=0, UNIT=0(61 files / 1466 passed), **INTEG=1**(워커 종료 2147483651 — 미변경 `migration-0023.test.ts`·`secrets-cli.test.ts`, 40/42 files), DRILL=0(불변식 위반 0건), MIGRATE=0, DRILL_RESTORE=0(PASS), CHECKS-DONE.
- 규칙대로 통합만 재실행: `corepack pnpm exec vitest run --project integration --maxWorkers=2` → **42 files / 833 passed, exit 0**(`.handoffs/checks-FIX3-T21P2.integ2.log`).

## 남은 위험·미검증(FIX3)
1. 실제 Linux·systemd·util-linux·GNU tar 에서 실행하지 않았다(가짜 systemctl·mountpoint·mv 와 Windows Git Bash 의 GNU tar/coreutils 로만). 장치·FIFO 항목 시험은 이 PC 에서 만들 수 없어 하지 않았다(형식 문자 검사로 거부하는 코드 경로는 링크·하드링크와 같다).
2. 마운트 지점 복원은 내용 삭제 → 이동 사이에 전원이 끊기면 내용이 불완전할 수 있다(직전 사본은 남아 있음). 하위 마운트(마운트 안 또 다른 마운트)는 고려하지 않았다 — `find -exec rm -rf` 가 그 안도 지운다.
3. 일반 폴더 교체의 두 `mv` 사이(아주 짧은 순간)에 프로세스가 죽으면 데이터 폴더가 없을 수 있다 — `data.replaced-*/data` 를 되돌리거나 `--data-missing-ok` 로 복원(README §8).
4. `cs_test_mode` 는 `$EUID` 를 믿는다. 운영에서 서비스 사용자(비 root)로 도는 build-release 에 누군가 `CS_DEPLOY_TEST_HARNESS=1` 을 일부러 주면 바꿔치기가 적용된다(표식은 운영 문서·unit 에 없음).
5. 이 PC 에서 deploy 시험 전체가 수 분 걸린다(Git Bash 프로세스 생성 비용).

## Codex 재검증 질문
1. 사본 검사(`tar -tv` 첫 글자 형식 + 이름 칸 검사 + 풀고 난 뒤 `find`)가 GNU tar 의 모든 항목 형식(예: sparse, 긴 이름 확장 헤더, `--` 로 시작하는 이름)에서 맞게 동작하는가? 이름과 형식 목록의 줄 수 일치 확인이 줄바꿈이 든 이름에서도 안전한가(tar 는 기본으로 이스케이프한다고 보았다)?
2. 일반 폴더 교체(같은 파일 시스템의 `mv -T` 두 번 + 되돌림)와 마운트 지점 교체(삭제 → 이동, 실패 시 직전 사본 자동 복구)의 실패 처리에 빠진 분기가 있는가?
3. `--data-missing-ok` 를 표시 방식(자동 감지 아님)으로 둔 선택이 적절한가?
4. `cs_test_mode`(표식 + `$EUID ≠ 0`)가 운영 진입점에서 바꿔치기를 충분히 막는가, 아니면 시험 훅을 모두 PATH 가짜 명령으로 옮겨야 하는가?
5. bash 패턴 기반 unit 목록 검색(`*$'\n'"$unit"[[:space:]]*`)이 실제 `systemctl list-unit-files --no-legend` 출력 형식과 맞는가?


### FIX round 3 — 오케스트레이터 기록
- FIX3 HEAD: 4e3490ac3d71b48ea94f1309f392e6a124c6e142 (deploy 스크립트·시험·README 만). BASE 9d107ab(+ docs e643d0e).
- checks-FIX3-T21P2: lint·typecheck·build 0 · unit 1466 · integration 1회차 1(손대지 않은 파일 워커 exit 2147483651) → maxWorkers=2 재실행 42 파일 · 833 · drill · migrate · restore PASS. 배포 bash 시험 183 통과(장치·FIFO 항목은 이 PC 에서 만들 수 없어 미실행).
