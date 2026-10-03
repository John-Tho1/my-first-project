# Implementation handoff — LIVE-T1 (D31 1단계: 실제 Threads OAuth 연결 코드, 실제 호출 0)
- Task ID / milestone: LIVE-T1 / M4 후속 — D31 승인 범위 1단계(실제 Threads OAuth·연결 확인 어댑터 코드, 기록된 응답(fixture)으로만 시험). 2단계(사용자 테스트 계정 1개 실제 연결)는 사용자가 README 순서로 직접.
- BASE_SHA: 6abe7099301dd623bc4cd954d7c212b1ad9e922b (6abe709, D30-3 인계 docs 커밋)
- HEAD_SHA: 1f16583 (code only, D28; orchestrator reran lint·typecheck·build·unit 884·integration 669·drill:mock 0·real-DB drill:restore PASS) — 커밋하지 않음(오케스트레이터가 커밋).
- Clean tracked tree: 작업 시작 시 yes(`?? .claude/` 만). 작업 중 `docs/handoffs/M4_CODEX_VERDICTS.md` 에 D30H 판정 3줄이 추가된 변경이 working tree 에 나타났다 — **이 작업이 만든 변경이 아니다**(오케스트레이터 동시 기록으로 보임). 건드리지 않았다.
- External calls performed: **none**. 코드·시험 어디에서도 Threads/Meta 로 요청하지 않았다(아래 네트워크 가드). 공식 문서 페이지만 읽기 전용으로 열람.
- PUBLISH_MODE: disabled 유지. 실제 게시(컨테이너·threads_publish)는 구현하지 않았다.
- Acceptance: D31(1단계 범위), D24·D25(T13 규칙 유지), AGENTS.md Invariants(credentials on server, never in logs/browser; no publish; mock success ≠ real), M4-DEV1(모의 다시 채우기는 실제 연결 정보를 건드리지 않음).

## 공식 문서 출처(2026-10-03 열람, 읽기 전용)
WebFetch 로 받은 본문(마크다운 변환)에 "Updated" 날짜가 보이지 않았다 — 페이지의 갱신일은 **확인하지 못함**. D31 은 같은 문서의 2026-08-12 판을 기록해 두었다(사용자 기록). 2단계 전에 사용자가 브라우저로 갱신일을 한 번 확인할 것을 권한다.
| 문서 | 확인한 내용 |
|---|---|
| developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions | 인증 창 `https://threads.com/oauth/authorize` ? client_id(필수)·redirect_uri(필수)·scope(필수, 쉼표/공백)·response_type=code(필수)·state(선택). **PKCE 언급 없음**. redirect 뒤 `#_` 가 붙을 수 있음(코드 일부 아님). 코드 교환 `POST https://graph.threads.com/oauth/access_token` (client_id·client_secret·code·grant_type=authorization_code·redirect_uri) → `{access_token, token_type?, user_id}`(user_id 는 JSON **숫자** 예시 17841405793187218 — 2^53 초과). 코드 1시간·1회용. 오류 예 `{error_type:"OAuthException", code:400, error_message:"Matching code was not found or was already used"}`. 권한 이름: threads_basic(필수)·threads_content_publish·threads_read_replies·threads_manage_replies·threads_manage_insights |
| developers.facebook.com/docs/threads/get-started/long-lived-tokens | 장기 교환 `GET https://graph.threads.net/access_token` ? grant_type=th_exchange_token·client_secret·access_token → `{access_token, token_type, expires_in}`, 60일. 갱신 `GET https://graph.threads.net/refresh_access_token` ? grant_type=th_refresh_token·access_token — 24시간 이상·만료 전·threads_basic, 갱신 시점부터 60일. 앱 시크릿 요청은 서버에서만. 오류 예·철회 언급 없음 |
| developers.facebook.com/docs/threads/threads-profiles | `GET https://graph.threads.net/v1.0/me?fields=id,username,…&access_token=…` → `id` 는 **문자열** 예시 "1234567", threads_basic 필요 |
| developers.facebook.com/docs/threads/troubleshooting | 영상 컨테이너 오류만 — OAuth 오류 코드·토큰 철회·탈퇴(deauthorize) 콜백 문서 없음 |
- 호스트: 코드 교환 문서는 **graph.threads.com**, 장기 교환·갱신·프로필 문서는 **graph.threads.net** — 문서대로 섞어 썼다(질문 1).
- 토큰 철회 API: 위 문서·검색에서 찾지 못함 → `revoke` = `{ remoteRevoke: 'unsupported' }`(네트워크 없음).
- Meta Graph 오류 코드(190·463·458·460·4·17·32·613·10·200번대·1·2·101)는 Threads 문서에 표가 없어 **Graph API 일반 규약을 가정**해 매핑했다(질문 2).

