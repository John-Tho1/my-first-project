#!/usr/bin/env bash
# Content Studio — 데이터 폴더 정지 상태 사본(T21-P2 · FIX1~3, 실제 서버에서 실행한 적 없음 — bash -n·로컬 stub 시험만).
# 사용(root, 서비스를 멈춘 뒤): sudo bash <앱 루트>/deploy/scripts/backup-data.sh <지금 배포된 SHA>
# PGlite 폴더는 서버가 멈춘 상태에서만 일관된 사본이 된다. 사본은 root 전용(700 폴더, 600 파일). 서버 밖으로 옮기는 일은 사용자 몫(T21-P4).
# 이 스크립트는 데이터 폴더를 옮기거나(mv) 지우지 않는다 — 마운트 지점이어도 그대로 읽기만 한다.
set -euo pipefail
umask 077
CS_SCRIPT_TAG=backup-data
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

[[ $# -eq 1 ]] || die "인수는 지금 배포된 커밋 SHA 하나입니다"
[[ "$1" =~ ^[0-9a-f]{7,40}$ ]] || die "SHA 형식이 아닙니다"
LABEL="$1"
require_root
# FIX2-T21P2: 멈춤이 확인될 때만(조회 실패·미등록·activating 등은 중단). 백업에는 최초 설치 예외가 없다.
require_service_stopped content-studio.service 0

DATA_PARENT="$(cs_opt CS_DATA_PARENT /srv/content-studio)"
BACKUP_DIR="$(cs_opt CS_BACKUP_DIR /srv/content-studio-backup)"
# FIX3-T21P2(Codex 질문 3): 데이터 폴더가 심볼릭 링크면 tar 가 링크만 담는다 — 거부
[[ ! -L "$DATA_PARENT/data" ]] || die "데이터 폴더가 심볼릭 링크입니다: $DATA_PARENT/data — 실제 폴더(또는 마운트 지점)만 지원합니다"
[[ -d "$DATA_PARENT/data" ]] || die "데이터 폴더가 없습니다: $DATA_PARENT/data"

make_backup_dir "$BACKUP_DIR"
# FIX3-T21P2: 고유 이름을 배타적으로 만든다(mktemp — 같은 초에 두 번 돌려도 덮어쓰지 않음, 0600)
OUT="$(mktemp --suffix=.tar.gz "$BACKUP_DIR/data-$(date -u +%Y%m%dT%H%M%SZ)-$LABEL.XXXXXX")" || die "사본 파일을 만들지 못했습니다"
tar -C "$DATA_PARENT" --exclude='data/.restore-stage.*' --exclude='data/.restore-rollback.*' -czf "$OUT" data
chmod 600 "$OUT"
tar -tzf "$OUT" >/dev/null || die "사본을 다시 읽지 못했습니다: $OUT"
echo "[backup-data] OK $OUT"
