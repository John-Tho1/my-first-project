---
description: 독립적인 단위 작업을 Claude 서브에이전트에 위임하고 결과 diff를 검토한다
allowed-tools: Agent, Bash(git diff:*), Bash(git status:*), Read
---

다음 작업을 Claude 서브에이전트에 위임하라: $ARGUMENTS

절차:
1. 위임 전에 `git status --porcelain`으로 작업 트리가 깨끗한지 확인한다. 깨끗하지 않으면 사용자에게 먼저 알린다.
2. Agent 도구로 서브에이전트를 띄운다. 작업 범위·건드릴 파일·금지 사항(AGENTS.md 규칙, 커밋·git 상태 변경 금지, 새 의존성 금지, 시험 약화 금지)을 명시한다.
   같은 작업 트리에서 다른 에이전트와 동시에 고치지 않는다.
3. `git diff` 로 서브에이전트가 실제로 바꾼 내용을 확인한다.
4. AGENTS.md의 규칙을 위반한 변경이 있으면 되돌리고 사용자에게 보고한다.
5. 변경 요약 + 위험 요소를 3~5줄로 보고한다. 커밋은 사용자 지시가 있을 때만 한다.
