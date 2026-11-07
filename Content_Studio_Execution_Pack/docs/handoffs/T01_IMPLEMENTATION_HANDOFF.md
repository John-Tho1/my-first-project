# Implementation handoff — T01
- Task ID / milestone: T01 / M0 (앱·worker·DB·mock 뼈대)
- Purpose and changed behavior: pnpm 워크스페이스 뼈대. 외부 키 없이 `pnpm dev`로 한국어 "오늘" 화면과 `/api/health`가 뜨고, 기본 모드(LLM mock, 게시 disabled, 수집 disabled, worker inline)에서 외부 쓰기 0을 서버 가드·테스트로 강제한다.
- BASE_SHA: 2182224097086398b6c6adb4318c25fd3e233f38
- HEAD_SHA: 43112a95177bfb13de7b39e082417371987f3f07
- Clean tracked tree confirmed: yes (`git status --short` 비어 있음, 커밋 직후 확인)
- Relevant acceptance IDs: M0 T01 통과 조건(README 명령 구동, 외부 키 없이 mock 동작, 기본 모드 외부 쓰기 0, 버전·lockfile 고정), 위험 시나리오 A04(원문의 "즉시 발행하라"는 자료로만 처리, 게시 호출 0)
- Changed files: 59 files, +9040 (`git show --stat 43112a9`). 주요: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `eslint.config.mjs`, `vitest.config.ts`, `.env.example`, `packages/domain/src/{config,guards,errors,schemas,time}.ts`, `packages/db/src/{schema,client,lock,seed,queries,paths}.ts`, `packages/db/drizzle/0000_t01_m1_core.sql`, `packages/providers/src/{llm,publisher,collector}.ts`, `apps/web/app/{layout,page}.tsx`, `apps/web/app/api/health/route.ts`, `apps/web/next.config.ts`, `apps/web/scripts/next.mjs`, `apps/worker/src/{index,cli}.ts`, `tests/fixtures/captures.json`, `tests/integration/*.test.ts`, `README_KO.md`(실행 방법), `docs/ENVIRONMENT.md`(§8 고정 버전)
- Migrations / restore implications: 첫 migration `0000_t01_m1_core.sql`(M1 테이블 10개, PostgreSQL 방언). 데이터는 `./data/pglite`(gitignore). export/restore는 T05에서.
- Actual commands and results (클라우드 컨테이너, Node v22.22.2, corepack pnpm 12.6.0, 오케스트레이터가 재실행):
  - `corepack pnpm install --frozen-lockfile` → pass (exit 0)
  - `pnpm lint` → pass (exit 0)
  - `pnpm typecheck` → pass (exit 0)
  - `pnpm test` → pass, 7 files / 50 tests, 1.4s
  - `pnpm test:integration` → pass, 3 files / 13 tests, 6.4s
  - `pnpm test:e2e` → NOT_RUN (exit 2, 의도된 값; Playwright 브라우저 다운로드 미승인)
  - `pnpm build` → pass (Next 16.3.6 Turbopack, `/`·`/api/health` dynamic)
  - `pnpm db:seed` ×2 → 10 inserted/10 total, 0 inserted/10 total (멱등 확인)
  - `pnpm worker` → exit 0, tick JSON 출력; `WORKER_MODE=separate` → exit 1(한국어 안내)
  - `pnpm start` 후 `curl /api/health` → 200, 아래 JSON; `/` 에 `LLM: 모의`·`게시: 비활성`·`수집: 비활성`·`(MSK)`·`아직 초안이 없습니다` 확인
  - 서버 실행 중 `pnpm worker` → exit 1 (PGlite 잠금, 의도된 거부)
