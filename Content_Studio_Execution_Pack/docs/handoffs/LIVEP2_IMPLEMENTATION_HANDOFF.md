# Implementation handoff — LIVE-P2 (D39 Task A)
- Task ID / milestone: LIVE-P2 / M4 (D39 — Threads 평상시 실제 게시: 최근 24시간 상한 + 즉시 중지 스위치)
- Purpose and changed behavior: 실제(live) Threads 전송 직전(`beginSend` 실제 분기, 승인 기록 상한 바로 뒤)에 owner 별 advisory 잠금 아래에서 (1) 즉시 중지 스위치, (2) 최근 24시간 실제 게시 상한(`PUBLISH_LIVE_DAILY_MAX`)을 확인한다. 걸리면 전송 의도를 쓰지 않고 blocked(not_sent)로 끝나며, 창이 비거나 재개한 뒤 기존 '재시도'로 다시 보낼 수 있다. 중지는 DB 저장(서버 재시작 불필요), 설정 화면에서 중지(확인 없음)·재개(확인 문구 '재개'). 모의 전송은 영향 없음.
- BASE_SHA: d240e25 (D39 결정·계획·클라우드 인계, docs 전용; 직전 코드 HEAD 9bbf96a DESIGN-A Codex PASS)
- HEAD_SHA: ca7228eaf4ed5fc5b52edbc22f97f54a92827a34
- Clean tracked tree confirmed: yes
- Relevant acceptance IDs: D39(상한 3건·즉시 중지·재시도/이어 보내기 미집계·결과 불명/재게시 금지 D38 그대로), LIVE-P1 승인 기록 상한(같은 잠금·시험 방식), AGENTS.md 불변식(서버 강제·승인 없는 게시 금지)
- Changed files: `git show --stat ca7228e`.
  - 신규: `packages/db/drizzle/0046_livep2_daily_cap_pause.sql`(+`meta/0046_snapshot.json`, `db:generate --name livep2_daily_cap_pause`), `apps/web/app/api/live-publish/{pause,resume}/route.ts`, `apps/web/lib/live-publish.ts`, `tests/integration/live-publish-daily.test.ts`(11)
  - 수정: domain `config.ts`·`live-publish.ts`·`bundle.ts`·`ops.ts`, db `schema.ts`·`jobs.ts`·`live-publish.ts`·`queries.ts`·`_journal.json`, web `app/page.tsx`·`settings/page.tsx`·`distribute/[id]/page.tsx`·`lib/distribution.ts`, `.env.example`·`deploy/content-studio.env.example`·`deploy/scripts/check-env.sh`, `README_KO.md`("실제 게시 상한·즉시 중지"), `docs/04_DATA_AND_API.md`(API 행 1개), 시험 `config.test.ts`·`live-publish.test.ts`·`distribution.test.ts`·`plan-detail-render.test.ts`·`ui-safety.test.ts`·`bundle-tables.test.ts`·`export-restore.test.ts`·`test-check-env.sh`
