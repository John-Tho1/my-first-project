# Implementation handoff — LIVEP1-TIMEOUT (실제 Threads 게시가 한 번의 tick 안에 끝나게)
- Task ID / milestone: LIVEP1-TIMEOUT / M4 D38 후속.
- 배경(실제 실행): 작업 6e236a8f — 컨테이너 생성 ~5초 + 상태 확인 ~1.5초 → 게시 시도 표식 → threads_publish 전송 중 화면 폼 tick 의 10초 예산(`apps/web/app/api/worker/tick/route.ts` `uiTickTimeoutMs`)이 끝나 `submit_timeout` → RECONCILING → (목록은 후보만) UNKNOWN. 실제로는 게시됐다(사용자 확인).
- Purpose and changed behavior:
  1. **실제 어댑터 작업의 예산**: 작업 처리기 `budgetFor(adapter, opts)` — 실제(live) 어댑터는 `max(호출자 예산, LIVE_SUBMIT_BUDGET_MS = 60초)`(옵션 `liveSubmitTimeoutMs` 로 바꿀 수 있음 — 시험용), 모의는 호출자 예산 그대로(모의 시간 시험 불변). 전송(sendJob)과 조회(remoteCheck) 모두. 호출당 HTTP 시간 제한(10초)은 그대로. lease 는 heartbeat(쓰기·조회 전)로 연장된다.
  2. **표식 전 남은 시간 확인**: 작업 처리기가 `ctx.deadline`(이번 전송 마감, 실제 시계)을 넣고, 실제 어댑터는 게시 시도 표식을 쓰기 **전에** 남은 시간 < 게시 호출 시간 제한(10초) + 여유(2초)이면 표식·게시 없이 `rejected / transient_no_side_effect / publish_budget_insufficient`(보내지 않음 → RETRY_WAIT). 다음 시도는 기록된 FINISHED 컨테이너로 바로 게시(새 컨테이너 없음). 앞 단계 지연 때문에 마감이 표식과 threads_publish 사이에서 터져 결과 불명이 되는 경우를 없앤다(그 밖의 결과 불명 규칙은 그대로).
  3. 화면 tick 버튼 안내에는 10초 문구가 없어 바꾸지 않았다. tick route 머리 주석에 실제 작업 예산을 적었다.
- 대안(폼 tick 이 먼저 응답하고 작업은 뒤에서 계속)은 쓰지 않았다 — Next route handler 에서 응답 뒤 작업을 안전하게 이어 가는 보장이 없고(요청 수명·프로세스), 예산 변경이 더 단순하다. 대신 화면 버튼은 실제 작업이 있으면 최대 약 60초 걸릴 수 있다.
- BASE_SHA: 3e21561
- HEAD_SHA: 98f11cd349d67606b94bad924edc214dc11076b4 (LIVEP1-TIMEOUT) · FIX-LIVEP1-TIMEOUT HEAD e708106cbb90b1e864926f2ae68a482a2076df64
- Clean tracked tree confirmed: 시작 시 yes(`?? .claude/` 만).
- External calls performed: **none**(주입 fixture fetch·전역 fetch stub, 지연은 setTimeout). `.env.local`·`./data` 열지 않음, db:migrate·drill:restore 없음, dev 서버 시작 안 함, 내가 띄운 프로세스만.

## 시험(먼저 실패 확인 → 수정 → 통과)
| 시험 | 수정 전 | 수정 뒤 |
|---|---|---|
| 단위 `threads-live-publish.test.ts` 「남은 시간이 … 적으면 표식 전에 멈춘다」: 마감 5초 → `publish_budget_insufficient`, threads_publish 0, 단계는 container:finished 만, 다음 시도(60초)는 같은 컨테이너로 게시(컨테이너 생성 1번) | FAIL(표식 쓰고 게시함 — `.handoffs/checks-LIVEP1TIMEOUT.repro-unit.log`) | PASS |
| 단위 「충분하거나 마감 없음 → 그대로 게시」 | PASS | PASS |
| 통합 `live-threads-publish.test.ts` 「화면 버튼(폼 tick, 10초 예산): 컨테이너 5초 + 상태 1.5초 + 게시 3초 + 읽기 1초 → 한 번에 CONFIRMED」(실제 tick route, 전역 fetch stub 지연, 소요 > 10초 단언) | FAIL — RECONCILING(실제 사고 재현, `.handoffs/checks-LIVEP1TIMEOUT.repro-integ.log`) | PASS — CONFIRMED, VERIFIED, threads_publish 1 |
| 통합 「남은 예산 < 게시 호출 + 여유 → 표식 전에 멈춤 → RETRY_WAIT → 다음 시도 CONFIRMED」(예산 13초, 컨테이너 5초) | FAIL — RECONCILING | PASS — 1차 threads_publish 0·단계 container:finished, 2차 같은 컨테이너로 게시(컨테이너 생성 1번·게시 1번) |
| 기존 결과 불명 시험(시간 초과·5xx·429·표식 뒤 저장 실패 등) | — | 변경 없이 PASS |
- 지연 1+1.5+3+5 초를 실제 시간으로 기다린다(가짜 타이머는 PGlite·fetch 경로와 섞여 쓰지 않음) — 통합 시험 파일이 약 20초 늘었다.

