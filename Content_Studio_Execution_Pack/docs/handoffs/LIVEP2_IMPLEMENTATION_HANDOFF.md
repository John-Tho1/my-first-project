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
