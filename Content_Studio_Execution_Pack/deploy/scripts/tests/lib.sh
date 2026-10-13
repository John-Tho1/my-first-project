#!/usr/bin/env bash
# FIX4-T21P2: 무엇보다 먼저 root 실행을 거부한다(guard.sh).
# shellcheck source=guard.sh
source "$(dirname "${BASH_SOURCE[0]}")/guard.sh"
cs_harness_refuse_root "$EUID"
# deploy/scripts 시험 공용(FIX2-T21P2). 일반 bash 만 쓴다(pnpm·node 불필요). 각 시험 파일이 source 한다.
# 외부 명령(systemctl·mountpoint·id)은 임시 폴더의 가짜 명령(stub)으로 바꾼다 — 실제 서비스·마운트·root 권한을 건드리지 않는다.
set -u
# FIX3-T21P2: 스크립트의 시험용 바꿔치기 변수(CS_*)는 이 표식이 있고 실제 root 가 아닐 때($EUID ≠ 0)만 적용된다.
# 운영 실행에는 이 표식이 없다 — "표식 없이 CS_* 를 줘도 효과 없음"은 test-fix3.sh 가 확인한다.
export CS_DEPLOY_TEST_HARNESS=1

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR="$(cd "$TESTS_DIR/.." && pwd)"
PASS=0
FAIL=0
CURRENT=""

T_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/cs-deploy-test.XXXXXX")"
STUB_BIN="$T_ROOT/bin"
mkdir -p "$STUB_BIN"
cleanup() { rm -rf "$T_ROOT"; }
trap cleanup EXIT

# 가짜 systemctl: 동작은 환경변수로 정한다.
#   STUB_SYSTEMCTL_FAIL=1  모든 호출 실패(버스 연결 오류 흉내)
#   STUB_LOAD              show -p LoadState 값(기본 loaded)
#   STUB_ACTIVE            show -p ActiveState 값(기본 inactive). is-active 는 active 일 때만 0
#   STUB_LIST_FAIL=1       list-unit-files 실패
#   STUB_UNIT_FILES        list-unit-files 출력 줄(공백 구분 단위 이름)
#   STUB_UNIT_FILES_BIG=N  list-unit-files 가 STUB_UNIT_FILES 뒤에 채움 줄 N 개를 더 출력(큰 목록 — 파이프 조기 종료 시험)
#   STUB_ACTIVE_FAIL=1     show -p ActiveState 만 실패(LoadState 는 성공)
cat >"$STUB_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
if [[ "${STUB_SYSTEMCTL_FAIL:-0}" == 1 ]]; then
  echo "Failed to connect to bus: No such file or directory" >&2
  exit 1
fi
args="$*"
case "$args" in
  *"show -p LoadState --value"*) echo "${STUB_LOAD:-loaded}" ;;
  *"show -p ActiveState --value"*)
    [[ "${STUB_ACTIVE_FAIL:-0}" == 1 ]] && exit 1
    echo "${STUB_ACTIVE-inactive}"
    ;;
  *list-unit-files*)
    [[ "${STUB_LIST_FAIL:-0}" == 1 ]] && exit 1
    for u in ${STUB_UNIT_FILES:-}; do echo "$u enabled enabled"; done
    if [[ -n "${STUB_UNIT_FILES_BIG:-}" ]]; then seq -f 'filler-%g.service enabled enabled' 1 "$STUB_UNIT_FILES_BIG"; fi
    ;;
  *is-active*)
    [[ "${STUB_ACTIVE:-inactive}" == active ]] && exit 0
    exit 3
    ;;
  *) exit 1 ;;
esac
EOF
# 가짜 mountpoint(util-linux 와 같은 종료 코드): STUB_MOUNTPOINT 에 적은 경로만 0(마운트 지점), 그 밖 32(아님). STUB_MOUNTPOINT_FAIL=1 이면 1(오류).
cat >"$STUB_BIN/mountpoint" <<'EOF'
#!/usr/bin/env bash
target="${!#}"
[[ "${STUB_MOUNTPOINT_FAIL:-0}" == 1 ]] && exit 1
[[ -n "${STUB_MOUNTPOINT:-}" && "$target" == "$STUB_MOUNTPOINT" ]] && exit 0
exit 32
EOF
# 가짜 id: -u 는 0(root 흉내), 그 밖은 진짜 id
REAL_ID="$(command -v id)"
cat >"$STUB_BIN/id" <<EOF
#!/usr/bin/env bash
if [[ "\${1:-}" == "-u" ]]; then echo 0; exit 0; fi
exec "$REAL_ID" "\$@"
EOF
# 가짜 mv: 인수 중 하나가 STUB_MV_FAIL_ON(glob 패턴, 예 '*.restore-stage*')과 맞으면 실패(교체 도중 실패 흉내), 그 밖은 진짜 mv(REAL_MV)
export REAL_MV="$(command -v mv)"
cat >"$STUB_BIN/mv" <<'EOF'
#!/usr/bin/env bash
if [[ -n "${STUB_MV_FAIL_ON:-}" ]]; then
  for a in "$@"; do
    # shellcheck disable=SC2053
    if [[ "$a" == $STUB_MV_FAIL_ON ]]; then
      echo "mv: 시험용 실패" >&2
      exit 1
    fi
  done
