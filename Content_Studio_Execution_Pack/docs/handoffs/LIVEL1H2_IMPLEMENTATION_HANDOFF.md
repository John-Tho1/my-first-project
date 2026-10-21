# Implementation handoff — LIVEL1-H2
- Task ID / milestone: LIVEL1-H2 / M4 (LIVE-L1·LIVEL1-H1 이후 남은 우선순위 낮은 보강 — M4_STATUS "남은 보강 후보")
- Purpose and changed behavior: (1) 복원 무결성에서 운영자가 손으로 넣는 `usage_ledger.pricing_snapshot.resolution` 형식을 검증, (2) 모의 LLM provider 도 실제 Claude 어댑터와 같은 공통 1인칭 판별(NFC) 사용, (3) 실제 Claude 출력 후처리에서 유니코드 정규화만 다른 경험 claim 중복 제거, (4)(5) 복원 후 월 예산 반영·복원 실패 시 대상 행 값 보존을 시험으로 고정(동작은 이미 맞음).
- 착수 전 조사: 읽기 전용 조사 에이전트 + 회의적 재확인(워크플로)으로 후보 7개 확인. **이미 처리됨 2개** — 목적이 섞인 계획의 승인 폼, 계획 만들기의 요청 결과·예약 입력(M4UI G1·G2: fa37b1a → 2fed5b4 → cd0a2aa, Codex PASS). M4_STATUS 의 "클라우드 세션이 남긴 화면·흐름 공백" 문구는 오래된 기록. 나머지 5개를 이 작업에서 처리.
- BASE_SHA: 1cb9d3c (EXPIRY-1 FIX1 92cd026 + 인계)
- HEAD_SHA: 990fd5d3b8d40a4bf415e46a0ffd58531a8e28ec
- Clean tracked tree confirmed: yes
- Relevant acceptance IDs: LIVEL1 수동 해결 절차(LIVEL1_IMPLEMENTATION_HANDOFF 4~6단계), A03(미확인 1인칭 경험 차단), A18(복원 무결성), D13·D16-F(예산·월 귀속), D34·D35
- Changed files: `git show --stat 990fd5d` — `packages/domain/src/bundle.ts`(+test), `packages/domain/src/writing.test.ts`, `packages/providers/src/llm.ts`(+test), `packages/providers/src/llm-anthropic.ts`(+test), `tests/integration/{live-llm,oauth,writing,variants}.test.ts`
- 항목별:
  1. **resolution 형식**(`checkIntegrity`, `isValidResolution`): resolution 이 있을 때만 — `usage_source` provider|none, 키 6개 정확히(resolved_at·resolved_by·reason·settled_amount·original_usage_source·original_reported), `resolved_at` TS_RE, `resolved_by` 공백 아님 ≤200, `reason` 공백 아님 ≤4000, `original_usage_source`='provider_unstorable', `original_reported` 키 3개·FIX4 보고 값 형식. `settled_amount` 는 reported_cost 형식(정수부 최대 40자리 — numeric(18,6) 를 넘는 실제 청구 기록 가능), 행 `settled`·actual 있음, **settled == actual(micro), 단 actual > reserved(4~5단계대로 상향 재정산·상한 적용)일 때만 settled > actual 허용**. settled < actual, actual 이 예약액 그대로인데 settled 만 큼(5단계 누락 — 예산이 돈을 못 봄)은 거부. 정규식 통과 뒤에만 toMicro → 항상 `integrity`(bad_request 아님). 실패 메시지는 값 없는 고정 문구.
     - 시험: `bundle.test.ts` "LIVEL1-H2: 수동 해결 resolution 형식 …"(통과 10·거부 약 50), `live-llm.test.ts` 실제 복원 경로 3변형(미리보기 integrity, 대상 행 수 그대로) + 무변경 재구성 대조. 수정 전 실패 확인, 코드 변이 3종(상한 가드 제거·동등만·provider_unstorable 허용) 잡힘. H1 왕복 시험은 수정 없이 통과.
  2. **모의 1인칭**: `llm.ts` 한 줄 `FIRST_PERSON.test(s)` → `hasFirstPersonExpression(s)`(NFC). H1 때 "결정성"을 이유로 둔 것은 NFC 가 순수 함수라 해당 없음(주석).
     - 시험: `llm.test.ts` "LIVEL1-H2 — 모의 provider 의 1인칭 판별"(NFD·8행 일치 표·결정성, 호환 자모 행 포함), 통합 `writing.test.ts`(NFD 1인칭 답변 → 409 → 201), `variants.test.ts`(실제 `runVariantAssist` 경로). 수정 전 단위 4·통합 2 실패.
  3. **NFC 중복**(`dedupeExperienceClaims`, 재분류 뒤): experience claim 만, 키 `text.normalize('NFC')` 정확히(공백 접기·trim 없음 — sanitize 전에 돌기 때문에 BOM·탭으로 인용 검사를 우회하지 못하게), 공백뿐인 claim 은 합치지 않음, 뒤의 중복은 원본 `source_refs` 문자열이 같은 키의 남은 claim 에 모두(===) 있을 때만 버림. `normalizeForCoverage`·문단 처리 그대로.
     - 시험: `llm-anthropic.test.ts` (a)~(k)(조사 교정대로 (d) 뒤집음) + claim↔문단 고정 + BOM/탭 인용 우회 고정, `domain/writing.test.ts` NFD `bodyContainsClaim`/`isClaimResolved` 고정, 통합 `live-llm.test.ts`(작성 보조 중복 → 확인·ready, 채널 경로, 우회 2건은 계속 `unverifiable_citation`). 수정 전 (a)(b)(c)(e)(f)·통합 2 실패, 키를 `normalizeForCoverage` 로 바꾸는 변이·refs trim/lowercase 변이 잡힘.
  4. **복원 예산(시험만)**: A1 해결된 9.95 USD 행 복원 → 대상 한도 10 이면 429 `monthly_limit`(호출 0·새 행 0), 100 이면 1회 호출. A2 지난달 행 제외(대조: 날짜 이동 전 두 번째 묶음). A3 현재 동작 기록 — add_missing 의존 충돌로 빠진 원장 행은 대상 월 합계에서 빠지고 미리보기 경고 없음. 변이: 복원이 원장 `created_at` 을 바꾸면 A1~A3 실패, 월 창 하한 제거 시 A2 실패.
  5. **실패 시 값 보존(시험만)**: 비어 있지 않은 대상 DB 에서 (a) 미리보기 integrity 거부, (b) 미리보기 뒤 저장 ZIP 교체 → `rejected` → `restore_not_committable`, (c) 커밋 트랜잭션 안 checksum 실패 → `failed`(실제 저장소 대조로 쓰기 후 롤백 확인), `oauth.test.ts` add_missing 파일 단계 실패 시 OAuth UPDATE 도 되돌림. 커밋은 명시적으로 `'add_missing'`. 변이 3종(파일 검사를 커밋 뒤로·rejected 표시 제거·검증 전 ZIP 쓰기) 잡힘.
