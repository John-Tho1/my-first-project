# Implementation handoff — T02
- Task ID / milestone: T02 / M1 (단일 사용자 로그인·owner 제한·세션 만료·파일 접근 제어)
- Purpose and changed behavior: 개발용 세션 로그인(D3: AUTH_MODE=dev, 비밀번호 없음, localhost 전용, 허용 식별자 1개), 서버 세션 만료·폐기, 모든 owner 데이터 조회의 owner 범위 강제, 로컬 파일 저장소와 owner 검사 다운로드·검증 업로드.
- BASE_SHA: 43112a95177bfb13de7b39e082417371987f3f07
- HEAD_SHA: f20f5bb88dccd78273a2f1b4163ace31a0510e5d
- Clean tracked tree confirmed: yes
- Relevant acceptance IDs: M1 T02, A01(다른 계정의 capture/asset ID → 거부), docs/04 API 규칙(owner 범위·CSRF·GET 무상태)
- Changed files: `git show --stat f20f5bb`. 주요: `packages/domain/src/{auth,media,config,errors,schemas}.ts`, `packages/db/src/{schema,queries,client}.ts`, `packages/db/drizzle/0001_t02_sessions.sql`, `packages/providers/src/storage.ts`, `apps/web/lib/{api,auth,session,server}.ts`, `apps/web/app/api/auth/{login,logout}/route.ts`, `apps/web/app/api/assets/{uploads,[id]}/route.ts`, `apps/web/app/login/page.tsx`, `apps/web/app/page.tsx`, `tests/integration/{auth,assets}.test.ts`, `docs/DECISIONS.md`(D3), `README_KO.md`, `.env.example`
- Migrations / restore implications: `0001_t02_sessions`(sessions 테이블, audit_events.owner_id nullable, assets unique(owner_id, checksum)). **sessions 는 T05 export/restore 에서 제외해야 함**(스키마 주석).
- Actual commands and results (클라우드, Node 22.22.2, pnpm 12.6.0, 오케스트레이터 재실행):
  - `corepack pnpm install --frozen-lockfile` → pass, lockfile 변경 없음(신규 의존성 0)
  - `pnpm lint` / `pnpm typecheck` → pass
  - `pnpm test` → pass 10 files / 129 tests
  - `pnpm test:integration` → pass 5 files / 46 tests, 9.4s
  - `pnpm build` → pass (신규 라우트 /login, /api/auth/login, /api/auth/logout, /api/assets/uploads, /api/assets/[id])
  - `pnpm db:migrate` → 0001 적용; `pnpm db:seed` → 0 inserted / 10 total
  - `pnpm test:e2e` → NOT_RUN(exit 2)
  - 구현 에이전트 프로덕션 smoke(curl): `/`→307 /login; 로그인 200+Set-Cookie(HttpOnly; SameSite=Lax; Max-Age=43200); 로그인 후 `/` 200(마스킹 식별자·세션 만료 MSK); 업로드 PNG 201, 재업로드 200 duplicate; 다운로드 200(attachment, nosniff, no-store); 텍스트 바이트 .png 415; 무쿠키 다운로드 401; GET logout 405; Origin 없는 POST 403; 로그아웃 200 → 재로그아웃 401; 폐기 쿠키로 `/` → 307
  - 변이 검증: `getAssetById`/`getCaptureById`에서 owner 필터를 제거하면 A01 테스트가 실패함을 확인 후 복원(구현 에이전트 보고)
- Demo route / local start steps: `pnpm dev` → http://localhost:3000/login → 식별자 `owner@example.local`(.env.example 기본값) 입력 → `/`. README_KO.md "로그인 (M1, T02)".
- External calls performed: none (런타임). 패키지 설치 없음.
- Mock-only functionality: 변경 없음(LLM mock·게시·수집 disabled 유지).
- Known risks / not run:
  - Codex 검증 **미실행**. 실제 브라우저 확인 미실행(curl 만).
  - 로그인 rate limit 없음; 거부 로그인마다 audit 행 증가(비인증 요청으로 audit 테이블 팽창 가능).
  - 만료·폐기 세션 정리 작업 없음.
  - server component 는 쿠키를 지울 수 없어 만료 세션은 `/login` 리다이렉트만; 다음 API 401 또는 재로그인에서 정리.
  - CSRF: Origin 없을 때 Referer 허용. 127.0.0.1 접속 + APP_BASE_URL=localhost 는 403(README 기재).
  - 업로드는 최대 ~10MB×2 메모리 사용(raw body + parsed form).
  - `assets` unique(owner_id, checksum) 추가는 docs/01 "중복 제안" 문구보다 강함(되돌릴 수 있음).
- Questions specifically for Codex:
  1. 세션 검증 경로(쿠키 형식 → sha256 → DB)에 우회가 없는지, `identityMatches` 상수시간 비교의 길이 누설이 문제인지.
  2. `assertSameOrigin`의 Referer fallback 과 `Sec-Fetch-Site` 처리에 허점이 없는지.
  3. 업로드 MIME 스니핑(magic bytes + 확장자 일치)과 텍스트 검증이 우회 가능한지(polyglot 파일).
  4. 다운로드 404 통일이 ID 열거를 막는지, storage 키 검증이 경로 조작을 완전히 막는지.
- Next authorized task: T03 (메모·URL 수집·원문 보존·수정 충돌·중복 후보)