## 설계
| 항목 | 결정 |
|---|---|
| 공급자 | `packages/providers/src/threads-live-oauth.ts` `LiveThreadsOAuthProvider`(id `threads`, mock=false, **pkce=false**). 기존 `OAuthProvider` 인터페이스 그대로 + 선택 필드 `pkce?`, `revoke` 반환형 `void | { remoteRevoke: 'unsupported' }` |
| authorize URL | `threads.com/oauth/authorize` 에 client_id·redirect_uri(등록값과 정확히 같을 때만)·scope=`threads_basic,threads_content_publish`(그 밖 scope 는 로컬 거부)·response_type=code·state 만. code_challenge·login_hint 없음 |
| PKCE | 문서에 없음 → 보내지 않음. 틀(T13)은 그대로 verifier 를 봉인해 두지만 challenge 를 싣지 않고 감사 `oauth.connect_start.pkce='none'`. 방어: state(SHA-256·세션·계정 결합·1회용·10분) + redirect 정확 일치 + 서버만 아는 client_secret |
| 코드 교환 | `POST graph.threads.com/oauth/access_token`(form 5개) → 단기 토큰 → 즉시 `GET graph.threads.net/access_token`(th_exchange_token) → 장기 토큰만 `OAuthTokenSet` 으로(만료 = now + expires_in, refresh token 없음). 단기 토큰·`user_id`(정밀도 손실)는 저장·사용하지 않음. 코드 끝 `#_` 는 뗀다 |
| scope 기록 | Threads 토큰 응답에 허용 scope 가 없다 → 요청한 최소 scope 를 그대로 기록(부분 허용 감지 불가 — 위험 1) |
| 프로필 | `/v1.0/me?fields=id,username` → `externalAccountId = id(문자열, 숫자만)`, `displayName = @username`. id 가 숫자형 JSON·없음 → malformed |
| 갱신 | `refresh_access_token`(th_refresh_token) 구현·시험. 단 **worker 자동 갱신은 모의 연결 정보만**(`refreshExpiringCredentials` 에 `is_mock = true` 조건) — 실제 갱신 호출은 D31 승인 목록 밖. 설정 화면도 실제 계정에 "지금 갱신" 버튼 없음. API `POST …/refresh` 는 여전히 호출 가능(질문 4) |
| 철회 | 네트워크 없이 unsupported. db `RemoteRevoke` 에 `'unsupported'` 추가 — 실패(failed·unknown)가 아니므로 정리 대기(cleanup_revoke)를 만들지 않고 T13 로컬 삭제(암호문 삭제·revoked_at·승인 철회) 그대로. 응답·감사 `remote_revoke: 'unsupported'`. callback 교환 뒤 폐기(계정 불일치·저장 실패)도 `issued_token_revoke: 'unsupported'`, `pending_record: 'not_requested'` |
| 오류 매핑 | `mapThreadsError`(순수 함수): 429·4/17/32/613 → provider_error(rate_limited, retryAfterSec) · 101 또는 client/app secret·client_id 메시지 → **invalid_client**(새 코드) · 190 → invalid_token(463 token_expired, 458·460 token_revoked) · 10·200~299 → scope_not_allowed · 5xx·1/2 → provider_error(server_error, 쓰기 단계면 ambiguous) · 교환 단계 그 밖 4xx → invalid_grant(redirect_uri 언급 → redirect_mismatch) · 401 → invalid_token · 그 밖 → invalid_request. 메시지 원문은 분류에만 쓰고 버림 |
| 결과 불명 | `OAuthProviderError.detail`(숫자·열거만: reason·step·httpStatus·providerCode·providerSubcode·ambiguous·retryAfterSec). 네트워크·시간 초과(10초)·5xx·2xx 형식 오류가 쓰기 단계(exchange·long_lived·refresh)면 `ambiguous: true`. callback: 400 `oauth_exchange_failed` + `outcome: 'unknown'`, 감사 `provider_reason`·`provider_step`·`outcome_ambiguous=yes`. 손에 든 토큰이 없어 T13 의 저장·정리 대기·철회 대상이 없음(재전송 없음, state 는 이미 사용 처리) |
| 비밀 위생 | 시크릿은 `#appSecret`(직렬화 안 됨) + `toJSON()` 은 id·redirect 만. fetch 실패의 원 오류(cause 에 URL·질의의 시크릿 가능)는 버리고 새 오류만 던짐. `redirect: 'error'`(시크릿 실은 요청이 다른 호스트로 리다이렉트되지 않게), https + `graph.threads.com`/`graph.threads.net` 외 호스트 거부. 오류 메시지는 `oauth provider error: <code>` 고정. route 의 미처리 예외 로그는 기존대로 이름만 |
| 준비 상태 | `liveOAuthReadiness` → `{ ready: boolean, missing }`: OAUTH_MODE=live · THREADS_APP_ID · THREADS_APP_SECRET(존재) · OAUTH_REDIRECT_URI(설정·형식) · SECRETS_MASTER_KEY · OAUTH_LIVE_APPROVAL_REF. **PUBLISH_MODE 는 연결 준비에서 뺐다**(D31 은 disabled 로 연결 승인). `LIVE_OAUTH_ADAPTER(T14 미구현)` 표식 제거(Threads 만). 새 `livePublishReadiness` = 항상 준비 안 됨 + `LIVE_THREADS_PUBLISH(D31 범위 밖)`. 공급자 선택(`resolveOAuthProvider`): 실제 계정 + Threads + 준비됨 + 등록 redirect = 설정값 + 앱 ID 숫자 형식 → 실제 공급자, 아니면 503 `live_oauth_not_configured`(이름만). Threads 밖 실제 계정 → `LIVE_OAUTH_ADAPTER(<채널> 범위 밖)`. 모의 계정은 OAUTH_MODE 와 관계없이 모의 공급자 |
| 실제 계정 행 | `POST /api/channel-accounts`(platform=threads, kind=live; 같은 출처·로그인·owner 범위·멱등) → `createLiveThreadsAccount`: external_account_id `pending:<uuid>`(mock: 접두 아님 — 기존 CHECK 그대로, migration 없음), state `disconnected`(accountReady=false → 배포 계획에 못 고름), 감사 `channel_account.live_created`. 첫 실제 callback 이 잠금 아래에서 프로필 ID 로 **묶음**(display_name = @username, 감사 `account_bound`). 같은 owner·플랫폼의 다른 행이 이미 그 ID → 409 `oauth_account_duplicate`. 묶인 행에 다른 ID → 409 `oauth_account_mismatch`(T13 그대로) |
| 게시 차단 | 실제 계정 state=disconnected(계획 불가) + `adapterIdFor` live → `LiveChannelNotConfiguredError`(변경 없음) + PUBLISH_MODE=disabled. 화면·/ops·health view notice 에 `LIVE_THREADS_PUBLISH(D31 범위 밖)` |
| 모의 경로 | 변경 없음. M4-DEV1 다시 채우기는 원래 `is_mock`·mock 공급자·kind=mock 만 읽고 live 모드에서는 건너뜀 — 실제 연결 정보가 있는 DB 에서 시험으로 확인 |
| 화면 | 설정: 연결 준비(준비됨/빠진 이름), 게시 준비 안 됨, "실제 Threads 계정 추가(연결 전 행 — 외부 호출 없음)", 실제 행 배지 `실제 계정`·`게시 안 함(D31 범위 밖)`, 준비됐을 때만 `실제 연결(Threads 인증 창)`(아니면 빠진 이름), `연결 확인(프로필 조회)`, `연결 해제(로컬 삭제 — Threads 철회 API 없음)`, 성공 문구 `connected=live`. /ops 한 줄 갱신 |
| 네트워크 가드 | `tests/setup/no-meta-network.ts`(vitest `setupFiles`, unit·integration 모두): globalThis.fetch 를 감싸 `*.threads.com|*.threads.net|*.facebook.com|*.instagram.com|*.fbcdn.net` 요청을 **보내기 전에** 거부·기록, 파일 afterAll 에서 기록이 있으면 그 파일 실패. 실제 효과 확인: 일부러 graph.threads.net 을 부르는 임시 시험 파일이 "1 failed"(삭제함) |

## 변경 파일
- 새 파일: `packages/providers/src/threads-live-oauth.ts`, `packages/providers/src/threads-live-oauth.test.ts`, `tests/integration/live-threads-oauth.test.ts`, `tests/setup/no-meta-network.ts`, 이 문서
- 코드: `packages/domain/src/oauth.ts`(인터페이스 pkce?·revoke 반환형·`OAuthRevokeOutcome`·`invalid_client`·`OAuthProviderErrorDetail`·준비 상태 분리·`LIVE_THREADS_PUBLISH_MARKER`·`pending:` 접두), `packages/providers/src/oauth.ts`(resolveOAuthProvider), `packages/providers/src/index.ts`, `packages/db/src/oauth.ts`(unsupported 철회·pkce 감사·교환 실패 부가 정보·live 묶기·`createLiveThreadsAccount`·`OAuthAccountDuplicateError`·health view notice/`live_unbound`·worker 자동 갱신 모의만), `packages/db/src/queries.ts`(감사 action), `apps/web/app/api/channel-accounts/route.ts`(POST), `…/[id]/connect/route.ts`(notice·주석), `apps/web/app/api/oauth/callback/route.ts`(connected=live), `apps/web/lib/oauth.ts`(livePublish·오류 문구), `apps/web/app/settings/page.tsx`, `apps/web/app/ops/page.tsx`, `vitest.config.ts`(setupFiles)
- 시험 수정: `packages/domain/src/oauth.test.ts`(준비 상태 — 의도한 동작 변경), `packages/providers/src/oauth.test.ts`(실제 계정 선택), `tests/integration/oauth.test.ts`(T13 의 "조건을 모두 넣어도 503 LIVE_OAUTH_ADAPTER" → "조건 하나(시크릿)가 빠지면 503, LIVE_OAUTH_ADAPTER 없음" — **의도한 동작 변경**이지 단언 완화가 아님. 나머지 단언(연결 요청 행 0·health needs_reconnect·트리거·CHECK) 그대로)
- 문서: `README_KO.md`("Threads 실제 연결(D31 2단계 준비)" 절), `docs/04_DATA_AND_API.md`(API 표 2줄)
- migration: 없음(0038 불필요 — `provider='threads'`·`is_mock=false` 는 0027/0036 CHECK 가 이미 허용, `pending:` 는 기존 CHECK 와 맞음)
- 수정하지 않음: `docs/DECISIONS.md`, `M4_CODEX_VERDICTS.md`, `M4_STATUS.md`, `D30H_IMPLEMENTATION_HANDOFF.md`, 기존 handoff, `.env.local`, `./data`

