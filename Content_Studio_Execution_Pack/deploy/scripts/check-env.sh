#!/usr/bin/env bash
# Content Studio — 운영 환경 파일 점검(T21-P2 · FIX1, 실제 서버에서 실행한 적 없음 — bash -n 만 확인).
# 사용(root): sudo bash <앱 루트>/deploy/scripts/check-env.sh
# 값은 출력하지 않는다(키 이름·판정만). 하나라도 어긋나면 0 이 아닌 종료 코드.
set -euo pipefail

ENV_FILE="${CS_ENV_FILE:-/etc/content-studio/env}"
fail=0
bad() {
  echo "[check-env] 문제: $*" >&2
  fail=1
}

[[ -f "$ENV_FILE" ]] || { echo "[check-env] 실패: 환경 파일이 없습니다: $ENV_FILE" >&2; exit 1; }
[[ ! -L "$ENV_FILE" ]] || bad "환경 파일이 심볼릭 링크입니다"
owner_mode="$(stat -c '%U:%G %a' "$ENV_FILE")" || { echo "[check-env] 실패: stat 실패" >&2; exit 1; }
[[ "$owner_mode" == "root:root 600" ]] || bad "소유자·권한이 root:root 600 이 아닙니다(현재 $owner_mode)"

# KEY=VALUE 에서 값 하나를 읽는다(출력하지 않고 비교에만 쓴다). 같은 키가 여러 번이면 마지막 값(systemd 와 같음).
value_of() {
  local v
  v="$(grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  printf '%s' "$v"
}
expect_eq() {
  [[ "$(value_of "$1")" == "$2" ]] || bad "$1 은(는) $2 여야 합니다"
}

app_base="$(value_of APP_BASE_URL)"
[[ "$app_base" == https://* ]] || bad "APP_BASE_URL 은 https:// 로 시작해야 합니다"
[[ "$app_base" != *example.com* ]] || bad "APP_BASE_URL 이 예시 도메인 그대로입니다"
expect_eq AUTH_MODE oidc
expect_eq DB_DRIVER pglite
expect_eq WORKER_MODE inline
expect_eq PUBLISH_MODE disabled
expect_eq COLLECTOR_MODE disabled
expect_eq COLLECTOR_SCHEDULER off
expect_eq IMPORT_CONNECTOR_MODE disabled
expect_eq OAUTH_MODE mock
expect_eq LLM_MODE mock
expect_eq STT_MODE mock
for k in DATABASE_URL STORAGE_LOCAL_DIR EXPORT_LOCAL_DIR RESTORE_LOCAL_DIR IMPORT_LOCAL_DIR; do
  [[ "$(value_of "$k")" == /srv/content-studio/data/* ]] || bad "$k 은(는) /srv/content-studio/data/ 아래 절대 경로여야 합니다"
done
interval="$(value_of WORKER_INLINE_INTERVAL_SECONDS)"
if [[ ! "$interval" =~ ^[0-9]{1,4}$ ]]; then
  bad "WORKER_INLINE_INTERVAL_SECONDS 는 0 또는 5~600 정수여야 합니다"
else
  n=$((10#$interval)) # 앞자리 0 을 8진수로 읽지 않게
  if [[ "$n" -ne 0 && ( "$n" -lt 5 || "$n" -gt 600 ) ]]; then
    bad "WORKER_INLINE_INTERVAL_SECONDS 는 0 또는 5~600 이어야 합니다"
  elif [[ "$n" -eq 0 ]]; then
    echo "[check-env] 경고: WORKER_INLINE_INTERVAL_SECONDS=0 — 주기 처리가 꺼져 있습니다" >&2
  fi
fi
for k in ANTHROPIC_API_KEY THREADS_APP_ID THREADS_APP_SECRET LLM_LIVE_APPROVAL_REF OAUTH_LIVE_APPROVAL_REF; do
  [[ -z "$(value_of "$k")" ]] || bad "$k 은(는) 이 단계에서 비어 있어야 합니다(별도 승인)"
done

if [[ "$fail" -ne 0 ]]; then
  echo "[check-env] 실패" >&2
  exit 1
fi
echo "[check-env] OK"
