# Implementation handoff — T14
- Task ID / milestone: T14 / M4 (Threads 텍스트 — **모의 어댑터만**)
- Purpose and changed behavior: T13 모의 OAuth 로 연결된 Threads 계정의 배포 항목을 Threads 형 2단계(컨테이너 생성 → publish)로 보낸다. 각 단계의 원격 참조(컨테이너 ID·게시 ID)를 다음 원격 호출 전에 `remote_steps` 에 기록하고, 응답 유실·처리 지연·부분 게시 뒤에는 기록과 조회로 확인해 **이미 게시된 게시물은 다시 보내지 않고 같은 컨테이너로 이어서** 게시한다. 요청 제한(로컬 잠정 한도 + 원격 429 Retry-After), 401 → BLOCKED(+T13 확인 1회), 400/403 → FAILED. 실제 Threads/Meta 호출 0, 실계정 시험은 `blocked_external`.
- BASE_SHA: 8e658e5 (T13 FIX3 코드 79201d6 + 인계 절)
- HEAD_SHA: 67ade9ea5289c787a6099d51e00ac76cfdeed056
- Clean tracked tree confirmed: yes
- Relevant acceptance IDs: M4 T14(텍스트·컨테이너 참조 저장·성공 확인·요청 제한), A08(원격 성공 후 응답 유실 → 조회로 확인, 재게시 0), A09(한 채널 성공·다른 채널 401 → PARTIAL, 성공 채널 재전송 0), A16(구분 유지), docs/03 Threads 행·중복·재시도 규칙·ChannelAdapter 계약, D24·D25·D26
- Changed files: `git show --stat 67ade9e`. 신규: `packages/providers/src/threads-mock.ts`(+test), `packages/db/src/remote-steps.ts`, `packages/db/drizzle/0031_t14_threads_steps.sql`(+snapshot), `packages/db/scripts/drill-threads.ts`, `tests/integration/threads.test.ts`. 수정: domain `jobs.ts`·`bundle.ts`·`ops.ts`, db `jobs.ts`·`oauth.ts`·`distribution.ts`·`mock-scenarios.ts`·`schema.ts`·`bundle-tables.ts`, providers `channel-adapter.ts`, worker `index.ts`·`cli.ts`, web `distribute/[id]/page.tsx`·`lib/distribution.ts`·`lib/oauth.ts`·`api/worker/tick`, `README_KO.md`, `docs/DECISIONS.md`(D26)
- Migrations / restore implications: `0031_t14_threads_steps` — `remote_steps`(job·item·intent·post_index·kind container|publish·remote_id·status; unique(job_id, post_index, kind); remote_id 1회 설정 후 불변·DELETE 금지 트리거; `remote_id LIKE 'mock%'` CHECK — **live 어댑터 전 재검토**). export 만, 복원 안 함(복원 환경은 조회로 재확인).
- Actual commands and results (클라우드 Node 22.22.2, pnpm 12.6.0, 오케스트레이터가 순차 재실행):
  - `corepack pnpm install --frozen-lockfile` → pass, lockfile 변경 없음
  - `pnpm lint` / `pnpm typecheck` / `pnpm build` → pass
  - `pnpm test` → pass 38 files / 657 tests
  - `pnpm test:integration`(단독) → pass 28 files / 495/495, 142.6 s (`threads.test.ts` 20건)
  - `pnpm drill:mock` → exit 0, `불변식 위반 0건 — M3 게이트 통과(MOCK), T14 Threads 모의 불변식 통과(MOCK)`, fetch 0
  - `pnpm db:migrate` → 0031 적용
  - 구현 에이전트 운영 모드 smoke(`pnpm start`, NODE_ENV=production, 임시 DB 삭제됨): 로그인 → 모의 Threads 연결(connect·authorize 303·callback 200, D25-3 의 모의 테스트 매개변수 없이) → 원고·파생본·계획·승인·실행 → tick `{CONFIRMED:1, mode:MOCK}` → publication `mock:threads:mockthr_post_…`/`mock://threads/…` MOCK, 단계 3게시물 × (container, publish) → HTML 에 `Threads 단계(MOCK`·`게시물 3/3 · 게시됨(MOCK)`·`실제 발행 실적 아님`, `게시 완료` 없음, 서버 로그 토큰 0건
