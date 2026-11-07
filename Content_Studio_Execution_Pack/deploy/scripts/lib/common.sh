#!/usr/bin/env bash
# deploy/scripts 공용 함수(FIX2·FIX3-T21P2). 각 스크립트가 source 한다. 실제 서버에서 실행한 적 없음(로컬 stub 시험만 — deploy/scripts/tests).
#
# FIX3-T21P2(Codex review-FIX2-T21P2 질문 5): 시험용 바꿔치기 변수(CS_SYSTEMCTL·CS_MOUNTPOINT_CMD·CS_DATA_PARENT·CS_BACKUP_DIR·CS_DATA_ROOT·
# CS_ENV_FILE·CS_ENV_OWNER_MODE·CS_REPO_ROOT·CS_SERVICE_USER·CS_LOCK_FILE·CS_MOUNTINFO)는 **시험 표식**(CS_DEPLOY_TEST_HARNESS=1 — tests/lib.sh 가 설정)이
# 있고 실제 root 가 아닐 때($EUID ≠ 0 — PATH 의 가짜 id 로 속일 수 없음)만 적용된다. 운영 실행(표식 없음, 또는 root)에서는 무시하고 운영 기본값을 쓴다.

# die <메시지> — 호출한 스크립트 이름(CS_SCRIPT_TAG)을 붙여 stderr 에 쓰고 종료 코드 1.
die() {
  echo "[${CS_SCRIPT_TAG:-deploy}] 실패: $*" >&2
  exit 1
}

# 시험 실행인가(표식 정확히 1 + 실제 root 아님)
cs_test_mode() {
  [[ "${CS_DEPLOY_TEST_HARNESS:-}" == 1 && "$EUID" -ne 0 ]]
}

# cs_opt <변수 이름> <운영 기본값> — 시험 실행이고 변수가 설정돼 있으면 그 값, 아니면 운영 기본값.
cs_opt() {
  if cs_test_mode && [[ -n "${!1+set}" ]]; then
    printf '%s' "${!1}"
  else
    printf '%s' "$2"
  fi
}

# root 요구(시험 실행에서는 실제 root 가 아니므로 건너뜀 — root 전용 명령(chown·install -o)은 시험 실행기의 PATH 가짜 명령이 받는다)
require_root() {
  cs_test_mode && return 0
  [[ "$EUID" -eq 0 ]] || die "root 로 실행하세요"
}

# require_service_stopped <unit> <first_install: 0|1>
# FIX2-T21P2(Codex review-FIX-T21P2 P1 build-release.sh:25 · backup-data.sh:21):
#   systemd 가 **조회에 성공하고** 상태가 inactive 또는 failed 라고 답할 때만 돌아온다. 그 밖(조회 실패·systemctl 없음·active·activating·
#   deactivating·reloading·빈 값·알 수 없는 값)은 모두 중단. `if` 조건 안의 실패는 set -e 가 잡지 않으므로 종료 코드를 직접 본다.
#   unit 이 등록되지 않았으면(LoadState=not-found) first_install=1 일 때만, 그리고 `list-unit-files` 가 **성공**했고 목록에 그 unit 이
#   **없음**이 확인될 때만 진행한다. first_install=1 인데 이미 등록돼 있으면 중단(실수 방지).
# FIX3-T21P2(Codex review-FIX2-T21P2 P2 :34): 목록은 명령 출력 전체를 먼저 받고(그 명령의 종료 코드 확인) bash 안에서 찾는다 —
#   파이프(`| grep -q`)의 조기 종료·SIGPIPE 가 pipefail 에서 "없음"으로 바뀌던 문제 제거. "조회 실패"(중단)와 "없음"(진행)을 구분한다.
require_service_stopped() {
  local unit="$1" first_install="$2"
  local sc
  sc="$(cs_opt CS_SYSTEMCTL systemctl)"
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
      # 각 줄의 첫 칸이 unit 이름(뒤는 공백·탭). 줄 맨 앞에서 정확히 일치하는지 bash 패턴으로 본다(파이프 없음).
      if [[ $'\n'"$list"$'\n' == *$'\n'"$unit"[[:space:]]* ]]; then
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
  local mp rc=0
  mp="$(cs_opt CS_MOUNTPOINT_CMD mountpoint)"
  command -v "$mp" >/dev/null 2>&1 || die "mountpoint 명령을 찾을 수 없습니다(util-linux) — 마운트 여부를 확인하지 못해 진행하지 않습니다"
  "$mp" -q -- "$1" || rc=$?
  case "$rc" in
    0) return 0 ;;
    32) return 1 ;;
    *) die "마운트 여부 확인에 실패했습니다(mountpoint 종료 코드 $rc) — 진행하지 않습니다" ;;
  esac
}