## 변경 파일
- `packages/domain/src/live-publish.ts` — `LIVE_SUBMIT_BUDGET_MS`(60초)·`LIVE_PUBLISH_BUDGET_MARGIN_MS`(2초)
- `packages/domain/src/jobs.ts` — `AdapterContext.deadline`
- `packages/providers/src/threads-live-publish.ts` — 표식 전 남은 시간 확인(`publish_budget_insufficient`)
- `packages/db/src/jobs.ts` — `JobRunOptions.liveSubmitTimeoutMs`, `budgetFor`(전송·조회), `ctx.deadline`
- `apps/web/app/api/worker/tick/route.ts` — 주석
- 시험: `packages/providers/src/threads-live-publish.test.ts`(+2), `tests/integration/live-threads-publish.test.ts`(+2, fixture 응답 타입이 Promise 도 받게)

## 실행한 명령과 결과
(Windows 10, Git Bash, `source tools/env.sh`, Node 24.21.0, `corepack pnpm`, dev 서버 꺼짐. ./data 를 여는 db:migrate·drill:restore 는 뺀 같은 순서 — 로그 `.handoffs/checks-LIVEP1TIMEOUT*.log`)
| 명령 | 결과 |
|---|---|
| 새 단위 시험 + 수정 전 어댑터 | FAIL 1/71(`repro-unit.log`) — 재현 |
| 새 통합 시험 + 수정 전 코드 | FAIL 3/20 — 새 2개(RECONCILING) + 그 작업이 남아 뒤 동시 실행 시험에 섞임(`repro-integ.log`) — 재현 |
| 수정 뒤 두 파일 | PASS 71/71 · 20/20(시험 fixture 응답 타입 1곳 수정 — Promise 응답 허용) |
| `corepack pnpm lint` · `typecheck` · `build` | PASS · PASS · PASS |
| `corepack pnpm test`(unit) | PASS — 68 files, 1649 tests |
| `corepack pnpm test:integration` | PASS — 47 files, 899 tests(워커 충돌 없음) |
| `corepack pnpm drill:mock` | PASS — "불변식 위반 0건"(모의 시간 동작 그대로) |
| `db:migrate` · `drill:restore` | not_run(./data 금지) |

## Known risks / not run
1. 실제 Threads 지연이 60초 예산을 넘으면(게시 호출이 10초 제한에 걸리면) 여전히 결과 불명 → UNKNOWN(설계대로 — 재게시 없음). 예산·여유 값은 실제 1회 관찰(컨테이너 ~5초·상태 ~1.5초) 기준.
2. 화면 버튼·inline tick 요청이 실제 작업이 있을 때 최대 약 60초 걸릴 수 있다(브라우저·프록시 시간 제한이 더 짧으면 응답이 끊길 수 있음 — 작업 자체는 서버에서 계속되고 상태는 DB 기준).
3. 남은 시간 판단은 실제 시계(Date.now) 기준 — 작업 처리기 시계 주입(clock)과는 별개.
4. 6e236a8f(이미 UNKNOWN)는 이 변경으로 바뀌지 않는다 — 사용자 확인 기록대로 둔다.

## Questions specifically for Codex
1. 실제 작업만 예산을 늘리는 `budgetFor`(모의는 그대로)와 표식 전 남은 시간 확인(여유 2초)이 "표식 뒤 마감 → 결과 불명"을 앞 단계 지연에 의해서는 만들지 않게 하는가? 남은 경로(게시 호출 자체가 10초를 넘는 경우)는 결과 불명이 맞는가?
2. 화면 요청이 길어지는 것(최대 약 60초) 대신 응답을 먼저 돌려주는 방식이 필요한가?

---

