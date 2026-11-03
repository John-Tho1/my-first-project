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

## FIX round 2 — FIX2-FULLREV2 (G9·G13·G14·G15·G16·G18·G19·G33)

- BASE_SHA: 32719be (FIX1 docs) · **HEAD_SHA: 6d54488** (`6d544887b0a51e6f307b31cd371878f5c626954d`)
- 출처: `FULLREV2_CLAUDE_REVIEW.md` 의 G9·G13–G16·G18·G19·G33(G17 은 FIX round 1). 결정은 D40-2(G9)·D40-3(G16)이고, 사용자 지시는 "FIX2-FULLREV2 진행해줘"(2026-11-02).
- G18 의 수정 방향은 오케스트레이터가 골랐다. D6 '기존 행 UPDATE 없음'에 맞춰, 부모 항목이 이번에 들어갔을 때만 승인·작업·전송 이력을 넣고 기존 항목이면 `existing_parent` 충돌로 둔다. 이력까지 넓힌 것은 구현자 판단이다.
- 진행:
  - 구현 에이전트 3명이 차례로 고쳤다(auth: G16·G15 / approval-restore: G9·G18·G19 / oauth-deploy: G13·G14·G33).
  - 오케스트레이터가 `ui-safety` 문구 토큰 1건을 G9 에 맞췄다.
  - 반박 검토(Claude 2명 — Codex 아님)에서 확정 4(P2), P0·P1 0이었다.
    - G13: provider 가 있어도 키 교체로 토큰을 열 수 없으면 해제가 멈춘다.
    - G15: 상한 뒤에도 요청마다 경고 로그가 남는다.
    - G9: 승인과 위험 표시 변경이 동시에 들어오면 경쟁이 생긴다.
    - G9: 복원으로 기존 원고가 needs_check 소재와 이어진다.
  - 보완 에이전트가 4건을 고쳤다.
  - 보완 재검토에서 확정 1(P2)이 나왔다: 실제 Threads 해제가 정리 대기 행은 여전히 열어야만 지운다. 오케스트레이터가 직접 고쳤다(행을 열지 않고 unsupported 로 삭제). 새 시험 1건, 변이 확인 1건.

### 처리
- **G9**(D40-2):
  - `snapshotProblems` 에 `risk_needs_check` 를 더했다(원고의 아이디어, 연결 소재 `content_captures`). 승인·실행 409 이고 오류 코드는 `snapshot_stale`, 문구는 '확인 필요'를 풀라는 안내다.
  - 전송 직전 재검사는 승인을 철회하고 PLANNED(부분이면 UNKNOWN)로 둔다. 파생본은 review 로 간다.
  - `updateIdea`·`updateCapture` 가 needs_check 로 저장하면 `invalidateApprovalsForRisk` 가 승인을 무효화한다(`invalidated:risk_needs_check`).
  - 승인·실행은 아이디어·소재 행을 FOR SHARE 로 잡는다. 순서는 계정 잠금 뒤, 항목 잠금 앞(id 순)으로 훅과 같다. `beginSend` 는 잡지 않는다(주석에 근거).
  - 계획 화면 항목 카드에 '확인 필요' 안내를 보인다(`<details>` 밖).
  - 복원 add_missing 이 기존 원고에 needs_check 소재 연결을 넣으면 무효화하고 `invalidated_approvals` 에 보고한다.
  - 표시를 지워도 승인은 되살아나지 않는다.
- **G16**(D40-3):
  - `sessions.policy_fingerprint` 를 더했다. sha256 이고, 들어가는 값은 oidc 는 AUTH_MODE·정규화 issuer·AUTH_ALLOWED_SUBJECT·명시 허용 email·owner 키, dev 는 AUTH_MODE·AUTH_ALLOWED_IDENTITY 다.
  - `validateSessionToken` 은 값이 없거나 다르면 401 + 쿠키 삭제다.
  - migration `0048_fullrev2_fix2_session_policy_audit_idx` 는 drizzle-kit 으로 생성했고, `audit_events(action, at)` 색인도 같이 넣었다. 적용 뒤에는 모두 한 번 다시 로그인해야 한다.
