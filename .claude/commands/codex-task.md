---
description: 독립적인 단위 작업을 Codex CLI에 위임하고 결과 diff를 검토한다
allowed-tools: Bash(./scripts/codex-task.sh:*), Bash(git diff:*), Bash(git status:*), Read
---

다음 작업을 Codex에 위임하라: $ARGUMENTS

절차:
1. 위임 전에 `git status --porcelain`으로 작업 트리가 깨끗한지 확인한다. 깨끗하지 않으면 사용자에게 먼저 알린다.
2. `./scripts/codex-task.sh "$ARGUMENTS"` 를 실행한다.
3. `git diff` 로 Codex가 실제로 바꾼 내용을 확인한다.
4. AGENTS.md의 규칙을 위반한 변경이 있으면 되돌리고 사용자에게 보고한다.
5. 변경 요약 + 위험 요소를 3~5줄로 보고한다. 커밋은 사용자 지시가 있을 때만 한다.