- Migrations / restore implications: migration 없음. **복원 무결성이 엄격해짐**(항목 1): 실제 `./data` 에 다른 키 집합의 수동 해결 행이 있으면 그 묶음 복원이 integrity 로 거부될 수 있다 → 적용 전 읽기 전용 확인 필요(아래 남은 위험).
- Actual commands and results (클라우드 Node v22.22.2, pnpm 12.6.0, 오케스트레이터 순차 재실행):
  - `corepack pnpm install --frozen-lockfile` → exit 0, lockfile sha256 `8db0ef8abda74fda…` 그대로
  - `pnpm lint` / `pnpm typecheck` / `pnpm build` → exit 0
  - `pnpm test` → 81 files / 1931 tests PASS
  - `pnpm test:integration`(단독) → 51 files / 952 tests PASS, 278.6 s
  - `pnpm drill:mock` → exit 0, 불변식 위반 0
- External calls performed: none(Anthropic·Threads 0 — 가짜 fetch, 네트워크 차단 가드). `.env.local`·`./data` 미접근.
- Mock-only functionality: 시험은 모의·가짜 fetch. 항목 3 은 실제 Claude 출력 후처리 코드(D35 사용 중)를 바꾼다.
- Known risks / not run:
  - Codex 검증 **미실행**(클라우드). `drill:restore`(실제 DB) 미실행 — 실제 `./data` 의 수동 해결 행 형식을 읽기 전용으로 확인한 뒤 적용 권장.
  - 상한 고려 규칙은 actual > reserved 이면 settled > actual 을 허용 → 예약액 위에서 임의 불일치도 통과. 월 한도가 예약액과 정확히 같은 경계는 거부될 수 있음.
  - A3 공백 유지: 부분 복원에서 빠진 지출은 대상 월 합계에 안 들어가고 미리보기 경고 없음(선택 과제 B — UI 변경이라 이번에 안 함).
  - 항목 3 은 실제 Claude 후처리 동작 변경: 확인할 claim 수와 "출처 미확인 … N건" 경고 수가 줄 수 있음.
  - A2·항목 5 의 고정 기준 시각은 실행이 MSK 월 경계를 넘으면 흔들릴 수 있음. 복원 동시성은 PGlite 단일 연결에서만.
  - H1 의 resolve 단계를 helper 로 옮기지 않고(H1 시험 수정 회피) 새 `resolveUnstorable` 에 복사.
