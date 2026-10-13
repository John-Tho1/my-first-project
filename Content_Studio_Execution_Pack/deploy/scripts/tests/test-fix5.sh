#!/usr/bin/env bash
# FIX5-T21P2(Codex review-FIX4-T21P2):
#  (1) P0 restore-data.sh:89 — 바꾸기 전에 **지금 데이터**도 같은 검사(특수 항목·하드링크·이름 규칙·하위 마운트)를 통과해야 하고,
#      직전 사본도 들어오는 사본과 같은 검사를 통과해야 교체를 시작한다. 실패하면 아무것도 바꾸지 않는다.
#  (2) P1 backup-data.sh:31 — 백업과 복원이 같은 검사(lib/common.sh)를 쓴다. 쓴 사본도 사본 검사를 통과해야 성공, 아니면 지우고 실패.
#  (3) P1 common.sh:101 — 시험 경로는 정규화(realpath -m, 기존 링크 해석)한 결과가 시험 임시 루트(CS_HARNESS_ROOT) 아래여야 한다.
#      상대 경로·`..`·중간 링크로 밖을 가리키는 경로는 거부.
source "$(dirname "$0")/lib.sh"

mk_case() {
  local p="$T_ROOT/$1"
  mkdir -p "$p/parent/data/sub" "$p/src/data/sub"
  echo old >"$p/parent/data/old.txt"
  echo new >"$p/src/data/new.txt"
  tar -C "$p/src" -czf "$p/backup.tar.gz" data
  echo "$p"
}
restore() { local p="$1"; shift; stub_env CS_DATA_PARENT="$p/parent" CS_BACKUP_DIR="$p/bk" "$@" bash "$SCRIPTS_DIR/restore-data.sh" "$p/backup.tar.gz"; }
backup() { local p="$1"; shift; stub_env CS_DATA_PARENT="$p/parent" CS_BACKUP_DIR="$p/bk" "$@" bash "$SCRIPTS_DIR/backup-data.sh" 0123456; }
untouched() { # 데이터 그대로·교체 흔적 없음·직전 사본 없음
  [[ -f "$1/parent/data/old.txt" && ! -e "$1/parent/data/new.txt" ]] || return 1
  ! ls -d "$1/parent"/data.replaced-* >/dev/null 2>&1 || return 1
  ! ls "$1/bk"/data-before-restore-* >/dev/null 2>&1
}
can_symlink() { MSYS=winsymlinks:nativestrict ln -s "$T_ROOT" "$T_ROOT/.lnp.$1" 2>/dev/null && [[ -L "$T_ROOT/.lnp.$1" ]]; }

echo "(1) 지금 데이터·직전 사본 검사(바꾸기 전)"
P="$(mk_case curhard)"
if ln "$P/parent/data/old.txt" "$P/parent/data/hard.txt" 2>/dev/null && [[ "$(stat -c %h "$P/parent/data/old.txt")" -gt 1 ]]; then
  t "일반 폴더: 지금 데이터에 하드링크 → 거부, 아무것도 바꾸지 않음(직전 사본도 없음)"
  run_capture r restore "$P"
  expect_nonzero "$r_rc" "$r_out"
  expect_contains "$r_out" "하드링크"
  untouched "$P" && ok "그대로" || ng "바뀌었다"
  t "마운트 지점: 지금 데이터에 하드링크 → 거부, 그대로"
  P2="$(mk_case curhardm)"
  ln "$P2/parent/data/old.txt" "$P2/parent/data/hard.txt"
  run_capture r restore "$P2" STUB_MOUNTPOINT="$P2/parent/data"
  expect_nonzero "$r_rc" "$r_out"
  untouched "$P2" && [[ -f "$P2/parent/data/hard.txt" ]] && ok "그대로" || ng "바뀌었다"
else
  echo "  SKIP - 하드링크를 만들 수 없음"
fi
if can_symlink a; then
  t "지금 데이터에 심볼릭 링크 → 거부, 그대로"
  P="$(mk_case curlink)"
  MSYS=winsymlinks:nativestrict ln -s "$T_ROOT" "$P/parent/data/link"
  run_capture r restore "$P"
  expect_nonzero "$r_rc" "$r_out"
  untouched "$P" && ok "그대로" || ng "바뀌었다"
else
  echo "  SKIP - 심볼릭 링크를 만들 수 없음"
fi
t "지금 데이터에 줄바꿈 이름 → 거부, 그대로"
P="$(mk_case curnl)"
: >"$P/parent/data/a
b"
run_capture r restore "$P"
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "이름"
untouched "$P" && ok "그대로" || ng "바뀌었다"
t "직전 사본이 사본 검사를 통과하지 못함 → 교체 전에 거부, 그 직전 사본은 지움"
P="$(mk_case badsnap)"
run_capture r restore "$P" STUB_TAR_BAD_OUT_GLOB='*data-before-restore*'
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "직전 사본"
untouched "$P" && ok "그대로(직전 사본 파일도 없음)" || ng "바뀌었다"
t "마운트 지점: 직전 사본 검사 실패 → 거부, 그대로"
P="$(mk_case badsnapm)"
run_capture r restore "$P" STUB_MOUNTPOINT="$P/parent/data" STUB_TAR_BAD_OUT_GLOB='*data-before-restore*'
expect_nonzero "$r_rc" "$r_out"
untouched "$P" && ok "그대로" || ng "바뀌었다"

