# FULLREV1 구현 인계 — 전체 코드 독립 검토 1차 FIX (FIX1-FULLREV)

- BASE_SHA: b533650 (전체 검토 1차 기록 docs, 그 앞 a0521fe) · **HEAD_SHA: af1d0b5** (`af1d0b56cbf8c5ce475517c62d8581d87af6349b`)
- 검토: `docs/handoffs/FULLREV1_CLAUDE_REVIEW.md` — 전체 코드 Claude 독립 검토 1차(Codex 아님). 확정 7건(F1·F2·F3 P1, F5·F6·F7·F9 P2), 기각 3건.
- 진행: 구현 에이전트 4묶음(A F1·F2 / B F3 / C F5·F6·F7 / D F9)이 순차로 구현했다. 고친 결과는 반박 검토를 3번 받았고, 확정된 지적은 매번 보완했다.
  - 1회차: 확정 1(P1) → 보완 1
  - 2회차: 확정 10(P1 2·P2 8, 중복 포함) → 보완 2
  - 3회차: 확정 2(P2)·기각 7 → 보완 3
  - 보완 3의 짧은 검토 결과는 아래 "보완 3 검토" 줄에 적는다.

## 지적 처리
- **F1** `packages/db/src/live-publish.ts` pendingLiveJobs: 보류(BLOCKED) 작업은 retryItem 으로 다시 보낼 수 있는 모양일 때만 센다. 조건은 셋이다.
  - 항목도 BLOCKED 다.
  - 그 작업이 항목의 최근 작업이다(created_at·id 내림차순).
  - 작업·항목 어디에도 restored_needs_review 가 없다.
  - 승인 철회·무효, beginSend approval_missing·snapshot_stale 로 항목이 PLANNED 로 돌아간 옛 작업은 세지 않는다. 전송 직전의 권위 있는 상한 검사(beginSend)는 그대로다.
- **F2** 일부 게시 뒤 승인 철회·무효:
  - revokeActiveApprovalsLocked 는 항목의 대기 작업(QUEUED·RETRY_WAIT, 보류 항목이면 최근 BLOCKED)에 publish·video 단계나 publish_attempt 표식이 있으면 항목을 PLANNED 로 되돌리지 않는다. 작업은 cancel_partial 로 UNKNOWN(`thread_partial_revoked`)이 되고, 항목도 UNKNOWN 이 된다. 승인은 그대로 철회된다.
  - 철회 응답(JSON `partial_job_ids`, HTML `revoked_partial=N`)과 화면 안내도 맞췄다. 계획 화면 머리줄은 job.lastErrorCode 를 먼저 본다.
- **F2 후속(보완 1~3)** 작업 처리기가 작업을 "보내지 않음"으로 끝내는 모든 곳에 같은 규칙을 둔다. 이미 게시된 단계나 게시 시도 표식이 있으면 CANCELED·FAILED{not_sent:true}·항목 PLANNED 대신 UNKNOWN 이다.
  - 판정은 `partialSendOf`(approval-invalidation.ts, export)가 하고, 처리는 `stopUnlessPartial`·`settlePartialStop`(jobs.ts)이 한다. 기존 JOB_TRANSITIONS 만 쓴다(domain 변경 없음).
  - 적용한 곳:
    - recoverExpiredLeases: LEASED 만료 한도, CANCEL_REQUESTED
    - beginSend: 취소 요청, approval_missing, snapshot_stale, validate_failed, attempts_exhausted
    - finishSend: 취소 3갈래
    - applyReconcile: CANCEL_REQUESTED + resumable·not_found
    - checkJob: CANCEL_REQUESTED(보내기 전 취소)
    - cancelItem·revokeActiveApprovalsLocked 는 같은 판정을 공유한다.
  - revokeActiveApprovalsLocked 는 항목의 LEASED 작업에 게시 단계가 있으면 항목을 PLANNED 로 두지 않는다(감사 `leased_partial_jobs`).
  - 사유 코드: 취소 경로 `thread_partial_cancel_requested`, cancelItem `thread_partial_canceled`, 승인 경로 `thread_partial_revoked`, 작업 처리기 자체 멈춤(시도 한도·사전 만료 한도·검증 실패) `thread_partial_stopped`(새 코드).
  - cancelRequestedAt 은 실제 취소일 때만 기록한다(사용자 취소·철회). 무효화·자체 멈춤은 null 이다. 그래서 뒤에 확인돼 CONFIRMED 가 되어도 "취소 불가(이미 전송됨)"로 보이지 않는다.
  - 화면: itemHeadline·liveItemHeadline 이 네 부분 게시 코드 모두 job.lastErrorCode 를 먼저 본다(옛 BLOCKED 사유에 가려지지 않음). thread_partial_stopped 는 원인(시도 한도 / 작업 처리기 중단 반복 / 검증 실패)을 BLOCKED 사유에서 이름 붙인다.
  - 아무것도 게시되지 않은 작업은 모든 곳에서 예전 결과 그대로다(시험으로 고정).
