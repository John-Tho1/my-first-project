# Implementation handoff
- Task ID / milestone: T21-P1b (T21 운영 배포 준비, docs/handoffs/T21_DEPLOY_REVIEW.md §2 **G1** — 운영 인증). 일반 OpenID Connect 로그인(`AUTH_MODE=oidc`), 단일 owner, IdP 미지정.
- Purpose and changed behavior:
  1. **라이브러리**: `openid-client` **6.8.8**(panva, npm 공개 2026-09-05T10:31:57Z) — `@cs/providers` 에 정확 버전 고정. 전이 의존성 `jose` **6.2.12**(2026-09-05T09:17:12Z)·`oauth4webapi` **3.8.8**(2026-09-05T10:22:40Z) — 셋 다 기준일(2026-09-29) 이전·2주 이상, 그 밖 새 의존성 없음. lockfile 에 정확 버전으로 들어갔으므로 overrides 는 추가하지 않았다(설치 때 pnpm "Lockfile passes supply-chain policies"). 확인 명령: `npm view openid-client time --json`, `npm view jose time --json`, `npm view oauth4webapi time --json`(레지스트리 조회만).
  2. **흐름**: `/login`(oidc·준비됨) "OIDC로 로그인"(GET 폼) → `GET /api/auth/oidc/start` → IdP → `GET /api/auth/oidc/callback` → 세션 쿠키(`cs_session`, 기존과 같음) → `/`. 로그아웃은 그대로.
  3. **식별자 입력 로그인**: `AUTH_MODE=oidc` 에서 `POST /api/auth/login` 은 403 `identity_login_disabled`(이전 503 `oidc_not_configured`). 감사 사유 `identity_login_disabled` 는 실패 횟수에 안 셈.
  4. **화면·health**: 설정 화면 "로그인(인증)" 카드(방식·준비 여부·빠진 설정 이름), `GET /api/health/details` 에 `auth: { mode, oidc_ready, missing }`(이름만). 로그인 전에는 빠진 이름을 서버 로그 `[auth] oidc_not_configured: <이름들>` 로만.
  5. **시험 네트워크 가드**: `tests/setup/no-meta-network.ts` 에 OIDC IdP 도메인(google.com·googleapis.com·microsoftonline.com·microsoft.com·live.com·okta.com·oktapreview.com·auth0.com·apple.com·amazoncognito.com·onelogin.com·pingidentity.com·gitlab.com·github.com·yahoo.com·line.me·kakao.com·naver.com)과 예약 TLD **`.test`**(가짜 IdP 호스트 `idp.test`) 추가.

