-- FIX-T11·T12(Codex review-T11·T12): drizzle-kit 출력(첫 문장 — jobs.restored_needs_review) + 손으로 더한 계획 상태 재계산.
-- (1) jobs.restored_needs_review: 묶음에서 복원한 작업(읽기 전용 이력). 복원은 진행 중이던 작업을 UNKNOWN/BLOCKED 로 넣고 이 표시를 켠다 —
--     worker 는 UNKNOWN·BLOCKED 를 lease 하지 않고, 재시도 API 는 이 표시가 있으면 거부한다. 사용자 재확인(조회만)은 가능하다.
-- (2) 계획 상태 재계산(0018 의 부분 재분류를 대신함): 모든 계획을 항목 상태 + 활성 승인 수로 @cs/domain planStatusFrom 과 같은 규칙으로 다시 계산한다.
--     규칙(우선순위): 항목 없음 → draft / 진행 중(QUEUED·SENDING·REMOTE_PROCESSING·RETRY_WAIT·RECONCILING·CANCEL_REQUESTED) 있음 → executing /
--     모두 PLANNED → 활성 승인 0 draft·전부 approved·그 밖 partially_approved / 모두 CONFIRMED → completed / 모두 CANCELED → canceled /
--     CONFIRMED·PARTIAL 있음 → partial / BLOCKED·UNKNOWN·PLANNED 있음 → attention / 나머지 → failed. 바뀐 계획만 revision + 1.
ALTER TABLE "jobs" ADD COLUMN "restored_needs_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
WITH s AS (
  SELECT p.id,
    count(i.id) AS n,
    count(i.id) FILTER (WHERE i.status IN ('QUEUED', 'SENDING', 'REMOTE_PROCESSING', 'RETRY_WAIT', 'RECONCILING', 'CANCEL_REQUESTED')) AS in_flight,
    count(i.id) FILTER (WHERE i.status = 'PLANNED') AS planned,
    count(i.id) FILTER (WHERE EXISTS (SELECT 1 FROM approvals a WHERE a.distribution_item_id = i.id AND a.revoked_at IS NULL)) AS approved,
    count(i.id) FILTER (WHERE i.status = 'CONFIRMED') AS confirmed,
    count(i.id) FILTER (WHERE i.status = 'CANCELED') AS canceled,
    count(i.id) FILTER (WHERE i.status IN ('CONFIRMED', 'PARTIAL')) AS some_success,
    count(i.id) FILTER (WHERE i.status IN ('BLOCKED', 'UNKNOWN', 'PLANNED')) AS needs_user
  FROM distribution_plans p
  LEFT JOIN distribution_items i ON i.plan_id = p.id
  GROUP BY p.id
), r AS (
  SELECT id,
    CASE
      WHEN n = 0 THEN 'draft'
      WHEN in_flight > 0 THEN 'executing'
      WHEN planned = n THEN CASE WHEN approved = 0 THEN 'draft' WHEN approved = n THEN 'approved' ELSE 'partially_approved' END
      WHEN confirmed = n THEN 'completed'
      WHEN canceled = n THEN 'canceled'
      WHEN some_success > 0 THEN 'partial'
      WHEN needs_user > 0 THEN 'attention'
      ELSE 'failed'
    END AS status
  FROM s
)
UPDATE "distribution_plans" p SET "status" = r.status, "revision" = p."revision" + 1, "updated_at" = now()
FROM r WHERE r.id = p.id AND p."status" IS DISTINCT FROM r.status;