- Questions specifically for Codex / reviewers:
  1. `settled_amount`: "같음, 또는 actual > reserved 일 때만 큼"이 맞는가, 5단계를 글자대로 읽어 엄격히 같음 + 실제 청구는 `reason` 에만 적어야 하는가?
  2. `resolution` 이 붙은 `provider_unstorable` 행(반쯤 끝난 상태)을 거부하는 것이 맞는가, 허용해야 하는가?
  3. 키 6개 정확히·길이 200/4000 이 맞는가(인계 4단계 예시에는 키 5개만 나온다)?
  4. 항목 3: 원래 Codex LIVEL1-H1 지적 원문 없이 실제 출력 후처리를 바꾸는 것이 허용되는가(경고 수가 줄어드는 부작용)?
  5. 항목 4 A3: 미리보기에 막지 않는 경고를 넣을지, 부분 복원을 막을지?
  6. 월 경계에서 흔들릴 수 있는 고정 기준 시각 시험이 허용 가능한가?
- Next authorized task: 독립 검토(Claude, Codex 아님) — LIVE-P2 FIX1·EXPIRY-1 FIX1·LIVEL1-H2 → 확인된 지적 FIX.

---

# FIX round 2 (2차 Claude 독립 검토 — Codex 아님)
- BASE_SHA: 41bd767 (2차 검토 기록 docs) · **HEAD_SHA: 561bc5f** (`561bc5f9e6c73ca9164913b0e1ab86e786207a68`) — LIVE-P2·EXPIRY-1·LIVEL1-H2 지적을 한 커밋으로 처리.
- 검토: 2차 Claude 독립 검토(Codex 아님, `D39_CLAUDE_REVIEW.md` 2차) 확정 12건(중복 2쌍, 실질 10건, 전부 P2), 기각 2건.
- 명령(클라우드 Node 22.22.2, 오케스트레이터 순차 재실행): install --frozen-lockfile(lockfile 불변) · lint · typecheck · build PASS · unit 81 files / 1934 · integration 51 files / 956 · drill:mock 위반 0 · test-dev-cert.sh 251/251 · bash -n ok · data/dev-certs 생성 없음.
- FIX round 2 자체는 아직 독립 검토하지 않았다(필요하면 3차 검토). Codex 미검증.

- 지적: 운영자 수동 해결 절차(LIVEL1_IMPLEMENTATION_HANDOFF 4~7단계)가 H2 의 새 복원 규칙을 반영하지 않아, 평소대로 해결한 뒤 만든 백업이 복원 때에야 실패할 수 있음.
- 변경: 4~7단계 다시 씀 — 키 6개 닫힌 집합, `resolved_at` 은 Z 로 끝나는 UTC, `settled_amount` 소수 6자리이고 상한 경우 외에는 `actual_amount` 와 같음, 4~6단계를 한 문장 SQL 로. 새 읽기 전용 점검 `corepack pnpm bundle:check <zip>`(`packages/db/scripts/bundle-check.ts`) — restore:preview 와 같은 묶음 검증을 DB 를 열지 않고(쓰기·.env.local 없음) 실행, exit 0(통과)/1(무결성 등)/2(사용법). `restore:preview` 는 restore_runs·감사·ZIP 사본을 쓰므로 버려도 되는 DB 에서만 쓰라고 문서화.
- 시험: 문서의 SQL 블록을 그대로 읽어 같음·상한 두 경우 실행 → 내보내기 → `bundle:check` 통과·복원 미리보기 통과. 흔한 실수 6종(`to_jsonb(now())`, `now()::text`, 키 추가, `"9.95"`, 숫자 9.95, 옛 5키 예) integrity 거부. 실행한 스크립트 exit 0/1/2/1, DATABASE_URL 폴더 미생성. 변이 4종(문서 SQL 2·checkBundleZip·exit 코드) 실패.
- 남은 위험: 시험이 인계 문서의 SQL 블록 형식에 묶임(문서 형식을 바꾸면 시험 실패), PGlite 용 SQL 콘솔은 여전히 없음, 무결성 메시지는 실패한 칸 이름을 말하지 않음.
- 검토자에게 물을 것: (1) `bundle:check` 가 아직 provider_unstorable 인 행을 정보로 알려야 하는가? (2) 무결성 메시지에 칸 이름을 넣어야 하는가(H2 정확 문자열 단언 변경 필요)? (3) 시험이 문서의 SQL 을 읽는 결합이 허용되는가?

