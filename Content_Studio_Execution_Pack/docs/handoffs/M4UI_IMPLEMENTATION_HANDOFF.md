# M4UI 구현 인계 — 배포 화면 폼 공백 G1·G2

- 작업: M4 배포 화면 폼 공백 G1(승인 폼 단일 purpose) · G2(계획 만들기 폼에 요청 결과·예약 공개 입력 없음) 닫기. 화면 + 승인 입력 계약의 최소 확장.
- 브랜치: `content-studio/m4`
- BASE: `ee36858` · HEAD_SHA: fa37b1a (code only, D28; orchestrator reran lint·typecheck·build·unit 737·integration 569·drill:mock 0·real-DB drill:restore PASS)(커밋하지 않음 — 오케스트레이터가 커밋 후 기록)
- 범위 밖: 실행·어댑터·워커 로직, DECISIONS.md, M4_CODEX_VERDICTS.md, T13–T15 인계, screen-notes-m4.md(손대지 않음).
- 모든 화면 문구 MOCK 유지 — 실제 채널로 아무것도 보내지 않는다. 네트워크·새 의존성 없음.

## 공백 → 변경 → 시험

| 공백 | 변경 | 시험 |
|---|---|---|
| G1: `/distribute/{id}` 승인 폼이 `purpose` 하나만 보냄 → YouTube(upload_private/public_publish) + Threads/seed(mock_publish) 섞인 계획은 폼 한 번으로 승인 불가 | **domain** `approveSchema`: `purpose` 선택(optional) + `purposes`(항목 id → 목적, enum) 추가. 고른 항목마다 `purposes[id] ?? purpose` 가 정해져야 하고, 둘 다 있으면 같아야 함(아니면 400). 키 소문자 정규화. `approvalPurposeFor()` 추가. **db** `approveItems`: 항목마다 `approvalPurposeFor(input, id) !== item.requestedResult` 면 `purpose_mismatch`(정해지지 않은 목적도 거부). confirm·expected hash·PLANNED·already_approved·snapshot 검사는 그대로(순서도 그대로). **web** 승인 폼: 단일 hidden `purpose` 제거 → 승인 가능 항목마다 hidden `purpose_<id>` = 그 항목의 저장된 requested_result. 목적이 섞이면 안내 한 줄(MOCK). `formToApprove`: `purpose_<id>` → `purposes`, `purpose` 는 있을 때만. JSON API 의 단일 `purpose` 는 하위 호환. | 통합 `tests/integration/m4-ui-forms.test.ts` G1: (1) 모의 연결 YouTube upload_private + Threads seed mock_publish 계획을 HTML 폼 1회로 승인 → `approved=2`, 승인 행 purpose 각각 upload_private·mock_publish, hash 일치; (2) YouTube 항목 `purpose_`를 mock_publish·public_publish 로 고침 → `purpose_mismatch`, 예전 단일 purpose 폼 → `purpose_mismatch`, purpose≠purposes → `invalid`, 고른 항목 목적 누락 → `invalid`, confirm 없음 → `confirm_required`, hash 변조 → `hash_mismatch`, 그동안 승인 0개, 이어서 올바른 폼은 통과; (3) public_publish + mock_publish 혼합에서 한 항목씩 승인. 단위: `approveSchema.purposes`(domain), `formToApprove`(web). |
| G2: `/distribute/new` 에 요청 결과·예약 공개 입력이 없어 YouTube 공개·예약 공개 계획은 API 로만 가능 | **web** 계획 폼: 채널 초안마다 `요청 결과(MOCK …)` select(`result_<vid>`) — 비공개 업로드 / 공개 게시 / 예약 공개(+ 계정이 섞이면 MOCK 실행·"계정 기본값"). 예약 공개 날짜(`publish_date_<vid>`, date)·시각(`publish_time_<vid>`, HH:mm) — 모스크바 시각, 서버 `scheduleFromMsk` 가 UTC 로 저장. 선택지는 D27 규칙대로 계정 기준(`resultChoicesFor` = `adapterIdFor` 한 곳 재사용): 모의 연결 YouTube 만 3개, Threads·seed 모의 계정만이면 select 없이 "요청 결과: MOCK 실행(실제 게시 아님)" 고정 문구. 계정 목록 줄에 그 계정이 고를 수 있는 결과 표시(`planAccountLabel`). 기존 일정 라벨은 "실행 예약 날짜/시각"으로 구분. `formToPlanCreate`: 예약 공개 → `requested_result=public_publish` + `publish_at{date,time}`(비어도 넘겨 서버가 invalid_schedule), 빈 값 → 계정 기본값(키 생략), 다른 결과에 넣은 예약 공개 시각도 숨기지 않고 넘김(서버가 거부). 오류 뒤 입력 되살리기(`e_res_`·`e_pdate_`·`e_ptime_`). 오류 문구: `requested_result_required` 추가, `invalid_schedule`·`schedule_in_past` 문구에 "실행 예약·예약 공개" 명시. 공개 범위는 사용자가 고른 값을 그대로 보냄(클라이언트가 바꾸지 않음). | 통합 G2: (1) 예약 공개 09:30 MSK + private → 303 `?created=1`, 항목 public_publish·private·`publish_at = <날짜>T06:30:00.000Z`, 같은 폼의 Threads seed 항목은 mock_publish·publish_at 없음, 승인 0개; (2) 공개 게시(public)/비공개 업로드/계정 기본값 → public_publish/upload_private/upload_private; (3) 서버 거부 → `/distribute/new?…&error=<code>`(한국어 문구 존재 확인): publish_at_requires_private, invalid_schedule(예약 공개 날짜 없음), schedule_in_past, publish_at_requires_public_publish, visibility_mismatch×2, requested_result_not_supported, invalid(모르는 값), Threads seed 에 upload_private·예약 공개 → mock_only, 예약 공개 시각만 → publish_at_not_supported; 입력값 되살림; 계획 행 0개. 단위: `formToPlanCreate`, `resultChoicesFor`/`planResultSelect`/`planAccountLabel`, echo 왕복, 오류 문구 한국어. |