## 변경 → 시험
| 변경 | 시험 |
|---|---|
| authorize URL 정확성 | unit `threads-live-oauth.test.ts` — origin+path, 쿼리 키 집합 정확히 5개, 값, PKCE·시크릿 없음, fetch 0; 끝 슬래시 redirect·reply/insights scope 거부 |
| 코드 교환 성공 | 요청 2개(POST form 5개 정확 · GET th_exchange_token 3개), 장기 토큰만·만료 계산·scope, `#_` 제거, `redirect:'error'`·signal |
| 이미 쓴 code / 시크릿 거부 / redirect 오류 | invalid_grant(장기 교환 호출 없음) · invalid_client(메시지 원문 없음) · redirect_mismatch(등록값과 다르면 보내기 전에) |
| 결과 불명 | TypeError·TimeoutError → provider_error `{reason, step:'exchange', ambiguous:true}`, cause 없음; 실제 AbortSignal 시간 초과(30ms); 장기 교환 5xx·HTML·expires_in 없음 → ambiguous |
| 갱신·프로필·철회 | refresh 요청 모양(시크릿 없음)·만료; 190/463/100/429 매핑; /me 문자열 id·@username; 숫자 id·없음 → malformed; revoke unsupported·fetch 0 |
| 오류 매핑 표 | 17행 `it.each` |
| 비밀 누출 | 가짜 시크릿·code·단기·장기 토큰으로 성공 1 + 실패 5(공급자 오류 본문·fetch 오류 메시지에 비밀을 일부러 넣음) → console 출력·JSON·inspect(showHidden)·message·stack·공급자 직렬화 어디에도 없음; 생성자 오류에도 없음. 통합: 전체 흐름의 모든 응답(헤더+본문)·owner 감사 전체·console 에 없음, DB 암호문에 평문 없음(봉인 해제 = 장기 토큰, 단기 토큰 없음) |
| 준비 상태 행렬 | domain: 기본(6개 이름)·전부 → ready·하나씩 빠짐 6행·게시 준비 마커·`pending:`; providers: 7행 + redirect 불일치·앱 ID 형식·Threads 밖 채널·모의 계정은 live 모드에서도 모의; 통합 route: 5행 503(이름만, 연결 요청 행 0, fetch 0) + 마스터 키 없음 |
| 실제 계정 행 | 통합: 201 pending:·disconnected·ready false, 멱등 200, 잘못된 본문 400 3종, 다른 출처 403, 다른 owner 404·목록에 없음 |
| 전체 흐름 | 통합: connect(외부 호출 0, pkce none 감사) → callback(호출 3개 순서·호스트 정확) → 묶기(ID·@username, state 그대로 disconnected) → 다시 채우기 대상 아님 → worker 55일 뒤 자동 갱신 0·호출 0 → 배포 계획 불가 → check = /me 1회 → revoke = unsupported·호출 0·암호문 삭제·정리 대기 0·감사 |
| 재연결·불일치·중복 | 통합: 같은 계정 재연결 세대 2; 다른 ID → 409 mismatch(세대·ID 그대로, 감사 issued_token_revoke unsupported); 새 pending 행이 이미 묶인 ID → 409 duplicate(행 그대로, 연결 정보 없음) |
| 교환 실패(통합) | used code → 400 invalid_grant(호출 1, 감사 outcome_ambiguous=no) · 네트워크 → outcome unknown·감사 ambiguous yes·시크릿 없음·같은 state 재사용 → oauth_state_used · 장기 5xx → unknown·연결 정보·정리 대기 0 |
| 모의 불변 | 통합: live 모드에서도 모의 Threads 연결 = mock_threads·앱 안 주소·호출 0; mock 모드 notice MOCK. 기존 `oauth.test.ts`·`mock-oauth-rehydrate.test.ts` 전체 통과 |
| 네트워크 가드 | unit: 주입 없는 실제 공급자 호출 → network 오류 + 가드 기록(graph.threads.net), facebook.com·threads.com 도 거부 → 기록을 비워 파일 통과. 별도 임시 파일로 "기록 남으면 파일 실패" 확인 후 삭제 |

## 실행한 명령과 결과(Windows 10, Git Bash, `source tools/env.sh`, Node 24.21.0, dev 서버 꺼짐)
| 명령 | 결과 |
|---|---|
| `corepack pnpm lint` | PASS (1차: `no-useless-assignment` 2·미사용 변수 1 → 수정 뒤 PASS) |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm build` | PASS |
| `corepack pnpm test` (unit) | PASS — 43 files, 884 tests |
| `corepack pnpm test:integration` (단독) | PASS — 34 files, 669 tests (557 s, unit 와 동시 실행 안 함) |
| `corepack pnpm drill:mock` | PASS — exit 0, "불변식 위반 0건" (M3·T14·T15·T16 표 그대로, Instagram fetch 호출 0) |

## 남은 위험
1. **부분 허용 scope 감지 불가**: Threads 토큰 응답에 허용 scope 가 없어 요청 scope 를 기록한다. 사용자가 threads_content_publish 를 빼고 동의해도 `연결됨`으로 보인다 — 게시(3단계) 때 권한 오류(10·200번대 → scope_not_allowed)로 드러난다. 3단계 전 권한 확인 방법(문서화된 엔드포인트가 있으면)을 정해야 한다.
2. **철회 불가**: 로컬 해제·교환 뒤 폐기(불일치·저장 실패) 시 장기 토큰이 Threads 쪽에서 최대 60일 유효하다. 결과 불명 교환(장기 교환 응답 유실)이면 우리가 본 적 없는 장기 토큰이 남을 수 있다. 사용자 수동 정리(Threads 앱 권한 삭제)만 가능 — README·화면에 안내.
3. **오류 코드 매핑은 Graph 일반 규약 가정**: Threads 문서에 OAuth 오류 표가 없다. 2단계 실제 응답(성공·오류 코드만)을 보고 보정.
4. **호스트 혼용**(graph.threads.com 교환, graph.threads.net 나머지)은 문서 그대로지만 실제로 한쪽만 동작할 수 있다.
5. `http://localhost` redirect 를 Meta 가 거부할 수 있다(D31 기록) — 그때 멈춤.
6. 실제 토큰 자동 갱신을 끔 → 60일 뒤 다시 연결 필요. 수동 `POST …/refresh` API 는 막지 않았다.
7. `apps/web/app/api/channel-accounts/route.ts` 의 POST 는 실제 계정 행만 만든다 — 행 삭제 경로는 없다(필요하면 별도 작업).

