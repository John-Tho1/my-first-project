# M4-DEV1 구현 인계 — 개발 서버 재시작 뒤 모의 OAuth 연결 유지

- 작업: M4-DEV1(개발 품질). 화면 확인(docs/handoffs/screen-notes-m4.md "참고")에서 본 증상 — dev 서버를 다시 켜면 모의 연결 계정의 다음 전송·갱신이 401 / `credential_refresh_failed` 로 실패하고 손으로 다시 연결해야 함 — 을 없앤다.
- BASE: `f7d3b37` · HEAD_SHA: 0d9911b (code only, D28; orchestrator reran lint·typecheck·build·unit 829·integration 636·drill:mock 0·real-DB drill:restore PASS)(커밋하지 않음 — 오케스트레이터가 커밋)
- 브랜치: `content-studio/m4`. migration 없음(0038 미사용). 새 의존성·네트워크 없음.

## 무엇을 바꿨나
| 파일 | 변경 |
| --- | --- |
| `packages/providers/src/oauth.ts` | `MockOAuthStore.registerRehydrated(entry)`(모의 ID·접두·refresh 모양 검사, 이미 아는 토큰은 건드리지 않음 — 철회 상태 유지, Google 형은 access·refresh 를 새 grant 묶음으로), `store.rehydration` 표식(`reset()` 이 함께 지움), `ensureMockOAuthRehydrated({ oauthMode, load, store })`(mock 아닐 때 load 안 부름·표식 없음, 프로세스당 한 번·동시 호출 같은 Promise, load 실패 시 표식 지우고 `{status:'failed'}`), `resetMockOAuthRehydration()`(시험용), `MOCK_OAUTH_PROVIDER_IDS`. 결과는 개수만. |
| `packages/db/src/oauth.ts` | `loadMockCredentialsForRehydration(db, { keyring, now })` — **읽기 전용**. `is_mock`·provider ∈ mock_*·`status='active'`·`revoked_at null`·계정 kind mock, health(정리 대기 표시는 빼고 판정)가 usable(연결됨·곧 만료)인 행만. 봉인을 열 수 없으면 건너뜀(쓰기 없음). `oauth_pending_tokens` 는 읽지 않음. |
| `apps/web/lib/oauth.ts` | `ensureMockOAuthReady(config, db, env)` — `OAUTH_MODE=mock` + 마스터 키 있을 때만 위 둘을 연결. |
| `apps/web/app/api/channel-accounts/[id]/{check,refresh,revoke}/route.ts`, `apps/web/app/api/oauth/callback/route.ts`, `apps/web/app/api/worker/tick/route.ts`, `apps/web/lib/stt.ts`(inline worker — 만료 임박 갱신 전) | 공급자·작업 처리기 연결 정보 경로 직전에 `await ensureMockOAuthReady(...)`. |
| `apps/worker/src/cli.ts` | 매 tick 전 `ensureMockOAuthRehydrated`(첫 번만 실제로 읽음). 출력 변화 없음. |
| `README_KO.md` | T13 절에 "dev 서버 재시작 뒤 모의 연결 유지(M4-DEV1)" — 연결은 유지, 시뮬레이터 원격 기록은 복원 안 됨(재시작 → UNKNOWN 유지). T14 절의 별도 worker 문단 갱신. |
| `packages/providers/src/oauth.test.ts` | 단위 4개 추가. |
| `tests/integration/mock-oauth-rehydrate.test.ts`(신규) | 통합 8개. |

바꾸지 않은 것: 채널 시뮬레이터(Threads·YouTube·Instagram)의 원격 기록, reconcile route(`/api/distribution-items/{id}/reconcile` — credentials 옵션을 쓰지 않음, 원격 기록이 없어 어차피 UNKNOWN), drill 스크립트, DECISIONS·M4_STATUS·M4_CODEX_VERDICTS·기존 인계 문서.

