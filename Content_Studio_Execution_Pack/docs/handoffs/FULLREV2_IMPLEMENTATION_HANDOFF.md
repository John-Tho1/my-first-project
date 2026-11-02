# FULLREV2 구현 인계

## FIX round 1 — FIX1-FULLREV2 (G1–G8 + G8 보완 + G17)

- BASE_SHA: 3029102 (D40 docs) · **HEAD_SHA: d641ac4** (`d641ac4dd6a41cb766d32603951a053c51211dd5`)
- 트리 SHA `3f8001e227713c59500965c699db35da9ddb6f77`. 커밋 전에 사용자에게 보낸 독립 검증 스냅샷의 기대 트리와 같다. 스냅샷 zip 의 SHA256 은 `ceec7e4b0ba5389eabe394c367dc533f81717189da7dcf08045f30c8a213fa46`.
- 출처:
  - `docs/handoffs/FULLREV2_CLAUDE_REVIEW.md` 의 G1–G8.
  - G2 는 D40-1(사용자 결정 2026-11-02 "권고대로")을 따른다.
  - G17 은 원래 FIX2 범위였다. 사용자 요청(2026-11-02)으로 이 묶음에 넣었다.
- 진행:
  - 구현 에이전트 3명이 차례로 고쳤다.
  - 3관점 반박 검토(Claude — Codex 아님)에서 확정 1(P2), 기각 1이 나왔다. 확정 1은 보완했다.
  - 보완 재검토(2관점)에서는 확정 0, 기각 2(P2)였다.
  - G17 은 오케스트레이터가 직접 고쳤다.

### 처리
- **G1** `apps/web/scripts/next.mjs`, 새 `next-args.mjs`:
  - `dev` 에 `-H` 가 없으면 루프백을 넣는다. APP_BASE_URL 호스트가 127.0.0.1 이면 127.0.0.1, 아니면 `localhost` 다.
  - 고정 127.0.0.1 이 아닌 까닭: Next 16.3.6 은 hostname 을 route handler 의 `request.url` 호스트로 쓴다. 고정하면 OAuth 콜백 정확 일치와 CSRF 가 깨진다.
  - 루프백이 아닌 `-H` 는 그대로 두고 경고만 한다. build·start·typegen 은 바꾸지 않았다.
- **G2**(D40-1) 새 `packages/db/src/duplicate-publish.ts`, `distribution.ts`, 라우트, 화면:
  - 같은 owner 의 다른 계획에 같은 글이 있으면 중복으로 본다. 같은 글은 같은 (변형 버전, 계정)이거나 같은 payload_hash 다.
  - 그 글이 게시됨(USER_CONFIRMED 포함), UNKNOWN, 진행 중(BLOCKED 포함)이면 새 계획·승인·실행 화면에 경고한다.
  - 실제 계정은 `acknowledge_duplicate: true` 가 없으면 승인·실행이 409 `duplicate_publish_unacknowledged` 다. 모의 계정은 경고만 한다.
  - 실행에는 owner advisory 잠금을 건다.
- **G3** `restore.ts` PARENTS:
  - `generation_runs.variant_id`, `claims.variant_version_id` 를 더했다.
  - DB 카탈로그의 모든 FK 와 대조하는 가드 시험을 넣었다.
- **G4** `CONFLICT_HTML_HEADERS` 를 `referrer-policy: same-origin` 으로 바꿨다. 캡처 긴 입력 409 도 같은 헤더를 쓴다.
- **G5** `applyReconcile`:
  - reconcile_count 는 연속 unknown 만 센다.
  - processing 폴링은 이번 시도의 job_events 로 따로 세어 REMOTE_POLL_MAX 에 견준다.
- **G6** 사용자 확인 후보 검사:
  - 다른 항목의 publication 이나 publish remote_step 이 쓴 ID 는 후보가 아니다.
  - 확인하면 409 `user_confirm_candidate_claimed` 다. 후보별 advisory 잠금을 건다.
  - 조회도 그 ID 를 후보로 기록하지 않는다.
- **G7** 실제 Threads 어댑터:
  - 앞선 시도·lease·조회가 'finished' 로 기록한 컨테이너도 게시 시도 표식 전에 상태를 다시 읽는다.
  - EXPIRED·ERROR 면 rejected/permanent(`container_expired`·`container_error`)이고, 표식과 게시는 없다.
- **G8** `invalidateApprovalsForAccount`:
  - 진행 중 항목(SENDING·REMOTE_PROCESSING·RECONCILING·CANCEL_REQUESTED)의 승인도 철회한다.
  - **보완**(검토 확정 P2): SENDING 중 철회된 뒤 그 전송이 보류(표식 전 즉시 중지, auth)로 끝나는 경우가 있다. 이때는 `finishSend` 가 `stopUnlessPartial` 로 항목을 PLANNED 로, 일부 게시면 UNKNOWN 으로 둔다. 재시도 409·재승인 409 인 막다른 BLOCKED 를 막는다.
- **G17** `apps/web/app/api/auth/login/route.ts`:
  - 미디어 유형 판별만 소문자로 하고, `formData()` 에는 원래 Content-Type(대소문자 boundary)을 넘긴다.
  - CSRF·식별자 검사·횟수 제한·잠금은 그대로다.

### 시험
- 신규:
  - `apps/web/scripts/next-args.test.ts` 17
  - `tests/integration/fullrev2-duplicate-publish.test.ts` 11
  - `fullrev2-restore-parents` 8
  - `fullrev2-conflict-referrer` 5
  - `fullrev2-publish-safety` 11(G5 (a)–(e), G8 (a)–(f))
  - `fullrev2-login-multipart` 8
