# 전체 코드 Claude 독립 검토 3차(FULLREV3)

- 대상: 브랜치 `content-studio/m4` HEAD `bc0e864`(코드 = FIX1~4-FULLREV2·OWNTEXT 이후). 사용자 지시 "계속 진행해줘" → 선택 "전체 코드 검토 3차"(2026-11-07).
- **Claude 독립 검토**(D42 — Codex 아님). 검토자·검증자는 모두 새 컨텍스트 서브에이전트, 읽기 전용(검증자 일부가 scratch 에서 node·Chromium·Next 실험).
- 방식:
  - FULLREV2 기준점 `09ddca0` 이후 바뀐 제품 파일 약 80개를 겹치지 않는 5개 영역으로 나눠 검토했다(A 게시 파이프라인, B 복원·보존, C 인증·OAuth·배포, D 작성·LLM·원고, E 수집·업로드·가져오기).
  - 여기에 가로지르는 검토 2개를 더했다(X1 저장소 전체 불변 조건, X2 시험 단언·문서 정합).
  - 지적마다 반박 검증을 붙였다. P0·P1 은 서로 다른 관점(코드 추적·방어 장치·명세)의 3명 중 2명이 유지해야 확정하고, P2 는 1명이 유지해야 확정한다.
  - 검토자 7 + 검증자 11 = 에이전트 18.
- 결과: **확정 8건(P1 1·P2 7), P0 없음, 기각 1건**(+ 검토자 단계 기각 다수).

## 확정
| 번호 | 심각도 | 위치 | 내용 | 검증 |
|---|---|---|---|---|
| H1 | **P1** | `apps/web/app/api/auth/oidc/callback/route.ts:93`, `apps/web/app/api/oauth/callback/route.ts:34` → `packages/db/src/oauth.ts:570`, `deploy/content-studio.service:37` | 문서대로 운영 배포(`next start --hostname 127.0.0.1` + Caddy)하면 route handler 의 `request.url` 이 `https://localhost:3000/…`(호스트는 서버 설정, 스킴만 X-Forwarded-Proto)라 `requestRedirectTarget(request.url)` 이 `OIDC_REDIRECT_URI`·`OAUTH` redirect 와 절대 같지 않다. 그래서 OIDC 로그인은 항상 `oidc_invalid/redirect_mismatch`(로그인 실패로 셈 → 10회 뒤 15분 잠김)이고, 계정 연결도 항상 `oauth_redirect_mismatch` 다. 운영에서는 dev 로그인이 막혀 OIDC 가 유일한 로그인 수단이라 아무도 로그인할 수 없다. | 3명 중 2명 유지(코드 추적: 설치된 Next 로 실제 `next start` 실험 재현, 방어 장치: Caddyfile·next.config·미들웨어에 보정 없음). 명세 관점: T21-P1b 인계 74행에 '확인하지 않았다 — 첫 배포 때 확인 필요'로 적혀 있었으나 deploy README 남은 위험에는 없다. 이번 실험으로 확정 실패가 됐다. |
| H2 | P2 | `packages/db/src/approval-invalidation.ts:581-602` (`invalidateApprovalsForRisk`), 주석 `:62-69`·`packages/db/src/distribution.ts:316-325` | 전송 중(SENDING·REMOTE_PROCESSING·RECONCILING·CANCEL_REQUESTED) 항목은 '확인 필요' 표시가 승인을 철회하지 못한다(REVOCABLE 상태만 봄). 표시를 지운 뒤 조회 재개(resumable·not_found → RETRY_WAIT → beginSend) 하면 새 승인 없이 원래 승인으로 게시된다. D40-2 '표시를 붙이면 승인 무효, 지워도 되살아나지 않음' 위반이며 G8(계정)과 같은 모양이다. | 3명 모두 유지(P2 — 게시 내용은 승인한 그대로, 사용자가 표시를 붙였다 지워야 하는 좁은 시점) |
| H3 | P2 | `packages/db/src/restore.ts:149,558-581`, `apps/web/app/settings/restores/[id]/page.tsx:138-151` | 복원(D41)이 승인을 무효화할 때, 일부 게시된 작업은 UNKNOWN(thread_partial_revoked)이 된다. 그런데 `invalidated_approvals` 는 `partialJobIds` 를 버리고, 화면은 모두 '실행 전으로 — 다시 계획·승인'이라고 안내한다(일반 철회 경로의 `revoked_partial` 과 다름). | 1명 유지 |
| H4 | P2 | `packages/providers/src/llm.ts:70-91` | 1인칭 판별이 축약형 '우린'·'난 '·'내겐'·'제겐'·'저한텐'·'나한텐'·'우리한텐'·'저 혼자'·'나 혼자'·'우리끼리' 를 놓친다(실제 실행으로 확인). 모델이 경험 표시를 빠뜨리면 지어낸 경험 문단이 A03 게이트를 통과한다. 수용된 위험(주어 없음·오탐)과 다르다. | 1명 유지(낮음) |
| H5 | P2 | `apps/web/lib/contents.ts:252`(본문)·`:286`(필드)·`:337`(브랜드), `apps/web/lib/captures.ts:117` | 409 충돌 화면의 `<textarea>${esc(v)}</textarea>` — HTML 규칙상 여는 태그 바로 뒤 LF 하나가 버려져, 다시 저장하면 본문 맨 앞 빈 줄 하나가 사라지고 내용이 다른 새 버전이 생긴다(Chromium 재현). | 1명 유지(낮음) |
| H6 | P2 | `apps/web/app/record/RecordClient.tsx:270-287,416`, `packages/db/src/transcription.ts:106-113` | 전사 요청이 서버에 들어갔는데 응답을 잃으면(fetch 오류·커밋 뒤 5xx) '전사만 다시 요청'이 남는다. 폴링 목록에 그 작업이 보여도 버튼을 거두지 않는다. 첫 작업이 끝난 뒤 재시도하면 같은 asset 에 작업·비용 예약이 하나 더 생긴다(G25 재검토 수정의 의도와 어긋남). 지금은 모의 예산이지만 실제 STT 면 이중 과금이 된다. | 1명 유지 |
| H7 | P2 | `docs/06_AGENT_WORKFLOW.md` §2 6단계 | D42 로 새로 쓴 전체 검사 목록에 deploy 셸 시험(`deploy/scripts/tests/run-all.sh`, root 거부 — 비root 실행 필요)이 없다. G33 마운트 검사 변경은 gate 에서 전체 deploy 시험을 통과한 적이 없다. | 1명 유지 |
| H8 | P2(낮음) | `/.ai/handoff/README.md`, `/.claude/commands/claude-task.md` | README 는 `/claude-task` 가 `task-<ts>.md` 를 쓴다고 하지만 명령에는 그 단계도, Write 도구도 없다. 4단계 '되돌린다'도 도구가 없다(D42 전환 때 생긴 불일치). | 1명 유지 |