- **G15**:
  - 설정 때문인 거부(identity_login_disabled·dev_login_not_allowed·dev_login_refused_in_production)는 감사 행을 쓰지 않는다. 대신 사유 이름만 1분 1회 서버 로그로 남긴다(`apps/web/lib/auth-log.ts`).
  - `oidc_cancelled` 는 24시간 20건까지 쓴다(전역 로그인 잠금 안에서 셈). 넘으면 응답은 같고 로그만 1분 1회다.
- **G13** 실제 Threads(kind live·platform threads) 해제:
  - 공급자 설정·키와 상관없이 현재 토큰과 정리 대기 행을 열지 않는다. 원격 철회는 `unsupported`, 로컬 삭제는 끝까지 한다.
  - worker 재개도 열지 않고 마무리한다.
  - `live_provider_unavailable` 감사 표시는 공급자를 못 만든 경우만 붙는다.
  - `revoke_provider_unavailable` 안내 문구를 실제 사유로 고쳤다.
- **G14**:
  - `startOAuthConnect` 는 revoking 이면 잠금 트랜잭션 안에서 409 `credential_busy` 다. state·감사·인증 주소는 만들지 않는다.
  - 설정 화면은 '연결 해제 미완료' 안내를 보이고 연결·다시 연결 폼은 숨긴다(모의·실제).
- **G18**: PARENTS 에 `fresh` 플래그를 더했다(`owned` 와 별개). approvals·jobs·send_intents·publications·remote_steps 는 부모가 이번에 들어갔을 때만 넣고, 아니면 `existing_parent` 충돌이다. 복원 화면 문구도 더했다.
- **G19**: 복원 전 현재 브랜드를 기억해 둔다. 바뀌었으면 `invalidateApprovalsForBrandProfile`(D6 예외 — 실행만 막음)을 부르고 `invalidated_approvals`(미리보기·결과) 에 보고한다. 기존 `revoked_approvals` 와는 섞지 않는다(drill 정확 비교).
- **G33**:
  - `content-studio.service` `[Unit]` 에 `RequiresMountsFor=/srv/content-studio/data` 를 넣었다.
  - `ExecStartPre=+/bin/sh -c 'test ! -e …/.data-must-be-mount || mountpoint -q …/data'` 를 넣었다.
  - `check-env.sh` 도 같은 검사를 하고, deploy/README_KO §2·§5·§7-4·§8 을 고쳤다.

### 시험
- 신규:
  - `fullrev2-session-policy` 10
  - `fullrev2-login-audit` 6
  - `fullrev2-risk-needs-check` 19(MOCK·LIVE)
  - `fullrev2-restore-approvals` 7
  - `fullrev2-live-revoke-connect` 12
  - unit `settings-revoking-render`
  - deploy `test-service-unit.sh` 12, `test-check-env.sh` 마운트 절 7
- 보강: `oidc.test.ts` 지문 3, `revoke-view.test.ts`.
- 바뀐 기존 단언(결정·새 동작에 따른 교체이고, 반박 검토에서 약화가 아님을 확인했다):
  - `oauth.test.ts` 해제 중 연결: '시작 뒤 콜백 409' 가 '시작 409' 가 됐다. 콜백 거부는 새 경쟁 시험(시작 뒤 해제 → 콜백 409·받은 토큰 철회)으로 유지한다.
  - `oauth.test.ts` D25-3: dev 세션이 oidc 에서 401 인 것을 먼저 단언하고, oidc 지문 세션으로 원래 단언을 그대로 돌린다.
  - `migration-0047.test.ts`: '0047 = 마지막' 가정을 0047 이상 모두로 일반화했다. `toEqual(tags)` 는 그대로다.
  - `ui-safety.test.ts`: 문구 토큰을 `snapProblems` 로 바꾸고 필터 줄 토큰을 더했다.
  - `auth.test.ts`: fixture 에 지문을 더했다.
- 변이 확인(제품 변경마다 되돌려 새 시험 실패 → cmp 원복):
  - auth 6, approval-restore 9, oauth-deploy 10, 보완 7, 재검토 보완 1.
  - G9 잠금 순서는 SQL 순서 단언으로 확인했다(PGlite 단일 연결이라 실제 경쟁은 재현할 수 없다).
- deploy 셸 시험은 구현자가 `nobody` 로 실행했다(test-check-env 75/75, test-service-unit 12/12). `pnpm` 검사 묶음에는 들어 있지 않다.