- 보강: `live-user-confirm`(G6), `live-orphan-blocked`(G7·G8·G8 후속), providers `threads-live-publish`(G7), domain `distribution`·`user-confirm`, web `distribution`·`ui-safety`.
- 바뀐 기존 단언:
  - G7 경계 시험만 바뀌었다. 다시 읽기의 heartbeat 1회를 반영해 같은 엄격도로 옮기고 경우 1개를 더했다.
  - 그 밖에는 필드 추가(`candidateClaimed:false`), 코드 목록 확장, fixture 타입 확장뿐이다. 약화된 것은 없다.
- 변이 확인(제품 변경마다 되돌려 새 시험 실패를 확인하고 cmp 로 원복했다):
  - G1 4, G2 38, G3 3, G4 2, G5 1, G6 6, G7 1, G8 1, 보완 5, G17 2(수정 전 코드에서는 8건 중 5건 실패).
  - G6·G2 의 advisory 잠금은 PGlite 가 단일 연결이라 변이를 확인할 수 없다.
- 실제 브라우저 E2E(Playwright + Chromium 153, `pnpm dev`):
  - 환경: localhost, scratch 합성 PGlite. 모의 설정(AUTH_MODE=dev, LLM·게시·OAuth 모의)이고 `.env.local`·`./data` 는 쓰지 않았다.
  - G17: `fetch(FormData)`(boundary `----WebKitFormBoundary…`)는 200 과 세션이 생기고, multipart 폼 제출은 303 `/` 다.
  - G4: 409(same-origin)에서 다시 저장하면 `Origin: http://localhost:3000` 이 가고 303 `saved_version=3` 이다.
  - 두 수정을 잠시 되돌린 대조: G17 은 400·`?error=invalid`, G4 는 `Origin: null` 로 `?error=csrf` 가 되어 저장되지 않는다. 확인 뒤 원복했다.

### 명령
클라우드 Node 22.22.x, 순차 실행. d641ac4 와 같은 트리이고, 검사 중 바뀐 파일은 없다.
- install --frozen-lockfile(lockfile `8db0ef8abda74fda` 불변) · lint · typecheck · build: 모두 exit 0
- **unit 84 files / 2069 · integration 67 files / 1169**: 실패 0, 건너뜀 0
- drill:mock: 불변식 위반 0, fetch 0
- test-dev-cert.sh: 472/472
- 보이지 않는 문자: 새 것 0(기존 이모지 시험 줄 1개는 diff 밖)
- `./data`: 전후 모두 없음. 외부 호출 0
- not_run:
  - Codex
  - 실제 Postgres 다중 연결(G2·G6 잠금)
  - Safari·Firefox, Windows·macOS(G1 의 `localhost` → ::1)
  - 실제 Threads·실계정
  - 사용자 PC 실행기 `content-studio-dev-https` 의 `-H` 값

### 남은 위험
- G2:
  - 실행 뒤·전송 전에 생긴 중복은 서버가 다시 막지 않는다(D40 결과).
  - BLOCKED 항목의 재시도 화면에는 중복 경고가 없다. 검토 지적이었고 D40 범위 밖이라 기각했다.
  - 버려진 BLOCKED 실제 항목이 있으면, 그 항목을 취소할 때까지 새 계획에 확인이 필요하다.
- G6: 다른 작업의 publish 단계가 커밋되기 전에 사용자 확인이 먼저 지나가는 틈이 있다. 실제 Postgres 에서는 시험하지 않았다.
- G7: 모의 Threads 어댑터는 그대로다(D26 후속 규칙).
- G8:
  - 진행 중 항목의 변형도 review 로 돌아간다.
  - 전송 중 철회 뒤 일시 오류면 RETRY_WAIT 로 최대 1시간 남는다. 다음 전송 직전 재검사가 막는다. 재검토 지적이었고 기각했다.
  - 이 보류 화면은 원래 원인(cause)을 보여 주지 않는다. 재검토 지적이었고, 이번 변경 전부터 있던 규칙이라 기각했다.
- G1:
  - `localhost` 기본값에서 http://127.0.0.1 로 열면 연결이 거부된다.
  - Windows 에서는 확인하지 않았다.

### 검토자에게 물을 것
1. G1 기본값 `localhost`(APP_BASE_URL 을 따름)가 '127.0.0.1 바인드' 권고의 목적(LAN 비노출)을 충족하는가? 사용자 실행기가 `-H 127.0.0.1` 을 넘기면 OAuth 콜백 불일치가 나는지도 봐 달라.
2. G2 가 BLOCKED 를 '진행 중'으로 세는 것과, 재시도 화면에 경고가 없는 것이 D40-1 에 맞는가?
3. G8 보완이 보류 결과에만 PLANNED 규칙을 적용하고 일시 오류(RETRY_WAIT)는 다음 전송 재검사에 맡기는 것이 적절한가?
4. G6 의 advisory 잠금과 publish remote_step 을 claim 으로 보는 범위가 충분한가?
5. G17 은 판별에 `startsWith`(소문자 전체 문자열)를 그대로 썼다. `application/jsonx` 같은 값도 지금처럼 받는다. 기존 동작 유지가 맞는가?

### 이후(사용자 결정 대기)
- FIX2-FULLREV2: G9·G13·G14·G15·G16(migration)·G18·G19·G33.
- FIX3-FULLREV2: G10–G12·G20–G32.
