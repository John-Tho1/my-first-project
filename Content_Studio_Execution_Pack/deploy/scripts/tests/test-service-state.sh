#!/usr/bin/env bash
# FIX2-T21P2(Codex review-FIX-T21P2 P1 build-release.sh:25 · backup-data.sh:21):
# 서비스 상태 조회가 "성공했고 inactive/failed" 일 때만 진행한다. 조회 실패·systemctl 없음·activating 등은 중단.
# 최초 설치(--first-install)는 unit 이 등록되지 않았음이 확인될 때만(list-unit-files 성공 + 없음).
# 진행 여부는 서비스 검사 다음 단계의 메시지로 판정한다(build-release: 저장소 루트 없음 / backup-data: 데이터 폴더 없음).
source "$(dirname "$0")/lib.sh"

SHA=0123456789abcdef0123456789abcdef01234567
ME="$(id -un)"
NOREPO="$T_ROOT/no-repo"
build() { stub_env CS_SERVICE_USER="$ME" CS_REPO_ROOT="$NOREPO" "$@" bash "$SCRIPTS_DIR/build-release.sh" "${BUILD_ARGS[@]}"; }
PASSED_SERVICE_BUILD="저장소 루트가 아닙니다"

echo "build-release.sh 서비스 상태"
BUILD_ARGS=("$SHA")
for st in inactive failed; do
  t "build: ActiveState=$st → 진행"
  run_capture r build STUB_ACTIVE="$st"
  expect_contains "$r_out" "$PASSED_SERVICE_BUILD"
done
for st in active activating deactivating reloading ""; do
  t "build: ActiveState='$st' → 중단"
  run_capture r build STUB_ACTIVE="$st"
  expect_nonzero "$r_rc" "$r_out"
  expect_not_contains "$r_out" "$PASSED_SERVICE_BUILD"
done
t "build: systemctl 조회 실패(버스 오류) → 중단"
run_capture r build STUB_SYSTEMCTL_FAIL=1
expect_nonzero "$r_rc" "$r_out"
expect_not_contains "$r_out" "$PASSED_SERVICE_BUILD"
t "build: systemctl 없음 → 중단"
run_capture r env PATH="$PATH" CS_SYSTEMCTL="$T_ROOT/none/systemctl" CS_SERVICE_USER="$ME" CS_REPO_ROOT="$NOREPO" bash "$SCRIPTS_DIR/build-release.sh" "$SHA"
expect_nonzero "$r_rc" "$r_out"
expect_not_contains "$r_out" "$PASSED_SERVICE_BUILD"
t "build: unit 미등록인데 --first-install 없음 → 중단"
run_capture r build STUB_LOAD=not-found STUB_ACTIVE=inactive
expect_nonzero "$r_rc" "$r_out"
expect_not_contains "$r_out" "$PASSED_SERVICE_BUILD"
BUILD_ARGS=(--first-install "$SHA")
t "build: --first-install + 미등록(list-unit-files 성공·없음) → 진행"
run_capture r build STUB_LOAD=not-found STUB_ACTIVE=inactive STUB_UNIT_FILES="ssh.service caddy.service"
expect_contains "$r_out" "$PASSED_SERVICE_BUILD"
t "build: --first-install + list-unit-files 실패 → 중단"
run_capture r build STUB_LOAD=not-found STUB_ACTIVE=inactive STUB_LIST_FAIL=1
expect_nonzero "$r_rc" "$r_out"
expect_not_contains "$r_out" "$PASSED_SERVICE_BUILD"
t "build: --first-install 인데 unit 파일 목록에 있음 → 중단"
run_capture r build STUB_LOAD=not-found STUB_ACTIVE=inactive STUB_UNIT_FILES="content-studio.service"
expect_nonzero "$r_rc" "$r_out"
expect_not_contains "$r_out" "$PASSED_SERVICE_BUILD"
t "build: --first-install 인데 이미 등록(loaded) → 중단"
run_capture r build STUB_LOAD=loaded STUB_ACTIVE=inactive
expect_nonzero "$r_rc" "$r_out"
expect_not_contains "$r_out" "$PASSED_SERVICE_BUILD"
t "build: LoadState=masked → 중단"
BUILD_ARGS=("$SHA")
run_capture r build STUB_LOAD=masked STUB_ACTIVE=inactive
expect_nonzero "$r_rc" "$r_out"
expect_not_contains "$r_out" "$PASSED_SERVICE_BUILD"

echo "backup-data.sh 서비스 상태"
NODATA="$T_ROOT/no-data-parent"
PASSED_SERVICE_BACKUP="데이터 폴더가 없습니다"
backup() { stub_env CS_DATA_PARENT="$NODATA" CS_BACKUP_DIR="$T_ROOT/bk" "$@" bash "$SCRIPTS_DIR/backup-data.sh" "$SHA"; }
# backup-data 는 데이터 폴더 확인을 서비스 확인 뒤에 한다(FIX2) — 진행했으면 "데이터 폴더가 없습니다"
for st in inactive failed; do
  t "backup: ActiveState=$st → 진행"
  run_capture r backup STUB_ACTIVE="$st"
  expect_contains "$r_out" "$PASSED_SERVICE_BACKUP"
done
for st in active activating deactivating reloading; do
  t "backup: ActiveState=$st → 중단"
  run_capture r backup STUB_ACTIVE="$st"
  expect_nonzero "$r_rc" "$r_out"
  expect_not_contains "$r_out" "$PASSED_SERVICE_BACKUP"
done
t "backup: systemctl 조회 실패 → 중단"
run_capture r backup STUB_SYSTEMCTL_FAIL=1
expect_nonzero "$r_rc" "$r_out"
expect_not_contains "$r_out" "$PASSED_SERVICE_BACKUP"
t "backup: systemctl 없음 → 중단"
run_capture r env PATH="$STUB_BIN:$PATH" CS_SYSTEMCTL="$T_ROOT/none/systemctl" CS_DATA_PARENT="$NODATA" CS_BACKUP_DIR="$T_ROOT/bk" bash "$SCRIPTS_DIR/backup-data.sh" "$SHA"
expect_nonzero "$r_rc" "$r_out"
expect_not_contains "$r_out" "$PASSED_SERVICE_BACKUP"
t "backup: unit 미등록 → 중단(백업에는 최초 설치 예외 없음)"
run_capture r backup STUB_LOAD=not-found STUB_ACTIVE=inactive
expect_nonzero "$r_rc" "$r_out"
expect_not_contains "$r_out" "$PASSED_SERVICE_BACKUP"

finish
