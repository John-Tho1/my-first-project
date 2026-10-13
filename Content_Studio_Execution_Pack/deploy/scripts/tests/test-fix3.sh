#!/usr/bin/env bash
# FIX3-T21P2(Codex review-FIX2-T21P2):
#  (4) common.sh:34 — unit 목록 검색이 파이프 조기 종료(pipefail + grep -q)로 "없음"이 되지 않는다. 조회 실패와 부재를 구분. ActiveState 만 실패해도 중단.
#  (5) 데이터 루트(또는 데이터 폴더) 자체가 심볼릭 링크면 check-env·backup-data·restore-data 가 거부.
#  (6) 시험용 바꿔치기 변수(CS_*)는 시험 표식(CS_DEPLOY_TEST_HARNESS=1) + 실제 root 아님일 때만 적용 — 표식 없이 주면 효과 없음.
source "$(dirname "$0")/lib.sh"

SHA=0123456789abcdef0123456789abcdef01234567
ME="$(id -un)"
NOREPO="$T_ROOT/no-repo"
PASSED_SERVICE_BUILD="저장소 루트가 아닙니다"
can_symlink() {
  local probe="$T_ROOT/.lnprobe"
  MSYS=winsymlinks:nativestrict ln -s "$T_ROOT" "$probe" 2>/dev/null && [[ -L "$probe" ]] && rm -f "$probe"
}
mklink() { MSYS=winsymlinks:nativestrict ln -s "$1" "$2"; }

echo "(4) unit 목록 검색·ActiveState 조회 실패"
t "first-install: 큰 목록의 맨 앞에 content-studio.service 가 있으면 '없음'으로 보지 않는다(중단)"
run_capture r stub_env CS_SERVICE_USER="$ME" CS_REPO_ROOT="$NOREPO" STUB_LOAD=not-found STUB_UNIT_FILES=content-studio.service STUB_UNIT_FILES_BIG=200000 \
  bash "$SCRIPTS_DIR/build-release.sh" --first-install "$SHA"
expect_nonzero "$r_rc" "$r_out"
expect_not_contains "$r_out" "$PASSED_SERVICE_BUILD"
expect_contains "$r_out" "unit 파일이 있습니다"
t "first-install: 큰 목록에 없으면 진행"
run_capture r stub_env CS_SERVICE_USER="$ME" CS_REPO_ROOT="$NOREPO" STUB_LOAD=not-found STUB_UNIT_FILES=ssh.service STUB_UNIT_FILES_BIG=200000 \
  bash "$SCRIPTS_DIR/build-release.sh" --first-install "$SHA"
expect_contains "$r_out" "$PASSED_SERVICE_BUILD"
t "LoadState 성공 + ActiveState 조회 실패 → 중단"
run_capture r stub_env CS_SERVICE_USER="$ME" CS_REPO_ROOT="$NOREPO" STUB_ACTIVE_FAIL=1 bash "$SCRIPTS_DIR/build-release.sh" "$SHA"
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "ActiveState"
expect_not_contains "$r_out" "$PASSED_SERVICE_BUILD"

