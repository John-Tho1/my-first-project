# Implementation handoff — LIVEP1-DIAG (D38 2단계 실패 진단·오래된 표시 정리)
- Task ID / milestone: LIVEP1-DIAG / M4 D38 후속. 배경: D38 2단계 실제 실행에서 작업 c94807f5 가 컨테이너 생성 단계 `container_permission_denied`(확정 실패)로 끝났다 — 게시물 없음. 어댑터가 판정 외 정보를 모두 버려 원인을 볼 수 없었다.
- Purpose and changed behavior:
  1. 실제 Threads 호출 실패(create·status·publish·read·list 모든 단계)에 **허용 목록 진단**(http_status·code·error_subcode·error_type(`…Exception` 형식만)·is_transient·fbtrace_id(`[A-Za-z0-9_-]{1,64}`)·transport·op)을 만들어 작업 이력(job_events.sanitized_details.provider_diag)·전송 의도(send_intents.sanitized_details.provider_diag)에 남기고, 배포 계획 항목 카드에 "Threads 오류 코드: 컨테이너 생성 · HTTP 403 · code 10 · subcode … · OAuthException · is_transient=false · fbtrace …" 로 보인다. 작업 API(GET /api/jobs/{id})의 events 에도 같은 값. message·error_user_msg·error_user_title·URL·토큰·본문은 저장하지 않는다(만들 때·DB 쓰기 직전·화면 출력 때 세 번 걸러짐).
- HEAD_SHA: 722e58cbfd88b4a23e643bf2f6eb5bd44fbef800 (LIVEP1-DIAG) · FIX-LIVEP1-DIAG HEAD 8701cf5576b2c31c71b4554b0b5f28c69604b6d1
- BASE_SHA: 9cf1338
- HEAD_SHA: uncommitted — orchestrator commits
- Clean tracked tree confirmed: 시작 시 yes(`?? .claude/` 만).
- Relevant acceptance IDs: AGENTS(비밀은 서버만·로그/브라우저 금지, 실제 공개 범위·확인 상태 표시, 모의 ≠ 실제), D38.
- External calls performed: **none**(주입 fixture fetch·전역 fetch stub 만). `.env.local`·`./data` 열지 않음, db:migrate·drill:restore 실행 안 함, dev 서버 시작 안 함(오케스트레이터가 port 3000 dev 서버를 멈춘 뒤 build 실행), 내가 띄운 프로세스만 다룸.

## capability_snapshot 이 게이트로 쓰이는가(2b 확인)
- 읽는 곳: `packages/db/src/distribution.ts` `channelAccountView`(API·화면 표시)와 내보내기 묶음 스키마(`packages/domain/src/bundle.ts` — 형식 검사만)뿐. 실행·전송·계획·승인 게이트(assertExecutionAllowed·beginSend·accountReady·credentialGate·livePublishReadiness·snapshotProblems)는 **읽지 않는다**. 게이트 의미는 바꾸지 않았다.

## 3. 실패(FAILED) 뒤 다시 게시하는 길 — 사용자 안내
- FAILED(컨테이너 단계 확정 실패, 게시 시도 없음)는 **재시도 불가**: `retryItem` 은 BLOCKED 만 받는다 → 409 `not_retryable`(통합 시험으로 확인). 재시도 의미는 바꾸지 않았다.
- **같은 파생본으로 새 배포 계획**은 된다(승인된 파생본도 계획 가능) → 새로 승인 → 실행 → 게시(통합 시험).
- **주의(게시 수 상한)**: 실패한 작업도 전송 의도를 만들었으므로 그 승인 기록의 게시 수 1을 이미 썼다. D38 2단계 설정(PUBLISH_LIVE_MAX_POSTS=1, 같은 PUBLISH_LIVE_APPROVAL_REF)으로 새 계획을 실행하면 **429 live_publish_limit**(작업 없음 — 시험으로 확인). 사용자는 다시 시도를 승인하는 **새 승인 기록**(예: D38-3)을 `.env.local` 의 PUBLISH_LIVE_APPROVAL_REF 에 넣고(MAX 1 유지) dev 서버 재시작 → 새 계획 → 승인 → 실행. 이번 코드부터 실패하면 카드에 Threads 오류 코드가 보인다(c94807f5 는 이 코드 전에 끝나 진단이 없다).
- 403 + code 10(또는 200~299)은 Meta 관례상 "앱에 그 권한이 없음"(앱 검수·고급 접근·테스터 역할 등)이고, 190 은 토큰, 100 은 매개변수다 — 다음 실패의 code·subcode·fbtrace_id 로 확인할 수 있다(추정이며 공식 Threads 표는 없음).

