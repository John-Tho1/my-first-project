#!/usr/bin/env bash
# Content Studio 작업별 커밋 Codex 검증 (docs/06 절차, LOCAL_RUNBOOK §2).
#
#   ./scripts/codex-review-commit.sh <SHA> [작업명] [인계문서 경로]
#   예) ./scripts/codex-review-commit.sh be3fd8f T05 .handoffs/T05_IMPLEMENTATION_HANDOFF.md
#
# 왜 codex exec + stdin 인가: Windows 의 read-only 샌드박스는 `codex review --commit` 이 쓰는 셸 명령을 모두 막아 빈 결과가 나온다.
# 그래서 AGENTS.md·인계 문서·diff 를 stdin 에 싣는다(상위 저장소 scripts/codex-review.sh 와 같은 방식).
# 생성 파일(pnpm-lock.yaml, drizzle/meta/*_snapshot.json)은 diff 에서 제외한다.
#
# 환경변수: CODEX_MODEL(기본 gpt-6-astra), CODEX_REASONING_EFFORT(기본 xhigh) — 2026-09-24 사용자 결정(검증은 항상 Astra / Extra High).
# 산출물: .handoffs/review-<작업명>.md (마지막 메시지), .handoffs/review-<작업명>.log (세션 헤더: 실제 model / reasoning effort)
set -euo pipefail

PACK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PACK"
SHA="${1:?커밋 SHA 가 필요합니다}"
LABEL="${2:-$(git rev-parse --short "$SHA")}"
HANDOFF="${3:-}"
CODEX_MODEL="${CODEX_MODEL:-gpt-6-astra}"
CODEX_REASONING_EFFORT="${CODEX_REASONING_EFFORT:-xhigh}"
MODEL_ARGS=(-m "$CODEX_MODEL" -c "model_reasoning_effort=\"$CODEX_REASONING_EFFORT\"")
EXCL=( ':(exclude,glob)**/pnpm-lock.yaml' ':(exclude,glob)**/drizzle/meta/*_snapshot.json' )

command -v codex >/dev/null || { echo "codex CLI 를 찾을 수 없습니다" >&2; exit 127; }
mkdir -p .handoffs
OUT=".handoffs/review-$LABEL.md"
LOG=".handoffs/review-$LABEL.log"

DIFF="$(git show --no-color --format=%B "$SHA" -- . "${EXCL[@]}")"
[ -n "${DIFF// }" ] || { echo "리뷰할 변경분이 없습니다 ($SHA)" >&2; exit 0; }

read -r -d '' PROMPT <<'P' || true
당신은 이 저장소(Content Studio)의 독립 코드 리뷰어다. 구현자는 다른 에이전트(Claude Code)이며, 당신의 역할은 동의가 아니라 검증이다.

<stdin> 블록에 세 가지가 들어 있다.
1. AGENTS.md — 이 프로젝트의 규칙과 불변 조건(Invariants). 위반 여부를 반드시 확인하라.
2. IMPLEMENTATION_HANDOFF — 구현자가 작성한 인계 문서(있을 때만). "Questions specifically for Codex" 에 답하라.
3. diff — 검토 대상 커밋 1개. 생성 파일(pnpm-lock.yaml, drizzle 스냅샷 JSON)은 제외되어 있다.

다음 형식의 마크다운 리포트만 출력하라. 서론·칭찬·요약 인사말은 쓰지 마라.

## 판정
PASS 또는 CHANGES_REQUESTED 중 하나.

## 지적 사항
각 항목을 아래 형식으로. 없으면 '없음'이라고만 쓴다.
- [P0|P1|P2] 파일:줄 — 문제 한 줄 요약
  - 재현/실패 시나리오: 어떤 입력·상태에서 어떻게 잘못되는가
  - 제안: 구체적인 수정 방향
(P0 = 불변 조건 위반·데이터 손상·보안, P1 = 기능 오류·명세 불일치, P2 = 경계값·품질)

## Codex 질문에 대한 답
인계 문서의 질문 각 항목에 번호를 붙여 답하라. 인계 문서가 없으면 '해당 없음'.

## 놓친 케이스
테스트나 수동 확인에서 빠졌을 가능성이 높은 입력·경계값 목록.

규칙:
- 추측을 사실처럼 쓰지 마라. diff 에서 확인되지 않는 것은 '미확인'으로 표시하라.
- 취향 문제(포매팅, 네이밍 선호)는 적지 마라. 동작·정확성·규칙 위반만 적어라.
- 샌드박스가 셸 명령·파일 읽기를 막는다. 차단되면 재시도하지 말고 <stdin> 만으로 검토하라.
- 파일을 수정하지 마라. 테스트를 실행했다고 주장하지 마라.
P

echo "▶ Codex 리뷰: $LABEL ($SHA, $(printf '%s' "$DIFF" | wc -c | tr -d ' ')B, model=$CODEX_MODEL, effort=$CODEX_REASONING_EFFORT)" >&2
{
  printf '===== AGENTS.md (프로젝트 규칙) =====\n'; cat AGENTS.md
  if [ -n "$HANDOFF" ] && [ -f "$HANDOFF" ]; then printf '\n\n===== IMPLEMENTATION_HANDOFF (%s) =====\n' "$LABEL"; cat "$HANDOFF"; fi
  printf '\n\n===== diff (커밋 %s) =====\n%s\n' "$SHA" "$DIFF"
} | codex exec --sandbox read-only "${MODEL_ARGS[@]}" -o "$OUT" "$PROMPT" >"$LOG" 2>&1
grep -E '^(model|reasoning effort):' "$LOG" >&2 || true
echo "$OUT"
