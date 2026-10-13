#!/usr/bin/env bash
# FIX2-T21P2(Codex review-FIX-T21P2 P1 check-env.sh:22 · :43):
#  - 환경 파일 문법을 `^[A-Z][A-Z0-9_]*=<값>$`(앞 공백·export·연속 행·따옴표·중복 키 없음)와 주석(# 로 시작)·빈 줄로만 제한 — 검사기와 systemd 가 다르게 읽을 수 없게
#  - 데이터 경로는 정규 경로(.. 와 기존 심볼릭 링크 해석)가 데이터 루트(정규 경로) 아래인지로 판정
source "$(dirname "$0")/lib.sh"

DATA_ROOT="$T_ROOT/data"
mkdir -p "$DATA_ROOT/pglite" "$DATA_ROOT/assets"
mkdir -p "$T_ROOT/other"

# 유효한 기본 환경 파일(경로는 시험용 데이터 루트)
base_env() {
  cat <<EOF
# Content Studio 운영 환경(시험)
APP_BASE_URL=https://studio.test-domain.invalid
AUTH_MODE=oidc
AUTH_ALLOWED_IDENTITY=owner@test-domain.invalid

DB_DRIVER=pglite
DATABASE_URL=$DATA_ROOT/pglite
STORAGE_DRIVER=local
STORAGE_LOCAL_DIR=$DATA_ROOT/assets
EXPORT_LOCAL_DIR=$DATA_ROOT/exports
RESTORE_LOCAL_DIR=$DATA_ROOT/restores
IMPORT_LOCAL_DIR=$DATA_ROOT/imports
WORKER_MODE=inline
WORKER_INLINE_INTERVAL_SECONDS=30
PUBLISH_MODE=disabled
COLLECTOR_MODE=disabled
COLLECTOR_SCHEDULER=off
IMPORT_CONNECTOR_MODE=disabled
OAUTH_MODE=mock
LLM_MODE=mock
STT_MODE=mock
LLM_LIVE_APPROVAL_REF=
OAUTH_LIVE_APPROVAL_REF=
RETENTION_SWEEP_MODE=manual
SECRETS_MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
EOF
}

