# FULLREV3 구현 인계

## FIX round 1 — FIX1-FULLREV3 (H1–H8)

- BASE_SHA: `26b44c1` (`26b44c12364969f5aec6dd17013ae05cb56a7cd6`) · **HEAD_SHA: `e1fdc02`** (`e1fdc02f053c7477a7294bc06b3cccb6726c40b5`)
- 출처: `docs/handoffs/FULLREV3_CLAUDE_REVIEW.md` 의 확정 8건(P1 1·P2 7). 사용자 지시 "권고대로 진행해줘"(2026-11-07).
- 방식(D42, Claude 독립 검토 — Codex 아님):
  1. 구현 서브에이전트 3명이 차례로 맡았다(H1 / H2·H3 / H4·H5·H6). H7·H8 은 주 세션이 고쳤다.
  2. 새 컨텍스트 검토자 3명이 반박 검토했다. 확정 P2 6건, 기각 1건.
  3. 보완 서브에이전트가 6건을 고쳤다.
  4. 보완분 재검토에서 P2 1건(문서 증상 설명)이 나와 주 세션이 고쳤다.
  5. 최종 트리에서 전체 검사를 돌렸다.

### 처리
- **H1 (P1) 운영 배포에서 callback redirect 항상 불일치**
  - `packages/domain/src/oauth.ts` 에 `callbackRedirectTarget(config, requestUrl)` = `APP_BASE_URL` origin + 요청 pathname 을 두었다.
  - OIDC callback(`apps/web/app/api/auth/oidc/callback/route.ts`)과 계정 연결 callback(`apps/web/app/api/oauth/callback/route.ts`)이 `request.url` 대신 이 값을 등록 redirect URI 와 정확히 비교한다. `Host`·`X-Forwarded-Host` 는 믿지 않는다.
  - 보완: `OAUTH_REDIRECT_URI` 의 origin 이 `APP_BASE_URL` 과 다르면 다음처럼 막는다.
    - 준비 판정(`liveOAuthReadiness`)에서 미리 막는다.
    - 연결 시작(`/api/channel-accounts/[id]/connect`)에서 503 `oauth_redirect_origin_mismatch` 로 막는다. state·감사 행·외부 요청은 0 이다.
    - callback 의 정확 일치는 시작 뒤 설정이 바뀐 경우를 막는 방어선으로 남겼다.
  - 문서: `deploy/README_KO.md` §4.1·§10, `README_KO.md`, `docs/04` 에 실제 증상을 적었다.
    - `OIDC_REDIRECT_URI` 불일치 → 503 `oidc_not_configured`(횟수에 세지 않음).
    - IdP 가 거부하거나, 호스트가 어긋나 `state_*` 실패(횟수에 셈).
- **H2 위험 표시가 전송 중 항목의 승인을 철회하지 못함**
  - `approval-invalidation.ts`: 계정 훅이 쓰던 상태 목록을 `IN_FLIGHT_INCLUSIVE_ITEM_STATUSES` 로 이름을 바꿨다.
  - 이 목록을 `invalidateApprovalsForRisk` 세 형태가 모두 쓴다. 주석 2곳(`approval-invalidation.ts`, `distribution.ts`)을 고쳤다.
- **H3 복원 보고가 부분 게시 작업을 '실행 전으로'라고 안내**
  - `invalidated_approvals` 항목에 `partial_job_ids`·`leased_partial_job_ids`(보완)·`in_flight` 를 넣었다.
  - 진행 중 상태 목록은 `IN_FLIGHT_ITEM_STATUSES` 하나로 합쳤다(보완 — restore.ts 의 따로 적은 목록 삭제).
  - 화면(`apps/web/lib/restore-view.ts` `restoreInvalidationNotices`, `settings/restores/[id]`)은 브랜드·위험·부분 게시(UNKNOWN)·lease 된 부분 게시·전송 중을 나눠 안내한다. 옛 기록은 `[]`·false 로 읽어 예전 문구 그대로다.
- **H4 1인칭 축약형 누락**
  - `packages/providers/src/llm.ts` 에 우린·저흰·난·내겐·제겐·저한텐·나한텐·우리한텐·저 혼자·나 혼자·우리끼리를 더했다.
  - '난' 은 앞이 '가/이 + 공백'이면 잡지 않는다(보완, 고정 길이 lookbehind — 선형 시간 유지). 받아들인 오탐·누락은 정규식 옆 주석에 적었다.
- **H5 충돌 화면 textarea 가 맨 앞 빈 줄을 잃음**
  - `apps/web/lib/contents.ts` 3곳·`apps/web/lib/captures.ts` 에서 여는 태그 바로 뒤에 `\n` 을 넣었다.
  - 시험 helper 에 `browserTextareaRaw` 를 더했다.
