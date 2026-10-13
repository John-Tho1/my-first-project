#!/usr/bin/env bash
# FIX4-T21P2(Codex review-FIX3-T21P2) — 낯선 것은 처리하지 않고 바꾸기 전에 거부(fail closed):
#  (1) 시험 실행기 root 거부 · 시험 실행에서 운영 경로(또는 경로 미지정) 거부
#  (2) 데이터 폴더 아래 하위 마운트(같은 파일 시스템 bind 포함)가 있으면 거부, 마운트 정보를 못 읽으면 거부
#  (3) 되돌림·자동 복구 뒤에도 서비스 사용자 소유·권한을 다시 적용하고 확인
#  (4) backup-data 는 restore-data 가 받는 형식만 만든다(링크·하드링크(링크 수>1)·특수 파일이 있으면 실패) + 실제 백업 → 복원 왕복
#  (5) 이름에 줄바꿈·역슬래시·제어 문자·UTF-8 아닌 바이트가 있는 사본 거부, PAX 긴 이름은 허용
#  (6) flock 으로 동시 실행 거부(이 PC 에는 flock 이 없어 가짜 flock 으로 "잠금이 이미 잡힌 경우"만 시험)
#  (7) 데이터 폴더가 마운트여야 한다는 표시(.data-must-be-mount)가 있으면 마운트가 아닐 때(폴더 없음 포함) 거부
source "$(dirname "$0")/lib.sh"

SHA=0123456789abcdef0123456789abcdef01234567
ME="$(id -un)"
mk_case() { # 데이터 부모(현재 old.txt·sub/)와 사본(new.txt·sub/deep.txt)
  local p="$T_ROOT/$1"
  mkdir -p "$p/parent/data/sub" "$p/src/data/sub"
  echo old >"$p/parent/data/old.txt"
  echo oldsub >"$p/parent/data/sub/old-sub.txt"
  echo new >"$p/src/data/new.txt"
  echo deep >"$p/src/data/sub/deep.txt"
  tar -C "$p/src" -czf "$p/backup.tar.gz" data
  echo "$p"
}
restore() { local p="$1"; shift; stub_env CS_DATA_PARENT="$p/parent" CS_BACKUP_DIR="$p/bk" "$@" bash "$SCRIPTS_DIR/restore-data.sh" "${RARGS[@]:-$p/backup.tar.gz}"; }
backup() { local p="$1"; shift; stub_env CS_DATA_PARENT="$p/parent" CS_BACKUP_DIR="$p/bk" "$@" bash "$SCRIPTS_DIR/backup-data.sh" 0123456; }
unchanged() { [[ -f "$1/parent/data/old.txt" && ! -e "$1/parent/data/new.txt" ]]; }
RARGS=()

echo "(1) 시험 실행기 root 거부·운영 경로 거부"
t "guard: EUID 0 이면 종료 코드 2, 그 밖은 통과"
run_capture r bash -c "source '$TESTS_DIR/guard.sh'; cs_harness_refuse_root 0; echo SHOULD-NOT-REACH"
expect_rc 2 "$r_rc" "$r_out"
expect_not_contains "$r_out" "SHOULD-NOT-REACH"
run_capture r bash -c "source '$TESTS_DIR/guard.sh'; cs_harness_refuse_root 1000; echo reached"
expect_contains "$r_out" "reached"
t "lib.sh·run-all.sh 는 guard 를 다른 어떤 명령보다 먼저 부른다"
for f in lib.sh run-all.sh; do
  # 주석·빈 줄·`set -u` 를 뺀 첫 두 명령이 guard source + 호출이어야 한다
  first="$(grep -vE '^\s*(#|$)|^set -u$' "$TESTS_DIR/$f" | head -2 | tr '\n' ' ')"
  [[ "$first" == *"guard.sh"*"cs_harness_refuse_root \"\$EUID\""* ]] && ok "$f" || ng "$f 첫 명령: $first"
