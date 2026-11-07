# FIX2-CODEX 구현 인계 — Codex 14건 제안 처리(원장 누락 경고·D39 명확화·빈 by/reason 거부·복원 결과 불명 모의 문구)

- BASE_SHA: 5ee7037 (FIX1-CODEX docs) · **HEAD_SHA: c189319** (`c1893197ac5e58c6686f04720743a4c8bd6a35e0`)
- 출처: `docs/handoffs/CODEX_14_REVIEWS_2026-10-23.md` 의 결함 아닌 제안 7건(M4_STATUS "2026-10-23 밤 — Codex 14건 결과"). 이 커밋은 Codex 지적의 재수정이 아니다(역사적 해결 항목은 건드리지 않음).
- 사용자 결정(2026-10-23 "다 권고 사항으로 진행해줘", Claude 권고): 7건 중 3건(U1·U2·U3)을 하고, FIX5 후속 검토의 U4 를 함께 넣는다. 나머지 4건(미래 의도 진단·만료 경고 계정 이름·유효/전체 시도 표시·반쯤 끝난 행 값 감사)은 보류한다.
- 진행:
  - 구현 에이전트 1명이 구현했다.
  - 반박 검토 2관점(Claude — Codex 아님)에서 확정 1(P2)·기각 1 이 나왔다.
    - 확정: U1 이 `같은 ID, 내용 다름`(different) 충돌도 "원장 누락"으로 셌다. 이 계정의 같은 행이 남아 월 합계에 들어가므로 경고가 틀린다.
    - 기각: text_blank 가 U+2800·C0/C1 제어 문자를 거르지 않는다. 동작은 사실이지만 이번 변경이 만든 결함이 아니고 문구도 그렇게 약속하지 않는다.
  - 보완 1(P2) 뒤 짧은 재검토(1명): 지적 1(P2)은 기각됐다(아래 검토자에게 물을 것 1).

## 처리
- **U1** 복원 미리보기 경고 `ledger_history_incomplete`(LIVEL1H2 Q5) — `packages/db/src/restore.ts`:
  - 건수만 알린다(금액·ID 없음). 복원은 막지 않는다. 기존 경고와 순서는 그대로다.
  - 미리보기의 dry-run 트랜잭션 안에서 계산한다(조회만, 끝에 되돌림).
  - `ledgerNotRestored`: `없는 항목만 추가`에서 들어가지 않고 이 계정에 그 비용의 원장 행도 남지 않는 비용 원장 행 수. 전체 충돌 목록(잘리지 않은 것)에서 reason 이 `different`·`unique` 인 것은 뺀다.
    - `different`: 같은 ID 행이 이 계정에 이미 있다(내용만 다름).
    - `unique`: 같은 실행·전사 작업의 원장이 이 계정에 다른 ID 로 이미 있다(run_id·transcription_job_id 고유 제약 + 같은 owner 복합 FK 가 보장).
    - 둘 다 기존 행이 남고 `monthlyUsedMicro` 가 더한다. `id_in_use`·`dependency` 와 앞으로 생길 다른 reason 은 센다.
  - `runsWithoutLedger`: dry-run 적용 뒤에도 원장이 없는 묶음의 AI 실행·전사 작업 수(원장 도입 전 실행 등).
  - README_KO 복원 미리보기 절에 세는 행·세지 않는 행을 적었다.
- **U2** D39 명확화(LIVEP2 Q2) — 코드 변경 없음:
  - 같은 작업의 재시도·이어 보내기는 최근 24시간 창 안에서는 한 번만 센다. 창이 지나면 다시 센다.
  - `docs/DECISIONS.md` D39 명확화 줄(2026-10-23), README_KO 상한 절, `.env.example` 주석을 맞췄다.
  - 창 밖 재전송 시험을 `live-publish-daily.test.ts` 에 더했다(창 안 시험은 기존).
- **U3** `ledger:resolve` 빈 by/reason 거부(FIX6-D39 Q4) — `packages/domain/src/ledger-resolution.ts`·`packages/db/src/ledger-resolve-cli.ts`:
  - `--by`·`--reason` 이 공백·기본 무시 문자(U+3164·U+115F·U+1160·U+FFA0·U+200B·U+2060·변이 선택자 등)만이면 `text_blank` 로 거부한다(exit 1).
  - 이 명령만의 규칙이다. 복원 검사 `isValidResolution` 은 바꾸지 않았다(이미 저장된 묶음의 값은 그대로 유효).
  - JS `trim()` 으로 이미 빈 값은 지금처럼 `resolution:resolved_by`·`resolution:reason` 이다. 보이는 글자가 섞인 값은 지금처럼 받고 미리보기가 `\u` 로 보인다.
  - 사용법 줄과 `LIVEL1_IMPLEMENTATION_HANDOFF.md` 4단계 `--by` 행·입력 거부 코드 목록에 `text_blank` 를 넣었다.