# ---- FIX4-T21P2: 낯선 것은 처리하지 않고 바꾸기 전에 거부(fail closed) ----

# cs_path <변수 이름> <운영 기본값> — 경로용 cs_opt. 운영 실행에서는 기본값. 시험 실행에서는(FIX5-T21P2 Codex P1 common.sh:101)
#  - 변수가 반드시 주어져야 하고, 절대 경로이며, `..` 칸이 없어야 하고,
#  - 정규 경로(realpath -m — 기존 심볼릭 링크를 모두 해석)가 시험 임시 루트(CS_HARNESS_ROOT — tests/lib.sh 가 만든 정규 경로, 시스템 임시 폴더 아래)
#    **아래**여야 한다. 그래서 `/tmp/../srv/…`·상대 경로·중간 링크로 밖(운영 경로 포함)을 가리키는 경로는 모두 거부된다.
#  돌려주는 값은 검사를 통과한 **원래 값**이다 — 정규 경로를 돌려주면 데이터 루트·데이터 폴더 자체가 링크인지(이후 단계의 -L 거부)를 가리게 된다.
cs_path() {
  if ! cs_test_mode; then
    printf '%s' "$2"
    return 0
  fi
  local v="${!1:-}" root tmp canon
  [[ -n "$v" ]] || die "시험 실행에서는 $1 을(를) 시험 경로로 주어야 합니다(운영 기본값으로 떨어지지 않음)"
  [[ "$v" == /* ]] || die "시험 실행에서 $1 은(는) 절대 경로여야 합니다"
  [[ "/$v/" != */../* ]] || die "시험 실행에서 $1 에 .. 가 있습니다"
  [[ -n "${CS_HARNESS_ROOT:-}" ]] || die "시험 실행인데 CS_HARNESS_ROOT(시험 임시 루트)가 없습니다 — $1 을(를) 확인할 수 없어 진행하지 않습니다"
  root="$(realpath -e -- "$CS_HARNESS_ROOT")" || die "CS_HARNESS_ROOT 를 해석하지 못했습니다"
  tmp="$(realpath -e -- "${TMPDIR:-/tmp}")" || die "시스템 임시 폴더를 해석하지 못했습니다"
  [[ "$root" == "$tmp"/* ]] || die "CS_HARNESS_ROOT 가 시스템 임시 폴더 아래가 아닙니다"
  canon="$(realpath -m -- "$v")" || die "$1 을(를) 해석하지 못했습니다"
  [[ "$canon" == "$root"/* ]] || die "시험 실행에서 $1 의 실제 위치가 시험 임시 루트 밖입니다(운영 경로 금지) — 진행하지 않습니다"
  printf '%s' "$v"
}

# make_backup_dir <dir> — root 700 폴더
make_backup_dir() {
  install -d -o root -g root -m 700 -- "$1" || die "사본 폴더를 만들지 못했습니다: $1"
  [[ -d "$1" && ! -L "$1" ]] || die "사본 폴더가 폴더가 아니거나 심볼릭 링크입니다: $1"
}

# cs_lock — 배포 스크립트끼리 동시 실행 금지(flock, 기다리지 않음). 잠금 파일은 README §2 에서 미리 만든다(서비스 사용자·root 모두 읽기로 연다).
cs_lock() {
  local lock
  lock="$(cs_path CS_LOCK_FILE /srv/content-studio/deploy.lock)" || exit 1
  command -v flock >/dev/null 2>&1 || die "flock 명령이 없습니다(util-linux) — 동시 실행을 막을 수 없어 진행하지 않습니다"
  [[ -f "$lock" && ! -L "$lock" ]] || die "잠금 파일이 없습니다: $lock (deploy/README_KO.md §2 에서 만든다)"
  exec 9<"$lock" || die "잠금 파일을 열지 못했습니다: $lock"
  flock -n 9 || die "다른 배포 스크립트가 실행 중입니다(잠금 $lock) — 진행하지 않습니다"
}

# refuse_submounts <dir> — <dir> 아래(엄격히 하위)에 마운트가 하나라도 있으면 거부(같은 파일 시스템 bind 포함). 마운트 정보를 못 읽으면 거부.
# /proc/self/mountinfo 의 다섯째 칸(마운트 지점, 공백 등은 \040 처럼 이스케이프)을 본다. 데이터 경로에 공백·역슬래시가 있으면 비교가 어긋나므로 거부.
refuse_submounts() {
  local dir="$1" real info content mp
  real="$(realpath -e -- "$dir")" || die "경로를 해석하지 못했습니다: $dir"
  [[ "$real" != *[[:space:]\\]* ]] || die "데이터 경로에 공백·역슬래시가 있으면 지원하지 않습니다: $real"
  info="$(cs_path CS_MOUNTINFO /proc/self/mountinfo)" || exit 1
  content="$(cat -- "$info" 2>/dev/null)" || die "마운트 정보를 읽지 못했습니다($info) — 진행하지 않습니다"
  [[ -n "$content" ]] || die "마운트 정보가 비어 있습니다($info) — 진행하지 않습니다"
  while read -r _ _ _ _ mp _; do
    [[ "$mp" != "$real"/* ]] || die "데이터 폴더 아래에 하위 마운트가 있습니다($mp) — 지원하지 않는 구성이라 진행하지 않습니다"
  done <<<"$content"
}

# refuse_if_must_be_mount_but_not <데이터 부모> <데이터 폴더> — <부모>/.data-must-be-mount 표시가 있으면 데이터 폴더가 지금 마운트 지점이어야 한다
# (볼륨이 빠진 채 빈 폴더를 백업·복원하지 않게). 폴더가 없으면 마운트가 아니므로 거부.
refuse_if_must_be_mount_but_not() {
  [[ -e "$1/.data-must-be-mount" ]] || return 0
  [[ -d "$2" ]] || die "데이터 폴더는 마운트여야 하는데(.data-must-be-mount) 폴더가 없습니다: $2 — 볼륨을 먼저 마운트하세요"
  is_mountpoint "$2" || die "데이터 폴더는 마운트여야 하는데(.data-must-be-mount) 지금 마운트가 아닙니다: $2 — 볼륨을 먼저 마운트하세요"
}

# validate_archive <사본.tar.gz> — 들어오는 사본·직전 사본·새로 쓴 백업 사본이 모두 통과해야 하는 검사(FIX3~5). 실패하면 die.
#  항목 이름: 역슬래시(tar 는 줄바꿈·제어 문자를 역슬래시 이스케이프로 보여 준다)·제어 문자·UTF-8 이 아닌 바이트 거부. 이런 이름이 없으면 두 목록이
#  항목당 정확히 한 줄이라 줄 번호로 맞춰 볼 수 있다. 항목 형식은 일반 파일·폴더만, 경로는 data/ 아래(빈 칸·.·.. 거부), 최상위 data 는 폴더.
validate_archive() {
  local archive="$1" names types i ty n c has_top
  local -a NAMES TYPES parts
  names="$(tar --quoting-style=escape -tzf "$archive")" || die "사본을 읽지 못했습니다: $archive"
  types="$(tar --quoting-style=escape -tvzf "$archive" | cut -c1)" || die "사본 목록(형식)을 읽지 못했습니다: $archive"
  [[ -n "$names" ]] || die "사본이 비어 있습니다"
  # 이름 제한: 역슬래시(줄바꿈·제어 문자는 tar 가 \n·\ooo 로 이스케이프한다)·제어 문자·UTF-8 이 아닌 바이트가 있으면 거부.
  # 이런 이름이 없으면 두 목록 모두 항목당 정확히 한 줄이라 줄 번호로 맞춰 볼 수 있다.
  [[ "$names" != *\\* ]] || die "사본 항목 이름에 줄바꿈·제어 문자·역슬래시가 있습니다 — 지원하지 않습니다"
  if LC_ALL=C grep -q "[[:cntrl:]]" <<<"$names"; then die "사본 항목 이름에 제어 문자가 있습니다 — 지원하지 않습니다"; fi
  iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1 <<<"$names" || die "사본 항목 이름이 UTF-8 이 아닙니다 — 지원하지 않습니다"
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
}

# refuse_special_tree <dir> — 일반 파일·폴더 밖의 항목(심볼릭 링크·소켓·FIFO·장치)이나 하드링크(링크 수 > 1)인 파일이 있으면 거부.
# backup-data(만들기 전)와 restore-data(풀고 난 뒤)가 같은 기준을 쓴다 — 백업이 만든 사본은 복원이 받아들인다.
refuse_special_tree() {
  local odd
  odd="$(find "$1" \( ! -type f ! -type d \) -print -quit)" || die "폴더를 검사하지 못했습니다: $1"
  [[ -z "$odd" ]] || die "일반 파일·폴더가 아닌 항목(심볼릭 링크·소켓·FIFO·장치)이 있습니다 — 지원하지 않습니다"
  odd="$(find "$1" -type f -links +1 -print -quit)" || die "폴더를 검사하지 못했습니다: $1"
  [[ -z "$odd" ]] || die "하드링크(링크 수 > 1)인 파일이 있습니다 — 지원하지 않습니다"
}

# validate_tree <dir> — 폴더 쪽 검사(backup 은 만들기 전, restore 는 지금 데이터와 풀고 난 임시 폴더에): 특수 항목·하드링크(refuse_special_tree) +
# validate_archive 와 같은 이름 규칙(역슬래시·제어 문자(줄바꿈 포함)·UTF-8 이 아닌 바이트 거부). 실패하면 die. (FIX5-T21P2 Codex P0 :89 · P1 :31)
validate_tree() {
  local odd
  refuse_special_tree "$1"
  odd="$(find "$1" \( -name '*\\*' -o -name "*[[:cntrl:]]*" \) -print -quit)" || die "폴더를 검사하지 못했습니다: $1"
  [[ -z "$odd" ]] || die "항목 이름에 줄바꿈·제어 문자·역슬래시가 있습니다 — 지원하지 않습니다"
  find "$1" -print | iconv -f UTF-8 -t UTF-8 >/dev/null 2>&1 || die "항목 이름이 UTF-8 이 아닙니다 — 지원하지 않습니다"
}

# apply_owner_perms <dir> <owner> — 소유자(-R --no-dereference)·폴더 700·파일 600 을 적용하고, 소유자를 확인한다. 실패하면 1.
# 이름이 .restore-* 인 임시 폴더는 건너뛴다(마운트 지점 안 작업 폴더).
apply_owner_perms() {
  local dir="$1" owner="$2" left
  chown -R --no-dereference -- "$owner:$owner" "$dir" || return 1
  find "$dir" -path "$dir/.restore-*" -prune -o -type d -exec chmod 700 -- {} + || return 1
  find "$dir" -path "$dir/.restore-*" -prune -o -type f -exec chmod 600 -- {} + || return 1
  left="$(find "$dir" -path "$dir/.restore-*" -prune -o ! -user "$owner" -print -quit)" || return 1
  [[ -z "$left" ]]
}