## 설계 표
| 항목 | 결정 | 근거·위치 |
| --- | --- | --- |
| 설정 | `OIDC_ISSUER_URL`(https 만, query·fragment·userinfo 없음 — 스키마 거부), `OIDC_CLIENT_ID`(공백 없는 1~512), `OIDC_REDIRECT_URI`(scheme+host+path만), `OIDC_SCOPES`(기본 `openid email`, openid 필수, scope-token 문법), `AUTH_ALLOWED_SUBJECT`(선택). `OIDC_CLIENT_SECRET` 은 스키마 밖 — `process.env` 에서만(THREADS_APP_SECRET 과 같은 방식) | `packages/domain/src/config.ts`, `oidc-format.ts`(순환 import 회피용 순수 검사) |
| 준비 상태(이름만) | `AUTH_MODE=oidc` · `OIDC_ISSUER_URL` · `OIDC_CLIENT_ID` · `OIDC_CLIENT_SECRET`(/형식) · `OIDC_REDIRECT_URI`(/불일치 — **APP_BASE_URL origin + `/api/auth/oidc/callback` 정확 일치**) · `APP_BASE_URL(https)`(localhost 만 http 허용) · `AUTH_ALLOWED_IDENTITY 또는 AUTH_ALLOWED_SUBJECT` · `OIDC_SCOPES(email 필요)`(email 확인 시) · `SECRETS_MASTER_KEY`. 시작·callback·로그인 화면·설정·health 가 같은 `oidcLoginReadiness` | `packages/domain/src/oidc.ts` |
| 허용 신원(결정) | `AUTH_ALLOWED_IDENTITY` 를 **환경에 명시**하면 email 일치(trim·소문자, 상수 시간) + `email_verified === true`(불리언만 — `"true"` 문자열 거부). `AUTH_ALLOWED_SUBJECT` 면 sub 정확 일치. 둘 다면 둘 다. 둘 다 없으면 준비 안 됨(기본값 `owner@example.local` 로는 허용하지 않음). owner 행은 항상 `ensureOwner(AUTH_ALLOWED_IDENTITY)` — 다른 사용자 생성 없음, dev 와 같은 owner 키 | `checkOidcIdentity`, `oidcIdentityPolicy` |
| 라이브러리 검증 | discovery(issuer 일치) · 인증 응답(state 정확 일치, RFC 9207 iss) · code 교환(PKCE S256, redirect_uri=설정값, 클라이언트 인증: 메타데이터에 basic 있으면 basic, post 만 있으면 post, 목록 없으면 basic) · ID token(iss·aud·exp·iat 허용 오차 30초·nonce, **서명 JWKS — `enableNonRepudiationChecks` 로 켬**: 라이브러리 기본은 TLS 직접 수신 ID token 의 서명 검사를 생략(OIDC Core 3.1.3.7)하며, 실제로 "다른 키 서명" 시험이 켜기 전 **통과(=검사 안 함)** 했다) | `packages/providers/src/oidc-login.ts` |
| 네트워크 | 주입 fetch(없으면 호출 시점 `globalThis.fetch`) 감쌈: https 만, 허용 호스트 = issuer 호스트 + discovery 의 token_endpoint·jwks_uri 호스트, `redirect: 'manual'`, 요청당 10초(주입 fetch 가 signal 을 무시해도 race 로 끊음), 전송 상태를 AsyncLocalStorage 로 작업별 기록 → 실패 분류 `unavailable`(전송 실패·시간 초과·5xx·허용 밖 호스트·discovery) / `invalid`(그 밖). 오류는 `OidcLoginFailure(kind, step)` 만(cause·URL·본문 버림) | 같은 파일 |
| discovery 캐시 | `Configuration`(JWKS 캐시 포함) 1시간, 실패는 캐시 안 함. web 은 설정 지문(시크릿 포함 sha256)이 같으면 클라이언트 재사용 | `apps/web/lib/oidc.ts` |
| state 저장 | **DB 표 `auth_oidc_states`**(migration 0043, owner 없음): state·결합 쿠키는 sha256 만, PKCE verifier·nonce 는 `SECRETS_MASTER_KEY` 로 봉인(AAD = 행 ID + 용도 `oidc_login_state`), 10분, `settings_hash`(issuer·client·redirect·scope 지문). 시작 때 만료·사용 행 삭제 + 진행 중 최대 100개(넘으면 오래된 것부터 삭제). export/restore 제외(EXCLUDED_TABLES), 보존 정리 대상 아님(RETENTION_PROTECTED_TABLES) | `packages/db/src/schema.ts`, `auth-oidc.ts` |
| 브라우저 결합 | 쿠키 `cs_oidc_flow`(32바이트 난수, HttpOnly·SameSite=Lax·Path=/api/auth/oidc·Max-Age 600·https 면 Secure), callback 이 결과와 무관하게 지움 | `buildOidcFlowCookie` |
| state 소비 | 행 잠금(for update). 없음→unknown, **결합 해시 다름→browser_mismatch(소비하지 않음 — T13 oauth_states 와 같은 규칙)**, 사용됨→used, 그 밖엔 used_at 기록 후 expired / settings_changed / ok, 봉인 못 열면 unreadable | `consumeOidcLoginState` |
| 시작 경로 | `Sec-Fetch-Site` 가 있으면 same-origin·none 만(403 csrf) → 준비(503, 이름은 로그만) → 전역 시도 제한 조기 검사(429) → 키 → discovery(502) → 행 → 303 IdP + 결합 쿠키. 성공은 감사 없음 | `apps/web/app/api/auth/oidc/start/route.ts` |
| callback 경로 | 준비 → **조기 429(state 소비 없음·감사 없음)** → 요청 origin+path = `OIDC_REDIRECT_URI` → state 형식(1개만) → 소비 → `error` 파라미터면 취소 → 라이브러리 → 허용 신원 → **`withLoginAttemptLock`(T21-P1a 와 같은 전역 잠금·재검사·순번)** 안에서 `auth.login_denied`{reason,check,mode:'oidc'} 또는 ensureOwner+세션+`auth.login`{mode:'oidc'}. 네트워크는 잠금 밖 | `apps/web/app/api/auth/oidc/callback/route.ts` |
| 실패 횟수 | `LOGIN_FAILURE_REASONS` = identity_mismatch · invalid_request · **oidc_invalid**(state 오류·redirect 불일치·code 교환 거절·ID token 검증 실패) · **oidc_identity_mismatch**. 세지 않음: `oidc_provider_error`(IdP 5xx·시간 초과 — 공격자가 만들 수 없음), `oidc_cancelled`(IdP 의 error 파라미터) | `packages/domain/src/auth.ts` |
| 오류(고정 한국어·안정 코드) | 503 `oidc_not_configured` · 400 `oidc_state_invalid` · 401 `oidc_login_invalid` · 403 `oidc_identity_denied` · 502 `oidc_provider_unavailable`(새 AppErrorKind `upstream_failed`) · 401 `oidc_cancelled` · 429 `login_rate_limited`. 브라우저는 303 `/login?error=<코드>`. 모든 응답 `Referrer-Policy: no-referrer`·`Cache-Control: no-store` | `oidc.ts`, `errors.ts`, `login/page.tsx` |
| 로그 | `[auth] oidc_not_configured: <이름>`, `[auth] oidc_start_failed: <kind>/<step>`, `[auth] oidc_login_denied: <reason>/<check>` — 값·토큰·code·IdP 본문 없음 | 각 route |

