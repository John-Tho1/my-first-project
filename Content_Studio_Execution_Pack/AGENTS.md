# Content Studio — shared project instructions
Purpose: a private content capture, writing, archive and explicitly approved distribution app.
Read README_KO.md and the relevant docs before changing code. This is a specification pack; no application is implemented yet.

## Scope
Audience: overseas business/sales practitioners and managers interested in working abroad.
Content: overseas business/sales operations, AI application, overseas/expatriate experience.
Use public, synthetic or user-confirmed personal material. No employer confidential data, clients, staff, private commercial figures, credentials, or unrelated project memory.
Keep Korean product UI. Show actual publication visibility and verification status.

## Collaboration
All work runs in Claude Code (user decision 2026-11-07, D42 — Codex is not used).
The Claude Code main session is the implementer. Independent verification is done by Claude reviewer subagents in a fresh context, read-only, for the specified BASE/HEAD (prompts/CLAUDE_REVIEW.md, docs/06_AGENT_WORKFLOW.md).
One bounded task per handoff. Do not edit the same worktree concurrently (implementers run one after another; reviewers are read-only).
Reviewers report findings; the main session reproduces each finding before fixing it.
Label Claude reviews as Claude reviews. Never present them as another tool's verdict.
No automatic merge/deploy. No invented test results or claims that another agent ran.

## Invariants
- No publish without server-validated approval of exact payload, assets, account, visibility and schedule.
- Edits invalidate relevant approval; LLM output never grants approval.
- Unknown remote outcome must reconcile or remain UNKNOWN; never blindly resubmit.
- Default LLM mock, publishing disabled, collectors disabled. Mock success never becomes a real publication.
- Keep credentials on server; never put secrets in repo, browser, LLM prompts or logs.
- Existing Notion/Drive integrations in another app are not this app's credentials.
- Preserve raw source and version history. AI cannot invent personal experiences or citations.
- Include portable export and restore.
- Enforce these in server/domain/tests, not only this instruction file.

## Work rules
Inspect existing repository/AGENTS, preserve unrelated work, use lockfile and documented versions.
Implement only selected milestone/task; do useful local/mock work while external account prerequisites are pending.
Do not weaken assertions, sandbox controls or approval checks to obtain a pass.
Before real external connections, paid API calls, publishing or production deployment, present exact scope for explicit approval unless already covered by that exact approval.
Record actual commands, pass/fail/not_run, BASE_SHA, HEAD_SHA and remaining risks.
Put review/handoff artifacts in gitignored .handoffs/ or outside the repository; do not change reviewed HEAD merely to record its SHA.