## 2단계에 필요한 것(사용자 수동, 정확한 순서) — README_KO "Threads 실제 연결(D31 2단계 준비)" 와 같음
1. Meta 앱 대시보드: Threads 사용 사례, 테스트 사용자(테스트 Threads 계정 1개), 유효한 OAuth 리디렉션 URI = `OAUTH_REDIRECT_URI` 와 글자까지 동일(기본 `http://localhost:3000/api/oauth/callback`). 거부되면 멈추고 알림.
2. `.env.local`(사용자가 직접): `OAUTH_MODE=live`, `THREADS_APP_ID`, `THREADS_APP_SECRET`, `OAUTH_REDIRECT_URI`, `OAUTH_LIVE_APPROVAL_REF=D31`, `SECRETS_MASTER_KEY`·`SECRETS_KEY_VERSION`. `PUBLISH_MODE` 는 disabled.
3. dev 서버 재시작 → 설정 → 배포 계정 연결: `실제 Threads 연결 준비됨` 확인.
4. `실제 Threads 계정 추가` → 그 행 `실제 연결(Threads 인증 창)` → 테스트 계정 로그인·동의 → `실제 Threads 계정을 연결했습니다`, 행 이름 `@username`·상태 연결됨·만료 약 60일.
5. (선택) `연결 확인(프로필 조회)` 1회.
6. 결과는 화면 문구·오류 코드만 공유(토큰·code·시크릿 없이). 실패 시 `/settings?account_error=<code>` 의 코드와 감사의 `provider_error`·`provider_reason`·`providerCode` 숫자만.
7. 끝나면 계속 둘지(만료 60일) 또는 `연결 해제`(로컬만) + Threads 앱 권한 삭제할지 사용자가 결정.

## Codex 에게 묻는 것
1. 호스트 혼용(교환 graph.threads.com, 장기·갱신·/me graph.threads.net)을 문서 그대로 둔 판단과, 허용 호스트 목록을 두 호스트로 고정한 것이 적절한가?
2. `mapThreadsError` 의 순서(429/rate → client → 190 → 권한 → 5xx/1·2 → 교환 단계 4xx → 401 → 그 밖)에서 잘못 분류될 수 있는 경우가 있는가? 특히 코드 1 + "client secret" 메시지를 invalid_client 로 보는 것(일시 오류일 가능성), 교환 단계의 모든 4xx 를 invalid_grant 로 보는 것.
3. 결과 불명 코드 교환에서 토큰이 손에 없으므로 정리 대기를 만들지 않은 것이 T13 의 "발급 토큰 정리" 규칙과 맞는가? state 는 이미 소비돼 재전송이 불가능한데, 추가로 막을 경로(같은 code 의 다른 callback)가 있는가?
4. 실제 연결 정보의 자동 갱신을 worker 에서 끈 것(D31 승인 목록에 갱신 호출이 없음)과 수동 `POST …/refresh` 를 열어 둔 것 — 수동 경로도 막아야 하는가?
5. `pending:` 행의 첫 callback 묶기(잠금 아래 재확인·같은 owner 중복 검사)에 경쟁 조건이 남는가? 두 pending 행이 동시에 같은 프로필로 묶이면 unique 제약 위반이 저장 실패 경로(store_failed → discard → 500 대신 409 가 아님)로 갈 수 있다.
6. 네트워크 가드(setupFiles)가 `vi.stubGlobal('fetch')` 를 쓰는 시험·`undici` 직접 사용·`http(s).request` 를 우회로 남기는가? 가드 범위를 넓혀야 하는가?


---

# FIX round 1 (Codex review-LIVET1)
- Orchestrator: HEAD_SHA 1b01226 (code only, D28) — reran lint·typecheck·build·unit 942·integration 673·drill:mock 0·real-DB drill:restore PASS.

- 판정 원본: `.handoffs/review-LIVET1.md`(CHANGES_REQUESTED, 검토 HEAD `1f16583`)
- BASE = `55b1b3839dc0a8d4148f72891c563821f4e6e7cb` · HEAD = TBD(커밋 전 — 오케스트레이터가 커밋 후 기록)
- 범위: D31 1단계 그대로 — Threads·Meta 로의 실제 요청 0(코드·시험 모두 fixture), 실제 자격 증명·`.env.local` 손대지 않음, 게시 코드 없음. 새 의존성 없음.

## 지적 → 변경 → 시험

### [P0] threads-live-oauth.ts:104 — 메시지 분류가 5xx 판정보다 먼저
- 변경: `mapThreadsError` 를 **전송·HTTP 상태 우선**으로 다시 짰다. 429 → rate_limited, 5xx → server_error(쓰기 단계면 ambiguous — 본문 코드·문구 무시), 408 → timeout(ambiguous), 4xx 가 아닌 상태의 오류 본문(2xx 등) → malformed_response(ambiguous), 4xx 인데 Meta 오류 형식 아님 → 쓰기 단계면 http_error(ambiguous). 형식 맞는 4xx 만 코드·하위 코드(4/17/32/613, 101, 190/463/458/460, 10·200~299)로 분류하고, 메시지는 그 뒤 4xx 안에서만 최후 수단(redirect_uri → 코드 교환이면 redirect_mismatch, 앱 ID·시크릿 → invalid_client). 코드 1/2 → server_error(ambiguous). 코드 교환은 알려진 코드(400·100·문자열 `invalid_grant`)만 invalid_grant, 그 밖(401·404·405·모르는 코드)은 provider_error(oauth_exception, ambiguous=false, providerCode·httpStatus 보존).
- Codex Q3(놓친 케이스): 장기 교환 단계의 모든 실패에 `detail.shortTokenIssued=true` — callback 감사에 `short_token_issued=yes`, `short_token_remote_state=may_be_valid`, `short_token_revoke=not_possible`(손에 없고 철회 API 도 없음). "발급 없음"으로 기록하지 않는다.
- 시험: `packages/providers/src/threads-live-oauth.test.ts` 「오류 분류 순서(FIX1-LIVET1 P0)」 표 26행 — 5xx + 코드 1 "validating client secret"(Codex 재현)·101·190/463·10·400 "already used"·redirect 문구·rate 코드, 408, 2xx 오류 본문, exchange 401/404 비형식, long_lived 400 비형식, 4xx 코드 vs 문구 충돌(190+client_id → invalid_token, 10+secret → scope, 4+secret → rate), 4xx 코드 1 + secret 문구(invalid_client) / 그 밖 문구(ambiguous), exchange 401/404/405 형식 본문 → provider_error. 각 행에서 detail 에 원문 문구 없음. 공급자 경유 2건(503 → ambiguous·장기 교환 안 부름 / 장기 교환 4xx → shortTokenIssued). 통합 `tests/integration/live-threads-oauth.test.ts`: 503 + secret 문구 callback → 400 `oauth_exchange_failed` + `outcome: unknown`, 감사 `outcome_ambiguous=yes`; 장기 교환 5xx 감사의 short_token_* 3필드.