## 변경 → 시험 표
| 변경 | 시험 |
| --- | --- |
| 설정 형식·redirect 정확 일치·준비 이름·설정 지문·허용 신원·쿠키 | `packages/domain/src/oidc.test.ts`(37) |
| oidc 모드의 식별자 로그인 거부, 실패 사유 4종 | `packages/domain/src/auth.test.ts`, `auth-production.test.ts`, `tests/integration/auth.test.ts`, `auth-production-rate-limit.test.ts`(기대값을 새 동작으로 바꿈 — 503 `oidc_not_configured` → 403 `identity_login_disabled`) |
| 라이브러리 감쌈: 인증 URL(PKCE·state·nonce·scope·redirect), discovery 캐시·실패·issuer 불일치·http 엔드포인트·지원 안 하는 인증, basic/post, nonce·iss·aud·만료·다른 키 서명·ID token 없음·token 400 → invalid, state 불일치·code 재사용·verifier 불일치, token 500·전송 실패 → unavailable, **실제 시간 제한(signal 무시 fetch, 300ms)**, 허용 호스트, 오류에 값 없음 | `packages/providers/src/oidc-login.test.ts`(17) |
| 가드: IdP 도메인·`.test` 차단, 비슷한 이름 통과 | `packages/providers/src/no-meta-network.test.ts`(+1) |
| route 통합(가짜 IdP): 성공→세션·감사·health details `auth`; HTML 303; 이메일 대소문자; sub 고정·sub 만; 틀린 email/email_verified false·없음·"true"/email 없음/틀린 sub → 403·감사·실패 1; state 없음·형식·모름·다른 브라우저(소비 안 함)·재사용·만료(IdP 호출 없음)·설정 변경·redirect 불일치; nonce·iss·aud·만료·서명·ID token 없음·token 400·code 위조 → 401·실패 1; token 500·시간 초과 → 502·실패 0; IdP 거부 → 401 취소·실패 0; discovery 실패 → 502·행 없음; **실패 10회 → 맞는 callback 도 429(state 미소비·감사 없음·IdP 호출 없음)·시작 429**; OIDC+dev 실패 합산; 준비 안 됨 503(응답에 이름 없음, 로그에 이름); cross-site 시작 403; oidc 의 식별자 로그인 403(실패 0); **NODE_ENV=production + oidc 성공, dev 는 계속 거부**; 진행 중 상한·unreadable·used(직접); 응답·감사·로그에 시크릿·키·code·state·토큰·이메일 없음 | `tests/integration/auth-oidc.test.ts`(36) |
| export 제외 표·보존 표·health details 키 | `bundle-tables.test.ts`, `export-restore.test.ts`, `ops.test.ts`(RETENTION 목록), `health.test.ts`, `ops-retention.test.ts` 기대값 갱신 |