- **H6 전사 응답을 잃으면 같은 asset 에 작업·비용 예약이 하나 더 생김**
  - 서버(`packages/db/src/transcription.ts`): `force` 가 아닌 요청은 그 asset 의 성공 작업이 있으면 그 작업을 돌려준다(200 `existing: true`, 새 작업·원장 없음).
  - `force` 는 `transcribeRequestSchema` 에 더했다. 방식은 'command_key' 대신 '최근 성공 작업 반환'을 골랐다(더 단순).
  - 화면(`RecordClient`): 폴링 목록에 그 asset 의 작업이 보이면 '전사만 다시 요청'을 거둔다.
  - 보완: `keep_original=false` 요청이 기존 성공 작업을 만나면 원음 삭제 경로(`deleteOriginalDetailed` — 첨부 재확인·삭제 의도 먼저·감사)를 실제로 탄다.
    - 응답에 `original_deleted` 또는 `original_kept_reason`(`asset_in_use`·`cleanup_pending`)을 넣고, 화면이 그 결과를 알린다.
    - 원음을 남긴 경우에는 대기 요청을 정리하지 않는다.
- **H7** `docs/06_AGENT_WORKFLOW.md` §2 6단계에 deploy 셸 시험을 넣었다. root 셸에서는 `setpriv --reuid=nobody --regid=nogroup --clear-groups -- env HOME=/tmp TMPDIR=/tmp bash deploy/scripts/tests/run-all.sh` 로 돌린다.
  - gate 에서 처음 돌린 전체 deploy 시험이 `test-restore-data.sh` 1건 실패했다('연속 두 번 실행 … 복원 내용 다름', 4번 중 1번 재현).
    - 원인: 직전 사본 이름의 시각이 초 단위라, 두 실행이 같은 초에 끝나면 `mktemp` 꼬리(무작위) 순서로 정렬된다. 시험이 `ls | head -1` 로 고른 '첫 사본'이 두 번째 사본일 수 있었다.
    - 제품 스크립트는 바꾸지 않았다(이번 diff 밖, 6d54488 이후 그대로). 시험이 첫 실행 직후 생긴 사본을 집도록 고쳤다. 단언은 그대로다.
    - 확인: 비root 로 10회 연속 64/64.
- **H8** `/.claude/commands/claude-task.md`:
  - Write·`Bash(date:*)` 도구를 더했다.
  - `.ai/handoff/task-<ts>.md` 저장 단계를 넣었다.
  - 되돌리기는 사용자 확인 뒤 사용자가 하거나 지시한 대로만 하도록 바꿨다.

### 반박 검토 기록
- 1차(구현 뒤, 검토자 3명): 확정 P2 6건을 보완했다(위 '보완'). 기각: H3 P2-2(이전 복원에서 온 보류 항목) — 검토자 스스로 '활성 승인이 남아 있을 가능성이 거의 없다'고 대부분 반박.
- 2차(보완분, 검토자 1명): 확정 P2 1건.
  - 내용: `deploy/README_KO.md` 가 OIDC 경로 불일치를 `redirect_mismatch`(횟수에 셈)라고 적었다. 실제로는 준비 판정이 `OIDC_REDIRECT_URI` 를 `APP_BASE_URL` + 고정 경로와 정확히 비교하므로 503 `oidc_not_configured` 다.
  - 처리: 주 세션이 `oidc.ts` `oidcLoginReadiness` 로 확인한 뒤 문서와 callback 주석을 고쳤다(동작 변경 없음).
- P0·P1 확정 0.

### 시험
- 새 시험 파일: `tests/integration/fullrev3-risk-inflight.test.ts`, `fullrev3-restore-partial.test.ts`, `fullrev3-client-ui.test.ts`.
- 단위 시험 추가: `oauth.test.ts`(domain), `restore-view.test.ts`, `record-client.test.ts`, `llm.test.ts`.
- 통합 시험 추가: `auth-oidc.test.ts`·`oauth.test.ts` 에 운영 형태 블록을 넣었다(요청 origin `https://localhost:3000`·`https://127.0.0.1:3000` 둘 다, Host·X-Forwarded-Host 흉내).
- 바뀐 기존 단언(약화 없음 — 같은 강도 또는 강화):
  - H1 설계에 따라 '요청 origin 이 달라 불일치'를 '경로가 달라 불일치'로 바꿨다(`auth-oidc.test.ts`, `auth-oidc-fix1.test.ts`, `oauth.test.ts`). 다른 origin 경우는 새 블록이 맡는다.
  - `oauth.test.ts` 의 'OAUTH_REDIRECT_URI 다른 origin → callback 불일치'를 둘로 나눴다: 연결 시작 503 시험 + 'callback 방어선'(시작 뒤 설정 변경) 시험.
  - `uploads-transcription.test.ts`: 같은 asset 재전사 5곳에 `force: true` 를 붙였다. 410 단언은 force 로 유지하고, force 없는 요청은 기존 작업 반환 단언을 더했다.
  - `fullrev2-restore-approvals.test.ts`·`fullrev3-restore-partial.test.ts`: 정확 일치 `toEqual` 에 새 칸을 더했다(강화).
  - domain `oauth.test.ts` 의 준비 판정 고정값에 `APP_BASE_URL` 을 넣었다(없으면 다른 origin 으로 바르게 '준비 안 됨').
