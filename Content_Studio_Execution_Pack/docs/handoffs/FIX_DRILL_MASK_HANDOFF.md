# 업로드 세션 URI 이중 가림 수정 인계 (오케스트레이터 직접 수정, 2026-10-03)
- BASE: 6b7b7bd 이후 · HEAD_SHA: 0c86db2 (코드만, D28). 구현: Claude(오케스트레이터, Opus 5.5) — 작은 수정이라 직접. 검증: Codex.
- 발견: M4 화면 확인 중 실제 로컬 DB 에 처음으로 YouTube 업로드 세션 단계가 생긴 뒤 `pnpm drill:restore` 가 FAIL — remote_steps.remote_id content_sha256 불일치 1건.
- 원인: `packages/db/src/bundle-tables.ts` selectExpr 는 내보낼 때 upload_session 의 remote_id 를 `mock-redacted:session:<sha256 앞 16자>` 로 가린다. FIX-T14 이후 복원이 가린 값을 그대로 넣으므로, 복원된 DB 를 같은 식으로 읽으면(복원 훈련의 대상 읽기, 복원 뒤 다시 내보내기) 이미 가린 값을 다시 가려 값이 바뀐다.
- 변경: 가림 조건에 `remote_id not like 'mock-redacted:%'` 추가 — 이미 가린 값은 그대로.
- 시험: tests/integration/youtube.test.ts "업로드 세션이 있는 owner 의 복원 훈련 PASS — 이미 가린 세션 값을 다시 가리지 않는다" — runRestoreDrill mismatches [] + 복원 대상 재내보내기의 가린 값 = 원래 묶음의 가린 값. 수정을 빼면 remote_steps 불일치로 실패함을 확인.
- 명령(Windows 10, Node 24.21.0): lint·typecheck·build PASS, unit 39 files/745, integration 31 files/570, drill:mock 위반 0, db:migrate, 실제 로컬 DB drill:restore PASS.
- Codex 에게: (1) 원본 remote_id 가 우연히 'mock-redacted:' 로 시작하는 경우(현재 CHECK 는 'mock%' 이고 모의 세션 URI 는 mock://… 라 불가)를 막아야 하나? (2) 가린 세션 행이 복원된 뒤 조회가 unknown 으로 끝나는지(FIX-T14 규칙) 외에 확인할 경로가 있나?
