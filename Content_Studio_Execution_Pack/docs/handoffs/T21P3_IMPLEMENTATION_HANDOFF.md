# Implementation handoff — T21-P3 (G4: 공개 /api/health 부작용·노출 제거)

- Task ID / milestone: T21-P3 (docs/handoffs/T21_DEPLOY_REVIEW.md §2 G4 차단 항목), M4 브랜치 `content-studio/m4`
- Purpose and changed behavior:
  - 공개 `GET /api/health`(로그인 없음)는 **생존 여부만** 반환한다. 응답 키는 정확히 `{status:'ok'|'degraded', app, time_utc, db_ok}` (ok 200, degraded 503, `cache-control: no-store`).
  - 공개 health 는 **worker tick 을 실행하지 않는다**(업로드 만료 정리·전사·배포 작업·연결 정보 갱신·수집 모두 없음). 이전에는 `runInlineWorker` 로 요청마다 tick(배포 작업 최대 5개)을 돌렸다.
  - 모드·llm/stt 준비 상태(빠진 조건 이름)·version·DB driver/migrated·worker 정보는 새 **`GET /api/health/details`(로그인한 owner 만, 없으면 401)** 로 옮겼다. details 는 **읽기 전용(tick 없음)**, `worker.last_tick_utc` 는 프로세스의 마지막 tick 시각만 보여 준다.
  - 설정 오류(config_invalid)는 이전 500 + `error:'config_invalid'` 에서 503 `degraded` + 4개 키로 바꿨다(변수 이름·값 없음, 서버 로그엔 `[health] config_invalid` 종류만).
  - `POST /api/worker/tick` 은 이미 `assertSameOrigin` + `requireOwner`(세션 필수)였다 — 코드 변경 없음, 세션 없음·위조 세션 401 + 작업 무변경 테스트를 추가.
  - `GET /api/transcription-jobs` 는 이미 `requireOwner`(세션 필수) — 동작 유지(로그인한 요청에서 inline tick 1회).
- 설계 선택: **별도 경로(`/api/health/details`)**. 이유 — 프록시가 경로 단위로 `/api/health` 만 외부에 열어도 자세한 상태가 새지 않고, 같은 경로에서 쿠키 유무로 응답 모양이 바뀌는 캐시·프록시 혼동이 없다. details 에서 tick 을 돌리지 않은 이유 — GET 은 상태를 바꾸지 않는다(docs/04 원칙), 쿠키가 실리는 교차 사이트 GET 으로 처리가 유발되지 않게.
- BASE_SHA: 4b9c69c (`git log --oneline -1` 시작 시점)
- HEAD_SHA: 449da0f6240eb68af143d4def699428cfd699614 (code only, D28 — 오케스트레이터 커밋)
- Clean tracked tree confirmed: 아니오 — 아래 파일이 미커밋 변경. `.claude/` 는 손대지 않음(원래부터 untracked).
- Relevant acceptance IDs: T21_DEPLOY_REVIEW G4, D23(e)·D30-3(운영 숫자 비노출 유지)
- Changed files:
  - `apps/web/app/api/health/route.ts` — 공개 생존 확인으로 축소(tick·모드·버전·driver·worker 제거)
  - `apps/web/app/api/health/details/route.ts` (신규) — 로그인 owner 전용 자세한 상태, 읽기 전용
  - `apps/worker/src/index.ts` — 주석만(inline tick 호출 경로 설명 갱신)
  - `README_KO.md` — health/details 계약, inline 처리 주기(공개 health 가 더 이상 처리 주기 아님) 문구 갱신(133·282·309·312·362·412~413·531행 부근)
  - `docs/04_DATA_AND_API.md` — 내부 HTTP API 표에 health(공개 예외)·health/details·worker/tick 행 추가
  - `tests/integration/health.test.ts` — 재작성(아래 표)
  - `tests/integration/budget-claims.test.ts`, `live-llm.test.ts`, `uploads-transcription.test.ts`, `ops-retention.test.ts` — llm/stt/db/worker 단언을 로그인한 details 로 이동(단언 그대로) + 공개 health 에 해당 키가 없다는 단언 추가
  - `tests/integration/jobs.test.ts` — 세션 없음·위조 세션 tick 401 + 공개 health 3회 후에도 두 owner 의 작업 QUEUED·이력 수 불변
  - `tests/integration/youtube.test.ts` — 시험 이름 문자열만(“health·목록” → “로그인한 목록 조회”)
