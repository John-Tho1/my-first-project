# Implementation handoff
- Task ID / milestone: T21-P1a (T21 운영 배포 준비, docs/handoffs/T21_DEPLOY_REVIEW.md §2 G1a) — **G1(운영 인증 OIDC, T21-P1b)은 아직 없다.** 운영 로그인 수단은 여전히 없음(AUTH_MODE=oidc 는 모든 로그인 503).
- Purpose and changed behavior:
  1. 운영 빌드에서 비밀번호 없는 dev 로그인 거부(fail closed). 허용 조건 = `NODE_ENV` 가 없음·빈 값·`development`·`test`. 그 밖(production·staging 등 모든 값)은 `AUTH_MODE=dev`(또는 미설정=기본 dev)를 세 곳에서 거부:
     - 서버 시작: `apps/web/instrumentation.ts` → `lib/startup-guard.ts` 가 한국어 안내(설정 이름 `AUTH_MODE(인증 방식)`만, 값 없음) 출력 후 `process.exit(1)`.
     - 설정 읽기: `loadConfig` 가 `ConfigError`(같은 문구). web `getConfig`·공개 health 는 `{...process.env, NODE_ENV: process.env.NODE_ENV}` 로 넘긴다 — Next 빌드가 `process.env.NODE_ENV` 식을 상수로 고정하므로 `next start` 때 NODE_ENV 를 바꿔도 풀리지 않는다(아래 실측). 공개 `/api/health` 는 degraded 503(내용 없음).
     - 로그인 요청: `POST /api/auth/login` 첫 줄에서 원시 env 판정 → 503 `dev_login_refused_in_production`(설정·DB 접근 전, 감사 행 없음), 폼은 `/login?error=production_dev`. `assertLoginAvailable(config, nodeEnv)` 에 nodeEnv 필수 인자 추가(두 번째 방어선).
     - **탈출구 없음(결정)**: Next App Router route handler 는 소켓 원격 주소를 주지 않고(NextRequest.ip 도 없음), Host·Origin·X-Forwarded-* 는 위조 가능 → "loopback 요청만" 판정을 믿을 수 없어 `AUTH_DEV_ALLOW_PRODUCTION_BUILD` 같은 설정을 두지 않았다. 로컬은 `pnpm dev`.
  2. 로그인 시도 횟수 제한: 전역(식별자·IP 무관) 15분 미끄러지는 창, 실패(`auth.login_denied` 의 reason `identity_mismatch`·`invalid_request`) 10회 이상이면 이후 시도는 식별자와 무관하게 같은 429 `login_rate_limited`(폼 `/login?error=rate_limited`). 본문·식별자를 보기 전에 판정(식별자 존재 비노출). 마지막 성공(`auth.login`) 이전 실패는 세지 않음. 저장 = 기존 감사 기록을 셈(`countRecentLoginFailures`, 새 표·migration 없음, 재시작 후 유지). 429 는 감사 행을 남기지 않음. 거부 감사 행은 `at: now`(횟수 제한 시계와 같게) 명시.
- BASE_SHA: 9b2883d
- HEAD_SHA: e70f7d4f53bc6c6b9bba437a4f12c9810002cc75 (code only, D28 — 오케스트레이터 커밋)
- Clean tracked tree confirmed: 아니오(이 과제의 미커밋 변경만 있음, `.claude/` 는 손대지 않은 기존 untracked).
- Relevant acceptance IDs: T21_DEPLOY_REVIEW G1a, D3(로그인 시도 제한 없음 → 추가)
- Changed files:
  - 수정: `packages/domain/src/{config.ts, auth.ts, errors.ts, auth.test.ts}`, `packages/db/src/queries.ts`, `apps/web/app/api/auth/login/route.ts`, `apps/web/app/api/health/route.ts`, `apps/web/app/login/page.tsx`, `apps/web/lib/{api.ts, server.ts}`, `tests/integration/oauth.test.ts`, `README_KO.md`, `docs/04_DATA_AND_API.md`, `.env.example`
  - 추가: `apps/web/instrumentation.ts`, `apps/web/lib/startup-guard.ts`, `apps/web/lib/startup-guard.test.ts`, `packages/domain/src/auth-production.test.ts`, `tests/integration/auth-production-rate-limit.test.ts`
  - 기존 시험 변경 2곳(의미 유지): `auth.test.ts` 의 `assertLoginAvailable(...)` 4회 호출에 `'test'` 인자 추가. `oauth.test.ts` D25-3(NODE_ENV=production 에서 모의 매개변수 거부)은 운영 빌드에서 dev 설정이 이제 불가하므로 같은 구간에 `AUTH_MODE=oidc` 를 함께 stub(세션 검증은 AUTH_MODE 무관, 판정·기대값 그대로), finally 에서 dev 로 되돌림.
