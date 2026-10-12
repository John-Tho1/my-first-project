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

---

## FIX round 1 (Codex CHANGES_REQUESTED on e70f7d4, `.handoffs/review-T21P1A.md`)
- BASE_SHA: b820278 (리뷰 대상 코드 HEAD e70f7d4 + docs 전용 커밋; 작업 중 coordinator 가 docs 전용 82eeef4 를 더 커밋함 — 코드 차이 없음). HEAD_SHA: 없음 — 커밋하지 않음(지시). 검토 대상 = 82eeef4 위 작업 트리 변경.
- 재현(수정 전 e70f7d4 코드로 새 시험 실행): `corepack pnpm exec vitest run --project integration --maxWorkers=1 tests/integration/auth-rate-limit-concurrency.test.ts` → **5 failed | 3 passed**
  - 동시 4건: `expected [401,401,401,401] to deeply equal [401,429,429,429]`(실패 9 → 13)
  - 조기 검사 뒤 상한 도달: 맞는 식별자 `expected 200 to be 429`
  - 경합 순서: 순번 없음(`expected 0 to be less than 0`)
  - 느린 본문: 실패 행 시각이 조기 검사 시각(20분 전)
  - 같은 ms: 실패 9 → 성공 → 실패 10 뒤에도 `expected 200 to be 429`
  - 처음부터 통과(놓친 케이스 확인용): 잘못된 본문 10회 → invalid_request 10행 → 429, 창 경계(창 시작 제외·now 포함), 순번 없는 같은 ms(성공 우선)