- 변경 → 시험 대응:

| 변경 | 시험 |
| --- | --- |
| 공개 health 키 정확히 4개(ok) | health.test "200 생존 여부만…", ops-retention "공개 /api/health(ok) 는 생존 키만" |
| 공개 health degraded(DB 실패·설정 오류)도 4개 키, 오류 내용 없음 | health.test "degraded(DB 열기 실패 → 503)…", "설정 오류도 503 degraded…" |
| 공개 health 가 값·모드·driver·worker 미노출 | health.test "환경변수 값…", budget-claims·live-llm·uploads-transcription 의 공개 health 단언 |
| 공개 health tick 없음 | health.test "T21-P3: 공개 health 는 worker tick 을 돌리지 않는다" — QUEUED 배포 작업 1개를 만든 뒤 공개 health 3회 → `getLastTick()` 동일, jobs·job_events·send_intents·publications·transcription_jobs·upload_sessions·usage_ledger·audit_events·oauth_credentials·collector_runs 행 스냅숏 동일, 작업 QUEUED. **대조**: 로그인한 `GET /api/transcription-jobs` 뒤엔 last tick·스냅숏이 바뀜(스냅숏이 변화를 잡는다는 증거). jobs.test 에서도 공개 health 후 두 owner 작업 QUEUED·이력 수 불변 |
| details 세션 필수 | health.test "세션 없음·잘못된 세션 → 401, 자세한 상태 키 미노출" |
| details 내용(모드·DB·worker·llm·stt) 및 운영 숫자 없음 | health.test "로그인: 기본 모드…", ops-retention "T21-P3: 로그인 뒤 GET /api/health/details…", budget-claims·live-llm(llm), uploads-transcription(stt) |
| details 읽기 전용 | health.test 부작용 시험 안에서 details 호출 후에도 last tick·스냅숏 동일 |
| worker/tick 인증 | jobs.test 기존 anon 401 + 위조 세션 401 추가, 두 경우 모두 작업 상태·이력 수 불변 |

- Migrations / restore implications: 없음(스키마·export/restore 무변경).
- Actual commands and results (이 PC, port 3000 LISTEN 없음 확인 후):
  - 개발 중: `corepack pnpm exec vitest run --project integration tests/integration/health.test.ts` → 1 file, 7 passed
  - 개발 중: `corepack pnpm exec vitest run --project integration --maxWorkers=2 <health·budget-claims·live-llm·uploads-transcription·ops-retention·jobs>` → 6 files, 231 passed
  - `bash .handoffs/run-checks.sh T21P3` → `.handoffs/checks-T21P3.log`: LINT=0, TYPECHECK=0, BUILD=0, UNIT=0 (57 files / 1411 passed), INTEG=0 (37 files / 793 passed), DRILL=0 (불변식 위반 0건), MIGRATE=0, DRILL_RESTORE=0 (PASS), CHECKS-DONE. 통합 재실행 필요 없었음(worker 2147483651·타임아웃 없음).