- 변이 확인(구현자 보고 — 주 세션이 직접 돌린 것 아님): 제품 변경마다 되돌려 새 시험이 실패하는 것을 보고 원복 뒤 `cmp` 로 같음을 확인했다. 문서만 바꾼 항목(H7·H8·H1 문서)은 제외.
- 보이지 않는 문자 검사(주 세션): 추가된 줄·새 시험 파일에서 0건. `llm.test.ts` 의 NBSP 는 의도한 시험 입력이다.

### 명령
클라우드 Node 22.22.0, `e1fdc02` 와 같은 트리. 단계별 종료코드 기준:
- install --frozen-lockfile(lockfile `8db0ef8abda74fda` 불변) · lint · typecheck · build: 각 exit 0
- **unit 88 files / 2248 · integration 78 files / 1322**: exit 0
- drill:mock: exit 0, 불변식 위반 0
- dev-cert(`scripts/tests/test-dev-cert.sh`): 472/472
- deploy 셸 시험(`setpriv --reuid=nobody --regid=nogroup --clear-groups -- env HOME=/tmp TMPDIR=/tmp bash deploy/scripts/tests/run-all.sh`): PASS — check-env 75·fix3 30·fix4 65·fix5 37·restore-data 64·service-state 45·service-unit 12
- `./data` 없음(검사 전후 같음), `.env.local`·실제 계정·외부 호출 없음.
- not_run: 실제 Caddy + `next start` 배포, 실제 OIDC IdP·Threads 계정, 실제 PostgreSQL 다중 연결, Chromium 외 브라우저.

### 남은 위험
1. **H1 실제 배포 미확인(not_run)**: Caddy + `next start` 경로는 route 수준 시험(두 origin 모양)으로만 확인했다. 첫 배포 때 OIDC 로그인 한 번으로 확인한다.
2. 위험 표시 창: 표시를 붙이는 순간 이미 전송을 시작한 한 번의 시도는 끝까지 갈 수 있다(승인은 철회되고 재개 경로는 막힘).
3. 일반 승인 철회 화면(`/api/.../revoke`)은 아직 `partial_job_ids` 만 알려 주고, lease 된 부분 게시 작업을 따로 표시하지 않는다(항목 상태는 맞음 — PLANNED 아님).
4. 전사:
   - `keep_original=false` 재요청이 진행 중인 `keep_original=true` 작업과 겹쳐 409 를 받으면 원음을 지우지 않는다.
   - 원음을 지운 응답을 잃으면 재시도 응답에는 지웠다는 표시가 없다(정보만 빠짐).
   - `force:true` 동시 요청과 원음 삭제 사이의 경합은 worker 성공 경로와 같은 기존 창이다(`/record` 는 force 를 보내지 않음).
5. '난' lookbehind 는 '-가/-이'로 끝나는 다른 낱말(같이·아이 등) 뒤의 '난' 도 놓친다(주어 생략과 같은 받아들인 한계).
6. 실계정 연결이 origin 불일치일 때 오류 코드는 이제 `oauth_redirect_origin_mismatch` 다(설정 화면은 빠진 이름을 계속 보여 줌). — **대체(FIX2-FULLREV3 K1)**: 이제 정확 일치 검사이며 코드는 `oauth_redirect_uri_mismatch` 다(아래 FIX round 2).
7. `packages/db/scripts/migrate.ts` 가 `DATABASE_URL` 을 그대로 출력한다(FULLREV3 남은 위험 — Postgres 를 붙이기 전에 고칠 것).

### 검토자에게 물을 것
1. `callbackRedirectTarget` 이 `APP_BASE_URL` 의 경로 부분(있다면)을 버리고 origin 만 쓰는 것이 하위 경로 배포가 없다는 전제(D37)와 맞는가?
2. 전사 '최근 성공 작업 반환'이 사용자가 일부러 다시 전사하고 싶은 경우를 막지 않는가(화면에는 force 경로가 없음 — 필요하면 별도 작업)?

## FIX round 2 — FIX2-FULLREV3 (e1fdc02 Claude 독립 검토 K1–K3)

- BASE_SHA: `26601dc` (`26601dcab013579f09ade50bf34fa0bc5c387eb9`, docs) · **HEAD_SHA: `f7d4c3e`** (`f7d4c3e853dd36cb631bcfcaecb37b168af6f34a`)
- 출처: 사용자 지시 "계속 진행해줘" → 절차 9단계(새 커밋 재검증). `26b44c1..e1fdc02` 를 겹치지 않는 3개 영역(A 인증·OAuth·배포 문서, B 승인·게시·복원, C 작성·전사·도구)으로 나눠 새 컨텍스트·읽기 전용 검토자 3명이 검토했다(Claude 독립 검토, D42).
- 결과: P0·P1 0, 확정 P2 3건(K1–K3). 구현 서브에이전트 1명이 고쳤고, 보완분 재검토(1명)에서 P2 2건이 더 나와 주 세션이 고쳤다.