## 변경 파일
- domain: `packages/domain/src/live-publish.ts`(ThreadsDiag·sanitizeThreadsDiag·threadsDiagFromBody), `packages/domain/src/live-publish.test.ts`(새 파일), `packages/domain/src/jobs.ts`(AdapterResult·ReconcileResult.provider_diag)
- providers: `packages/providers/src/threads-live-publish.ts`(LiveThreadsApiError.diag, 모든 단계 진단, 결과에 provider_diag), `packages/providers/src/threads-live-publish.test.ts`(+진단 3 시험, 기존 정확 비교 4곳에 진단 기대값 — 나머지 필드는 그대로 정확 비교)
- db: `packages/db/src/jobs.ts`(이력·전송 의도에 진단, 작업 API mode), `packages/db/src/distribution.ts`(modeForAccountKind·jobView·planDetailView mode), `packages/db/src/live-publish.ts`(capability_snapshot 갱신), `packages/db/src/oauth.ts`(LIVE_ACCOUNT_SNAPSHOT_CONNECT_ONLY)
- web: `apps/web/lib/distribution.ts`(threadsDiagLine·latestThreadsDiag), `apps/web/lib/distribution.test.ts`(+3), `apps/web/app/distribute/[id]/page.tsx`(진단 줄·후보 문구), `apps/web/app/contents/[id]/page.tsx`·`apps/web/app/contents/[id]/variants-panel.tsx`(배포 계획 링크 문구), `apps/web/app/api/distribution-plans/[id]/route.ts`(주석)
- tests: `tests/integration/live-threads-publish.test.ts`(+진단·mode·재시도·새 계획 1 시험, 모의 계획 mode MOCK 단언, 사용 중지 시 snapshot 되돌림 단언)
- migration: 없음(새 열 없음 — 기존 jsonb sanitized_details 에 넣음). remote_steps 에는 넣지 않았다(상세 열이 없음 — 실패한 단계는 대개 단계 행이 생기기 전).

## 실행한 명령과 결과
(Windows 10, Git Bash, `source tools/env.sh`, Node 24.21.0, `corepack pnpm`. dev 서버는 오케스트레이터가 멈춘 상태. ./data 를 여는 db:migrate·drill:restore 는 뺀 같은 순서 — 로그 `.handoffs/checks-LIVEP1DIAG*.log`)
| 명령 | 결과 |
|---|---|
| `vitest run --project unit` 어댑터·domain 진단 시험(개발 중) | 1회차 FAIL 7 — 기존 정확 비교(toEqual)에 새 provider_diag 필드가 붙음(의도한 추가) → 기대값에 진단을 넣어 정확 비교 유지(2xx·id 없음 한 행만 "진단 없음 또는 publish")·2회차 PASS 80 |
| `vitest run --project integration tests/integration/live-threads-publish.test.ts` | 1회차 FAIL 1(jsonb 키 순서 — JSON 문자열 비교 → 깊은 비교로 시험 수정) → PASS 17/17 |
| `corepack pnpm lint` · `typecheck` · `build` | PASS · PASS · PASS(build 충돌 없음 — dev 서버 꺼짐) |
| `corepack pnpm test`(unit) | PASS — 68 files, 1647 tests |
| `corepack pnpm test:integration` | PASS — 47 files, 896 tests(워커 충돌 없음) |
| `corepack pnpm drill:mock` | PASS — "불변식 위반 0건" |
| `db:migrate` · `drill:restore` | not_run(./data 금지) |

## Known risks / not run
1. 진단은 Threads 가 Graph 오류 형식(error.code·error_subcode·type·fbtrace_id)을 줄 때만 숫자가 찬다 — 실제 응답 모양은 다음 실제 실패에서 확인.
2. error_type 은 `…Exception` 형식만 남긴다 — Threads 고유 값이 다른 형식이면 버려진다(보수적).
3. 2xx 인데 id 가 없는 게시 응답 등 상태를 모르는 경우는 진단이 비어 있을 수 있다.
4. fbtrace_id 는 Meta 지원 문의용 추적값으로 비밀은 아니지만 사용자 화면·API·이력에 보인다(요청대로).
5. 이전 위험(결과 불명 = UNKNOWN, 실제 PostgreSQL 동시성 미검증, GET 질의 토큰의 앱 밖 기록 미검증) 그대로.

