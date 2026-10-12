#!/usr/bin/env bash
# FIX2-T21P2(Codex review-FIX-T21P2 P1 README:132): 되돌리기 — 데이터 폴더가 마운트 지점이면 mv 하지 않고 내용만 바꾼다.
# 일반 폴더면 옆으로 옮긴(mv) 뒤 풀고, 어느 쪽이든 바꾸기 전 지금 내용을 사본(tar)으로 남긴다. 서비스가 멈췄음이 확인될 때만.
source "$(dirname "$0")/lib.sh"

SCRIPT="$SCRIPTS_DIR/restore-data.sh"
mk_case() { # mk_case <name> → 데이터 부모 폴더(현재 내용 old.txt)와 사본(new.txt) 준비
  local p="$T_ROOT/$1"
  mkdir -p "$p/parent/data/sub" "$p/src/data/sub" # 사본 폴더(bk)는 스크립트가 만든다
  echo old >"$p/parent/data/old.txt"
  echo new >"$p/src/data/new.txt"
  echo deep >"$p/src/data/sub/deep.txt"
  tar -C "$p/src" -czf "$p/backup.tar.gz" data
  echo "$p"
}
restore() { # restore <case-dir> [env...]
  local p="$1"
  shift
  stub_env CS_DATA_PARENT="$p/parent" CS_BACKUP_DIR="$p/bk" CS_TEST_SKIP_CHOWN=1 "$@" bash "$SCRIPT" "$p/backup.tar.gz"
}

echo "restore-data.sh"
t "스크립트가 있다"
if [[ -f "$SCRIPT" ]]; then ok; else ng "없음: $SCRIPT"; fi

t "일반 폴더: 옆으로 옮긴 뒤 사본을 푼다"
P="$(mk_case plain)"
run_capture r restore "$P"
expect_rc 0 "$r_rc" "$r_out"
expect_contains "$r_out" "mode=directory"
[[ -f "$P/parent/data/new.txt" && -f "$P/parent/data/sub/deep.txt" && ! -e "$P/parent/data/old.txt" ]] && ok "내용 교체" || ng "내용 교체 안 됨"
ls -d "$P/parent/data.replaced-"* >/dev/null 2>&1 && [[ -f "$(ls -d "$P/parent/data.replaced-"* | head -1)/old.txt" ]] && ok "이전 폴더 보존" || ng "이전 폴더 없음"
ls "$P/bk"/data-before-restore-*.tar.gz >/dev/null 2>&1 && ok "바꾸기 전 사본" || ng "바꾸기 전 사본 없음"

t "마운트 지점: mv 하지 않고(같은 폴더 유지) 내용만 바꾼다"
P="$(mk_case mounted)"
echo keep >"$P/parent/data/.inode-marker-dir-kept"
run_capture r restore "$P" STUB_MOUNTPOINT="$P/parent/data"
expect_rc 0 "$r_rc" "$r_out"
expect_contains "$r_out" "mode=mountpoint"
[[ -f "$P/parent/data/new.txt" && -f "$P/parent/data/sub/deep.txt" && ! -e "$P/parent/data/old.txt" && ! -e "$P/parent/data/.inode-marker-dir-kept" ]] && ok "내용 교체" || ng "내용 교체 안 됨"
if ls -d "$P/parent/data.replaced-"* >/dev/null 2>&1; then ng "마운트 지점을 옮겼다(mv)"; else ok "mv 없음"; fi
ls "$P/bk"/data-before-restore-*.tar.gz >/dev/null 2>&1 && ok "바꾸기 전 사본" || ng "바꾸기 전 사본 없음"

t "서비스 실행 중 → 중단(아무것도 바꾸지 않음)"
P="$(mk_case active)"
run_capture r restore "$P" STUB_ACTIVE=active
expect_nonzero "$r_rc" "$r_out"
[[ -f "$P/parent/data/old.txt" ]] && ok "그대로" || ng "바뀌었다"

t "systemctl 조회 실패 → 중단"
P="$(mk_case busfail)"
run_capture r restore "$P" STUB_SYSTEMCTL_FAIL=1
expect_nonzero "$r_rc" "$r_out"
[[ -f "$P/parent/data/old.txt" ]] && ok "그대로" || ng "바뀌었다"

t "mountpoint 명령 없음 → 중단(일반 폴더로 가정하지 않음)"
P="$(mk_case nomp)"
run_capture r restore "$P" CS_MOUNTPOINT_CMD="$T_ROOT/none/mountpoint"
expect_nonzero "$r_rc" "$r_out"
[[ -f "$P/parent/data/old.txt" ]] && ok "그대로" || ng "바뀌었다"

t "mountpoint 오류(종료 코드 1) → 중단"
P="$(mk_case mperr)"
run_capture r restore "$P" STUB_MOUNTPOINT_FAIL=1
expect_nonzero "$r_rc" "$r_out"
expect_contains "$r_out" "마운트 여부 확인에 실패"
[[ -f "$P/parent/data/old.txt" ]] && ok "그대로" || ng "바뀌었다"

t "backup-data: 정지 확인 뒤 사본(600)을 만들고 데이터 폴더는 그대로(마운트 지점이어도 옮기지 않음)"
P="$(mk_case backup)"
run_capture r stub_env CS_DATA_PARENT="$P/parent" CS_BACKUP_DIR="$P/bk" CS_TEST_SKIP_CHOWN=1 STUB_MOUNTPOINT="$P/parent/data" bash "$SCRIPTS_DIR/backup-data.sh" 0123456
expect_rc 0 "$r_rc" "$r_out"
ls "$P/bk"/data-*-0123456.tar.gz >/dev/null 2>&1 && ok "사본 있음" || ng "사본 없음"
[[ -f "$P/parent/data/old.txt" ]] && ok "데이터 그대로" || ng "데이터가 바뀌었다"

t "사본에 data/ 밖 경로(../)가 있으면 중단"
P="$(mk_case evil)"
mkdir -p "$P/evsrc/data"
echo x >"$P/evsrc/data/a.txt"
echo y >"$P/evsrc/escape.txt"
(cd "$P/evsrc/data" && tar -czf "$P/backup.tar.gz" a.txt ../escape.txt 2>/dev/null)
run_capture r restore "$P"
expect_nonzero "$r_rc" "$r_out"
[[ -f "$P/parent/data/old.txt" ]] && ok "그대로" || ng "바뀌었다"

t "사본 최상위가 data/ 가 아니면 중단"
P="$(mk_case wrongtop)"
mkdir -p "$P/w/other"
echo z >"$P/w/other/z.txt"
tar -C "$P/w" -czf "$P/backup.tar.gz" other
run_capture r restore "$P"
expect_nonzero "$r_rc" "$r_out"
[[ -f "$P/parent/data/old.txt" ]] && ok "그대로" || ng "바뀌었다"

finish
