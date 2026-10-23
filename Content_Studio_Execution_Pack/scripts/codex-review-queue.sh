#!/usr/bin/env bash
# Content Studio Codex 검증 대기열 실행기 — 대기열 파일의 커밋을 순서대로 scripts/codex-review-commit.sh 로 검토한다.
#
#   bash scripts/codex-review-queue.sh [--dry-run] [대기열 파일]   (기본: docs/handoffs/CODEX_QUEUE.txt)
#
# 대기열 한 줄: <SHA> <작업명> <인계문서>[,<인계문서>...]   (# 로 시작하는 줄·빈 줄은 건너뜀, 경로는 앱 폴더 기준)
# - 이미 끝난 작업(.handoffs/review-<작업명>.md 에 "## 판정" 줄이 있음)은 건너뛴다 — 한도·오류로 멈춘 뒤 같은 명령으로 이어서 실행.
#   다시 검토하려면 그 파일을 지운다.
# - 인계 문서가 여럿이면 .handoffs/queue-handoff-<작업명>.md 로 합쳐 넘긴다.
# - 한 건이라도 실패하면(종료 코드 ≠ 0 또는 결과에 "## 판정" 없음) 그 자리에서 멈춘다(한도에 걸리면 뒤 작업이 모두 실패하므로).
# - 모델·추론 강도는 codex-review-commit.sh 기본값(gpt-6-astra / xhigh, 2026-09-24 사용자 결정)을 그대로 쓴다.
set -euo pipefail

PACK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PACK"

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then DRY_RUN=1; shift; fi
QUEUE="${1:-docs/handoffs/CODEX_QUEUE.txt}"
[ -f "$QUEUE" ] || { echo "대기열 파일이 없습니다: $QUEUE" >&2; exit 2; }
REVIEW="${CODEX_REVIEW_COMMIT:-./scripts/codex-review-commit.sh}"

mkdir -p .handoffs
done_labels=()
ran=0
skipped=0
lineno=0
while IFS= read -r line || [ -n "$line" ]; do
  lineno=$((lineno + 1))
  line="${line%$'\r'}"
  case "$line" in '' | '#'*) continue ;; esac
  read -r sha label docs extra <<<"$line" || true
  if [ -z "${sha:-}" ] || [ -z "${label:-}" ] || [ -z "${docs:-}" ] || [ -n "${extra:-}" ]; then
    echo "대기열 $QUEUE:$lineno 형식 오류 — '<SHA> <작업명> <인계문서>[,…]' 이어야 합니다" >&2; exit 2
  fi
  [[ "$sha" =~ ^[0-9a-f]{7,40}$ ]] || { echo "대기열 $QUEUE:$lineno SHA 형식 오류: $sha" >&2; exit 2; }
  [[ "$label" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "대기열 $QUEUE:$lineno 작업명 형식 오류: $label" >&2; exit 2; }
  git cat-file -e "$sha^{commit}" 2>/dev/null || { echo "대기열 $QUEUE:$lineno 커밋을 찾을 수 없습니다: $sha (git pull 필요?)" >&2; exit 2; }
  IFS=',' read -r -a docs_arr <<<"$docs"
  for d in "${docs_arr[@]}"; do
    [ -f "$d" ] || { echo "대기열 $QUEUE:$lineno 인계 문서가 없습니다: $d" >&2; exit 2; }
  done

  out=".handoffs/review-$label.md"
  if [ -s "$out" ] && grep -q '^## 판정' "$out"; then
    echo "건너뜀: $label (이미 결과 있음 — $out)"
    skipped=$((skipped + 1)); done_labels+=("$label"); continue
  fi

  if [ "${#docs_arr[@]}" -eq 1 ]; then
    handoff="${docs_arr[0]}"
  else
    handoff=".handoffs/queue-handoff-$label.md"
    : >"$handoff"
    for d in "${docs_arr[@]}"; do printf '===== %s =====\n' "$d" >>"$handoff"; cat "$d" >>"$handoff"; printf '\n\n' >>"$handoff"; done
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "실행 예정: bash $REVIEW $sha $label $handoff"
    continue
  fi
  echo "▶ $label ($sha) — 인계: $docs"
  set +e
  bash "$REVIEW" "$sha" "$label" "$handoff"  # 실행 권한 비트에 기대지 않음(저장소의 codex-review-commit.sh 는 100644)
  rc=$?
  set -e
  if [ "$rc" -ne 0 ] || ! { [ -s "$out" ] && grep -q '^## 판정' "$out"; }; then
    echo "중단: $label (종료 코드 $rc, 결과에 '## 판정' 없음일 수 있음) — 로그: .handoffs/review-$label.log" >&2
    echo "한도·일시 오류면 나중에 같은 명령으로 다시 실행하면 끝난 작업은 건너뛰고 여기서부터 이어서 합니다." >&2
    exit 1
  fi
  ran=$((ran + 1)); done_labels+=("$label")
done <"$QUEUE"

[ "$DRY_RUN" -eq 1 ] && exit 0
echo
echo "끝: 이번에 검토 $ran건, 건너뜀 $skipped건"
for label in ${done_labels[@]+"${done_labels[@]}"}; do
  verdict="$(awk '/^## 판정/{f=1; next} f && NF {print; exit}' ".handoffs/review-$label.md")"
  printf '  %-16s %s\n' "$label" "${verdict:-(판정 줄 없음)}"
done
