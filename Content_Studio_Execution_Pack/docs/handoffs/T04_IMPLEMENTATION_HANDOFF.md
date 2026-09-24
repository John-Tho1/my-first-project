# Implementation handoff — T04
- Task ID / milestone: T04 / M1 (콘텐츠 카드·검색·필터·버전·원고 원문/파생 관계)
- Purpose and changed behavior: 아이디어 카드(Idea/Audience/Evidence/Risk/Next Decision) CRUD, 원고(contents) 생성·메타 수정·불변 본문 버전 append(base_version CAS → 409), 버전 열람·줄 diff, 소재↔카드↔원고 관계(정션, 같은 owner 복합 FK), 통합 검색(한국어 부분 일치 + pg_trgm 점수), 아카이브 필터·커서.
- BASE_SHA: 55be7108597d9093ebd48911e82fbbef4226aa9e
- HEAD_SHA: 97dd427ff56b6e22f266261e4021fb815142619e
- Clean tracked tree confirmed: yes
- Relevant acceptance IDs: M1 T04, A01, A02, M1 통과 조건 중 "검색→원고 수정", "한국어 검색 별도 확인"
- Changed files: `git show --stat 97dd427`. 주요: `packages/db/drizzle/0003_t04_contents.sql`, `packages/db/src/{ideas,contents,search,schema,client}.ts`, `packages/domain/src/{content,diff}.ts`, `apps/web/app/api/{ideas,contents,search}/**`, `apps/web/app/api/captures/[id]/{ideas,contents}/route.ts`, `apps/web/app/{ideas,contents,search}/**`, `apps/web/app/layout.tsx`(내비), `tests/integration/{contents,ideas,search}.test.ts`, `docs/DECISIONS.md`(D5), `README_KO.md`
- Migrations / restore implications: `0003_t04_contents` — `CREATE EXTENSION pg_trgm`(운영 PostgreSQL 에 확장 설치 권한 필요), `ideas.source_capture_ids` **삭제**(idea_captures 로 이관), contents lifecycle CHECK(draft|review|ready|archived), `content_versions` UPDATE/DELETE 금지 트리거, GIN trigram 색인. drizzle-kit 출력을 손으로 재배치(파일 헤더 기재). T05 export 는 content_captures·idea_captures·content_versions.note·tags·revision 포함 필요.
- Actual commands and results (클라우드, 오케스트레이터 재실행):
  - `corepack pnpm install --frozen-lockfile` → pass, lockfile 변경 없음
  - `pnpm lint` / `pnpm typecheck` → pass
  - `pnpm test` → pass 14 files / 239 tests
  - `pnpm test:integration` → pass 9 files / 101 tests, 17.1s
  - `pnpm build` → pass
  - `pnpm db:migrate` → 0003 적용(기존 T03 데이터 위); `pnpm db:seed` → 0 inserted / 10 total
  - `pnpm test:e2e` → NOT_RUN(exit 2)
  - 구현 에이전트 smoke(별도 DB, 삭제됨): 소재→원고 201(v1), 버전 append base 1 → 201 v2, 같은 base 1 재요청 → 409 current/yours, `/api/search?q=주재원` → fx-007 + 새 초안, 페이지 `/contents`·`/search`·`/ideas`·diff 200, 무쿠키 307
  - 변이 검증(구현 에이전트): base_version 검사 제거 시 3건, 검색 owner 필터 제거 시 4건 실패 확인 후 복원
- Demo route / local start steps: 로그인 → `/captures/{id}` → `카드로 발전`/`원고 시작` → `/contents/{id}` 편집·버전·diff → `/search?q=주재원`. README_KO.md "카드·원고·검색 (M1, T04)".
- External calls performed: none.
- Mock-only functionality: 이 작업은 LLM 을 사용하지 않음(모의 AI 보조는 T06).
- Known risks / not run:
  - Codex 검증 **미실행**, 실제 브라우저 미확인.
  - 카드·원고 생성에 command_key 없음 → 폼 이중 제출 시 중복 생성 가능(README 기재).
  - 검색은 최근순 정렬, 2자 이하 검색어는 trigram 색인 미사용, 오타 허용 없음; 성능 미측정.
  - 카드 lifecycle(candidate) 전이 규칙 없음.
  - 409 HTML 비교 페이지는 인라인 CSS 색상 하드코딩(T03 과 동일).
- Questions specifically for Codex:
  1. `appendContentVersion` 의 `FOR UPDATE` + currentVersionId 조건 UPDATE 가 동시 append 에서 버전 번호 충돌/유실 없이 동작하는지(unique(content_id, version) 의존 여부).
  2. 불변 트리거가 drizzle migrator 나 향후 migration 에서 우회되지 않는지.
  3. 검색 SQL 의 사용자 입력 이스케이프(ILIKE 의 `%`·`_` 처리)와 owner 격리.
  4. 정션 테이블 복합 FK 가 타 owner capture 연결을 DB 수준에서 막는지(테스트 있음).
- Next authorized task: T05 (Markdown/JSON/파일 export 와 import preview/복원)