### [P1] threads-live-oauth.ts:199 — 실제 갱신이 서버 경계에서 막히지 않음
- 변경: (1) 서버 공통 갱신 진입점 `refreshCredential`(packages/db/src/oauth.ts)이 **공급자를 만들거나 정리 대기·봉인을 건드리기 전에** 계정 kind 를 보고 실제(live) 계정이면 `LiveRefreshOutOfScopeError`(409 `live_refresh_out_of_scope`, extra.marker `LIVE_THREADS_REFRESH(D31 범위 밖)`)를 던진다 — 외부 호출 0, 연결 정보 상태·세대·봉인·lastErrorCode 그대로, 감사 `oauth.refresh_refused`(reason·kind·platform·trigger). 수동 API(`POST …/refresh`, JSON 409·폼 303 `account_error=live_refresh_out_of_scope`), 작업 처리기(`jobCredentials().refresh`), worker(`refreshExpiringCredentials` — 원래 isMock 조건 + 이 진입점) 모두 이 함수를 지난다. (2) 두 번째 방어선: `LiveThreadsOAuthProvider.refresh` 는 생성자 `refreshEnabled` 가 true 가 아니면 네트워크 없이 같은 오류. `resolveOAuthProvider` 는 이 값을 넘기지 않는다(설정·환경으로 켤 수 없음 — fixture 시험만 true 로 요청 모양 확인). 모의 갱신은 그대로.
- 시험: 단위 「실제 갱신 차단(FIX1-LIVET1 P1)」 — 직접 만든 공급자·resolveOAuthProvider 가 만든 공급자 모두 refresh → LiveRefreshOutOfScopeError(conflict, 표식), fixture fetch 0회. 통합 전체 흐름 시험 안: API refresh(JSON) 409 + 표식, 폼 303, `jobCredentials().refresh` 거부, fixture 호출 수 불변, 연결 정보 5개 필드 불변, `oauth.refresh_refused` 3건, `oauth.refresh_failed` 0건. worker 자동 갱신은 기존 단언(refreshed 0·failed 0·호출 0) 유지.

### [P2] domain/oauth.ts:401 — 화면 준비 판정과 공급자 설정 검증 불일치
- 변경: 공유 검증 함수 `isValidThreadsAppId`(숫자 1~30자리)·`isValidThreadsAppSecret`(앞뒤 공백 뗀 값이 공백 없는 1~512자)·`threadsAppSecretState(env)` 를 domain 에 두고, `liveOAuthReadiness(config, { threadsAppSecret: 'missing'|'invalid'|'ok', masterKeyConfigured }, registeredRedirectUri?)` 가 형식(`THREADS_APP_ID(형식)`·`THREADS_APP_SECRET(형식)`)과 등록 redirect 불일치(`OAUTH_REDIRECT_URI(불일치)`)까지 판정한다. `liveOAuthReadinessFromEnv` 를 화면(`oauthReadinessView` — 등록 redirect = `oauthRedirectUri(config)`)과 공급자 선택(`resolveOAuthProvider`)이 같이 쓰고, resolver 는 그 missing 을 그대로 던진다. 공급자 생성자도 같은 검증 함수(생성자 catch 는 이제 닿지 않는 방어선). 이름만, 값 없음.
- 시험: 단위 「준비 판정 ↔ 공급자 선택 일치 행렬」 15행 — 각 행 `readiness.ready === (resolver 성공)`, `readiness.missing` === resolver 오류 missing === 기대값(placeholder-app-id(Codex 재현)·31자리·시크릿 공백뿐/중간 공백/513자/앞뒤 공백(통과)·redirect 없음/불일치·키·승인·복합). domain 시험: 기존 FULL 의 `placeholder-app-id`(불일치를 고정하던 값) → 숫자 ID, 형식 2행 + 불일치·검증 함수 시험 추가. 통합 준비 행렬 2행 추가(앱 ID·시크릿 형식 → route 503 이름 + `oauthReadinessView().live` 같은 이름·ready=false).

### [P2] tests/setup/no-meta-network.ts:37 — fetch 래퍼만으로는 차단 보장 불가
- 변경: 가드가 막는 경로(이 시험 프로세스 안): ① 전역 fetch 래퍼 ② Node 내장 undici 전역 dispatcher(`Symbol.for('undici.globalDispatcher.1')` 를 Proxy 로 감쌈 — fetch 의 리다이렉트 각 단계, 가드 설치 전 fetch 참조도 지남. 이 저장소에 undici 패키지는 없음 — 설치되면 같은 전역 dispatcher 사용) ③ `node:http`·`node:https` request·get ④ `node:net` connect·createConnection, `node:tls` connect(host·servername), `net.Socket.prototype.connect`(http.Agent·ClientRequest 직접 생성 포함 모든 TCP·TLS 의 마지막 관문) ⑤ `node:dns` lookup·resolve·resolve4·resolve6·resolveAny·resolveCname + promises. `syncBuiltinESMExports()` 로 ESM 이름 가져오기에도 반영. 호스트 정규화(소문자·[ ] 제거·끝의 점 제거), `*.fbcdn.net` 포함. afterAll 은 시도 기록 외에 전역 dispatcher 가 가드 밖으로 바뀌었는지도 확인한다. 막지 못하는 것: 자식 프로세스·worker_threads, 이미 해석한 IP 로의 직접 연결, 네이티브 애드온 — 가드 머리 주석·README_KO D31 절에 명시.
- 증명(probe — 실제 Meta 호스트로 나가지 않게 두 단계): (a) 가드 정규식에 임시로 `guard-probe.invalid` 를 넣고 영구 시험의 호스트를 모두 `*.guard-probe.invalid` 로 바꾼 사본을 돌림 → 11/11 통과(모든 경로가 연결·DNS 전에 막힘 — 새는 경로가 있었어도 .invalid 로만 나감). (b) 정규식 원복 뒤, 기록을 비우지 않는 임시 probe(fetch·http.request·https.get·net.connect·tls.connect·dns.lookup 각 1회)를 돌림 → 4개 시험은 통과(각각 throw/reject)하고 **파일은 afterAll 에서 FAIL**("6번 요청 … fetch, http.request, https.get, net.connect, tls.connect, dns.lookup"). 두 임시 파일 모두 삭제, 정규식 원복 확인(`guard-probe` 0건).
- 영구 시험: `packages/providers/src/no-meta-network.test.ts`(11) — fetch 문자열/URL/Request·대문자·끝의 점·fbcdn·instagram, 로컬(127.0.0.1) 서버의 302 → graph.threads.net 리다이렉트가 `undici.dispatch` 에서 막힘, 가드 설치 전 fetch 참조도 막힘, 허용 호스트(로컬)는 fetch·http.get 통과, http/https request·get(문자열·옵션·host:port·URL·ESM 이름 가져오기), ClientRequest 직접 생성(Agent·createConnection+tls), net/tls/Socket.connect, dns 콜백·promises, 비슷한 이름은 막지 않음. 마지막에 기록을 비운다.

### 그 밖 놓친 케이스(review 목록 중 싼 것)
- 반영: 5xx + client·token·permission 코드, exchange 401·404·405·408·2xx 오류 본문, 실제 계정 수동 갱신 API, 앱 ID·시크릿 형식의 화면·API 일치, 직접 HTTP(S)·undici·리다이렉트·끝의 점 호스트, 장기 교환 실패 시 단기 토큰 원격 유효 가능성 기록.
- 미반영(남은 위험으로): 새 state 로 같은 code 재전달·동시 전달 차단(code 지문 원자 예약), 서로 다른 pending 행의 같은 프로필 동시 묶기·계정 생성 API 동시 호출의 고유 제약 → 409 변환, 부분 권한 허용 scope 구분, 프로필 조회·저장 실패 시 원격 철회 미지원 기록의 추가 필드.

