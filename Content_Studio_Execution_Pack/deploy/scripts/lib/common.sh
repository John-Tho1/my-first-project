#!/usr/bin/env bash
# deploy/scripts 공용 함수(FIX2-T21P2). 각 스크립트가 source 한다. 실제 서버에서 실행한 적 없음(로컬 stub 시험만 — deploy/scripts/tests).
# 시험용 바꿔치기(운영에서는 설정하지 않는다): CS_SYSTEMCTL(systemctl 경로), CS_MOUNTPOINT_CMD(mountpoint 경로).

# die <메시지> — 호출한 스크립트 이름(CS_SCRIPT_TAG)을 붙여 stderr 에 쓰고 종료 코드 1.
die() {
  echo "[${CS_SCRIPT_TAG:-deploy}] 실패: $*" >&2
  exit 1
}

# require_service_stopped <unit> <first_install: 0|1>
# FIX2-T21P2(Codex review-FIX-T21P2 P1 build-release.sh:25 · backup-data.sh:21):
#   systemd 가 **조회에 성공하고** 상태가 inactive 또는 failed 라고 답할 때만 돌아온다. 그 밖(조회 실패·systemctl 없음·active·activating·
#   deactivating·reloading·빈 값·알 수 없는 값)은 모두 중단. `if` 조건 안의 실패는 set -e 가 잡지 않으므로 종료 코드를 직접 본다.
#   unit 이 등록되지 않았으면(LoadState=not-found) first_install=1 일 때만, 그리고 `list-unit-files` 가 **성공**했고 목록에 그 unit 이
#   **없음**이 확인될 때만 진행한다. first_install=1 인데 이미 등록돼 있으면 중단(실수 방지).
require_service_stopped() {
  local unit="$1" first_install="$2"
  local sc="${CS_SYSTEMCTL:-systemctl}"
  local load active list
  command -v "$sc" >/dev/null 2>&1 || die "systemctl 을 찾을 수 없어 서비스 상태를 확인하지 못했습니다 — 진행하지 않습니다"
  if ! load="$("$sc" show -p LoadState --value "$unit" 2>/dev/null)"; then
    die "서비스 상태(LoadState) 조회에 실패했습니다 — 진행하지 않습니다"
  fi
  case "$load" in
    loaded)
      [[ "$first_install" == 0 ]] || die "$unit 이(가) 이미 등록돼 있습니다 — --first-install 없이 실행하세요"
      ;;
    not-found)
      [[ "$first_install" == 1 ]] || die "$unit 이(가) 등록되지 않았습니다 — 처음 설치라면 --first-install 로 실행하세요"
      if ! list="$("$sc" list-unit-files --no-legend --no-pager --type=service 2>/dev/null)"; then
        die "unit 파일 목록 조회에 실패했습니다 — 미등록을 확인하지 못해 진행하지 않습니다"
      fi
      if printf '%s\n' "$list" | awk '{print $1}' | grep -Fqx -- "$unit"; then
        die "$unit 의 unit 파일이 있습니다 — 처음 설치가 아닙니다"
      fi
      echo "[${CS_SCRIPT_TAG:-deploy}] 처음 설치: $unit 미등록 확인" >&2
      return 0
      ;;
    *)
      die "$unit 의 LoadState 가 '${load}' 입니다 — 진행하지 않습니다"
      ;;
  esac
  if ! active="$("$sc" show -p ActiveState --value "$unit" 2>/dev/null)"; then
    die "서비스 상태(ActiveState) 조회에 실패했습니다 — 진행하지 않습니다"
  fi
  case "$active" in
    inactive | failed) return 0 ;;
    *) die "$unit 상태가 '${active}' 입니다 — 멈춘 것이 확인될 때만 진행합니다(sudo systemctl stop $unit)" ;;
  esac
}

# is_mountpoint <dir> — 0 = 마운트 지점, 1 = 아님. util-linux mountpoint 의 종료 코드: 0 = 마운트 지점, 32 = 아님, 그 밖 = 오류.
# 명령이 없거나 오류면 중단한다(일반 폴더로 가정하지 않는다).
is_mountpoint() {
  local mp="${CS_MOUNTPOINT_CMD:-mountpoint}" rc=0
  command -v "$mp" >/dev/null 2>&1 || die "mountpoint 명령을 찾을 수 없습니다(util-linux) — 마운트 여부를 확인하지 못해 진행하지 않습니다"
  "$mp" -q -- "$1" || rc=$?
  case "$rc" in
    0) return 0 ;;
    32) return 1 ;;
    *) die "마운트 여부 확인에 실패했습니다(mountpoint 종료 코드 $rc) — 진행하지 않습니다" ;;
  esac
}
