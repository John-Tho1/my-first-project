# Implementation handoff — T03
- Task ID / milestone: T03 / M1 (한 문장/URL 저장·원문 보존·수정 충돌·중복 후보)
- Purpose and changed behavior: 텍스트/URL 수집 API·화면, command_key 멱등, 원문(raw_text) 불변 + 메모/제목/위험만 revision 기반 수정(stale → 409, 입력값 반환), 정확 중복(정규화 URL·내용 해시)·유사 후보(문자 bigram Jaccard), 추출 요청은 SSRF 가드 후 수집 비활성으로 차단(fetch 0).
- BASE_SHA: f20f5bb88dccd78273a2f1b4163ace31a0510e5d
- HEAD_SHA: 55be7108597d9093ebd48911e82fbbef4226aa9e
- Clean tracked tree confirmed: yes
- Relevant acceptance IDs: M1 T03, A02(stale 편집 → 충돌 표시·원문 손실 없음), A04(발행 지시문은 자료), A05(내부 주소 추출 차단·메모 저장), A19(서버 저장만 저장으로 표시)
- Changed files: `git show --stat 55be710`. 주요: `packages/domain/src/{url,similarity,capture}.ts`, `packages/db/src/captures.ts`, `packages/db/drizzle/0002_t03_captures.sql`, `apps/web/app/api/captures/**`, `apps/web/app/captures/**`, `apps/web/lib/{body,captures,labels}.ts`, `tests/integration/captures.test.ts`, `docs/DECISIONS.md`(D4), `README_KO.md`
- Migrations / restore implications: `0002_t03_captures`(capture_revisions, captures.revision/updated_at/content_hash(nullable)/title, sources.normalized_url 부분 unique, source_versions.raw_hash nullable). drizzle-kit 출력의 제약 순서를 손으로 조정(파일 헤더 기재). content_hash 는 SQL backfill 없이 seed/insert 경로가 채움. T05 export 는 capture_revisions·sources·source_versions 포함 필요.
- Actual commands and results (클라우드, 오케스트레이터 재실행):
  - `corepack pnpm install --frozen-lockfile` → pass, lockfile 변경 없음
  - `pnpm lint` / `pnpm typecheck` → pass
  - `pnpm test` → pass 12 files / 216 tests
  - `pnpm test:integration` → pass 6 files / 72 tests, 11.7s
  - `pnpm build` → pass (/api/captures, /api/captures/[id], /api/captures/[id]/extract, /captures, /captures/[id])
  - `pnpm db:migrate` → 0002 적용; `pnpm db:seed` → 0 inserted / 10 total(URL fixture 3건 → sources 3행)
  - `pnpm test:e2e` → NOT_RUN(exit 2)
  - 구현 에이전트 smoke(별도 DB, 삭제됨): 텍스트 수집 201 → 같은 command_key 200 created:false; `http://localhost/x` 수집 201 → extract 400 url_not_allowed; PATCH If-Match "1" 200 etag "2" → 같은 PATCH 409 current/yours; `/captures` 200; 폼 저장 303 → `서버에 저장됨 ✓`
  - 변이 검증(구현 에이전트): revision 조건 제거 시 3건, assertFetchableUrl 제거 시 6건 테스트 실패 확인 후 복원
- Demo route / local start steps: `pnpm dev` → 로그인 → `/` 빠른 수집 → `/captures/{id}`. README_KO.md "수집 (M1, T03)".
- External calls performed: none.
- Mock-only functionality: 추출은 어떤 모드에서도 fetch 하지 않음(enabled 면 501 collector_not_implemented, T19).
- Known risks / not run:
  - Codex 검증 **미실행**, 실제 브라우저 미확인.
  - URL 가드는 DNS 미조회(`127.0.0.1.nip.io` 류·redirect 는 T19 fetch 시점 재검사 필요).
  - 유사도 임계값 0.45 는 소수 문장으로만 확인; 최근 200건만 비교.
  - 충돌 시 입력값이 redirect 쿼리(≤2000자)에 실려 브라우저 히스토리에 남음; 초과 시 409 HTML 페이지로 대체.
  - 생성 폼 검증 실패 시 입력 텍스트 손실(브라우저 maxLength/type=url 로 완화).
  - HTML 폼 수정은 POST + `_method=PATCH`.
- Questions specifically for Codex:
  1. `updateCapture` 의 조건부 UPDATE(revision = expected)가 동시 편집에서 lost update 를 막는지, 'system' 이력 삽입과의 순서가 안전한지.
  2. `assertFetchableUrl` 우회 사례(IPv6 변형, 퍼센트 인코딩 호스트, 숫자 표기) 잔존 여부.
  3. 정규화 URL unique 와 sources upsert 의 경합.
  4. 커서 페이지네이션의 누락/중복 가능성(received_at 동일 값).
- Next authorized task: T04 (콘텐츠 카드·검색·필터·버전·원고 원문/파생 관계)
