#!/usr/bin/env bash
# Content Studio — 데이터 폴더를 정지 상태 사본(backup-data.sh 결과)으로 되돌린다(FIX2-T21P2, 실제 서버에서 실행한 적 없음 — bash -n·로컬 stub 시험만).
# 사용(root, 서비스를 멈춘 뒤): sudo bash <앱 루트>/deploy/scripts/restore-data.sh /srv/content-studio-backup/data-<시각>-<SHA>.tar.gz
#
# Codex review-FIX-T21P2 P1 README:132: 데이터 폴더가 볼륨 **마운트 지점**이면 `mv` 는 "Device or resource busy" 로 실패한다. 그래서
#   - 마운트 지점(mountpoint -q): 폴더는 그대로 두고 **내용만** 바꾼다(지금 내용을 사본으로 남김 → 내용 삭제 → 사본 풀기).
#   - 일반 폴더: 지금 폴더를 옆(data.replaced-<시각>)으로 옮긴 뒤 사본을 푼다(같은 파일 시스템 안의 이름 바꾸기).
# 어느 쪽이든 바꾸기 전 지금 내용을 BACKUP_DIR/data-before-restore-<시각>.tar.gz 로 남긴다. 공급자 볼륨 스냅숏 복구를 쓸 때는 이 스크립트 대신
# 공급자 절차를 따른다(서비스 정지 → 스냅숏 복구 → 시작, deploy/README_KO.md §8).
set -euo pipefail
umask 077
CS_SCRIPT_TAG=restore-data
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

[[ $# -eq 1 ]] || die "인수는 사본 파일(.tar.gz) 하나입니다"
ARCHIVE="$1"
[[ -f "$ARCHIVE" ]] || die "사본 파일이 없습니다: $ARCHIVE"
[[ "$(id -u)" -eq 0 ]] || die "root 로 실행하세요"
require_service_stopped content-studio.service 0

DATA_PARENT="${CS_DATA_PARENT:-/srv/content-studio}"
DATA="$DATA_PARENT/data"
BACKUP_DIR="${CS_BACKUP_DIR:-/srv/content-studio-backup}"
SERVICE_OWNER="${CS_SERVICE_USER:-content-studio}"
[[ -d "$DATA" ]] || die "데이터 폴더가 없습니다: $DATA"

# 사본 안의 경로는 모두 data/ 아래여야 한다(절대 경로·.. 거부) — 다른 곳에 풀리지 않게
entries="$(tar -tzf "$ARCHIVE")" || die "사본을 읽지 못했습니다: $ARCHIVE"
[[ -n "$entries" ]] || die "사본이 비어 있습니다"
while IFS= read -r e; do
  [[ "$e" == data || "$e" == data/* ]] || die "사본에 data/ 밖 경로가 있습니다"
  [[ "$e" != /* && "$e" != *"/../"* && "$e" != *"/.." && "$e" != "../"* ]] || die "사본에 허용하지 않는 경로(.. 또는 절대 경로)가 있습니다"
done <<<"$entries"

# 마운트 여부(명령이 없거나 오류면 중단 — 일반 폴더로 가정하지 않음)
if is_mountpoint "$DATA"; then MODE=mountpoint; else MODE=directory; fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ "${CS_TEST_SKIP_CHOWN:-0}" == 1 ]]; then
  mkdir -p "$BACKUP_DIR" && chmod 700 "$BACKUP_DIR" # 시험 전용(root 소유자를 만들 수 없는 환경 — Windows Git Bash 의 install -m 은 실패한다)
else
  install -d -o root -g root -m 700 "$BACKUP_DIR"
fi
BEFORE="$BACKUP_DIR/data-before-restore-$STAMP.tar.gz"
tar -C "$DATA_PARENT" -czf "$BEFORE" data
chmod 600 "$BEFORE"
tar -tzf "$BEFORE" >/dev/null || die "바꾸기 전 사본을 다시 읽지 못했습니다: $BEFORE"

if [[ "$MODE" == mountpoint ]]; then
  # 마운트 지점은 옮기지 않는다 — 안의 내용만 지우고 사본을 같은 자리에 푼다
  find "$DATA" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  tar -C "$DATA_PARENT" -xzf "$ARCHIVE"
else
  REPLACED="$DATA_PARENT/data.replaced-$STAMP"
  [[ ! -e "$REPLACED" ]] || die "이미 있습니다: $REPLACED"
  mv -- "$DATA" "$REPLACED"
  tar -C "$DATA_PARENT" -xzf "$ARCHIVE"
fi
[[ -d "$DATA" ]] || die "풀고 난 뒤 데이터 폴더가 없습니다"
if [[ "${CS_TEST_SKIP_CHOWN:-0}" != 1 ]]; then
  chown -R "$SERVICE_OWNER:$SERVICE_OWNER" "$DATA"
fi
chmod 700 "$DATA"
echo "[restore-data] OK mode=$MODE before=$BEFORE"