---

# FIX round 3 (3차 Claude 독립 검토 — Codex 아님)
- BASE_SHA: 2803382 (3차 검토 기록 docs) · **HEAD_SHA: e7c73c9** (`e7c73c9c13d03ea4a268179291c2d97e8bda4a59`)
- 검토: 3차 Claude 독립 검토(Codex 아님, `D39_CLAUDE_REVIEW.md` 3차) — FIX2 561bc5f 대상, 확정 3건(전부 P2)·기각 3건.
- 명령(클라우드 Node 22.22.2, 오케스트레이터 순차 재실행): install --frozen-lockfile(lockfile 불변) · lint · typecheck · build PASS · unit 81 files / 1934 · integration 51 files / 959 · drill:mock 위반 0 · test-dev-cert.sh 271/271 · bash -n ok · 변경 파일 보이지 않는 문자 0 · data/dev-certs 생성 없음. Codex 미검증.
- 지적: (a) 4~6단계 SQL 이 자기 입력을 검사하지 않아 잘못 채워도 반영되고(실제 연결 차단 해제·최상위 reported 삭제), 7-③ 실패 뒤 다시 실행하면 조용히 0행, 흔한 수정 방법은 `original_reported` 를 지움, "UPDATE 1" 확인 안내 없음, `bundle:check` 는 아직 provider_unstorable 인 행이 있어도 exit 0. (b) 7-④ 는 ZIP 사본이 버리는 DB 쪽에 남는다고 했지만 `restore:preview` 는 `RESTORE_LOCAL_DIR` 에 쓴다.
- 변경(`LIVEL1_IMPLEMENTATION_HANDOFF.md` 4~7단계, `packages/db/scripts/bundle-check.ts`, `packages/db/src/restore.ts`):
  - 해결문: 자리표시마다 `values` 한 행에 한 번, `actual_amount`·`overage_amount`·`over_budget` 을 한 `<ACTUAL>` 에서. WHERE 가드 = `isValidResolution` 규칙(출처 provider|none, 정산 `^(0|[1-9][0-9]{0,39})\.[0-9]{6}$`·실제 정수부 12자리, 같음 또는 정산 > 실제 > 예약, resolved_by ≤200·reason ≤4000 UTF-16·공백 아님 — JS `trim()` 과 같은 집합, BMP 전수 대조 25=25). 캐스트는 `CASE` 뒤라 `'abc'` 도 SQL 오류 대신 0행. 대상 행은 이 owner·이 id·settled·여전히 provider_unstorable·최상위 reported 3개 유효. `returning` 으로 1행 확인, "결과가 UPDATE 1" 안내, 읽기 전용 확인 질의(`target_resolved` = 1, `unresolved_rows`).
  - 수정문(이미 resolution 이 있는 행): resolution 의 resolved_at·resolved_by·reason·settled_amount 4개 키, usage_source, 금액 칸만 변경. `original_usage_source`·`original_reported` 바이트 그대로. 같은 가드. 추가 키·original_reported 없음·무효면 0행 + "멈추고 1단계 백업 보관".
  - `bundle:check`: 통과 시 stdout JSON 에 `unresolved_live_usage`(건수만), stderr 건수 안내 1줄, exit 코드 그대로. 7-③ 에서 해결한 수만큼 줄었는지(모두 해결이면 0) 확인.
  - 7-④: `DATABASE_URL` 과 `RESTORE_LOCAL_DIR` 를 모두 버리는 폴더로, 끝나면 둘 다 삭제. 쓰기 경로 인용: `scripts/restore.ts:53-75`, `createRestorePreview`(mkdir + `<id>.zip` writeFile), `client.ts` `createDb`(DB 폴더·잠금 파일). 저장소는 commit 에서만.
