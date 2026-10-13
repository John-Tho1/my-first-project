#!/usr/bin/env bash
# Content Studio — 데이터 폴더를 정지 상태 사본(backup-data.sh 결과 또는 restore-data 가 남긴 직전 사본)으로 되돌린다.
# (FIX2·FIX3-T21P2, 실제 서버에서 실행한 적 없음 — bash -n·로컬 stub 시험만)
# 사용(root, 서비스를 멈춘 뒤):
#   sudo bash <앱 루트>/deploy/scripts/restore-data.sh /srv/content-studio-backup/<사본>.tar.gz
#   데이터 폴더가 없는 상태(이전 복원이 되돌림까지 실패한 경우 등): ... restore-data.sh --data-missing-ok <사본>.tar.gz
#
# 순서(FIX3 — Codex review-FIX2-T21P2 P0 :31 · P0 :45 · P1 :26):
#  1. 사본 목록(tar -tv) 검사: 항목은 **일반 파일·폴더만**(링크·하드링크·장치·FIFO 거부), 경로는 모두 data/ 아래(절대 경로·`.`·`..`·빈 칸 거부),
#     최상위 data 는 폴더. 아무것도 바꾸기 전에 한다.
#  2. 지금 데이터의 직전 사본: 백업 폴더에 **배타적으로 만든 고유 이름**(mktemp, 0600) — 덮어쓰지 않고, 입력 사본과 같은 파일이면 중단.
#  3. 같은 파일 시스템의 새 임시 폴더(mktemp -d)에 풀기: 일반 폴더면 데이터 부모 폴더 안, 마운트 지점이면 마운트 안.
#     풀고 나서 다시 확인 — 일반 파일·폴더 밖의 항목 0, 최상위는 실제 폴더 data 하나. 소유자·권한은 이 확인 뒤에만(링크가 없으므로 따라가지 않음).
#  4. 교체:
#     - 일반 폴더: data → data.replaced-<시각>.<고유>/data 로 옮김 → 임시 data 를 제자리로. 둘째 단계가 실패하면 옮겨 둔 폴더를 되돌린다.
#     - 마운트 지점: 폴더(마운트)는 그대로, 안의 내용(임시 폴더 제외)을 지우고 임시 data 의 내용을 옮김. 실패하면 2 의 직전 사본으로 자동 복구.
#     - 데이터 폴더 없음(--data-missing-ok): 임시 data 를 제자리로.
#  5. 임시 폴더 정리(종료 시 trap).
set -euo pipefail
umask 077
CS_SCRIPT_TAG=restore-data
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

MISSING_OK=0
if [[ "${1:-}" == "--data-missing-ok" ]]; then
  MISSING_OK=1
  shift