echo "(5) 데이터 루트·데이터 폴더가 심볼릭 링크"
if can_symlink; then
  REAL="$T_ROOT/real-data"
  mkdir -p "$REAL/pglite"
  mklink "$REAL" "$T_ROOT/data-link"
  ENV_FILE="$T_ROOT/env5"
  {
    echo "APP_BASE_URL=https://studio.test-domain.invalid"
    for kv in AUTH_MODE=oidc DB_DRIVER=pglite WORKER_MODE=inline PUBLISH_MODE=disabled COLLECTOR_MODE=disabled COLLECTOR_SCHEDULER=off \
      IMPORT_CONNECTOR_MODE=disabled OAUTH_MODE=mock LLM_MODE=mock STT_MODE=mock WORKER_INLINE_INTERVAL_SECONDS=30; do echo "$kv"; done
    for k in DATABASE_URL:pglite STORAGE_LOCAL_DIR:assets EXPORT_LOCAL_DIR:exports RESTORE_LOCAL_DIR:restores IMPORT_LOCAL_DIR:imports; do
      echo "${k%%:*}=$T_ROOT/data-link/${k#*:}"
    done
  } >"$ENV_FILE"
  t "check-env: 데이터 루트가 링크 → 거부"
  run_capture r env CS_ENV_FILE="$ENV_FILE" CS_DATA_ROOT="$T_ROOT/data-link" CS_ENV_OWNER_MODE="$(stat -c '%U:%G %a' "$ENV_FILE")" bash "$SCRIPTS_DIR/check-env.sh"
  expect_nonzero "$r_rc" "$r_out"
  expect_contains "$r_out" "심볼릭 링크"
  t "check-env: 같은 내용을 실제 폴더로 주면 OK(대조)"
  sed "s#$T_ROOT/data-link#$REAL#" "$ENV_FILE" >"$ENV_FILE.real"
  run_capture r env CS_ENV_FILE="$ENV_FILE.real" CS_DATA_ROOT="$REAL" CS_ENV_OWNER_MODE="$(stat -c '%U:%G %a' "$ENV_FILE.real")" bash "$SCRIPTS_DIR/check-env.sh"
  expect_rc 0 "$r_rc" "$r_out"

  PARENT="$T_ROOT/lp"
  mkdir -p "$PARENT"
  mklink "$REAL" "$PARENT/data"
  t "backup-data: 데이터 폴더가 링크 → 거부(링크만 담긴 사본을 만들지 않음)"
  run_capture r stub_env CS_DATA_PARENT="$PARENT" CS_BACKUP_DIR="$T_ROOT/bk5" CS_TEST_SKIP_CHOWN=1 bash "$SCRIPTS_DIR/backup-data.sh" 0123456
  expect_nonzero "$r_rc" "$r_out"
  expect_contains "$r_out" "심볼릭 링크"
  if ls "$T_ROOT/bk5"/data-*.tar.gz >/dev/null 2>&1; then ng "사본이 만들어졌다"; else ok "사본 없음"; fi
  t "restore-data: 데이터 폴더가 링크 → 거부"
  mkdir -p "$T_ROOT/src5/data"
  echo n >"$T_ROOT/src5/data/n.txt"
  tar -C "$T_ROOT/src5" -czf "$T_ROOT/a5.tar.gz" data
  run_capture r stub_env CS_DATA_PARENT="$PARENT" CS_BACKUP_DIR="$T_ROOT/bk5" CS_TEST_SKIP_CHOWN=1 bash "$SCRIPTS_DIR/restore-data.sh" "$T_ROOT/a5.tar.gz"
  expect_nonzero "$r_rc" "$r_out"
  expect_contains "$r_out" "심볼릭 링크"
  [[ -f "$REAL/pglite" || -d "$REAL/pglite" ]] && [[ ! -e "$REAL/n.txt" ]] && ok "링크 대상 그대로" || ng "링크 대상이 바뀌었다"
else
  echo "  SKIP - (5) 이 환경에서 진짜 심볼릭 링크를 만들 수 없음"
fi