- drill:mock Threads 행 (요약): 단일·3게시물 성공(컨테이너=게시=게시물 수), 컨테이너 지연 → 같은 컨테이너, publish 응답 유실(보냄) → 조회 확인·재게시 0, publish 응답 유실(안 보냄) → 같은 컨테이너로 게시, 3번째 실패 → 3번째부터 이어서(1·2 재게시 0), 429 → 재시도, 401 → BLOCKED(컨테이너 0), 400 → FAILED, 로컬 한도 → 의도 없이 대기, 재시작으로 모의 원격 기록 유실 → UNKNOWN(재게시 0)
- Demo route / local start steps: 설정에서 Threads 모의 계정 연결 → 원고·threads 파생본 검토 → `/distribute/new` → 승인 → 실행 → `작업 처리 실행(모의 1회)` → 단계 목록 확인. 개발 시나리오는 `threads_*` 모의 시나리오.
- External calls performed: none. Threads 시뮬레이터는 프로세스 메모리.
- Mock-only functionality: 전부. `kind='live'` 계정은 기존대로 LiveChannelNotConfiguredError.
- Known risks / not run:
  - Codex 검증 **미실행**(클라우드). 실제 브라우저·실제 PostgreSQL 병렬 트랜잭션·실제 Threads 미실행.
  - 401/403/400 으로 스레드 중간에 멈추면 앞 게시물은 공개된 채 항목은 BLOCKED/FAILED(단계 목록이 공개된 범위를 보여 줌) — 별도 PARTIAL 상태 없음(Codex 질문 4).
  - 같은 컨테이너 재게시를 시뮬레이터는 거부하지만 실제 Threads 동작은 미확인 — live 전 공식 자료 확인 필요.
  - 로컬 한도(잠정 250/24h)는 다른 job 에서 진행 중인 게시물을 세지 않음.
  - 컨테이너 생성 후 기록 전 프로세스 종료 → 게시되지 않은 고아 컨테이너가 원격에 남을 수 있음(다음 시도는 새 컨테이너).
  - 만료된 컨테이너는 게시물당 컨테이너 1개 규칙 때문에 UNKNOWN 으로 감.
  - 401 에 docs/03 의 "refresh 1회" 대신 T13 `checkCredential` 1회(Threads 형 refresh 는 유효 토큰이 필요하므로).
  - publication 의 원격 공개 범위는 승인된 공개 범위와 같다고 가정(모의 한정).
  - 단위 테스트의 `lock.test.ts` 는 부하에서 가끔 실패하는 기존 테스트(이번 실행에서는 통과).
- Questions specifically for Codex:
  1. `resumable` → `resume` → 새 시도 경로가 원격의 같은 컨테이너 재게시 동작을 모를 때도 이중 게시를 막는가? resume 전에 두 번째 확인 조회를 요구해야 하는가?
  2. "기록된 단계 없음 → not_found(확실히 미전송)" 판정이 건전한가(컨테이너는 publish 전에 항상 기록된다는 전제)?
  3. 401 뒤 refresh 없이 확인 1회가 docs/03 과 FIX3 의 "revoke 시 invalid_token 은 이미 철회" 규칙과 일관되는가?
  4. 부분 게시된 스레드를 BLOCKED/FAILED/UNKNOWN 으로 끝내는 것이 허용되는가, 별도 상태(PARTIAL 등)가 필요한가?
  5. 조회 어댑터를 send intent 의 `adapter_id` 로 고르는 것으로 충분한가, DB 칼럼이어야 하는가?
  6. 로컬 한도: 창이 비면 허용하고 가장 오래된 게시 + 창에서 초기화하는 규칙과 진행 중 게시물 미집계가 허용 가능한가?
- Next authorized task: T15(YouTube 재개 업로드, 모의) — 클라우드에서 계속. 실계정 Threads 시험은 D24 승인 항목 대기.

---

## FIX round 1 (Codex review-T14)
- Orchestrator: HEAD_SHA 6f766d2 (code only, D28) — reran lint·typecheck·build·unit 705·integration 552·drill:mock 0·db:migrate 0034·real-DB drill:restore PASS.

