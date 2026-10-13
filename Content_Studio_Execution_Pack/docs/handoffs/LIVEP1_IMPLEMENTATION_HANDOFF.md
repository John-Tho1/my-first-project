# Implementation handoff — LIVE-P1 (D38 1단계: 실제 Threads 텍스트 게시 어댑터, 실제 호출 0)
- Task ID / milestone: LIVE-P1 / M4 후속 — 사용자 "실제 게시 진행해보자"(D38). 1단계 = 실제 Threads 텍스트 게시 어댑터·게이트·DB·화면을 만들고 **기록된 응답(fixture)·주입 fetch 로만** 시험. 2단계(실제 1건 게시)는 별도 정확 범위 승인 대상 — 이 작업에서 하지 않음.
- Purpose and changed behavior: 실제 계정 + Threads + 연결 정보가 있는 항목을 모든 게이트가 열렸을 때만 실제 Threads 텍스트 게시 어댑터(`live_threads`)로 보낸다(컨테이너 → 상태 FINISHED → 게시 시도 표식 → threads_publish → 원격 읽기 확인). 기본 설정(PUBLISH_MODE disabled·승인 기록 없음)에서는 실제 게시 경로가 열리지 않는다. 모의 계정 동작은 그대로.
- BASE_SHA: a50ee58
- HEAD_SHA: 320dadb20609c21e3a330b4a51847637bb07fb47 (LIVE-P1) · FIX-LIVEP1 HEAD 1a224348f4e720aadc2476a736513506c9d20deb
- Clean tracked tree confirmed: 시작 시 yes(`?? .claude/` 만). 이 작업의 변경 외 추적 파일 변경 없음.
- Relevant acceptance IDs: AGENTS Invariants(정확한 payload·계정·공개 범위 승인 없이 게시 금지, 편집 → 승인 무효, 결과 불명 → 조회 또는 UNKNOWN·맹목 재전송 금지, 모의 성공 ≠ 실제 게시, 비밀은 서버만), docs/03(승인 스냅샷·중복·재시도·ChannelAdapter 계약·VERIFIED 정의), A08·A10·A11·A20, D24·D26·D30·D31·D36.
- External calls performed: **none**. 코드·시험 어디에서도 Threads/Meta 로 요청하지 않았다(어댑터 시험·통합 시험은 주입 fetch, 전역 fetch 는 막고 0회 확인 + setupFiles 네트워크 가드). 공식 문서 페이지만 읽기 전용으로 열람(WebFetch). `.env.local`·`./data` 열지 않음, db:migrate·drill:restore(둘 다 ./data 를 연다) 실행 안 함.

## 공식 문서 출처(2026-10-13 열람, 읽기 전용 — 페이지에 갱신일 표시 없음, 확인하지 못함)
| 문서 | 확인한 내용 | 코드 반영 |
|---|---|---|
| https://developers.facebook.com/docs/threads/posts | 텍스트 게시 = `POST https://graph.threads.net/v1.0/<THREADS_USER_ID>/threads`(media_type=TEXT, text) → `{id}`(컨테이너) → `POST …/<THREADS_USER_ID>/threads_publish`(creation_id) → `{id}`(미디어). "Text posts are limited to 500 characters", 이모지는 UTF-8 바이트 수로 센다. 게시 전 평균 30초 기다림 권장. 예시는 POST 의 access_token 을 **form 본문**에 둔다 | 컨테이너·게시 요청, 500·이모지 바이트 계산(`threadsTextUnits`), 기다림 대신 컨테이너 상태 FINISHED 확인 |
| https://developers.facebook.com/docs/threads/reference/publishing | `auto_publish_text`(컨테이너 생성 즉시 게시 — 텍스트만), reply_to_id·reply_control 등 선택 매개변수, threads_publish 의 creation_id. 응답 모양은 이 페이지에 없음. Authorization 헤더 언급 없음 | auto_publish_text·reply_to_id 를 **보내지 않는다**(컨테이너 생성이 게시를 만들지 않게 — 결과 불명 규칙의 전제) |
| https://developers.facebook.com/docs/threads/troubleshooting | 컨테이너 상태 `GET /{container-id}?fields=status,error_message` — EXPIRED·ERROR·FINISHED·IN_PROGRESS·PUBLISHED, 24시간 안에 게시하지 않으면 EXPIRED, 조회는 분당 1회·5분 이내 권장(영상 기준). PUBLISHED 에서 게시된 미디어 ID 를 주는 필드는 문서에 없음. `GET /{threads-user-id}/threads_publishing_limit`(quota_usage, config.quota_total 250·quota_duration 86400 예시) | 상태 판정, PUBLISHED 는 목록 대조로만 ID 를 찾음 |
| https://developers.facebook.com/docs/threads/threads-media | 목록 `GET /{threads-user-id}/threads`(fields·since·until·limit), 단일 `GET /{threads-media-id}`; 필드 id·permalink(저작권·신고 미디어는 생략)·text·timestamp("2023-10-17T05:42:03+0000")·media_type(TEXT_POST 등)·username·owner. **공개 범위·audience 필드 없음** | 읽기 확인·목록 대조, remote_visibility 'unknown' + 화면 "Threads 계정 공개 설정을 따름" |
| https://developers.facebook.com/docs/threads/overview | 게시 한도 24시간 이동 창 250 게시물(캐러셀 1), 답글 1,000, 호출 한도 4800 × 노출 수, 호스트 graph.threads.com·graph.threads.net 둘 다, v1.0. Authorization 헤더 언급 없음 | capabilities.rate_limit 250/24h(checked_at 2026-10-13, api v1.0, 출처 URL) |
- **Authorization: Bearer 헤더**: Threads 공식 문서에서 확인하지 못했다(제3자 글만). 보수적으로 **문서 예시대로** POST 는 form 본문, GET 은 질의 문자열에 access_token. 그래서 GET URL 에 토큰이 있을 수 있다 → URL·요청·응답 본문·공급자 문구를 기록·직렬화·오류에 넣지 않는다(LIVE-T1 규칙 그대로: https + 허용 호스트, `redirect:'error'`, 호출당 10초 + 작업 중단 신호, 원 오류 버림). 2단계 전에 헤더 방식을 공식으로 확인하면 바꿀 수 있다.
- 오류 코드 표(190 토큰·10·200~299 권한·100 형식·일시 1·2·4·17·32·341·613·80000~80014)는 LIVE-T1 과 같은 Graph 일반 규약 가정(Threads 문서에 같은 표 없음 — 미확인).