## 바뀐 파일

- `packages/domain/src/distribution.ts` — `approveSchema`(purpose optional + purposes), `approvalPurposeFor`
- `packages/db/src/distribution.ts` — `approveItems` 항목별 목적 대조(1줄 + import)
- `apps/web/lib/distribution.ts` — `formToApprove`·`formToPlanCreate`, `REQUESTED_RESULT_LABEL`, `PlanResultChoice`·`RESULT_CHOICE_LABEL`·`resultChoicesFor`·`planAccountLabel`·`planResultSelect`, echo/defaults 확장, 오류 문구
- `apps/web/app/distribute/[id]/page.tsx` — 항목별 hidden `purpose_<id>`, 혼합 안내
- `apps/web/app/distribute/new/page.tsx` — `ResultFields`(요청 결과·예약 공개), 계정 줄 라벨, 실행 예약 라벨
- 시험: `packages/domain/src/distribution.test.ts`(+1), `apps/web/lib/distribution.test.ts`(+5), `tests/integration/m4-ui-forms.test.ts`(새 파일, 6)
- CRLF 파일은 CRLF 유지(CR 수 = LF 수 확인).

## 명령과 결과(이 세션, Windows 10 · Node 24.21.0 · `source tools/env.sh`)

| 명령 | 결과 |
|---|---|
| `corepack pnpm lint` | pass |
| `corepack pnpm typecheck` | pass(첫 실행에서 새 시험 파일 TS2352 3건 → `as unknown as CanonicalPayload` 로 고친 뒤 pass) |
| `corepack pnpm build` | pass(dev 서버 꺼진 상태) |
| `corepack pnpm test` (unit) | pass — 39 files, 737 tests |
| `corepack pnpm exec vitest run --project integration tests/integration/m4-ui-forms.test.ts` | pass — 6 tests |
| `corepack pnpm test:integration` (단독, unit 과 동시 아님) | pass — 31 files, 569 tests |
| `corepack pnpm drill:mock` | pass — exit 0, "불변식 위반 0건 — M3 게이트·T14 Threads·T15 YouTube 모의 불변식 통과(MOCK)" |
| 브라우저 화면 확인 | not_run(dev 서버 꺼둠 — 오케스트레이터 화면 확인 필요) |

