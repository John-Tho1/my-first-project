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

## FIX round 1 (Codex review-M4UI + review-FIX-M4screen2)
- Orchestrator: HEAD_SHA 2fed5b4 (code only, D28) — reran lint·typecheck·build·unit 759·integration 589·drill:mock 0·real-DB drill:restore PASS.

- BASE: `bdf4c54` · HEAD: TBD(커밋하지 않음 — 오케스트레이터가 커밋 후 기록)
- 범위: 화면 폼 변환·표시·연결 해제 HTML 리다이렉트 + 승인 입력 스키마 1곳. 작업·어댑터·워커·해제(revokeCredential) 로직 변경 없음. 네트워크·새 의존성 없음. 모든 문구 MOCK 유지.

| 지적 | 변경 | 시험 |
|---|---|---|
| [P1] review-M4UI `distribution.ts:161` — "공개 게시"(또는 비공개 업로드·계정 기본값)를 골라도 남은 예약 공개 날짜·시각이 `publish_at` 으로 실려, private 이면 "예약 공개"와 같은 요청이 됨 | `formToPlanCreate`: `publish_date_`·`publish_time_` 는 `result_<vid>=scheduled_publish` 일 때만 읽는다. 그 밖의 선택이면 `publish_at` 을 보내지 않는다(남은 값 무시). 그래서 "공개 게시" = `public_publish`(publish_at 없음), "예약 공개" = `public_publish` + private + `publish_at` 로 요청에서 구별된다. 서버 규칙(D27)은 그대로: JSON API 의 `public_publish + private + publish_at` 은 예약 공개, `upload_private`/MOCK·Threads 에 `publish_at` 은 거부. 화면 라벨에 "다른 요청 결과면 보내지 않음" 추가. | 단위 `apps/web/lib/distribution.test.ts`: 공개 게시(public) + 남은 날짜 → publish_at 없음; 같은 private + 날짜에서 공개 게시 ≠ 예약 공개; 계정 기본값·MOCK 실행 → publish_at 없음, 실행 예약(date_·time_)은 유지; 기존 `upload_private` 단언을 `publish_at: undefined` 로 갱신. 통합 `m4-ui-forms`: (1) 남은 날짜 + 공개 게시(public·unlisted)/비공개 업로드/계정 기본값 → 계획 생성, publish_at·실행 예약 없음, 승인 0; (2) 공개 게시 + private + 남은 날짜 → `visibility_mismatch`(예약 공개로 바뀌지 않음), 계획 0; (3) Threads seed + 남은 날짜 → MOCK 실행 계획(publish_at 없음); (4) JSON API 서버 판정 유지: upload_private+publish_at → `publish_at_requires_public_publish`, public_publish+public+publish_at → `publish_at_requires_private`, Threads+publish_at → `publish_at_not_supported`. 기존 거부 표에서 폼 경로의 "비공개 업로드 + 예약 공개 시각"·"Threads 예약 공개 시각만" 2건은 위 성공·JSON 시험으로 옮김. |
| [P1] review-FIX-M4screen2 `distribution.ts:860` — `publishAtView` 가 `PUBLISHED` 만으로 "원격이 적용하지 않음" 단정 | 새 상태 `unconfirmed`. 입력에 `recordedAt`(publications.created_at) 추가. `PUBLISHED`: 기록 시각이 요청한 예약 시각 **전**이면 `not_applied`(경고, "예약 시각 전(<MSK> 기록)에 원격이 공개로 보고함, 예약이 적용되지 않음"), 예약 시각 이후·같은 순간·기록 시각 없음/잘못됨·요청 시각 잘못됨 → 중립 "원격 결과: 공개됨(예약 적용 여부는 원격 기록으로 확인 필요)", 경고 아님. `MANUAL_REPORTED`·모르는 값도 중립. `UPLOADED_PRIVATE` 는 D27 상 "원격이 publishAt 없이 비공개로 보고"(private+publishAt 이면 SCHEDULED_REMOTE)라 `not_applied` 유지(문구에 "원격 publishAt 없음" 근거 추가). `SCHEDULED_REMOTE` 는 그대로 적용. `/distribute/[id]` ItemCard 가 `latestPub.createdAt` 을 넘긴다. | 단위 「M4 화면 FIX(S5)」: PUBLISHED 예약 시각 이후 기록(중립·경고 아님·"적용하지 않음" 없음), 같은 순간(중립), 기록 시각 없음/null/잘못됨(중립, MOCK 표기), 예약 시각 전 기록(미적용·경고·기록 시각 표시), 요청 시각 잘못됨(중립), MANUAL_REPORTED·모르는 값(중립), UPLOADED_PRIVATE·SCHEDULED_REMOTE 는 기록 시각과 무관. 기존 "PUBLISHED → 적용하지 않음" 단언은 제거·대체. |
| 설정 화면 연결 해제 HTML 폼 — `incomplete`(T13 FIX6 `incomplete_code`)인데도 `?revoked=1`("연결을 해제했습니다") | 새 `apps/web/lib/revoke-view.ts`(import 없음): `revokeRedirectPath(outcome, incompleteCode)` — incomplete → `/settings?revoke=incomplete&revoke_code=<코드>#accounts`(코드는 `revoke_current_no_key`·`revoke_current_unreadable`·`revoke_provider_unavailable`·`revoke_current_seal_failed` 허용 목록만, 그 밖·null 은 코드 없이), superseded → `?revoke=superseded`, 그 밖(revoked·already_revoked·completed_by_other) → `?revoked=1`. `revokeNotice(q)` — 미완료는 경고(`notice`, role=alert): "연결 해제가 끝나지 않았습니다 — <이유>. 연결 정보는 지우지 않았고 이 계정은 해제 중으로 남아 배포 실행이 계속 차단됩니다. <키 설정/공급자/잠시 뒤> 작업 처리기가 같은 해제 작업을 이어서 마무리하며, 연결 해제를 다시 눌러도 같은 작업으로 이어집니다"(FIX6 worker 재개 조건과 맞춤). 모르는 코드는 일반 미완료 문구(원문 미표시). 쿼리 이름은 OAuth `code` 와 헷갈리지 않게 `revoke_code`. revoke route HTML 분기와 settings page 가 이 두 함수를 쓴다. JSON 응답은 그대로. | 단위 `apps/web/lib/revoke-view.test.ts`(6): 끝난 3종 → revoked=1·완료 문구; 허용 코드 4종 → 경로·경고 문구(끝나지 않음·차단 유지·이어서 마무리, "해제했습니다" 없음); 코드 없음·허용 밖(주입 문자열) → 코드 없이·일반 문구·원문 미포함; revoked=1 과 함께 와도 경고 우선; superseded; 해당 없음. 통합 `oauth.test.ts`(마스터 키 없음): HTML 해제 → 303 `/settings?revoke=incomplete&revoke_code=revoke_current_no_key#accounts`, revoked 없음, 문구 매핑, 행은 revoking·암호문 유지; 키 설정 후 HTML 해제 → `/settings?revoked=1#accounts`, 암호문 삭제. |
| 놓친 케이스(review-M4UI): 대소문자만 다른 같은 UUID 목적 키 충돌·삽입 순서 | `approveSchema` superRefine: 소문자 키가 같은데 목적이 다르면 400 invalid(순서 무관, 고르지 않은 항목 키도). 같은 목적이면 통과. | 단위 `packages/domain/src/distribution.test.ts` +1(두 순서 모두 거부·미선택 항목 충돌 거부·같은 목적 통과). |
| 놓친 케이스(review-M4UI): 실행 예약 = 예약 공개 시각, 공개 시각이 더 이름, MSK 자정 날짜 변경, 없는 날짜·`24:00` | 코드 변경 없음(서버 기존 규칙 확인) | 통합 `m4-ui-forms`: 같은 시각·더 이름 → `publish_at_before_send`, `2030-02-30`·`24:00` → `invalid_schedule`, 계획 0; MSK 00:30 → 전날 `21:30:00.000Z`. |

