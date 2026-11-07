# Implementation handoff — LIVEL1-H1 (review-FIX4-LIVEL1 "놓친 케이스" 보강)
- Task ID / milestone: LIVEL1-H1 / LIVE-L1(Codex PASS 2b05044) 뒤 보강. 시험 위주이고 코드 수정은 1줄(NFD 판별)이다.
- Purpose and changed behavior: 1인칭 판별(`hasFirstPersonExpression`)이 판별 전에 NFC 정규화를 한다. 그래서 분해형(NFD) 한글 본문·claim 도 1인칭으로 잡힌다(원문은 바꾸지 않음). 그 밖은 시험 추가뿐이다.
- BASE_SHA: 523a9aa
- HEAD_SHA: 259f4f965d9dd48bb5511a8a629a5eccc1b02d52 (code only, D28 — 오케스트레이터 커밋)
- Clean tracked tree confirmed: 시작 시 yes(`?? .claude/` 만).
- Relevant acceptance IDs: D34, D13, A06(승인 뒤 변경은 승인 무효), A03(미확인 경험 게이트), AGENTS.md Invariants.
- External calls performed: **none**(Anthropic·npm 모두 0).
- Mock-only functionality: 변경 없음. 모의 provider 의 1인칭 판별은 자체 정규식을 그대로 쓴다.

## 항목 → 재현(523a9aa) → 결과
| # | 항목 | 523a9aa 에서 | 조치 | 시험 |
|---|---|---|---|---|
| 1 | 보고값 경계 | **통과**(정규식 `^(0\|[1-9]\d{0,39})$`·`…\.\d{6}$` 가 이미 막음 — JS `\d` 는 ASCII 만, `$` 는 뒤 줄바꿈 앞에서 맞지 않음) | 코드 변경 없음 | `bundle.test.ts` "LIVEL1-H1: 보고값 경계": 토큰 in/out·비용 정수부 40자리 허용, 41자리 거부 · 비용 소수 5·7자리 거부 · 뒤 공백·줄바꿈(토큰·비용) 거부 · 전각 `１`·아라비아-인도 `٣`·데바나가리 소수 거부 · null·배열·객체 거부 |
| 2 | 손상 묶음의 실제 복원 거부 | **통과** | 코드 변경 없음 | `live-llm.test.ts`: 실제 export 묶음을 `parseBundleZip` → 행 수정 → `buildBundle`(manifest 해시 다시 계산) → `createRestorePreview`. 3종(보고 비용 없음·토큰 음수·usage_source 지우고 reported_* 만 남김) 모두 `integrity`. **대상 DB 의 원장·run·원고·버전·claims 수 변화 0**, 미해결 차단 행 없음 |
| 3 | 수동 해결 왕복 | **통과** | 코드 변경 없음 | `live-llm.test.ts`: provider_unstorable 행에 인계 절차 4~6 을 적용 — `reported_*` → `resolution.original_reported`, 사유·시각 기록, 9.95 USD 로 재정산(overage·over_budget 맞춤), usage_source=provider. 결과: 차단 해제 · **월 상한 10 에서 다음 예약 429 `monthly_limit`(재정산액이 합계에 들어감, 호출 0)** · 상한 100 이면 호출 성공 · export → 빈 DB 복원 성공, `actual_amount 9.950000`, `original_reported` 가 같은 값, 최상위 `reported_cost` 없음, 차단 없음 |
| 4 | NFD 본문·claim | **실패 3건**(NFD `저는`/`제가` 를 정규식이 못 잡음 → claim 이 추가되지 않고 재분류도 안 됨) | `packages/providers/src/llm.ts` `hasFirstPersonExpression` 이 판별 전에 `normalize('NFC')`. live provider 의 claim 재분류·문단 판별이 이 함수를 쓴다 | `llm-anthropic.test.ts`: NFD 본문 + `claims: []` → 본문 그대로의 experience claim 추가 · NFD `fact`·`opinion` claim → experience + 확인 필요 |
| 5 | 승인 뒤 본문 수정 → 이전 승인으로 게시 거부(T10/A06) | 기존 시험 **있음(부분)**: `tests/integration/distribution.test.ts` "A06 (a) 파생본 수정 → invalidated:body_changed … 실행 403, 재승인 409 snapshot_stale" — 파생본(채널 초안) 본문. 원고 본문은 "(c) 원고 수정 → invalidated:content_changed" 가 철회 사유만 확인했다 | 시험 추가만(승인 로직 변경 없음 — 새 시험이 통과하므로 버그 없음) | `distribution.test.ts` "(c2) 원고 본문 수정 뒤 이전 승인으로 실행 → 403 approval_required, 작업 0, 재승인 409 snapshot_stale" — 523a9aa 에서도 통과 |
| 6 | Postgres 다른 연결 | — | **미검증**(이 환경에 Postgres 서버 없음). 동시 예약·횟수 제한·미해결 차단의 직렬화는 owner 행 `FOR UPDATE` + 같은 트랜잭션 삽입에 기대며 PGlite 에서만 시험했다 | 없음 |

## 바뀐 파일
- 코드: `packages/providers/src/llm.ts`(`hasFirstPersonExpression` NFC 정규화 1줄 + 주석)
- 시험: `packages/domain/src/bundle.test.ts`(+1), `packages/providers/src/llm-anthropic.test.ts`(+3), `tests/integration/live-llm.test.ts`(+2, import 추가), `tests/integration/distribution.test.ts`(+1)
- migration 없음. 기존 단언 변경·삭제 없음

## Actual commands and results(Windows 10, Git Bash, `source tools/env.sh`, Node 24.21.0, `corepack pnpm`, 실행 전 node 프로세스 0개 확인)
| 명령 | 결과 |
|---|---|
| 재현(523a9aa, 새 시험만): unit `llm-anthropic.test.ts`·`bundle.test.ts` | 3 failed(NFD 3건) / 122 passed — 경계 시험은 통과 |
| 재현(523a9aa): integration `live-llm.test.ts`·`distribution.test.ts` | 71 passed(새 3건 모두 통과 — 동작 기록) |
| 수정 후 단독: unit `packages/providers/src` + `packages/domain/src` | 46 files, 1298 passed |
| `bash .handoffs/run-checks.sh LIVEL1H1` → `.handoffs/checks-LIVEL1H1.log` | **LINT=0 · TYPECHECK=0 · BUILD=0 · UNIT=0(56 files, 1405) · INTEG=0(37 files, 789) · DRILL=0 · MIGRATE=0 · DRILL_RESTORE=0(PASS)** — 시간 초과·워커 비정상 종료 없음 |

## Known risks / not run
- Postgres 다중 연결 경쟁: 미검증(위 6).
- 1인칭 판별은 여전히 정규식이다(NFC 만 맞춤). 주어를 생략한 경험은 잡지 못한다.
- provider_unstorable 해결은 수동 절차뿐이다(화면·API·감사 없음). 시험은 절차의 데이터 모양만 확인한다.

## Questions for Codex
1. 수동 해결 뒤 `resolution` 객체의 형식(키·타입)도 복원 무결성에서 검증해야 하는가? 지금은 최상위 `reported_*` 만 검사한다.
2. NFC 정규화를 모의 provider 의 판별에도 맞춰야 하는가? 지금 모의는 기존 결정성을 지키려고 그대로 두었다.

- Next authorized task: 없음.