### 처리
- **K1 (A) 계정 연결 redirect 는 origin 만 비교**
  - 문제: 같은 origin 의 다른 경로(`/oauth/callback`)나 끝 `/` 는 연결 시작을 통과했다. 그 결과 동의 뒤 404 가 나거나 `oauth_redirect_mismatch` 로 끝나 연결을 마칠 수 없었다(FIX1-FULLREV3 H1 후속 이전부터 있던 문제).
  - 수정(`packages/domain/src/oauth.ts`):
    - `expectedOAuthRedirectUri` = `APP_BASE_URL` origin + `/api/oauth/callback`. OIDC 의 `expectedOidcRedirectUri` 와 같은 방식이다.
    - `oauthRedirectUriMismatch`·`assertOAuthRedirectUri` 는 정확 일치를 요구한다. 설정이 없으면 기본값이라 언제나 맞는다.
    - 준비 판정 이름은 `OAUTH_REDIRECT_URI(APP_BASE_URL/api/oauth/callback 과 다름)`, 연결 시작 거부는 503 `oauth_redirect_uri_mismatch` 다.
  - **오류 코드 변경**: FIX1-FULLREV3 의 `oauth_redirect_origin_mismatch` 를 대체한다(미병합 브랜치 안에서만 쓰였음). callback 정확 일치 방어선은 그대로다.
  - 문서: `deploy/README_KO.md` §4.1, `README_KO.md`, `docs/04`, `.env.example` 주석.
- **K2 (B) 이전 복원 확인 표시가 있는 보류 항목의 승인 무효를 '실행 전으로'로 안내**
  - 수정: `RevokedApproval.restoredReview` → `invalidated_approvals[].restored_review`. 복원 화면은 이 항목을 '실행 전으로'에 세지 않고 `restore-restored-review` 로 따로 안내한다(보류 그대로 — 다시 승인할 수 없음).
  - 복구 문구: 보완분 재검토 P2 를 반영해 `RESTORED_RETRY_RECOVERY`(FIX5-FULLREV T2 사용자 결정 — 채널에서 직접 확인해 **게시물이 없을 때만** 새 배포 계획으로 다시 승인)를 그대로 쓴다. 계정 kind 를 모르므로 MOCK 문구는 쓰지 않는다.
  - 옛 기록은 칸이 없으면 false 로 읽는다.
  - 범위: 이 상태는 지금 실제 복원 경로로는 만들어지지 않는다. 첫 복원의 재검사가 그런 승인을 `restore_stale` 로 먼저 철회하기 때문이다. 그래서 방어용 수정이고, 시험은 DB 를 직접 고쳐 상태를 만든다(기존 시험과 같은 방식, 시험 주석에 적음).
- **K3 (C) 기존 성공 작업 경로의 원음 삭제 감사가 원인 요청을 남기지 않음**
  - 수정: `deleteOriginalDetailed` 에 `trigger` 를 더했다. 요청 경로에서 지우면 `asset.delete_original`·`asset.delete_original_skipped` details 에 `trigger: 'request_existing'` 이 붙는다. worker 경로는 그대로(`{ job_id }`)다.

### 반박 검토 기록
- 영역 검토(3명): 확정 P2 3건(K1–K3). 기각한 후보(검토자 스스로 반박)는 각 보고의 'Refuted candidates' 에 있다.
  - A: callback 정확 일치와 Host 불신은 유지됨. `isPlainRedirectUri` 정규 표기 때문에 오탐 거부가 없음.
  - B: 전송 중 항목이 철회된 승인으로 게시되는 경로 없음(`beginSend` 재검사). 위험 시험·복원 시험 8/8.
  - C: 1인칭 정규식 재현율이 줄지 않고 선형이다. 원음 삭제 조건이 맞다. deploy 시험 수정은 약화가 아니다(비root 64/64).
- 보완분 재검토(1명): P2 2건.
  1. K2 문구가 '확인한 뒤 새 계획'으로 무조건 새 계획을 권해 사용자 결정(FIX5-FULLREV T2)과 어긋나고 중복 게시 위험이 있었다. 조건부 문구로 바꿨다. 주 세션이 변이 확인을 했다(옛 문구로 되돌리면 단위 시험 1건 실패).
  2. 이 인계 문서의 FIX round 1 남은 위험 6 이 옛 오류 코드를 적었다. 그 줄에 대체 표시를 붙였다.

### 시험
- 추가:
  - domain `oauth.test.ts` K1: 다른 경로·끝 `/`·`callback2`·대소문자·기본 경로 접두, 같은 값·설정 없음.
  - 통합 `oauth.test.ts`: 같은 origin 다른 경로 2종 → 503(JSON·폼 303), state·감사·외부 요청 0, 자격 증명 없음. 정확한 값을 직접 설정하면 연결된다.
  - `restore-view.test.ts` K2 3건, `fullrev3-restore-partial.test.ts` K2 `it.each`(brand_changed·risk_needs_check).
  - `fullrev3-client-ui.test.ts` K3: 삭제·건너뜀 감사 details 정확 일치, worker 경로는 trigger 없음.