### 명령
클라우드 Node 22.22.x, 순차 실행. 6d54488 과 같은 트리이고, 검사 중 바뀐 파일은 없다.
- install --frozen-lockfile(lockfile `8db0ef8abda74fda` 불변) · lint · typecheck · build: 모두 exit 0
- **unit 85 files / 2073 · integration 72 files / 1224**: 실패 0
- drill:mock: 불변식 위반 0
- test-dev-cert.sh: 472/472
- 보이지 않는 문자: 0
- `./data`: 없음
- not_run:
  - Codex
  - 실제 Postgres 다중 연결(G9 잠금·G15 상한)
  - 실제 systemd(`systemd-analyze`·재부팅)
  - deploy `run-all.sh` 전체
  - 브라우저
  - 실제 Threads·실계정·실제 OIDC IdP

### 남은 위험
- G16:
  - 정책을 바꿨다가 원래대로 되돌리면 만료 전 옛 세션이 다시 유효해진다. 일괄 폐기 버튼·CLI 는 없다.
  - `oidc_provider_error` 에는 상한이 없다.
  - `audit_events` 보존 정리가 없다.
- G9:
  - 승인·실행이 같은 아이디어·소재의 동시 편집을 잠깐 기다리게 한다.
  - `idea_captures`(원고에 잇지 않은 아이디어 소재)는 보지 않는다.
- G19: D6 예외(기존 승인 행 변경)는 DECISIONS 에 기록하지 않았다. 사용자 결정 대상이다.
- G33: `Restart=on-failure` 이면 ExecStartPre 실패가 5초마다 다시 시도될 수 있다. 실제 서버에서는 확인하지 않았다.
- 구현자가 deploy 시험을 `nobody` 로 돌리려고 이 클라우드 작업 트리에 `chmod -R a+rX` 를 했다. git 모드 변경은 없다.
- (범위 밖, 재검토 메모) `beginSend` 의 brand_changed 무효화는 파생본을 draft 로 보낸다. 훅은 review 로 보낸다.

### 검토자에게 물을 것
1. G18 이 승인 외 작업·전송·게시 이력까지 `existing_parent` 로 막는 것이 D6·이력 보존에 맞는가?
2. G9 잠금 순서(계정 → 아이디어 → 소재 → 원고·파생본·계획·항목)에 교착 경로가 없는가? `beginSend` 에 잠금을 두지 않은 근거가 맞는가?
3. G16 지문 구성(oidc 에서 명시 허용 email 이 있을 때만 포함, client id 제외)이 D40-3 에 맞는가?
4. G13 이 실제 Threads 의 봉인 토큰을 열지 않고 지우는 것(원격 철회 없음 전제)이 철회 의무 규칙(FIX5/6-T13)과 충돌하지 않는가?
5. G33 ExecStartPre 의 `+`(root 실행)와 `mountpoint` 부재 시 시작 거부가 운영 의도에 맞는가?

### 이후
- FIX3-FULLREV2: G10–G12·G20–G32(G20·G29 는 D40-4·5). 사용자 결정 대기.

## FIX round 3 — FIX3-FULLREV2 (G10–G12·G20–G32)

- BASE_SHA: ec0ec6c (FIX2 docs) · **HEAD_SHA: 4f6b71b** (`4f6b71bab0063ed83fd9023a11e21625d0e5ee3d`)
- 출처: `FULLREV2_CLAUDE_REVIEW.md` 의 G10–G12·G20–G32. 결정은 D40-4(G20)·D40-5(G29)이고, 사용자 지시는 "진행해줘"(2026-11-03). 이로써 FULLREV2 확정 33건을 모두 처리했다.
- 진행:
  - 구현 에이전트 3명이 차례로 고쳤다(publish-ui: G10·G11·G12·G30 / writing-content: G20·G21·G22·G29·G31·G32 / capture-upload: G23–G28).
  - 반박 검토(Claude 3명 — Codex 아님)에서 P0·P1 0, 확정 P2 8이었다(A 0, B 3, C 5). 보완 에이전트가 8건 모두 고쳤다.
    - B: 채널 초안 실패 원인이 화면에 없음, 1인칭 조사·공백·영어 누락, 스키마 실패 분류 불일치.
    - C: 지워진 asset 에 410 이 반복됨, 세션 폴더 없음에 503 이 반복됨, 최신 본문 없이 덮어쓰기 버튼이 보임, 정리 순서, 주석 위치.
  - 보완 재검토에서 확정 P2 3이 나왔다.
    - 2건은 오케스트레이터가 직접 고쳤다(새 시험 3, 변이 확인 2): ① 전사 진행 중(409 transcription_in_progress)에 다시 요청하지 않고 키를 거둔다(같은 asset 에 작업·비용이 하나 더 생기는 것 방지). ② 업로드 루트 자체가 없으면 세션을 거부하지 않고 503 이다.
    - 1건(1인칭 오탐: '나와 있다', 'coal mine', 'MY')은 D40-4 가 받아들인 방향(확인 대상만 늘어남)이라 남은 위험으로 둔다.

