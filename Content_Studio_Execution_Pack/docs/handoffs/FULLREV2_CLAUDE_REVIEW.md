# 전체 코드 독립 검토 기록 2차 — content-studio/m4 09ddca0

- **Claude 독립 검토이며 Codex 판정이 아니다.** 사용자 지시(2026-10-25 "현재까지 모든 코드 리뷰 한번 더 진행해줘", 한도 중단 뒤 "계속 진행해줘"·"다시해줘")로 클라우드 세션에서 실행했다. Codex 상태는 바뀌지 않는다.
- 대상: HEAD 09ddca0(코드 c189319)의 `Content_Studio_Execution_Pack/` 제품 코드 전체(시험·문서 제외 358 files)와 시험·문서(맥락).
- 방식(1차는 한 번 훑기였고, 이번에는 나눠서 빠짐없이 읽었다):
  - 제품 파일을 겹치지 않는 영역 14개로 나눴다. 영역마다 읽기 전용 검토자 1명이 그 파일을 모두 읽었다.
  - 영역을 가로지르는 점검 8개(게시 끝에서 끝까지, 편집 → 승인 무효화, 전 route 권한, 비밀값 흐름, 모의/실제 분리, 복원 뒤 상태, 시간, 동시성)를 따로 돌렸다.
  - 지적마다 반박 검증을 붙였다. P0·P1 은 서로 다른 관점(코드 추적·다른 가드·명세)의 검증자 3명 중 2명 이상이 유지해야 확정이다. P2 는 세 관점을 함께 보는 검증자 1명이 유지해야 확정이다.
  - 검토 에이전트 79개, 결과 누락 0. 사용량 한도로 두 번 끊겼고, 끝난 결과는 그대로 둔 채 같은 입력으로 재개했다.
- 확정 P1 4건은 오케스트레이터가 해당 줄을 직접 다시 확인했다.
- 실행 범위: 정적 검토다. 시험·빌드·dev 서버·`./data` 는 쓰지 않았다. 일부 검증자는 짧은 node 실험을 돌렸다(정규식 판정, FormData boundary).
- 한계: P0 은 찾지 못했다. 그래도 빠짐없이 봤다는 보장은 없다 [추정]. 영역 검토자가 "훑기만 했다"고 적은 맥락 파일은 각 영역 기록(세션 scratchpad)에 남아 있다.
- 결과: 올라온 지적 41건 → 확정 35건(같은 원인 2쌍을 합쳐 **33건: P1 4·P2 29**), 기각 6건.
- 지적이 없었던 영역·점검: 승인·배포 도메인(A3), 스키마·migration(B4), 비밀값 흐름(X4), 시간(X7), 동시성·잠금(X8).