- 설계 요점:
  - 상한: 이 owner 의 **다른** 작업 중 `sanitized_details.live_approval_ref`(어떤 ref 든)가 있는 send_intent 가 `created_at > now − 24h` 인 작업 수(DISTINCT). 이 작업이 창 안에 이미 실제 의도가 있으면 새 게시가 아님(재시도·이어 보내기 미집계). `used >= max` → blocked `{reason:'live_publish_daily_limit', not_sent:true, used, limit, available_at}`, lastErrorCode 동일. 한국어 문구(모스크바 시각)는 `packages/domain/src/live-publish.ts`. 미설정 = 상한 없음(하위 호환).
  - `available_at` = 집계된 각 작업의 **창 안 가장 최근** 의도 중 가장 이른 것 + 24h(재시도한 작업 때문에 너무 이른 시각이 나오지 않게 — 계획의 "가장 오래된 의도"에서 바꿈).
  - 중지: `live_publish_controls`(owner_id PK·FK, paused, changed_at, changed_by='owner'), 행 없음 = 중지 아님. `beginSend` 가 일일 잠금 아래 `FOR SHARE` 로 읽고 의도 쓰기 전에 blocked `{reason:'live_publish_paused', not_sent:true}`. publish_attempt 이후 작업은 기존 결과 규칙 그대로(중지가 취소하지 않음). 감사 `live_publish_paused`/`live_publish_resumed` `{by:'owner'}` — 상태가 실제로 바뀔 때만.
  - **잠금 순서**: 계정(공유) → 항목 → 작업 → `cs_rate:<계정>` → `cs_live_publish:<ref>` → `cs_live_publish_daily:<owner>`. 일일 잠금은 `beginSend` 실제 분기와 `setLivePublishPaused`(이 잠금 하나만, 먼저)에서만 잡아 엇갈림이 없다. 상한 미설정이어도 잠금은 잡는다(중지 판정이 스위치 변경과 줄을 서게).
  - export: `live_publish_controls` **제외**(환경별 안전 스위치 — 복원으로 다른 환경을 중지/해제하지 않게), 보존 정리 보호 목록(`ops.ts`). 옛 묶음은 그대로 복원(읽을 때 `excluded_tables` 미검증).
  - 경로: `POST /api/live-publish/pause`·`/resume` — 같은 출처 검사 → 소유자 세션(다른 상태 변경 경로와 같은 순서).
  - 화면: 설정 "실제 게시"(`#live-publish`: 켜짐 / 일시 중지됨 / 꺼짐(PUBLISH_MODE), 최근 24시간 n/상한, 중지·재개 폼), 기존 "실제 게시 준비됨" 안내에 중지 표시, 홈(실제 계정 있을 때)·`distribute/[id]`(실제 항목 있을 때) 한 줄 "실제 게시: 최근 24시간 n/3" 또는 "실제 게시 일시 중지됨…", 막힌 항목 문구. 안전 문구 토큰을 ui-safety 시험에 추가.
  - `check-env.sh`: D37 배포 대기 단계에서는 다른 `PUBLISH_LIVE_*` 처럼 비어 있어야 함.
- Migrations / restore implications: `0046_livep2_daily_cap_pause` — 표 1개 추가(기존 행 영향 없음). 로컬 적용은 사용자 PC 에서(dev 서버 끈 상태, `data` 백업 후 `db:migrate`).
- Actual commands and results (클라우드 컨테이너 Node v22.22.2, pnpm 12.6.0, 오케스트레이터가 순차 재실행):
  - `corepack pnpm install --frozen-lockfile` → exit 0, lockfile sha256 `8db0ef8abda74fda…` 전후 동일(새 의존성 0)
  - `pnpm lint` / `pnpm typecheck` / `pnpm build` → exit 0
  - `pnpm test` → 76 files / 1838 tests PASS
  - `pnpm test:integration`(단독) → 51 files / 928 tests PASS, 289 s
  - `pnpm drill:mock` → exit 0, 불변식 위반 0(M3·Threads·YouTube·Instagram)
  - 구현 에이전트: `test-check-env.sh` 58/58(사용자 `nobody` 로 — 하네스가 root 거부), 배포 스크립트 `bash -n` 통과, scratchpad 임시 DB `db:migrate` 47개 적용·칼럼/제약 확인 후 삭제
  - 구현 에이전트 변이 확인: "이미 집계된 작업" 예외 제거 / 중지 검사 제거 / 창 경계 `>` → `>=` 각각 시험 실패
  - 첫 실행에서 표 목록을 정확히 비교하는 시험 2건(`ops.test.ts` 보존 대상, `export-restore` 제외 표)이 새 표 때문에 실패 → 목록에 새 표 추가(단언 약화 없음)