- 바뀐 기존 단언(약화 없음): 오류 코드·준비 이름·함수 이름을 새 이름으로 바꿨다(같은 정확 일치). `invalidated_approvals` 정확 일치 `toEqual` 에 `restored_review: false` 를 더했다(강화).
- 변이 확인(구현자 보고): K1·K2(3곳)·K3 각각 되돌리면 새 시험이 실패하고, 원복 뒤 `cmp` 로 같음을 확인했다. K2 문구는 주 세션이 직접 했다.
- 보이지 않는 문자 검사(주 세션): 추가된 줄 0건.

### 명령
클라우드 Node 22.22.0, `f7d4c3e` 와 같은 트리. 단계별 종료코드 기준:
- install --frozen-lockfile(lockfile `8db0ef8abda74fda` 불변) · lint · typecheck · build: 각 exit 0
- **unit 88 files / 2250 · integration 78 files / 1328**: exit 0
- drill:mock: exit 0, 불변식 위반 0
- dev-cert: 472/472
- deploy 셸 시험(비root, `setpriv … env HOME=/tmp TMPDIR=/tmp bash deploy/scripts/tests/run-all.sh`): PASS — check-env 75·fix3 30·fix4 65·fix5 37·restore-data 64·service-state 45·service-unit 12
- `./data` 없음(전후 같음), `.env.local`·실제 계정·외부 호출 없음.
- not_run: 실제 Caddy + `next start` 배포, 실제 OIDC IdP·Threads 계정, 실제 PostgreSQL 다중 연결, Chromium 외 브라우저.

### 남은 위험
1. 저장소 밖에서 `oauth_redirect_origin_mismatch` 를 찾던 것이 있다면 새 코드 `oauth_redirect_uri_mismatch` 를 놓친다(미병합·미배포라 실제 영향 없음).
2. K2 는 지금 도달할 수 없는 상태를 막는 방어용 수정이다. 실제 복원으로 그 상태를 만든 시험은 없다.
3. K2 안내는 계정 kind 를 모르므로 모의 계정 항목에도 실제 채널 확인 문구를 쓴다(FIX5-FULLREV 'MOCK 문구는 코드가 구별할 수 있을 때만' 규칙대로).
4. FIX round 1 남은 위험 1·2·4·5·7 은 그대로다. 6 은 K1 로 코드가 바뀌었다.

### 검토자에게 물을 것
1. K1 준비 이름 `OAUTH_REDIRECT_URI(APP_BASE_URL/api/oauth/callback 과 다름)` 을 기존 `OAUTH_REDIRECT_URI(불일치)`(등록 redirect ≠ 설정값)와 따로 둔 것이 운영자에게 더 분명한가?

### f7d4c3e 재검증(Claude 독립 검토, 2026-11-07 — 사용자 지시 "계속 진행해줘", 절차 9단계)
- 새 컨텍스트·읽기 전용 검토자 1명이 `git show f7d4c3e` 를 검토했다(보완분 재검토 뒤 주 세션이 고친 K2 문구 포함).
- 결과: **확정 지적 0**(P0·P1·P2 없음).
- 확인한 것:
  - K1: 정규 표기 검사 때문에 맞는 값이 거부되지 않는다. 시험·drill 의 redirect 고정값이 모두 기대값과 같다. 옛 이름은 코드에 남지 않았다.
  - K2: `restoredReview` 는 `toPlanned` 가 빼는 분기와 정확히 같다. 문구는 `RESTORED_RETRY_RECOVERY` 를 그대로 쓴다.
  - K3: trigger 는 요청 경로에만 붙고 worker 경로는 그대로다.
  - 단언 약화와 보이지 않는 문자는 없다.
- 검토자 실행(단일 파일): `restore-view.test.ts`·domain `oauth.test.ts` 34/34.
- 스타일 메모(지적 아님): `docs/04` 의 K3 문장이 어색하다.

## 후속 — DB CLI 출력의 DATABASE_URL 제거(FULLREV3 남은 위험 7)

- BASE_SHA: `68e4854` (`68e4854b7ff46024fc25583f36c52eb9bf5a48ff`, docs) · **HEAD_SHA: `9f908f7`** (`9f908f7806a8ea1f3b621af154ff15c27a0a5dfb`)
- 출처: 사용자 지시 "1번 진행해줘"(2026-11-07). 대상은 FIX round 1 남은 위험 7 = FULLREV3 남은 위험(`migrate.ts:14` 가 `DATABASE_URL` 을 그대로 출력함).

