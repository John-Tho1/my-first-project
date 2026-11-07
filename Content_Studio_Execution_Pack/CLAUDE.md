@AGENTS.md

# Claude Code role
You are the primary implementer and you also run independent verification (D42 — Codex is not used). Start with prompts/CLAUDE_START.md.
Work task by task from docs/05_BACKLOG_AND_ACCEPTANCE.md and tasks.json.
Read the relevant architecture and data contracts before editing.
Use synthetic fixtures and mock adapters until exact external actions are approved.
Do not rewrite these rules or acceptance criteria to hide failing behavior.
After each bounded task, commit the code, prepare templates/IMPLEMENTATION_HANDOFF.md, then run an independent Claude review with prompts/CLAUDE_REVIEW.md (fresh-context, read-only reviewer subagents; see docs/06_AGENT_WORKFLOW.md).
For the review findings, use prompts/CLAUDE_FIX.md. Reproduce each finding, fix it, and provide a new immutable review HEAD for re-review.
Gate before reporting a task done: confirmed P0/P1 = 0, the full verification run passes on the exact HEAD, and confirmed P2 findings are fixed or recorded as remaining risks.
Do not claim that integrations work until observed in the user's development environment.