- 시험(`tests/integration/live-llm.test.ts`, 문서의 두 문장을 그대로 읽음): 잘못 채움 32종 → 0행(대상·같은 owner 다른 미해결 행·다른 owner 행 그대로), 올바른 채움(경계 길이·none·상한) → 1행·묶음 통과·재실행 0행, 수정문으로 깨진 resolution 5변형 복구(original_reported 원래 값), 못 고치는 9형태 0행, 실제 `restore:preview` 를 임시 작업 공간에서 문서 값으로 실행해 두 폴더만 생성·ZIP 은 RESTORE_LOCAL_DIR. 문서·코드 변이 21/21 잡힘(처음 살아남은 2개 — 출처 가드 제거·usage_source 조건 제거 — 는 시험 강화로 잡음). FIX2 문장 복원 시 실패.
- 차이: 수정문도 usage_source 를 가드 아래 다시 씀(FIX3 전 채움이 `'providers'` 를 넣었을 수 있음). SQL 은 `none` ⇒ actual = reserved 를 강제(6단계대로, 검증기보다 엄격). id 는 텍스트 비교라 대문자 uuid 는 0행(2단계 출력 그대로 붙이라고 문서화).
- 남은 위험: SQL 가드는 bundle.ts 규칙을 손으로 옮긴 것(새 규칙은 문서-SQL 시험으로만 드러남), 추가 키·original_reported 없는 옛 수동 해결 행은 복구 절차 없음(멈춤 안내), README T05 CLI 예시도 DATABASE_URL 만 설정(합성 데이터 예라 범위 밖으로 둠), Windows Git Bash·macOS 미실행.
- 검토자에게 물을 것: (1) 수정문이 usage_source 를 바꿔도 되는가? (2) none ⇒ actual = reserved 를 SQL 에서만 더 엄격하게 둔 것이 맞는가? (3) 추가 키·original_reported 없는 행에 1단계 백업으로부터 재구성 절차가 필요한가? (4) stderr 안내 + JSON 칸 형태가 맞는가?

---

# FIX round 4 (4차 Claude 독립 검토 — Codex 아님)
- BASE_SHA: 8bff163 (4차 검토 기록 docs) · **HEAD_SHA: fb1fa58** (`fb1fa58a1d6a196a230701a9341fba4d95181154`)
- 검토: 4차 Claude 독립 검토(`D39_CLAUDE_REVIEW.md` 4차) — FIX3 e7c73c9 대상, 확정 11건(실질 전부 P2)·기각 4건. 대부분 손으로 채워 실행하는 수동 해결 SQL 에서 나옴.
- **판단(근본 원인 수정 — 확인 필요):** SQL 가드를 더하는 대신 수동 SQL 을 없애고, 앱 검증기(`isValidResolution`)를 그대로 쓰는 CLI `corepack pnpm ledger:resolve` 로 대체. 운영 절차가 SQL → 명령으로 바뀐다.
- 만든 것:
  - `packages/domain/src/bundle.ts`: `resolutionProblem(snap,row)`(첫 실패 규칙 또는 null) + 행 단위 원장 검사 `usageLedgerRowProblems(r)` 분리 — `isValidResolution`·`checkIntegrity` 의 판정·메시지·순서 그대로.
  - `packages/domain/src/ledger-resolution.ts`(순수): `classifyLedgerRow` → resolve / correct(`--correct` 필요) / refuse(사유 코드), `planLedgerResolution` 이 내보내기 형식의 새 행을 만들어 `resolutionProblem`·`usageLedgerRowProblems`·행 스키마를 통과할 때만 계획 반환. CLI 자체 규칙은 더 엄격한 두 가지(`--actual` 정규형 소수 6자리·정수부 12자리, none ⇒ actual = reserved) + NUL·짝 없는 서로게이트 거부.
  - `packages/db/src/ledger-resolve-cli.ts` + `packages/db/scripts/ledger-resolve.ts`: `--list`(읽기 전용 — 후보 행·보고 값·처리 방식·복원 검사 통과 여부), 기본 미리보기(아무것도 안 씀, by/reason 은 길이만), `--confirm`(행 잠금 → 다시 읽어 전체 비교 → 값 조건 UPDATE 정확히 1행 → 다시 읽어 재검증 → 감사 `usage_ledger.manual_resolve`(건수·금액만) → `updated 1`). 잠금 오류는 잠금 안내, 그 밖은 `describeErrorSafely`. exit 0/1/2.
  - 운영 절차 `LIVEL1_IMPLEMENTATION_HANDOFF.md` 2·4~7단계 CLI 로 다시 씀(손으로 쓰는 SQL 미지원 + 이유), 1단계 백업 유지, README 명령 행.
