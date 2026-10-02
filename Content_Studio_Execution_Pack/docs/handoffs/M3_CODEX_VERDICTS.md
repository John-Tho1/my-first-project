# Codex 판정 요약 (M3, GPT-6 Astra / xhigh, 로컬 실행 2026-09-25)

전문은 로컬 `.handoffs/review-*.md`(gitignore). 판정과 지적 제목만 옮긴다.

## T10 — CHANGES_REQUESTED
- [P0] `packages/db/src/restore.ts:267`
- [P1] `packages/db/src/distribution.ts:169`
- [P1] `packages/db/src/approval-invalidation.ts:43`
- [P1] `packages/domain/src/bundle.ts:424`
- [P2] `packages/domain/src/distribution.ts:115`

## FIX-T10 — CHANGES_REQUESTED
- [P1] packages/db/drizzle/0019_t10_fix_restore_triggers.sql:26
- [P1] packages/db/drizzle/0019_t10_fix_restore_triggers.sql:31

## FIX2-T10 — PASS

## T11 — CHANGES_REQUESTED
- [P0] packages/providers/src/channel-adapter.ts:283
- [P1] packages/db/src/jobs.ts:725
- [P1] packages/domain/src/bundle.ts:110
- [P2] apps/web/app/distribute/[id]/page.tsx:267

## T12 — CHANGES_REQUESTED
- [P0] packages/db/src/approval-invalidation.ts:44
- [P1] packages/db/drizzle/0018_t12_mock_scenarios.sql:22
- [P2] apps/web/lib/distribution.ts:269

## FIX-T11T12 — CHANGES_REQUESTED
- [P1] packages/db/src/jobs.ts:276
- [P2] apps/web/app/distribute/[id]/page.tsx:28
- [P2] apps/web/lib/distribution.ts:332

## FIX2-T11T12 — CHANGES_REQUESTED
- [P1] packages/db/drizzle/0022_t11_fix2_pre_intent_expiry.sql:3

## FIX3-T11 — PASS


# Codex 판정 요약 (T20 모의·로컬 부분, GPT-6 Astra / xhigh, 로컬 실행 2026-10-01~02)

## T20 (41ff399) — CHANGES_REQUESTED
- [P0] packages/db/src/retention.ts:77 — 실제 파일 존재 여부보다 실행 기록 순위를 먼저 적용해 마지막 로컬 백업까지 삭제할 수 있음
- [P1] packages/db/src/restore-drill.ts:184 — 안전 상태와 금액까지 비교에서 제외하여 잘못된 복원도 PASS가 될 수 있음
- [P1] packages/db/src/restore-drill.ts:244 — 준비·비교 단계에서 예외가 발생하면 실패한 훈련이 기록되지 않음
- [P2] packages/db/src/ops.ts:246 — 확인 필요 작업·계획을 50개로 제한하면서 화면에서는 전체 개수처럼 표시함
- [P2] packages/db/src/ops.ts:46 — 디렉터리 탐색 실패를 정상적인 0바이트 또는 완전한 측정값으로 반환함
- Codex 질문 답 요지: Q1 변환 열 전체 제외는 불안전 → 기대 변환값 비교(FIX 반영). Q2 빈 표 일치는 허용하되 검증 범위 표시(FIX: emptyTables). Q4 /ops 도 캐시 공유·진행 중 Promise 공유(FIX 반영). **Q5 백업 나이는 사용 가능한 파일/확인된 외부 사본 기준이어야 함(미반영, 사용자 결정 D22-c 와 연결). Q6 health `ops` 숫자는 세션 뒤로(미반영, 사용자 결정).**

## FIX-T20 (0c0d969) — CHANGES_REQUESTED
- [P0] packages/db/src/retention.ts:86 — 크기가 같은 손상 ZIP을 정상 백업으로 인정해 마지막 복원 가능한 백업을 삭제할 수 있음
- [P1] packages/db/src/restore-expect.ts:79 — 승인 철회·파생본 강등의 기대값을 검증 대상의 반환값으로 결정하여 잘못된 복원을 통과시킬 수 있음
- [P2] packages/db/src/restore-expect.ts:153 — 일반 JSON 값의 `sameOrRestoreTime` 키가 내부 비교 표식과 충돌함
- [P2] packages/db/src/ops.ts:141 — 진행 중인 디스크 측정에도 TTL을 적용하여 느린 측정이 중복 실행됨
- 답 요지: 크기 일치는 무결성 검사가 아님(해시·ZIP 구조 검증 필요); 선언된 철회·강등 신뢰는 불충분(묶음에서 재도출); 시간 허용 범위는 복원 호출 전후로 좁힐 것; 하위 트리 소실은 partial 로; Q5·Q6 는 그대로 유지(사용자 결정).

