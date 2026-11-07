# FULLREV4 구현 인계

## FIX round 1 — FIX1-FULLREV4 (J1)

- BASE_SHA: `af3894e` (`af3894eb6fdd6c063e9d7e14e42d852193b5626e`, docs) · **HEAD_SHA: `0020226`** (`00202263b017e3624455919b5fb6a69a3fd6068d`)
- 출처: `docs/handoffs/FULLREV4_CLAUDE_REVIEW.md` 확정 P2 J1. 사용자 지시 "권고대로 진행해줘"(2026-11-07).
- 방식(D42, Claude 독립 검토 — Codex 아님): 구현 서브에이전트 1명 → 관점이 다른 검토자 2명(코드 추적·방어 장치) → 최종 트리 전체 검사.

### 재현
- 새 시험을 먼저 썼다: lease 만 잡고 보내지 않음 → 원인 켬(승인 A 철회, 항목 PLANNED, 작업 LEASED 그대로) → 원인 끔 → 승인 B → 실행 409 → lease 만료 → worker tick.
- 고치기 전에는 tick 결과가 `{ CONFIRMED: 1 }`(옛 작업이 B 로 게시)였고, 새 시험 3건이 실패했다(정상 대조 1건만 통과).
- 순서 메모: 재승인보다 lease 복구가 먼저면 항목이 QUEUED 로 돌아가 B 승인 자체가 409 `item_not_planned` 다(이미 안전). 결함은 옛 작업의 lease 가 복구되기 전에 재승인할 때만 생긴다.

### 처리
- `packages/db/src/jobs.ts`:
  - `approvalBindingOf(job, activeApprovalId)`: 작업 키 `publish:<itemId>:<approvalId>` 를 엄격하게 해석한다(세 부분, `publish`, item id 가 `job.itemId` 와 같음, UUID). 결과는 `null`(일치) / `'other_approval'` / `'key_unparsed'`.
  - `beginSend`: 기존 '승인 없음·hash 다름' 조건에 승인 불일치를 더했다. 같은 `stopUnlessPartial` 경로를 탄다: 부분 게시가 있으면 UNKNOWN `thread_partial_revoked`, 없으면 BLOCKED `approval_missing` + 항목 PLANNED. 이벤트에 `approval_binding` 을 남긴다.
- migration 은 없다(작업 행에 승인 칸이 없어 키를 읽음). 키는 T10 이후 `executePlan` 만 같은 형식으로 쓴다(검토자 확인: `git log -S`, restore 는 id 그대로).
- 경로 확인(구현자 + 검토자): 옛 승인으로 만든 작업이 새 승인으로 정당하게 이어지는 경로는 없다.
  - 승인은 PLANNED 항목에만 붙는다. 전송 중 항목은 다시 승인할 수 없다.
  - `retryItem` 은 BLOCKED 항목·작업이 필요하다.
  - 재개·재확인·사용자 확인은 같은 작업·같은 승인이거나 조회만 한다.
  - 복원 작업은 다시 보내지 않는다.
- `README_KO.md` A10 단락에 이 검사를 적었다.

### Claude 독립 검토
- 코드 추적(1명): **확정 0**.
  - 정당한 경로가 막히지 않는다. drill(`drill-matrix` A10 포함)·시험 고정값도 실행 경로로 작업을 만들거나 보내지 않는다.
  - 다른 경로로 새지 않는다: `send_start` 는 `beginSend` 안에서만 일어나고, `finishSend` 는 보내지 않는다.
  - 키 해석이 엄격하다(소문자 UUID — PG 출력도 소문자).
  - 추가 효과: worker 가 죽지 않아도 한 tick 에 여러 작업을 lease 하면 뒤 작업이 오래 LEASED 로 남는다. 그 사이의 철회·재승인도 이 검사가 막는다.
- 방어 장치(1명): **확정 0**.
  - 정확한 승인·부분 게시 재전송 금지·UNKNOWN 유지가 지켜진다. 막힌 뒤 다시 실행하면 새 키(승인 B)로 한 번 게시된다(`jobs_active_item_uq`·`approvals_active_item_uq` 충돌 없음).
  - 시험은 실제 진입 함수(`setChannelAccountState`·`updateIdea`·실행 route·`runJobsTick`)를 쓰고, 고치기 전에 실패한다.

### 시험
- 새 시험 `tests/integration/fullrev4-stale-leased-job.test.ts` 4건:
  1. 계정 끔→켬
  2. 위험 표시 붙임→해제
  3. 원인 없이 lease 만료(정상 게시 1회 대조)
  4. 읽을 수 없는 키(`legacy:`·다른 item id)
  - 1·2 는 막힘(`{BLOCKED:1}`·전송 0·`other_approval`)과 다음 실행 1회 게시를 확인한다.
- 기존 단언 변경: 없음.
- 변이 확인(구현자 보고): 새 조건을 빼면 같은 3건이 `{ CONFIRMED: 1 }` 로 실패한다. 원복 뒤 `cmp` 로 같음을 확인했다.
- 구현자의 단일 파일 실행: 통합 38개 파일 836건 통과.
- 보이지 않는 문자(주 세션): 0.

### 명령
클라우드 Node 22.22.0, `0020226` 와 같은 트리. 단계별 종료코드 기준:
- install(lockfile `8db0ef8abda74fda` 불변) · lint · typecheck · build: 각 exit 0
- **unit 89 files / 2260 · integration 79 files / 1332**: exit 0
- drill:mock 위반 0 · dev-cert 472/472 · deploy 셸 시험(비root) PASS
- not_run: 실제 Threads·계정, 실제 worker 비정상 종료 타이밍(시험은 lease 만료를 시각으로 흉내 냄).

### 남은 위험
1. 옛 작업이 다음 보내기 시도에서 막히기 전까지(lease TTL 60초 + tick 간격) 사용자의 실행은 409 다. 예전과 같고, 그 뒤에는 된다.
2. 같은 옛 작업이 보내기 전에 lease 만료를 5번 되풀이하면(worker 가 그때마다 죽거나 트랜잭션 예외) `beginSend` 에 닿지 못하고 FAILED(`lease_expired_before_intent`)로 끝난다. 이때 항목도 FAILED 가 되고 승인 B 는 남는다. 게시는 없고, 복구는 새 계획이다(FAILED 의 기존 경로).
   - 방어 장치 검토자 권고: 지금 고치지 않는다. 철회 때 LEASED 를 막으면 받아들인 G8 규칙을 되돌린다. 고친다면 `recoverExpiredLeases` 의 LEASED 분기에 같은 승인 일치 검사를 두는 것이 가장 작다.
3. 막힌 옛 작업의 키는 철회된 승인 A 를 계속 가리킨다(기록). 승인 B 는 활성 승인으로만 남는다.
4. 부분 게시가 있는 작업의 승인 불일치(→ UNKNOWN) 전용 시험은 없다(공유 분기이고 기존 시험이 다룬다).

### 검토자에게 물을 것
1. 남은 위험 2 를 지금 `recoverExpiredLeases` 에서 막을 가치가 있는가?
