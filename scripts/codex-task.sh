#!/usr/bin/env bash
# Codex CLI에 격리된 서브 개발 작업을 위임한다.
#
#   ./scripts/codex-task.sh "입력값 검증에 음수 처리를 추가해줘"
#   ./scripts/codex-task.sh --dry "..."     # 코드를 고치지 않고 계획만 받는다
#
# 환경변수:
#   CODEX_MODEL   사용할 모델 (미지정 시 Codex 기본값)
#
# 산출물: .ai/handoff/task-<timestamp>.md  (Codex의 최종 보고)
# 주의: --dry가 아니면 Codex가 작업 트리를 직접 수정한다. 실행 후 반드시 git diff로 확인할 것.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI를 찾을 수 없습니다. docs/ai-pair-setup.md의 1단계를 먼저 수행하세요." >&2
  exit 127
fi

SANDBOX="workspace-write"
if [ "${1-}" = "--dry" ]; then
  SANDBOX="read-only"
  shift
fi

TASK="${1:?작업 지시문을 인자로 넘기세요}"

if [ -n "$(git status --porcelain)" ] && [ "$SANDBOX" = "workspace-write" ]; then
  echo "⚠ 작업 트리에 커밋되지 않은 변경이 있습니다. Codex의 변경과 섞이면 구분이 어렵습니다." >&2
  echo "  계속하려면 Enter, 중단하려면 Ctrl-C." >&2
  read -r _
fi

mkdir -p .ai/handoff
OUT=".ai/handoff/task-$(date +%Y%m%d-%H%M%S).md"

PROMPT="AGENTS.md의 규칙을 먼저 읽고 그 범위 안에서 작업하라.

요청: ${TASK}

제약:
- 요청된 범위만 수정한다. 리팩터링·포매팅·의존성 추가를 임의로 하지 마라.
- 커밋하지 마라. 작업 트리만 수정한다.
- 확신이 서지 않는 결정은 임의로 정하지 말고 보고에 '판단 필요'로 남겨라.

마지막에 다음 형식으로만 보고하라.
## 변경한 파일
- 경로 — 무엇을 왜 바꿨는지 한 줄
## 검증한 것
실제로 실행해서 확인한 내용. 확인하지 않았으면 '없음'이라고 써라.
## 판단 필요
사람이 결정해야 할 항목. 없으면 '없음'."

CMD=(codex exec --sandbox "$SANDBOX" -o "$OUT")
[ -n "${CODEX_MODEL-}" ] && CMD+=(-m "$CODEX_MODEL")

echo "▶ Codex 위임 실행 중 (sandbox=$SANDBOX)..." >&2
"${CMD[@]}" "$PROMPT" >/dev/null

echo "$OUT"
[ "$SANDBOX" = "workspace-write" ] && echo "→ git diff 로 변경 내용을 직접 확인하세요." >&2
exit 0
