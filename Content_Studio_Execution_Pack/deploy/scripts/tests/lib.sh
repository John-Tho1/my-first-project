#!/usr/bin/env bash
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
# 가짜 mv: 인수 중 하나가 STUB_MV_FAIL_ON(부분 문자열)을 포함하면 실패(교체 도중 실패 흉내), 그 밖은 진짜 mv(REAL_MV)
export REAL_MV="$(command -v mv)"
cat >"$STUB_BIN/mv" <<'EOF'
#!/usr/bin/env bash
if [[ -n "${STUB_MV_FAIL_ON:-}" ]]; then
  for a in "$@"; do
    if [[ "$a" == *"$STUB_MV_FAIL_ON"* ]]; then
      echo "mv: 시험용 실패" >&2
      exit 1
    fi
  done
fi
exec "$REAL_MV" "$@"
EOF
chmod +x "$STUB_BIN"/*

# stub 이 PATH 앞에 오는 실행 환경. 스크립트가 지원하면 CS_SYSTEMCTL 등으로도 같은 stub 을 가리킨다.
stub_env() {
  env PATH="$STUB_BIN:$PATH" CS_SYSTEMCTL="$STUB_BIN/systemctl" CS_MOUNTPOINT_CMD="$STUB_BIN/mountpoint" "$@"
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