## Questions specifically for Codex
1. 진단 허용 목록(필드·형식)과 세 번 거르기(어댑터 생성·DB 쓰기 직전·화면)가 "문구·토큰 미저장"을 보장하는가? fbtrace_id 를 화면에 보이는 것이 적절한가?
2. 실패한 시도도 승인 기록의 게시 수를 쓰는 기존 규칙(D38-3) 때문에 사용자가 새 승인 기록을 넣어야 하는 흐름이 의도와 맞는가(규칙은 바꾸지 않음)?
3. mode 를 계정 kind 로만 정하는 표시(게이트 아님)가 오해를 만들 여지(예: 실제 계정이지만 게이트 닫힘)가 있는가?

---

# FIX-LIVEP1-DIAG (Codex review-LIVEP1-DIAG — CHANGES_REQUESTED on 722e58c, P1 1)
- 판정 원본: `.handoffs/review-LIVEP1-DIAG.md`
- BASE_SHA: 722e58c · HEAD_SHA: uncommitted — orchestrator commits
- 범위: 네트워크 0, `.env.local`·`./data` 손대지 않음, dev 서버·db:migrate·drill:restore 없음, 내가 띄운 프로세스만, migration 없음.

## 지적 → 시험(재현) → 변경
| 지적 | 재현(수정 전 코드로 먼저 실패) | 변경 |
|---|---|---|
| **[P1] live-publish.ts:96** 이미 사용 중(connected)이던 실제 계정(예: 사용자의 @yongho.tho)은 publish-target 을 다시 누르기 전까지 옛 D31 표시("연결·프로필 조회만, 게시 안 함") | 통합 새 시험 `FIX-LIVEP1-DIAG: 이미 사용 중이던 실제 계정의 표시(다시 누르지 않음)`: 옛 D31 snapshot 그대로 connected 인 실제 Threads 계정을 직접 넣고(토글 없음) GET /api/channel-accounts → 수정 전 `capability_snapshot` 이 D31(실패, `.handoffs/checks-FIX-LIVEP1DIAG.repro-integ.log`) | 표시값을 **화면·API 계층에서 계산**: `displayedCapability(a)` — 실제 Threads 계정은 kind·platform·state 로(connected = D38 실제 텍스트 게시 `live_text_D38`·external_writes true, 그 밖 = D31 연결만), 다른 계정은 저장값 그대로. `channelAccountView.capability_snapshot` = 계산값, 저장값은 `capability_snapshot_stored` 로 함께(이력). **저장 행은 바꾸지 않음**(내보내기·형식 그대로 — 시험이 DB 행 불변 확인). 설정 화면의 연결 상태 안내(accountHealthView notice·live_publish_target)는 원래 state 기준이라 이미 맞았음 — 같은 시험이 확인. disconnected 이면 저장값이 D38 이어도 D31 표시(시험). 게이트는 이 값을 읽지 않는다(변경 없음) |
| Codex 답 3(안내 문구에 조건 명시) | — | 원고 화면 링크 문구: "실제 게시 조건이 모두 갖춰졌을 때만 실제로 게시" |

## 바뀐 파일(FIX-LIVEP1-DIAG)
- `packages/db/src/distribution.ts` — `displayedCapability`, `channelAccountView`(capability_snapshot 계산값 + capability_snapshot_stored)
- `apps/web/app/contents/[id]/variants-panel.tsx` — 조건 문구
- `tests/integration/live-threads-publish.test.ts` — 회귀 시험 1

## 실행한 명령(FIX-LIVEP1-DIAG — 로그 `.handoffs/checks-FIX-LIVEP1DIAG*.log`)
| 명령 | 결과 |
|---|---|
| `vitest run --project integration tests/integration/live-threads-publish.test.ts`(새 시험 + 수정 전 코드) | FAIL 1/18 — 재현 |
| 같은 파일(수정 뒤, 시험의 GET 호출 인자 1곳 타입 수정) | PASS 18/18 |
| `corepack pnpm lint` · `typecheck` · `build` | PASS · PASS · PASS |
| `corepack pnpm test`(unit) | PASS — 68 files, 1647 tests |
| `corepack pnpm test:integration` | PASS — 47 files, 897 tests |
| `corepack pnpm drill:mock` | PASS — "불변식 위반 0건" |
| `db:migrate` · `drill:restore` | not_run(./data 금지) |

## 남은 위험·미반영(Codex 놓친 케이스 중 이번 범위 밖)
- fbtrace_id 정규식을 통과하는 토큰 모양 문자열은 그대로 저장·표시될 수 있다(공급자가 그런 값을 줄지는 미확인) — 사용 중 토큰과의 일치 검사 등은 하지 않았다.
- 재확인 중 status·read·list 실패 진단의 이력·전송 의도 동시 기록 통합 시험, MIXED 계획·게이트 닫힌 실제 계정의 mode 표시 경계, 성공한 재확인 뒤 과거 진단 표시 구분은 추가하지 않았다(다음 라운드 후보).
