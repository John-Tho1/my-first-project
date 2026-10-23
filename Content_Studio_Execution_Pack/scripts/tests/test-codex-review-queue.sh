#!/usr/bin/env bash
# scripts/codex-review-queue.sh 시험 — 가짜 codex(PATH 앞)로 호출 순서·건너뛰기·멈춤·형식 검사만 본다. 실제 Codex·네트워크 호출 없음.
#   bash scripts/tests/test-codex-review-queue.sh
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0
fail=0
ok() { echo "  ok   - $1"; pass=$((pass + 1)); }
ng() { echo "  FAIL - $1"; fail=$((fail + 1)); }
check() { if eval "$2"; then ok "$1"; else ng "$1"; fi; }

# 가짜 codex: -o 파일에 판정을 쓰고, 받은 stdin·인자를 기록한다. STUB_RC=종료 코드, STUB_NO_VERDICT=1 이면 판정 없이 씀.
mkdir -p "$TMP/bin"
cat >"$TMP/bin/codex" <<'STUB'
#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac
done
n=$(( $(cat "$STUB_LOG_DIR/calls" 2>/dev/null || echo 0) + 1 ))
echo "$n" >"$STUB_LOG_DIR/calls"
cat >"$STUB_LOG_DIR/stdin-$n"
echo "model: stub"
echo "reasoning effort: stub"
if [ "${STUB_NO_VERDICT:-0}" = "1" ]; then echo "오류: 사용 한도" >"$out"; else printf '## 판정\nPASS\n\n## 지적 사항\n없음\n' >"$out"; fi
exit "${STUB_RC:-0}"
STUB
chmod +x "$TMP/bin/codex"

# 시험용 저장소: 실제 두 스크립트 + AGENTS.md + 인계 문서 3개 + 커밋 2개
P="$TMP/pack"
mkdir -p "$P/scripts" "$P/docs/handoffs"
cp "$SRC/scripts/codex-review-commit.sh" "$SRC/scripts/codex-review-queue.sh" "$P/scripts/"
printf '# AGENTS\n' >"$P/AGENTS.md"
printf 'HANDOFF-A\n' >"$P/docs/handoffs/A.md"
printf 'HANDOFF-B\n' >"$P/docs/handoffs/B.md"
printf 'HANDOFF-C\n' >"$P/docs/handoffs/C.md"
(
  cd "$P" && git init -q && git config user.email t@example.local && git config user.name t
  printf 'one\n' >f.txt && git add -A && git commit -qm one
  printf 'two\n' >>f.txt && git commit -qam two
)
S1="$(git -C "$P" rev-parse --short HEAD~1)"
S2="$(git -C "$P" rev-parse --short HEAD)"
printf '# 주석\n\n%s T-ONE docs/handoffs/A.md\n%s T-TWO docs/handoffs/B.md,docs/handoffs/C.md\r\n' "$S1" "$S2" >"$P/q.txt"

run() { (cd "$P" && PATH="$TMP/bin:$PATH" STUB_LOG_DIR="$TMP" "$@"); }
calls() { cat "$TMP/calls" 2>/dev/null || echo 0; }

echo "codex-review-queue 시험"
out="$(run bash scripts/codex-review-queue.sh --dry-run q.txt 2>&1)"; rc=$?
check "dry-run: exit 0 · 두 건 '실행 예정' · codex 호출 0" "[ $rc -eq 0 ] && [ \"\$(grep -c '^실행 예정: bash ' <<<\"\$out\")\" -eq 2 ] && [ \"\$(calls)\" = 0 ]"

out="$(run bash scripts/codex-review-queue.sh q.txt 2>&1)"; rc=$?
check "실행: exit 0 · codex 2회 · 두 결과에 '## 판정'" "[ $rc -eq 0 ] && [ \"\$(calls)\" = 2 ] && grep -q '^## 판정' '$P/.handoffs/review-T-ONE.md' && grep -q '^## 판정' '$P/.handoffs/review-T-TWO.md'"
check "실행: 순서(1번째 stdin = 커밋 one·인계 A, 2번째 = 커밋 two)" "grep -q HANDOFF-A '$TMP/stdin-1' && grep -q \"커밋 $S2\" '$TMP/stdin-2'"
check "여러 인계 문서는 합쳐서(B·C 모두, 머리줄 포함) 넘김" "grep -q HANDOFF-B '$TMP/stdin-2' && grep -q HANDOFF-C '$TMP/stdin-2' && grep -q '===== docs/handoffs/C.md =====' '$TMP/stdin-2'"
check "요약: 두 작업 PASS" "grep -Eq 'T-ONE +PASS' <<<\"\$out\" && grep -Eq 'T-TWO +PASS' <<<\"\$out\""

out="$(run bash scripts/codex-review-queue.sh q.txt 2>&1)"; rc=$?
check "다시 실행: 끝난 작업은 건너뜀(codex 호출 늘지 않음)" "[ $rc -eq 0 ] && [ \"\$(calls)\" = 2 ] && [ \"\$(grep -c '^건너뜀' <<<\"\$out\")\" -eq 2 ]"

rm -f "$P/.handoffs/review-"*.md "$TMP/calls"
out="$(STUB_RC=1 run bash scripts/codex-review-queue.sh q.txt 2>&1)"; rc=$?
check "codex 실패(exit 1): 첫 건에서 멈춤(exit 1, 호출 1회, 이어 실행 안내)" "[ $rc -eq 1 ] && [ \"\$(calls)\" = 1 ] && grep -q '이어서' <<<\"\$out\""

rm -f "$P/.handoffs/review-"*.md "$TMP/calls"
out="$(STUB_NO_VERDICT=1 run bash scripts/codex-review-queue.sh q.txt 2>&1)"; rc=$?
check "결과에 판정 없음(exit 0): 멈춤(exit 1, 호출 1회)" "[ $rc -eq 1 ] && [ \"\$(calls)\" = 1 ]"
out="$(run bash scripts/codex-review-queue.sh q.txt 2>&1)"; rc=$?
check "판정 없는 결과는 끝난 것으로 보지 않고 다시 검토" "[ $rc -eq 0 ] && [ \"\$(calls)\" = 3 ]"

for bad in "zzzzzzz T-X docs/handoffs/A.md" "$S1 T-X docs/handoffs/none.md" "$S1 T-X docs/handoffs/A.md extra" "$S1 bad/label docs/handoffs/A.md" "$S1 T-X"; do
  printf '%s\n' "$bad" >"$P/bad.txt"
  rm -f "$TMP/calls"
  run bash scripts/codex-review-queue.sh bad.txt >/dev/null 2>&1; rc=$?
  check "형식 오류 거부(exit 2, 호출 0): $bad" "[ $rc -eq 2 ] && [ \"\$(calls)\" = 0 ]"
done
run bash scripts/codex-review-queue.sh none.txt >/dev/null 2>&1; rc=$?
check "대기열 파일 없음: exit 2" "[ $rc -eq 2 ]"

echo "test-codex-review-queue.sh: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