ENV_FILE="$T_ROOT/env"
check() { # 소유자·권한 기대값은 시험 파일의 실제 값(이 PC 는 root·600 을 만들 수 없음) — 그 검사 자체는 아래 별도 시험
  local om
  om="$(stat -c '%U:%G %a' "$ENV_FILE")"
  env CS_ENV_FILE="$ENV_FILE" CS_DATA_ROOT="$DATA_ROOT" CS_ENV_OWNER_MODE="$om" bash "$SCRIPTS_DIR/check-env.sh"
}
write_env() { base_env >"$ENV_FILE"; [[ $# -gt 0 ]] && printf '%s\n' "$@" >>"$ENV_FILE"; return 0; }

echo "check-env.sh 기준 파일"
t "유효한 파일 → OK"
write_env
run_capture r check
expect_rc 0 "$r_rc" "$r_out"
expect_contains "$r_out" "[check-env] OK"

echo "check-env.sh 문법(systemd 와 다르게 읽힐 수 있는 줄 거부)"
t "앞 공백으로 시작하는 재할당( LLM_MODE=live) → 거부"
write_env " LLM_MODE=live"
run_capture r check
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "지원하지 않는 줄"
t "탭으로 시작하는 줄 → 거부"
write_env $'\tPUBLISH_MODE=enabled'
run_capture r check
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "지원하지 않는 줄"
t "중복 키(LLM_MODE 두 번) → 거부"
write_env "LLM_MODE=live"
run_capture r check
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "중복 키: LLM_MODE"
t "export 접두사 → 거부"
write_env "export EXTRA_FLAG=1"
run_capture r check
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "지원하지 않는 줄"
t "줄 끝 역슬래시(연속 행) → 거부"
write_env 'EXTRA_NOTE=abc\' 'LLM_MODE=live'
run_capture r check
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "지원하지 않는 줄"
t "따옴표 값 → 거부"
write_env 'EXTRA_NOTE="quoted value"'
run_capture r check
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "지원하지 않는 줄"
t "작은따옴표 값 → 거부"
write_env "EXTRA_NOTE='x'"
run_capture r check
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "지원하지 않는 줄"
t "소문자 키 → 거부"
write_env "llm_mode=live"
run_capture r check
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "지원하지 않는 줄"
t "= 주변 공백(LLM_MODE = live) → 거부"
write_env "EXTRA = x"
run_capture r check
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "지원하지 않는 줄"
t "값 끝 공백 → 거부"
write_env "EXTRA_NOTE=x "
run_capture r check
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "지원하지 않는 줄"
t "\$ 확장 → 거부"
write_env 'EXTRA_NOTE=${HOME}'
run_capture r check
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "지원하지 않는 줄"
t "CRLF 줄 끝 → 거부"
base_env | sed 's/$/\r/' >"$ENV_FILE"
run_capture r check
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "지원하지 않는 줄"
t "앞 공백이 있는 주석 → 거부(주석은 # 로 시작하는 줄만)"
write_env "  # comment"
run_capture r check
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "지원하지 않는 줄"
echo "check-env.sh 실제 게시 설정(LIVE-P1 D38 — 운영 배포 대기 단계에서는 비어 있어야 함)"
t "PUBLISH_LIVE_APPROVAL_REF 빈 값 → 허용"
write_env "PUBLISH_LIVE_APPROVAL_REF=" "PUBLISH_LIVE_MAX_POSTS="
run_capture r check
expect_rc 0 "$r_rc" "$r_out"
t "PUBLISH_LIVE_APPROVAL_REF 값 있음 → 거부(값 출력 없음)"
write_env "PUBLISH_LIVE_APPROVAL_REF=D38-secret-ref-xyz"
run_capture r check
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "PUBLISH_LIVE_APPROVAL_REF 은(는) 이 단계에서 비어 있어야 합니다"
expect_not_contains "$r_out" "D38-secret-ref-xyz"
t "PUBLISH_LIVE_MAX_POSTS 값 있음 → 거부"
write_env "PUBLISH_LIVE_MAX_POSTS=1"
run_capture r check
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "PUBLISH_LIVE_MAX_POSTS 은(는) 이 단계에서 비어 있어야 합니다"
t "PUBLISH_MODE=enabled → 거부(실제 게시 설정과 함께여도)"
base_env | sed "s#^PUBLISH_MODE=.*#PUBLISH_MODE=enabled#" >"$ENV_FILE"
run_capture r check
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "PUBLISH_MODE 은(는) disabled 여야 합니다"

t "거부 메시지에 값이 나오지 않는다"
write_env "EXTRA_SECRET=\"s3cr3t-value\""
run_capture r check
expect_not_contains "$r_out" "s3cr3t-value"

echo "check-env.sh 데이터 경로(정규 경로)"
t ".. 로 데이터 루트 밖 → 거부"
base_env | sed "s#^DATABASE_URL=.*#DATABASE_URL=$DATA_ROOT/../other/pglite#" >"$ENV_FILE"
run_capture r check
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "DATABASE_URL"
expect_not_contains "$r_out" "STORAGE_LOCAL_DIR"
t "데이터 루트 자체(하위가 아님) → 거부"
base_env | sed "s#^EXPORT_LOCAL_DIR=.*#EXPORT_LOCAL_DIR=$DATA_ROOT/exports/..#" >"$ENV_FILE"
run_capture r check
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "EXPORT_LOCAL_DIR"
t "상대 경로 → 거부"
base_env | sed "s#^IMPORT_LOCAL_DIR=.*#IMPORT_LOCAL_DIR=data/imports#" >"$ENV_FILE"
run_capture r check
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "IMPORT_LOCAL_DIR"
t "이름이 데이터 루트로 시작하는 형제 폴더(data-evil) → 거부"
mkdir -p "$T_ROOT/data-evil"
base_env | sed "s#^RESTORE_LOCAL_DIR=.*#RESTORE_LOCAL_DIR=$T_ROOT/data-evil/restores#" >"$ENV_FILE"
run_capture r check
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "RESTORE_LOCAL_DIR"
t "아직 없는 하위 경로(데이터 루트 안) → 허용"
base_env | sed "s#^EXPORT_LOCAL_DIR=.*#EXPORT_LOCAL_DIR=$DATA_ROOT/not-yet/deeper/exports#" >"$ENV_FILE"
run_capture r check
expect_rc 0 "$r_rc" "$r_out"
t "데이터 루트가 없음 → 거부"
write_env
run_capture r env CS_ENV_FILE="$ENV_FILE" CS_DATA_ROOT="$T_ROOT/missing-root" CS_ENV_OWNER_MODE="$(stat -c '%U:%G %a' "$ENV_FILE")" bash "$SCRIPTS_DIR/check-env.sh"
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "데이터 루트"

# 심볼릭 링크: 이 환경에서 진짜 링크를 만들 수 있을 때만(Windows Git Bash 는 기본으로 복사본을 만든다 — 그때는 SKIP 으로 기록)
mkdir -p "$T_ROOT/outside"
if MSYS=winsymlinks:nativestrict ln -s "$T_ROOT/outside" "$DATA_ROOT/link-out" 2>/dev/null && [[ -L "$DATA_ROOT/link-out" ]]; then
  t "데이터 루트 안의 링크가 밖을 가리킴(기존 링크) → 거부"
  base_env | sed "s#^STORAGE_LOCAL_DIR=.*#STORAGE_LOCAL_DIR=$DATA_ROOT/link-out/assets#" >"$ENV_FILE"
  run_capture r check
  expect_nonzero "$r_rc" "$r_out"
  expect_contains "$r_out" "STORAGE_LOCAL_DIR"
  t "데이터 루트 안을 가리키는 링크 → 허용"
  MSYS=winsymlinks:nativestrict ln -s "$DATA_ROOT/assets" "$DATA_ROOT/link-in"
  base_env | sed "s#^STORAGE_LOCAL_DIR=.*#STORAGE_LOCAL_DIR=$DATA_ROOT/link-in#" >"$ENV_FILE"
  run_capture r check
  expect_rc 0 "$r_rc" "$r_out"
else
  rm -rf "$DATA_ROOT/link-out"
  echo "  SKIP - 심볼릭 링크 시험(이 환경에서 진짜 링크를 만들 수 없음)"
fi

echo "check-env.sh 소유자·권한"
t "소유자·권한 기대값과 다르면 거부(값 형식만 출력)"
write_env
run_capture r env CS_ENV_FILE="$ENV_FILE" CS_DATA_ROOT="$DATA_ROOT" CS_ENV_OWNER_MODE="root:root 600" bash "$SCRIPTS_DIR/check-env.sh"
if [[ "$(stat -c '%U:%G %a' "$ENV_FILE")" == "root:root 600" ]]; then
  ok "이 환경은 root:root 600 이라 비교 불가 — 건너뜀"
else
  expect_nonzero "$r_rc" "$r_out"
  expect_contains "$r_out" "root:root 600"
fi

finish
