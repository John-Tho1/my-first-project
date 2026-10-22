# 전체 코드 독립 검토 기록 1차 — content-studio/m4 a0521fe (origin/main 대비)

- **Claude 독립 검토이며 Codex 판정이 아니다.** 사용자 지시(2026-10-21 "현재까지의 전체 코드 리뷰를 클로드 코드 리뷰로 진행해줘")로 클라우드 세션에서 실행했다. Codex 상태는 "미검증" 그대로다.
- 대상: `origin/main...a0521fe` 의 `Content_Studio_Execution_Pack/` 전체(631 files). 시험 실행 없는 정적 검토.
- 방식: Claude Code `code-review` 스킬(전체 앱 대상 1회) → 지적 10건. #10 은 오케스트레이터가 D28·D30 으로 직접 기각, 나머지 9건은 지적마다 읽기 전용 반박 검증자 3명(코드 추적·다른 가드·명세 관점, 2표 이상 유지 시 확정). 검증 에이전트 27개·실패 0.
- 한계: 한 번 훑는 방식이라 631 files 를 빠짐없이 봤다는 보장은 없다 [추정].
- 결과: 확정 7건(P1 3·P2 4), 기각 3건. FIX 는 FIX1-FULLREV 로 처리(`docs/handoffs/FULLREV1_IMPLEMENTATION_HANDOFF.md`).

## 확정된 지적
| # | 심각도(검증자) | 위치 | 내용 |
|---|---|---|---|
| F1 | P1 (P1/P1/P2) | `packages/db/src/live-publish.ts:49` | pendingLiveJobs counts orphan BLOCKED jobs (item back to PLANNED after revoke/invalidation or beginSend approval_missing/snapshot_stale) that can never send, retry or be cancelled, so with PUBLISH_LIVE_MAX_POSTS=1 every re-approve + execute returns 429 live_publish_limit under any approval ref |
| F2 | P1 (P1/P1/P1) | `packages/db/src/approval-invalidation.ts:269` | Approval revoke/invalidation sends the item back to PLANNED even when its job already published thread parts (or has a publish_attempt marker); re-approve + execute creates a fresh job that republishes them (D26/A11). cancelItem guards this, revoke does not |
| F3 | P1 (P1/P1/P1) | `apps/web/app/record/RecordClient.tsx:168` | Upload accepts only exact canonical File.type (server planUpload too); browser aliases such as audio/x-m4a, audio/x-wav, audio/mp3 and an empty type are rejected, so an iPhone Voice Memo (.m4a) cannot be uploaded in Chrome/Safari [추정: 브라우저 보고값은 검증자 기억] |
| F5 | P2 (P2/P2/P2) | `packages/domain/src/zip.ts:191` | readZip (restore) does not reject overlapping entry data ranges (imports.ts listZip does since FIX-T18 r2) and copies each entry, so a crafted 256MB ZIP can exhaust memory |
| F6 | P2 (P2/P2/P2) | `apps/web/lib/oauth.ts:174` | mockTestParamsAllowed reads NODE_ENV through a process.env alias at runtime, so a production build started with NODE_ENV=development accepts mock_user/mock_grant/mock_deny |
| F7 | P2 (P2/P2/P2) | `packages/domain/src/content.ts:159` | Search date validator only checks Date.parse is not NaN; impossible dates such as 2026-02-30 roll over and the filter silently includes March 1-2 |
| F9 | P2 (P2/P2/P2) | `packages/db/src/live-publish.ts:25` | liveApprovalUsage / livePublishDailyUsage scan all of send_intents (no index on the jsonb ref / owner+created_at) under exclusive advisory locks; the append-only table only grows. pendingLiveJobs uses the job_id index (part of the finding overstated) |

## 기각된 지적 (반박 근거)
- **F4 `packages/db/src/writing.ts:575` — 실제 LLM 호출 성공 뒤 마무리 트랜잭션 실패·프로세스 중단 시 run 'running'·원장 'reserved' 가 남음 (유지 1/3, 기각)**
  - 동작은 사실이다. 그러나 D12·D13 Consequences 와 LIVEL1 인계 남은 위험 10번("D13 의 기존 위험 그대로")에 받아들인 위험으로 기록돼 있고, D34·D35 승인이 그 위험을 안고 이뤄졌다.
  - 예약액은 입력 추정 + max_tokens 상한이라 실제 비용 이상이어서 월 합계는 많게 센다(막는 쪽으로 실패). "실제 지출을 적게 센다"는 주장은 사실상 닿지 않는다.
- **F8 `packages/db/src/jobs.ts:368` — fillIntent 가 결과 기록 때 sanitized_details 의 approval_id·adapter 를 버림 (유지 1/3, 기각)**
  - 실제로 버린다. 그러나 send_intent 는 job_id 로 작업에 묶이고, 작업은 승인 하나마다 만들어지며(idempotency_key `publish:<item>:<approval.id>`) 지워지지 않는다. 승인과의 감사 연결은 끊기지 않는다.
  - D26·D38 이 남기라고 정한 키(adapter_id·live_approval_ref)는 보존한다. approval_id 를 send_intents 에서 읽는 코드도 없다.
- **#10 `docs/handoffs/LIVEL1H2_IMPLEMENTATION_HANDOFF.md:1` — 인계·검토 기록을 추적 docs/handoffs/ 에 docs 전용 커밋으로 남김 (오케스트레이터 기각)**
  - AGENTS.md 의 ".handoffs/" 규칙에 대한 예외가 D28(2026-10-02)로 정해졌고, D30 4번(사용자 결정)에서 "현재 방식 유지"로 확인됐다.