## 확정된 지적 — P1
| # | 심각도(검증자) | 위치 | 내용 |
|---|---|---|---|
| G1 | P1 (3/3 · 3/3, 두 영역이 따로 찾음) | `apps/web/scripts/next.mjs:12`, `package.json:11` | `pnpm dev` 가 `-H` 없이 Next 를 띄워 모든 인터페이스(0.0.0.0)에서 듣는다. 비밀번호 없는 dev 로그인의 'localhost 전용' 가드(`isLocalhostBaseUrl`)는 설정값만 보고, Origin 은 비브라우저가 위조할 수 있다. 그래서 같은 Wi-Fi·LAN 의 다른 기기가 owner 세션을 얻고 원고 열람·승인·실행(D39 실제 게시 포함)까지 할 수 있다. 전제: OS 방화벽이 3000 포트를 허용. T21_DEPLOY_REVIEW G1a 와 같은 원리가 로컬 dev 에 남은 것이다 |
| G2 | P1 (P1/P2/P1) | `apps/web/app/distribute/[id]/page.tsx:876`, `packages/db/src/distribution.ts` createPlan·approveItems | 같은 글(같은 초안 버전·계정·payload_hash)이 다른 계획에서 이미 실제 게시(CONFIRMED)됐거나 결과 불명(UNKNOWN)인데, 새 계획 만들기·승인·실행 화면 어디에도 중복 게시 경고가 없다. 서버도 다른 계획을 보지 않는다. docs/03:65-66("동일 본문 재게시는 경고 후 새 승인", "재전송 결정에 중복 가능성 표시") 위반이다. 게시된 파생본은 approved 로 남아 /distribute/new 에 다시 나온다 |
| G3 | P1 (3/3) | `packages/db/src/restore.ts:180` PARENTS | `generation_runs.variant_id` 와 `claims.variant_version_id` FK 가 부모 검사에서 빠졌다. add_missing 대상에서 채널 초안 AI 제안을 채택한 뒤 다시 내보낸 묶음, 또는 같은 원고에 Threads 초안이 따로 있는 대상이면, 즉시 FK 위반으로 트랜잭션이 중단된다. 그래서 미리보기·복원이 500 으로 끝나고 그 묶음은 쓸 수 없다. D6 의 "부모가 복원되지 않은 행은 충돌로 보고"와 다르다 |
| G4 | P1 (3/3) | `apps/web/lib/contents.ts:191`, `apps/web/app/api/captures/[id]/route.ts:128` | 409 충돌 HTML(원고 본문·원고 정보·카드·소재 긴 입력)이 `Referrer-Policy: no-referrer` 로 나간다. 그 화면의 "다시 저장" 폼 POST 는 브라우저가 `Origin: null`·Referer 없음으로 보내고, `assertSameOrigin` 이 CSRF 403 으로 거부한다. 충돌 뒤 내 입력을 저장할 길이 막힌다(A02) |