## Proposed D38 (DECISIONS.md 에 넣지 않음 — 오케스트레이터·사용자 확인용 초안)
1. **어댑터·선택**: `@cs/providers` `LiveThreadsPublishAdapter`(id `live_threads`, kind live). `adapterIdFor`: 실제 계정 + threads + credential_state ≠ none → `live_threads`(선택일 뿐 허용 아님). 레지스트리 `LiveCapableAdapterRegistry`/`createChannelAdapterRegistry(config)` 는 `livePublishReadiness(config)` 가 준비됐을 때만 실제 어댑터를 돌려주고(아니면 `LivePublishNotReadyError`), YouTube·Instagram·블로그·연결 전 Threads 실제 계정은 지금처럼 `LiveChannelNotConfiguredError`. web(`getChannelAdapters(config)`)·CLI worker 가 이 레지스트리를 쓴다.
2. **게이트(모두, 서버, fail closed)**: (a) PUBLISH_MODE=enabled (b) 새 env `PUBLISH_LIVE_APPROVAL_REF`(1~200자) (c) 새 env `PUBLISH_LIVE_MAX_POSTS`(1~1000, **없으면 막힘** — LLM_LIVE_MAX_RUNS 의 "없음=무제한"과 다름) (d) 계정 kind live + platform threads + 묶인 Threads 프로필 ID + state connected("실제 게시 계정으로 사용") + 쓸 수 있는 연결 정보(T13 credentialGate) (e) 서버 승인 스냅샷 hash 일치(기존 의미 그대로) (f) 스냅샷의 provider_account_id = 지금 계정의 Threads 프로필 ID(snapshotProblems + 실행 때 한 번 더 + 어댑터 validate). 검사 위치: `assertExecutionAllowed`(execute·beginSend), 레지스트리, 어댑터 submit/reconcile(두 번째 방어선).
3. **게시 수 상한**: 승인 기록별로 "그 기록으로 전송 의도를 하나라도 만든 작업 수"를 센다(재시도·이어 게시는 새 게시 아님). 전송 의도 `sanitized_details.live_approval_ref` 에 남기고(결과를 채운 뒤에도 보존), beginSend 가 `pg_advisory_xact_lock(hashtext('cs_live_publish:<ref>'))` 아래에서 센다 → 넘으면 보내지 않고 BLOCKED `live_publish_limit`. 실행(executePlan)은 앞선 검사(이미 쓴 수 + 대기 중 실제 작업(끝나지 않음·UNKNOWN 제외) + 이번 항목 > 상한 → 429, 전체 거부). owner 와 무관하게 센다.
4. **"실제 게시 계정으로 사용"**: D31 연결은 state disconnected 로 남는다(계획 불가). 새 route `POST /api/channel-accounts/{id}/publish-target {enabled}` — 실제 Threads·묶임·쓸 수 있는 연결 정보일 때만 connected, 사용 중지 = disconnected(그 계정 활성 승인 철회). 외부 호출 없음. 설정 화면 버튼.
5. **계획 규칙(실제 Threads)**: requested_result = public_publish 만(기본값), visibility = public 만(실제 공개 범위는 Threads 계정 설정 — API 에 게시물별 공개 범위 없음), 텍스트 1개(이어지는 글·답글 없음 — threads_manage_replies 를 요청하지 않았음), 첨부 없음, 500 단위(이모지 = UTF-8 바이트, 보수적).
6. **결과 불명 규칙**: 컨테이너 생성 실패는 게시물을 만들지 않으므로(auto_publish_text 미사용) 일시·제한·전송 실패 = 부작용 없는 재시도, 401/190 = BLOCKED, 권한·형식·모르는 4xx = 확정 실패. 게시 직전에 `publish_attempt`('threads:pa:<컨테이너>' — 컨테이너마다 하나, DB unique) 기록 → threads_publish. 시간 초과·전송 실패·5xx·429·모르는 오류·id 없는 2xx = 결과 불명(RECONCILING). 표식이 있으면 **어떤 경로로도 같은 컨테이너를 다시 게시하지 않는다**(재시도·재개 포함). 조회: 게시 기록 → found(읽기 확인), 표식 없음 + FINISHED → resumable(같은 컨테이너), IN_PROGRESS → processing, ERROR/EXPIRED → failed(게시물 없음 확정), 표식 있음 + 게시 기록 없음 → 최근 글 25개 중 "정확히 같은 본문(NFC·줄바꿈·앞뒤 공백만 정규화) + 시도 시각 −10분 ~ 지금 +10분" 이 **정확히 1개**일 때만 found, 아니면 unknown(3회 뒤 UNKNOWN — 사용자 안내). 401 뒤 자동 연결 확인(실제 /me 호출)은 하지 않는다(승인 범위 밖 호출을 늘리지 않음).
7. **결과 기록**: publications external_id `threads:<미디어 ID>`, permalink 는 https://(www.)threads.com|net 만 저장, verification = 게시 뒤 원격 읽기로 ID·본문·공식 링크가 확인되면 VERIFIED(+verified_at), 아니면 UNVERIFIED. remote_visibility 'unknown', result_kind PUBLISHED.
8. **요청 제한**: capabilities.rate_limit 250/24h(공식, 확인일 2026-10-13), 단위 = publish_attempt(결과 불명 시도도 원격 한도를 썼을 수 있으므로). threads_publishing_limit 사전 조회는 하지 않음(호출 수를 늘리지 않음 — 2단계 1건에는 불필요).
9. **check-env(운영)**: D37(배포 대기) 단계라 PUBLISH_LIVE_APPROVAL_REF·PUBLISH_LIVE_MAX_POSTS 는 운영 환경 파일에서 비어 있어야 한다(PUBLISH_MODE=disabled 기존 규칙 그대로).