### 처리
- **G10**: 계획 만들기·승인·재시도 JSON 의 `mode` 를 계정 종류로 정한다(`modeForAccountKind`). 항목별 mode 와 전체 mode(MOCK·LIVE·MIXED)를 둔다. 재시도는 `RetryOutcome.mode` 를 쓴다.
- **G11**: 실제 게시 중지·재개 배너는 쿼리와 저장 상태가 맞을 때만 보인다. 다르면 중립 안내(`livePublishDoneBanner`)를 보인다.
- **G12**: 작업 목록에서 최근 작업 줄만 보류 사유(block.code)를 쓰고, 다른 줄은 자기 `lastErrorCode` 를 쓴다.
- **G30**:
  - `retentionPlanFingerprint`(삭제 대상 정렬 목록의 sha256)를 미리보기 JSON 과 폼 hidden 에 넣는다.
  - 수동 적용은 지문이 필수다(없으면 400 `plan_fingerprint_required`). ① 트랜잭션에서 새 계획과 다르면 아무것도 지우지 않고 409 `plan_changed` 다(폼은 새 미리보기로 간다).
  - 자동 정리는 지금처럼 지문 없이 돈다. **API 변경**: `{confirm:"yes"}` 만 보내면 400 이다(docs/04·README).
- **G20**(D40-4) `FIRST_PERSON`:
  - 앞 경계는 `(?<![\p{L}\p{N}])` 다(괄호·꺾쇠·따옴표·강조 뒤도 잡는다).
  - 어휘: 저희·우리+공백/조사·저도·제게·저를·저와·저한테·저만·저로서는·필자·본인, `\s` 공백, 영어 I/me/my/we/us/our/myself/ourselves/mine(단어 경계, 대소문자 규칙).
  - 제외: 우리나라·저만큼·나와서/나와야/나와요·US·ME·i.e.·(i). 선형이다.
- **G21**:
  - 허용 목록 `AI_RUN_FAILURE_TEXT`·`LIVE_LLM_FAILURE_TEXT`·`PERMANENT_AI_FAILURE_CODES`·`aiRunFailureView` 를 두었다.
  - 작성 패널의 실패 run 과 폼 redirect 의 `failure=`(채널 초안 포함)에 원인과 영구 실패 안내를 보인다. 원문은 표시하지 않는다.
  - 502 에는 `run_id`·`failure_code`·`permanent` 를 담는다. 채널 초안도 `aiFailureCode` 를 같이 쓴다(스키마 실패 = `invalid_output`).
- **G22**: `budget_currency_mismatch` 에 고정 폼 문구를 둔다.
- **G29**(D40-5):
  - 잠금 안에서 base_version 확인 뒤, CRLF/CR→LF 로 맞춘 본문이 같으면 새 버전·감사·승인 변경이 없다(메모와 관계없음).
  - JSON 은 200 `unchanged:true`, 폼은 '변경 없음(메모 저장 안 됨)' 이다.
- **G31**: 브랜드 폼 충돌은 409 HTML 비교 화면이다(`CONFLICT_HTML_HEADERS`, 모두 escape). 필드별 현재 값과 내 입력을 보이고, base_version = 현재인 재저장 폼을 준다.
- **G32**: 고유 검색 조각이 8개를 넘으면 400 이고 검색 화면이 문구를 보인다.
- **G23**:
  - 전사 초안은 `{base, text, conflict}` 이고 base_version 은 편집 시작 버전이다.
  - 409 `stale_transcript` 면 최신 본문과 경고를 보인다. 최신 본문을 못 불러왔으면 '최신 기준으로' 버튼을 숨긴다.