## 바뀐 파일
- `packages/providers/src/threads-live-oauth.ts` — 오류 분류 순서, refreshEnabled 게이트, 공유 형식 검증, 장기 교환 shortTokenIssued
- `packages/providers/src/oauth.ts` — resolver 가 `liveOAuthReadinessFromEnv` 결과를 그대로 사용
- `packages/domain/src/oauth.ts` — `shortTokenIssued` detail, `LIVE_THREADS_REFRESH_MARKER`·`LiveRefreshOutOfScopeError`, 공유 검증 함수, readiness 형식·불일치, `liveOAuthReadinessFromEnv`
- `packages/db/src/oauth.ts` — refreshCredential 실제 계정 거부(감사 `oauth.refresh_refused`), callback 감사 short_token_* 필드
- `packages/db/src/queries.ts` — 감사 action `oauth.refresh_refused`
- `apps/web/lib/oauth.ts` — 화면 준비 판정이 공유 함수 사용, 폼 오류 문구 `live_refresh_out_of_scope`
- `tests/setup/no-meta-network.ts` — 다층 가드
- 시험: `packages/providers/src/threads-live-oauth.test.ts`, `packages/providers/src/no-meta-network.test.ts`(새 파일), `packages/domain/src/oauth.test.ts`, `tests/integration/live-threads-oauth.test.ts`
- 문서: `README_KO.md`(D31 절 가드 범위·갱신 거부 문장), 이 인계 문서(추가만)
- 손대지 않음: DECISIONS·M4_CODEX_VERDICTS·M4_STATUS·다른 인계, `.env.local`, `./data`

## 실행한 명령(Windows 10, Git Bash, `source tools/env.sh`, Node 24.21.0, `corepack pnpm`)
| 명령 | 결과 |
|---|---|
| `corepack pnpm lint` | PASS |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm build` | PASS(exit 0) |
| `corepack pnpm test` (unit) | PASS — 44 files, 942 tests(이전 43/884) |
| `corepack pnpm test:integration` (단독, unit 과 동시 실행 안 함) | PASS — 34 files, 673 tests(이전 669) |
| `corepack pnpm drill:mock` | PASS — exit 0, "불변식 위반 0건"(M3·T14·T15·T16), Instagram fetch 호출 0 |
| 임시 probe (a) `.invalid` 사본 | 11/11 PASS(차단 확인) → 삭제 |
| 임시 probe (b) 기록 안 비움 | 의도대로 FAIL(afterAll BLOCKED_EXTERNAL_NETWORK, 6건·6경로) → 삭제 |

(README 수정은 위 명령 뒤의 문서 변경 — 코드 변경 없음.)

## 남은 위험(이번 라운드 기준 갱신)
1. 위 "미반영" 놓친 케이스(같은 code 재전달·동시 묶기·동시 계정 생성·부분 scope).
2. 오류 분류는 여전히 Graph 일반 규약 가정 — 4xx 코드 1 + 시크릿 문구를 invalid_client 로 보는 판단은 문구 의존(최후 수단). 2단계 실제 응답으로 보정.
3. 실제 갱신은 이제 모든 경로에서 막힌다 → 실제 연결은 60일 뒤 다시 연결 필요(설계상 의도, 별도 승인 시 refreshCredential 의 kind 검사와 refreshEnabled 를 함께 풀어야 함).
4. 네트워크 가드는 시험 프로세스 안만 — 자식 프로세스·worker_threads·IP 직접 연결·네이티브 애드온은 범위 밖. 누군가 `setGlobalDispatcher` 를 부르면 afterAll 이 파일을 실패시키지만 그 사이 요청은 net 층만 막는다.
5. HEAD 미정 — 커밋 후 SHA 기록 필요.

## Codex 에게 묻는 것(FIX round 1)
1. 상태 우선 분류에서 **4xx + 형식 맞는 본문 + 코드 1/2** 를 쓰기 단계 ambiguous 로 둔 것(4xx 는 HTTP 상 미처리 거절이지만 Meta 코드 1 은 "알 수 없는 오류")과, exchange 의 모르는 4xx 코드를 ambiguous=false provider_error 로 둔 것이 불변식("불명은 UNKNOWN")에 맞는가?
2. 실제 갱신 차단을 `refreshCredential` 의 계정 kind 검사(공급자·봉인·정리 대기보다 먼저) + 공급자 `refreshEnabled` 두 겹으로 둔 것이 충분한가? 정리 대기(pending)가 있는 실제 계정도 refresh 요청 시 reconcile 없이 거부되는데, 이것이 정리 지연 위험을 만드는가(정리는 check·worker tick 이 계속 한다)?
3. 네트워크 가드의 undici 전역 dispatcher Proxy·`net.Socket.prototype.connect` 패치 방식에 우회 경로(예: `http2.connect`, `fetch` 에 `dispatcher` 옵션으로 별도 Agent 전달 — 이 저장소엔 undici 패키지가 없어 Agent 생성 불가)가 남는가? `http2` 도 막아야 하는가?

---

# FIX round 2 (Codex review-FIX-LIVET1)
- Orchestrator: HEAD_SHA e51ae72 (code only, D28) — reran lint·typecheck·build·unit 1010·integration 692·drill:mock 0·real-DB drill:restore PASS.

- 대상 판정: `.handoffs/review-FIX-LIVET1.md`(CHANGES_REQUESTED — P0 1, P2 2) on `1b01226`
- BASE_SHA: `16a22b13a8a3bf4387d51b72b8334588942d1cdd`(현재 HEAD, docs 전용 커밋) · HEAD_SHA: TBD(커밋 안 함 — 오케스트레이터가 커밋 후 기록)
- 범위: D31 1단계 그대로 — Threads·Meta 로 실제 요청 0, fixture 만, 실제 자격 증명·`.env.local`·`./data` 손대지 않음, 실제 게시·실제 갱신 없음. 새 의존성 없음.

## 지적 → 변경 → 시험

### [P0] threads-live-oauth.ts:138 — 메시지 분기가 일시 코드를 확정 실패로 덮어씀
- 재현: `mapThreadsError('exchange', 400, { error: { code: 1|2, message: 'Error validating client secret.' | 'redirect_uri …' } })` → 수정 전 `invalid_client`·`redirect_mismatch`(ambiguous 없음 → 감사 `outcome_ambiguous=no`, 응답에 `outcome: unknown` 없음). 수정 전 단위 시험 2곳(「앱 시크릿 거부」 코드 1 fixture, 표 행 「400 + 코드 1 "Error validating client secret."」)이 바로 그 잘못된 동작을 고정하고 있었다 → 기대값을 결과 불명으로 바꿨다(약화가 아니라 불변식 쪽으로 강화).
- 변경: `mapThreadsError` 를 엄격한 표 기반 순서로 다시 짰다(위가 이긴다):
  1) 전송·상태(429 → rate_limited · 5xx → server_error · 408 → timeout · 4xx 아닌 오류 본문 → malformed_response · 4xx 비형식 → 쓰기 단계 http_error ambiguous) — FIX1 그대로
  2) **일시 표 `THREADS_TRANSIENT_CODES`**(export): 1·2 → server_error(쓰기 단계 ambiguous), 4·17·32·341·613·80000~80014 → rate_limited. Graph 오류 객체의 `is_transient: true` 도 일시(코드가 190 이어도 일시가 이긴다). **문구는 보지 않는다.**
  3) 확정 표 `definiteByCode`: 101 → invalid_client, 190(463 expired·458/460 revoked) → invalid_token 계열, 10·200~299 → scope_not_allowed, 교환 400·100 → invalid_grant, 그 밖 단계 100 → invalid_request. 범용 매개변수 오류 **100 만** 문구로 더 구체적인 확정 오류(redirect_mismatch·invalid_client)로 좁힌다(확정 → 확정, ambiguous 영향 없음).
  4) 문구는 **코드·하위 코드가 모두 없을 때만**(redirect_uri → redirect_mismatch(교환), 앱 ID·시크릿 → invalid_client), 문자열 `invalid_grant`(교환) → invalid_grant.
  5) 나머지(모르는 코드·하위 코드만 있음·분류 안 되는 본문): 쓰기 단계면 provider_error(oauth_exception, **ambiguous=true** — Codex 답 Q7 "확정 거절로 검증된 응답과 나머지를 구분"), 읽기 단계(account)는 401 → invalid_token, 그 밖 → invalid_request(FIX1 은 교환의 모르는 코드를 ambiguous=false 로 두었음 → 바꿈).
  - `parseThreadsErrorBody` 가 `is_transient`(불리언만)를 읽는다. 문자열 코드("1")도 숫자로 읽는 기존 규칙 그대로.
- 시험: `packages/providers/src/threads-live-oauth.test.ts`
  - 「오류 분류 순서」 표 +20행: 400 + 코드 1/2 + 시크릿 문구(Codex 재현 2건), 코드 1 + redirect_uri, long_lived 코드 2 + client_id, 403 + 코드 4 + 시크릿 → rate_limited, 341·80002 + 문구 → rate_limited, 모르는 코드 + is_transient + 시크릿 → ambiguous, 190 + is_transient → 일시, 문자열 코드 "1" + 시크릿, 읽기 단계 코드 2(ambiguous=false), 코드 없음 + 시크릿 → invalid_client, 코드 없음 + redirect → redirect_mismatch, 하위 코드만 + 시크릿 → 문구 안 봄(ambiguous), 모르는 코드 + 시크릿 → 문구 안 봄(ambiguous), 코드 100 + 시크릿 → invalid_client, long_lived 모르는 코드 → ambiguous, refresh 100 → invalid_request, account 모르는 코드 400/401 → invalid_request/invalid_token. exchange 401·404·405 형식 본문 3행은 ambiguous=true 로 기대값 변경(Q7).
  - 공급자 경유 새 시험: 코드 교환 400 + {코드 1·2} × {시크릿·redirect 문구} 4건 → `detail` 이 정확히 `{reason: server_error, step: exchange, httpStatus: 400, providerCode, ambiguous: true}`, 장기 교환 안 부름. 기존 「앱 시크릿 거부」는 코드 101 fixture 로 바꿔 invalid_client 경로를 유지.
  - 매핑 표 +2행(341·80014 → rate_limited).
  - 통합 `tests/integration/live-threads-oauth.test.ts` +2건(it.each): callback 코드 교환 400 + 코드 2 "Temporary error validating client secret" / 코드 1 + redirect_uri 문구 → 400 `oauth_exchange_failed` + `reason: provider_error` + `outcome: unknown`, 감사 `provider_reason=server_error`·`outcome_ambiguous=yes`, 감사에 문구 원문 없음, 연결 정보 없음, fixture 호출 1회.

### [P2] threads-live-oauth.ts:127 — 429 밖 제한 응답에서 Retry-After 유실
- 변경: 제한 분류(429 와 일시 표의 rate_limited 코드 전부)가 공통 `parseRetryAfterSec(hints)`(export)를 쓴다. 힌트는 `{ retryAfter, businessUseCaseUsage }` — `Retry-After` 는 0~999999 의 정수 초만(음수·소수·HTTP-date·너무 큼은 버림), `X-Business-Use-Case-Usage` JSON(8 KiB 이하)의 `estimated_time_to_regain_access`(분, 양의 정수)의 최댓값 × 60. 둘 다 있으면 긴 쪽. 결과는 기존 필드 `detail.retryAfterSec`(초 — domain `OAuthProviderErrorDetail`·`retryDelay` 와 같은 단위라 ms 필드는 새로 만들지 않았다). 원 헤더 값은 어디에도 남기지 않는다. `X-App-Usage` 는 사용률(%)만 있고 시간이 없어 읽지 않는다. 확정·5xx 오류에는 붙이지 않는다. `#call` 이 두 헤더를 넘긴다. 문자열 4번째 인자(기존 호출 형태)는 Retry-After 로 그대로 받는다.
- 시험: 「제한 응답의 다시 시도 시간(FIX2-LIVET1 P2)」 13행(400 + 코드 4 + Retry-After 120(Codex 재현), 403 + 17 + 문자열 인자, 613 + BUC 5분, 32 + 둘 다 → 긴 쪽, 429 + BUC 만, 429 + 0, 음수·소수·HTTP-date·너무 큼·깨진 JSON·BUC 음수/문자·힌트 없음 → 필드 없음, 모든 행에서 detail 에 헤더 원문 없음) + 확정·5xx 에는 붙지 않음 1건 + 공급자 경유 1건(/me 400 + 코드 4 + Retry-After 90 + BUC 1분 + X-App-Usage → detail 이 정확히 `{reason, step, httpStatus, providerCode: 4, retryAfterSec: 90}`).

