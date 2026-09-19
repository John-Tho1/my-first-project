#!/usr/bin/env bash
# Codex CLI를 "검증자(reviewer)"로 실행한다.
#
#   ./scripts/codex-review.sh                  # 커밋 안 된 변경분을 리뷰
#   ./scripts/codex-review.sh --base main      # main 대비 현재 브랜치 전체를 리뷰
#   ./scripts/codex-review.sh --commit <SHA>   # 특정 커밋 하나를 리뷰
#
# 환경변수:
#   CODEX_MODEL   사용할 모델 (미지정 시 Codex 기본값)
#
# 산출물: .ai/handoff/review-<timestamp>.md
# Codex는 read-only 샌드박스로 돌기 때문에 이 스크립트는 코드를 고치지 않는다.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI를 찾을 수 없습니다. docs/ai-pair-setup.md의 1단계를 먼저 수행하세요." >&2
  exit 127
fi

MODE="uncommitted"
REF=""
case "${1-}" in
  --base)   MODE="base";   REF="${2:?--base 뒤에 브랜치명이 필요합니다}" ;;
  --commit) MODE="commit"; REF="${2:?--commit 뒤에 SHA가 필요합니다}" ;;
  "")       ;;
  *)        echo "알 수 없는 옵션: $1" >&2; exit 2 ;;
esac

case "$MODE" in
  uncommitted)
    DIFF="$(git diff HEAD)"
    SCOPE="커밋되지 않은 작업 트리 변경분"
    UNTRACKED="$(git ls-files --others --exclude-standard)"
    if [ -n "$UNTRACKED" ]; then
      echo "⚠ 추적되지 않는 파일은 diff에 포함되지 않습니다. 리뷰하려면 먼저 git add 하세요:" >&2
      printf '  %s\n' $UNTRACKED >&2
    fi
    ;;
  base)        DIFF="$(git diff "$REF"...HEAD)";           SCOPE="$REF 대비 현재 브랜치의 변경분" ;;
  commit)      DIFF="$(git show --format=%B "$REF")";      SCOPE="커밋 $REF" ;;
esac

if [ -z "${DIFF// }" ]; then
  echo "리뷰할 변경분이 없습니다 ($SCOPE)." >&2
  exit 0
fi

DIFF_BYTES=$(printf '%s' "$DIFF" | wc -c | tr -d ' ')
if [ "$DIFF_BYTES" -gt 200000 ]; then
  echo "diff가 ${DIFF_BYTES}바이트로 너무 큽니다. 범위를 좁혀서 다시 실행하세요 (--commit 권장)." >&2
  exit 1
fi

mkdir -p .ai/handoff
OUT=".ai/handoff/review-$(date +%Y%m%d-%H%M%S).md"

PROMPT="당신은 이 저장소의 독립 코드 리뷰어다. 구현자는 다른 에이전트이며, 당신의 역할은 동의가 아니라 검증이다.

리뷰 범위: ${SCOPE}
프로젝트 규칙: AGENTS.md를 먼저 읽고 그 규칙 위반 여부를 반드시 확인하라.

변경 내용은 <stdin> 블록의 diff에 있다. 다음 형식의 마크다운 리포트만 출력하라. 서론·칭찬·요약 인사말은 쓰지 마라.

## 판정
PASS 또는 CHANGES_REQUESTED 중 하나.

## 지적 사항
각 항목을 아래 형식으로. 없으면 '없음'이라고만 쓴다.
- [심각도: high|medium|low] 파일:줄 — 문제 한 줄 요약
  - 재현/실패 시나리오: 어떤 입력·상태에서 어떻게 잘못되는가
  - 제안: 구체적인 수정 방향

## 놓친 케이스
테스트나 수동 확인에서 빠졌을 가능성이 높은 입력·경계값 목록.

규칙:
- 추측을 사실처럼 쓰지 마라. diff에서 확인되지 않는 것은 '미확인'으로 표시하라.
- 취향 문제(포매팅, 네이밍 선호)는 적지 마라. 동작·정확성·규칙 위반만 적어라.
- diff에 없는 파일의 내용이 필요하면 읽어서 확인한 뒤 판단하라."

CMD=(codex exec --sandbox read-only -o "$OUT")
[ -n "${CODEX_MODEL-}" ] && CMD+=(-m "$CODEX_MODEL")

echo "▶ Codex 리뷰 실행 중 ($SCOPE, ${DIFF_BYTES}B)..." >&2
printf '%s\n' "$DIFF" | "${CMD[@]}" "$PROMPT" >/dev/null

echo "$OUT"
