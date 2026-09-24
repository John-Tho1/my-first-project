#!/usr/bin/env bash
# Codex CLI를 "검증자(reviewer)"로 실행한다.
#
#   ./scripts/codex-review.sh                  # 커밋 안 된 변경분을 리뷰
#   ./scripts/codex-review.sh --base main      # main 대비 현재 브랜치 전체를 리뷰
#   ./scripts/codex-review.sh --commit <SHA>   # 특정 커밋 하나를 리뷰
#
# 환경변수:
#   CODEX_MODEL              검증에 쓰는 모델. 기본 gpt-6-astra (2026-09-24 사용자 결정: 검증 호출은 항상 GPT-6 Astra / Extra High)
#   CODEX_REASONING_EFFORT   추론 강도. 기본 xhigh
#   두 값은 ~/.codex/config.toml 의 기본값(model / model_reasoning_effort)과 무관하게 이 스크립트가 명시적으로 고정한다.
#
#   ./scripts/codex-review.sh --selftest       # 검증 경로 자체 점검: 고정 문구 1회 호출 후 실제 모델·강도 헤더를 출력
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

CODEX_MODEL="${CODEX_MODEL:-gpt-6-astra}"
CODEX_REASONING_EFFORT="${CODEX_REASONING_EFFORT:-xhigh}"
# -c 값은 TOML 로 해석되므로 문자열은 따옴표로 감싼다. 배열 원소로 넘겨 셸이 다시 쪼개지 않게 한다.
MODEL_ARGS=(-m "$CODEX_MODEL" -c "model_reasoning_effort=\"$CODEX_REASONING_EFFORT\"")

MODE="uncommitted"
REF=""
case "${1-}" in
  --base)   MODE="base";   REF="${2:?--base 뒤에 브랜치명이 필요합니다}" ;;
  --commit) MODE="commit"; REF="${2:?--commit 뒤에 SHA가 필요합니다}" ;;
  --selftest)
    # 검증 경로 점검: 같은 실행 인수(sandbox·모델·강도·출력)로 고정 문구만 보낸다. 업무 파일은 싣지 않는다.
    mkdir -p .ai/handoff
    OUT=".ai/handoff/selftest-$(date +%Y%m%d-%H%M%S).md"
    LOG="${OUT%.md}.log"
    echo "▶ Codex 검증 경로 자체 점검 (model=$CODEX_MODEL, effort=$CODEX_REASONING_EFFORT) — 모델 사용량이 발생합니다." >&2
    codex exec --sandbox read-only "${MODEL_ARGS[@]}" -o "$OUT"       "Reply with exactly ASTRA_XHIGH_OK. Do not read or write files, execute commands, use tools, or invoke other agents."       </dev/null >"$LOG" 2>&1 || { echo "codex exec 실패 — $LOG 확인" >&2; exit 1; }
    echo "요청값: model=$CODEX_MODEL effort=$CODEX_REASONING_EFFORT" >&2
    echo "Codex 세션 헤더(실제 적용값):" >&2
    grep -E '^(model|reasoning effort|provider|sandbox|session id):' "$LOG" >&2 || echo "  (헤더 없음 — $LOG 확인)" >&2
    echo "응답: $(cat "$OUT")" >&2
    echo "$OUT"
    exit 0 ;;
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

# read-only 샌드박스에서는 파일 읽기 명령이 차단될 수 있다(Windows에서 확인됨).
# 따라서 프로젝트 규칙을 파일로 읽게 하지 않고 stdin에 직접 실어 보낸다.
RULES=""
if [ -f AGENTS.md ]; then
  RULES="$(cat AGENTS.md)"
fi

PROMPT="당신은 이 저장소의 독립 코드 리뷰어다. 구현자는 다른 에이전트이며, 당신의 역할은 동의가 아니라 검증이다.

리뷰 범위: ${SCOPE}

<stdin> 블록에 두 가지가 들어 있다.
1. AGENTS.md — 이 프로젝트의 규칙. 위반 여부를 반드시 확인하라.
2. diff — 검토 대상 변경분.

다음 형식의 마크다운 리포트만 출력하라. 서론·칭찬·요약 인사말은 쓰지 마라.

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
- 샌드박스가 파일 읽기를 막을 수 있다. 차단되면 재시도하지 말고, 판단에 필요한 정보가
  <stdin>에 없는 항목은 '미확인'으로 표시한 뒤 나머지를 마저 검토하라."

CMD=(codex exec --sandbox read-only "${MODEL_ARGS[@]}" -o "$OUT")

echo "▶ Codex 리뷰 실행 중 ($SCOPE, ${DIFF_BYTES}B, model=$CODEX_MODEL, effort=$CODEX_REASONING_EFFORT)..." >&2
{
  if [ -n "$RULES" ]; then
    printf '===== AGENTS.md (프로젝트 규칙) =====\n%s\n\n' "$RULES"
  fi
  printf '===== diff (검토 대상) =====\n%s\n' "$DIFF"
} | "${CMD[@]}" "$PROMPT" >/dev/null

echo "$OUT"