- **G25**:
  - 이어 올리기 키는 전사 요청이 성공한 뒤에만 지운다. 실패하면 '전사만 다시 요청'을 보인다.
  - verified 세션은 전사만 요청한다.
  - 404·410·`asset_not_verified` 면 키를 지우고 새로 올린다. 409 `transcription_in_progress` 면 다시 요청하지 않고 키를 거둔다.
- **G24**:
  - 조립 결과를 ok·chunk·io 로 나눈다.
  - 조각 sha256 불일치·조각 없음·세션 폴더 없음(루트는 있음)만 `assembly_failed` 다.
  - 서버 I/O 오류(열기·쓰기·닫기·stat·크기 불일치·루트 없음)는 `assembled.part` 만 지우고 세션을 open 으로 되돌린 뒤 503 `upload_assembly_io_error` 다.
  - 일반 실패 경로는 파일을 지운 다음 open 으로 되돌린다.
- **G26**: Markdown 첫 제목은 선형 문자 처리(`markdownFirstHeading`)로 뽑는다. 옛 식과 같은 결과임을 짧은 입력 전수와 무작위 2만 건으로 대조했다.
- **G27**: 목록의 정확 중복은 상세와 같은 정규화 URL 규칙이다.
- **G28**: 빠른 수집 본문 상한은 상수에서 계산한다(약 300KiB).

### 시험
- 신규 파일:
  - `fix3-fullrev2-writing` 24
  - `fix3-fullrev2-capture-upload` 6
  - `fix3-fullrev2-fixup-ai` 6
  - unit `imports-fix3-fullrev2` 7
  - `record-client` 14
- 신규 describe 를 더한 파일: `live-threads-publish`(G10), `fix5-fullrev`, `ops-retention`(G30), `uploads-transcription`(G23–G25·보완·재검토), `llm.test.ts`(G20 39+49), domain `writing`·`content`, web `live-publish-render`·`plan-detail-render`.
- 바뀐 기존 단언(결정·새 동작에 따른 교체이고, 반박 검토에서 같은 엄격도임을 확인했다):
  - `ops-retention` 의 수동 적용 200 시험이 자기 미리보기 지문을 보낸다.
  - `uploads-transcription` 의 '쓰기 진행 0·크기 불일치 → assembly_failed' 가 '503·세션 open·조각 유지·재시도 성공' 이 됐다.
  - 보완 시험의 `transcription_in_progress → retry` 가 `already` 가 됐다.
- 변이 확인(제품 변경마다 되돌려 새 시험 실패 → cmp 원복):
  - A 6, B 9, C 8, 보완 16, 재검토 보완 2.
  - G26 은 옛 식을 되돌리면 적대 입력에서 60 초를 넘어 멈춘다.

### 명령
클라우드 Node 22.22.0, 순차 실행. 4f6b71b 와 같은 트리이고, 검사 중 바뀐 파일은 없다.
- install --frozen-lockfile(lockfile `8db0ef8abda74fda` 불변) · lint · typecheck · build: 모두 exit 0
- **unit 87 files / 2194 · integration 75 files / 1278**: 실패 0
- drill:mock: 불변식 위반 0
- test-dev-cert.sh: 472/472
- 보이지 않는 문자: 0
- `./data`: 없음
- not_run:
  - Codex
  - 브라우저(녹음 화면 G23·G25, 브랜드·검색·작성 화면 렌더 일부는 helper·원본 확인만)
  - 실제 PostgreSQL 다중 연결
  - 실제 LLM·실계정
  - 실제 디스크 부족

### 남은 위험
- G20: 정규식 휴리스틱이다.
  - 주어가 없는 경험은 놓친다.
  - 오탐이 늘었다('나와 있다', 'coal mine', 'MY', '본인', '우리 ').
  - 대문자 'ME TOO' 는 놓친다.
- G21:
  - 폼 실패 원인은 redirect 쿼리로만 보인다(새로 고침 뒤에도 기억하지 않는다). 손으로 만든 `failure=` 는 허용 목록 문구만 보인다.
  - 같은 실패가 작성 패널에 두 번 보일 수 있다.
- G30: 미리보기와 적용 사이에 항목이 기준 시각을 넘으면 409 가 난다(안전한 쪽).
- G24: 디스크가 계속 고장 나면 503 이 반복된다(재시도 횟수 상한이 없다). 남은 디스크를 미리 확인하지는 않는다.
- G25: 404(잘못 라우팅된 프록시 등)도 파일 없음으로 보고 다시 올린다. 이어 올리기 키는 owner 별로 나뉘지 않는다(범위 밖).
- G32: 대소문자만 다른 9조각도 400 이다.
- (범위 밖, 검토 메모) 원고·브랜드 화면이 `?error=` 를 그대로 키로 써서 문구를 찾는다. `__proto__` 같은 값이면 렌더가 깨질 수 있다. 별도 작업 후보다.