- Migrations / restore implications: 없음(새 표·열·색인 없음). 횟수 제한은 `audit_events` 를 읽기만 한다. 복원된 감사 기록도 시각 기준으로 같이 세어진다.
- Actual commands and results:
  - 시작 전 3000·3999 LISTEN 없음 확인(Get-NetTCPConnection).
  - `bash .handoffs/run-checks.sh T21P1A` → LINT=0, TYPECHECK=0, BUILD=0, UNIT=1, INTEG=0-NO-SUMMARY(요약상 1 failed | 800 passed, 38 files), DRILL=0, MIGRATE=0, DRILL_RESTORE=0(PASS).
    - UNIT=1: `imports-fix1.test.ts`·`imports-fix3.test.ts` 의 5s 시간 초과 2건(이 과제가 건드리지 않은 파일, 같은 시각 빌드 산출물 grep 이 병렬로 돌아 부하) → 단독 재실행 `corepack pnpm exec vitest run --project unit packages/domain/src/imports-fix1.test.ts packages/domain/src/imports-fix3.test.ts` → 2 files, 120 passed.
    - INTEG 실패 1건: `oauth.test.ts` D25-3 — 이 과제의 동작 변화(운영 빌드 + dev 설정 거부)로 생긴 실제 실패. 위처럼 시험을 고친 뒤 `corepack pnpm exec vitest run --project integration --maxWorkers=1 tests/integration/oauth.test.ts` → 102 passed. **수정 후 통합 전체는 다시 돌리지 않았다(not_run)** — 수정은 그 시험 하나뿐.
  - 수정 후 `corepack pnpm lint` → 0, `corepack pnpm typecheck` → 0.
  - 개발 중: 새/기존 인증 시험 `vitest run --project integration --maxWorkers=1 auth-production-rate-limit auth health` → 3 files, 32 passed (기본 병렬 실행 1회는 worker exit 2147483651 로 죽어 maxWorkers=1 로 재실행). 단위 auth·config·startup-guard → 4 files, 84 passed.
  - 운영 빌드 실측(임시 메모리 DB, 127.0.0.1:3999, 외부 호출 없음, 종료 확인):
    - `AUTH_MODE=dev DATABASE_URL=memory:// node apps/web/scripts/next.mjs start -H 127.0.0.1 -p 3999` → exit 1, `[startup] 서버를 시작하지 않습니다.` + AUTH_MODE 안내.
    - 같은 명령에 `NODE_ENV=development`(우회 시도) → Next 경고 후 exit 1(빌드 고정값이 production).
    - `AUTH_MODE=oidc` → 시작, `GET /api/health` 200 `{status:ok,…}`, 로그인 POST 503 `oidc_not_configured`, timeout 45s 로 종료(exit 124), 이후 3999 비어 있음.
- Demo route / local start steps: `pnpm dev` → `/login`(기존과 같음). 실패 10회 후 429 확인 가능. 운영 빌드 확인은 위 `next start` 명령.
- External calls performed (exact scope, or none): 없음. `.env.local`·`./data` 를 읽지 않았다(단 `next start` 실측 때 next.config 가 프로세스 안에서 `.env.local` 을 로드함 — 명시한 env 가 우선, DB 는 memory://, 출력에 값 없음).
- Mock-only functionality: 해당 없음(인증 가드).
- Known risks / not run:
  - **운영 인증(OIDC, G1/T21-P1b)은 여전히 없음** — 운영 배포는 아직 로그인 불가(차단 유지).
  - 전역 창의 대가: 공격자가 15분마다 실패 10회를 보내면 주인도 새 로그인이 계속 막힌다(기존 세션은 유지). IP 를 믿을 수 없어 택한 절충. 동시 요청은 잠그지 않아 상한을 몇 회 넘을 수 있음. `audit_events` 에 action/at 색인이 없어 매 로그인 시도마다 감사 표를 훑는다(단일 사용자 규모 가정, 측정 안 함).
  - `next start` 출력에 "Ready" 가 먼저 찍힌 뒤 instrumentation 이 종료시킨다. 그 짧은 사이 요청이 들어와도 getConfig·로그인 경로가 같은 판정으로 거부한다(이 구간을 시험으로 재현하지는 않음).
  - 과거 인계(T06~T09, T14, T15)의 "`next start -p 3100` + dev 로그인" 수동 smoke 절차는 이제 쓸 수 없다 — 같은 확인은 `next dev -p 3100` 으로 해야 한다. 저장소 스크립트(drill:*, e2e)는 next start 를 쓰지 않아 영향 없음.
  - `apps/web/src/app/api/health`(빈 디렉터리, 추적 안 됨)는 손대지 않음.
  - 통합 전체 재실행(oauth 시험 수정 후) not_run.
- Questions specifically for Codex:
  1. Next 16 Turbopack 서버 번들에서 `process.env.NODE_ENV` 고정에 의존하는 설계(route·getConfig·instrumentation)가 충분한가? 빌드 산출물에 `NODE_ENV:"production"` 이 들어간 것과 NODE_ENV=development 우회 실패는 실측했다.
  2. instrumentation 의 `process.exit(1)` 이 "Ready" 이후 실행되는 순서에서 요청이 먼저 처리될 여지가 있는지.
  3. `countRecentLoginFailures` 의 경계(창 시작 `>`·`at <= now`·마지막 성공과 같은 ms 의 실패는 세지 않음)와 `sanitized_details->>'reason'` 필터가 맞는지.
  4. NODE_ENV 허용 목록(없음·''·development·test) 밖을 모두 거부하는 것이 worker·db 스크립트를 운영 서버에서 `NODE_ENV=production` 으로 돌릴 때 과도한지(AUTH_MODE=oidc 면 통과).
- Next authorized task: 사용자 결정 대기 — T21-P1b(OIDC, IdP 선택은 사용자 결정), 또는 T21 의 다른 P 과제.


## 오케스트레이터 재검사(커밋 전)
- 구현자 실행 뒤 oauth.test.ts D25-3 수정분을 포함해 전체를 다시 돌림: unit **59 파일 · 1437 통과(UNIT2=0)**, integration **38 파일 · 801 통과(INTEG2=0)**. 1회차 UNIT=1 은 손대지 않은 imports-fix1/fix3 의 5초 시간 초과.
