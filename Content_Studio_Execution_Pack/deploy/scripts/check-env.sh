#!/usr/bin/env bash
# Content Studio — 운영 환경 파일 점검(T21-P2 · FIX1 · FIX2, 실제 서버에서 실행한 적 없음 — bash -n·로컬 시험만).
# 사용(root): sudo bash <앱 루트>/deploy/scripts/check-env.sh
# 값은 출력하지 않는다(키 이름·판정만). 하나라도 어긋나면 0 이 아닌 종료 코드.
#
# FIX2-T21P2(Codex review-FIX-T21P2 P1 :22): 이 파일은 systemd EnvironmentFile 로 읽힌다. 검사기와 systemd 가 같은 파일을 다르게 읽을 수
# 없도록 허용 문법을 **좁게** 정하고 나머지는 모두 거부한다.
#   허용: 빈 줄 / `#` 로 시작하는 주석 줄 / `KEY=값` — KEY 는 `[A-Z][A-Z0-9_]*`, 줄 맨 앞부터(앞 공백 없음), `=` 주변 공백 없음,
#         값에는 따옴표(" ')·역슬래시(\)·`$`·제어 문자(CR 포함)가 없고 앞뒤 공백이 없다. 같은 KEY 는 한 번만.
#   거부 예: ` LLM_MODE=live`(앞 공백), `export X=1`, 줄 끝 `\`(연속 행), `X="v"`, `X=${HOME}`, CRLF, 중복 키, 소문자 키.
# FIX2-T21P2(P1 :43): 데이터 경로는 문자열 접두사가 아니라 **정규 경로**로 본다 — `..`·기존 심볼릭 링크를 해석한 경로가
#   데이터 루트(정규 경로) **아래**여야 하고, 아직 없는 경로는 가장 가까운 기존 부모의 정규 경로도 데이터 루트 아래여야 한다.
set -euo pipefail

CS_SCRIPT_TAG=check-env
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

# FIX3-T21P2: CS_* 바꿔치기는 시험 표식 + 실제 root 아님일 때만(lib/common.sh cs_opt). 운영에서는 아래 기본값만 쓴다.
ENV_FILE="$(cs_path CS_ENV_FILE /etc/content-studio/env)" || exit 1
DATA_ROOT="$(cs_path CS_DATA_ROOT /srv/content-studio/data)" || exit 1
OWNER_MODE_EXPECTED="$(cs_opt CS_ENV_OWNER_MODE 'root:root 600')"
fail=0
bad() {
  echo "[check-env] 문제: $*" >&2
  fail=1
}

[[ -f "$ENV_FILE" ]] || die "환경 파일이 없습니다: $ENV_FILE"
[[ ! -L "$ENV_FILE" ]] || bad "환경 파일이 심볼릭 링크입니다"
owner_mode="$(stat -c '%U:%G %a' "$ENV_FILE")" || die "stat 실패"
[[ "$owner_mode" == "$OWNER_MODE_EXPECTED" ]] || bad "소유자·권한이 $OWNER_MODE_EXPECTED 가 아닙니다(현재 $owner_mode)"