- 입력: `.handoffs/review-T14.md`(CHANGES_REQUESTED, HEAD 67ade9e) — P0 1·P1 1·P2 1 + 놓친 케이스 8.
- BASE_SHA: 0b1eb9c (T13 FIX round 4 인계·M4 판정 기록 포함, T13 FIX4 `oauth_pending_tokens` 0033 그대로) · HEAD_SHA: TBD(오케스트레이터 커밋 뒤 기록)
- 범위: 모의 어댑터만. 외부 호출 0, 새 의존성 0, 실제 자격 증명 0, `./data` 열지 않음(db:migrate·seed·drill:restore 미실행). docs/DECISIONS.md·M4_CODEX_VERDICTS.md·T13 인계는 건드리지 않았다(D26 갱신 필요 항목은 아래 "결정 기록 필요").

### 지적 → 변경 → 시험

| 지적 | 변경 | 시험 |
|---|---|---|
| [P0] jobs.ts:848 — `adapter_id` 없는 옛 의도를 현재 선택 규칙(mock_threads)으로 조회 → 단계 없음 → `not_found` → 재전송 허용 | `@cs/domain` `recordedAdapterIdOf`·`LEGACY_SEND_ADAPTER_ID`: 없음·null → **명시적으로 `mock_generic`**(T14 이전 유일 어댑터), 모르는 문자열 → null. `remoteCheck` 는 의도가 있으면 기록된 어댑터만 쓴다(`resolveAdapterById` — `getAdapterById` 없는 레지스트리는 현재 선택의 ID 가 같을 때만). 못 찾으면 `unknown`(`adapter_unresolved`, 3회 뒤 UNKNOWN), 현재 어댑터로 대신하지 않는다. `beginSend`: 어댑터 ID 없는 어댑터로는 의도를 만들지 않음(BLOCKED `adapter_id_missing`), 단계 기록이 있는 작업의 이전 의도 어댑터 ≠ 지금 어댑터면 BLOCKED `adapter_changed`(Codex 답 5). **데이터 이전·NOT NULL 은 하지 않음**: 결과를 기록한 의도는 트리거로 불변이고, 이전 묶음 복원 행·M3 시험 고정 데이터(drill-matrix 등 직접 INSERT)도 ID 가 없으므로 같은 읽기 규칙이 어차피 필요하다 | 통합 `threads.test.ts` "FIX round 1": (a) T13 연결 Threads 계정을 T14 이전 레지스트리(일반 모의만)로 `ambiguous_sent` 전송 → 의도에서 `adapter_id` 제거(트리거 잠시 끔 — 이전 행 흉내) → T14 레지스트리 조회가 일반 모의로 CONFIRMED, Threads 조회·제출 0. (b) 같은 의도를 원격 기록 없는(재시작) 일반 모의로 → `reconciled_not_found` 없음, `send_start` 1회, UNKNOWN, Threads 조회 0. (c) 레지스트리가 모르는 ID → `adapter_unresolved` → UNKNOWN, 컨테이너·게시 0. 단위 `jobs.test.ts` recordedAdapterIdOf |
| [P1] bundle.ts:123 — 복원이 `remote_steps` 를 버려 Threads 재확인이 `not_found`, 게시 이력 사라짐 | `remote_steps` 를 NON_RESTORED 에서 빼고 **읽기 전용 이력으로 복원**(restore.ts PARENTS: job·intent·item 이 이번에 들어갔을 때만, owner 는 대상 owner, 0031/0032 트리거 그대로 통과). 업로드 세션 URI 는 내보낼 때 가린 값 그대로 들어간다(T15 마스킹 유지 — 이어 올리기에 쓸 수 없고 조회는 unknown). 어댑터 표식 `usesRemoteSteps`(Threads·YouTube 모의): **복원한 작업**의 `not_found` 는 `unknown` 으로 바꾼다 — 단계 없음 `restored_steps_missing`(이전 묶음), 있는데 not_found `restored_not_found_unverified`. 복원 작업은 `definitive_not_found=false`. restore-expect.ts: 변환 없는 표라 기대값 = 묶음 행(주석 추가) — 훈련은 RESTORED_TABLES 를 돌므로 이제 remote_steps 도 비교한다 | 통합: 응답 유실(`threads_publish_timeout_sent`)·부분 스레드(`threads_thread_partial`) → 내보내기 → 빈 DB 복원(empty_only): 단계 행이 같은 ID·종류·remote_id·상태로 들어옴, 작업 restored_needs_review·lease 없음, 수동 재확인 `unknown`(not_found 아님, 제출 0), worker lease 0. 같은 묶음에서 `remote_steps=[]`(이전 묶음) → 재확인 `unknown` + 사건 `restored_steps_missing`. 기존 restore-drill·export 시험 통과 |
| [P2] threads-mock.ts:622 — 429 대기·resumable 뒤 만료 컨테이너 publish → `invalid_parameter:container_expired` 영구 FAILED | `classifyThreadsError`: `container_expired` → `ambiguous`(조회 경로). 같은 시도 안 조회 중 EXPIRED 도 오류 기록 없이 `ambiguous`(ERROR 는 그대로 영구). 조회는 기존대로 만료 → unknown → 3회 뒤 UNKNOWN, 새 컨테이너 없음 | 단위: publish 429 → 만료 → 재시도 ambiguous·조회 unknown·컨테이너 1·게시 0; resumable 뒤 만료; 처리 지연 중 만료(단계 `created` 유지). 통합: 429 RETRY_WAIT 중 만료 → UNKNOWN(permanent_failure 사건 없음), resume 뒤 만료 → UNKNOWN |
| missed: 2번째 이후 게시물 401·403·400·429 뒤 취소·재시도 | `cancelItem`: QUEUED·RETRY_WAIT·BLOCKED 인데 게시 단계(publish·video)가 있으면 새 사건 `cancel_partial` → **UNKNOWN**(`thread_partial_canceled`, `not_sent:false`, published_parts) — "취소했습니다(보내지 않음)"라고 하지 않는다(A11, D26 의 취소 요청 중 부분 = UNKNOWN 과 같은 규칙). 응답 `{state:'UNKNOWN', published_parts}`. 화면 `일부만 게시됨(MOCK) — 취소 뒤 남은 게시물은 보내지 않음, 게시된 부분은 원격에 남음` | 통합: 3개 스레드 2번째 publish 429(예산 1) → 취소 UNKNOWN·추가 게시 0·재시도 409 / 대기 후 이어서 CONFIRMED(재게시 0) / 2번째 401 → BLOCKED → 재시도 → 2번째부터 CONFIRMED, 같은 상황 취소 → UNKNOWN / 2번째 400 → FAILED(단계 publish:0 만), 취소·재시도 409 / 게시 0 인 RETRY_WAIT 취소는 CANCELED 그대로 |
| missed: 부분 스레드 resume 직후(RETRY_WAIT) 취소 | 위 `cancel_partial` | 통합: threads_thread_partial → resume → 취소 → UNKNOWN(published_parts 2), 3번째 게시 0, publication 0 |
| missed: 같은 계정 여러 worker 의 로컬 한도 동시 확인 | 요청 제한 검사 앞에서 `pg_advisory_xact_lock(hashtext('cs_rate:<account>'))`(트랜잭션 끝까지 — 기존 FOR SHARE 계정 잠금과 교착 없음: 공유 잠금끼리는 호환, advisory 는 그 뒤 한 번만). 같은 계정·같은 어댑터의 진행 중 작업(SENDING·REMOTE_PROCESSING·RECONCILING·CANCEL_REQUESTED)의 남은 단위(rateUnits − 기록된 단계)를 예약으로 더한다. 예약 때문에만 막히면 창이 아니라 60초 뒤 재확인. 사건 상세 `inflight` | 통합: 한도 3, 사용 1 + 진행 중(처리 지연) 2게시물 → 새 2게시물 작업은 의도 없이 `local_rate_limited`(used 1·inflight 2·needed 2, 60초 안 재확인). **PGlite 한 연결 — 실제 병렬 잠금은 관찰하지 않음** |
| missed: publish 성공 직후 단계 기록 실패 / 단계 기록 중 lease 상실 | 코드 변경 없음(기존 경로 확인): 기록 실패 → submit 예외 → ambiguous → 조회가 컨테이너 PUBLISHED 로 게시물을 찾아 기록 | 통합(시험용 어댑터 하위 클래스로 단계 창구만 감쌈): 게시 기록 1회 실패 → RECONCILING → CONFIRMED, 게시 1·publishCount 1. 게시 기록 직후 lease 탈취 → 다음 호출 전 heartbeat 실패 → 만료 복구 → 조회 → 2번째만 이어서 CONFIRMED, 재게시 0 |
| missed: 처리 지연 재개가 maxAttempts 초과 | migration **`0034_t14_fix_resume_count`**: `jobs.resume_count`(기본 0, CHECK 0 ≤ resume_count ≤ attempt). REMOTE_PROCESSING 에서의 `resume` 은 resume_count + 1(상한 `FREE_RESUME_MAX`=20), RECONCILING(결과 불명) 뒤의 resume 은 시도로 센다(끝없는 재개 방지). 한도 비교 5곳(beginSend·finishSend 2·applyReconcile·retryItem)은 `countedAttempts = attempt − resume_count`. 사건 상세 `counted`. 묶음 jobs 행에 `resume_count`(이전 묶음 기본 0) | 통합: 7게시물이 모두 처리 지연 → max_attempts 5 인데 CONFIRMED(attempt 8 > 5, resume_count = attempt − 1, 모든 resume counted:false, 게시 7·각 컨테이너 1회). RECONCILING 뒤 resume 은 counted:true·resume_count 0. 단위 countedAttempts·FREE_RESUME_MAX |
| 조사: web 에서 연결한 계정을 별도 `pnpm worker` 프로세스가 처리 | **문서화(코드 변경 없음)**: 모의 OAuth 발급 기록(`globalThis` MockOAuthStore)과 Threads 시뮬레이터는 프로세스 메모리 — 공유·재수화하지 않는다. 다른 프로세스는 토큰을 모르므로 원격 401 → BLOCKED(게시 0, 거짓 성공 없음), 그 프로세스의 401 뒤 연결 확인은 연결 정보를 error 로 표시(다시 연결 필요) — 서버 재시작과 같은 D25 동작. PGlite 는 한 디렉터리 한 프로세스라 web 과 동시에 돌 수 없고 `WORKER_MODE=separate + pglite` 는 거부된다. README 에 명시 | 통합: 빈 OAuth 저장소를 쓰는 시뮬레이터(다른 프로세스 흉내) → BLOCKED `auth_invalid_token`, 두 시뮬레이터 모두 게시 0, publication 0 |