### [P2] tests/setup/no-meta-network.ts:169 — DNS 가드가 Resolver 인스턴스를 놓침
- 변경: dns 모듈 함수는 기본 Resolver 에 묶인 사본이라 프로토타입 패치가 반영되지 않는다 → 둘 다 감싼다. (1) 이름 목록을 고정하지 않고 `node:dns`·`dns.promises` 의 `lookup` + `resolve*` 전부(이 Node 에 있는 것 — resolveTxt·resolveMx·resolveSrv·resolveNs·resolveSoa·resolveCaa·resolveNaptr·resolvePtr·resolveTlsa 등), (2) `dns.Resolver.prototype`·`dns.promises.Resolver.prototype` 의 `resolve*` 자체 메서드(하위 클래스는 프로토타입 사슬로 포함). 콜백 형은 동기 throw, promise 형은 reject, 기록 경로 이름 `dns.Resolver.<fn>`·`dns.promises.Resolver.<fn>`. `reverse`·`lookupService` 는 IP 를 받아 판별 불가 → 남은 위험(머리 주석·README 에 명시). `GuardState.dnsResolverGuarded` 표시 추가.
- 증명(probe — 실제 Meta 로 나가지 않게): 가드 정규식에 임시로 `guard-probe.invalid` 추가, Resolver 서버를 닫힌 로컬 포트 `127.0.0.1:9` 로 둔 임시 시험 `packages/providers/src/zz-dns-resolver-probe.test.ts`:
  - **수정 전 가드**: `new dns.Resolver().resolve4('b.guard-probe.invalid')` 동기 throw 없음, `new dns.promises.Resolver().resolveTxt('c.guard-probe.invalid')` → `queryTxt ECONNREFUSED`(가드를 지나 실제 조회 함수까지 감), 기록 `[]` — Codex 지적 재현.
  - **수정 후 가드**: 둘 다 BLOCKED, 기록 `dns.Resolver.resolve4`·`dns.promises.Resolver.resolveTxt`. 같은 probe 에서 `http2.connect('https://d.guard-probe.invalid')` → `tls.connect` 에서 동기 throw(별도 http2 패치 불필요 — Codex 답 Q9 의 "net/tls 가드에서 전송 전에 차단됨을 검증").
  - probe 파일 삭제, 정규식 원복, `guard-probe` 참조 0건 확인.
