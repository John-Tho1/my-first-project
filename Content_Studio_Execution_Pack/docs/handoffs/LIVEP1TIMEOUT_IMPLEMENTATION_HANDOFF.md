# Implementation handoff — LIVEP1-TIMEOUT (실제 Threads 게시가 한 번의 tick 안에 끝나게)
- Task ID / milestone: LIVEP1-TIMEOUT / M4 D38 후속.
- 배경(실제 실행): 작업 6e236a8f — 컨테이너 생성 ~5초 + 상태 확인 ~1.5초 → 게시 시도 표식 → threads_publish 전송 중 화면 폼 tick 의 10초 예산(`apps/web/app/api/worker/tick/route.ts` `uiTickTimeoutMs`)이 끝나 `submit_timeout` → RECONCILING → (목록은 후보만) UNKNOWN. 실제로는 게시됐다(사용자 확인).
- Purpose and changed behavior:
  1. **실제 어댑터 작업의 예산**: 작업 처리기 `budgetFor(adapter, opts)` — 실제(live) 어댑터는 `max(호출자 예산, LIVE_SUBMIT_BUDGET_MS = 60초)`(옵션 `liveSubmitTimeoutMs` 로 바꿀 수 있음 — 시험용), 모의는 호출자 예산 그대로(모의 시간 시험 불변). 전송(sendJob)과 조회(remoteCheck) 모두. 호출당 HTTP 시간 제한(10초)은 그대로. lease 는 heartbeat(쓰기·조회 전)로 연장된다.
  2. **표식 전 남은 시간 확인**: 작업 처리기가 `ctx.deadline`(이번 전송 마감, 실제 시계)을 넣고, 실제 어댑터는 게시 시도 표식을 쓰기 **전에** 남은 시간 < 게시 호출 시간 제한(10초) + 여유(2초)이면 표식·게시 없이 `rejected / transient_no_side_effect / publish_budget_insufficient`(보내지 않음 → RETRY_WAIT). 다음 시도는 기록된 FINISHED 컨테이너로 바로 게시(새 컨테이너 없음). 앞 단계 지연 때문에 마감이 표식과 threads_publish 사이에서 터져 결과 불명이 되는 경우를 없앤다(그 밖의 결과 불명 규칙은 그대로).
  3. 화면 tick 버튼 안내에는 10초 문구가 없어 바꾸지 않았다. tick route 머리 주석에 실제 작업 예산을 적었다.
- 대안(폼 tick 이 먼저 응답하고 작업은 뒤에서 계속)은 쓰지 않았다 — Next route handler 에서 응답 뒤 작업을 안전하게 이어 가는 보장이 없고(요청 수명·프로세스), 예산 변경이 더 단순하다. 대신 화면 버튼은 실제 작업이 있으면 최대 약 60초 걸릴 수 있다.
- BASE_SHA: 3e21561
- HEAD_SHA: 98f11cd349d67606b94bad924edc214dc11076b4
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
