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