echo "(6) 표식 없이 준 CS_* 는 효과 없음(운영 진입점)"
# 시험 표식을 지우고(env -u), 바꿔치기 변수는 모두 유효한 시험 값으로 준다 → 운영 기본값(경로·root·소유자)으로 판정되어야 한다
DR="$T_ROOT/d6"
mkdir -p "$DR/pglite"
E6="$T_ROOT/env6"
{
  echo "APP_BASE_URL=https://studio.test-domain.invalid"
  for kv in AUTH_MODE=oidc DB_DRIVER=pglite WORKER_MODE=inline PUBLISH_MODE=disabled COLLECTOR_MODE=disabled COLLECTOR_SCHEDULER=off \
    IMPORT_CONNECTOR_MODE=disabled OAUTH_MODE=mock LLM_MODE=mock STT_MODE=mock WORKER_INLINE_INTERVAL_SECONDS=30; do echo "$kv"; done
  for k in DATABASE_URL STORAGE_LOCAL_DIR EXPORT_LOCAL_DIR RESTORE_LOCAL_DIR IMPORT_LOCAL_DIR; do echo "$k=$DR/$k"; done
} >"$E6"
OM="$(stat -c '%U:%G %a' "$E6")"
t "check-env: 표식 있으면 시험 값으로 OK(대조)"
run_capture r env CS_ENV_FILE="$E6" CS_DATA_ROOT="$DR" CS_ENV_OWNER_MODE="$OM" bash "$SCRIPTS_DIR/check-env.sh"
expect_rc 0 "$r_rc" "$r_out"
t "check-env: 표식 없으면 CS_ENV_FILE·CS_DATA_ROOT·CS_ENV_OWNER_MODE 무시(운영 경로 /etc/content-studio/env 를 본다)"
run_capture r env -u CS_DEPLOY_TEST_HARNESS CS_ENV_FILE="$E6" CS_DATA_ROOT="$DR" CS_ENV_OWNER_MODE="$OM" bash "$SCRIPTS_DIR/check-env.sh"
expect_nonzero "$r_rc" "$r_out"
expect_not_contains "$r_out" "[check-env] OK"
expect_contains "$r_out" "/etc/content-studio/env"
t "check-env: 표식 값이 1 이 아니면 무시"
run_capture r env CS_DEPLOY_TEST_HARNESS=yes CS_ENV_FILE="$E6" CS_DATA_ROOT="$DR" CS_ENV_OWNER_MODE="$OM" bash "$SCRIPTS_DIR/check-env.sh"
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "/etc/content-studio/env"

P6="$T_ROOT/p6"
mkdir -p "$P6/data"
echo old >"$P6/data/old.txt"
t "backup-data: 표식 없으면 root 요구·CS_TEST_SKIP_CHOWN·경로 바꿔치기 무시"
run_capture r env -u CS_DEPLOY_TEST_HARNESS PATH="$STUB_BIN:$PATH" CS_SYSTEMCTL="$STUB_BIN/systemctl" CS_DATA_PARENT="$P6" CS_BACKUP_DIR="$T_ROOT/bk6" CS_TEST_SKIP_CHOWN=1 \
  bash "$SCRIPTS_DIR/backup-data.sh" 0123456
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "root 로 실행"
if ls "$T_ROOT/bk6"/data-*.tar.gz >/dev/null 2>&1; then ng "사본이 만들어졌다"; else ok "사본 없음"; fi
t "restore-data: 표식 없으면 root 요구·바꿔치기 무시"
mkdir -p "$T_ROOT/s6/data"
echo new >"$T_ROOT/s6/data/new.txt"
tar -C "$T_ROOT/s6" -czf "$T_ROOT/a6.tar.gz" data
run_capture r env -u CS_DEPLOY_TEST_HARNESS PATH="$STUB_BIN:$PATH" CS_SYSTEMCTL="$STUB_BIN/systemctl" CS_MOUNTPOINT_CMD="$STUB_BIN/mountpoint" CS_DATA_PARENT="$P6" CS_BACKUP_DIR="$T_ROOT/bk6" CS_TEST_SKIP_CHOWN=1 \
  bash "$SCRIPTS_DIR/restore-data.sh" "$T_ROOT/a6.tar.gz"
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "root 로 실행"
[[ -f "$P6/data/old.txt" && ! -e "$P6/data/new.txt" ]] && ok "데이터 그대로" || ng "데이터가 바뀌었다"
t "build-release: 표식 없으면 CS_SERVICE_USER 무시(운영 사용자 content-studio 요구)"
run_capture r env -u CS_DEPLOY_TEST_HARNESS CS_SERVICE_USER="$ME" CS_REPO_ROOT="$NOREPO" CS_SYSTEMCTL="$STUB_BIN/systemctl" bash "$SCRIPTS_DIR/build-release.sh" "$SHA"
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "서비스 사용자(content-studio)"

finish
