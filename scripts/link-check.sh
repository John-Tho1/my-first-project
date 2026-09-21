#!/usr/bin/env bash
# Claude Code ↔ Codex 연결 점검
#
#   ./scripts/link-check.sh          설정만 점검 (모델 호출 없음, 쿼터 소비 없음)
#   ./scripts/link-check.sh --call   실제 시험 호출 1회 포함 (쿼터를 소비합니다)
#
# 아무것도 변경하지 않는다. 설치·로그인·수정·커밋을 하지 않는다.
# 인증 파일(~/.codex/auth*, ~/.claude/*)을 열지 않는다.

set -uo pipefail

RUN_CALL=0
[ "${1-}" = "--call" ] && RUN_CALL=1

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

echo "=============================================="
echo " Claude Code <-> Codex 연결 점검"
echo " 일시: $(date '+%Y-%m-%d %H:%M:%S')"
echo "=============================================="
echo

echo "[1] 실행 환경"
echo "    OS      : $(uname -s 2>/dev/null || echo unknown) / OSTYPE=${OSTYPE-unknown}"
echo "    셸      : ${SHELL-unknown}"
echo "    작업경로: $(pwd)"
echo "    브랜치  : $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '(git 아님)')"
echo

echo "[2] 설치"
if command -v claude >/dev/null 2>&1; then
  echo "    claude  : $(command -v claude)"
  echo "              $(claude --version 2>&1 | head -1)"
else
  echo "    claude  : 찾을 수 없음"
fi
if command -v codex >/dev/null 2>&1; then
  echo "    codex   : $(command -v codex)"
  echo "              $(codex --version 2>&1 | head -1)"
else
  echo "    codex   : 찾을 수 없음  → 이 셸에서는 연동 불가"
fi
echo

echo "[3] 환경변수 (설정 여부만, 값은 출력하지 않음)"
for v in ANTHROPIC_API_KEY OPENAI_API_KEY CODEX_HOME; do
  if [ -n "${!v-}" ]; then echo "    $v = [SET]"; else echo "    $v = [unset]"; fi
done
echo

echo "[4] 연결 경로"
echo "    방식    : CLI 호출 (MCP 아님)"
grep -n "CMD=(codex" scripts/codex-review.sh scripts/codex-task.sh 2>/dev/null | sed 's/^/    /'
if [ -f .mcp.json ]; then echo "    .mcp.json: 있음"; else echo "    .mcp.json: 없음 (정상 — Claude→Codex는 MCP 미사용)"; fi
echo

echo "[5] 역방향 MCP (Codex → Claude Code) 재귀 호출 위험"
if [ -f .codex/config.toml ]; then
  # grep -c 는 매칭이 없으면 "0"을 출력하고 종료 코드 1을 낸다.
  # `|| echo 0` 을 붙이면 0이 두 줄이 되어 정수 비교가 깨진다. 빈 값만 0으로 보정한다.
  N=$(grep -cE '^[[:space:]]*\[mcp_servers' .codex/config.toml 2>/dev/null)
  [ -z "$N" ] && N=0
  if [ "$N" -gt 0 ]; then
    echo "    ⚠ 활성 ($N건) — 양쪽 쿼터 동시 소모 및 재귀 호출 가능"
    echo "      수정: cp .codex/config.toml.example .codex/config.toml"
  else
    echo "    비활성 — 정상"
  fi
  echo "    적용 중인 설정(주석 제외):"
  grep -vE '^\s*#' .codex/config.toml | grep -vE '^\s*$' | sed 's/^/      /'
else
  echo "    .codex/config.toml 없음"
fi
echo

echo "[6] 실제 모델 응답"
if [ "$RUN_CALL" -eq 0 ]; then
  echo "    미실행 — 설정 점검 모드입니다."
  echo "    실제 호출을 승인하시면 아래를 실행하세요 (ChatGPT 쿼터를 소비합니다):"
  echo "        ./scripts/link-check.sh --call"
elif ! command -v codex >/dev/null 2>&1; then
  echo "    실행 불가 — codex 명령을 찾을 수 없습니다."
else
  TOKEN="LINK_OK_$(date +%H%M%S)"
  echo "    호출 경로: codex exec --sandbox read-only   (codex-review.sh와 동일 형태)"
  echo "    기대 응답: $TOKEN"
  echo "    --- 실제 출력 ---"
  OUT=$(codex exec --sandbox read-only \
    "Reply with exactly $TOKEN. Do not read or write files, execute commands, use tools, or invoke other agents." \
    </dev/null 2>&1)
  RC=$?
  echo "$OUT" | sed 's/^/      /'
  echo "    --- 종료 코드: $RC ---"
  if echo "$OUT" | grep -q "$TOKEN"; then
    echo "    판정: PASS — 기대 문구가 반환되었습니다."
  else
    echo "    판정: FAIL 또는 미확인 — 기대 문구가 확인되지 않았습니다."
  fi
fi
echo
echo "=============================================="
echo " 점검 종료 (변경 사항 없음)"
echo "=============================================="