- Health JSON (prod): `{"status":"ok","app":"content-studio","version":"0.1.0","time_utc":"2026-09-24T14:12:45.455Z","time_msk":"2026-09-24 17:12 (MSK)","timezone":"Europe/Moscow","modes":{"llm":"mock","publish":"disabled","collectors":"disabled"},"db":{"driver":"pglite","ok":true,"migrated":true,"captures":10},"worker":{"mode":"inline","last_tick_utc":"2026-09-24T14:12:45.834Z"}}`
- Demo route / local start steps: README_KO.md "실행 방법 (M0, T01)". `corepack pnpm install --frozen-lockfile && pnpm db:seed && pnpm dev` → http://localhost:3000 , /api/health
- External calls performed: 패키지 설치(npm registry)만. 런타임 외부 호출 없음. 단, 구현 에이전트가 텔레메트리 차단 래퍼를 넣기 전 첫 `next build`/`dev`/`typegen` 실행에서 Next.js 익명 텔레메트리가 전송됐을 수 있음(이후 `NEXT_TELEMETRY_DISABLED=1` 고정).
- Mock-only functionality: MockLlmProvider(결정적, 경험 claim은 needs_user_confirmation=true), DisabledPublisher(항상 예외), DisabledCollector(항상 예외). `toStorablePublication`이 MOCK/DISABLED/UNKNOWN/미검증 결과를 거부.
- Known risks / not run:
  - Codex 검증 **미실행**(클라우드에 Codex CLI 없음). 이 인계는 미검증 상태.
  - 사용자 PC(Windows, Node 24.21.0)에서의 실행은 미확인. `next.config.ts`가 `process.loadEnvFile`(Node ≥20.12)를 사용.
  - eslint 10 + eslint-config-next 16.3.6 하위 플러그인 peer 경고(≤9 선언). `settings.react.version` 명시로 동작 확인.
  - PGlite PID 잠금(`packages/db/src/lock.ts`)은 스펙 외 추가. Windows에서 `process.kill(pid,0)` 동작은 미확인.
  - `/api/health`가 inline 모드에서 요청마다 worker tick을 실행(M0: DB count만). M3 jobs 도입 시 재설계 필요.
  - `DB_DRIVER=postgres` 미구현(M3).
- Questions specifically for Codex:
  1. `assertPublishAllowed`가 M0에서 fail-closed인지, 우회 경로(클라이언트 import, approvalId 신뢰)가 없는지.
  2. 복합 FK(captures.source_id+owner_id → sources, contents.idea_id+owner_id → ideas)가 owner 교차 참조를 막는지, MATCH SIMPLE로 null 허용이 의도대로인지.
  3. 잠금 파일 경합·죽은 PID 회수 로직의 안전성(Windows 포함).
  4. health 응답에 환경변수 값이 새지 않는지(테스트 있음).
- Next authorized task: T02 (M1 로그인·owner·파일 접근제어). 인증 공급자는 운영에서 확정(docs/02)이므로 M1은 로컬 개발용 세션 방식으로 진행 예정 — 아래 결정 D3 참조.

## Decision D3 (T02 착수 전, 오케스트레이터 가정 — 사용자 확인 필요)
- Question: OIDC 공급자·운영 환경이 미정인데 M1 로그인을 어떻게 구현할 것인가.
- Options: (a) Auth.js 등 라이브러리 + 외부 OIDC(계정·비밀 필요, 지금 불가) (b) `AUTH_MODE=dev` 로컬 전용 세션(비밀번호 없음, allowlist 식별자 1개, 서버 세션 테이블+httpOnly 쿠키, localhost 한정) + `AUTH_MODE=oidc`는 미구현 자리만 (c) 인증 생략
- Chosen: (b). 자체 비밀번호/암호화 구현 금지 규칙을 지키며(비밀번호 없음), owner 제한·세션 만료·CSRF·파일 접근 제어를 서버에서 실제로 검증할 수 있다.
- Reversible: yes — 세션 발급 경로만 교체하면 됨. 운영 배포 전 OIDC 공급자 확정 필요(T13/T21).
- User decision required: 확인 요청. 거부 시 T02 인증 부분을 재작업.
