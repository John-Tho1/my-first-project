#!/usr/bin/env bash
# Content Studio — 데이터 폴더 정지 상태 사본(T21-P2 · FIX1, 실제 서버에서 실행한 적 없음 — bash -n 만 확인).
# 사용(root, 서비스를 멈춘 뒤): sudo bash <앱 루트>/deploy/scripts/backup-data.sh <지금 배포된 SHA>
# PGlite 폴더는 서버가 멈춘 상태에서만 일관된 사본이 된다. 사본은 root 전용(700 폴더, 600 파일). 서버 밖으로 옮기는 일은 사용자 몫(T21-P4).
set -euo pipefail
umask 077

die() {
  echo "[backup-data] 실패: $*" >&2
  exit 1
}

[[ $# -eq 1 ]] || die "인수는 지금 배포된 커밋 SHA 하나입니다"
[[ "$1" =~ ^[0-9a-f]{7,40}$ ]] || die "SHA 형식이 아닙니다"
LABEL="$1"
[[ "$(id -u)" -eq 0 ]] || die "root 로 실행하세요"

DATA_PARENT="${CS_DATA_PARENT:-/srv/content-studio}"
BACKUP_DIR="${CS_BACKUP_DIR:-/srv/content-studio-backup}"
[[ -d "$DATA_PARENT/data" ]] || die "데이터 폴더가 없습니다: $DATA_PARENT/data"
if systemctl is-active --quiet content-studio; then
  die "content-studio 서비스가 실행 중입니다 — 먼저 멈추세요(정지 상태 사본만 일관성이 있음)"
fi

install -d -o root -g root -m 700 "$BACKUP_DIR"
OUT="$BACKUP_DIR/data-$(date -u +%Y%m%dT%H%M%SZ)-$LABEL.tar.gz"
[[ ! -e "$OUT" ]] || die "같은 이름의 사본이 이미 있습니다: $OUT"
tar -C "$DATA_PARENT" -czf "$OUT" data
chmod 600 "$OUT"
tar -tzf "$OUT" >/dev/null || die "사본을 다시 읽지 못했습니다: $OUT"
echo "[backup-data] OK $OUT"