# FIX-LIVEP1-TIMEOUT (Codex review-LIVEP1-TIMEOUT — CHANGES_REQUESTED on 98f11cd, P1 1)
- 판정 원본: `.handoffs/review-LIVEP1-TIMEOUT.md`
- BASE_SHA: 98f11cd (작업 트리는 09ba025 위) · HEAD_SHA: uncommitted — orchestrator commits
- 범위: 실제 Threads·Meta 요청 0(주입 fixture fetch·전역 fetch stub), `.env.local`·`./data` 손대지 않음, db:migrate·drill:restore·dev 서버 없음, migration·의존성 추가 없음, 내가 띄운 프로세스만 다룸. `packages/db/src/jobs.ts`(budgetFor) 변경 없음.

## 지적 → 시험(재현) → 변경
| 지적 | 재현(수정 전 어댑터로 먼저 실패) | 변경 |
|---|---|---|
| **[P1] threads-live-publish.ts:455** 남은 시간 검사 뒤 `#beforeWrite`(heartbeat)·표식 저장이 게시 호출 몫을 먹어 표식 뒤 마감 → 결과 불명 재발 가능 | 단위(`checks-FIX-LIVEP1TIMEOUT.repro-unit.log`, 4 실패): 시험용 게시 제한 300ms·표식 몫 200ms·마감 2.8초(옛 검사 필요 2.3초·새 검사 2.5초 모두 처음엔 통과) — ① heartbeat 600ms → 이전엔 표식·게시함 ② 표식 저장 600ms(몫 초과) → 이전엔 기다렸다 게시 ③ 표식 저장 멈춤 → 이전엔 마감까지 매달림 ④ 경계(시계 주입). 통합(`…repro-integ.log`, 2 실패, 작업 처리기 전체·실제 DB 단계 기록, 예산 3초): heartbeat 800ms → 이전엔 CONFIRMED(게시함), 표식 저장 멈춤 → 이전엔 RECONCILING(결과 불명) | 필요 남은 시간 = 게시 호출 제한 + **표식 저장 몫**(새 `LIVE_PUBLISH_MARKER_ALLOWANCE_MS` 3초) + 여유 2초(= 기본 15초). 검사를 **heartbeat 전과 뒤 두 번**(뒤 검사가 지연분을 반영 → `publish_budget_insufficient`, 표식·게시 없음 → RETRY_WAIT). 표식 저장은 몫 안에서만 기다린다(`Promise.race` + 타이머) — 넘으면 `rejected / transient_no_side_effect / publish_marker_slow`(이 실행은 게시하지 않음, 늦게 끝난 저장의 실패는 삼킴). 게시 요청은 표식 저장이 **끝난(resolve) 뒤에만** 보내고, 그 사이 중단 신호(lease 상실·마감)가 켜졌으면 보내지 않는다(abort → 기존 결과 불명 경로, 표식 있음 → 조회만). 시험용 옵션 `markerAllowanceMs`·`nowMs`(기본 상수·Date.now) |
| 놓친 케이스: 정확히 경계 | 단위(시계 주입): 남은 = 필요 정확히 → 게시, −1ms → 멈춤, heartbeat 가 시계를 5ms 밀면(여유 5) 게시·6ms 밀면 멈춤 | 비교는 `남은 < 필요` 면 멈춤(경계 포함 통과) |
| 놓친 케이스: 표식 저장 실패(예외) | 단위(수정 전에도 통과 — 기존 규칙 고정): 예외 그대로, 게시 0 | 변경 없음 |

## 좁힌 보장(주석·이 문서)
- 앞 단계·heartbeat·표식 저장 지연 때문에 "표식은 썼는데 마감이 게시 호출 중에 터지는" 일은 만들지 않는다: 표식 저장이 몫 안에 끝났다면 남은 시간 ≥ 게시 호출 제한 + 여유.
- 덮지 않는 것: (a) 게시 호출 자체가 제한(10초) 가까이 걸린 뒤의 처리(응답 본문 읽기·게시 단계 기록·읽기 확인)는 여유 2초로만 덮는다 — 게시 뒤 시간 초과는 여전히 결과 불명(설계대로, 재게시 없음). 게시 ID 를 받은 뒤 읽기 확인이 늦으면 마감 전 단계 기록이 끝났는지에 따라 found 또는 unknown(이번 변경 없음, 시험 없음). (b) 이벤트 루프가 막혀 타이머가 늦는 경우. (c) **표식 저장이 몫을 넘긴 뒤 늦게 커밋되면** 표식만 남고 게시는 없다 — 다음 시도는 기존 규칙(표식 있으면 같은 컨테이너로 재게시하지 않음)대로 `publish_attempt_unresolved` → 조회 → 확인 불가 3회 뒤 UNKNOWN. 중복 게시는 없지만 "깨끗한 재시도"는 아니다(사용자가 Threads 에서 없음을 확인 → 새 계획). 표식을 지우거나 "보내지 않음"을 따로 기록하는 장치는 만들지 않았다(migration·불변 규칙 변경 필요 — 범위 밖). 단위 시험이 이 경로를 고정한다. 저장이 끝나지 않거나(멈춤) 실패하면 표식이 없으므로 다음 시도가 같은 컨테이너로 게시(통합 시험).
- 그대로인 것(리뷰 "놓친 케이스" 중 이번 범위 밖): 조회 경로의 예산(`budgetFor` — 실제 조회도 60초, 모의 그대로), 한 tick 여러 실제 작업의 전체 요청 시간, lease 만료·다른 작업 처리기 복구와 겹침(heartbeat 실패 → LeaseLost → 표식 전이면 게시 없음, 표식 뒤면 조회만 — 기존 규칙), 조기 응답 방식(쓰지 않음).

