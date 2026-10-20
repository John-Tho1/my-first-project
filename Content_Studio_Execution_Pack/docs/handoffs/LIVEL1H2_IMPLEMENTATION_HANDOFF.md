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