fi
[[ $# -eq 1 ]] || die "인수는 [--data-missing-ok] <사본 파일(.tar.gz)> 입니다"
ARCHIVE="$1"
[[ -f "$ARCHIVE" && ! -L "$ARCHIVE" ]] || die "사본 파일이 없거나 일반 파일이 아닙니다: $ARCHIVE"
ARCHIVE_REAL="$(realpath -e -- "$ARCHIVE")" || die "사본 경로를 해석하지 못했습니다"
require_root
require_service_stopped content-studio.service 0

DATA_PARENT="$(cs_opt CS_DATA_PARENT /srv/content-studio)"
BACKUP_DIR="$(cs_opt CS_BACKUP_DIR /srv/content-studio-backup)"
SERVICE_OWNER="$(cs_opt CS_SERVICE_USER content-studio)"
SKIP_CHOWN="$(cs_opt CS_TEST_SKIP_CHOWN 0)"
[[ -d "$DATA_PARENT" && ! -L "$DATA_PARENT" ]] || die "데이터 부모 폴더가 없거나 심볼릭 링크입니다: $DATA_PARENT"
DATA="$DATA_PARENT/data"
[[ ! -L "$DATA" ]] || die "데이터 폴더가 심볼릭 링크입니다: $DATA — 실제 폴더(또는 마운트 지점)만 지원합니다"

# ---- 1. 사본 목록 검사(아무것도 바꾸기 전) ----
names="$(tar -tzf "$ARCHIVE")" || die "사본을 읽지 못했습니다: $ARCHIVE"
types="$(tar -tvzf "$ARCHIVE" | cut -c1)" || die "사본 목록(형식)을 읽지 못했습니다: $ARCHIVE"
[[ -n "$names" ]] || die "사본이 비어 있습니다"
mapfile -t NAMES <<<"$names"
mapfile -t TYPES <<<"$types"
[[ "${#NAMES[@]}" -eq "${#TYPES[@]}" ]] || die "사본 목록을 해석하지 못했습니다(항목 수 불일치)"
has_top=0
for i in "${!NAMES[@]}"; do
  ty="${TYPES[$i]}"
  [[ "$ty" == "-" || "$ty" == "d" ]] || die "사본에 일반 파일·폴더가 아닌 항목(형식 '$ty')이 있습니다 — 링크·하드링크·장치 등은 복원하지 않습니다"
  n="${NAMES[$i]%/}"
  [[ "$n" == data || "$n" == data/* ]] || die "사본에 data/ 밖 경로가 있습니다"
  IFS=/ read -r -a parts <<<"$n"
  for c in "${parts[@]}"; do
    [[ -n "$c" && "$c" != "." && "$c" != ".." ]] || die "사본에 허용하지 않는 경로(빈 칸·. 또는 ..)가 있습니다"
  done
  if [[ "$n" == data ]]; then
    [[ "$ty" == d ]] || die "사본 최상위 data 가 폴더가 아닙니다"
    has_top=1
  fi
done
[[ "$has_top" -eq 1 ]] || die "사본에 최상위 data 폴더 항목이 없습니다"

# ---- 방식 결정 ----
if [[ -e "$DATA" ]]; then
  [[ -d "$DATA" ]] || die "데이터 경로가 폴더가 아닙니다: $DATA"
  [[ "$MISSING_OK" -eq 0 ]] || die "데이터 폴더가 있습니다 — --data-missing-ok 없이 실행하세요"
  if is_mountpoint "$DATA"; then MODE=mountpoint; else MODE=directory; fi
else
  [[ "$MISSING_OK" -eq 1 ]] || die "데이터 폴더가 없습니다: $DATA — 이전 복원이 중단돼 폴더가 없는 상태라면 --data-missing-ok 로 다시 실행하세요(deploy/README_KO.md §8)"
  MODE=missing
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
make_backup_dir "$BACKUP_DIR"

# ---- 2. 직전 사본(고유 이름, 배타적 생성) ----
BEFORE=""
if [[ "$MODE" != missing ]]; then
  BEFORE="$(mktemp --suffix=.tar.gz "$BACKUP_DIR/data-before-restore-$STAMP.XXXXXX")" || die "직전 사본 파일을 만들지 못했습니다"
  [[ "$(realpath -e -- "$BEFORE")" != "$ARCHIVE_REAL" ]] || die "직전 사본 경로가 입력 사본과 같습니다 — 진행하지 않습니다"
  tar -C "$DATA_PARENT" --exclude='data/.restore-stage.*' --exclude='data/.restore-rollback.*' -czf "$BEFORE" data
  chmod 600 "$BEFORE"
  tar -tzf "$BEFORE" >/dev/null || die "직전 사본을 다시 읽지 못했습니다: $BEFORE"
fi

# ---- 3. 같은 파일 시스템의 임시 폴더에 풀고 다시 확인 ----
if [[ "$MODE" == mountpoint ]]; then STAGE_PARENT="$DATA"; else STAGE_PARENT="$DATA_PARENT"; fi
STAGE="$(mktemp -d "$STAGE_PARENT/.restore-stage.XXXXXX")" || die "임시 폴더를 만들지 못했습니다"
RB=""
cleanup() {
  [[ -n "${STAGE:-}" && -d "$STAGE" && ! -L "$STAGE" ]] && rm -rf -- "$STAGE"
  [[ -n "${RB:-}" && -d "$RB" && ! -L "$RB" ]] && rm -rf -- "$RB"
  return 0
}
trap cleanup EXIT

tar -C "$STAGE" --no-same-owner -xzf "$ARCHIVE" || die "사본을 임시 폴더에 풀지 못했습니다(데이터는 바꾸지 않았습니다)"
verify_tree() { # verify_tree <임시 폴더> — 최상위는 실제 폴더 data 하나, 그 아래 일반 파일·폴더만
  local root="$1" odd top
  [[ -d "$root/data" && ! -L "$root/data" ]] || return 1
  odd="$(find "$root" ! -type f ! -type d -print -quit)" || return 1
  [[ -z "$odd" ]] || return 1
  top="$(find "$root" -mindepth 1 -maxdepth 1 ! -name data -print -quit)" || return 1
  [[ -z "$top" ]] || return 1
}
verify_tree "$STAGE" || die "풀어 놓은 사본에 일반 파일·폴더가 아닌 항목이 있거나 구조가 다릅니다(데이터는 바꾸지 않았습니다)"
# 확인 뒤에만 소유자·권한(링크가 없으므로 따라가지 않는다; -h 는 혹시 모를 링크도 따라가지 않게)
if [[ "$SKIP_CHOWN" != 1 ]]; then
  chown -R -h "$SERVICE_OWNER:$SERVICE_OWNER" -- "$STAGE/data"
fi
chmod 700 -- "$STAGE/data"

# ---- 4. 교체 ----
# 마운트 지점 안 내용(임시 폴더 제외)을 지우고 src 의 내용을 옮긴다. 실패하면 1(호출자가 복구).
mount_fill() {
  local src="$1" item
  find "$DATA" -mindepth 1 -maxdepth 1 ! -name '.restore-stage.*' ! -name '.restore-rollback.*' -exec rm -rf -- {} + || return 1
  shopt -s nullglob dotglob
  for item in "$src"/*; do
    mv -- "$item" "$DATA/" || {
      shopt -u nullglob dotglob
      return 1
    }
  done
  shopt -u nullglob dotglob
  return 0
}

case "$MODE" in
  directory)
    REPL="$(mktemp -d "$DATA_PARENT/data.replaced-$STAMP.XXXXXX")" || die "보관 폴더를 만들지 못했습니다(데이터는 바꾸지 않았습니다)"
    mv -T -- "$DATA" "$REPL/data" || die "지금 데이터 폴더를 옮기지 못했습니다(데이터는 바꾸지 않았습니다)"
    if ! mv -T -- "$STAGE/data" "$DATA"; then
      if mv -T -- "$REPL/data" "$DATA"; then
        rmdir -- "$REPL" 2>/dev/null || true
        die "새 데이터로 바꾸지 못해 이전 데이터 폴더를 되돌렸습니다(직전 사본: $BEFORE)"
      fi
      die "새 데이터로 바꾸지 못했고 이전 폴더도 되돌리지 못했습니다 — 이전 데이터: $REPL/data, 직전 사본: $BEFORE. 원인을 고친 뒤 --data-missing-ok 로 직전 사본을 복원하세요"
    fi
    ;;
  mountpoint)
    if ! mount_fill "$STAGE/data"; then
      RB="$(mktemp -d "$DATA/.restore-rollback.XXXXXX")" || die "새 데이터로 바꾸지 못했고 복구용 임시 폴더도 만들지 못했습니다 — 직전 사본: $BEFORE"
      if tar -C "$RB" --no-same-owner -xzf "$BEFORE" && verify_tree "$RB" && mount_fill "$RB/data"; then
        die "새 데이터로 바꾸지 못해 직전 사본으로 복구했습니다: $BEFORE"
      fi
      die "새 데이터로 바꾸지 못했고 직전 사본 복구도 실패했습니다 — 직전 사본: $BEFORE"
    fi
    [[ ! -L "$DATA" ]] || die "데이터 폴더가 심볼릭 링크로 바뀌었습니다"
    if [[ "$SKIP_CHOWN" != 1 ]]; then chown -h "$SERVICE_OWNER:$SERVICE_OWNER" -- "$DATA"; fi
    chmod 700 -- "$DATA"
    ;;
  missing)
    mv -T -- "$STAGE/data" "$DATA" || die "사본을 제자리로 옮기지 못했습니다"
    ;;
esac
[[ -d "$DATA" && ! -L "$DATA" ]] || die "교체 뒤 데이터 폴더가 없거나 심볼릭 링크입니다"
echo "[restore-data] OK mode=$MODE before=${BEFORE:-없음}"