- BASE_SHA: a04c521
- HEAD_SHA: af9860c85f561f65025ed1eb89a806f4df49f1b5 (code only, D28 — 오케스트레이터 커밋)
- Clean tracked tree confirmed: 아니오 — 이 과제의 미커밋 변경만 있음(`.claude/` 는 손대지 않은 기존 untracked).
- Relevant acceptance IDs: T21_DEPLOY_REVIEW G1, D3(운영 인증), T21-P1a 횟수 제한과의 결합
- Changed files:
  - 새 파일: `packages/domain/src/oidc.ts`, `oidc-format.ts`, `oidc.test.ts`; `packages/providers/src/oidc-login.ts`, `oidc-login.test.ts`; `packages/db/src/auth-oidc.ts`; `packages/db/drizzle/0043_t21p1b_oidc_states.sql`, `meta/0043_snapshot.json`(+`_journal.json`); `apps/web/app/api/auth/oidc/start/route.ts`, `callback/route.ts`; `apps/web/lib/oidc.ts`; `tests/helpers/fake-oidc-idp.ts`; `tests/integration/auth-oidc.test.ts`
  - 수정: `packages/domain/src/{auth,config,errors,secrets,bundle,ops,index}.ts`, `auth.test.ts`, `auth-production.test.ts`; `packages/db/src/{schema,index}.ts`, `bundle-tables.test.ts`; `packages/providers/{package.json,src/index.ts,src/no-meta-network.test.ts}`; `pnpm-lock.yaml`; `apps/web/app/api/auth/login/route.ts`, `app/login/page.tsx`, `app/settings/page.tsx`, `app/api/health/details/route.ts`, `lib/api.ts`; `tests/setup/no-meta-network.ts`; `tests/integration/{auth,auth-production-rate-limit,health,export-restore,ops-retention}.test.ts`
  - 문서: `README_KO.md`, `docs/04_DATA_AND_API.md`, `.env.example`(placeholder 만), `deploy/README_KO.md`(머리 경고 갱신 + §4.1 OIDC 설정 = 사용자 단계·별도 승인), `deploy/content-studio.env.example`(OIDC placeholder, 빠져 있던 `SECRETS_KEY_VERSION=1` 추가). `docs/DECISIONS.md`·`docs/handoffs/*` 는 손대지 않음.
- Migrations / restore implications: 0043 = 새 표 `auth_oidc_states` 만(drizzle-kit 출력 + 머리 주석, 다른 표 변화 없음). owner FK 없음. export 묶음 `excluded_tables` 에 `auth_oidc_states` 가 추가됨(묶음 스키마는 문자열 배열이라 이전 묶음 복원에 영향 없음 — drill:restore PASS). 앞으로만(down 없음, G8).
- Actual commands and results: (아래 "점검 결과")
- Demo route / local start steps: `.env.local` 에 `AUTH_MODE=oidc` + OIDC_* + 허용 신원 + 마스터 키 → `pnpm dev` → `/login` "OIDC로 로그인". 실제 IdP 가 필요하므로 **이번에는 실행하지 않음(not_run)** — 브라우저 확인도 하지 않았다.
- External calls performed (exact scope, or none): npm 레지스트리만 — `npm view openid-client|jose|oauth4webapi time/dependencies` 조회와 `corepack pnpm --filter @cs/providers add openid-client@6.8.8 --save-exact` 설치 1회. IdP·그 밖 외부 호출 없음. 시험은 프로세스 안 가짜 IdP 만.
- Mock-only functionality: OIDC 왕복 전체가 가짜 IdP 로만 확인됨(실제 IdP 0회).
- Known risks / not run: (아래)
- Questions specifically for Codex: (아래)
- Next authorized task: 없음(Codex 검증 후 오케스트레이터 결정). 실제 IdP 연결은 사용자 승인 필요.

## 점검 결과
시작 전 3000 포트 LISTEN 없음 확인(`netstat`). 명령: `bash .handoffs/run-checks.sh T21P1B`(2회), 그다음 `corepack pnpm exec vitest run --project integration --maxWorkers=2`.

| 단계 | 1회차(로그 `.handoffs/T21P1B-run1/`) | 2회차(최종, `.handoffs/checks-T21P1B.*.log`) |
| --- | --- | --- |
| LINT | 0 | 0 |
| TYPECHECK | 0 | 0 |
| BUILD | 0 | 0 |
| UNIT | 1 — `ops.test.ts`(새 표가 RETENTION 목록에 없음 → `RETENTION_PROTECTED_TABLES` 에 `auth_oidc_states` 추가) | **0 — 63 files / 1521 tests pass** |
| INTEG | 1 — `export-restore.test.ts`(excluded_tables 기대값)·`ops-retention.test.ts`(details 키 기대값) 2건 + worker 종료 2147483651(variants.test.ts) | 1 — 단언 실패 0건, worker 종료 2147483651 2건(ops-retention·seed, 손대지 않은 환경 문제) → 41/43 files, 784/869 |
| INTEG `--maxWorkers=2` 재실행 | — | **0 — 43 files / 869 tests pass**(884s) — `.handoffs/checks-T21P1B.integ-w2.log` |
| DRILL(`drill:mock`) | 0 | 0 — 불변식 위반 0건 |
| MIGRATE(`db:migrate`, 0043 적용) | 0 | 0 |
| DRILL_RESTORE | 0 | 0 — PASS |