### 처리
- `packages/db/src/db-label.ts`:
  - `databaseLabel(url)`:
    - PGlite 폴더 경로와 `memory://` 는 그대로 보인다.
    - `://` 가 있는 값은 `scheme://host[:port]` 만 남긴다(마지막 `@` 뒤, 첫 `/`·`?`·`#` 앞). URL 해석기에 맡기지 않는다. 해석기는 인코딩하지 않은 `/`·`?`·`#` 가 든 비밀번호를 경로로 읽어 내보내기 때문이다.
    - query 의 `=`, `://` 없는 값의 `=`·`@`(libpq 키워드 형식 포함), host 모양이 아닌 값은 `(숨김)` 이다.
  - `dbCliErrorLine(what, e)`: `DbLockedError`·`DbDriverNotImplementedError` 는 고정 문구(값 없음)를 그대로 쓴다. 그 밖은 `describeErrorSafely`(허용 이름 + 코드)만 쓴다.
- `packages/db/scripts/migrate.ts`·`seed.ts`:
  - 성공 출력은 `databaseLabel` 을 거친다.
  - 열기·seed·닫기 오류는 다시 던지지 않는다. Node 가 메시지·스택(파일 오류는 경로 = `DATABASE_URL`)을 찍기 때문이다. `dbCliErrorLine` 한 줄을 찍고 종료코드 1 로 끝난다.

### Claude 독립 검토(D42)
- 1차: P2 2건.
  - 인코딩하지 않은 `/`·`?`·`#` 비밀번호와 키워드 형식이 그대로 출력됐다.
  - 예상하지 못한 오류가 메시지·스택을 그대로 출력했다.
- 2차: P2 4건. 3건을 반영했다.
  - DB 닫기 오류가 보호되지 않았다.
  - 드라이버 미구현 안내가 사라졌다.
  - `user=` 키워드 형식이 그대로 출력됐다.
  - 1건은 남은 위험으로 둔다(표시 host 가 틀릴 수 있음).
- 3차: **확정 0**. 순환 import 없음, 모든 경로의 종료코드가 맞음, `e.message`·스택 출력이 남지 않음을 확인했다.
- 범위 밖으로 확인만 한 것: `export.ts`·`restore.ts`·`restore-drill.ts` 는 예상하지 못한 `openDb` 오류를 다시 던진다(같은 종류의 누출 가능성). 다른 출력 경로(worker·health·ops·check-env·config 오류)는 값을 찍지 않는다.

### 시험
- 새 단위 시험 `packages/db/src/db-label.test.ts` 8건:
  - 경로 그대로, postgres URL, 인코딩하지 않은 비밀번호 4종, query·키워드 형식 숨김, host 없음.
  - 두 스크립트가 helper 를 거치고 `throw e`·`e.message`·보호 없는 close 가 없음(소스 검사).
  - 오류 한 줄(EACCES 경로 미포함, 고정 안내 유지).
- 변이 확인(주 세션): 다음을 하나씩 되돌리면 시험이 각각 실패하고, 원복 뒤 `cmp` 로 같음을 확인했다.
  - 스크립트 연결 되돌림, 원래 URL 반환, query `=` 숨김 제거.
  - 키워드 형식 규칙 되돌림, 드라이버 미구현 고정 문구 제거, seed close 보호 제거.
- 실제 실행(주 세션):
  - `DATABASE_URL=memory://` 로 migrate·seed 를 돌려 정상 출력을 확인했다.
  - `DB_DRIVER=postgres DATABASE_URL='postgres://u:1234/abc@h/db'` 로 migrate·seed 를 돌리면 고정 안내 한 줄만 나오고 종료코드는 1 이다(URL 없음).

### 명령
클라우드 Node 22.22.0, `9f908f7` 와 같은 트리. 단계별 종료코드 기준:
- install(lockfile `8db0ef8abda74fda` 불변) · lint · typecheck · build: 각 exit 0
- **unit 89 files / 2258 · integration 78 files / 1328**: exit 0
- drill:mock 위반 0 · dev-cert 472/472 · deploy 셸 시험(비root) PASS
- not_run: 실제 PostgreSQL(드라이버 미구현), 실제 계정.

### 남은 위험
1. 표시 host 가 틀릴 수 있다(비밀은 아님). 마지막 `@` 기준이라 fragment 의 `@` 뒤를 host 로 보이고, pglite 드라이버로 postgres 모양 값을 열면 실제로는 로컬 폴더인데 `postgres://host` 로 보인다. 고치면 인코딩하지 않은 `/` 비밀번호가 다시 새는 쪽과 부딪쳐 두었다.
2. `=`·`@` 가 든 PGlite 폴더 경로는 `(숨김)` 으로만 보인다(정보만 줄어듦).
3. `export.ts`·`restore.ts`·`restore-drill.ts` 의 `throw e` 는 그대로다. Postgres 드라이버를 붙일 때 같은 `dbCliErrorLine` 으로 바꿀 것. — **해결(`3bc5729`)**: 아래 '후속 2'.
4. 일반 잠금 재시도 오류(`lock.ts` '잠금 파일을 만들지 못했습니다')는 이제 `Error` 로만 보인다.

## 후속 2 — export·restore·restore-drill·worker CLI 오류 출력(후속 남은 위험 3)