### 바뀐 파일
- domain `jobs.ts`(사건 `cancel_partial`·전이 3개, `FREE_RESUME_MAX`·`countedAttempts`, `LEGACY_SEND_ADAPTER_ID`·`recordedAdapterIdOf`, ChannelAdapter `usesRemoteSteps`), `bundle.ts`(remote_steps 복원 표, jobs.resume_count), `jobs.test.ts`
- db `jobs.ts`(조회 어댑터 해석·복원 not_found → unknown·무료 재개·센 시도·어댑터 ID 필수/변경 차단·계정 advisory 잠금 + 진행 중 예약·부분 취소), `schema.ts`(jobs.resume_count + CHECK), `approval-invalidation.ts`(set 에 resumeCount), `restore.ts`(PARENTS remote_steps), `restore-expect.ts`·`bundle-tables.ts`(주석), `drizzle/0034_t14_fix_resume_count.sql`(+snapshot·journal)
- providers `threads-mock.ts`(container_expired → 조회, usesRemoteSteps), `youtube-mock.ts`(usesRemoteSteps), `threads-mock.test.ts`
- web `lib/distribution.ts`(부분 취소 문구), `README_KO.md`(Threads 절), `tests/integration/threads.test.ts`(FIX round 1 describe 18건)

### Migrations / restore implications
- `0034_t14_fix_resume_count`: `ALTER TABLE jobs ADD resume_count integer DEFAULT 0 NOT NULL` + `jobs_resume_count_chk`. 기존 행 0 — 동작 변화 없음. 데이터 이전 없음.
- 복원: `remote_steps` 이제 복원(읽기 전용 이력, 자동 재개 없음). 복원 훈련 비교 대상에 포함. 이전 묶음(0031 전·0034 전)은 빈 표·기본값으로 읽는다.