### 검토자에게 물을 것
1. G30 의 수동 적용 지문 필수(API 변경)와 지문 범위(작업 id·배포 파일·내보내기 kind+id)가 충분한가?
2. G20 의 확대 범위와 제외 목록이 D40-4 의 '오탐은 막는 쪽'에 맞는가?
3. G24 의 io·chunk 경계(크기 불일치 = io, 세션 폴더 없음 = chunk, 루트 없음 = io)가 맞는가?
4. G29 에서 base_version 이 낡으면 본문이 같아도 409 인 순서가 맞는가?
5. G25 의 `transcription_in_progress → already`(키를 거둠)가 이어 올리기 규칙에 맞는가?

### 이후
- FULLREV2 확정 33건 처리를 마쳤다. Codex 재확인은 대기열 15–20번이다(사용자 PC).

## 후속 — 쿼리 문구 조회 방어(ownText)

- BASE_SHA: 5104059 (FIX3 docs) · **HEAD_SHA: abdc5d9** (`abdc5d90607c66f7c6b3ccf9c6c46e4a8dc16fef`)
- 출처: FIX3-FULLREV2 반박 검토에서 범위 밖으로 남긴 지적. 사용자 지시는 "계속 진행해줘"(2026-11-03). Codex 대기열 21번 추가는 사용자 요청이다.

### 처리
- 결함: 화면이 `?error=`·`?upload=`·`?account_error=` 등의 쿼리 값을 문구 표에 대괄호로 바로 썼다. `__proto__`·`constructor` 같은 값이면 Object.prototype 의 속성(문자열 아님)이 나와, 렌더가 깨지거나 기본 문구로 넘어가지 않았다.
- `apps/web/lib/lookup.ts` 에 `ownText(table, key)` 를 두었다. `Object.hasOwn` 이고 값이 문자열일 때만 돌려주고, 아니면 undefined 를 돌려 호출부의 기본 문구로 넘어간다.
- 화면 17개 파일 24곳을 바꿨다: 로그인, 홈, 원고·원고 목록, 브랜드, 설정·복원, 운영, 수집·수집 실행, 가져오기·가져오기 상세, 아이디어·아이디어 상세, 소재 상세, 배포 만들기·배포 상세.

### 시험
- 새 `apps/web/lib/lookup.test.ts` 4건:
  - 프로토타입 키 6종(`__proto__`·`constructor`·`toString`·`hasOwnProperty`·`valueOf`·`isPrototypeOf`)이 undefined 다. 대조로, 대괄호 조회는 문자열이 아닌 값을 낸다.
  - `app/**` 원본에 쿼리 값 대괄호 조회 꼴이 없다(원본 가드).
  - 대표 화면 연결.
- 변이 확인: 원고 화면을 수정 전으로 되돌리면 2건이 실패한다. cmp 로 원복했다.
- 바뀐 기존 단언: 없음.

### 명령
클라우드 Node 22.22.0, abdc5d9 와 같은 트리.
- install(lockfile `8db0ef8abda74fda` 불변) · lint · typecheck · build: PASS
- **unit 88 files / 2198 · integration 75 files / 1278**
- drill:mock: 위반 0
- dev-cert: 472/472
- not_run: Codex, 브라우저.

### 남은 위험
- 원본 가드는 `TABLE[q.x]`·`TABLE[str(q.x)!]`·`TABLE[params.x]` 꼴만 찾는다. 다른 이름의 변수에 쿼리 값을 담아 조회하면 잡지 못한다(예: `const code = q.error; TABLE[code]` — 로그인 화면은 고쳤다).
- `lib/collector.ts` 의 `COLLECTOR_ERROR_LABEL[code]` 는 DB 에 저장된 코드라 바꾸지 않았다.

### 검토자에게 물을 것
1. 쿼리·사용자 입력으로 고정 문구 표를 찾는 곳 중 남은 것이 있는가(lib 함수 안 포함)?
2. 원본 가드의 정규식 범위가 충분한가?
