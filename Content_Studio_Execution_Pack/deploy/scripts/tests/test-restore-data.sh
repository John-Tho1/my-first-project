#!/usr/bin/env bash
# restore-data.sh 시험(FIX2-T21P2 → FIX3-T21P2 재설계).
# FIX3(Codex review-FIX2-T21P2 P0 :31 · P0 :45 · P1 :26):
#  - 사본은 같은 파일 시스템의 새 임시 폴더(mktemp -d)에 먼저 풀고, 풀기 전(tar -tv 형식)·후(find) 모두 일반 파일·폴더만 있는지 확인한다.
#    링크·하드링크·특수 파일·data/ 밖 경로·최상위 data 가 링크인 사본은 거부(데이터·링크 대상은 그대로).
#  - 복원 직전 사본은 배타적으로 만든 고유 이름 — 같은 초에 두 번 돌려도, 직전 사본을 입력으로 다시 돌려도 덮어쓰지 않는다.
#  - 교체 실패 시 되돌림: 일반 폴더는 옮겨 둔 폴더를 되돌리고, 마운트 지점은 직전 사본으로 자동 복구. 데이터 폴더가 없는 상태는 --data-missing-ok 로만.
source "$(dirname "$0")/lib.sh"

SCRIPT="$SCRIPTS_DIR/restore-data.sh"
mk_case() { # mk_case <name> → 데이터 부모 폴더(현재 내용 old.txt)와 사본(new.txt·sub/deep.txt) 준비
  local p="$T_ROOT/$1"
  mkdir -p "$p/parent/data/sub" "$p/src/data/sub" # 사본 폴더(bk)는 스크립트가 만든다
  echo old >"$p/parent/data/old.txt"
  echo new >"$p/src/data/new.txt"
  echo deep >"$p/src/data/sub/deep.txt"
  tar -C "$p/src" -czf "$p/backup.tar.gz" data
  echo "$p"
}
restore() { # restore <case-dir> [env...] — 인수는 RESTORE_ARGS(기본: 사본 파일)
  local p="$1"
  shift
  stub_env CS_DATA_PARENT="$p/parent" CS_BACKUP_DIR="$p/bk" CS_TEST_SKIP_CHOWN=1 "$@" bash "$SCRIPT" "${RESTORE_ARGS[@]:-$p/backup.tar.gz}"
}
unchanged() { [[ -f "$1/parent/data/old.txt" && ! -e "$1/parent/data/new.txt" ]]; }
no_stage_left() { ! ls -d "$1/parent"/.restore-stage.* "$1/parent/data"/.restore-stage.* "$1/parent/data"/.restore-rollback.* >/dev/null 2>&1; }
can_symlink() {
  local probe="$T_ROOT/.lnprobe"
  MSYS=winsymlinks:nativestrict ln -s "$T_ROOT" "$probe" 2>/dev/null && [[ -L "$probe" ]] && rm -f "$probe"
}
RESTORE_ARGS=()

echo "restore-data.sh — 정상 경로"
t "일반 폴더: 임시 폴더에 풀고 검증한 뒤 교체, 이전 폴더 보존, 직전 사본"
P="$(mk_case plain)"
run_capture r restore "$P"
expect_rc 0 "$r_rc" "$r_out"
expect_contains "$r_out" "mode=directory"
[[ -f "$P/parent/data/new.txt" && -f "$P/parent/data/sub/deep.txt" && ! -e "$P/parent/data/old.txt" ]] && ok "내용 교체" || ng "내용 교체 안 됨"
ls "$P/parent"/data.replaced-*/data/old.txt >/dev/null 2>&1 && ok "이전 폴더 보존" || ng "이전 폴더 없음"
ls "$P/bk"/data-before-restore-*.tar.gz >/dev/null 2>&1 && ok "직전 사본" || ng "직전 사본 없음"
no_stage_left "$P" && ok "임시 폴더 정리" || ng "임시 폴더가 남았다"

t "마운트 지점: 폴더는 그대로(mv 없음), 마운트 안 임시 폴더에 풀고 검증한 뒤 내용만 교체"
P="$(mk_case mounted)"
echo keep >"$P/parent/data/.hidden-old"
run_capture r restore "$P" STUB_MOUNTPOINT="$P/parent/data"
expect_rc 0 "$r_rc" "$r_out"
expect_contains "$r_out" "mode=mountpoint"
[[ -f "$P/parent/data/new.txt" && -f "$P/parent/data/sub/deep.txt" && ! -e "$P/parent/data/old.txt" && ! -e "$P/parent/data/.hidden-old" ]] && ok "내용 교체" || ng "내용 교체 안 됨"
if ls -d "$P/parent/data.replaced-"* >/dev/null 2>&1; then ng "마운트 지점을 옮겼다(mv)"; else ok "mv 없음"; fi
ls "$P/bk"/data-before-restore-*.tar.gz >/dev/null 2>&1 && ok "직전 사본" || ng "직전 사본 없음"
no_stage_left "$P" && ok "임시 폴더 정리" || ng "임시 폴더가 남았다"