## 확정된 지적 — P2
| # | 위치 | 내용 |
|---|---|---|
| G5 | `packages/db/src/jobs.ts:1446` | 원격 처리 중 폴링 수와 확인 불가 수를 같은 `reconcileCount` 로 센다. 처리 중 조회 2회 뒤 확인 불가 1회만에 UNKNOWN 이 된다. D18 의 "확인 불가 3회째 UNKNOWN"과 다르다. 게시되지 않은 글이 결과 불명으로 남는다 |
| G6 | `packages/db/src/user-confirm.ts:76` | 사용자 확인(USER_CONFIRMED)이 다른 항목의 결과로 이미 기록된 Threads 외부 ID 를 그대로 받는다. 같은 본문의 두 계획 중 하나만 게시됐을 때, 결과 불명 항목의 후보가 남의 글이 되어 글 하나가 두 항목의 게시로 기록된다 |
| G7 | `packages/providers/src/threads-live-publish.ts:435` | 기록상 `finished` 인 컨테이너는 상태를 다시 묻지 않고 게시 시도 표식·threads_publish 로 간다. 중지·상한·연결 문제로 보류됐다가 24시간 넘게 지나 재시도하면, 이미 EXPIRED 인 컨테이너로 게시를 보내 '게시 없음 확정'이 결과 불명이 된다 |
| G8 | `packages/db/src/approval-invalidation.ts:526` | 계정 상태 변경(실제 게시 계정 사용 중지·재사용)의 승인 무효화가 진행 중(REMOTE_PROCESSING·RECONCILING) 항목의 승인은 남긴다. 토글을 되돌린 뒤 resume·not_found 로 다시 전송할 때 그 승인으로 게시한다. 대기 항목은 다시 승인해야 하는 것과 비대칭이다 |
| G9 | `packages/db/src/distribution.ts:276` snapshotProblems | 소재·아이디어의 위험 표시(`risk='needs_check'`, '확인 필요')를 계획·승인·실행·전송 직전 어디에서도 보지 않는다. 위험 표시 변경은 승인 무효화도 하지 않는다. docs/03:30("실행 직전 … risk … 다시 검사")과 다르다. 빼기로 한 결정 기록도 없다 |
| G10 | `apps/web/app/api/distribution-items/[id]/retry/route.ts:39` (+ `distribution-plans/route.ts:46`·`[id]/approve/route.ts:37`) | 계획 만들기·승인·재시도 JSON 응답이 실제 Threads 항목에도 `mode: 'MOCK'` 을 고정해 보낸다(같은 응답의 message·감사 기록은 실제) |
| G11 | `apps/web/app/settings/page.tsx:95` | 실제 게시 일시 중지·재개 완료 배너가 쿼리(`?live_publish=`)만 보고 뜬다. 다른 탭에서 상태를 바꾼 뒤 새로 고치면 저장된 스위치와 반대로 말한다 |
| G12 | `apps/web/app/distribute/[id]/page.tsx:614` | 작업 목록의 모든 작업 줄이 가장 최근 작업의 보류 사유(`block.code`)를 쓴다. 옛 BLOCKED 작업(예: 승인 철회)이 다른 사유로 보인다 |
| G13 | `packages/db/src/oauth.ts:1762` | 실제 Threads 계정의 연결 해제가 live OAuth 준비 설정 전체(OAUTH_MODE=live·앱 ID·시크릿·redirect·마스터 키·승인 기록)에 묶여 있다. 하나라도 빠지면 원격 철회가 원래 없는데도 로컬 삭제를 못 하고, `revoking`(incomplete)으로 계속 남아 장기 토큰 암호문도 남는다 |
| G14 | `packages/db/src/oauth.ts:376` | `revoking` 으로 남은 실제 계정에도 연결 시작을 허용한다. 콜백은 반드시 `credential_busy` 로 거부되지만, 그 전에 실제 60일 장기 토큰을 발급받고 버린다(Threads 에 철회 API 없음) |
| G15 | `apps/web/app/api/auth/login/route.ts:91` | AUTH_MODE=oidc 에서 POST /api/auth/login 이 요청마다 횟수 제한 없이 감사 행을 쓴다(사유 `identity_login_disabled`, 그리고 `oidc_cancelled`). 인증 없이 무제한으로 쓸 수 있어 audit_events 가 계속 커진다. 그 표를 훑는 로그인 판정이 전역 잠금 안에서 느려진다(색인 없음은 T21P1A Known risk) |
| G16 | `apps/web/lib/session.ts:37` (두 점검이 따로 찾음) | OIDC 허용 sub(AUTH_ALLOWED_SUBJECT)·issuer 를 바꿔도 기존 세션이 만료(기본 12시간, 최대 30일)까지 유효하다. 세션 검증은 AUTH_ALLOWED_IDENTITY 만 대조하고, 자료를 잃지 않고 세션을 일괄 폐기할 수단이 없다 |
| G17 | `apps/web/app/api/auth/login/route.ts:42` | 식별자 로그인이 소문자로 바꾼 Content-Type(boundary 포함)으로 multipart 를 파싱한다. Chrome·Safari FormData 요청은 항상 400 이고 실패 1회로 센다. 앱의 /login 폼(urlencoded)은 영향 없음 |
| G18 | `packages/db/src/restore.ts:520` | add_missing 이 기존('같음') 배포 항목에 새 활성 승인을 넣는다. 그런데 기존 계획 상태·파생본 lifecycle 은 다시 계산하지 않는다. 계획은 '초안'인데 실행 폼은 대기열에 넣고, 재승인은 409 already_approved 가 된다 |
| G19 | `packages/db/src/restore.ts:496` | add_missing 으로 더 높은 브랜드 프로필 버전이 들어와 현재 브랜드가 바뀌어도 기존 활성 승인을 무효화하지 않는다(D19 브랜드 훅 우회). 예약 시각에야 beginSend 가 brand_changed 로 조용히 막는다 |
| G20 | `packages/providers/src/llm.ts:56` (P2/P2, 1명 기각) | 1인칭 판별 정규식이 '저희'·'우리 ○○'·'저도'·'제게'와 괄호·꺾쇠·따옴표·`*` 뒤 대명사를 놓친다(node 확인). 실제 AI 가 claim 을 빼거나 fact 로 낸 경험 문단이 A03 게이트를 통과한다. 기각한 1명은 LIVEL1 남은 위험("정규식 휴리스틱 — 놓치는 표현에는 claim 이 생기지 않는다")에 포함된 것으로 봤다. 유지한 2명은 어휘·경계 누락은 기록된 범위 밖이라고 봤다 |
| G21 | `packages/db/src/writing.ts:569` | 실제 AI 실패 원인(llm_auth_failed·llm_not_found·llm_max_tokens·unverifiable_citation)이 일반 LlmFailedError 로 바뀌고 작성 패널은 run.error 를 그리지 않는다. 고칠 수 없는 실패를 사용자가 반복 재시도하며 매번 예약액이 확정된다 |
| G22 | `apps/web/lib/writing.ts:162` | budget_currency_mismatch(409)가 폼 경로에서 일반 conflict 로 바뀐다. 그래서 '다른 곳에서 먼저 저장되었습니다'로 보이고, 그 달 내내 AI 보조가 막히는 원인이 숨는다 |
| G23 | `apps/web/app/record/RecordClient.tsx:221` | 전사 수정 저장이 초안을 시작한 버전이 아니라 폴링으로 바뀐 최신 버전을 base_version 으로 보낸다. 그래서 `stale_transcript` 잠금이 무력화되고, 다른 탭의 수정이 최신 본문에서 조용히 빠진다 |
| G24 | `packages/db/src/uploads.ts:427` | 조립 중 서버 쪽 I/O 오류(ENOSPC·EMFILE 등)를 `assembly_failed` 거부로 처리해 세션을 rejected 로 굳히고 받은 조각을 모두 지운다. 최종 커밋 실패는 open 으로 되돌리는 것과 비대칭이다 |
| G25 | `apps/web/app/record/RecordClient.tsx:204` | 업로드 완료 뒤 전사 요청만 실패해도 이어 올리기 키를 먼저 지운다. '받은 곳부터 이어 올립니다' 안내와 달리 전체 파일을 다시 올리고 조립해야 한다 |
| G26 | `packages/domain/src/imports.ts:762` | Markdown 첫 제목 추출 정규식이 3제곱 백트래킹(ReDoS)이다. 2KB `.md` 하나로 이벤트 루프가 약 6초, 4KB 면 약 45초 멈춘다. 가져오기 ZIP 미리보기·확정에서 파일마다 돈다. T18 의 htmlToText ReDoS 수정과 같은 종류가 빠졌다 |
| G27 | `packages/db/src/imports.ts:433` | '새 버전'(가져오기)·'고쳐진 글'(수집)로 같은 출처에 붙은 소재들이 목록에서 '정확 중복 있음'으로 표시된다. 상세 화면·D4 정의와 모순이다 |
| G28 | `apps/web/lib/captures.ts:7` | 빠른 수집 폼 본문 상한 128KiB 가 원문 20,000자 허용치보다 작다(한국어 1자 = urlencoded 9바이트). 유효한 한국어 입력이 413 으로 거부되고 입력이 사라진다 |
| G29 | `packages/db/src/contents.ts:384` | 본문이 그대로인 저장도 새 버전을 만든다. 그래서 그 원고 항목의 활성 승인이 철회되고 모든 파생본이 stale 이 된다(예약 실제 게시가 내용 변경 없이 나가지 않음) |
| G30 | `packages/db/src/retention.ts:377` | 보존 정리 적용이 사용자가 확인한 미리보기가 아니라 새로 세운 계획으로 지운다. 미리보기에 없던 백업 ZIP·풀어 둔 폴더가 확인 없이 지워질 수 있다 |
| G31 | `apps/web/app/api/brand/route.ts:37` | Brand Profile 폼 저장 충돌 시 비교 화면 없이 리다이렉트해 입력을 잃는다(원고·소재는 409 비교 화면이 있음) |
| G32 | `packages/domain/src/content.ts:205` | 검색어 조각을 앞 8개로 조용히 자른다. 9번째 이후 단어가 없는 결과가 섞이고 안내도 없다 |
| G33 | `deploy/content-studio.service:48` | 데이터 볼륨이 마운트되지 않아도 서비스가 시작된다. 그래서 루트 디스크의 빈 마운트 지점에 새 DB 를 만들고 쓴다(`.data-must-be-mount` 는 백업·복원 스크립트만 확인). `RequiresMountsFor` 없음 |

