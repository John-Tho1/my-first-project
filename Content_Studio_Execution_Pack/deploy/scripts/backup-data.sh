#!/usr/bin/env bash
# Content Studio — 데이터 폴더 정지 상태 사본(T21-P2 · FIX1~4, 실제 서버에서 실행한 적 없음 — bash -n·로컬 stub 시험만).
# 사용(root, 서비스를 멈춘 뒤): sudo bash <앱 루트>/deploy/scripts/backup-data.sh <지금 배포된 SHA>
# PGlite 폴더는 서버가 멈춘 상태에서만 일관된 사본이 된다. 사본은 root 전용(700 폴더, 600 파일). 서버 밖으로 옮기는 일은 사용자 몫(T21-P4).
# 이 스크립트는 데이터 폴더를 옮기거나(mv) 지우지 않는다.
# FIX4·5: restore-data.sh 가 받아들이는 형식만 만든다 — 데이터 안에 링크·하드링크·특수 파일·하위 마운트·허용하지 않는 이름이 있으면 사본을 만들기 전에 실패,
# 쓴 사본도 restore-data 와 같은 사본 검사(lib/common.sh validate_archive)를 통과해야 성공.
set -euo pipefail
umask 077
CS_SCRIPT_TAG=backup-data
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

[[ $# -eq 1 ]] || die "인수는 지금 배포된 커밋 SHA 하나입니다"
[[ "$1" =~ ^[0-9a-f]{7,40}$ ]] || die "SHA 형식이 아닙니다"
LABEL="$1"
require_root
cs_lock
require_service_stopped content-studio.service 0

DATA_PARENT="$(cs_path CS_DATA_PARENT /srv/content-studio)" || exit 1
BACKUP_DIR="$(cs_path CS_BACKUP_DIR /srv/content-studio-backup)" || exit 1
DATA="$DATA_PARENT/data"
[[ ! -L "$DATA" ]] || die "데이터 폴더가 심볼릭 링크입니다: $DATA — 실제 폴더(또는 마운트 지점)만 지원합니다"
[[ -d "$DATA" ]] || die "데이터 폴더가 없습니다: $DATA"
refuse_if_must_be_mount_but_not "$DATA_PARENT" "$DATA"
refuse_submounts "$DATA"
validate_tree "$DATA" # FIX5: restore-data 와 같은 검사(특수 항목·하드링크·이름 규칙)

make_backup_dir "$BACKUP_DIR"
OUT="$(mktemp --suffix=.tar.gz "$BACKUP_DIR/data-$(date -u +%Y%m%dT%H%M%SZ)-$LABEL.XXXXXX")" || die "사본 파일을 만들지 못했습니다"
if ! tar -C "$DATA_PARENT" --exclude='data/.restore-stage.*' --exclude='data/.restore-rollback.*' -czf "$OUT" data; then
  rm -f -- "$OUT"
  die "사본을 만들지 못했습니다"
fi
# FIX5-T21P2(Codex P1 :31): 쓴 사본이 restore-data 의 사본 검사(같은 함수)를 통과해야 성공 — 아니면 지우고 실패
if ! (validate_archive "$OUT"); then
  rm -f -- "$OUT"
  die "만든 사본이 복원 검사를 통과하지 못해 지웠습니다 — 백업 실패"
fi
chmod 600 -- "$OUT"
echo "[backup-data] OK $OUT"