- Demo route / local start steps: (Codex PASS 뒤, 사용자 PC) dev 서버 끈 상태 → `data` 백업 → `db:migrate`(0046) → `.env.local` 에 `PUBLISH_MODE=enabled`, `PUBLISH_LIVE_APPROVAL_REF=D39`, `PUBLISH_LIVE_MAX_POSTS=1000`, `PUBLISH_LIVE_DAILY_MAX=3` → 서버 → 설정 `#live-publish`·홈 한 줄·health 확인.
- External calls performed: none(실제 Threads·Meta 호출 0, 실계정 0, `.env.local`·`./data` 미접근).
- Mock-only functionality: 시험은 모의·기록된 응답만. 실제 게시 경로 자체는 LIVE-P1 그대로.
- Known risks / not run:
  - **advisory 잠금 자체는 시험으로 증명되지 않음**: 구현 에이전트가 잠금을 제거해도 경쟁 시험이 통과 — PGlite 단일 연결이 트랜잭션을 직렬화하기 때문(LIVE-P1 상한 시험과 같은 한계). 실제 Postgres 다중 연결 정확성은 잠금 설계에 의존.
  - 결과 불명(ambiguous) 뒤 이어 보내기가 중지에 막히면 '재시도'가 `outcome_unknown` 으로 거부 → 새 계획 필요(기존 `credential_blocked` 와 같은 동작).
  - 24시간이 지난 뒤의 재시도는 새 게시로 센다(보수적).
  - 미래 시각(시계 오차) 의도도 창 안으로 센다(창 상한 없음 — 보수적).
  - `executePlan` 에는 일일 사전 확인 없음(정본 판정은 전송 시점).
  - 테스트 전용 `liveDailyHook` 추가(`rateCheckHook` 방식).
  - not_run: 브라우저 렌더링, `deploy/scripts/tests/run-all.sh` 전체, 실제 `./data` migrate·`drill:restore`, 실제 Threads.
- Questions specifically for Codex:
  1. 잠금 순서가 건전한가, `setLivePublishPaused` 가 일일 잠금을 먼저 잡는 것으로 커밋된 중지 이후 시작한 전송 판정이 항상 중지를 보는가?
  2. "창 안에 있을 때만 이미 집계됨"(24시간 뒤 재시도는 새로 셈)이 D39 의 "재시도·이어 보내기는 새로 세지 않음"의 올바른 해석인가?
  3. 결과 불명 작업의 이어 보내기가 중지에 걸리면 `outcome_unknown` 뒤에 갇히지 않도록 blocked 대신 대기 상태로 보내야 하는가?
  4. `live_publish_controls` 를 export 에서 빼고 복원 시 "중지 아님"으로 시작하는 것이 허용되는가?
  5. 중지 중이거나 일일 상한일 때 `executePlan` 이 거부(또는 경고)해야 하는가, 지금처럼 대기열에 넣고 전송 시점에 막는 것이 맞는가?
  6. 창 상한이 없어 미래 시각 의도까지 세는 보수적 선택이 허용 가능한가?
- Next authorized task: EXPIRY-1(D39 Task B).

---

# FIX round 1 (Claude 독립 검토 — Codex 아님, `D39_CLAUDE_REVIEW.md`)
- BASE_SHA: bc24fbe (검토 기록 docs) · **HEAD_SHA: 7538492** (`7538492e6f1a1ba6d167016591798d7559692fc6`)
- 검토: 읽기 전용 검토자 5명 + 지적마다 반박 검증. LIVE-P2 확정 14건(중복 포함, P1 2건은 같은 내용) → 아래 A~H 로 묶어 처리. 기각: "표식 전 중지 미적용" P1 판정(같은 내용의 P2 는 확정 → D), "상한 미설정 = 상한 없음은 실패 개방"(설계상 하위 호환, D39 적용 값으로 해소).