## 남은 위험

1. 서버 렌더 폼(클라이언트 JS 없음)이라 요청 결과 선택지는 "선택한 계정"이 아니라 **그 채널 초안의 계정들 합집합**이다. 모의 연결 YouTube 계정과 seed YouTube 계정이 함께 있으면 MOCK 실행·비공개 업로드 등이 모두 보이고, 계정 줄 라벨로 안내만 한다 — 맞지 않는 조합은 서버가 거부(mock_only·requested_result_not_supported). 계정 하나뿐이거나 같은 종류만 있으면 그 계정의 선택지만 보인다.
2. 예약 공개를 골라도 공개 범위를 자동으로 private 로 바꾸지 않는다(클라이언트가 값을 바꾸지 않도록). public 을 그대로 두면 서버가 `publish_at_requires_private` 로 거부하고 한국어 문구를 보인다 — UX 상 한 번 더 고쳐야 할 수 있음.
3. 실제(live) 계정은 `resultChoicesFor` 가 빈 목록 → "MOCK 실행" 고정 문구로 보인다. M4 에서는 live 게시가 막혀 있어 영향 없음이지만 live 연결 단계에서 다시 정해야 한다.
4. `approveSchema` 의 `purpose` 가 optional 이 됐다. 목적이 정해지지 않으면 스키마(400 invalid)와 `approveItems`(purpose_mismatch) 두 곳에서 거부하지만, 다른 직접 호출자가 생기면 같은 규칙을 지켜야 한다.
5. 승인 화면 페이지 컴포넌트 자체(hidden 필드 렌더)는 통합 시험이 직접 렌더하지 않는다 — 폼 필드 계약(`purpose_<id>`·`hash_<id>`·`item_<id>`·`confirm`)을 route 로 시험했다. 화면 렌더는 build 와 오케스트레이터 화면 확인으로 확인 필요.

## Codex 에게 질문

1. `purposes` 와 `purpose` 를 함께 보낼 때 "다르면 400" 규칙이 충분히 엄격한가, 아니면 둘 중 하나만 허용(동시 전송 거부)해야 하나?
2. 승인 폼이 승인 가능한 **모든** 항목의 `purpose_<id>` 를 보내고 서버는 고른 항목만 대조한다(추가 키 무시 — expected_hashes 와 같은 방식). 고르지 않은 항목의 목적 키도 검증·거부해야 하나?
3. D27 규칙상 `needs_reconnect` YouTube 모의 계정도 `adapterIdFor` 기준 mock_youtube 라서 비공개 업로드·공개 게시·예약 공개가 보인다(서버도 같은 판정). 계획 만들기 화면에서 이 계정의 선택지를 제한해야 하나(실행은 T13 연결 상태로 차단됨)?
4. 예약 공개를 다른 결과(비공개 업로드·공개 게시)와 함께 넣은 예약 공개 시각을 숨기지 않고 서버로 넘겨 거부시키는 방식(`publish_at_requires_public_publish`)이 맞는가, 아니면 공개 게시 + private + 예약 시각을 "예약 공개"로 받아들이는 현재 서버 규칙과 화면 선택지 사이에 혼동 여지가 있나?
5. 계정이 섞인 채널 초안에서 "계정 기본값"(빈 값 → 서버 기본: 모의 연결 YouTube = upload_private, 그 밖 = mock_publish)을 두는 것이 docs/03 "기본 전체 선택 금지"·명시 승인 원칙과 충돌하지 않는가(계획 단계일 뿐, 승인은 항목별 명시)?
