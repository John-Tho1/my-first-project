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