## 바뀐 파일(FIX-LIVEP1-TIMEOUT)
- `packages/domain/src/live-publish.ts` — `LIVE_PUBLISH_MARKER_ALLOWANCE_MS`(3초)
- `packages/providers/src/threads-live-publish.ts` — 표식 전 두 번 검사(필요 = 게시 제한 + 표식 몫 + 여유), 표식 저장 몫 제한(`publish_marker_slow`), 표식 저장 뒤 중단 확인, 옵션 `markerAllowanceMs`·`nowMs`
- 시험: `packages/providers/src/threads-live-publish.test.ts`(+6), `tests/integration/live-threads-publish.test.ts`(+2 — heartbeat 지연·표식 저장 멈춤, 작업 처리기 전체)
- 기존 LIVEP1-TIMEOUT 시험(예산 13초 → 표식 전 멈춤, 폼 tick 실제 지연 → CONFIRMED)은 기대값 변경 없이 통과.

## 실행한 명령(FIX-LIVEP1-TIMEOUT)
(Windows 10, Git Bash, `export PATH="/usr/bin:/mingw64/bin:$PATH"; source tools/env.sh`, Node 24.21.0, `corepack pnpm`, dev 서버 시작 안 함. ./data 를 여는 db:migrate·drill:restore 는 뺐다 — 로그 `.handoffs/checks-FIX-LIVEP1TIMEOUT*.log`)
| 명령 | 결과 |
|---|---|
| `vitest run --project unit packages/providers/src/threads-live-publish.test.ts -t FIX-LIVEP1-TIMEOUT`(새 시험 + 수정 전 어댑터) | FAIL 4/6(`repro-unit.log`) — 재현 |
| `vitest run --project integration tests/integration/live-threads-publish.test.ts`(새 시험 + 수정 전 어댑터를 잠시 HEAD 판으로 되돌려) | FAIL 2/22(`repro-integ.log`) — CONFIRMED·RECONCILING, 되돌림 확인 |
| 같은 두 파일(수정 뒤) | PASS 77/77 · 22/22(통합 1회차는 시험 설정 오류 — 호출자 예산 5초가 실제 예산 3초보다 커서 지연 시험이 게시함 → 호출자 예산 1초로 고침, 수정 전 어댑터 재현도 고친 시험으로 다시 돌림) |
| `corepack pnpm lint` | PASS |
| `corepack pnpm typecheck`(1회차) | FAIL — 새 단위 시험의 `sleepMs` 반환 타입(`Promise<unknown>` → heartbeat `Promise<void>`) → `new Promise<void>` 로 고침(동작 같음) |
| `corepack pnpm build` | PASS |
| `corepack pnpm exec vitest run --project unit` | PASS — 69 files, 1705 tests |
| `corepack pnpm exec vitest run --project integration` | PASS — 49 files, 913 tests(워커 충돌 없음) |
| `corepack pnpm drill:mock` | PASS — "불변식 위반 0건" |
| 타입 수정 뒤 `typecheck` · `lint` · 어댑터 단위 파일 | PASS · PASS · PASS 77/77(시험 파일 타입만 바뀜 — build·통합·drill 재실행 안 함) |
| `db:migrate` · `drill:restore` | not_run(./data 금지) |

## Codex 에게 묻는 것(FIX-LIVEP1-TIMEOUT)
1. 표식 저장 몫 초과 → 늦은 커밋 시 UNKNOWN(중복 없음, 깨끗한 재시도 아님)으로 좁힌 보장이 받아들일 만한가, 아니면 "보내지 않은 표식"을 기록하는 장치(migration)가 필요한가?
2. 몫 3초·여유 2초(필요 15초, 실제 예산 60초 안)가 실제 관찰(컨테이너 ~5초·상태 ~1.5초)에 비해 적절한가?
