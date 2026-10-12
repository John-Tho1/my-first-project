#!/usr/bin/env bash
# deploy/scripts 시험 실행기(FIX2-T21P2) — pnpm·node 없이 일반 bash 로:
#   bash deploy/scripts/tests/run-all.sh
# 먼저 모든 스크립트의 문법(bash -n)을 확인하고, test-*.sh 를 차례로 실행한다. 하나라도 실패하면 종료 코드 1.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS="$(cd "$DIR/.." && pwd)"
rc=0
echo "== bash -n"
for f in "$SCRIPTS"/*.sh "$SCRIPTS"/lib/*.sh "$DIR"/*.sh; do
  [[ -e "$f" ]] || continue
  if bash -n "$f"; then echo "  ok   - $(basename "$f")"; else echo "  FAIL - $(basename "$f")"; rc=1; fi
done
for t in "$DIR"/test-*.sh; do
  echo "== $(basename "$t")"
  bash "$t" || rc=1
done
if [[ "$rc" -eq 0 ]]; then echo "DEPLOY-SCRIPT-TESTS: PASS"; else echo "DEPLOY-SCRIPT-TESTS: FAIL"; fi
exit "$rc"