## FIX2-T20 (cef5eaf, 보존 정리 놓친 케이스) — CHANGES_REQUESTED
- [P1] packages/db/src/retention.ts:136 — ZIP이 존재하지만 손상되거나 읽히지 않는 실행까지 `dir_only`로 분류해 폴더를 삭제한다
- [P2] packages/db/src/retention.ts:324 — ZIP 삭제와 폴더 삭제를 하나의 결과로 합쳐 실제 삭제량을 잘못 기록한다
- 답 요지: advisory lock 은 적절하나 파일 삭제는 롤백 불가 → 삭제 예정 기록을 먼저 커밋하고 결과를 조정하는 구조 권고; 실패만 있어도 감사 기록 필요; 실제 PostgreSQL 동시성 미확인(not_run).

## FIX3-T20 (9458dff, round 3: review-FIX-T20 + review-FIX2-T20 반영) — CHANGES_REQUESTED
- [P0] packages/db/src/retention.ts:123 — 검증 캐시 때문에 손상된 ZIP을 보존 대상으로 세고 마지막 정상 백업을 삭제할 수 있다
- [P1] packages/db/src/restore-expect.ts:257 — 모호한 예약 승인을 항상 비활성으로 계산하여 정상 복원을 FAIL로 판정한다
- [P1] packages/db/src/ops.ts:402 — 계획과 결과를 시각만으로 연결하여 다른 정리 실행의 결과를 잘못 합친다
- [P2] packages/db/src/retention.ts:454 — 계획된 파일이 모두 이미 없으면 정상 종료해도 결과 미기록으로 표시한다
- 답 요지: 삭제 직전 남길 ZIP 은 캐시 없이 실제 바이트 재검증; 복원 판정용 시각 주입; sweep_id 로 계획·결과 연결; manifest 해시는 파서가 누락·변조를 검사한다면 충분(파서 본문 미확인); 다중 PostgreSQL 작업자용 프로세스 간 배타는 미해결(not_run).

## FIX4-T20 (19986fc, round 4: review-FIX3-T20 반영) — CHANGES_REQUESTED (P0 없음)
- [P1] packages/db/src/retention.ts:441 — 삭제 후보의 캐시된 검증 결과는 그대로 신뢰하므로 손상 ZIP과 폴더가 삭제될 수 있다
- [P1] packages/db/src/ops.ts:433 — 최근 1,000개 제한 때문에 오래된 미완료 정리가 경고에서 사라진다
- 답 요지: 삭제 후보도 캐시 없이 재검증; 미완료 sweep 은 전체 대상 NOT EXISTS 조회; 재검증 실패 시 package 정리까지 중단할 필요는 없으나 전체 성공으로 표현 금지; jobs·approvals 한쪽만 비어도 미검증 범위 표시; 여러 PostgreSQL worker 지원 전엔 영속 sweep 상태 구조 권고(단일 worker 범위 밖).

## FIX5-T20 (82cde4a, round 5: review-FIX4-T20 반영) — CHANGES_REQUESTED (P2 1건만)
- [P2] apps/web/app/ops/page.tsx:277 — 정상 ZIP이 다시 생긴 경우도 백업 손상·읽기 실패로 표시한다
- 답 요지: 이전 라운드 방향 모두 적절(독립 기대값·전 컬럼 비교, 삭제 직전 실제 바이트 검증, 판정 시각 고정, 실패도 감사). Q5·Q6 권고 유지(사용자 결정). 다중 PostgreSQL 프로세스 동시성은 계속 not_run.

## FIX6-T20 (6e99eef, round 6: review-FIX5-T20 반영) — **PASS** (지적 없음)
- 남은 "놓친 케이스"(테스트 보강 제안, 결함 아님): 재등장 테스트에서 outcome partial·rmDir 0회 직접 검증, partialRetentionSweeps 의 owner 격리·표시 한도·동일 시각 정렬, 재등장으로 보존한 ZIP 의 다음 정리 재평가, 감사 JSON 의 배열·불리언·음수·빈 문자열 sweep_id. 실제 PostgreSQL 다중 프로세스 삭제 경쟁은 not_run.

## D23 (f7fbae8, 공개 /api/health 에서 ops 제거 → GET /api/ops/summary) — **PASS** (지적 없음)
- 답 요지: 공개 health 에 남은 `jobs`(attention_plans 포함)·`uploads`·`db.captures` 도 세션 뒤로 옮기기를 권고(이번 결정 범위 밖 → 사용자 결정 대상). 폴더 바이트를 owner 응답에 포함하는 것은 단일 owner 배포에서만 허용 가능.
- 놓친 케이스(테스트 보강 제안): 503 응답에도 ops 없음, A·B 각각 비영 데이터 분리, 만료 세션 401, 반복 실패 50개 초과 — 마지막 항목은 오케스트레이터가 확인: `repeatedFailures` 쿼리에 상한 없음(결함 아님).