- **F3** 업로드 MIME:
  - 새 `packages/domain/src/media-mime.ts` 의 `normalizeMediaMime(type, fileName?)` 이 대소문자·매개변수(`;codecs=`)를 정리하고 별칭을 표준 형식으로 바꾼다. audio/x-m4a·audio/m4a → audio/mp4, audio/x-wav·audio/wave·audio/vnd.wave → audio/wav, audio/mp3·audio/x-mp3·audio/x-mpeg → audio/mpeg, video/x-m4v → video/mp4.
  - 형식이 비었거나 application/octet-stream 이면 확장자로 정한다. 허용되지 않는 선언 형식은 확장자로 덮지 않는다.
  - 브라우저는 `@cs/domain/media-mime` 하위 경로로 가져온다(바렐은 node:* 를 끌어옴).
  - 서버 planUpload 도 같은 함수를 써서 표준 형식만 저장한다. 바이트 검사(sniffMedia)는 그대로 최종 판정이다.
- **F5** `packages/domain/src/zip.ts` readZip: 기존 검사를 모두 돈 뒤 항목 데이터 구간을 정렬해 겹치면 `ZipFormatError('ZIP 항목의 데이터 구간이 겹칩니다')`. 이 검사는 복사·CRC 전에 하므로 복사량은 파일 크기를 넘지 않는다.
- **F6** `apps/web/lib/oauth.ts` mockTestParamsAllowed:
  - 기본 인자를 문자 그대로의 `process.env.NODE_ENV` 로 바꿨다. 빌드 때 고정된다.
  - 판정은 `isDevAuthAllowedForNodeEnv`(허용: 비어 있음·development·test)로 막는 쪽이다. 소스 모양 시험으로 고정했다.
- **F7** `packages/domain/src/content.ts` 검색 날짜: 왕복 확인을 한다. 2026-02-30·2026-04-31·2026-02-29·2100-02-29 는 거부하고, 2028-02-29 는 받는다.
- **F9** migration **0047**(`packages/db/drizzle/0047_fullrev_fix1_live_intent_idx.sql`, drizzle-kit generate): send_intents 부분 인덱스 2개.
  - `((sanitized_details->>'live_approval_ref'), job_id)`
  - `(owner_id, created_at)`
  - 둘 다 `where sanitized_details->>'live_approval_ref' is not null` 이다. 질의 문장은 그대로이고, 인덱스가 실제로 읽히는지 시험으로 확인한다.
  - 묶음 형식·복원 호환은 바뀌지 않는다(0046 묶음 → 0047 앱 복원 가능).
  - README_KO LIVE-P2 migration 안내를 0046·0047 로 고쳤다.