## 변경 → 시험
| 변경 | 시험 |
| --- | --- |
| 재시작 뒤 첫 작업 처리(route)가 다시 채움 → Threads 새 계획 CONFIRMED, YouTube 비공개 업로드 CONFIRMED, Instagram 단일 이미지 CONFIRMED, 세 계정 연결 확인 connected | 통합 "Threads·YouTube·Instagram 모의 연결 → 재시작 …"(다시 채우기 전 토큰 확인 false 재현, 다른 사용자로는 여전히 거부, 감사에 rehydrate 행 없음) |
| 첫 사용이 갱신 route 여도 다시 채운 뒤 갱신 성공(세 공급자, 세대 +1), 이전 토큰은 공급자 규칙대로 무효 | 통합 "다시 재시작 → 첫 사용이 연결 갱신 …" |
| 재시작 전 RECONCILING 작업 → 연결은 다시 채워져도 원격 기록 없음 → UNKNOWN, 의도 1·컨테이너·게시 호출 0 | 통합 "재시작 전 결과 불명 작업 …" + 기존 threads/youtube/instagram/m3-gate 재시작 행 + `drill:mock` 재시작 행 그대로 |
| 해제·오류·scope 부족·다른 키 봉인 행 미등록, 행·감사 불변, 열 수 없는 행은 다음 확인에서 기존대로 409·`decrypt_*`; 정리 대기 토큰 미등록(계정 현재 토큰은 등록, 계정은 계속 차단) | 통합 "해제·오류·scope 부족 …" |
| 멱등·프로세스당 한 번·표식만 지우고 다시 불러도 철회된 토큰 되살리지 않음 | 통합 "멱등 …", 단위 "ensure: …", "모의 아닌 공급자·접두 불일치 …" |
| OAUTH_MODE=live·키 없음 → 아무것도 안 함(load 미호출·표식 없음) | 통합 "OAUTH_MODE=live·마스터 키 없음 …", 단위 "ensure: …" |
| 실제 공급자(`threads`) 행은 DB 읽기 단계에서 제외 | 통합 "실제(live) 공급자 행은 읽지 않는다 …" |
| 공급자 규칙대로 쓰임(Threads 갱신 = 이전 무효, Google 묶음 회전·짧은 access 만료) | 단위 2개 |
| 비밀 유출 없음 | 통합 "콘솔·감사·응답에 토큰 없음"(연 토큰 전부 + `mock(thr|yt|ig)_(at|rt)_` 모양) |

음성 대조: `ensureMockOAuthReady` 를 항상 null 로 바꾸면 신규 통합 8개 중 6개 실패를 확인하고 되돌렸다(나머지 2개는 DB 읽기 단계·유출 검사).

## 실행한 명령과 결과(Windows 10, Git Bash, `source tools/env.sh`, Node 24.21.0, dev 서버 꺼짐)
| 명령 | 결과 |
| --- | --- |
| `corepack pnpm lint` | pass(exit 0) |
| `corepack pnpm typecheck` | pass(exit 0) |
| `corepack pnpm build` | pass(exit 0) |
| `corepack pnpm test` | pass — 42 files, 829 tests |
| `corepack pnpm test:integration`(단독) | pass — 33 files, 636 tests(376 s) |
| `corepack pnpm drill:mock` | pass(exit 0) — "불변식 위반 0건", 재시작 행 4개(M3·Threads·YouTube·Instagram) 이전과 같음 |
| `corepack pnpm test:e2e` | not_run(요청 범위 밖) |