## 설계 요약 — 변경 파일
- 새 파일
  - `packages/domain/src/live-publish.ts` — `LIVE_THREADS_ADAPTER_ID`, `threadsTextUnits`(500·이모지 바이트), ID·permalink 형식, `LIVE_THREADS_VISIBILITY_TEXT`, `LIVE_EXECUTE_NOTICE`, `LivePublishNotReadyError`(503)·`LivePublishLimitError`(429)
  - `packages/providers/src/threads-live-publish.ts` — 실제 어댑터, `classifyLivePublishError`, `LiveThreadsApiError`(숫자·열거만), 목록 대조
  - `packages/providers/src/threads-live-publish.test.ts`(54 시험)
  - `packages/db/src/live-publish.ts` — `liveApprovalUsage`·`pendingLiveJobs`·`setLivePublishTarget`·`LivePublishTargetError`
  - `packages/db/drizzle/0044_livep1_threads_live.sql` + `meta/0044_snapshot.json`(drizzle-kit 생성 + 손으로 추가한 INSERT 트리거 2개)
  - `apps/web/app/api/channel-accounts/[id]/publish-target/route.ts`
  - `tests/integration/live-threads-publish.test.ts`(11), `tests/integration/migration-0044.test.ts`(1)
- 수정
  - domain: `config.ts`(PUBLISH_LIVE_APPROVAL_REF·PUBLISH_LIVE_MAX_POSTS + 라벨), `guards.ts`(LIVE 모드·게이트 순서), `oauth.ts`(`livePublishReadiness` 실제 판정 — 의도한 동작 변경), `jobs.ts`(ADAPTER_IDS `live_threads`, adapterIdFor, REMOTE_STEP_KINDS `publish_attempt`, `AdapterResult/ReconcileResult.verified`, text unit 종류, scenarioApplies), `bundle.ts`(remote_steps 실제 ID·publish_attempt, publications 실제 형식·계정 kind 무결성), `index.ts`
  - providers: `channel-adapter.ts`(`LiveCapableAdapterRegistry`·`createChannelAdapterRegistry`), `index.ts`
  - db: `schema.ts`(CHECK 3개 추가·remote_id CHECK 교체), `jobs.ts`(LIVE 게이트·게시 수 잠금·전송 의도 ref·VERIFIED 기록·실제 계정 자동 연결 확인 생략·취소 시 게시 시도 표식 = UNKNOWN·재시도 문구), `distribution.ts`(계획 규칙·실행 LIVE·앞선 상한 검사·ExecuteResult mode), `oauth.ts`(health view notice·account_state·live_publish_target), `queries.ts`(감사 action), `index.ts`, `drizzle/meta/_journal.json`
  - web: `lib/server.ts`(getChannelAdapters(config)), `lib/stt.ts`, `api/worker/tick`, `api/distribution-items/[id]/reconcile`, `api/distribution-plans/[id]/execute`(주석), `lib/distribution.ts`(실제 게시 문구·패널·오류 문구), `lib/oauth.ts`(오류 문구), `app/distribute/[id]/page.tsx`(실제 게시 배지·계정·공개 범위·확인 상태·UNKNOWN 안내·실제 단계 패널·승인/실행 경고), `app/distribute/new/page.tsx`, `app/settings/page.tsx`(게시 준비·실제 게시 계정 사용 버튼)
  - worker: `apps/worker/src/cli.ts`(실제 가능 레지스트리), `apps/worker/src/index.ts`(tick 안내 문구)
  - env·deploy: `.env.example`, `deploy/content-studio.env.example`, `deploy/scripts/check-env.sh`, `deploy/scripts/tests/test-check-env.sh`
  - 문서: `docs/04_DATA_AND_API.md`(API 표 1줄)
  - 시험(의도한 동작 변경에 맞춘 갱신 — 단언 완화 아님): `tests/integration/m3-hardening.test.ts`(실제 계정 고정 데이터를 Threads → 블로그 — 단언 그대로), `packages/domain/src/oauth.test.ts`(게시 준비 판정), `packages/domain/src/jobs.test.ts`·`apps/web/lib/distribution.test.ts`·`packages/providers/src/threads-mock.test.ts`(`live_threads` 가 이제 아는 어댑터 — "모르는 값" 예시를 `live_youtube` 로 바꾸고 live_threads 기대값 추가), `packages/domain/src/guards.test.ts`(게이트 시험 추가)

