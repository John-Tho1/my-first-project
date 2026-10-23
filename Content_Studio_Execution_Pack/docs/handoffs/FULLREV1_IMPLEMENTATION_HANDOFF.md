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

# FIX round 2 (FIX2-FULLREV — "검토자에게 물을 것" 1~4 사용자 결정)
- BASE_SHA: 2915097 (FULLREV1 인계 docs) · **HEAD_SHA: 13f29b3** (`13f29b34b192f40065a2b9753a85d102b28e75de`)
- 사용자 결정(2026-10-22 "다 권고 사항으로 진행해줘"): 위 질문 1~4 모두 권고안대로 정했다.
- 진행:
  - 구현 에이전트 1명이 결정 4건을 구현했다.
  - 고친 결과를 반박 검토 3관점(상태·화면·시험, Claude — Codex 아님)으로 봤다. 확정 5(P2)·기각 2 → 보완 FX1~FX5.
  - 보완 부분을 짧게 다시 검토했다. 확정 3(P2, 중복 1) → 오케스트레이터가 FX6 을 직접 고쳤다.
- 결정 처리:
  - **Q1** 이미 게시된 부분(publish·video 단계, 표식은 세지 않음)이 있는 작업의 최종 실패는 FAILED 대신 UNKNOWN(새 코드 `thread_partial_failed`)이다. 대상:
    - finishSend: 영구 거부, 재시도 소진
    - applyReconcile: remote_failed(publish 만 셈 — YouTube 거부는 FAILED 그대로, T15 D27), not_found 한도
  - Q1 전이는 기존 전이만 쓴다. SENDING → blocked → cancel_partial, RECONCILING·REMOTE_PROCESSING → reconcile_unsupported 이다. 게시 0 은 FAILED 그대로다(실제 계정의 표식 뒤 확정 거부 포함 — 시험).
  - FX2: 조회 한도(RECONCILE_MAX_ATTEMPTS·REMOTE_POLL_MAX)에 걸린 부분 게시 작업은 `thread_partial_unresolved`(게시 0 은 그대로)다.
  - **Q2** `unknownKindOf`(partial = 부분 게시 코드 6종, restored_unverified)로 고른다. 대상은 상태 태그(`itemStatusText`), 작업 줄(`jobStatusText`·`jobStatusTextFor`), 스냅샷 안내, 실제 결과 불명 안내다.
    - 모두 "새 계획 필요"·새 계획 권유가 없다. 일반 UNKNOWN 문구는 그대로다.
    - 모의 카드는 "채널에서 직접 확인"(할 수 없음) 대신 모의 문구다(FX4·FX6).
    - 실제 카드의 스냅샷 안내는 "게시됐거나 게시됐을 수 있는"이다(FX3).
  - **Q3** 복원한 작업(작업 또는 항목의 restored_needs_review)의 취소는 `restoredCancelNotSentProven`(domain)이 증명할 때만 CANCELED not_sent 다. 증명 조건은 둘 중 하나다.
    - 의도가 없다.
    - 모든 의도가 rejected 이고, 게시 증거 단계가 없고, 단계 기록을 쓰는 어댑터면 단계 행이 있다.
    - 증명하지 못하면 UNKNOWN(`restored_cancel_unverified`)이고, 다시 보내지 않는다. 0031 이전 묶음은 단계가 없을 수 있어 보수적으로 판정한다.
  - **Q4** `transitionJob` 이 cancelRequestedAt 을 coalesce 로 쓴다. 처음 요청 시각을 지킨다.
- 바뀐 기존 단언: `threads.test.ts` "2번째 게시물 400 → FAILED" 1곳이다. Q1 이 바꾸는 동작이라, 같은 강도 이상인 UNKNOWN·사유 코드·사건 모양·항목 상태 단언으로 바꿨다. 그 밖의 추적 시험 파일에서 지운 단언은 0(import 줄만)이다.
- 변이 확인: 구현·보완마다 되돌려 새 시험 실패를 확인했다(FX6: 모의 부분 줄 분기 제거 → 단위 2·통합 3 실패, 복원 모의 분기 제거 → 렌더 시험 1 실패 — 이전에 늘 통과하던 단언을 `<strong>` 작업 줄로 좁힘). 모두 복원 뒤 cmp 일치했다.
- 명령(클라우드 Node 22.22.2, 오케스트레이터 순차 실행, 13f29b3 과 같은 코드):
  - install --frozen-lockfile(lockfile 불변 `8db0ef8abda74fda`) · lint · typecheck · build PASS
  - **unit 83 files / 1990 · integration 58 files / 1063**
  - drill:mock 위반 0 · test-dev-cert.sh 271/271
  - 변경 파일 보이지 않는 문자 0 · `./data` 변화 없음
- 남은 위험:
  - Q3 는 0031 이후 묶음에서 단계 없이 끝난 작업(예: 컨테이너 생성 401)도 UNKNOWN 이다(보수적).
  - reconcile 경로로 UNKNOWN 이 된 thread_partial_failed 는 BLOCKED 사건이 없어 머리줄 원인이 일반 문구다.
  - 영상(video) 단계 계산 분기는 지금 어댑터로 닿지 않는다(방어용, 미시험).