echo "restore-data.sh — 실행 조건"
t "서비스 실행 중 → 중단(아무것도 바꾸지 않음)"
P="$(mk_case active)"
run_capture r restore "$P" STUB_ACTIVE=active
expect_nonzero "$r_rc" "$r_out"
unchanged "$P" && ok "그대로" || ng "바뀌었다"
t "systemctl 조회 실패 → 중단"
P="$(mk_case busfail)"
run_capture r restore "$P" STUB_SYSTEMCTL_FAIL=1
expect_nonzero "$r_rc" "$r_out"
unchanged "$P" && ok "그대로" || ng "바뀌었다"
t "mountpoint 명령 없음 → 중단(일반 폴더로 가정하지 않음)"
P="$(mk_case nomp)"
run_capture r restore "$P" CS_MOUNTPOINT_CMD="$T_ROOT/none/mountpoint"
expect_nonzero "$r_rc" "$r_out"
unchanged "$P" && ok "그대로" || ng "바뀌었다"
t "mountpoint 오류(종료 코드 1) → 중단"
P="$(mk_case mperr)"
run_capture r restore "$P" STUB_MOUNTPOINT_FAIL=1
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "마운트 여부 확인에 실패"
unchanged "$P" && ok "그대로" || ng "바뀌었다"

echo "restore-data.sh — 사본 검증(P0 :31)"
t "사본에 data/ 밖 경로가 있으면 중단"
P="$(mk_case evil)"
mkdir -p "$P/evsrc/data" "$P/evsrc/other"
echo x >"$P/evsrc/data/a.txt"
echo y >"$P/evsrc/other/escape.txt"
tar -C "$P/evsrc" -czf "$P/backup.tar.gz" data other
run_capture r restore "$P"
expect_nonzero "$r_rc" "$r_out"
unchanged "$P" && ok "그대로" || ng "바뀌었다"
[[ ! -e "$P/parent/other" ]] && ok "밖에 풀리지 않음" || ng "data 밖에 풀렸다"
t "사본 최상위가 data/ 가 아니면 중단"
P="$(mk_case wrongtop)"
mkdir -p "$P/w/other"
echo z >"$P/w/other/z.txt"
tar -C "$P/w" -czf "$P/backup.tar.gz" other
run_capture r restore "$P"
expect_nonzero "$r_rc" "$r_out"
unchanged "$P" && ok "그대로" || ng "바뀌었다"

if can_symlink; then
  t "사본 안 심볼릭 링크(data/link → 밖) → 풀기 전에 거부, 링크 대상 권한·내용 그대로"
  P="$(mk_case symlink)"
  mkdir -p "$P/outside"
  echo o >"$P/outside/o.txt"
  chmod 755 "$P/outside"
  before_mode="$(stat -c '%a' "$P/outside")"
  MSYS=winsymlinks:nativestrict ln -s "$P/outside" "$P/src/data/link"
  tar -C "$P/src" -czf "$P/backup.tar.gz" data
  run_capture r restore "$P"
  expect_nonzero "$r_rc" "$r_out"
  expect_contains "$r_out" "일반 파일·폴더가 아닌 항목"
  unchanged "$P" && ok "그대로" || ng "바뀌었다"
  [[ "$(stat -c '%a' "$P/outside")" == "$before_mode" && -f "$P/outside/o.txt" ]] && ok "링크 대상 그대로" || ng "링크 대상이 바뀌었다"
  no_stage_left "$P" && ok "임시 폴더 없음" || ng "임시 폴더가 남았다"

  t "최상위 data 자체가 링크인 사본 → 거부"
  P="$(mk_case toplink)"
  mkdir -p "$P/outside2" "$P/ts"
  echo o >"$P/outside2/o.txt"
  MSYS=winsymlinks:nativestrict ln -s "$P/outside2" "$P/ts/data"
  tar -C "$P/ts" -czf "$P/backup.tar.gz" data
  run_capture r restore "$P"
  expect_nonzero "$r_rc" "$r_out"
  unchanged "$P" && ok "그대로" || ng "바뀌었다"
  [[ -f "$P/outside2/o.txt" ]] && ok "링크 대상 그대로" || ng "링크 대상이 바뀌었다"
else
  echo "  SKIP - 심볼릭 링크 사본 시험(이 환경에서 진짜 링크를 만들 수 없음)"
fi

P="$(mk_case hardlink)"
if ln "$P/src/data/new.txt" "$P/src/data/hard.txt" 2>/dev/null && tar -C "$P/src" -czf "$P/backup.tar.gz" data && tar -tvzf "$P/backup.tar.gz" | grep -q '^h'; then
  t "사본 안 하드링크 항목 → 거부"
  run_capture r restore "$P"
  expect_nonzero "$r_rc" "$r_out"
  expect_contains "$r_out" "일반 파일·폴더가 아닌 항목"
  unchanged "$P" && ok "그대로" || ng "바뀌었다"
else
  echo "  SKIP - 하드링크 사본 시험(이 환경에서 하드링크 항목을 만들 수 없음)"
fi