done
t "시험 실행인데 데이터 경로가 운영 경로 → 거부(아무것도 바꾸지 않음)"
run_capture r stub_env CS_DATA_PARENT=/srv/content-studio CS_BACKUP_DIR="$T_ROOT/bk1" bash "$SCRIPTS_DIR/backup-data.sh" 0123456
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "운영 경로"
t "시험 실행인데 경로 변수를 안 줌 → 운영 기본값으로 떨어지지 않고 거부"
run_capture r env PATH="$STUB_BIN:$PATH" CS_SYSTEMCTL="$STUB_BIN/systemctl" CS_LOCK_FILE="$LOCK_DEFAULT" CS_MOUNTINFO="$MOUNTINFO_DEFAULT" CS_SERVICE_USER="$ME" \
  bash "$SCRIPTS_DIR/backup-data.sh" 0123456
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "CS_DATA_PARENT"
t "시험 실행인데 사본 폴더가 운영 경로 → 거부"
P="$(mk_case prodbk)"
run_capture r restore "$P" CS_BACKUP_DIR=/srv/content-studio-backup
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "운영 경로"
unchanged "$P" && ok "그대로" || ng "바뀌었다"

echo "(2) 하위 마운트"
P="$(mk_case submount)"
MI="$T_ROOT/mi-sub"
printf '%s\n' "1 0 8:1 / / rw - ext4 /dev/sda1 rw" "2 1 8:1 /x $P/parent/data/sub rw - ext4 /dev/sda1 rw" >"$MI"
t "restore: 데이터 폴더 아래 bind 마운트(같은 장치) → 바꾸기 전에 거부"
run_capture r restore "$P" CS_MOUNTINFO="$MI"
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "하위 마운트"
unchanged "$P" && [[ -f "$P/parent/data/sub/old-sub.txt" ]] && ok "그대로" || ng "바뀌었다"
t "restore: 데이터 폴더 자체가 마운트(정확히 같은 경로)는 하위 마운트가 아님 → 진행"
P2="$(mk_case selfmount)"
printf '%s\n' "1 0 8:1 / / rw - ext4 /dev/sda1 rw" "2 1 8:2 / $P2/parent/data rw - ext4 /dev/sdb1 rw" >"$T_ROOT/mi-self"
run_capture r restore "$P2" CS_MOUNTINFO="$T_ROOT/mi-self" STUB_MOUNTPOINT="$P2/parent/data"
expect_rc 0 "$r_rc" "$r_out"
t "restore: 이름이 데이터 폴더로 시작하는 형제(data2) 마운트는 무관 → 진행"
P3="$(mk_case sibling)"
printf '%s\n' "1 0 8:1 / / rw - ext4 /dev/sda1 rw" "2 1 8:3 / $P3/parent/data2 rw - ext4 /dev/sdc1 rw" >"$T_ROOT/mi-sib"
run_capture r restore "$P3" CS_MOUNTINFO="$T_ROOT/mi-sib"
expect_rc 0 "$r_rc" "$r_out"
t "restore: 마운트 정보를 못 읽음 → 거부"
P="$(mk_case nomi)"
run_capture r restore "$P" CS_MOUNTINFO="$T_ROOT/does-not-exist"
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "마운트 정보"
unchanged "$P" && ok "그대로" || ng "바뀌었다"
t "backup: 하위 마운트 → 거부"
P="$(mk_case bksub)"
printf '%s\n' "1 0 8:1 / / rw - ext4 /dev/sda1 rw" "2 1 8:1 /x $P/parent/data/sub rw - ext4 /dev/sda1 rw" >"$T_ROOT/mi-bk"
run_capture r backup "$P" CS_MOUNTINFO="$T_ROOT/mi-bk"
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "하위 마운트"