- BASE_SHA: `c253559` (`c253559a7be5133c04bc3f966d53c462cf139fb1`, docs) · **HEAD_SHA: `3bc5729`** (`3bc572948088ef34ebac13f9be88ee75d9da61fe`)
- 출처: 사용자 지시 "진행해줘"(2026-11-07). 위 '후속' 남은 위험 3.

### 처리
- `packages/db/scripts/export.ts`·`restore.ts`·`restore-drill.ts`:
  - `openDb` 실패와 예상하지 못한 오류를 다시 던지지 않는다. `dbCliErrorLine` 한 줄을 찍고 종료코드 1 로 끝난다.
  - DB 닫기 오류도 같다.
  - `restore.ts` 의 AppError 출력(코드·안내 문구)은 그대로다.
- `apps/worker/src/cli.ts`: DB 열기·닫기만 같은 방식으로 바꿨다. tick 안의 오류와 `assertWorkerModeSupported` 의 다른 오류(DB 전)는 범위 밖이다.

### Claude 독립 검토(D42)
- 1회(검토자 1명): P0·P1 0, P2 1건 — worker 의 DB 닫기가 그대로였고 시험도 그 경로를 보지 않았다.
  - 처리: 다른 세 스크립트와 같은 형태로 고치고 시험 단언을 더했다. 같은 형태라 별도 재검토는 하지 않았다(주 세션 변이 확인만).
- 검토자가 확인한 것:
  - 모든 경로의 종료코드가 같다(성공 0, 실패 1, restore 사용법 2).
  - restore AppError 출력이 바이트 단위로 같다.
  - 잃는 내부 오류 문구(export 의 절대 경로 검사 등)는 도달하지 않거나 방어용이다.

### 시험
- `packages/db/src/db-label.test.ts` 에 소스 검사 1건을 더했다(세 스크립트 + worker: 열기·닫기·예상 밖 오류 형태, `throw e`·`e.message`·`e.stack` 없음 — restore 의 AppError 줄 1개만).
- 변이 확인(주 세션):
  - 다음을 각각 되돌리면 시험이 실패했다: 네 파일의 열기 catch, restore 의 다시 던지기, worker 닫기.
  - 첫 시도는 시험 정규식이 틀려(조사 '을' 과 '를') 기준선부터 실패했다. 그 상태의 변이 결과는 버리고, 정규식을 고친 뒤 다시 했다.
- 실제 실행(주 세션):
  - `memory://`: export·restore-drill 은 owner 없음 안내로, restore preview 는 파일 없음 안내로 그대로 나왔다.
  - `DB_DRIVER=postgres` + postgres 모양 URL: export·restore-drill 은 고정 안내 한 줄, 종료코드 1 이었다.

### 명령
클라우드 Node 22.22.0, `3bc5729` 와 같은 트리. 단계별 종료코드 기준:
- install(lockfile `8db0ef8abda74fda` 불변) · lint · typecheck · build: 각 exit 0
- **unit 89 files / 2259 · integration 78 files / 1328**: exit 0
- drill:mock 위반 0 · dev-cert 472/472 · deploy 셸 시험(비root) PASS

### 남은 위험
1. worker tick 안에서 던진 오류는 여전히 Node 가 메시지·스택을 찍는다(범위 밖). — **해결(`e0d0817`)**: 아래 '후속 3'. tick 오류의 원천이 많아 일괄로 숨기면 진단이 어려워진다. 실제 Postgres·실계정을 붙이기 전에 따로 본다.
2. 내부 방어 오류(예: '묶음 경로가 폴더를 벗어났습니다')는 이제 `Error` 로만 보인다.

## 후속 3 — worker CLI tick·시작·준비 오류(후속 2 남은 위험 1)

- BASE_SHA: `4ad5123` (`4ad51233fcb15ef5c64ca005d7b4cc24b4e0feea`, docs) · **HEAD_SHA: `e0d0817`** (`e0d08173ceb77baf77030def3deb367a68033881`)
- 출처: 사용자 지시 "계속 진행해줘"(2026-11-07).
- 근거: drizzle-orm 0.45.3 의 `DrizzleQueryError` 메시지는 `Failed query: …\nparams: …` 로 쿼리 파라미터 값(봉인된 토큰·원고 내용 등)을 담는다. worker 내부(`packages/db/src/jobs.ts`)는 이미 이름만 찍었고, 노출 경로는 CLI 맨 위층(던진 오류를 Node 가 그대로 출력)뿐이었다.

### 처리(`apps/worker/src/cli.ts`)
- tick 오류: `catch` 에서 `dbCliErrorLine('worker tick 을 마치지 못했습니다', e)` 한 줄을 찍고 `exitCode = 1` 로 둔다(예전처럼 반복 모드도 멈춤). `finally` 의 DB 닫기는 그대로다.
- DB 를 연 뒤의 준비(어댑터·저장소·연결 정보 함수)를 보호된 `try` 안으로 옮겼다. 예: `STORAGE_DRIVER=object` 면 `createStorage` 가 던진다 → 한 줄 + DB 닫기.
- 시작 검사(`assertWorkerModeSupported`)의 다른 오류도 한 줄. 지금은 `WorkerModeError` 만 던지므로 미래 대비다.
- drizzle 쿼리 오류는 바깥 객체에 이름·코드가 없어 `Error` 로만 보인다. SQLSTATE 는 `cause` 안에 있지만 일부러 읽지 않는다(`describeErrorSafely` 는 바꾸지 않음).