fi
exec "$REAL_MV" "$@"
EOF
chmod +x "$STUB_BIN"/*

# stub 이 PATH 앞에 오는 실행 환경. 스크립트가 지원하면 CS_SYSTEMCTL 등으로도 같은 stub 을 가리킨다.
# FIX4-T21P2: 가짜 chown(진짜로 바꾸지 않고 인수만 기록 — Windows 에는 서비스 사용자가 없다), 가짜 install(-d 폴더 만들기만, 소유자 지정 무시),
# 가짜 flock(STUB_FLOCK_HELD=1 이면 다른 실행이 잠금을 쥔 것처럼 실패). 진짜 flock 의 배타성 자체는 이 PC 에 flock 이 없어 시험하지 못한다.
export CHOWN_LOG="$T_ROOT/chown.log"
: >"$CHOWN_LOG"
cat >"$STUB_BIN/chown" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$CHOWN_LOG"
exit 0
EOF
cat >"$STUB_BIN/install" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-d" ]]; then
  target="${!#}"
  mkdir -p -- "$target"
  exit $?
fi
echo "stub install: 지원하지 않는 사용" >&2
exit 1
EOF
cat >"$STUB_BIN/flock" <<'EOF'
#!/usr/bin/env bash
[[ "${STUB_FLOCK_HELD:-0}" == 1 ]] && exit 1
exit 0
EOF
# FIX5-T21P2: 가짜 tar — `-czf <출력>` 의 출력 경로가 STUB_TAR_BAD_OUT_GLOB 과 맞으면 진짜 tar 로 **형식은 맞지만 검사를 통과하지 못하는**
# 사본(data/ 밖 항목 other/x)을 대신 만든다(사본 검사가 실제로 실행되고 실패하면 멈추는지 확인용). 그 밖은 진짜 tar.
export REAL_TAR="$(command -v tar)"
cat >"$STUB_BIN/tar" <<'EOF'
#!/usr/bin/env bash
if [[ -n "${STUB_TAR_BAD_OUT_GLOB:-}" ]]; then
  prev=""
  for a in "$@"; do
    # shellcheck disable=SC2053
    if [[ "$prev" == "-czf" && "$a" == $STUB_TAR_BAD_OUT_GLOB ]]; then
      d="$(mktemp -d)"
      mkdir -p "$d/data" "$d/other"
      echo x >"$d/other/x"
      "$REAL_TAR" -C "$d" -czf "$a" data other
      rc=$?
      rm -rf "$d"
      exit "$rc"
    fi
    prev="$a"
  done
fi
exec "$REAL_TAR" "$@"
EOF
chmod +x "$STUB_BIN"/chown "$STUB_BIN"/install "$STUB_BIN"/flock "$STUB_BIN"/tar
# FIX5-T21P2: 시험 경로는 이 임시 루트 아래만 허용된다(lib/common.sh cs_path). 정규 경로로 내보낸다.
export CS_HARNESS_ROOT="$(realpath -e "$T_ROOT")"
# 마운트 정보 기본 fixture: 루트 하나만(시험이 하위 마운트를 넣을 때는 CS_MOUNTINFO 로 다른 파일)
MOUNTINFO_DEFAULT="$T_ROOT/mountinfo"
echo "1 0 8:1 / / rw - ext4 /dev/sda1 rw" >"$MOUNTINFO_DEFAULT"
LOCK_DEFAULT="$T_ROOT/deploy.lock"
: >"$LOCK_DEFAULT"

# stub 이 PATH 앞에 오는 실행 환경 + 시험 경로 기본값(시험 실행에서 경로 변수는 반드시 주어져야 한다 — 운영 경로로 떨어지지 않게).
# 뒤에 오는 인수(시험별 값)가 같은 변수를 다시 주면 그 값이 이긴다(env 는 마지막 할당을 쓴다).
stub_env() {
  env PATH="$STUB_BIN:$PATH" CS_SYSTEMCTL="$STUB_BIN/systemctl" CS_MOUNTPOINT_CMD="$STUB_BIN/mountpoint" \
    CS_SERVICE_USER="$(id -un)" CS_LOCK_FILE="$LOCK_DEFAULT" CS_MOUNTINFO="$MOUNTINFO_DEFAULT" "$@"
}


# run_capture <out-var-prefix> cmd... : 종료 코드·stdout+stderr 저장
run_capture() {
  local __p="$1"
  shift
  local __out __rc
  __out="$("$@" 2>&1)"
  __rc=$?
  printf -v "${__p}_rc" '%s' "$__rc"
  printf -v "${__p}_out" '%s' "$__out"
}

t() { CURRENT="$1"; }
ok() {
  PASS=$((PASS + 1))
  echo "  ok   - $CURRENT${1:+ ($1)}"
}
ng() {
  FAIL=$((FAIL + 1))
  echo "  FAIL - $CURRENT: $1"
}
expect_rc() { # expect_rc <want> <got> <output>
  if [[ "$1" == "$2" ]]; then ok "rc=$2"; else ng "rc want $1 got $2 :: ${3//$'\n'/ | }"; fi
}
expect_nonzero() {
  if [[ "$1" != 0 ]]; then ok "rc=$1"; else ng "rc 0 이면 안 됨 :: ${2//$'\n'/ | }"; fi
}
expect_contains() { # expect_contains <haystack> <needle>
  if [[ "$1" == *"$2"* ]]; then ok "contains '$2'"; else ng "'$2' 없음 :: ${1//$'\n'/ | }"; fi
}
expect_not_contains() {
  if [[ "$1" != *"$2"* ]]; then ok "no '$2'"; else ng "'$2' 가 있으면 안 됨 :: ${1//$'\n'/ | }"; fi
}
finish() {
  echo "  $(basename "$0"): $PASS passed, $FAIL failed"
  [[ "$FAIL" -eq 0 ]]
}