### 실행한 명령과 결과(Windows 10, 포터블 Node 24.21.0, `corepack pnpm`, 순차 실행)
- `packages/db` 에서 `corepack pnpm exec drizzle-kit generate --name t14_fix_resume_count` → 0034 SQL + snapshot 생성(헤더 주석만 손으로 추가)
- `pnpm lint` → pass
- `pnpm typecheck` → pass
- `pnpm build` → pass
- `pnpm test` → pass 39 files / 705 tests
- `pnpm test:integration`(단독) → pass 30 files / 552 tests, 381.3 s (`threads.test.ts` 38건 = 기존 20 + FIX 18)
- `pnpm drill:mock` → exit 0, `불변식 위반 0건 — M3 게이트 통과(MOCK), T14 Threads 모의 불변식 통과(MOCK), T15 YouTube 모의 불변식 통과(MOCK)`, fetch 0
- not_run: `pnpm db:migrate`·`db:seed`·`drill:restore`(./data 금지 지시), 운영 모드 smoke·브라우저, 실제 PostgreSQL 병렬 트랜잭션, Codex 검증

### 남은 위험
- advisory 잠금·진행 중 예약은 PGlite 한 연결에서만 관찰했다(실제 PostgreSQL 동시성 미관찰). 예약은 같은 어댑터·진행 중 상태만 센다 — RETRY_WAIT 로 쉬는 부분 스레드의 남은 게시물은 예약하지 않는다(돌아올 때 자기 검사). `used=0` 이면 한도보다 큰 작업도 허용하는 D26 예외는 그대로(Codex 답 6 지적 유지).
- `cancel_partial` 은 새 상태 없이 UNKNOWN 을 쓴다 — 게시된 부분이 정확히 알려진 경우에도 "확인 불가" 칸에 들어간다(화면 문구로 구분). PARTIAL 상태 도입 여부는 사용자 결정 대상.
- `adapter_id` 없는 의도 → `mock_generic` 은 "T14 이전 어댑터는 일반 모의 하나뿐"이라는 이 저장소 이력에 기댄 규칙이다. live 어댑터를 붙일 때는 ID 없는 의도가 생기지 않도록(앱에서 이미 차단) 유지해야 한다.
- 무료 재개 판정은 "REMOTE_PROCESSING 에서 resumable" 이다. RECONCILING → (조회 processing) → REMOTE_PROCESSING → resume 도 무료로 센다(게시물당 컨테이너가 한 번만 FINISHED 가 되므로 유한, 상한 20).
- 복원한 Threads·YouTube 작업은 연결 정보가 묶음 밖이라 다시 연결하기 전 재확인은 항상 unknown — 재연결 뒤 재확인 경로는 시험하지 않았다.
- 별도 worker 프로세스의 모의 상태 비공유는 문서화만 했다(재수화 없음).