echo "(3) 되돌림·자동 복구 뒤 소유자·권한"
t "마운트 지점: 일부 항목을 옮긴 뒤 실패 → 직전 사본으로 복구 + 서비스 사용자 소유 재적용"
P="$(mk_case latefail)"
: >"$CHOWN_LOG"
run_capture r restore "$P" STUB_MOUNTPOINT="$P/parent/data" STUB_MV_FAIL_ON='*/.restore-stage.*/data/sub'
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "직전 사본으로 복구"
[[ -f "$P/parent/data/old.txt" && -f "$P/parent/data/sub/old-sub.txt" && ! -e "$P/parent/data/new.txt" ]] && ok "내용 복구(먼저 옮긴 new.txt 도 없음)" || ng "복구 내용 다름"
grep -q -- "-R --no-dereference -- $ME:$ME .*\.restore-rollback\." "$CHOWN_LOG" && ok "복구 트리 chown" || ng "복구 트리 chown 없음: $(cat "$CHOWN_LOG")"
[[ -z "$(find "$P/parent/data" ! -user "$ME" -print -quit)" ]] && ok "서비스 사용자 소유" || ng "다른 소유자"
t "일반 폴더: 교체 실패 → 이전 폴더 되돌림 + 소유자 재적용"
P="$(mk_case plainfail)"
: >"$CHOWN_LOG"
run_capture r restore "$P" STUB_MV_FAIL_ON='*.restore-stage*'
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "되돌렸습니다"
unchanged "$P" && ok "이전 데이터" || ng "되돌리지 못함"
grep -q -- "-R --no-dereference -- $ME:$ME $P/parent/data\$" "$CHOWN_LOG" && ok "되돌린 폴더 chown" || ng "되돌린 폴더 chown 없음: $(cat "$CHOWN_LOG")"
t "정상 복원도 같은 소유자 적용(-R --no-dereference)"
P="$(mk_case okown)"
: >"$CHOWN_LOG"
run_capture r restore "$P"
expect_rc 0 "$r_rc" "$r_out"
grep -q -- "-R --no-dereference -- $ME:$ME .*\.restore-stage\..*/data" "$CHOWN_LOG" && ok "임시 data chown" || ng "chown 없음: $(cat "$CHOWN_LOG")"

echo "(4) 백업 형식 = 복원 형식, 왕복"
t "실제 backup-data 사본 → restore-data 로 복원(왕복)"
P="$(mk_case roundtrip)"
echo "round" >"$P/parent/data/sub/rt.txt"
run_capture r backup "$P"
expect_rc 0 "$r_rc" "$r_out"
made="$(ls "$P/bk"/data-*-0123456.*.tar.gz | head -1)"
rm -f "$P/parent/data/old.txt" "$P/parent/data/sub/rt.txt"
echo changed >"$P/parent/data/changed.txt"
RARGS=("$made")
run_capture r restore "$P"
RARGS=()
expect_rc 0 "$r_rc" "$r_out"
[[ -f "$P/parent/data/old.txt" && -f "$P/parent/data/sub/rt.txt" && ! -e "$P/parent/data/changed.txt" ]] && ok "왕복 내용 일치" || ng "왕복 내용 다름"
if MSYS=winsymlinks:nativestrict ln -s "$T_ROOT" "$T_ROOT/.lnprobe" 2>/dev/null && [[ -L "$T_ROOT/.lnprobe" ]]; then
  t "backup: 데이터 안 심볼릭 링크 → 실패(사본 없음)"
  P="$(mk_case bklink)"
  MSYS=winsymlinks:nativestrict ln -s "$T_ROOT" "$P/parent/data/link"
  run_capture r backup "$P"
  expect_nonzero "$r_rc" "$r_out"
  expect_contains "$r_out" "일반 파일·폴더가 아닌"
  if ls "$P/bk"/data-*.tar.gz >/dev/null 2>&1; then ng "사본이 남았다"; else ok "사본 없음"; fi
else
  echo "  SKIP - 데이터 안 심볼릭 링크 백업 시험(링크를 만들 수 없음)"
fi
P="$(mk_case bkhard)"
if ln "$P/parent/data/old.txt" "$P/parent/data/hard.txt" 2>/dev/null && [[ "$(stat -c %h "$P/parent/data/old.txt")" -gt 1 ]]; then
  t "backup: 하드링크(링크 수 > 1) → 실패(사본 없음)"
  run_capture r backup "$P"
  expect_nonzero "$r_rc" "$r_out"
  expect_contains "$r_out" "하드링크"
  if ls "$P/bk"/data-*.tar.gz >/dev/null 2>&1; then ng "사본이 남았다"; else ok "사본 없음"; fi
else
  echo "  SKIP - 하드링크 백업 시험(하드링크를 만들 수 없음)"
fi