## 남은 위험
1. 다시 채우기는 DB 를 그대로 믿는다: 모의 공급자 쪽에서 재시작 전에 철회됐지만 DB 에 반영되지 않은 토큰(예: 철회 후 기록 전 프로세스 종료)은 다시 유효가 된다. 모의 전용이고 실제 공급자에는 해당 없음.
2. 다시 채우기와 같은 프로세스의 동시 연결 변경: 모든 경로가 먼저 `await` 하므로 같은 프로세스 안에서는 순서가 보장되지만, 다시 채우기가 읽은 뒤 다른 프로세스(별도 worker)가 갱신하면 옛 토큰이 그 프로세스 메모리에 유효로 남을 수 있다(PGlite 는 한 프로세스만 열어 현재 구성에서는 발생하지 않음).
3. 표식은 프로세스당 한 번: 서버가 켜진 뒤 처음 경로를 쓸 때 키가 없었다면 표식 없이 넘어가고 다음 호출에 다시 시도한다. 반대로 성공한 뒤 DB 를 밖에서 바꾸면(복원 등) 다시 읽지 않는다 — 복원된 계정은 연결 정보가 없으므로 영향 없음.
4. reconcile route 는 다시 채우지 않는다(다른 경로에서 이미 채웠으면 무관). 재시작 직후 첫 동작이 수동 재확인이면 토큰 확인이 실패하지만 원격 기록도 없어 결과는 이전과 같은 확인 불가.
5. 정리 대기 계정의 **현재** 토큰은 등록한다(아래 Q1) — 계정 실행 차단은 health 가 그대로 한다.

## Codex 에 묻는 3가지
1. 정리 대기(`oauth_pending_tokens`)가 있는 계정의 **현재** 연결 정보 토큰은 health 판정에서 정리 대기를 빼고 usable 이면 등록한다(정리 대기 토큰 자체는 읽지도 등록하지도 않음). 재시작 전 공급자 상태를 그대로 흉내 내려는 선택인데, 정리 대기 해소 판정(verify_current·cleanup_revoke)이나 차단 불변식을 약하게 만드는 경로가 있는가?
2. 다시 채우기 표식을 `MockOAuthStore` 인스턴스(globalThis 싱글턴)에 두고 load 실패 시에만 지운다. 키 없음·live 모드는 표식을 남기지 않는다. web 경로(check·refresh·revoke·callback·worker tick·inline worker)와 worker CLI 에 호출을 넣었고 reconcile route·connect·모의 동의 화면에는 넣지 않았다 — 빠진 공급자 호출 경로가 있는가?
3. `registerRehydrated` 는 Threads 토큰에도 `provider: 'mock_threads'`·`kind: 'access'` 를 붙이고(T13 발급분은 둘 다 없음), Google 형은 새 grant 로 access·refresh 를 묶는다. 이미 아는 토큰은 덮지 않는다. 기존 모의 공급자·시뮬레이터의 토큰 판정(`live()`·`mock*TokenCheck`)과 어긋나는 경우가 있는가?

---

## FIX round 1 (Codex review-M4DEV1)
- Orchestrator: HEAD_SHA b3041c0 (code only, D28) — reran lint·typecheck·build·unit 830·integration 644·drill:mock 0·real-DB drill:restore PASS.

- 대상 판정: `.handoffs/review-M4DEV1.md`(CHANGES_REQUESTED, BASE `f7d3b37` · HEAD `0d9911b`) — P1 2건 + 놓친 케이스.
- BASE: `558f0aa`(현재 HEAD) · HEAD_SHA: TBD(커밋하지 않음 — 오케스트레이터가 커밋). 브랜치 `content-studio/m4`. migration 없음. 새 의존성·네트워크 없음.

