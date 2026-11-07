#!/usr/bin/env bash
# Content Studio — 데이터 폴더를 정지 상태 사본(backup-data.sh 결과 또는 restore-data 가 남긴 직전 사본)으로 되돌린다.
# (FIX2~4-T21P2, 실제 서버에서 실행한 적 없음 — bash -n·로컬 stub 시험만)
# 사용(root, 서비스를 멈춘 뒤):
#   sudo bash <앱 루트>/deploy/scripts/restore-data.sh /srv/content-studio-backup/<사본>.tar.gz
#   데이터 폴더가 없는 상태(이전 복원이 되돌림까지 실패한 경우 등): ... restore-data.sh --data-missing-ok <사본>.tar.gz
#
# 원칙(FIX4): 낯선 것은 처리하지 않고 **바꾸기 전에 거부**한다.
#  0. 잠금(flock)·root·서비스 정지·데이터 폴더(부모 포함)가 링크 아님·하위 마운트 없음·.data-must-be-mount 이면 지금 마운트.
#  1. 사본 목록: 항목 형식은 일반 파일·폴더만, 이름은 data/ 아래·UTF-8·제어 문자/역슬래시 없음(줄바꿈 이름은 tar 가 \n 으로 표시 → 거부).
#  2. 지금 데이터의 직전 사본(mktemp 고유 이름, 0600 — 덮어쓰지 않음, 입력과 같은 파일이면 중단).
#  3. 같은 파일 시스템의 새 임시 폴더에 --no-same-owner --no-same-permissions --no-overwrite-dir 로 풀고, find 로 다시 확인(권위 있는 확인):
#     최상위는 실제 폴더 data 하나, 일반 파일·폴더만, 하드링크 없음. 그 뒤 서비스 사용자 소유·폴더 700·파일 600 적용·확인.
#  4. 교체 — 일반 폴더: data 를 data.replaced-*/data 로 옮기고 임시 data 를 제자리로(실패하면 이전 폴더를 되돌리고 소유·권한 재적용).
#     마운트 지점: 마운트는 그대로, 내용만 교체(실패하면 직전 사본을 같은 방식으로 풀고·확인하고·소유 적용한 뒤 복구). 폴더 없음: --data-missing-ok 로만.
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
cs_lock
require_service_stopped content-studio.service 0

DATA_PARENT="$(cs_path CS_DATA_PARENT /srv/content-studio)" || exit 1
BACKUP_DIR="$(cs_path CS_BACKUP_DIR /srv/content-studio-backup)" || exit 1
OWNER="$(cs_opt CS_SERVICE_USER content-studio)"
[[ -d "$DATA_PARENT" && ! -L "$DATA_PARENT" ]] || die "데이터 부모 폴더가 없거나 심볼릭 링크입니다: $DATA_PARENT"
DATA="$DATA_PARENT/data"
[[ ! -L "$DATA" ]] || die "데이터 폴더가 심볼릭 링크입니다: $DATA — 실제 폴더(또는 마운트 지점)만 지원합니다"
refuse_if_must_be_mount_but_not "$DATA_PARENT" "$DATA"

# ---- 1. 사본 목록 검사(아무것도 바꾸기 전, lib/common.sh validate_archive — backup-data 와 같은 검사) ----
validate_archive "$ARCHIVE"

# ---- 방식 결정·하위 마운트 ----
if [[ -e "$DATA" ]]; then
  [[ -d "$DATA" ]] || die "데이터 경로가 폴더가 아닙니다: $DATA"
  [[ "$MISSING_OK" -eq 0 ]] || die "데이터 폴더가 있습니다 — --data-missing-ok 없이 실행하세요"
  refuse_submounts "$DATA"
  # FIX5-T21P2(Codex P0 :89): 지금 데이터도 같은 검사(특수 항목·하드링크·이름 규칙)를 통과해야 한다 — 통과하지 못하면 직전 사본으로
  # 되돌릴 수 없거나(복구가 그 사본을 거부) 소유자 재적용이 하드링크로 밖의 파일을 바꿀 수 있으므로, 아무것도 바꾸기 전에 거부.
  validate_tree "$DATA"
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
  chmod 600 -- "$BEFORE"
  # FIX5-T21P2(Codex P0 :89): 직전 사본도 들어오는 사본과 **같은 검사**를 통과해야 교체를 시작한다(자동 복구가 그 사본을 쓸 수 있게).
  if ! (validate_archive "$BEFORE"); then
    rm -f -- "$BEFORE"
    die "직전 사본이 사본 검사를 통과하지 못했습니다 — 되돌릴 수 없으므로 아무것도 바꾸지 않았습니다"
  fi
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