## 기각된 지적 (반박 근거)
- **`packages/db/src/remote-steps.ts:113` — 컨테이너 준비 중 승인 철회·취소가 커밋돼도 threads_publish 를 보냄 (P1 제기, 3/3 기각)**
  - 동작은 사실이다. 그러나 docs/03:31 이 승인 재검사 지점을 SENDING 전환 트랜잭션으로 정했고, "SENDING 이후 철회는 CANCEL_REQUESTED 로 추적, 원격까지의 원자적 취소는 보장하지 않음"이라고 적었다.
  - A11 시험(jobs.test.ts:466·:486)이 `cancel_too_late` → CONFIRMED 를 고정한다. 게시되는 글은 beginSend 가 검증한 그 스냅샷이다.
- **`packages/db/src/restore.ts:355` — 복원이 실제 계정 state=connected 와 실행 전 승인을 들여와, 새 환경에서 다시 연결만 하면 실행됨 (P1 제기, 3/3 기각)**
  - D17(6)(승인 hash 그대로 복원 + 재검사), D24(복원 후 '다시 연결 필요'), D25-1(같은 계정 재연결은 승인 유지)이 겹친 결정된 동작이다.
  - 새 환경에서도 PUBLISH_MODE·승인 기록 설정, OAuth 재연결, 실행 클릭이 모두 따로 필요하다. D39_CLAUDE_REVIEW livep2-safety Q4 에서 받아들였다.
