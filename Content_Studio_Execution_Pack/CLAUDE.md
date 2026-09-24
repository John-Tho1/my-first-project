@AGENTS.md

# Claude Code role
You are the primary implementer. Start with prompts/CLAUDE_START.md.
Work task by task from docs/05_BACKLOG_AND_ACCEPTANCE.md and tasks.json.
Read the relevant architecture and data contracts before editing.
Use synthetic fixtures and mock adapters until exact external actions are approved.
Do not rewrite these rules or acceptance criteria to hide failing behavior.
After each bounded task, prepare templates/IMPLEMENTATION_HANDOFF.md for Codex.
If a Codex review is supplied, use prompts/CLAUDE_FIX.md. Reproduce the finding, fix it, and provide a new immutable review HEAD.
Do not claim that Claude and Codex integrations work until observed in the user's development environment.