- Demo route / local start steps: `pnpm dev` 후 `curl http://localhost:3000/api/health` → 4개 키. 로그인 후 브라우저에서 `/api/health/details`. (이번 작업에서 dev 서버는 띄우지 않았다 — 실제 화면 관찰 없음.)
- External calls performed: 없음.
- Mock-only functionality: 변화 없음(inline tick 의 배포 처리는 여전히 모의 어댑터).
- Known risks / not run:
  1. **동작 변경**: 이전에는 외부 모니터가 `/api/health` 를 주기 호출하면 inline 모드에서 배포 작업·만료 정리·연결 정보 갱신·주기 수집이 돌았다. 이제 inline 처리는 로그인한 "작업 처리 실행"(`POST /api/worker/tick`)과 전사 목록 조회(`GET /api/transcription-jobs`)에서만 돈다. 화면은 `/api/health` 를 부르지 않으므로(grep 확인) UI 영향은 없지만, 예약 시각이 된 배포 작업·`RETENTION_SWEEP_MODE=auto`·`COLLECTOR_SCHEDULER=on`·만료 임박 연결 정보 갱신은 사용자가 위 경로를 쓰기 전까지 진행되지 않는다. 운영(T21)에서는 로그인 없는 자동 주기가 필요하면 별도 worker 프로세스(postgres) 또는 내부 전용 주기 장치가 필요 — 결정 대상.
  2. `GET /api/transcription-jobs` 는 로그인 필수지만 **GET 이 tick(전 owner 대상 runWorkerTick)을 실행**하는 기존 동작이 남아 있다(docs/04 "GET으로 상태를 바꾸지 않는다"와 어긋남, 이번 범위에서 유지 지시). 세션 쿠키 SameSite 정책에 따라 교차 사이트 최상위 GET 으로 tick 이 유발될 수 있다.
  3. 공개 health 는 `getDb(config)` 를 부른다 — 프로세스 첫 요청이면 앱 공용 DB 연결을 열고 migration 을 적용한다(다른 경로 첫 요청과 같은 동작, 행 쓰기 없음). `db_ok` 는 "연결 핸들 획득"이며 쿼리 왕복 확인은 아니다.
  4. 공개 health 반복 호출 부하(요청 제한)는 여전히 앱 밖(프록시) 과제 — T21_DEPLOY_REVIEW §130 6번 그대로.
  5. details 는 DB 를 열 수 없으면 세션 검증 단계에서 500(일반 문구)이 된다 — degraded 표현은 공개 health 의 `db_ok:false` 가 담당.
  6. `docs/handoffs/LOCAL_RUNBOOK.md` 69행(“/api/health … db.captures 10, worker inline”)은 이미 낡은 기술이지만 지시에 따라 docs/handoffs/* 는 수정하지 않았다. `docs/DECISIONS.md` 도 수정하지 않음 — G4 처리 기록은 오케스트레이터 몫.
- Questions specifically for Codex:
  1. 공개 health 응답이 정확히 4개 키이고, ok·degraded(DB 실패)·config_invalid 세 경로 모두에서 tick·모드·버전·driver·worker·빠진 조건 이름이 새지 않는가?
  2. health.test 의 부작용 스냅숏(10개 표 + `getLastTick()`)이 inline tick 이 남길 수 있는 흔적을 충분히 덮는가? 빠진 표(예: oauth_pending_tokens, remote_steps, upload_chunks, collected_items)가 있으면 지적 바람. 대조 시험이 실제로 변화를 잡는 것도 확인 바람.
  3. `/api/health/details` 를 읽기 전용으로 둔 선택(tick 없음)과 그로 인한 inline 처리 주기 축소(위험 1)가 G4 의도와 맞는가, 아니면 details 가 tick 을 돌려야 하는가?
  4. `POST /api/worker/tick` 의 `assertSameOrigin` → `requireOwner` 순서·헤더 의존이 외부 무인증 호출을 확실히 막는가(위조 세션 401, 작업 무변경)?
  5. 테스트 이동에서 기존 단언이 약해진 곳이 있는가(budget-claims·live-llm·uploads-transcription·ops-retention·jobs)?
- Next authorized task: 오케스트레이터 지시 대기(T21 의 다른 G 항목 / D35 등).