- **U4** 복원 때 결과 불명(UNKNOWN)이던 모의 항목의 재시도 거절 — `packages/db/src/jobs.ts` retryItemTx·`packages/domain/src/jobs.ts`:
  - 모의 계정이면 `RESTORED_UNKNOWN_RETRY_MOCK_MESSAGE` + `mock: true` 다. 원격 확인을 시키지 않는다(FIX5 T2 모의 분기와 같은 규칙).
  - 코드 `outcome_unknown`·`restored: true` 는 그대로다. 실제 계정·계정 kind 를 모름은 지금 문구 그대로다.

## 시험
- 새 `tests/integration/fix2-codex-restore-ledger.test.ts` 11건(U1): 완전한 묶음 경고 없음, different(세지 않음), 앱이 만든 경우(전사 예약을 확정한 뒤 다시 미리보기), id_in_use, unique(세지 않음), dependency, 원장 없는 실행, run·전사 작업 원장을 뺀 묶음, 두 건 함께, 기존 경고 순서, `POST /api/restores/preview` 경로.
- 보강: `ledger-resolve-cli.test.ts`(U3·운영 문서 목록), `live-llm.test.ts`(U1 경고), `fix5-fullrev.test.ts`(U4), `live-publish-daily.test.ts`(U2 창 밖).
- 바뀐 기존 단언(결정에 따른 교체, 약화 아님):
  - `ledger-resolve-cli.test.ts` 6차 검토 #2: 한글 채움 문자만인 `--by` 를 받던 단언 → 이제 exit 1·`거부(text_blank)`·빈 stdout. 보이는 글자가 섞인 값(`\u3164\u3164op` — 한글 채움 문자 둘 + op)을 받는 단언을 더했다.
  - `ledger-resolve-cli.test.ts` 운영 문서 확인: `--by` 행·입력 거부 코드 목록에 `text_blank` 를 더했다(강화).
  - `live-llm.test.ts` A3: 경고 없음(`toEqual([])`) → 경고 배열 전체 `toEqual`(원장 누락 1건, dependency 경우).
- 변이 확인: 구현의 각 제품 변경을 하나씩 되돌려 새 시험이 실패함을 확인했다. 보완은 M1(전체 되돌림)·M2(`unique` 다시 셈)·M3(`id_in_use` 뺌) 셋 모두 잡혔다. 복원 뒤 cmp 일치, 남긴 변이 없음.

## 명령(클라우드 Node 22.22.2, 오케스트레이터 순차 실행, c189319 와 같은 파일)
- install --frozen-lockfile(lockfile sha256 앞 16자 `8db0ef8abda74fda` 불변) · lint · typecheck · build PASS
- **unit 83 files / 2034 · integration 62 files / 1120**
- drill:mock 불변식 위반 0 · test-dev-cert.sh 472/472
- 보이지 않는 문자 검사 14 파일 0 · 실제 `./data` 스냅숏 전후 같음 · 외부 호출 0
- not_run: Codex, 실제 Postgres 다중 연결, 브라우저, Windows Git Bash·macOS, 실제 원장 해결 행이 있는 DB 의 `ledger:resolve`, 실제 원장 도입 전(0008 이전) 묶음 복원.

## 남은 위험
- U1 은 건수 경고다. 남은 같은 owner `different` 행의 금액이 묶음보다 작아도(예: 대상은 `reserved` 예약액, 원본은 뒤에 초과 정산) 경고하지 않는다 — 재검토 지적, 기각(아래 1).
- 같은 비용이 `ledgerNotRestored`(dependency)와 `runsWithoutLedger` 에 함께 잡힐 수 있다(둘 다 사실 — 손으로 고친 묶음이나 부모 실행이 `different` 인 경우).
- `dependency`·`unique` 충돌은 손으로 고친 묶음에서만 거짓 양성이 날 수 있다(앱이 만든 묶음에서는 생기지 않음).
- 0008 이전(원장 파일 없음) 실제 묶음으로는 시험하지 않았다(같은 상태 — 원장 없는 실행 — 로만).

## 검토자에게 물을 것
1. 같은 owner `different` 원장 행은 "남은 행이 월 합계에 들어간다"는 이유로 세지 않는다. 남은 행이 예약액·옛 금액이라 묶음보다 적을 때 별도 문구(예: "이 계정 값 유지, 금액 다를 수 있음")가 필요한가?
2. JS 공백만인 by/reason 도 `text_blank` 로 묶어야 하는가? 지금은 기존 코드(`resolution:*`)와 단언을 그대로 두었다.
3. D39: 게시 시도 표식 전에 멈춘 의도와 거부된 의도도 24시간 창에서 센다(보수적). 이대로 괜찮은가?
4. text_blank 가 U+2800(점자 빈칸)·C0/C1 제어 문자를 거르지 않는 것은 범위 밖으로 두었다. 넓혀야 하는가?

## 보류(사용자 결정, 이 커밋에 없음)
- 미래 시각 의도 운영 진단(LIVEP2 Q6), 만료 경고 계정 이름(EXPIRY1 Q4), 유효·전체 시도 구분 표시(FIX2-D39 Q2), 반쯤 끝난 행의 버리는 값 감사(FIX6-D39 Q1).
