-- FIX-T11 round 3(Codex review-FIX2-T11T12 0022:3): 0022 이전 worker 는 lease 때 attempt 를 먼저 올렸다(전송 의도 없이). 새 규칙(시도는 의도를 쓸 때만,
-- beginSend)으로 업그레이드하면 그 선증가분만큼 전송 기회를 잃는다(예: 의도 1개·attempt 2 → 다음 의도 #3, 의도 4개·attempt 5 → attempts_exhausted).
-- 끝나지 않은 작업 중 attempt 가 그 작업의 가장 큰 전송 의도 번호보다 크면 attempt 를 그 번호(의도 없으면 0)로 되돌린다. 이미 의도가 있는 시도 번호는
-- 그대로 둔다 — 개수(count)가 아니라 최대 번호를 쓰는 이유: 예전 만료 복구가 번호를 건너뛰었을 수 있고(의도 #2 만 있음), 다음 의도 key
-- '<job>:<attempt+1>' 가 기존 key 와 겹치면 안 된다(send_intents_intent_key_uq).
-- 전제: **구버전 worker(CLI·inline tick)를 멈춘 뒤** 적용한다 — 적용 중에 구버전이 lease 하면 다시 선증가한다. 끝난 작업(CONFIRMED·FAILED·CANCELED)은 건드리지 않는다.
UPDATE "jobs" j SET "attempt" = coalesce((SELECT max(si."attempt") FROM "send_intents" si WHERE si."job_id" = j."id"), 0), "updated_at" = now()
WHERE j."state" NOT IN ('CONFIRMED', 'FAILED', 'CANCELED')
  AND j."attempt" > coalesce((SELECT max(si."attempt") FROM "send_intents" si WHERE si."job_id" = j."id"), 0);