echo "(5) 사본 항목 이름"
t "이름에 줄바꿈 → 거부"
P="$(mk_case newline)"
: >"$P/src/data/a
b"
tar -C "$P/src" -czf "$P/backup.tar.gz" data
run_capture r restore "$P"
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "이름"
unchanged "$P" && ok "그대로" || ng "바뀌었다"
t "UTF-8 이 아닌 이름 → 거부"
P="$(mk_case badutf)"
# Windows(Cygwin)는 0xFF 바이트를 유효한 UTF-8(ÿ)로 바꿔 만들므로, 실제로 0xFF 이름이 생긴 환경에서만 시험한다
if : >"$P/src/data/$(printf 'x\xff')" 2>/dev/null && ls "$P/src/data" | LC_ALL=C grep -q $'x\xff$'; then
  tar -C "$P/src" -czf "$P/backup.tar.gz" data
  run_capture r restore "$P"
  expect_nonzero "$r_rc" "$r_out"
  unchanged "$P" && ok "그대로" || ng "바뀌었다"
else
  echo "  SKIP - UTF-8 아닌 이름 파일을 만들 수 없음(이 환경은 바이트를 UTF-8 로 바꿔 저장)"
fi
t "PAX 형식 긴 이름(경로 150자 이상) → 허용·복원"
P="$(mk_case paxlong)"
long="$(printf 'd%.0s' $(seq 1 60))/$(printf 'e%.0s' $(seq 1 60))/$(printf 'f%.0s' $(seq 1 40)).txt"
mkdir -p "$P/src/data/$(dirname "$long")"
echo pax >"$P/src/data/$long"
tar -C "$P/src" --format=pax -czf "$P/backup.tar.gz" data
run_capture r restore "$P"
expect_rc 0 "$r_rc" "$r_out"
[[ -f "$P/parent/data/$long" ]] && ok "긴 이름 복원" || ng "긴 이름 없음"

echo "(6) 동시 실행(잠금)"
for s in backup-data restore-data build-release; do
  t "$s: 잠금이 이미 잡혀 있으면 거부"
  P="$(mk_case "lock-$s")"
  case "$s" in
    backup-data) run_capture r backup "$P" STUB_FLOCK_HELD=1 ;;
    restore-data) run_capture r restore "$P" STUB_FLOCK_HELD=1 ;;
    build-release) run_capture r stub_env CS_REPO_ROOT="$T_ROOT/no-repo" STUB_FLOCK_HELD=1 bash "$SCRIPTS_DIR/build-release.sh" "$SHA" ;;
  esac
  expect_nonzero "$r_rc" "$r_out"
  expect_contains "$r_out" "다른 배포 스크립트가 실행 중"
done
t "잠금 파일이 없으면 거부"
P="$(mk_case nolock)"
run_capture r backup "$P" CS_LOCK_FILE="$T_ROOT/no-such.lock"
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "잠금 파일"

echo "(7) 마운트여야 하는 데이터 폴더(.data-must-be-mount)"
t "표시 있음 + 데이터 폴더가 마운트 아님(볼륨 빠짐) → restore 거부"
P="$(mk_case mustmount)"
: >"$P/parent/.data-must-be-mount"
run_capture r restore "$P"
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "마운트"
unchanged "$P" && ok "그대로" || ng "바뀌었다"
t "표시 있음 + 데이터 폴더 없음 + --data-missing-ok → 거부"
rm -rf "$P/parent/data"
RARGS=(--data-missing-ok "$P/backup.tar.gz")
run_capture r restore "$P"
RARGS=()
expect_nonzero "$r_rc" "$r_out"
[[ ! -e "$P/parent/data" ]] && ok "만들지 않음" || ng "데이터 폴더를 만들었다"
t "표시 있음 + 마운트 아님 → backup 거부"
P="$(mk_case mustmountbk)"
: >"$P/parent/.data-must-be-mount"
run_capture r backup "$P"
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "마운트"
t "표시 있음 + 마운트 지점 → restore 진행(대조)"
P="$(mk_case mustmountok)"
: >"$P/parent/.data-must-be-mount"
run_capture r restore "$P" STUB_MOUNTPOINT="$P/parent/data"
expect_rc 0 "$r_rc" "$r_out"

finish
