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