- 검토자에게 물을 것:
  1. 복원 묶음의 migration 수준을 작업마다 기록해 0031 이후 묶음의 단계 없는 작업은 not_sent 로 끝낼 수 있게 해야 하는가?
  2. 취소 HTML 경로가 UNKNOWN 결과(부분 게시·복원 미확정)에도 `cancel_requested=1` 로 돌아간다. 전용 안내가 없는데, 따로 둬야 하는가?
  3. 실제 부분·복원 미확정 안내는 Threads 에 글이 실제로 없을 때의 복구 길(새 계획)을 말하지 않는다. 이 문구로 괜찮은가?

# FIX round 3 (FIX3-FULLREV — FIX round 2 "검토자에게 물을 것" 1~3 사용자 결정)
- BASE_SHA: a3af045 (FIX round 2 인계 docs) · **HEAD_SHA: a9873af** (`a9873afdf10ee09d44fae30a7addd948125f3291`)
- 사용자 결정(2026-10-23 "다 권고 사항으로 진행해줘"). 오케스트레이터가 권고안을 정해 알린 뒤 진행했다.
- 진행: 구현 에이전트 1명이 구현했고, 반박 검토 2관점(취소 경로·안내 / 실제 계정 문구, Claude — Codex 아님)에서 지적 0건이었다.
- 결정 처리:
  - **R1** (질문 1, 복원 묶음 migration 수준을 작업마다 기록): **하지 않는다.** 작업마다 새 칸과 migration(0048)이 필요한데 드문 경우이고, 지금의 보수적 UNKNOWN(다시 보내지 않음)이 안전하다. 받아들인 제약이다: 0031 이후 묶음에서 단계 없이 끝난 복원 작업(예: 컨테이너 생성 401)도 취소하면 UNKNOWN(`restored_cancel_unverified`)이다.
  - **R2** (질문 2): HTML 취소가 UNKNOWN 으로 끝나면 `cancel_unknown=1&cancel_item=<항목>&cancel_reason=<허용 목록 코드>` 로 돌아간다(`cancelRedirectQuery`).
    - 계획 화면은 `cancelUnknownBannerOf` 로 저장된 상태를 확인한 뒤에만 전용 안내(`CANCEL_UNKNOWN_BANNER`)를 보인다. 확인 조건은 넷이다: 항목이 이 계획의 것, 항목·최근 작업이 UNKNOWN, 작업에 cancelRequestedAt 있음, 문구는 모의·실제·종류별.
    - 질의 글은 화면에 그대로 내지 않는다. `canceled=1`·`cancel_requested=1`·JSON 응답은 그대로다.
  - **R3** (질문 3): 실제 계정 카드에만 조건부 복구 줄을 둔다. 문구는 "Threads 에서 이 글이 없음을 직접 확인한 경우에만 새 배포 계획으로 다시 승인"이고, `LIVE_UNKNOWN_GUIDANCE_BY_KIND`, 실제 스냅샷 안내, 부분 게시 6코드·복원 미확정의 실제 머리줄 끝(`LIVE_UNKNOWN_HEADLINE_RECOVERY`)에 들어간다.
    - 부분 게시는 「Threads에서 확인함」(카드에 보일 때)을 가리킨다. 복원 작업은 user-confirm 이 거부하므로 그 버튼을 가리키지 않는다.
    - 모의 카드·상태 태그·작업 줄은 그대로다(모의 스레드는 여러 게시물이라 새 계획을 권하지 않음).
- 바뀐 기존 단언: FIX2 에서 "실제 카드에 '없을 때만 새 배포 계획으로 다시 승인' 없음"을 고정한 단언과 실제 머리줄 정확 문구 단언을 R3 결정에 따라 바꿨다. 새 정확 문구 `toBe` 와 "모든 '새 배포 계획'은 '없을 때만 ' 바로 뒤에만" 세기 검사로 교체했고, 모의 카드에는 여전히 없음을 단언한다. 그 밖의 단언 제거 0 이다.
- 변이 확인: 12개(+시험 강화 1) 모두 잡혔고, 복원 뒤 cmp 일치했다.
- 명령(클라우드 Node 22.22.2, 오케스트레이터 순차 실행, a9873af 와 같은 코드):
  - install --frozen-lockfile(lockfile 불변 `8db0ef8abda74fda`) · lint · typecheck · build PASS
  - **unit 83 files / 2002 · integration 59 files / 1069**
  - drill:mock 위반 0 · test-dev-cert.sh 271/271
  - 변경 파일 보이지 않는 문자 0 · `./data` 변화 없음
- 남은 것(구현 에이전트 질문, 손대지 않음):
  1. 실제 머리줄에도 조건부 줄을 둘지, 안내·스냅샷 안내에만 둘지 정해야 한다. 지금은 셋 다 있어 카드에 3번 나온다.
  2. 복원 작업 user-confirm 거부 문구(`user_confirm_restored`)가 아직 조건 없이 "새 배포 계획을 만드세요"다.
  3. 계정 없는 항목의 취소 JSON 문구(실제 쪽 조심 문구)와 카드·안내(모의 문구)가 다르다(이전부터).
  4. plan_id 없이 보낸 취소는 /distribute 로 돌아가 안내가 없다(이전부터).