### 결정 기록 필요(DECISIONS.md 는 이번 범위에서 건드리지 않음 — 오케스트레이터/사용자)
- D26 "remote_steps 내보내기만" → 읽기 전용 이력 복원으로 변경. D26 조회 판정에 "복원 작업의 단계 없음 → unknown", "만료 컨테이너 publish 오류도 조회", "adapter_id 없음 → mock_generic, 모르는 ID → unknown", "처리 지연 재개는 시도 한도 밖(resume_count, 0034)", "부분 게시 뒤 대기 중 취소 → UNKNOWN(thread_partial_canceled)", "로컬 한도 advisory 잠금 + 진행 중 예약" 추가.

### Codex 에게 묻는 것
1. `adapter_id` 없는 의도를 데이터 이전 없이 읽기 규칙(`mock_generic`)으로만 처리한 것이 충분한가, 아니면 0034 에서 트리거를 잠시 끄고 이전 행에 값을 채워야 하는가(결과 기록 의도 불변 원칙과의 우선순위)?
2. 복원한 작업에서 단계 기록이 **있는데** 어댑터가 not_found 를 낸 경우까지 unknown 으로 바꾼 것(`restored_not_found_unverified`)이 과한가? 복원 작업은 재전송 경로가 없으므로 판정 문구에만 영향이 있다.
3. 부분 게시 뒤 대기 중 취소를 UNKNOWN(`cancel_partial`)으로 둔 것과, 취소 요청 중 부분(D26 `thread_partial_cancel_requested`)을 같은 칸에 둔 것이 A11 에 맞는가? CANCELED + 부분 표식이 더 정확한가?
4. 무료 재개를 "REMOTE_PROCESSING 에서의 resume"으로 한정하고 상한 20 을 둔 규칙이 무한 반복을 막으면서 정상 처리 지연을 허용하는가? RECONCILING 경유 REMOTE_PROCESSING 을 무료로 보는 것이 문제인가?
5. 진행 중 예약(같은 어댑터·네 상태)과 advisory 잠금이 Codex 답 6 의 "엄격한 계정 한도"에 충분한가, 남은 구멍(RETRY_WAIT 부분 스레드 미예약·used=0 예외)을 지금 막아야 하는가?