| Finding | 변경 | 시험 |
| --- | --- | --- |
| P1 확인·기록 분리(초과량 무제한) | `packages/db/src/queries.ts` `withLoginAttemptLock`: 한 트랜잭션 + `pg_advisory_xact_lock(hashtext('cs.auth.login'))`(전역) → 잠금 안 새 `now` → `countRecentLoginFailures` 재계산 → 판정 → 성공(세션·`auth.login`)·실패(`auth.login_denied`) 기록 후 커밋. route 는 조기 검사(잠금 밖, 값싼 거름) 유지 → 본문 읽기(잠금 밖, 느린 본문이 잠금을 잡지 않게) → 잠금 안 판정. 429 는 트랜잭션 안에서 던져 아무것도 쓰지 않음. 401·400 은 값으로 돌려 기록을 커밋한 뒤 밖에서 던짐. `ensureOwner`·`createSession`·`findOwner` 인자 타입을 `DbOrTx` 로 넓힘 | `auth-rate-limit-concurrency.test.ts`: 실패 9 + 조기 검사 통과 후 멈춘 틀린 식별자 4건 동시 해제 → `[401,429,429,429]`, 창 안 실패 정확히 10 / 조기 검사 뒤 10번째 실패 → 기다리던 맞는 식별자 429·세션 없음 / 경계 경합(맞음·틀림) → `401/429` 또는 `401/200`(성공 행 순번 < 실패 행 순번) |
| P2(질문 3) 같은 ms 순서 | 잠금 안에서 로그인 순번 `seq = max+1` 을 판정 기록의 `version_or_hash` 에 저장(10진 문자열, 새 열·migration 없음). 셈 규칙: 마지막 성공 = 창 안 (시각, 순번) 최대, 둘 다 순번이 있으면 순번 비교, 어느 한쪽이라도 없으면(예전·복원·직접 넣은 행) 시각 엄격 비교(같은 ms = 성공 우선) | 시계 정지(모든 요청 같은 ms): 실패 9 → 성공 → 실패 10 → 429 / 직접 넣은 행: 창 시작 정확히 = 제외, now 정확히 = 포함 / 순번 없는 같은 ms 성공·실패 = 실패 제외, 1ms 뒤 = 포함 |
| 놓친 케이스: 느린 본문·`now` | 판정·기록 시각 = 잠금을 얻은 뒤 `new Date()`(본문 다 읽은 뒤) | 본문 20분 지연 → 실패 행 `at` = 해제 시각 |
| 놓친 케이스: 잘못된 본문 | 동작 변경 없음(잠금 안 기록으로 옮김) | 깨진 JSON·필드 누락·빈 식별자·숫자 식별자·text/plain 10회 → 400, invalid_request 10행, 다음 429 |
| 질문 2 "요청을 받지 않음" 단정 | README·`startup-guard.ts`·`instrumentation.ts` 주석을 "종료 코드 1 로 끝냄, Ready 이후 순서는 미확인, 보장은 설정 읽기·route 거부" 로 완화 | (문서) |
| 질문 4 worker·DB 스크립트 | README·`.env.example` 에 "NODE_ENV=production 으로 실행하면 AUTH_MODE=oidc 필요" 명시 | 실측(DATABASE_URL=memory://): `NODE_ENV=production pnpm db:migrate` → exit 1 + AUTH_MODE 안내, `+AUTH_MODE=oidc` → 0 / `pnpm worker` prod+dev → 1, prod+oidc → 0 / `pnpm drill:mock` prod → 0(고정 설정, NODE_ENV 미사용) / `pnpm drill:restore` prod+oidc → 설정 통과 후 "허용 사용자 데이터 없음" exit 1(빈 메모리 DB 라 예상된 결과) / 평소 env: run-checks 의 DRILL·MIGRATE·DRILL_RESTORE 모두 0 |

- 변경 파일(이번 라운드): `apps/web/app/api/auth/login/route.ts`, `packages/db/src/queries.ts`, `apps/web/lib/startup-guard.ts`, `apps/web/instrumentation.ts`(주석), `README_KO.md`, `docs/04_DATA_AND_API.md`, `.env.example`, 추가 `tests/integration/auth-rate-limit-concurrency.test.ts`. 기존 시험 변경 없음.
- Actual commands and results:
  - 3000·3999 LISTEN 없음 확인 후 `bash .handoffs/run-checks.sh FIX-T21P1A` → LINT=0, TYPECHECK=0, BUILD=0, UNIT=0(59 files, 1437 passed), INTEG=0(39 files, 809 passed), DRILL=0, MIGRATE=0, DRILL_RESTORE=0(PASS). 재실행·worker 사망 없음.
  - 수정 후 `vitest run --project integration --maxWorkers=1 tests/integration/auth-rate-limit-concurrency.test.ts` → 8 passed.
- Known risks / not run:
  - PGlite 는 연결 하나에서 트랜잭션을 하나씩만 실행하고(advisory 잠금은 같은 세션이라 즉시 획득) 직렬화는 PGlite 트랜잭션 뮤텍스가 한다. 여러 연결·프로세스 사이 직렬화(advisory 잠금의 실제 효과)는 Postgres 드라이버가 없어 미검증(G2/T21-P5).
  - 잠금 안 쿼리 3회(마지막 성공·실패 수·최대 순번)는 `audit_events` 색인 없이 훑는다(단일 사용자 규모 가정, 측정 안 함). 모든 로그인 판정이 전역 잠금으로 줄을 선다(의도).
  - 순번은 `version_or_hash` 에 둔다 — auth 행에서는 원래 비어 있던 열. 내보내기·복원 시 그대로 이동(복원 뒤 순번이 이어지는 것은 max+1 이라 문제 없음).
  - 경합 시험의 결과(401/429 또는 401/200)는 잠금 획득 순서에 따라 정해지며 시험은 두 경우 모두 규칙대로인지 확인한다(어느 쪽이 나왔는지는 고정하지 않음).
  - 운영 번들 시작과 동시에 로그인 요청을 보내는 경우는 재현하지 않음(not_run). 운영 번들의 상수 치환은 이전 라운드 실측(산출물에 `NODE_ENV:"production"`, NODE_ENV=development 우회 실패) 그대로.
- Questions specifically for Codex:
  1. 조기 검사(잠금 밖)·본문 읽기(잠금 밖)·재검사·판정·기록(잠금 안) 순서에서 남은 경합이 있는지.
  2. 순번 혼합 규칙(둘 다 순번 → 순번, 아니면 시각 엄격)이 복원 데이터와 섞였을 때 우회 경로를 만드는지.


### FIX round 1 — 오케스트레이터 기록
- FIX HEAD: e57cfa5157da22ff2a499c433c6d66dfcddc5272 (code only). BASE b820278(+ docs 82eeef4).
- checks-FIX-T21P1A: lint·typecheck·build 0 · unit 1437 · integration 39 파일 · 809 · drill:mock 0 · migrate 0 · drill:restore PASS. 재실행 없음.

---

## FIX round 2 (Codex CHANGES_REQUESTED on e57cfa5, `.handoffs/review-FIX-T21P1A.md`)
- BASE_SHA: 7c982a1(코드 = e57cfa5, 이후 docs 전용 577ae20). HEAD_SHA: 없음 — 커밋하지 않음(지시). 검토 대상 = 577ae20 위 작업 트리 변경.
- 재현(e57cfa5 코드로 새 시험 `tests/integration/auth-rate-limit-fix2.test.ts`, `vitest run --project integration --maxWorkers=1`): **3 failed | 1 passed**
  - 조기 검사 두 SELECT 사이 커밋: `expected [9, 1] to include 10`(섞인 상태 10 → 그 상태면 즉시 429)
  - 순번 15자리 경계: 16자리 순번이 순번으로 읽히지 않아 같은 ms 실패가 안 세짐 → `expected 200 to be 429`
  - 2^53 초과 순번 +1: `Number` 반올림으로 `9007199254740994` 행 없음
  - 처음부터 통과: 성공 감사 기록 실패 시 세션까지 되돌림(이미 한 트랜잭션이었음 — 회귀 시험으로 남김)

| Finding | 변경 | 시험 |
| --- | --- | --- |
| P2 조기 검사의 두 SELECT 불일치 → 잘못된 429 | `countRecentLoginFailures` 를 **SQL 한 문장**으로(마지막 성공 = 상관 하위 질의 `(select … order by at desc, seq desc nulls last limit 1)`, 실패 계수와 같은 문장). 선택 이유: 한 문장은 Postgres(READ COMMITTED 포함)·PGlite 에서 한 스냅숏을 보므로 결과는 항상 어떤 실제 시점의 정확한 값이다 → 조기 검사의 429 는 "그 시점에 잠금 안 판정을 했어도 429" 와 같다. 조기 429 를 없애는 안보다 변경이 작고(동작 동일), 막힌 동안 본문을 읽지 않는 이점도 유지. 잠금 안 판정·기록은 그대로(같은 함수) | PGlite 클라이언트 `query` 를 감싸 **첫 질의 직후** 성공(순번 1010)·실패(1011) 커밋 → 결과 ∈ {9, 1}(섞인 10 아님), 커밋 뒤 다시 세면 1, 실제 요청 401 |
| (a) 순번 자릿수 | 순번 파싱 `^[0-9]{1,30}$` + `::numeric`(이전 `{1,15}`·bigint), 다음 순번은 SQL `(coalesce(max,0)+1)::text` 로 계산해 문자열로 전달(JS Number 미사용). `LoginAttemptContext.seq` 를 `string` 으로 | 성공 순번 `999999999999999`(같은 ms) 뒤 route 실패 10회 → 순번 `1000000000000000`~`…009` 연속·모두 셈 → 429 / `9007199254740993` 다음 `…994` 정확 |
| (b) 세션 생성 후 감사 실패 | 변경 없음(이미 한 트랜잭션) | 시험용 트리거(`auth.login` insert 시 예외) → 500, 쿠키 없음, 세션·`auth.login` 행 수 그대로, 트리거 제거 후 200 |
| (c) 복원·순번 혼합·시계 역행 | 코드 주석(`countRecentLoginFailures`)·README 에 보수적 규칙 명시: 다른 이력의 성공 행이 add_missing 복원으로 창 안에 섞여 순번이 더 크면 그 창(최대 15분) 동안 실패를 덜 셈. 다음 순번은 섞인 최대 + 1 이라 이후 기록은 다시 앞섬. 실패 행은 owner 가 없어 내보내기·복원 대상 아님. 시계가 뒤로 가면 `at <= now` 로 미래가 된 기록을 무시 → 되돌린 폭 동안 느슨. 순번·시각 순서가 어긋나도 마지막 성공은 (시각, 순번) 최대 | (문서 — 추가 시험 없음, 지시대로 과설계하지 않음) |
| (d) Postgres 다중 연결 | `withLoginAttemptLock` 주석에 "Postgres 드라이버가 없어(G2) 여러 연결에서의 잠금 대기·커밋·롤백·격리 수준 동작 미검증" 명시 | **not_run** |

- 변경 파일(이번 라운드): `packages/db/src/queries.ts`, `apps/web/app/api/auth/login/route.ts`(순번 문자열), `README_KO.md`, 추가 `tests/integration/auth-rate-limit-fix2.test.ts`. 기존 시험 변경 없음.
- Actual commands and results:
  - 수정 후 `vitest run --project integration --maxWorkers=1` auth-rate-limit-fix2·auth-rate-limit-concurrency·auth-production-rate-limit·auth → 4 files, 37 passed. `tsc -p tsconfig.json --noEmit` → 0.
  - 3000·3999 LISTEN 없음 확인 후 `bash .handoffs/run-checks.sh FIX2-T21P1A` → LINT=0, TYPECHECK=0, BUILD=0, **UNIT=1**(1 failed | 1436 passed: 손대지 않은 `imports-fix1.test.ts` "<h1> 열고 짧은 태그 반복" 5307ms 시간 초과), INTEG=0(40 files, 813 passed), DRILL=0, MIGRATE=0, DRILL_RESTORE=0(PASS).
  - 시간 초과 단독 재실행: `corepack pnpm exec vitest run --project unit packages/domain/src/imports-fix1.test.ts` → 34 passed.
- Known risks / not run: Postgres 다중 연결(G2) not_run. 운영 번들 시작과 동시 로그인 not_run(보장은 설정 읽기·route 거부). 복원 혼합·시계 역행의 느슨함은 위 규칙대로 수용(창 15분 한정).


### FIX round 2 — 오케스트레이터 기록
- FIX2 HEAD: a448b7859f155daf6ae9e62f48a3b920bad16369 (code only). BASE 7c982a1(+ docs 577ae20).
- checks-FIX2-T21P1A: lint·typecheck·build 0 · unit 1회차 1(손대지 않은 imports-fix1 시간 초과 — 단독 34 통과) · integration 813 · drill:mock 0 · migrate 0 · drill:restore PASS.