# ---- 문법(한 줄씩) ----
declare -A VALUES=()
line_no=0
KEY_RE='^[A-Z][A-Z0-9_]*$'
while IFS= read -r line || [[ -n "$line" ]]; do
  line_no=$((line_no + 1))
  [[ -z "$line" ]] && continue
  [[ "$line" == "#"* ]] && continue
  key="${line%%=*}"
  if [[ "$line" != *=* || ! "$key" =~ $KEY_RE ]]; then
    bad "지원하지 않는 줄(${line_no}행) — KEY=값 형식(대문자 KEY, 앞 공백·export 없음)만 허용"
    continue
  fi
  value="${line#*=}"
  if [[ "$value" == *[\"\'\\\$]* || "$value" =~ [[:cntrl:]] || "$value" =~ ^[[:space:]] || "$value" =~ [[:space:]]$ ]]; then
    bad "지원하지 않는 줄(${line_no}행, ${key}) — 값에 따옴표·역슬래시·\$·제어 문자·앞뒤 공백 금지"
    continue
  fi
  if [[ -n "${VALUES[$key]+set}" ]]; then
    bad "중복 키: ${key}(${line_no}행)"
    continue
  fi
  VALUES[$key]="$value"
done <"$ENV_FILE"

value_of() { printf '%s' "${VALUES[$1]-}"; }
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

# ---- 데이터 경로(정규 경로) ----
root_real=""
# FIX3-T21P2(Codex 질문 3): 데이터 루트 자체가 심볼릭 링크면 거부 — backup-data 의 tar 가 링크만 담게 되므로 백업·복원과 판정이 어긋난다
if [[ -L "${DATA_ROOT%/}" ]]; then
  bad "데이터 루트가 심볼릭 링크입니다: $DATA_ROOT — 실제 폴더(또는 마운트 지점)만 지원합니다"
elif ! root_real="$(realpath -e -- "$DATA_ROOT" 2>/dev/null)" || [[ ! -d "$root_real" ]]; then
  bad "데이터 루트가 없거나 폴더가 아닙니다: $DATA_ROOT"
  root_real=""
fi
under_root() { # under_root <정규 경로> — 데이터 루트 자체는 아니고 그 아래인가
  [[ -n "$root_real" && "$1" == "$root_real"/* ]]
}
for k in DATABASE_URL STORAGE_LOCAL_DIR EXPORT_LOCAL_DIR RESTORE_LOCAL_DIR IMPORT_LOCAL_DIR; do
  v="$(value_of "$k")"
  if [[ "$v" != /* ]]; then
    bad "$k 은(는) 절대 경로여야 합니다"
    continue
  fi
  canon="$(realpath -m -- "$v")" || {
    bad "$k 경로를 해석하지 못했습니다"
    continue
  }
  if ! under_root "$canon"; then
    bad "$k 의 실제 위치가 데이터 루트($DATA_ROOT) 아래가 아닙니다"
    continue
  fi
  # 가장 가까운 기존 부모(링크 해석)도 데이터 루트 안이어야 한다
  p="$canon"
  while [[ ! -e "$p" && "$p" != "/" ]]; do p="$(dirname -- "$p")"; done
  p_real="$(realpath -e -- "$p")" || {
    bad "$k 의 기존 부모 경로를 해석하지 못했습니다"
    continue
  }
  [[ "$p_real" == "$root_real" || "$p_real" == "$root_real"/* ]] || bad "$k 의 기존 부모 경로가 데이터 루트 밖입니다"
done

interval="$(value_of WORKER_INLINE_INTERVAL_SECONDS)"
if [[ ! "$interval" =~ ^[0-9]{1,4}$ ]]; then
  bad "WORKER_INLINE_INTERVAL_SECONDS 는 0 또는 5~600 정수여야 합니다"
else
  n=$((10#$interval)) # 앞자리 0 을 8진수로 읽지 않게
  if [[ "$n" -ne 0 && ("$n" -lt 5 || "$n" -gt 600) ]]; then
    bad "WORKER_INLINE_INTERVAL_SECONDS 는 0 또는 5~600 이어야 합니다"
  elif [[ "$n" -eq 0 ]]; then
    echo "[check-env] 경고: WORKER_INLINE_INTERVAL_SECONDS=0 — 주기 처리가 꺼져 있습니다" >&2
  fi
fi
# LIVE-P1(D38): 실제 게시 승인 기록·게시 수 상한도 이 단계(운영 배포 대기 — D37)에서는 비어 있어야 한다
# LIVE-P2(D39): 최근 24시간 실제 게시 상한(PUBLISH_LIVE_DAILY_MAX)도 같다(D39 실제 게시는 로컬 서버만 — 운영 배포는 별도 승인)
for k in ANTHROPIC_API_KEY THREADS_APP_ID THREADS_APP_SECRET LLM_LIVE_APPROVAL_REF OAUTH_LIVE_APPROVAL_REF PUBLISH_LIVE_APPROVAL_REF PUBLISH_LIVE_MAX_POSTS PUBLISH_LIVE_DAILY_MAX; do
  [[ -z "$(value_of "$k")" ]] || bad "$k 은(는) 이 단계에서 비어 있어야 합니다(별도 승인)"
done

if [[ "$fail" -ne 0 ]]; then
  echo "[check-env] 실패" >&2
  exit 1
fi
echo "[check-env] OK"