| 묶음 | 지적 | 변경 | 시험(실패 → 통과 증거) |
|---|---|---|---|
| A | 상한 초과 시 다음 가능 시각이 이르다, 분 잘림 | used ≥ 상한이면 작업별 마지막 의도 오름차순 [used − 상한] + 24h, 표시는 다음 분 올림(`formatLiveAvailableAt`) | 통합 ~392(기존 단언이 확정된 오류 값 → 올바른 값으로 교체), ~321(잘린 분 → 올림), 옛 시각 재시도 차단·1분 전 차단·새 시각 전송 |
| B (P1) | 중지 시험 누락 | 코드 변경 없음(이미 맞음) | 창 안 의도가 있는 작업의 재시도도 중지(상한 없음·3), 상한 미설정 중지 — 변이(이미 집계 작업 중지 면제·상한 있을 때만 중지 검사) 각각 실패 |
| C | 결과 불명 → resume → 중지/상한 보류 = 재시도 막다른 길 | `resumeProvenRetryable`(domain) + `retryItem`: 마지막 사건이 not_sent 보류(중지·일일 상한·credential_blocked)이고 거슬러 올라가며 허용 사건만 지나 같은 attempt 의 `resume`(reconcile resumable)에 닿을 때만 허용, 표식 있는데 게시 없음이면 거부. unblock 사건·감사에 `unresolved_intent_cleared_by: reconcile_resume` | 막다른 길 → 재시도로 컨테이너 1·게시 1(이전 409), resume 증명 없는 상태는 계속 409(SQL 로 구성) — 증명 요구 제거 변이에서 실패 |
| D | beginSend 뒤·표식 전 중지 무시 | 표식 트랜잭션에서 cs_rate(공유) → 일일 잠금 → 스위치 행(FOR SHARE) 확인, 중지면 표식·게시 없이 컨테이너 유지 → BLOCKED(not_sent, before_publish_attempt, 의도 rejected — 일반 재시도 가능, 시도 횟수 1 소모). 표식 이후는 기존 규칙 | 이전 `{CONFIRMED:1}`(중지 중 게시) → BLOCKED, 재개·재시도로 같은 컨테이너 게시 1회. 표식 뒤 중지는 정상 확인. 게이트 제거 변이에서 실패 |
| E | 중지 중에도 준비 표시가 "게시됨" 취지 | 계획 만들기·배포 목록·ops 에 "일시 중지됨"(설정과 같은 문구), ops 빈 목록은 "없음(준비됨)" | `live-publish-render.test.ts`, 목록 렌더 중지 경우, ui-safety 토큰 — 옛 화면에서 4건 실패 |
| F | 오래된 예약(D36) 보류 항목은 재시도 두 번 필요 | attempt 0·60분 초과·미확인 예약 항목의 재시도는 schedule_stale 로 다시 보류하고 409(대기열에 넣지 않음) → 다음 재시도가 기존 D36 확인 | daily_limit·paused 두 경우: 이전 첫 재시도 대기열 → 이후 409·원격 호출 0, 두 번째 재시도 게시 |
| G | 경쟁 시험이 잠금을 증명한다고 과장 | 기존 시험 이름·주석 수정, 새 잠금 순서 시험(PGlite SQL 순서 + pg_locks): beginSend(상한 유무)·표식 트랜잭션·setLivePublishPaused | 잠금 제거(두 곳)·중지 읽기 뒤로 이동 변이 각각 실패 |
| H | 모의 집계·화면 연결 시험 누락 | 시험만 | 상한 가득 찬 상태 모의 확인·used 3 유지, 실제 loadConfig 로 홈·설정·계획 화면 n/상한·중지 |

- 잠금 순서(갱신): beginSend `cs_rate:<계정>`(배타) → `cs_live_publish:<ref>` → `cs_live_publish_daily:<owner>` → 스위치 행(FOR SHARE) / 표식 트랜잭션 `cs_rate:<계정>`(공유) → 일일 잠금 → 스위치 행 → 단계 행 / setLivePublishPaused 일일 잠금 → 스위치 행. 모두 같은 방향.
- 명령(클라우드 Node 22.22.2, 오케스트레이터 순차 재실행): install --frozen-lockfile(lockfile 불변) · lint · typecheck · build PASS · unit 80 files / 1896 · integration 51 files / 938(LIVE-P2 시험 11 → 21) · drill:mock 위반 0. check-env 미변경(시험 미실행).
- 남은 위험: 다음 가능 시각은 현재 자료 기준 추정(창 안 다른 작업이 재시도하면 실제는 더 늦을 수 있음 — 막을 뿐 초과 게시 없음), resume 뒤 `execution_not_allowed`·`live_publish_limit`·`adapter_changed` 보류는 여전히 재시도 불가(이번 범위 밖), 잠금 순서 시험은 PGlite 디버그 로그 형식에 의존(바뀌면 크게 실패), F 경로는 주입 시계로 `retryItem` 직접 호출(HTTP 경로는 실제 시계), 실제 Postgres 다중 연결·브라우저·실제 Threads 미실행.
- 검토자에게 물을 것:
  1. D: BLOCKED(의도 rejected, 시도 1 소모) 정산이 맞는가? 순환 import 를 피하려 `remote-steps.ts` 가 스위치 행을 직접 읽는 것이 허용되는가?
  2. C: resume 과 마지막 보류 사이 허용 사건 집합이 충분히 좁은가? `execution_not_allowed`·`live_publish_limit` 도 나중에 넣어야 하는가?
  3. F: unblock → blocked 두 사건 대신 BLOCKED → BLOCKED 전용 전이가 필요한가? 사전 확인을 상한·중지 보류로만 좁혀야 하는가?
  4. 표식 트랜잭션(cs_rate 공유 → 일일 → 스위치 → 단계 행)이 beginSend(cs_rate 배타 → ref → 일일)·setLivePublishPaused 와 교착할 수 있는가?
  5. G: 잠금 순서 시험이 PGlite 디버그 로그에 의존하는 것이 허용 가능한가?