### 지적 → 변경 → 시험
| 지적 | 변경 | 시험 |
| --- | --- | --- |
| [P1] check/route.ts:25 — 다시 채우기 실패를 무시하고 진행 → 빈 모의 공급자가 토큰을 "알 수 없음"으로 판정 → 연결 정보가 `error` 로 굳음(refresh·worker 도 같음) | `@cs/providers` `mockCredentialWorkAllowed(outcome)`(실패만 false). `apps/web/lib/oauth.ts` `requireMockOAuthReady()` — 실패면 공급자 호출·상태 변경 없이 **503 `mock_rehydration_unavailable`**(`mockRehydrationUnavailable()`). check·refresh·revoke·callback·worker tick route 가 이것을 쓴다. inline worker(`lib/stt.ts`)·worker CLI 는 그 tick 의 배포 작업(`channelAdapters` 없음)·만료 임박 갱신/정리 대기 처리(`credentialRefresh` 없음)를 건너뛴다(업로드 만료·전사는 그대로). 표식은 기존대로 실패 시 지워져 다음 요청·tick 이 다시 읽는다. 화면 폼: 설정 `account_error=mock_rehydration_unavailable`, 배포 `error=mock_rehydration_unavailable`(503 → `live_blocked` 로 뭉개지 않음), 한국어 문구 추가. | 통합 "check·refresh·revoke·worker tick route·inline worker: 503 …"(`oauthTestHooks.beforeMockRehydrationLoad` 로 읽기 실패 주입 → 두 계정 × check/refresh/revoke 503, tick route 503, inline worker `jobs=null`·`credentials=null`, 연결 정보 행·정리 대기 행 `toEqual` 그대로, 작업 state·attempt·nextRunAt 그대로·의도 0, 모의 메모리 0·표식 null → 회복 뒤 check 200 connected, tick CONFIRMED). 통합 "callback: 실패하면 503 … 회복 뒤 같은 callback 성공". 통합 "화면 폼 …". 단위 "FIX1-M4DEV1: … 실패 결과만 연결 정보 작업을 막는다"(실패 → 표식 null → 회복 뒤 성공, load 2회). |
| [P1] db/oauth.ts:781 — 정리 대기가 있는 계정의 현재 토큰을 유효로 복원 → 회전으로 무효였던 토큰이 유효로 보일 수 있음 | `loadMockCredentialsForRehydration` WHERE 에 `notExists(oauth_pending_tokens where owner_id·channel_account_id 같음)` — refresh_unknown·cleanup_revoke·verify_current 중 하나라도 있으면 계정 통째로 제외. 제외된 계정은 모의 공급자에서 알 수 없는 토큰 그대로(health 차단도 그대로). 기존 통합 시험의 "정리 대기 계정의 현재 토큰은 등록" 기대를 **등록 안 함**으로 바꿨다(동작 변경 — 약화 아님). | 통합 "refresh_unknown·verify_current·cleanup_revoke 계정: …"(로더 결과에 A 없음, 깨끗한 계정은 있음, 재시작 뒤 A 미등록·토큰 확인 false·usable false·pending 표시 유지; check: refresh_unknown·verify_current → connected 아님·usable false; cleanup_revoke → 기존 T13 규칙대로 첫 확인은 정리로 갈음해 정리 대기만 걷히고, 다음 일반 확인이 `invalid_token` → error·usable false; 모든 경우 A 로 성공한 공급자 호출 없음). |
| 놓친 케이스: 만료·키 버전 누락·복호화되지만 내용이 잘못된 토큰 | `registerRehydrated` 반환을 `'registered' \| 'already_known' \| 'rejected'` 로 — 내용이 잘못된 항목은 "이미 아는 토큰"이 아니라 skipped 로 센다. 접두만 있는 토큰·Date 아닌 만료도 거부. 거부 판정을 이미 아는 토큰 판정보다 먼저. | 통합 "만료된 연결 정보·알 수 없는 키 버전(99)·복호화는 되지만 내용이 잘못된 행 …"(미등록, skipped ≥ 3, 행 그대로, 다른 계정은 등록). 단위 기존 3개 갱신(true/false → 세 값) + 거부 3줄 추가. |
| 놓친 케이스: Google access 만료·refresh 유효에서 첫 사용 | 코드 변경 없음(기존 `accessExpiresAt` 처리) | 통합 "Google 형 access 는 만료 …"(재시작 → 첫 tick route → 보내기 전 갱신 → 비공개 업로드 CONFIRMED, 세대 증가, 이전 access 무효). |
| 놓친 케이스: 재시작 뒤 첫 호출이 revoke·callback·inline worker | 코드 변경 없음(위 가드) | 통합 "첫 사용이 연결 해제(revoke) …"(revoked, 모의 공급자에서 철회됨, 정리 대기 0), "첫 사용이 inline worker …"(CONFIRMED), callback 은 위 실패·회복 시험. |