### Claude 독립 검토(D42)
- 1차: P2 2건.
  - 시험이 이름을 흉내 낸 오류를 써서 실제 drizzle 오류 모양(`Error`, 코드 없음)과 달랐다. 주석도 'SQLSTATE 등'이라고 잘못 적었다.
  - `openDb` 와 `try` 사이의 준비 코드가 던지면 스택을 찍고 DB 를 닫지 않았다.
- 2차: **확정 0**.
  - 신호 처리·변수 범위·성공 경로(한 번, `--loop`, SIGINT)는 그대로다.
  - 타이머가 남아 프로세스가 멈추는 경우는 없다(모든 `setTimeout` 에 `clearTimeout` 이 짝지어 있음).
  - 시험은 실제 클래스를 쓰고 그 전제가 맞다.

### 시험
- `packages/db/src/db-label.test.ts`:
  - 실제 `DrizzleQueryError`(메시지에 파라미터 값이 있다는 전제를 먼저 확인)로 출력이 `Error` 한 줄이고 토큰·표 이름·파라미터·원인 문구가 없음을 확인한다.
  - worker 소스 검사: `throw e` 없음, tick catch·시작 오류 한 줄, `openDb` 와 `try` 사이에 준비 호출 없음, 준비 코드가 `try` 첫머리에 있음.
- 변이 확인(주 세션): 다음을 각각 되돌리면 시험이 실패했다: 준비 코드를 `try` 밖으로, tick 오류 다시 던지기, 시작 오류 다시 던지기.
  - 시험 작성 중 두 번 기준선이 실패했다. 한 번은 앞쪽의 다른 `try` 를 잡았고, 한 번은 주석 문구 'createStorage' 에 걸렸다. 그때의 변이 결과는 버리고 고친 뒤 다시 했다.
- 실제 실행(주 세션):
  - `memory://` 정상 tick → JSON 출력, 종료코드 0.
  - `STORAGE_DRIVER=object` → `worker tick 을 마치지 못했습니다(오류 종류: Error).`, 종료코드 1.
- 전체 검사 1회차에서 lint 가 실패했다(`no-regex-spaces` — 시험 정규식의 두 칸 공백). `{2}` 로 고치고 전체 검사를 처음부터 다시 돌렸다.

### 명령
클라우드 Node 22.22.0, `e0d0817` 와 같은 트리. 단계별 종료코드 기준:
- install(lockfile `8db0ef8abda74fda` 불변) · lint · typecheck · build: 각 exit 0
- **unit 89 files / 2260 · integration 78 files / 1328**: exit 0
- drill:mock 위반 0 · dev-cert 472/472 · deploy 셸 시험(비root) PASS

### 남은 위험
1. 오류 원인 진단이 어려워진다: drizzle 쿼리 오류는 `Error` 로만 보인다. 원인을 보려면 개발 환경에서 따로 재현해야 한다.
2. 맨 위의 `loadRootEnv`·`loadConfig` 오류는 그대로 스택을 찍는다(메시지에 값 없음 — 설정 이름·파일 경로만).
3. web 서버(Next) 쪽 route 의 처리되지 않은 오류 출력은 이번 범위 밖이다(inline worker 는 이미 허용 이름·코드만 찍음).
   - **확인(2026-11-07, 주 세션 grep — 코드 변경 없음)**:
     - API route 62개는 모두 `apiHandler`/`errorResponse`(처리하지 못한 오류는 `[api] 처리하지 못한 오류:<이름>` 만 찍음)를 거친다. 예외 4개도 안전하다: 모의 authorize 3개는 `oauthEndpoint` 감싸개를 쓰고, `/api/health` 는 자체 catch 가 있다.
     - 남는 경로는 화면(서버 컴포넌트) 렌더 중 처리되지 않은 오류다. Next 가 기본 로그로 메시지를 찍으므로, 그 오류가 DrizzleQueryError 면 쿼리 파라미터 값이 서버 로그(journalctl)에 남을 수 있다.
     - 화면 쿼리의 파라미터는 주로 owner id·검색어·원고 id 이고, 봉인된 토큰을 쓰는 쿼리(갱신·삽입)는 API·worker 경로에 있다. 그래서 낮음으로 본다.
     - 고친다면 `instrumentation.ts` 의 `onRequestError` 로는 Next 의 기본 출력을 막지 못한다. 화면별 DB 호출을 감싸거나 로그 수집 단계에서 걸러야 한다. 실제 Postgres·운영 로그 수집을 붙일 때 결정한다.