- 4차 지적 처리: #1 역슬래시 — SQL 없음(소수점 빠짐·지수·이모지 101개 표 시험) · #2·#5 확인 질의 — 없앰, `updated 1` + exit 0 / 거부는 exit 1·행 그대로, 잘못된 id 는 exit 2 · #3 최상위 reported 형식 — `reported_invalid` 시험 · #4 수정 대상·이웃 행 — `--correct` 필수, `--list` 가 복원 검사 통과 여부 표시, 이미 유효하면 미리보기 경고 · #6 반쯤 끝난 옛 행 — `--correct` 없이 최상위 값으로 해결, 위험하면 `partial_resolution_unsafe` · #7 `bundle:check` 미해결 건수 — 건너뛸 행(provider·none(실패)·estimate·옛 행)과 셀 행(실패 포함) 섞어 2→1→0(`checkBundleZip`·실제 스크립트) · #8 수정 모드 가드 — 잘못 채움 전체를 수정 모드에도 · #9 `.env.local` 우선순위 — 임시 작업 공간 `.env.local` 경로는 비어 있고, 대조로 `.env.local` 의 AUTH_ALLOWED_IDENTITY owner 가 버리는 DB 에 생김(파일을 실제로 읽음) · #10 공백 — JS `trim()` 25문자 전체를 by·reason, resolve·correct 모두 · #11 문서 경로 — `<날짜>` 포함·기본 DB/복원/내보내기/저장소/가져오기 폴더와 같거나 안이거나 포함하지 않음.
- 제거·대체한 시험(`live-llm.test.ts`): FIX3 의 4~6 문장 시험·수정문 시험(+SQL 도우미) — 없어진 SQL 대상, 모든 경우를 새 파일로 같거나 더 강한 "행·다른 행 그대로" 단언과 함께 옮김. 예외: 대문자 uuid(이제 같은 행으로 해결 — SQL 텍스트 비교 부작용이었음), 자리표시 1회 검사(이제 문서의 명령 한 줄을 파싱·채워 실행), 재실행 0행(이제 `needs_correct`·행 그대로), 확인 질의 단언(→ `updated 1`·`hasUnresolvedLiveUsage`). FIX2 시험은 CLI 로 해결하도록 바꿈(`resolved_at` 은 마이크로초 정규식 → 주입 시각과 정확히 같음, reason 정확 일치 추가). 7-④ 시험 목록에 `.env.local` 추가.
- 변이: 26 중 25 잡힘. 남은 1개 = UPDATE 의 값 조건만 제거(행 전체 재비교가 먼저 잡음 — PGlite 단일 연결에서는 따로 시험 불가), 둘 다 제거는 잡힘.
- 명령(클라우드 Node 22.22.2, 오케스트레이터 순차 재실행): install --frozen-lockfile(lockfile 불변) · lint · typecheck · build PASS · unit 81 files / 1934 · integration 52 files / 980 · drill:mock 위반 0 · test-dev-cert.sh 271/271 · 변경 파일 보이지 않는 문자 0 · 실제 `./data` 미접근(구현 에이전트: data 아래 1269개 mtime 전후 동일).
- 차이: `--list` 추가(2단계도 손으로 쓰는 SQL 이었음), 수정 모드는 현재 usage_source 를 provider|none 으로 한정하지 않음(original_* 증거가 있으면 `providers`·덜 바뀐 `provider_unstorable` 도 수정), 문서 경로는 `./data/pglite-check-<날짜>`(gitignore 안 — "기본 data 폴더와 겹치지 않음"으로 해석), 미리보기는 by·reason 길이만.
- 남은 위험: UPDATE 뒤 재검증은 결함 주입 시험 없음, UPDATE 값 조건은 재비교와 분리 시험 불가, 일부 `resolution:*` 사유 코드는 계획기 버그 없이는 도달 불가, Windows Git Bash 인용·UTF-8 인자 미확인, Postgres 동시성 미검증, 추가 키·original_reported 없는 옛 행은 여전히 멈춤.
- 검토자에게 물을 것: (1) 미리보기가 by·reason 을 그대로 보여 셸 변형을 보이게 해야 하는가? (2) `--confirm` 이 미리보기 지문(`--expect <hash>`)을 요구해야 하는가? (3) 이미 복원 검사를 통과하는 행 수정에 추가 플래그가 필요한가? (4) `--list` 가 보고 값을 출력하는 것이 허용되는가? (5) 수정 모드의 넓은 usage_source 허용이 맞는가?