음성 대조: `mockCredentialWorkAllowed` 를 항상 true 로, 로더의 `notExists` 를 빼고 돌리면 이 파일 16개 중 4개 실패(기존 정리 대기 시험·실패 주입 2개·정리 대기 3종)를 확인하고 되돌렸다.

### 바꾼 파일
`packages/providers/src/oauth.ts`, `packages/providers/src/oauth.test.ts`, `packages/db/src/oauth.ts`(로더 + 시험 훅 `beforeMockRehydrationLoad`), `apps/web/lib/oauth.ts`, `apps/web/lib/distribution.ts`, `apps/web/lib/stt.ts`, `apps/worker/src/cli.ts`, `apps/web/app/api/channel-accounts/[id]/{check,refresh,revoke}/route.ts`, `apps/web/app/api/oauth/callback/route.ts`, `apps/web/app/api/worker/tick/route.ts`, `tests/integration/mock-oauth-rehydrate.test.ts`(8 → 16개, `mediaVariant` 영상 크기를 호출마다 달리해 checksum 중복 방지).

### 실행한 명령과 결과(Windows 10, Git Bash, `source tools/env.sh`, Node 24.21.0, dev 서버 꺼짐)
| 명령 | 결과 |
| --- | --- |
| `corepack pnpm lint` | pass(exit 0) |
| `corepack pnpm typecheck` | pass(exit 0) |
| `corepack pnpm build` | pass(exit 0) |
| `corepack pnpm test` | pass — 42 files, 830 tests |
| `corepack pnpm test:integration`(단독) | pass — 33 files, 644 tests(397 s) |
| `corepack pnpm drill:mock` | pass(exit 0) — "불변식 위반 0건", 재시작 행(M3·Threads·YouTube·Instagram) 이전과 같음 |
| worker CLI 실제 실행 | not_run(분기 판단은 단위 `mockCredentialWorkAllowed` 로만 확인) |
| `corepack pnpm test:e2e` | not_run(요청 범위 밖) |

### 남은 위험
1. cleanup_revoke 만 남은 계정은 현재 토큰이 실제로 유효했을 가능성이 크지만(정리 대상은 다른 토큰) 이제 다시 채우지 않는다 — 재시작 뒤 첫 확인은 정리로 갈음해 connected 로 보이고, 다음 실제 사용(전송 401 → 확인)에서 `invalid_token` → 다시 연결 필요. 모의 전용, 안전 쪽 실패.
2. 다시 채우기 실패 동안 inline worker 는 배포 작업 전체를 건너뛴다(모의 모드에서는 모든 배포 작업이 모의 연결 정보를 쓰므로 계정별 구분 없이). DB 가 계속 실패하면 작업이 대기에 머문다 — 상태 변경 없음, 회복 뒤 다음 tick 이 처리.
3. reconcile route(`/api/distribution-items/{id}/reconcile`)·connect·모의 동의 화면에는 가드가 없다(연결 정보 공급자 호출 없음 — 이전 인계 위험 4 그대로).
4. 원래 위험 1·2(DB 를 그대로 믿음, 다른 프로세스 동시 변경)는 그대로다.

### Codex 에 묻는 것
1. 정리 대기 계정 제외를 kind 구분 없이(cleanup_revoke 포함) 했다. cleanup_revoke 만 있는 계정의 현재 토큰은 등록해도 되는 경우가 있는가, 아니면 지금처럼 일괄 제외가 맞는가(위험 1)?
2. 실패 시 web route 는 503 으로 막고 inline worker·CLI 는 그 tick 의 배포 작업·만료 임박 갱신을 통째로 건너뛴다. 연결 정보를 쓰지 않는 배포 작업(일반 모의 어댑터)까지 미루는 것이 불변식상 문제 되는 경로가 있는가?
3. `checkCredential` 은 정리 대기를 정리하면 공급자 확인 없이 health 를 돌려준다(기존 T13 규칙). 다시 채우지 않은 cleanup_revoke 계정이 그 직후 잠깐 connected 로 보이는 것을 이번 범위에서 막아야 하는가?