### 바뀐 파일

- `apps/web/lib/distribution.ts` — `formToPlanCreate`(남은 예약 공개 값 무시), `publishAtView`(`recordedAt`·`unconfirmed`)
- `apps/web/app/distribute/[id]/page.tsx` — `publishAtView` 에 `recordedAt: latestPub.createdAt`
- `apps/web/app/distribute/new/page.tsx` — 예약 공개 날짜·시각 라벨 문구
- `apps/web/lib/revoke-view.ts`(새 파일) · `apps/web/app/api/channel-accounts/[id]/revoke/route.ts` · `apps/web/app/settings/page.tsx`
- `packages/domain/src/distribution.ts` — `approveSchema` 목적 키 충돌 거부
- 시험: `apps/web/lib/distribution.test.ts`, `apps/web/lib/revoke-view.test.ts`(새 파일), `packages/domain/src/distribution.test.ts`, `tests/integration/m4-ui-forms.test.ts`, `tests/integration/oauth.test.ts`
- 작업 트리의 CRLF 파일은 CRLF 유지(CR 수 = LF 수 확인), 인덱스는 LF(autocrlf).

### 명령과 결과(이 세션, Windows 10 · Node 24.21.0 · `source tools/env.sh` · `corepack pnpm`)

| 명령 | 결과 |
|---|---|
| `lint` | pass |
| `typecheck` | pass |
| `build` | pass(dev 서버 꺼진 상태; 라벨 문구 수정 뒤 lint·typecheck·build 다시 pass) |
| `test`(unit) | pass — 40 files, 759 tests |
| `exec vitest run --project integration tests/integration/m4-ui-forms.test.ts tests/integration/oauth.test.ts` | pass — 2 files, 100 tests |
| `test:integration`(단독, unit 과 동시 아님) | pass — 31 files, 588 tests |
| `drill:mock` | pass — exit 0, "불변식 위반 0건 — M3 게이트·T14 Threads·T15 YouTube 모의 불변식 통과(MOCK)", YouTube fetch 0 |
| `drill:restore`(실제 DB) | not_run(./data 열지 않음 — 오케스트레이터) |
| 브라우저 화면 확인 | not_run(dev 서버 꺼둠) — 남은 예약 값 + 공개 게시, PUBLISHED 문구, 해제 미완료 배너 육안 확인 필요 |