- **`packages/db/src/jobs.ts:940` — D36 오래 지난 예약 보류가 attempt 0 에만 적용 (기각)**: D36 이 "첫 전송 시점"으로 정했고, T21P2 인계·시험이 attempt>0 면제를 고정했다.
- **`packages/providers/src/threads-live-publish.ts:547` — 게이트가 닫히면 게시 기록이 있어도 조회가 unknown (기각)**: LIVEP1 인계 2번의 의도된 두 번째 방어선이다. 닿으려면 게시 기록 직후 1~2초 안의 프로세스 중단과 환경 설정 변경이 겹쳐야 한다.
- **`apps/web/lib/distribution.ts:58` — 실제 일반 결과 불명 카드의 상태 태그 문구 (기각)**: FIX2-FULLREV Q2·FIX3 R3 에서 그대로 두기로 기록했다. 같은 카드의 머리줄·안내가 조건부 복구를 정확히 말한다.
- **`apps/web/lib/oauth.ts:53` — OAUTH_MODE=live 에서 모의 연결 정보 다시 채우기 건너뜀 (기각)**: README_KO.md:439 와 M4DEV1 인계(Codex PASS)가 "OAUTH_MODE=mock 일 때만"으로 정한 동작이다. 모의 계정이 안전한 쪽(다시 연결 안내)으로 실패한다.

## 권고 (다음 FIX 묶음 제안 — 사용자 결정 전)
1. **FIX1-FULLREV2 (P1 + 게시 안전 P2):** G1·G3·G4 는 바로 고칠 수 있다(dev hostname 127.0.0.1 기본, PARENTS 두 줄 + FK 대조 시험, 409 Referrer-Policy `same-origin`). G2 는 결정이 필요하다. 이어서 G5·G6·G7·G8.
2. **FIX2-FULLREV2 (계정·로그인·복원·배포):** G13·G14·G15·G17·G18·G19·G33. G16 은 sessions 에 정책 지문 열을 추가하는 migration 이 필요하므로 결정 뒤에 한다.
3. **FIX3-FULLREV2 (화면·데이터 품질):** G10·G11·G12·G21·G22·G23·G24·G25·G26·G27·G28·G30·G31·G32.
4. **사용자 결정이 필요한 것:**
   - G2: 중복 게시를 경고만 할지, 실제 계정은 서버에서 확인값(예: acknowledge_duplicate)까지 요구할지.
   - G9: 위험 표시 'needs_check' 가 승인·실행을 막을지, 경고만 할지, 게시와 무관한 메모로 둘지. 무관하게 두면 docs/03:30 을 고치고 결정을 기록한다.
   - G16: 세션 정책 지문(migration) 또는 일괄 세션 폐기 수단.
   - G20: 정규식을 넓힐지, 받아들인 위험으로 둘지(오탐은 확인 대상만 늘린다).
   - G29: 변경 없는 저장을 새 버전 없이 끝낼지(메모만 있는 저장의 처리 포함).