## Migrations / restore implications
- `0044_livep1_threads_live`: remote_steps `remote_steps_mock_id_chk` → `remote_steps_remote_id_chk`(모의 ID 또는 `threads:ct|pa|post:<숫자>`, publish_attempt 는 실제 형식만), kind/kind_status 에 publish_attempt(created). publications `publications_real_external_chk`(실제 = `threads:<숫자>`)·`publications_real_permalink_chk`(https://(www.)threads.com|net/)·`publications_verified_at_chk`. 트리거 `remote_steps_account_guard`(실제 ID ⇔ 실제 Threads 계정 작업, 모의 ID ⇔ 모의 계정)·`publications_account_guard`(is_mock ⇔ 계정 kind mock, 실제 결과는 Threads 만). 기존 모의 행은 그대로 통과(migration-0044 시험이 0043 상태 행 위에 적용).
- 내보내기·복원: 새 열 없음. 묶음 스키마·무결성이 실제 단계 ID·publish_attempt·실제 결과를 받고 계정 kind 일치를 검사한다. 복원 경로는 기존 그대로(remote_steps·publications 읽기 전용 이력, 복원 작업의 not_found 는 unknown — 실제 어댑터도 usesRemoteSteps). 복원 훈련(runRestoreDrill)이 실제 결과가 있는 owner 로 PASS.
- **운영 DB(./data)에는 아직 적용하지 않았다** — 오케스트레이터가 dev 서버를 끈 뒤 `pnpm db:migrate` 를 실행해야 0044 가 들어간다.

## 실행한 명령과 결과(Windows 10, Git Bash, `export PATH="/usr/bin:/mingw64/bin:$PATH"; source tools/env.sh`, Node 24.21.0, `corepack pnpm`, dev 서버 꺼짐)
`.handoffs/run-checks.sh` 는 db:migrate·drill:restore(둘 다 ./data 를 연다)를 포함하므로 쓰지 않고, 그 둘만 뺀 같은 순서의 스크립트(scratchpad `checks.sh` → `.handoffs/checks-LIVEP1*.log`)를 돌렸다.
| 명령 | 결과 |
|---|---|
| `corepack pnpm exec drizzle-kit generate --name livep1_threads_live`(packages/db — schema.ts 만 읽음, DB 연결 없음) | 0044 SQL·snapshot·journal 생성 → 트리거 2개 손으로 추가 |
| `vitest run --project unit packages/providers/src/threads-live-publish.test.ts` | 1회차 FAIL 2(시험의 메모리 단계 시각이 실제 시계 — 시험 수정), 2회차 FAIL 1(시험이 POST 컨테이너 요청을 목록 GET 으로 잘못 찾음 — 시험 수정), 3회차 PASS 54/54 |
| `vitest run --project unit`(전체, 1회차) | FAIL 5 — 모두 의도한 동작 변경(`live_threads` 가 아는 어댑터가 됨·게시 준비 판정) → 시험 기대값 갱신 후 관련 43 파일 977 PASS |
| `vitest run --project integration tests/integration/live-threads-publish.test.ts` | PASS 11/11 |
| `vitest run --project integration tests/integration/migration-0044.test.ts` | 1회차 FAIL(시험 SQL 매개변수 타입 $2 uuid/text) → 수정 후 PASS 1/1 |
| `bash -n` deploy/scripts 전체 · `bash deploy/scripts/tests/test-check-env.sh` | PASS · 54 passed, 0 failed |
| `bash deploy/scripts/tests/run-all.sh` | 5분 넘게 끝나지 않아 중단(위 위험 2) |
| `corepack pnpm lint`(1회차) | FAIL 4 — 이모지 문자 클래스(no-misleading-character-class)·쓰지 않는 대입 → 수정 |
| 전체 checks(마지막): `lint` · `typecheck` · `build` · `test`(unit) · `test:integration` · `drill:mock` | LINT=0 · TYPECHECK=0 · BUILD=0 · UNIT=0(67 files, 1612 tests) · INTEG=1(47 files, 889/890 — `m3-hardening.test.ts` 의 "실제 계정 항목 not_mock_account" 시험이 실제 Threads 계정에 upload_private·여러 문단을 계획 → 새 계획 규칙(D38-5)과 충돌) · DRILL=0("불변식 위반 0건") |
| `m3-hardening.test.ts` 고정 데이터 수정(실제 Threads → 실제 블로그 계정, 요지 "실제 계정 항목에는 모의 시나리오 없음 → 400 not_mock_account" 그대로) 뒤 단독 | PASS 19/19 |
| `corepack pnpm test:integration`(전체 재실행) + 바꾼 시험 3개 eslint | PASS — 47 files, 890 tests · eslint 0 |
| `corepack pnpm db:migrate` · `corepack pnpm drill:restore` | **not_run**(./data 를 연다 — 작업 지시). 대신 통합 시험의 runRestoreDrill(메모리 DB)이 실제 결과 포함 PASS |
- 주의(운영): 처음에 두 번의 checks 실행이 겹쳐(중지한 실행의 하위 프로세스가 남음) build 가 한 번 실패했고, 정리하려고 `taskkill //F //IM node.exe` 로 **이 사용자 계정의 node.exe 프로세스를 모두 종료**했다(dev 서버는 켜져 있지 않다는 전제였지만, 다른 node 프로세스가 있었다면 함께 종료됨). 그 뒤 깨끗한 한 번의 실행이 위 결과다.

## Demo route / local start steps (2단계 승인 뒤 — 지금은 하지 않음)
1. 설정 → 배포 계정 연결: 실제 Threads 계정(D31 연결됨, @yongho.tho)의 "실제 게시 계정으로 사용".
2. `.env.local`(사용자가 직접): `PUBLISH_MODE=enabled`, `PUBLISH_LIVE_APPROVAL_REF=<승인 기록>`, `PUBLISH_LIVE_MAX_POSTS=1`. dev 서버 재시작 → 설정 화면 "실제 게시 준비됨".
3. 원고 → threads 초안(텍스트 1개·500자 이하) 검토 → 배포 계획(실제 계정) → 항목 카드의 실제 게시 경고 확인 → 승인 → 실행 → "작업 처리 실행(1회 — 실제 게시 항목은 실제로 게시)".
4. 끝나면 `PUBLISH_LIVE_APPROVAL_REF` 제거(또는 PUBLISH_MODE=disabled)로 잠금. UNKNOWN 이면 Threads 에서 직접 확인(자동 재게시 없음).

## Mock-only functionality
- 실제 어댑터의 모든 원격 응답은 fixture(주입 fetch). 실제 Threads 동작(오류 본문 모양·컨테이너 처리 시간·목록 정렬/시각 형식·permalink 호스트)은 미관찰.

## Known risks / not run
1. **db:migrate·drill:restore 미실행**(./data 를 연다 — 작업 지시). `.handoffs/run-checks.sh` 대신 이 두 단계를 뺀 같은 순서의 스크립트를 돌렸다.
2. `deploy/scripts/tests/run-all.sh` 전체는 5분 넘게 끝나지 않아 중단(이 작업이 바꾸지 않은 다른 시험 파일에서 멈춘 것으로 보임 — 원인 미확인). 바꾼 스크립트는 `bash -n` 전부 통과, `test-check-env.sh` 단독 54/54 PASS.
3. Bearer 헤더 미확인 → GET 질의에 토큰(문서 방식). 로그·오류에는 URL 을 남기지 않지만, 중간 프록시·Threads 쪽 로그에는 남을 수 있다.
4. 목록 대조는 최근 25개·정확한 본문 일치만 — Threads 가 본문을 바꿔 돌려주면(링크 축약 등) 실제 게시도 UNKNOWN 으로 남는다(보수적, 사용자 확인). 같은 본문을 짧은 시간에 두 번 올렸으면 구분 불가 → UNKNOWN.
5. 게시 시도 표식 뒤 **확정 거절**(400 코드 100, 401/190)도 같은 컨테이너로 다시 게시하지 않는다 — 재연결 뒤 재시도는 조회(목록 대조)만 하고 결과 불명이면 UNKNOWN → 새 계획 필요. 429 도 쓰기 단계라 결과 불명 처리(LIVE-T1 FIX4 원칙).
6. 표식 기록 직후·fetch 직전에 중단(lease 상실·시간 초과)되면 실제로는 보내지 않았어도 UNKNOWN 이 될 수 있다(보수적).
7. 게시 수 상한은 PGlite 한 연결에서만 확인 — 실제 PostgreSQL 병렬 잠금은 관찰하지 않음(advisory 잠금 사용).
8. `pendingLiveJobs`(실행 앞선 검사)는 다른 승인 기록으로 보낸 진행 중 작업도 "대기"로 센다(보수적) — 권위 있는 검사는 beginSend.
9. 이모지 계산은 보수적 근사(코드 포인트 단위 + 변형 선택자·ZWJ·국기·피부색·태그 바이트 가산). Threads 의 실제 계산과 다르면 우리 쪽이 더 엄격.
10. 장기 토큰 자동 갱신은 여전히 꺼져 있음(D31) — 2026-12-12 만료 전 재연결 필요.
11. 화면은 서버 렌더링 코드만 바꾸고 브라우저로 보지 않았다(dev 서버 금지). 문구는 lib 단위·통합 시험으로만 확인.

## Questions specifically for Codex
1. 게시 시도 표식(publish_attempt, 컨테이너마다 하나·DB unique) + "표식 있으면 어떤 경로로도 재게시 없음" + 목록 대조 정확히 1개만 found 가 A08/A20·"unknown → reconcile or UNKNOWN" 을 닫는가? 표식 없음 + FINISHED → resumable 판정에 구멍(예: 표식 기록 전 다른 프로세스가 게시)이 있는가?
2. 컨테이너 생성 실패(시간 초과·5xx 포함)를 "부작용 없음"으로 재시도하는 근거(auto_publish_text 미사용 → 컨테이너는 게시물이 아님)가 충분한가?
3. 게시 수 상한을 "작업 단위·전송 의도 기준·승인 기록별 advisory 잠금"으로 센 것과 실행 앞선 검사의 보수적 pending 계산이 적절한가?
4. VERIFIED 조건(게시 뒤 GET 으로 id·본문·공식 permalink 확인, 목록 대조 found 는 공식 permalink 가 있을 때)이 docs/03 의 VERIFIED 정의에 맞는가?
5. "실제 게시 계정으로 사용"(state connected) 토글을 새 route 로 둔 것과, 연결 확인·health 와의 경쟁(사용 확인 트랜잭션과 상태 변경 트랜잭션이 분리됨 — 실행·전송 게이트가 다시 막음)이 받아들일 만한가?
6. GET 질의 토큰(문서 방식)을 유지한 판단 — Bearer 헤더로 바꿔야 하는가(공식 근거 없음)?

## Next authorized task
- D38 2단계(실제 1건 게시)는 **별도 정확 범위 승인** 필요: 계정(@yongho.tho), 원고(가상/공개 소재 1건, 500자 이하 텍스트), 공개 범위(계정 설정), 호출 종류(컨테이너 생성·상태·게시·읽기, 결과 불명 시 목록 1회 이상), PUBLISH_LIVE_APPROVAL_REF 값, PUBLISH_LIVE_MAX_POSTS=1, 끝난 뒤 잠금 방법. 그 전에 오케스트레이터가 커밋·Codex 검증·`pnpm db:migrate`(dev 서버 끈 상태).

---

# FIX-LIVEP1 (Codex review-LIVEP1 — CHANGES_REQUESTED on 320dadb, gpt-6-astra/xhigh)
- 판정 원본: `.handoffs/review-LIVEP1.md`
- BASE_SHA: 320dadb · HEAD_SHA: uncommitted — orchestrator commits
- 범위: 실제 Threads·Meta 요청 0(주입 fetch·전역 fetch stub 만), `.env.local`·`./data` 손대지 않음, db:migrate·drill:restore·dev 서버 실행 안 함, 새 의존성 없음, migration 추가 없음.

## 지적 → 시험(재현) → 변경
| 지적 | 재현(수정 전 코드로 먼저 실패 확인) | 변경 |
|---|---|---|
| **[P0] threads-live-publish.ts:504** 본문·시각만 맞는 글을 이 작업의 VERIFIED 결과로 확정 | 단위 `threads-live-publish.test.ts` 새 시험 3개 + 표 4행 — 수정 전 실행 9 실패(`.handoffs/checks-FIX-LIVEP1.repro-unit.log`): ① 같은 본문 1개 → 이전엔 `found`·`publish` 단계·`verified:true` ② **Codex 재현: 시도 5분 전 손으로 올린 같은 글** → 이전엔 found(창 −10분) ③ **Codex 재현: 첫 25개 안에 하나 + 다음 쪽 가능(받은 수 = limit)** → 이전엔 found. 통합: 시간 초과 시험이 이전엔 CONFIRMED·VERIFIED publication | 게시 시도 표식이 있고 게시 기록이 없으면 조회는 **항상 unknown** — `publish` 단계·external_id·permalink·VERIFIED 를 만들지 않는다(재게시도 없음 → 3회 뒤 UNKNOWN). 목록은 **확인 후보**만: 같은 본문(정규화)·시도 시각 ±2분(10분 → 2분으로 좁힘)·정확히 1개·목록이 한 쪽에 다 들어옴(받은 수 < limit)일 때만 `candidate {external_id, permalink}` 를 돌려주고, 작업 처리기는 이력(`candidate_external_id`·`candidate_permalink` — 형식 검사 뒤)에만 남긴다. 화면: UNKNOWN 안내 + `미확인` 배지 "확인 후보(미확인 — 이 작업의 게시물이라는 증거 없음, 같은 글을 따로 올렸을 수도 있음)" + 공식 링크, "이 앱은 이 글을 게시 결과로 기록하지 않았습니다". 확정은 threads_publish 가 돌려준 미디어 ID(결정적 연결)뿐 |
| **[P1] reconcile/route.ts:32** 수동 재확인에 실제 계정 연결 정보 전달 누락 | 통합 새 시험: **실제 POST route handler** 로 UNKNOWN 항목 재확인(앱 레지스트리 → 실제 어댑터 → 전역 fetch stub fixture). 수정 전 route 로도 통과함을 확인(`.handoffs/checks-FIX-LIVEP1.repro-route.log` — 15/15): `reconcileItem` → `makeContext` 가 `credentials` 가 없어도 `process.env` 키 묶음으로 서버 안 봉인 해제 창구를 만든다(지적의 "기본 주입 여부 미확인" → 기본 주입 있음으로 확인). | 그래도 작업 처리기와 같게 route 에서 `credentials: jobCredentials(config, owner.db)` 를 명시 전달. 시험이 GET 목록 요청의 access_token = 봉인 해제한 장기 토큰(서버 안), 응답 200 `{state: UNKNOWN, found: false, remote: unknown, outcome: applied}`, 결과·게시 0, 응답·이력에 토큰 없음을 확인 |
| **[P1] distribute/[id]/page.tsx:732** 버튼 안내가 현재 계획만 보고 "외부 호출 없음" | 통합 새 시험: 다른 계획에 실제 게시 작업(QUEUED, 게이트 열림) + 모의 계획 → 모의 계획 화면 폼(`plan_id`)으로 tick. 수정 전(범위 없음)으로 돌리면 실패(`.handoffs/checks-FIX-LIVEP1.repro-tickscope.log`) | 버튼의 서버 실행 범위를 **그 계획으로 제한**: `tickSchema.plan_id`, 폼이 보낸 `plan_id` → `runJobsTick({planId})` → `leaseJobs` 가 그 계획 항목의 작업만 lease(만료 복구는 그대로 — 외부 호출 없음). JSON 호출은 plan_id 없으면 기존 동작. 화면 안내 "이 계획의 작업만, 최대 5개 … 다른 계획의 작업은 처리하지 않음". 시험: 모의 계획 CONFIRMED, 다른 계획 실제 작업 QUEUED 그대로, 전역 fetch 0 |
| 답 5: publish-target 확인·변경 분리 | 통합 새 시험: 사용 중지 → 연결 정보 만료 → 사용 → 409 `live_target_credential_unusable`, 상태 disconnected 그대로 | `setChannelAccountStateTx`(호출자 트랜잭션) 분리, `setLivePublishTarget` 이 **한 트랜잭션**에서 계정 FOR UPDATE → 묶임·연결 정보 확인 → 상태 변경·승인 철회 → 감사 |
| 놓친 케이스: 큰 스트리밍 응답 | 단위 새 시험: 64 KiB 조각을 끝없이 내는 스트림 → 수정 전엔 전부 읽음(실패), content-length 10 MiB | `readCapped`: 조각으로 읽으며 512 KiB(바이트) 넘으면 `reader.cancel()` 후 `body_too_large`, content-length 가 상한보다 크면 읽지 않고 취소. 시험: cancel 호출·읽은 조각 < 20·컨테이너 생성은 부작용 없는 실패 |
| 놓친 케이스: 동시 실행 | 단위 새 시험(같은 단계 저장소로 submit 두 개 동시) — 수정 전 threads_publish 2번(실패) | `RemoteStepsPort.record({createOnly})` + `recordRemoteStep(createOnly)`: 이미 있으면 기존 행을 돌려주지 않고 409 `remote_step_exists`. 게시 시도 표식은 createOnly — 새로 만든 실행만 게시, 늦은 쪽은 `publish_attempt_exists`(결과 불명, 재게시 없음). DB 에서는 (작업·순서·종류) unique 가 동시 INSERT 를 막는다. 통합 새 시험 2개(PGlite 한 연결): 같은 작업을 두 작업 처리기가 동시에 → publish 1번; `PUBLISH_LIVE_MAX_POSTS=1` 두 작업을 두 작업 처리기가 동시에 → publish 1번·나머지 BLOCKED `live_publish_limit`(전송 의도 0). **실제 PostgreSQL 독립 연결 동시성은 미검증** |
| 답 6: GET 질의 토큰 | — | 그대로 둔다(Bearer 공식 근거 없음). 확인한 사실: 우리 코드는 요청 URL·본문을 어디에도 기록하지 않는다(오류는 숫자·열거만, `console` 출력 없음 — 시험이 console spy 로 확인). Next 설정에 `logging.fetches` 가 없어 서버 fetch 로그를 쓰지 않고, `logging.incomingRequests` 는 들어오는 요청만(콜백 경로 제외). Next 16 의 fetch 는 기본 캐시하지 않는다(no-store 기본) — 다만 Next 내부 동작·APM·프록시·Threads 쪽 로그는 이 저장소에서 확인할 수 없다(미검증, 2단계 전 운영 경로 확인 필요) |

## 바뀐 파일(FIX-LIVEP1)
- `packages/providers/src/threads-live-publish.ts` — 목록 대조 = 확인 후보만(항상 unknown), 창 ±2분·목록 불완전 시 후보 없음, `createOnly` 게시 시도 표식·`publish_attempt_exists`, `readCapped`(스트리밍 바이트 상한·취소), `MAX_RESPONSE_BYTES` export
- `packages/domain/src/jobs.ts` — `RemoteStepsPort.record.createOnly`, `ReconcileResult.candidate`, `tickSchema.plan_id`
- `packages/db/src/remote-steps.ts` — `createOnly`(409 remote_step_exists)
- `packages/db/src/jobs.ts` — 후보를 이력에만(`candidate_external_id`·`candidate_permalink`), `JobRunOptions.planId`·`leaseJobs` 계획 범위
- `packages/db/src/distribution.ts` — `setChannelAccountStateTx` 분리
- `packages/db/src/live-publish.ts` — 사용 확인·상태 변경 한 트랜잭션
- `apps/web/app/api/distribution-items/[id]/reconcile/route.ts` — `credentials: jobCredentials(config, owner.db)`
- `apps/web/app/api/worker/tick/route.ts` — 폼·JSON `plan_id` 범위
- `apps/web/app/distribute/[id]/page.tsx` — 확인 후보(미확인) 표시, 버튼 안내 "이 계획의 작업만"
- `apps/web/lib/distribution.ts` — `liveCandidateFromEvents`·`LIVE_CANDIDATE_LABEL`
- 시험: `packages/providers/src/threads-live-publish.test.ts`(+5 시험, 표 4행 기대값을 새 규칙으로 — found → unknown), `tests/integration/live-threads-publish.test.ts`(시간 초과 시험을 "확인 후보 + UNKNOWN + 실제 재확인 route"로 바꿈, +4 시험)
- 손대지 않음: DECISIONS·다른 인계·`.env.local`·`./data`. migration 추가 없음(0044 그대로).

## 실행한 명령(FIX-LIVEP1)
(Windows 10, Git Bash, `export PATH="/usr/bin:/mingw64/bin:$PATH"; source tools/env.sh`, Node 24.21.0, `corepack pnpm`, dev 서버 꺼짐. ./data 를 여는 db:migrate·drill:restore 는 뺀 같은 순서 — 로그 `.handoffs/checks-FIX-LIVEP1*.log`)
| 명령 | 결과 |
|---|---|
| `vitest run --project unit packages/providers/src/threads-live-publish.test.ts`(새 시험 + **수정 전 어댑터**) | FAIL 9/58 — P0 3·표 4·동시 submit 1·스트리밍 1(`checks-FIX-LIVEP1.repro-unit.log`) — 재현 |
| 같은 파일(수정 뒤) | PASS 58/58 |
| `vitest run --project integration tests/integration/live-threads-publish.test.ts`(tick route 의 planId 만 임시로 뺌) | FAIL 1/15 — 계획 범위 시험(`checks-FIX-LIVEP1.repro-tickscope.log`) — 재현, 되돌림 |
| 같은 파일(reconcile route 의 credentials 만 임시로 뺌) | PASS 15/15(`checks-FIX-LIVEP1.repro-route.log`) — route 는 이미 기본 키 묶음으로 동작(지적은 실제 결함 아님, 명시 전달은 일관성용), 되돌림 |
| 같은 파일(수정 뒤, 실행 앞선 검사 상한 1회 조정 — 다른 계획의 진행 중 작업을 보수적으로 세기 때문) | PASS 15/15 |
| `corepack pnpm lint` · `typecheck` · `build` | PASS · PASS · PASS |
| `corepack pnpm test`(unit) | PASS — 67 files, 1616 tests |
| `corepack pnpm test:integration` | PASS — 47 files, 894 tests(워커 충돌 없음 — --maxWorkers=2 재실행 불필요) |
| `corepack pnpm drill:mock` | PASS — "불변식 위반 0건" |
| `db:migrate` · `drill:restore` | not_run(./data 금지) |
- 이 라운드에서는 내가 띄운 프로세스만 다뤘다(전체 node 종료 명령 없음).

## 남은 위험(FIX-LIVEP1 기준)
1. 결과 불명 실제 게시는 이제 **항상** UNKNOWN 으로 끝난다(목록에 진짜 우리 글이 있어도) — 사용자가 Threads 에서 확인해야 한다. 컨테이너 ID ↔ 미디어 ID 를 잇는 공식 필드가 없어서다(문서 확인 2026-10-13). 2단계 실제 응답에서 컨테이너 GET 이 미디어 ID 를 주는지 확인되면 결정적 확인으로 바꿀 수 있다.
2. 확인 후보 창 ±2분은 시계 차이가 크면 진짜 글을 후보로도 못 보일 수 있다(확정에는 영향 없음).
3. 실제 PostgreSQL 독립 연결의 동시성(게시 수 잠금·createOnly unique)은 PGlite 한 연결로만 확인 — 미검증.
4. GET 질의 토큰: Next 내부·APM·프록시·Threads 쪽 기록은 미검증.
5. 그 밖의 1차 위험(run-all.sh 중단 원인 미확인, 화면 브라우저 미확인, 장기 토큰 자동 갱신 꺼짐) 그대로.

## Codex 에게 묻는 것(FIX-LIVEP1)
1. "게시 시도 표식 뒤 확정은 threads_publish 응답의 미디어 ID 뿐, 목록은 이력의 확인 후보만"이 P0 를 닫는가? 후보를 이력(job_events)에 남기는 것 자체가 사용자 오해를 만들 위험은 화면 문구(미확인 배지·"게시 결과로 기록하지 않았습니다")로 충분한가?
2. 계획 범위 tick(`plan_id`)이 버튼 경로만 좁히고, 주기 타이머·전사 목록 조회의 inline tick 은 owner 전체를 처리하는 것(그 경로들은 화면 안내 문구가 없음)이 받아들일 만한가?
3. `createOnly` 를 게시 시도 표식에만 쓰고 컨테이너 기록은 기존 규칙(같은 remote_id 면 기존 행)으로 둔 것 — 두 실행이 같은 컨테이너 ID 를 받는 경우(원격이 같은 ID 를 줄 때)에도 게시는 표식 하나로 막히므로 충분한가?