# unpack_verified <사본> <임시 폴더> — 풀기 + 권위 있는 확인(최상위 실제 폴더 data 하나, 일반 파일·폴더만, 하드링크 없음) + 소유·권한. 실패하면 1.
unpack_verified() {
  local archive="$1" root="$2" top
  tar -C "$root" --no-same-owner --no-same-permissions --no-overwrite-dir -xzf "$archive" || return 1
  [[ -d "$root/data" && ! -L "$root/data" ]] || return 1
  top="$(find "$root" -mindepth 1 -maxdepth 1 ! -name data -print -quit)" || return 1
  [[ -z "$top" ]] || return 1
  (validate_tree "$root/data") || return 1
  apply_owner_perms "$root/data" "$OWNER"
}
unpack_verified "$ARCHIVE" "$STAGE" || die "사본을 풀어 확인하지 못했습니다(특수 항목·구조·소유자 적용 실패) — 데이터는 바꾸지 않았습니다"

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
  chmod 700 -- "$DATA" || return 1
  apply_owner_perms "$DATA" "$OWNER"
}

case "$MODE" in
  directory)
    REPL="$(mktemp -d "$DATA_PARENT/data.replaced-$STAMP.XXXXXX")" || die "보관 폴더를 만들지 못했습니다(데이터는 바꾸지 않았습니다)"
    mv -T -- "$DATA" "$REPL/data" || die "지금 데이터 폴더를 옮기지 못했습니다(데이터는 바꾸지 않았습니다)"
    if ! mv -T -- "$STAGE/data" "$DATA"; then
      mv -T -- "$REPL/data" "$DATA" || die "새 데이터로 바꾸지 못했고 이전 폴더도 되돌리지 못했습니다 — 이전 데이터: $REPL/data, 직전 사본: $BEFORE. 원인을 고친 뒤 --data-missing-ok 로 직전 사본을 복원하세요"
      rmdir -- "$REPL" 2>/dev/null || true
      apply_owner_perms "$DATA" "$OWNER" || die "이전 데이터 폴더는 되돌렸지만 소유자·권한을 다시 적용하지 못했습니다: $DATA — 직접 확인하세요"
      die "새 데이터로 바꾸지 못해 이전 데이터 폴더를 되돌렸습니다(소유자·권한 재적용·확인 완료, 직전 사본: $BEFORE)"
    fi
    ;;
  mountpoint)
    if ! mount_fill "$STAGE/data"; then
      RB="$(mktemp -d "$DATA/.restore-rollback.XXXXXX")" || die "새 데이터로 바꾸지 못했고 복구용 임시 폴더도 만들지 못했습니다 — 직전 사본: $BEFORE"
      if unpack_verified "$BEFORE" "$RB" && mount_fill "$RB/data"; then
        die "새 데이터로 바꾸지 못해 직전 사본으로 복구했습니다(소유자·권한 재적용·확인 완료): $BEFORE"
      fi
      die "새 데이터로 바꾸지 못했고 직전 사본 복구(또는 소유자·권한 재적용)도 실패했습니다 — 직전 사본: $BEFORE"
    fi
    ;;
  missing)
    mv -T -- "$STAGE/data" "$DATA" || die "사본을 제자리로 옮기지 못했습니다"
    ;;
esac
[[ -d "$DATA" && ! -L "$DATA" ]] || die "교체 뒤 데이터 폴더가 없거나 심볼릭 링크입니다"
echo "[restore-data] OK mode=$MODE before=${BEFORE:-없음}"