## 시험·확인
- 새 시험 파일: `revoke-thread-partial`·`live-orphan-blocked`·`upload-mime-alias`·`migration-0047`(integration), `media-mime`·`oauth-mock-params`(unit). 기존 파일에도 추가했다: distribution·ui-safety·upload-client·upload·content·zip 시험.
- 기존(추적) 시험 파일에서 지운 단언 0(upload-client.test.ts import 줄만 바뀜). 이번 변경 안에서 새로 만든 시험 중 보완 1의 잘못된 동작(cancelRequestedAt 기록)을 단언하던 2곳은 보완 3에서 더 엄격한 반대 단언으로 바꿨다.
- 변이 확인: 묶음·보완마다 고친 것을 되돌려 새 시험 실패를 확인하고 복원했다. 합계 60개 남짓으로, A 20·B 6·C 5·D 7·보완 1 6·보완 2 14·보완 3 3 이다. 모두 잡혔다.
- 명령(클라우드 Node 22.22.2, 오케스트레이터 순차 실행):
  - install --frozen-lockfile(lockfile 불변 `8db0ef8abda74fda`) · lint · typecheck · build PASS
  - **unit 83 files / 1974 · integration 56 files / 1047**
  - drill:mock 위반 0 · test-dev-cert.sh 271/271
  - 변경 파일 보이지 않는 문자 0 · `./data` 변화 없음
- 보완 3 검토: 짧은 반박 검토 1명(Claude, Codex 아님) — 확정 0(지적 없음). cancelRequestedAt 을 읽는 모든 곳·머리줄 원인 대응·바뀐 단언을 대상으로 했다.

## 차이·남은 위험
- 범위 확장: 처음 지적은 F2(철회·무효)였다. 검토에서 같은 불변식(게시된 부분을 "보내지 않음"이라 하지 않음)이 깨지는 다른 곳이 확정돼 함께 고쳤다. 그중 원래부터 있던 곳은 finishSend 취소, 실행 기한 초과·시도 한도 소진이다.
- 실제 계정: 게시 시도 표식 뒤 401·표식 늦은 기록과 동시 취소가 겹치면 CANCELED 대신 UNKNOWN 이 된다(보수적 — 다시 보내지 않음).
- `@cs/domain/media-mime` 클라이언트 번들은 build 로만 확인했다. 실제 브라우저에서 .m4a 선택·업로드는 미실행이다.
- migration 0047 은 CONCURRENTLY 가 아니다. 1인 PGlite 규모에서는 무해하다. 실제 Postgres 다중 연결은 미실행이다.
- 사용자 `./data` 는 다음 실행 때 0046·0047 이 함께 적용된다(서버 끈 상태, 백업 먼저).
- not_run: Codex, 실제 Postgres 다중 연결, 브라우저, Windows Git Bash·macOS, `./data` migrate·`drill:restore`, 실제 Threads·Claude.

## 검토자에게 물을 것
1. mock 스레드 일부 게시 뒤 finishSend 비취소 최종 실패(영구 거부·재시도 소진)는 지금도 FAILED 다. 화면에 '새 계획'이 열려 있어 다시 게시될 수 있다. 실제 계정의 표식 뒤 확정 거부는 FAILED 가 맞다. 이 mock 경우만 UNKNOWN 으로 바꿔야 하는가?
2. 부분 게시 UNKNOWN 카드의 상태 표시·작업 줄은 여전히 일반 문구("재확인 또는 새 계획 필요")다. 머리줄만 부분 게시 문구다. 상태 표시도 바꿔야 하는가?
3. 복원된 QUEUED·RETRY_WAIT 작업(→ BLOCKED)은 묶음에 remote_steps 가 없으면 cancelItem 이 CANCELED{not_sent:true} 로 끝낸다. 복원 작업은 "보내지 않음"을 증명할 수 없으므로 UNKNOWN 으로 둬야 하는가?
4. beginSend 취소 갈래(LEASED + cancelRequestedAt 이미 있음)는 settlePartialStop 이 처음 요청 시각을 지금 시각으로 덮어쓴다. 원래 시각을 지켜야 하는가?