echo "restore-data.sh — 직전 사본 고유 이름(P0 :45)"
t "연속 두 번 실행 → 직전 사본 두 개(덮어쓰지 않음), 직전 사본을 입력으로 다시 실행해도 입력 파일 그대로"
P="$(mk_case twice)"
run_capture r restore "$P"
expect_rc 0 "$r_rc" "$r_out"
run_capture r2 restore "$P"
expect_rc 0 "$r2_rc" "$r2_out"
n="$(ls "$P/bk"/data-before-restore-*.tar.gz 2>/dev/null | wc -l)"
[[ "$n" -eq 2 ]] && ok "직전 사본 2개" || ng "직전 사본 $n 개"
first="$(ls "$P/bk"/data-before-restore-*.tar.gz | head -1)"
sum_before="$(cksum <"$first")"
RESTORE_ARGS=("$first")
run_capture r3 restore "$P"
RESTORE_ARGS=()
expect_rc 0 "$r3_rc" "$r3_out"
[[ "$(cksum <"$first")" == "$sum_before" ]] && ok "입력 사본 그대로" || ng "입력 사본이 바뀌었다"
[[ -f "$P/parent/data/old.txt" ]] && ok "직전 사본(old) 내용으로 복원" || ng "복원 내용 다름"
n="$(ls "$P/bk"/data-before-restore-*.tar.gz | wc -l)"
[[ "$n" -eq 3 ]] && ok "직전 사본 3개" || ng "직전 사본 $n 개"

echo "restore-data.sh — 교체 실패 되돌림(P1 :26)"
t "일반 폴더: 새 폴더를 제자리에 옮기다 실패 → 옮겨 둔 이전 폴더를 되돌린다"
P="$(mk_case swapfail)"
run_capture r restore "$P" STUB_MV_FAIL_ON=.restore-stage
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "되돌렸습니다"
unchanged "$P" && ok "이전 데이터로 되돌림" || ng "되돌리지 못함"
no_stage_left "$P" && ok "임시 폴더 정리" || ng "임시 폴더가 남았다"
t "마운트 지점: 내용 채우기 실패 → 직전 사본으로 자동 복구"
P="$(mk_case mountfail)"
run_capture r restore "$P" STUB_MOUNTPOINT="$P/parent/data" STUB_MV_FAIL_ON=.restore-stage
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "직전 사본으로 복구했습니다"
unchanged "$P" && ok "이전 데이터로 복구" || ng "복구하지 못함"
[[ -f "$P/parent/data/sub/.keep" || -d "$P/parent/data/sub" ]] && ok "하위 폴더 복구" || ng "하위 폴더 없음"
no_stage_left "$P" && ok "임시 폴더 정리" || ng "임시 폴더가 남았다"

echo "restore-data.sh — 데이터 폴더가 없는 상태"
t "데이터 폴더 없음 + 표시 없음 → 중단(안내)"
P="$(mk_case missing)"
rm -rf "$P/parent/data"
run_capture r restore "$P"
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "--data-missing-ok"
t "데이터 폴더 없음 + --data-missing-ok → 사본으로 만든다"
RESTORE_ARGS=(--data-missing-ok "$P/backup.tar.gz")
run_capture r restore "$P"
RESTORE_ARGS=()
expect_rc 0 "$r_rc" "$r_out"
expect_contains "$r_out" "mode=missing"
[[ -f "$P/parent/data/new.txt" ]] && ok "복원됨" || ng "복원 안 됨"
t "데이터 폴더가 있는데 --data-missing-ok → 중단(실수 방지)"
RESTORE_ARGS=(--data-missing-ok "$P/backup.tar.gz")
run_capture r restore "$P"
RESTORE_ARGS=()
expect_nonzero "$r_rc" "$r_out"

echo "backup-data.sh"
t "정지 확인 뒤 사본(고유 이름)을 만들고 데이터 폴더는 그대로(마운트 지점이어도 옮기지 않음)"
P="$(mk_case backup)"
run_capture r stub_env CS_DATA_PARENT="$P/parent" CS_BACKUP_DIR="$P/bk" CS_TEST_SKIP_CHOWN=1 STUB_MOUNTPOINT="$P/parent/data" bash "$SCRIPTS_DIR/backup-data.sh" 0123456
expect_rc 0 "$r_rc" "$r_out"
ls "$P/bk"/data-*-0123456.*tar.gz >/dev/null 2>&1 && ok "사본 있음" || ng "사본 없음"
[[ -f "$P/parent/data/old.txt" ]] && ok "데이터 그대로" || ng "데이터가 바뀌었다"
run_capture r2 stub_env CS_DATA_PARENT="$P/parent" CS_BACKUP_DIR="$P/bk" CS_TEST_SKIP_CHOWN=1 bash "$SCRIPTS_DIR/backup-data.sh" 0123456
expect_rc 0 "$r2_rc" "$r2_out"
n="$(ls "$P/bk"/data-*-0123456.*tar.gz 2>/dev/null | wc -l)"
[[ "$n" -eq 2 ]] && ok "같은 초 두 번 → 사본 2개" || ng "사본 $n 개"

finish