1회차 실패 3건은 모두 새 표·새 키를 반영하지 않은 기존 기대값이었고 기대값·목록을 고친 뒤 2회차에서 통과했다(단언을 약하게 하지 않음 — 목록에 새 이름을 정확히 추가). 개발 중 개별 실행: `oidc-login.test.ts` 17/17, `oidc.test.ts` 37/37, `auth-oidc.test.ts` 36/36. "다른 키 서명" 시험은 `enableNonRepudiationChecks` 를 켜기 전 **실패**(라이브러리가 서명 검사를 생략)했고, 켠 뒤 통과했다.

## 남은 위험 / not_run
1. **실제 IdP 미검증(not_run)**: discovery 문서·키 교체·시계 오차·`email_verified` 표기·클라이언트 인증 방식은 가짜 IdP 로만 확인. 자체 호스팅 IdP 의 도메인은 시험 가드가 이름으로 막지 못한다(앱 경로는 주입 fetch 로만 나감).
2. **프록시 뒤 redirect 정확 일치**: callback 은 `requestRedirectTarget(request.url)`(origin+path)을 `OIDC_REDIRECT_URI` 와 비교한다(T13 Threads callback 과 같은 패턴). Caddy 뒤에서 Next 가 `request.url` 을 `https://<도메인>` 으로 만드는지(Host 보존·`X-Forwarded-Proto`) **확인하지 않았다** — 어긋나면 모든 OIDC callback 이 `redirect_mismatch`(실패로 셈)가 되어 15분 잠김. 첫 배포 때 확인 필요.
3. 전역 실패 창(T21-P1a 대가 그대로): 누구나 임의 state 로 callback 을 10번 치면 15분 동안 주인도 새로 로그인 못 함(기존 세션은 유지). 프록시 요청 제한 없음.
4. 시작 경로는 인증 없이 DB 행을 만든다 — 상한 100개(오래된 것 삭제)로 크기는 묶었지만, 시작을 계속 치면 주인의 진행 중 요청(10분 안)이 밀려나 다시 시작해야 할 수 있다.
5. `deploy/Caddyfile` 의 `Referrer-Policy "same-origin"`(지연 적용)이 앱의 `no-referrer` 를 덮어쓸 수 있다(같은 출처로만 Referer 전송 — code 가 외부로 새지는 않음). 이번 과제에서 Caddyfile 은 바꾸지 않음.
6. `check-env.sh` 는 OIDC_* 를 검사하지 않는다(문서에 명시).
7. IdP 응답 본문 크기 상한은 두지 않았다(라이브러리가 JSON 을 읽음).
8. 로그인 화면은 준비 여부만 보고 빠진 이름은 보여 주지 않는다(로그인 전 노출 회피) — 운영자는 서버 로그로 확인.

## Codex 에게 묻는 것
1. `enableNonRepudiationChecks` 를 켠 상태에서 openid-client 6.8.8 이 ID token 서명·iss·aud·exp·iat·nonce 를 모두 검사하는지(우리 시험: 다른 키 서명·nonce·iss·aud·만료가 모두 거부됨). `alg` 고정(RS256 등)이 필요한가, 메타데이터의 `id_token_signing_alg_values_supported` 에 맡겨도 되는가.
2. state 소비 규칙 — 다른 브라우저(결합 쿠키 불일치)는 소비하지 않고 실패로만 센다. 맞는가, 아니면 소비해야 하는가.
3. 실패 분류: `oidc_provider_error`(5xx·시간 초과)·`oidc_cancelled` 를 횟수에서 뺀 것이 안전한가.
4. 위험 2(프록시 뒤 `request.url`) — origin 비교를 유지할지, path 만 비교할지(코드 교환의 redirect_uri 는 어차피 설정값).
5. 허용 신원 결정(email 은 환경에 **명시**했을 때만, `email_verified` 는 불리언 true 만, 이메일 소문자 비교)이 적절한가.
6. 감싼 fetch 의 허용 호스트(issuer + discovery 의 token_endpoint·jwks_uri)와 시간 제한 race, AsyncLocalStorage 로 작업별 전송 상태를 나누는 방식에 빈틈이 있는가(캐시된 Configuration 을 동시 요청이 공유).
7. `auth_oidc_states` 상한 100 / 삭제 순서·잠금이 PGlite 단일 연결 밖(Postgres, G2)에서도 맞는가.


## 오케스트레이터 기록
- checks-T21P1B(2회차): lint·typecheck·build 0 · unit 63 파일 · 1521 · integration 1차 워커 exit 2147483651 2건(단언 실패 없음) → maxWorkers=2 재실행 43 파일 · 869 통과 · drill · migrate · restore PASS.
- migration 0043 포함 — 로컬 DB 는 다음 기동 때 앞으로만 적용된다.