## 기각(검증 단계)
- X2-F1 `duplicate_ack_required` 가 승인된 항목에서 false: 승인된 항목도 상태가 PLANNED(별도 승인 행)라 플래그는 실행 전까지 true 다. 서버 409·화면 체크박스와 일치하므로 결함이 아니다.

## 남은 위험으로 기록(확정 아님)
- `packages/db/scripts/migrate.ts:14` 가 `DATABASE_URL` 을 그대로 출력한다. 지금은 PGlite 경로라 무해하지만, Postgres(DSN·비밀번호)를 붙이는 순간 비밀이 출력된다(X1).
- X1(불변 조건)은 확정 0이다. 다만 YouTube·Instagram 모의 어댑터·수집기·인증 라우트·대부분 화면은 grep 외에 직접 읽지 않았다.

## 권고 수정 묶음(FIX1-FULLREV3)
1. H1: 두 콜백의 대상 URL 을 `request.url` 대신 `APP_BASE_URL` origin + 요청 pathname 으로 만든다(정확 일치 유지, Host·X-Forwarded-Host 를 믿지 않음). 운영 형태(`request.url` 호스트 127.0.0.1/localhost)를 흉내 낸 회귀 시험을 넣고, deploy README·T21P1B 위험 기록을 갱신한다.
2. H2: `invalidateApprovalsForRisk` 가 계정 훅처럼 전송 중 상태를 포함한다. 주석 2곳을 고치고, 전송 중 표시 → 해제 → 재개 시험을 넣는다.
3. H3: 복원 보고에 `partial_job_ids` 를 넣고 화면 문구를 나눈다.
4. H4: 축약형 어휘를 더한다(`난` 은 경계 필요).
5. H5: 충돌 화면 textarea 4곳에 여는 태그 뒤 `\n` 을 넣는다.
6. H6: 폴링 목록에 그 asset 의 작업이 보이면 '전사만 다시 요청'을 거둔다. 서버도 같은 asset 에 최근 성공 작업이 있으면 그 작업을 돌려준다(또는 command_key).
7. H7·H8: 절차 문서·명령을 고친다(deploy 시험은 비root 로 실행).
- 결정이 필요한 것: 없음(모두 기존 결정 범위 안의 결함 수정). H6 서버 쪽 방식(최근 성공 작업 반환 vs command_key)은 구현 때 단순한 쪽을 고르고 인계에 적는다.
