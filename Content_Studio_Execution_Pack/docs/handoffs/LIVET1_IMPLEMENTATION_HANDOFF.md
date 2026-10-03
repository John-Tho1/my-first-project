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