- 영구 시험 `packages/providers/src/no-meta-network.test.ts` +3(11 → 14): Resolver 콜백(resolve4·resolveTxt·resolve, 대문자·끝의 점)·promises(resolve4·resolveTxt·resolveAny)·하위 클래스(resolveSrv)·모듈 resolveTxt·resolveMx·promises.resolveNs 10경로의 기록 순서; 허용 이름(`allowed.guard-test.invalid`)은 Resolver 가드를 지나 원래 조회 함수로 감(닫힌 로컬 서버 → 연결 거부, 기록 없음); `http2.connect('https://graph.threads.net')` → `tls.connect` 에서 막힘. 마지막 정리 시험의 최소 시도 수 20 → 35.
- 문서: 가드 머리 주석, `README_KO.md` D31 절(막는 경로에 Resolver 인스턴스·http2, 막지 못하는 것에 reverse/lookupService·undici 패키지 별도 dispatcher(시험 없음)).

### 그 밖 놓친 케이스(review 목록 중 싼 것)
- 반영: 400 코드 1/2 + client secret·redirect_uri 문구와 UNKNOWN 감사(단위·통합), 429 아닌 제한 코드의 유효·무효 Retry-After, callback·promise Resolver 인스턴스·누락 조회 함수·http2 의 차단 시험과 `.invalid` 허용 경로 시험.
- 미반영(남은 위험 — FIX1 과 같음): 별도 undici dispatcher(패키지 없음 — 만들 수 없어 시험 불가), pending 있는 실제 계정 갱신 거부 뒤 독립 정리 완료 시험, 서로 다른 state 로 같은 code 순차·동시 전달(code 지문 원자 예약), 두 pending 행의 같은 프로필 동시 묶기·동시 계정 생성 고유 제약 → 409, 부분 권한 허용·프로필 조회/저장 실패 뒤 원격 토큰 잔존 기록.

## 바뀐 파일(FIX round 2)
- `packages/providers/src/threads-live-oauth.ts` — 표 기반 분류(`THREADS_TRANSIENT_CODES`·`definiteByCode`·`refineByMessage`), `is_transient`, `parseRetryAfterSec`·`ThreadsRateLimitHints`, `#call` 이 Retry-After·BUC 헤더 전달
- `tests/setup/no-meta-network.ts` — dns 모듈 함수 전부 + Resolver.prototype(콜백·promises), 주석
- 시험: `packages/providers/src/threads-live-oauth.test.ts`, `packages/providers/src/no-meta-network.test.ts`, `tests/integration/live-threads-oauth.test.ts`
- 문서: `README_KO.md`(D31 절 한 문장), 이 인계 문서(추가만)
- 손대지 않음: T18 인계·DECISIONS·M4_CODEX_VERDICTS·M4_STATUS·다른 인계, `.env.local`, `./data`. (작업 트리의 `docs/handoffs/M4_CODEX_VERDICTS.md` 변경은 이 라운드가 만든 것이 아니다.)

## 실행한 명령(Windows 10, Git Bash, `source tools/env.sh`, Node 24.21.0, `corepack pnpm`)
| 명령 | 결과 |
|---|---|
| 임시 probe(수정 전 가드, `.invalid`·127.0.0.1:9) | Resolver 2경로 **안 막힘**(기록 0, ECONNREFUSED) — 지적 재현 |
| 임시 probe(수정 후 가드) | Resolver 2경로 + http2 막힘(기록 3) → 파일 삭제·정규식 원복 |
| `vitest run --project unit` 두 파일(no-meta-network·threads-live-oauth) | PASS — 2 files, 140 tests |
| `corepack pnpm lint` | PASS |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm build` | PASS(exit 0) |
| `corepack pnpm test` (unit) | PASS — 46 files, 1010 tests |
| `corepack pnpm test:integration` (단독, unit 과 동시 실행 안 함) | PASS — 35 files, 692 tests |
| `corepack pnpm drill:mock` | PASS — exit 0, "불변식 위반 0건"(M3·T14·T15·T16), Instagram fetch 호출 0 |

(README 수정은 lint·typecheck·build·test 전에 했다. 이 인계 추가는 명령 뒤의 문서 변경.)

## 남은 위험(FIX round 2 기준)
1. 일시·확정 코드 표는 Meta Graph API 일반 규약(Handling Errors·Rate Limiting) 기준 — Threads 문서에 같은 표가 있는지는 이번 라운드에 다시 열람하지 않았다. 표에 없는 코드는 쓰기 단계에서 UNKNOWN 으로 남기므로(보수적) 잘못 분류되면 "확정 실패를 불명으로" 쪽이다. 2단계 실제 응답으로 보정.
2. 교환 단계에서 모르는 4xx 코드·코드 없는 비분류 본문이 이제 `outcome: unknown` — 사용자는 "결과 불명, 다시 연결" 안내를 더 자주 볼 수 있다(state 는 이미 소비, code 는 1회용이라 재전송 위험은 없음).
3. 코드 100 만 문구로 좁히는 예외(확정 → 확정). 문구가 바뀌면 redirect_mismatch·invalid_client 대신 invalid_grant 로 보일 뿐 ambiguous 판정은 바뀌지 않는다.
4. Retry-After 의 HTTP-date 형식은 읽지 않는다(현재 시각 의존을 피함) — 날짜형이면 retryAfterSec 없음 → 기본 백오프. Threads 가 BUC 헤더를 실제로 보내는지 미확인.
5. 네트워크 가드: dns.reverse·lookupService(IP), IP 직접 연결, 자식 프로세스·worker_threads, 네이티브 애드온, undici 패키지의 별도 dispatcher(시험 없음 — net/tls 단계가 막는다고 보지만 미확인)는 여전히 범위 밖.
6. FIX1 의 미반영 놓친 케이스(같은 code 재전달·동시 묶기·부분 scope·pending 정리 완료 시험) 그대로.
7. HEAD 미정 — 커밋 후 SHA 기록 필요.

## Codex 에게 묻는 것(FIX round 2)
1. 우선순위 "전송·상태 → 일시 코드/is_transient → 확정 코드(100 만 문구로 좁힘) → 코드·하위 코드 없을 때만 문구 → 나머지는 쓰기 단계 UNKNOWN" 이 불변식에 맞는가? 특히 (a) 코드 100 의 문구 좁히기(확정 → 확정)를 허용한 것, (b) 하위 코드만 있고 코드가 없는 본문에서도 문구를 보지 않게 한 것, (c) 일시 표에 341·80000~80014(BUC)를 넣은 것이 과하거나 부족한가?
2. 제한 정보를 기존 `retryAfterSec`(초, domain `retryDelay` 와 같은 단위)에 Retry-After 정수 초와 `X-Business-Use-Case-Usage.estimated_time_to_regain_access`(분) 중 긴 쪽으로 싣는 것이 충분한가 — HTTP-date Retry-After 를 버리는 것과 X-App-Usage 를 읽지 않는 것이 실제 소비 경로(현재 OAuth 경로는 갱신이 막혀 있어 소비자가 거의 없음)에 위험을 만드는가?