---

# FIX round 2 (2차 Claude 독립 검토 — Codex 아님)
- BASE_SHA: 41bd767 (2차 검토 기록 docs) · **HEAD_SHA: 561bc5f** (`561bc5f9e6c73ca9164913b0e1ab86e786207a68`) — LIVE-P2·EXPIRY-1·LIVEL1-H2 지적을 한 커밋으로 처리.
- 검토: 2차 Claude 독립 검토(Codex 아님, `D39_CLAUDE_REVIEW.md` 2차) 확정 12건(중복 2쌍, 실질 10건, 전부 P2), 기각 2건.
- 명령(클라우드 Node 22.22.2, 오케스트레이터 순차 재실행): install --frozen-lockfile(lockfile 불변) · lint · typecheck · build PASS · unit 81 files / 1934 · integration 51 files / 956 · drill:mock 위반 0 · test-dev-cert.sh 251/251 · bash -n ok · data/dev-certs 생성 없음.
- FIX round 2 자체는 아직 독립 검토하지 않았다(필요하면 3차 검토). Codex 미검증.

| 지적 | 변경 | 시험·증거 |
|---|---|---|
| 재개 증명 + 표식만 있고 게시 없음 → 재시도 거부 가드 시험 없음 | 시험만 | 증명 체인 뒤 SQL 로 publish_attempt 행 삽입 → 409 outcome_unknown·BLOCKED 유지·unblock 없음·의도 그대로·게시 0. `|| unresolvedAttempts > 0` 제거 변이 실패 |
| 잠금 순서 시험이 잠금끼리 순서를 안 봄 | 시험 확장 | beginSend cs_rate(배타) → ref → 일일(일일 1회), 표식 트랜잭션 cs_rate(공유) → 일일 — 각각 같은 트랜잭션. 변이 3종(remote-steps 순서 바꾸기·일일을 ref 앞·일일을 cs_rate 앞) 실패 |
| 마지막 시도에서 표식 전 중지 → 재개 뒤 재시도가 409 attempts_exhausted | 표식 전 중지로 끝난 시도는 max_attempts 에 세지 않음(resume_count +1, `resume_count < attempt` 가드, 이벤트 counted:false). 유한: BLOCKED 라 매번 사용자 중지·재개·재시도 필요. migration 없음(스키마 주석만) | 4회 실패 → 5/5 에서 중지 → 재개만으로는 0건 → 재시도로 같은 컨테이너 1회 게시(이전 409) |
| 설정 "다음 게시 가능" 끝까지 시험 없음 | 시험만 | `livePublishOverview(...,2).availableAt` = sorted[used−limit]+24h, `formatLiveAvailableAt` 문자열, 상한 없음·3 이면 earliest+24h. 상한 전달 제거 변이 실패 |
| F(오래된 예약) 경로·폼 결과 시험 없음 | 시험만 | 실제 재시도 경로(Date 만 대체): JSON 409 + SCHEDULE_STALE 문구·late_minutes ≥ 60, 폼 303 `?error=schedule_stale` 한국어 문구, 두 번째 폼 재시도 retried=1·게시. `distributeFormFailure` 단위. 문구 제거 변이 실패 |

- 남은 위험: 배포 화면의 `시도 {attempt}/{max}` 가 표식 전 중지 재시도 뒤 6/5 로 보일 수 있음(upload_yield 와 같은 기존 특성), 중지로 돌려받은 시도가 원격 처리 재개와 resume_count 예산을 공유(일찍 세는 쪽으로만).
- 검토자에게 물을 것: (1) 표식 전 중지 시도를 세지 않는 규칙이 맞는가, "새 계획" 안내로 바꿔야 하는가? (2) 시도 표시를 `attempt − resume_count` 로 바꿔야 하는가?