echo "(2) 백업 = 복원 검사"
t "데이터에 줄바꿈 이름 → 백업 거부, 사본 없음"
P="$(mk_case bknl)"
: >"$P/parent/data/a
b"
run_capture r backup "$P"
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "이름"
if ls "$P/bk"/data-* >/dev/null 2>&1; then ng "사본이 남았다"; else ok "사본 없음"; fi
t "쓴 사본이 사본 검사를 통과하지 못함 → 백업 실패, 그 사본은 지움"
P="$(mk_case bkbad)"
run_capture r backup "$P" STUB_TAR_BAD_OUT_GLOB='*/data-*-0123456.*'
expect_nonzero "$r_rc" "$r_out"
if ls "$P/bk"/data-* >/dev/null 2>&1; then ng "사본이 남았다"; else ok "사본 없음"; fi
t "한국어 이름: 백업이 성공하면 복원도 성공(로캘에 따라 둘 다 거부될 수는 있지만 서로 어긋나지 않음)"
P="$(mk_case korean)"
echo 한 >"$P/parent/data/한국어.txt"
run_capture r backup "$P"
if [[ "$r_rc" == 0 ]]; then
  made="$(ls "$P/bk"/data-*-0123456.*.tar.gz | head -1)"
  rm -f "$P/parent/data/한국어.txt"
  run_capture r2 stub_env CS_DATA_PARENT="$P/parent" CS_BACKUP_DIR="$P/bk" bash "$SCRIPTS_DIR/restore-data.sh" "$made"
  expect_rc 0 "$r2_rc" "$r2_out"
  [[ -f "$P/parent/data/한국어.txt" ]] && ok "왕복 일치" || ng "왕복 내용 다름"
else
  if ls "$P/bk"/data-* >/dev/null 2>&1; then ng "백업 거부인데 사본이 남았다"; else ok "백업 거부·사본 없음(로캘이 이름을 이스케이프)"; fi
fi

echo "(3) 시험 경로 정규화"
P="$(mk_case paths)"
t "/tmp/../srv/content-studio → 거부"
run_capture r stub_env CS_DATA_PARENT="/tmp/../srv/content-studio" CS_BACKUP_DIR="$P/bk" bash "$SCRIPTS_DIR/backup-data.sh" 0123456
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "CS_DATA_PARENT"
t "상대 경로 → 거부"
run_capture r stub_env CS_DATA_PARENT="paths/parent" CS_BACKUP_DIR="$P/bk" bash "$SCRIPTS_DIR/backup-data.sh" 0123456
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "CS_DATA_PARENT"
t "시험 루트 안이어도 .. 가 들어간 경로 → 거부"
run_capture r stub_env CS_DATA_PARENT="$P/x/../parent" CS_BACKUP_DIR="$P/bk" bash "$SCRIPTS_DIR/backup-data.sh" 0123456
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "CS_DATA_PARENT"
t "시험 루트 밖(다른 임시 폴더) → 거부"
OUTSIDE="$(mktemp -d "${TMPDIR:-/tmp}/cs-deploy-outside.XXXXXX")"
mkdir -p "$OUTSIDE/data"
echo keep >"$OUTSIDE/data/keep.txt"
run_capture r stub_env CS_DATA_PARENT="$OUTSIDE" CS_BACKUP_DIR="$P/bk" bash "$SCRIPTS_DIR/backup-data.sh" 0123456
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "CS_DATA_PARENT"
if can_symlink b; then
  t "시험 루트 안 링크가 밖을 가리킴(중간 링크) → 거부, 밖의 데이터 그대로"
  MSYS=winsymlinks:nativestrict ln -s "$OUTSIDE" "$T_ROOT/escape"
  run_capture r stub_env CS_DATA_PARENT="$T_ROOT/escape" CS_BACKUP_DIR="$P/bk" bash "$SCRIPTS_DIR/backup-data.sh" 0123456
  expect_nonzero "$r_rc" "$r_out"
  expect_contains "$r_out" "CS_DATA_PARENT"
  run_capture r stub_env CS_DATA_PARENT="$P/parent" CS_BACKUP_DIR="$T_ROOT/escape/bk" bash "$SCRIPTS_DIR/backup-data.sh" 0123456
  expect_nonzero "$r_rc" "$r_out"
  expect_contains "$r_out" "CS_BACKUP_DIR"
  [[ ! -e "$OUTSIDE/bk" ]] && ok "밖에 사본 폴더를 만들지 않음" || ng "밖에 사본 폴더가 생겼다"
else
  echo "  SKIP - 심볼릭 링크를 만들 수 없음"
fi
rm -rf "$OUTSIDE"
t "CS_HARNESS_ROOT 가 없으면 시험 경로 모두 거부"
run_capture r env -u CS_HARNESS_ROOT PATH="$STUB_BIN:$PATH" CS_SYSTEMCTL="$STUB_BIN/systemctl" CS_SERVICE_USER="$(id -un)" CS_LOCK_FILE="$LOCK_DEFAULT" CS_MOUNTINFO="$MOUNTINFO_DEFAULT" \
  CS_DATA_PARENT="$P/parent" CS_BACKUP_DIR="$P/bk" bash "$SCRIPTS_DIR/backup-data.sh" 0123456
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "CS_HARNESS_ROOT"
t "정상 시험 경로(대조) → 백업 성공"
run_capture r backup "$P"
expect_rc 0 "$r_rc" "$r_out"

finish
