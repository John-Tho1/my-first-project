# Implementation handoff — T05
- Task ID / milestone: T05 / M1 (Markdown/JSON/파일 export 와 import preview/복원) — **M1 마지막 작업**
- Purpose and changed behavior: owner 데이터 전체를 번들(manifest.json + data/<table>.json + markdown/ + assets/ + README.md)과 store-only ZIP 으로 내보내고, 업로드/기존 export 로 복원 미리보기(파일 sha256 전수 검증·migration 호환·행 스키마·참조 무결성·충돌 계산) 후 confirm 커밋(empty_only | add_missing, 기존 행 절대 덮어쓰지 않음, ID 보존, owner 재매핑).
- BASE_SHA: 97dd427ff56b6e22f266261e4021fb815142619e
- HEAD_SHA: be3fd8f5e1fa2033fcbb67f31c6352475a08647c
- Clean tracked tree confirmed: yes
- Relevant acceptance IDs: M1 T05, **M1 통과 조건**(10개 가상 소재 입력→검색→원고 수정→export→빈 DB 복원 후 ID 관계·본문·checksum 일치), A18, docs/02 "export 에서 OAuth/API key 제외", docs/07 "실제 복원 결과 없이 안전이라고 표시하지 않음"
- Changed files: `git show --stat be3fd8f`. 주요: `packages/domain/src/{zip,bundle}.ts`, `packages/db/src/{bundle-tables,export,restore}.ts`, `packages/db/scripts/{export,restore}.ts`, `packages/db/drizzle/0004_t05_exports.sql`, `apps/web/app/api/{exports,restores}/**`, `apps/web/app/settings/**`, `apps/web/lib/backup.ts`, `tests/integration/export-restore.test.ts`, `docs/DECISIONS.md`(D6), `README_KO.md`, `.env.example`(EXPORT_LOCAL_DIR, RESTORE_LOCAL_DIR)
- Migrations / restore implications: `0004_t05_exports`(export_runs, restore_runs; 둘 다 번들 제외). 번들 제외 표: sessions, export_runs, restore_runs. audit_events 는 export 만(복원 안 함). users 는 복원하지 않고 현재 계정으로 재매핑. 표 JSON 에 owner_id 없음(manifest.owner 에 1회). 스키마에 표를 추가하면 `bundle-tables.test.ts` 가 EXPORTED/EXCLUDED 누락을 실패로 잡는다.
- Actual commands and results (클라우드, 오케스트레이터 재실행):
  - `corepack pnpm install --frozen-lockfile` → pass, lockfile 변경 없음
  - `pnpm lint` / `pnpm typecheck` → pass
  - `pnpm test` → pass 17 files / 273 tests
  - `pnpm test:integration` → pass 10 files / 115 tests, 20.1s (export-restore 14건 포함)
  - `pnpm build` → pass
  - `pnpm db:migrate` → 0004 적용; `pnpm db:seed` → 0 inserted / 10 total
  - **CLI 게이트**(임시 DB 2개, 삭제됨): seed 10 → export(zip 28,476B, 25 files, restorable_rows 14) → 빈 DB migrate → restore:preview(can_commit_empty_only true, 충돌 0) → restore:commit --mode empty_only --confirm(brand_profiles 1, sources 3, captures 10) → 재export → 표 13개 중 sha256 상이 표는 `users`(owner id 상이)·`audit_events`(복원 안 함)뿐, 나머지 11개 표 해시 일치
  - `pnpm test:e2e` → NOT_RUN(exit 2)
  - 구현 에이전트 smoke(별도 DB, 삭제됨): POST /api/exports 201 → GET zip 200 application/zip(무쿠키 401) → preview(export_id) 200(같은 owner, 충돌 0) → commit confirm 없음 400 → empty_only 409 restore_target_not_empty → add_missing 200(14 skipped_identical) → 재커밋 409 already_committed → /settings 200(“안전”·“백업 완료” 문구 없음)
  - 변이 검증(구현 에이전트): getExportRun owner 필터 제거 시 2건, add_missing 덮어쓰기로 바꾸면 게이트 테스트(6) 실패 확인 후 복원
- Demo route / local start steps: 로그인 → `/settings` → 내보내기 → 다운로드; 복원은 zip 업로드 → `/settings/restores/{id}` 미리보기 → 확인 체크 → 커밋. CLI 는 README_KO.md "내보내기·복원 (M1, T05)".
- External calls performed: none.
- Mock-only functionality: 해당 없음(LLM 미사용).
- Known risks / not run:
  - Codex 검증 **미실행**, 실제 브라우저 미확인.
  - 번들 미암호화(T20). 업로드 미리보기는 zip 전체(≤256MB)를 메모리에 올림.
  - 다른 도구로 재압축(deflate)한 zip 은 거부(store-only 만).
  - 같은 DB 의 다른 owner 로 복원하면 ID 보존 때문에 전부 id_in_use 충돌.
  - 커밋 실패 시 DB 는 롤백되나 이미 쓴 asset 파일은 남을 수 있음.
  - PGlite 단일 연결에서 REPEATABLE READ 스냅샷은 사실상 무의미; PostgreSQL 미검증.
- Questions specifically for Codex:
  1. ZIP 리더의 EOCD/central directory 파싱이 악의적 오프셋·중복 항목·CRC 우회에 안전한지.
  2. 복원 커밋 트랜잭션의 FK 삽입 순서와 `contents.current_version_id` 후행 갱신이 불변 트리거·CHECK 와 충돌하지 않는지.
  3. add_missing 의 dependency 충돌 규칙이 부분 복원으로 관계를 깨뜨릴 수 있는 경우가 남아 있는지.
  4. 번들의 markdown 이 원문(raw_text)을 문자 그대로 보존하는지(펜스 충돌 등).
- Next authorized task: 없음. M0+M1 완료. M2(T06~)는 사용자 승인 후. 이 세션의 5개 인계(T01~T05)를 사용자 로컬 PC 에서 Codex 로 검증 요망.