### 남은 위험

1. 남은 예약 공개 값은 **조용히 무시**한다(Codex 제안은 "명시 거부 + 입력 보존"). 사용자가 날짜를 넣고 "공개 게시"로 바꾸면 즉시 공개 계획이 된다 — 승인 화면이 예약 시각 없음·공개 범위를 보여 주고 승인은 항목별 명시라 실행 전 확인 지점은 있다. private 이면 서버가 `visibility_mismatch` 로 거부하므로 "몰래 예약 공개"는 생기지 않는다.
2. `publications` 에 원격이 보고한 publishAt 이 없어(스키마 변경 없음) PUBLISHED 판정은 기록 시각(created_at)만 근거다. 실제 공개 시각과 기록 시각은 다르다(재확인 지연 등) — 그래서 "예약 시각 전 기록"일 때만 미적용이라 말하고 그 밖은 중립. SCHEDULED_REMOTE 의 원격 예약 시각이 요청과 같은지도 저장값으로 확인할 수 없다(모의는 요청값 그대로).
3. 설정 화면 해제 배너는 query 기반이라 새로 고침·북마크로 다시 보일 수 있다(기존 `revoked=1` 과 같은 방식). 실제 상태는 계정 행(해제 중·차단)이 보여 준다.
4. `superseded` 를 경고로 따로 보이게 바꿨다(이전엔 "해제했습니다"). 문구는 db 주석(해제 작업은 끝났고 그 뒤 다시 연결·새 해제)에 맞췄다.
5. `approveSchema` 목적 키 충돌은 고르지 않은 항목 키도 거부한다(입력 모호성 제거). `expected_hashes` 의 같은 충돌은 손대지 않았다(마지막 값이 남지만 서버가 저장 hash 와 대조).

### Codex 에게 질문

1. 남은 예약 공개 값을 "무시"(이번 구현)하는 것과 "거부 + 입력 보존"(review-M4UI 제안) 중 어느 쪽이 docs/03 명시 승인 원칙에 더 맞는가? 무시 쪽이 승인 화면 확인만으로 충분한가?
2. PUBLISHED + 기록 시각 < 예약 시각을 "예약이 적용되지 않음"(경고)으로 말하는 것이 근거로 충분한가, 아니면 이것도 중립으로 둬야 하나?
3. `UPLOADED_PRIVATE` 를 계속 `not_applied` 로 두는 근거(D27 `youtubeResultOf`: private+publishAt → SCHEDULED_REMOTE)가 실제 어댑터 단계에서도 유지된다고 봐도 되나, 아니면 결과 행에 원격 publishAt 을 기록하는 후속이 필요한가?
4. 연결 해제 미완료 문구의 "작업 처리기가 이어서 마무리" 약속이 FIX6 재개 조건(revoking·암호문·`revoke_*`·60초 경과·지금 키로 열림·공급자 있음)과 어긋나는 경우가 있나(예: `revoke_current_seal_failed` 이후 키는 열리는데 계속 봉인 실패)?
5. `superseded` 를 `?revoke=superseded` 경고로 분리한 것이 맞는가, 아니면 "해제 끝남"(revoked=1)으로 두는 편이 정확한가?

# FIX round 2 (Codex review-FIX-M4UI P2) — 오케스트레이터 직접
- HEAD_SHA: cd0a2aa (apps/web/lib/revoke-view.ts + test).
- 지적: 해제 미완료 안내가 원인 해소 여부와 무관하게 "이어서 마무리" 를 약속함(봉인 실패 지속·unknown 에도).
- 변경: 안내를 "원인이 해결되고 재개 조건이 갖춰지면 작업 처리기가 같은 해제 작업을 다시 시도합니다(…). 해제가 끝날 때까지 이 계정의 배포 실행은 차단됩니다." 로 — 재시도와 완료를 구분.
- 시험: revoke-view.test.ts 가 조건부 문구 포함·"마무리합니다/마무리하며/자동으로 완료" 없음 확인.
- 명령: lint·typecheck·build·unit 759·integration 595·drill:mock 0·실제 DB drill:restore PASS.