# FIX round 4 (FIX4-FULLREV — FIX round 3 "남은 것" 1~4 사용자 결정)
- BASE_SHA: d3eb1f3 (FIX round 3 인계 docs) · **HEAD_SHA: fc74b3a** (`fc74b3aae5795b63c1385b84b9460757c4c249cb`)
- 사용자 결정(2026-10-23 "다 권고 사항으로 진행해줘"). 오케스트레이터가 권고안 S1~S4 를 알린 뒤 진행했다.
- 진행: 구현 에이전트 1명이 구현했다. 반박 검토 2관점(이동·소유자 / 문구, Claude — Codex 아님)에서 지적 5건이 나왔고 확정 0·기각 5다. 기각 사유는 모두 이번 변경 밖의 원래 문구이거나 닿을 수 없는 상태다.
- 결정 처리:
  - **S1** 실제 카드의 조건부 복구 줄은 결과 불명 안내(`LIVE_UNKNOWN_GUIDANCE_BY_KIND`)에 한 번만 둔다.
    - 실제 머리줄 꼬리(`LIVE_UNKNOWN_HEADLINE_RECOVERY` 제거)와 실제 스냅샷 안내에서 뺐다. 둘 다 "다시 게시하지 않음·Threads 에서 직접 확인"은 남는다.
    - 스냅샷 안내는 결과 기록 기준, 안내는 계정 기준으로 서로 다르게 골라졌다. 이제 같은 값(recordLive)으로 고른다. 그래서 줄이 빠진 채 안내 없는 카드는 없다.
  - **S2** `USER_CONFIRM_RESTORED_MESSAGE`(@cs/domain)와 화면 오류 문구 `user_confirm_restored` 에 "직접 확인해 글이 없을 때만 새 배포 계획" 조건을 붙였다.
  - **S3** 항목은 계정을 잃을 수 없다. channel_account_id 는 NOT NULL 이고, 같은 owner FK 는 ON DELETE RESTRICT 이고, 열 변경·항목 삭제는 트리거가 막고, kind 는 mock·live 만 된다. 새 시험(`fix4-account-required`)으로 고정했다.
    - 그래도 화면의 모의/실제 판정을 하나로 모았다(`itemRecordLive`). 순서는 결과 기록 is_mock → 계정 종류 → 최근 의도의 adapter_id(live_*·mock_*) → 모름(null)이다.
    - 모름이면 MOCK·Threads·"실제 게시"·새 계획을 말하지 않는 조심 문구를 쓴다(표마다 `unknown` 칸, `UNPROVEN_CONFIRMED_LINE`). cancelItem 은 이미 같은 규칙이라 그대로다.
  - **S4** plan_id 없이 보낸 HTML 취소의 성공·실패 이동 대상은 그 항목의 계획 화면이다(`planIdOfItem` — 소유자 범위, `itemPlanBack` — 조회 실패·UUID 아님은 /distribute). CSRF·401 은 소유자 확인 전이라 조회하지 않는다. 404 는 /distribute?missing=1 그대로다. JSON 과 plan_id 경로는 그대로다.
- 바뀐 기존 단언: FIX3 의 실제 머리줄 정확 문구·꼬리 단언과 카드당 조건부 줄 3회 세기를 S1 결정에 따라 바꿨다. 새 정확 문구, 꼬리 없음, 카드당 정확히 1회로 교체했다. 계정 없는 항목의 배너 기대값은 S3 에 따라 mock → unknown 이다. ui-safety 의 연결 고정 줄은 새 단일 규칙 연결로 갱신했다. 그 밖의 제거 0 이고, 모의 스냅샷 안내 검사는 세 칸(mock·live·unknown) 모두로 넓혔다.
- 변이 확인: 33개 모두 잡혔고, 복원 뒤 cmp 일치했다.
- 명령(클라우드 Node 22.22.2, 오케스트레이터 순차 실행, fc74b3a 와 같은 코드):
  - install --frozen-lockfile(lockfile 불변 `8db0ef8abda74fda`) · lint · typecheck · build PASS
  - **unit 83 files / 2018 · integration 60 files / 1079**
  - drill:mock 위반 0 · test-dev-cert.sh 271/271
  - 변경 파일 보이지 않는 문자 0 · `./data` 변화 없음
- 남은 것(손대지 않음, 모두 이번 변경 전부터):
  1. 일반 실제 결과 불명(부분·복원 코드 아님)은 조건부 줄이 머리줄과 안내에 2번 나온다.
  2. retryItem 의 복원 작업 거부 JSON 문구 2곳에 조건 없는 "새 배포 계획을 만드세요"가 남아 있다(HTML 은 일반 문구).
  3. 계획 머리의 MOCK·실제 표시(hasLive·hasMock)는 계정 종류 기준이다(계정 없는 항목은 DB 가 막아 닿지 않음).
  4. retry·reconcile·user-confirm·mock-scenario 폼도 plan_id 가 없으면 /distribute 로 돌아간다.
