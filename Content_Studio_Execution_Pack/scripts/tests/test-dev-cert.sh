#!/usr/bin/env bash
# scripts/dev-cert.sh 시험(EXPIRY-1, 결정 D39) — pnpm·node 없이 일반 bash 로:
#   bash scripts/tests/test-dev-cert.sh
# 모든 실행은 mktemp 로 만든 임시 폴더의 DEV_CERT_DIR 에서만 한다(실제 data/dev-certs 를 건드리지 않음 — run_dc 가 경로를 확인).
# 진짜 openssl 이 있으면 진짜로 키·인증서를 만들어 검사하고, 만료된 인증서·생성 실패는 가짜 openssl(진짜 openssl 을 감싼 stub)로 흉내 낸다.
# openssl 이 없으면 openssl 이 필요 없는 시험(사용법 오류·openssl 없음)만 하고 나머지는 SKIP 으로 표시한다.
# FIX1-EXPIRY1: 바꾸기 중 실패·중단은 가짜 mv, 백업 이름 충돌은 가짜 date 로 확정적으로 만든다(PATH 앞에 둘 때만, 시험 전용 — dev-cert.sh 에는 시험용 분기 없음).
set -u

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$TESTS_DIR/.." && pwd)/dev-cert.sh"
BASH_BIN="${BASH:-bash}"
PASS=0
FAIL=0
SKIP=0
CURRENT=""

T_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/cs-dev-cert-test.XXXXXX")"
cleanup() { rm -rf -- "$T_ROOT"; }
trap cleanup EXIT

t() { CURRENT="$1"; }
ok() {
  PASS=$((PASS + 1))
  echo "  ok   - $CURRENT${1:+ ($1)}"
}
ng() {
  FAIL=$((FAIL + 1))
  echo "  FAIL - $CURRENT: $1"
}
skip() {
  SKIP=$((SKIP + 1))
  echo "  SKIP - $CURRENT: $1"
}
expect_rc() { if [[ "$1" == "$2" ]]; then ok "rc=$2"; else ng "rc want $1 got $2 :: ${3//$'\n'/ | }"; fi; }
expect_contains() { if [[ "$1" == *"$2"* ]]; then ok "contains '$2'"; else ng "'$2' 없음 :: ${1//$'\n'/ | }"; fi; }
expect_not_contains() { if [[ "$1" != *"$2"* ]]; then ok "no '$2'"; else ng "'$2' 가 있으면 안 됨 :: ${1//$'\n'/ | }"; fi; }
expect_true() { if eval "$1"; then ok "$2"; else ng "$2 :: ($1)"; fi; }

# run_dc <dir> [env 할당…] -- args… : DEV_CERT_DIR=<dir> 로 dev-cert.sh 실행. 결과는 RC·OUT(stdout+stderr).
# 안전: <dir> 가 이 시험의 임시 루트 밑이 아니면 실행하지 않고 중단한다.
run_dc() {
  local dir="$1"
  shift
  case "$dir" in
    "$T_ROOT"/*) ;;
    *)
      echo "[test-dev-cert] 중단: 임시 폴더 밖 DEV_CERT_DIR($dir)로는 실행하지 않습니다" >&2
      exit 3
      ;;
  esac
  local envs=()
  while [[ $# -gt 0 && "$1" != "--" ]]; do
    envs+=("$1")
    shift
  done
  [[ "${1:-}" == "--" ]] && shift
  # FIX2-EXPIRY1: RUN_DC_STDERR=full 이면 dev-cert.sh 의 stderr 를 /dev/full(쓰기마다 실패 — 끊긴 터미널의 EIO 대용), closed 면 닫힌 fd 로 —
  # 이때 OUT 은 stdout 만. 비어 있으면(기본) 예전처럼 stdout+stderr.
  case "${RUN_DC_STDERR:-}" in
    full) OUT="$(env -u OPENSSL -u DEV_CERT_FILE -u DEV_KEY_FILE DEV_CERT_DIR="$dir" "${envs[@]+"${envs[@]}"}" "$BASH_BIN" "$SCRIPT" "$@" 2>/dev/full)" ;;
    closed) OUT="$(env -u OPENSSL -u DEV_CERT_FILE -u DEV_KEY_FILE DEV_CERT_DIR="$dir" "${envs[@]+"${envs[@]}"}" "$BASH_BIN" "$SCRIPT" "$@" 2>&-)" ;;
    # brokenpipe: 호출자가 fd 6 에 읽는 쪽이 닫힌 파이프를 열어 둔다(쓰면 SIGPIPE/EPIPE — 예: `renew 2>&1 | head -1` 에서 head 가 먼저 끝남)
    brokenpipe) OUT="$(env -u OPENSSL -u DEV_CERT_FILE -u DEV_KEY_FILE DEV_CERT_DIR="$dir" "${envs[@]+"${envs[@]}"}" "$BASH_BIN" "$SCRIPT" "$@" 2>&6)" ;;
    *) OUT="$(env -u OPENSSL -u DEV_CERT_FILE -u DEV_KEY_FILE DEV_CERT_DIR="$dir" "${envs[@]+"${envs[@]}"}" "$BASH_BIN" "$SCRIPT" "$@" 2>&1)" ;;
  esac
  RC=$?
}

HAVE_OPENSSL=0
REAL_OPENSSL="$(command -v openssl 2>/dev/null || true)"
[[ -n "$REAL_OPENSSL" ]] && HAVE_OPENSSL=1

# 시험용 인증서 직접 만들기(dev-cert.sh 와 무관하게 — check 의 입력): mk_cert <dir> <days> [cn]
mk_cert() {
  local dir="$1" days="$2" cn="${3:-localhost}"
  mkdir -p "$dir"
  printf '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=%s\n' "$cn" >"$dir/.t.cnf"
  "$REAL_OPENSSL" genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$dir/localhost-key.pem" >/dev/null 2>&1 &&
    "$REAL_OPENSSL" req -new -x509 -key "$dir/localhost-key.pem" -out "$dir/localhost-cert.pem" -days "$days" -config "$dir/.t.cnf" >/dev/null 2>&1
  local rc=$?
  rm -f "$dir/.t.cnf"
  return $rc
}

# 개인 키 PEM 본문 줄(머리·꼬리 제외) — 출력에 한 줄이라도 나오면 실패
key_lines() { grep -v -- '-----' "$1" 2>/dev/null || true; }
# key_leaked <output> <key file>... : 출력에 개인 키가 어떤 꼴로든 드러났으면 0(드러남), 아니면 1.
#   FIX1-EXPIRY1(D39 검토 P2 test-dev-cert.sh:79): PEM 만이 아니라 텍스트·16진·다시 감싼 base64 도 잡는다.
#   1) 표지 글자(대소문자 무시): "PRIVATE KEY"(PEM 머리, EC PRIVATE KEY 포함)·"Private-Key: (256 bit)"·"priv:"(openssl pkey/ec -text)
#   2) 키 파일 PEM 본문 줄 그대로(기존 검사)
#   3) 같은 DER 를 다른 폭으로 감싼 base64(base64 기본 76자 등): 공백·줄 바꿈을 뺀 출력에 PKCS#8 본문·SEC1(-traditional) 본문이 이어 있는가
#   4) 개인 스칼라 16진(pkey -text 의 priv: 블록, 앞의 00 은 뗌): 16진 글자만 남긴 출력에 들어 있는가(콜론·줄 바꿈·대소문자 무관)
key_leaked() {
  local out="$1" f line body hex flat hexflat re_marker='private[-_ ]?key|(^|[^a-z])priv:' hit=1
  shift
  shopt -s nocasematch
  [[ "$out" =~ $re_marker ]] && hit=0
  shopt -u nocasematch
  [[ "$hit" == 0 ]] && return 0
  flat="$(printf '%s' "$out" | tr -d ' \t\r\n')"
  hexflat="$(printf '%s' "$out" | tr -cd '0-9a-fA-F' | tr 'A-F' 'a-f')"
  for f in "$@"; do
    [[ -s "$f" ]] || continue
    while IFS= read -r line; do
      [[ -n "$line" && "$out" == *"$line"* ]] && return 0
    done < <(key_lines "$f")
    for body in "$(key_lines "$f" | tr -d ' \t\r\n')" "$("$REAL_OPENSSL" pkey -in "$f" -traditional 2>/dev/null | grep -v -- '-----' | tr -d ' \t\r\n')"; do
      [[ -n "$body" && "$flat" == *"$body"* ]] && return 0
    done
    hex="$("$REAL_OPENSSL" pkey -in "$f" -noout -text 2>/dev/null | sed -n '/^priv:/,/^pub:/p' | sed '1d;$d' | tr -cd '0-9a-fA-F' | tr 'A-F' 'a-f')"
    hex="${hex#00}"
    [[ ${#hex} -ge 32 && "$hexflat" == *"$hex"* ]] && return 0
  done
  return 1
}
expect_no_key_in() { # expect_no_key_in <output> <key file>...
  if key_leaked "$@"; then ng "개인 키 내용이 출력에 있음"; else ok "키 내용 출력 없음"; fi
}
# file_mode <path> : 권한 8진수(GNU stat → BSD stat). 읽지 못하면 빈 값.
file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null || true; }

echo "== test-dev-cert.sh (openssl: ${REAL_OPENSSL:-없음})"

t "bash -n dev-cert.sh"
if "$BASH_BIN" -n "$SCRIPT"; then ok; else ng "문법 오류"; fi

# ---- 사용법 오류: exit 2 ----
D_USAGE="$T_ROOT/usage"
for args in "" "foo" "check extra" "renew abc" "renew 0" "renew 826" "renew 1 2" "renew -5" "renew 1.5"; do
  t "사용법 오류: '${args}'"
  # shellcheck disable=SC2086
  run_dc "$D_USAGE" -- $args
  expect_rc 2 "$RC" "$OUT"
  expect_contains "$OUT" "사용법"
done
t "사용법 오류: DEV_CERT_FILE 에 폴더(../x.pem)"
run_dc "$D_USAGE" DEV_CERT_FILE=../x.pem -- check
expect_rc 2 "$RC" "$OUT"
t "사용법 오류: DEV_KEY_FILE 이 .pem 아님"
run_dc "$D_USAGE" DEV_KEY_FILE=key.txt -- check
expect_rc 2 "$RC" "$OUT"
t "사용법 오류: 인증서·키 이름이 같음"
run_dc "$D_USAGE" DEV_CERT_FILE=a.pem DEV_KEY_FILE=a.pem -- renew
expect_rc 2 "$RC" "$OUT"
# FIX1-EXPIRY1(D39 검토 P2 dev-cert.sh:204): NTFS(Git Bash)·기본 APFS 는 대소문자를 가리지 않는다 — 대소문자만 다른 이름도 같은 파일
for pair in "Localhost.pem localhost.pem" "A.pem a.pem" "LOCALHOST-KEY.pem localhost-key.pem" "localhost-cert.pem LocalHost-Cert.pem"; do
  read -r c_name k_name <<<"$pair"
  t "사용법 오류: 대소문자만 다른 인증서·키 이름 (DEV_CERT_FILE=$c_name DEV_KEY_FILE=$k_name)"
  run_dc "$D_USAGE" DEV_CERT_FILE="$c_name" DEV_KEY_FILE="$k_name" -- renew 30
  expect_rc 2 "$RC" "$OUT"
  expect_contains "$OUT" "같은 파일"
done
t "사용법 오류: 대소문자만 다른 인증서 이름 + 기본 키 이름(check 도)"
run_dc "$D_USAGE" DEV_CERT_FILE=Localhost-Key.pem -- check
expect_rc 2 "$RC" "$OUT"
expect_contains "$OUT" "같은 파일"
for name in "./localhost.pem" "localhost.pem/" "./Localhost.pem"; do
  t "사용법 오류: 폴더 꼴 이름($name) — ./·끝 / 는 정규화하지 않고 거부"
  run_dc "$D_USAGE" DEV_CERT_FILE="$name" DEV_KEY_FILE=localhost.pem -- renew 30
  expect_rc 2 "$RC" "$OUT"
done
# FIX2-EXPIRY1(검토 #10 dev-cert.sh:255): 점(.)으로 시작하는 이름은 백업 glob(*.pem)에 잡히지 않아 예전 키가 백업 없이 덮어써졌다 — 이름 단계에서 거부
for env_name in "DEV_KEY_FILE=.dev-key.pem" "DEV_CERT_FILE=.dev-cert.pem" "DEV_KEY_FILE=..pem" "DEV_CERT_FILE=.pem"; do
  t "사용법 오류: 점(.)으로 시작하는 이름($env_name) → exit 2"
  run_dc "$D_USAGE" "$env_name" -- renew 30
  expect_rc 2 "$RC" "$OUT"
  expect_contains "$OUT" "점(.)으로 시작할 수 없습니다"
done
t "사용법 오류는 폴더를 만들지 않는다"
expect_true '[[ ! -e "$D_USAGE" ]]' "usage 폴더 없음"

# ---- openssl 없음: exit 1(아무것도 바꾸지 않음) ----
NOSSL_BIN="$T_ROOT/nossl-bin"
mkdir -p "$NOSSL_BIN"
for c in env dirname date mkdir mktemp cp mv chmod rm head cat; do
  p="$(command -v "$c" 2>/dev/null || true)"
  [[ -n "$p" && "$p" == /* ]] && ln -s "$p" "$NOSSL_BIN/$c"
done
D_NOSSL="$T_ROOT/nossl"
mkdir -p "$D_NOSSL"
echo "old-cert-bytes" >"$D_NOSSL/localhost-cert.pem"
t "openssl 없음: check → exit 1 + 한국어 안내"
OUT="$(env -i PATH="$NOSSL_BIN" HOME="$T_ROOT" DEV_CERT_DIR="$D_NOSSL" "$BASH_BIN" "$SCRIPT" check 2>&1)"
RC=$?
expect_rc 1 "$RC" "$OUT"
expect_contains "$OUT" "openssl 을 찾을 수 없습니다"
expect_not_contains "$OUT" "인증서를 읽지 못했습니다" # 바로 멈춘다(다음 단계로 가지 않음)
t "openssl 없음: renew 30 → exit 1, 폴더 그대로"
OUT="$(env -i PATH="$NOSSL_BIN" HOME="$T_ROOT" DEV_CERT_DIR="$D_NOSSL" "$BASH_BIN" "$SCRIPT" renew 30 2>&1)"
RC=$?
expect_rc 1 "$RC" "$OUT"
expect_contains "$OUT" "아무것도 바꾸지 않았습니다"
expect_not_contains "$OUT" "만들지 못했습니다" # 키 생성 단계까지 가지 않는다
expect_true '[[ "$(ls -A "$D_NOSSL")" == "localhost-cert.pem" && "$(cat "$D_NOSSL/localhost-cert.pem")" == "old-cert-bytes" ]]' "기존 파일 그대로·새 파일 없음"
t "OPENSSL 로 없는 경로를 주면 exit 1"
run_dc "$D_NOSSL" OPENSSL="$T_ROOT/no-such-openssl" -- check
expect_rc 1 "$RC" "$OUT"
expect_contains "$OUT" "openssl 을 찾을 수 없습니다"

if [[ "$HAVE_OPENSSL" != 1 ]]; then
  t "openssl 이 필요한 시험"
  skip "이 PC 에 openssl 이 없어 check·renew 실제 동작 시험을 하지 않았습니다(NOT_RUN)"
  echo "  $(basename "$0"): $PASS passed, $FAIL failed, $SKIP skipped"
  [[ "$FAIL" -eq 0 ]]
  exit $?
fi

# ---- check ----
D_CHECK="$T_ROOT/check"
t "check: 인증서 없음 → exit 1"
run_dc "$D_CHECK" -- check
expect_rc 1 "$RC" "$OUT"
expect_contains "$OUT" "인증서 파일이 없습니다"

t "check: PEM 인증서가 아님 → exit 1"
mkdir -p "$D_CHECK"
echo "not a certificate" >"$D_CHECK/localhost-cert.pem"
run_dc "$D_CHECK" -- check
expect_rc 1 "$RC" "$OUT"
expect_contains "$OUT" "인증서를 읽지 못했습니다"

t "check: 10일짜리 인증서 → notAfter·남은 10일·14일 경고"
rm -f "$D_CHECK/localhost-cert.pem"
if mk_cert "$D_CHECK" 10; then
  want_na="$("$REAL_OPENSSL" x509 -in "$D_CHECK/localhost-cert.pem" -noout -enddate)"
  run_dc "$D_CHECK" -- check
  expect_rc 0 "$RC" "$OUT"
  expect_contains "$OUT" "notAfter: ${want_na#notAfter=}"
  expect_contains "$OUT" "남은 날짜: 10일"
  expect_contains "$OUT" "14일 안에 만료됩니다"
  expect_no_key_in "$OUT" "$D_CHECK/localhost-key.pem"
else
  ng "시험 인증서를 만들지 못함"
fi

t "check: 30일짜리 인증서 → 남은 30일, 경고 없음"
D_CHECK30="$T_ROOT/check30"
if mk_cert "$D_CHECK30" 30; then
  run_dc "$D_CHECK30" -- check
  expect_rc 0 "$RC" "$OUT"
  expect_contains "$OUT" "남은 날짜: 30일"
  expect_not_contains "$OUT" "경고"
else
  ng "시험 인증서를 만들지 못함"
fi

# 가짜 openssl: 진짜 openssl 을 감싸되 STUB_ENDDATE 가 있으면 `x509 … -enddate` 에 그 값을, STUB_FAIL_REQ=1 이면 `req` 를 실패시킨다.
# FIX1-EXPIRY1: STUB_CAPTURE_KEY=<경로> 면 `req` 의 -key 인수(dev-cert.sh 가 막 만든 새 개인 키 임시 파일)를 그 경로에 복사해 둔다 —
# 실패 경로에서 dev-cert.sh 가 임시 키를 지워도 그 키가 출력에 없었는지 확인할 수 있게.
STUB="$T_ROOT/stub-openssl"
cat >"$STUB" <<EOF
#!/usr/bin/env bash
if [[ -n "\${STUB_ENDDATE:-}" && "\$1" == x509 && " \$* " == *" -enddate "* ]]; then echo "notAfter=\$STUB_ENDDATE"; exit 0; fi
if [[ -n "\${STUB_CAPTURE_KEY:-}" && "\$1" == req ]]; then
  prev=""
  for a in "\$@"; do
    if [[ "\$prev" == -key ]]; then cp -- "\$a" "\$STUB_CAPTURE_KEY"; fi
    prev="\$a"
  done
fi
if [[ "\${STUB_FAIL_REQ:-0}" == 1 && "\$1" == req ]]; then echo "stub: req 실패(시험)" >&2; exit 1; fi
exec "$REAL_OPENSSL" "\$@"
EOF
chmod +x "$STUB"

# 가짜 mv·date(시험 전용 — run_dc 에 PATH="\$FAKE_BIN:\$PATH" 를 줄 때만 쓰이고, 아래 변수가 없으면 진짜 명령을 그대로 실행):
#   FAKE_MV_FAIL(쉼표 목록) key   = 목적지가 localhost-key.pem 이면 실패(옮기지 않음)
#                           cert  = 목적지가 localhost-cert.pem 이면 실패(옮기지 않음) — 키 이동과 인증서 이동 "사이" 실패
#                           restore = 원본이 .restore-key.*(되돌리기 사본)이면 실패 — 되돌리기까지 실패
#                           term-after-key = 새 키(.new-key.*) 이동은 진짜로 한 뒤 부모(dev-cert.sh)에 TERM 을 보내고 성공 — 두 이동 사이 중단
#                           term-again = 되돌리기 이동(.restore-key.*)도 진짜로 한 뒤 TERM 한 번 더(두 번째 신호에도 되돌리기·정리가 끝까지 가는지)
#                           hup-after-key·int-after-key = term-after-key 와 같되 HUP·INT(FIX2-EXPIRY1 — 터미널 닫기·Ctrl+C)
#   FAKE_CP_DROP  (FIX2-EXPIRY1) 이 이름(basename)의 원본은 복사하지 않고 넘어간다 — 백업에 키가 빠진 상태(대소문자 무시 파일 시스템의 *.pem 누락 등)
#   FAKE_MV_LOG  호출 기록(원본 이름 -> 목적지 이름, 한 줄씩)
#   FAKE_DATE_STAMP  `date +%Y%m%d-%H%M%S` 에 이 값을 낸다(백업 폴더 이름 충돌을 시계와 무관하게 고정). 다른 date 호출은 진짜.
FAKE_BIN="$T_ROOT/fake-bin"
mkdir -p "$FAKE_BIN"
REAL_MV="$(command -v mv)"
REAL_DATE="$(command -v date)"
cat >"$FAKE_BIN/mv" <<EOF
#!/usr/bin/env bash
src="" dst=""
for a in "\$@"; do src="\$dst"; dst="\$a"; done
sb="\${src##*/}" db="\${dst##*/}"
if [[ -n "\${FAKE_MV_LOG:-}" ]]; then echo "\$sb -> \$db" >>"\$FAKE_MV_LOG"; fi
has() { [[ ",\${FAKE_MV_FAIL:-}," == *",\$1,"* ]]; }
if has key && [[ "\$db" == localhost-key.pem ]]; then echo "fake mv: 실패(시험) \$db" >&2; exit 1; fi
if has cert && [[ "\$db" == localhost-cert.pem ]]; then echo "fake mv: 실패(시험) \$db" >&2; exit 1; fi
if has restore && [[ "\$sb" == .restore-key.* ]]; then echo "fake mv: 실패(시험) \$sb" >&2; exit 1; fi
for pair in TERM:term HUP:hup INT:int; do
  if has "\${pair#*:}-after-key" && [[ "\$sb" == .new-key.* && "\$db" == localhost-key.pem ]]; then
    "$REAL_MV" "\$@" || exit 1
    kill -"\${pair%%:*}" "\$PPID"
    exit 0
  fi
done
if has term-again && [[ "\$sb" == .restore-key.* ]]; then
  "$REAL_MV" "\$@" || exit 1
  kill -TERM "\$PPID"
  exit 0
fi
exec "$REAL_MV" "\$@"
EOF
REAL_CP="$(command -v cp)"
cat >"$FAKE_BIN/cp" <<EOF
#!/usr/bin/env bash
if [[ -n "\${FAKE_CP_DROP:-}" ]]; then
  args=()
  for a in "\$@"; do [[ "\${a##*/}" == "\$FAKE_CP_DROP" ]] || args+=("\$a"); done
  exec "$REAL_CP" "\${args[@]}"
fi
exec "$REAL_CP" "\$@"
EOF
cat >"$FAKE_BIN/date" <<EOF
#!/usr/bin/env bash
if [[ -n "\${FAKE_DATE_STAMP:-}" && \$# -eq 1 && "\$1" == "+%Y%m%d-%H%M%S" ]]; then echo "\$FAKE_DATE_STAMP"; exit 0; fi
exec "$REAL_DATE" "\$@"
EOF
chmod +x "$FAKE_BIN/mv" "$FAKE_BIN/cp" "$FAKE_BIN/date"
FAKE_PATH="$FAKE_BIN:$PATH"

# 인증서 공개 키 = 키의 공개 키(짝이 맞음): pair_ok <cert> <key>
pair_ok() {
  local a b
  a="$("$REAL_OPENSSL" x509 -in "$1" -noout -pubkey 2>/dev/null)" || return 1
  b="$("$REAL_OPENSSL" pkey -in "$2" -pubout 2>/dev/null)" || return 1
  [[ -n "$a" && "$a" == "$b" ]]
}
# 폴더 바로 아래 점(.)으로 시작하는 파일(임시·되돌리기 사본) 수
dot_files() { find "$1" -maxdepth 1 -name '.*' -type f | wc -l | tr -d ' '; }

# ---- 키 노출 감지기 자체 시험(FIX1-EXPIRY1): 드러난 꼴은 모두 잡고, 공개 정보만 있는 출력은 잡지 않는다 ----
D_DET="$T_ROOT/detector"
mkdir -p "$D_DET"
if "$REAL_OPENSSL" genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$D_DET/k.pem" >/dev/null 2>&1; then
  det_text="$("$REAL_OPENSSL" pkey -in "$D_DET/k.pem" -noout -text 2>/dev/null)"
  det_hex="$(printf '%s\n' "$det_text" | sed -n '/^priv:/,/^pub:/p' | sed '1d;$d')"
  det_hex_flat="$(printf '%s' "$det_hex" | tr -cd '0-9a-fA-F')"
  # 40자 폭: PEM 본문 줄(64자)이 한 줄째 들어 있지 않아 줄 검사(2)가 아니라 이어 붙인 비교(3)로만 잡힌다
  det_der40="$("$REAL_OPENSSL" pkey -in "$D_DET/k.pem" -outform DER 2>/dev/null | "$REAL_OPENSSL" base64 -e 2>/dev/null | tr -d '\n' | fold -w 40)"
  det_sec1_body="$("$REAL_OPENSSL" pkey -in "$D_DET/k.pem" -traditional 2>/dev/null | grep -v -- '-----')"
  det_pem_line="$(key_lines "$D_DET/k.pem" | sed -n 2p)"
  for form in \
    "pkey -text 전체:$det_text" \
    "priv 16진 블록만(머리 없음):$det_hex" \
    "priv 16진 콜론·줄 바꿈 없이 대문자:$(printf '%s' "$det_hex_flat" | tr 'a-f' 'A-F')" \
    "DER base64 40자 감싸기:$det_der40" \
    "SEC1(-traditional) 본문만(머리 없음):$det_sec1_body" \
    "PEM 본문 한 줄:앞 $det_pem_line 뒤" \
    "Private-Key 표지만:Private-Key: (256 bit)"; do
    t "감지기: 드러남 — ${form%%:*}"
    if key_leaked "${form#*:}" "$D_DET/k.pem"; then ok "잡음"; else ng "못 잡음"; fi
  done
  printf '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=detector\n' >"$D_DET/c.cnf" # -subj "/CN=…" 는 Git Bash 경로 변환을 탄다
  "$REAL_OPENSSL" req -new -x509 -key "$D_DET/k.pem" -out "$D_DET/c.pem" -days 1 -config "$D_DET/c.cnf" >/dev/null 2>&1 || true
  for form in \
    "공개 키 PEM:$("$REAL_OPENSSL" pkey -in "$D_DET/k.pem" -pubout 2>/dev/null)" \
    "공개 키 -text(pub: 블록):$("$REAL_OPENSSL" pkey -in "$D_DET/k.pem" -pubout 2>/dev/null | "$REAL_OPENSSL" pkey -pubin -noout -text 2>/dev/null)" \
    "인증서 x509 -text:$("$REAL_OPENSSL" x509 -in "$D_DET/c.pem" -noout -text 2>/dev/null)" \
    "스크립트 안내 문구:개인 키: /x/localhost-key.pem (내용은 출력하지 않음, 권한 600)"; do
    t "감지기: 공개 정보만 — ${form%%:*}"
    if key_leaked "${form#*:}" "$D_DET/k.pem"; then ng "잘못 잡음(공개 정보)"; else ok "안 잡음"; fi
  done
else
  t "감지기 자체 시험"
  ng "시험 키를 만들지 못함"
fi

t "check: 만료된 인증서(가짜 openssl notAfter 2020) → exit 0 + 만료됨"
run_dc "$D_CHECK30" OPENSSL="$STUB" STUB_ENDDATE="Jan  1 00:00:00 2020 GMT" -- check
expect_rc 0 "$RC" "$OUT"
expect_contains "$OUT" "만료됨("
expect_contains "$OUT" "renew"

# ---- renew ----
D_RENEW="$T_ROOT/renew"
t "renew 30: 기존 pem 백업 → 새 EC P-256 키 + CN=localhost·SAN 인증서"
if mk_cert "$D_RENEW" 10 old-localhost; then
  echo "other-pem" >"$D_RENEW/extra.pem"
  mkdir -p "$T_ROOT/old"
  cp -p "$D_RENEW"/*.pem "$T_ROOT/old/"
  run_dc "$D_RENEW" -- renew 30
  expect_rc 0 "$RC" "$OUT"
  backups=("$D_RENEW"/backup-*)
  expect_true '[[ ${#backups[@]} -eq 1 && -d "${backups[0]}" ]]' "백업 폴더 1개"
  expect_true '[[ "$(basename "${backups[0]}")" =~ ^backup-[0-9]{8}-[0-9]{6}$ ]]' "백업 폴더 이름 backup-YYYYMMDD-HHMMSS"
  expect_true 'cmp -s "$T_ROOT/old/localhost-cert.pem" "${backups[0]}/localhost-cert.pem" && cmp -s "$T_ROOT/old/localhost-key.pem" "${backups[0]}/localhost-key.pem" && cmp -s "$T_ROOT/old/extra.pem" "${backups[0]}/extra.pem"' "백업 = 기존 pem 3개 그대로"
  expect_true '! cmp -s "$T_ROOT/old/localhost-cert.pem" "$D_RENEW/localhost-cert.pem" && ! cmp -s "$T_ROOT/old/localhost-key.pem" "$D_RENEW/localhost-key.pem"' "인증서·키가 새것으로 바뀜"
  subj="$("$REAL_OPENSSL" x509 -in "$D_RENEW/localhost-cert.pem" -noout -subject 2>&1)"
  expect_true '[[ "$subj" =~ CN[[:space:]]*=[[:space:]]*localhost$ ]]' "subject CN=localhost ($subj)"
  text="$("$REAL_OPENSSL" x509 -in "$D_RENEW/localhost-cert.pem" -noout -text 2>&1)"
  expect_contains "$text" "DNS:localhost"
  expect_contains "$text" "IP Address:127.0.0.1"
  expect_contains "$text" "CA:FALSE"
  issuer="$("$REAL_OPENSSL" x509 -in "$D_RENEW/localhost-cert.pem" -noout -issuer 2>&1)"
  expect_true '[[ "${issuer#issuer=}" == "${subj#subject=}" ]]' "자체 서명(issuer = subject)"
  pubtext="$("$REAL_OPENSSL" pkey -in "$D_RENEW/localhost-key.pem" -pubout 2>/dev/null | "$REAL_OPENSSL" pkey -pubin -noout -text 2>&1)"
  expect_contains "$pubtext" "prime256v1"
  expect_true '[[ "$("$REAL_OPENSSL" x509 -in "$D_RENEW/localhost-cert.pem" -noout -pubkey)" == "$("$REAL_OPENSSL" pkey -in "$D_RENEW/localhost-key.pem" -pubout 2>/dev/null)" ]]' "인증서 공개 키 = 새 개인 키의 공개 키"
  if "$REAL_OPENSSL" x509 -in "$D_RENEW/localhost-cert.pem" -noout -checkend $((29 * 86400)) >/dev/null && ! "$REAL_OPENSSL" x509 -in "$D_RENEW/localhost-cert.pem" -noout -checkend $((31 * 86400)) >/dev/null; then ok "유효 기간 30일(29일 뒤 유효·31일 뒤 만료)"; else ng "유효 기간이 30일이 아님"; fi
  expect_contains "$OUT" "남은 날짜: 30일"
  # FIX1-EXPIRY1(D39 검토 P2 test-dev-cert.sh:235): 이 파일 시스템이 chmod 를 지키는지 같은 임시 루트의 시험 파일로 먼저 본다 —
  # Git Bash(Git for Windows, noacl 마운트)의 NTFS 는 chmod 600 이 효과가 없어 644 로 읽힌다(dev-cert.sh 도 "지원되는 파일 시스템에서만").
  # 지키는 파일 시스템(POSIX)에서는 그대로 600 을 단언하고, 아니면 이유를 적고 SKIP.
  perm_probe="$T_ROOT/perm-probe"
  : >"$perm_probe"
  chmod 644 "$perm_probe" 2>/dev/null
  probe_a="$(file_mode "$perm_probe")"
  chmod 600 "$perm_probe" 2>/dev/null
  probe_b="$(file_mode "$perm_probe")"
  rm -f "$perm_probe"
  mode="$(file_mode "$D_RENEW/localhost-key.pem")"
  if [[ -z "$probe_b" || -z "$mode" ]]; then
    skip "stat 으로 권한을 읽지 못함(GNU·BSD stat 없음) — 키 권한 확인 못 함"
  elif [[ "$probe_a" != 644 || "$probe_b" != 600 ]]; then
    skip "이 파일 시스템은 chmod 를 지키지 않음(시험 파일 chmod 644→$probe_a, 600→$probe_b — 예: Git Bash/NTFS noacl) — 키 권한 600 확인 못 함(키 $mode)"
  else
    expect_true '[[ "$mode" == 600 ]]' "개인 키 권한 600 (got $mode, chmod 시험 파일 644→$probe_a 600→$probe_b)"
  fi
  expect_contains "$OUT" "dev 서버를 다시 시작하세요"
  expect_contains "$OUT" "인증서 경고를 다시 수락하세요"
  expect_contains "$OUT" "백업: ${backups[0]}"
  expect_no_key_in "$OUT" "$D_RENEW/localhost-key.pem" "$T_ROOT/old/localhost-key.pem"
  leftovers="$(find "$D_RENEW" -maxdepth 1 -name '.*' -type f | wc -l | tr -d ' ')"
  expect_true '[[ "$leftovers" == 0 ]]' "임시 파일 남지 않음"
  # 새 인증서는 앱의 check 로도 읽힌다
  run_dc "$D_RENEW" -- check
  expect_rc 0 "$RC" "$OUT"
  expect_contains "$OUT" "남은 날짜: 30일"
else
  ng "시험 인증서를 만들지 못함"
fi

t "renew 를 연달아 두 번(실제 시계) → 백업 폴더가 겹치지 않는다(같은 초 충돌은 아래 가짜 date 시험이 확정적으로 확인)"
run_dc "$D_RENEW" -- renew 30
r1=$RC
run_dc "$D_RENEW" -- renew 30
r2=$RC
backups=("$D_RENEW"/backup-*)
expect_true '[[ "$r1" == 0 && "$r2" == 0 && ${#backups[@]} -eq 3 ]]' "백업 폴더 3개(rc $r1/$r2, ${#backups[@]}개)"

# FIX1-EXPIRY1(D39 검토 P2 test-dev-cert.sh:254): 백업 이름 충돌을 시계와 무관하게 — 가짜 date 가 같은 시각 도장을 내고, 그 이름의 폴더가 이미 있다
STAMP=20260101-000000
D_COLL="$T_ROOT/coll"
t "renew 백업 이름 충돌(가짜 date 로 같은 초 고정) → backup-$STAMP-1, 다음은 -2, 먼저 있던 백업은 바이트 그대로"
if mk_cert "$D_COLL" 10 old-localhost; then
  mkdir -p "$D_COLL/backup-$STAMP" "$T_ROOT/coll-old" "$T_ROOT/coll-mid"
  echo "sentinel-bytes-$$" >"$D_COLL/backup-$STAMP/sentinel.pem"
  cp -p "$D_COLL/backup-$STAMP/sentinel.pem" "$T_ROOT/coll-sentinel.pem"
  cp -p "$D_COLL"/*.pem "$T_ROOT/coll-old/"
  run_dc "$D_COLL" PATH="$FAKE_PATH" FAKE_DATE_STAMP="$STAMP" -- renew 30
  expect_rc 0 "$RC" "$OUT"
  expect_contains "$OUT" "백업: $D_COLL/backup-$STAMP-1 "
  expect_true '[[ -d "$D_COLL/backup-$STAMP-1" ]]' "backup-$STAMP-1 생김"
  expect_true 'cmp -s "$T_ROOT/coll-old/localhost-cert.pem" "$D_COLL/backup-$STAMP-1/localhost-cert.pem" && cmp -s "$T_ROOT/coll-old/localhost-key.pem" "$D_COLL/backup-$STAMP-1/localhost-key.pem"' "-1 = 갱신 전 인증서·키"
  expect_true '[[ "$(ls -A "$D_COLL/backup-$STAMP")" == sentinel.pem ]] && cmp -s "$T_ROOT/coll-sentinel.pem" "$D_COLL/backup-$STAMP/sentinel.pem"' "먼저 있던 backup-$STAMP 은 sentinel 하나 그대로(덮어쓰지 않음)"
  cp -p "$D_COLL"/localhost-*.pem "$T_ROOT/coll-mid/"
  run_dc "$D_COLL" PATH="$FAKE_PATH" FAKE_DATE_STAMP="$STAMP" -- renew 30
  expect_rc 0 "$RC" "$OUT"
  expect_contains "$OUT" "백업: $D_COLL/backup-$STAMP-2 "
  expect_true 'cmp -s "$T_ROOT/coll-mid/localhost-cert.pem" "$D_COLL/backup-$STAMP-2/localhost-cert.pem" && cmp -s "$T_ROOT/coll-mid/localhost-key.pem" "$D_COLL/backup-$STAMP-2/localhost-key.pem"' "-2 = 두 번째 갱신 전 인증서·키"
  expect_true 'cmp -s "$T_ROOT/coll-old/localhost-key.pem" "$D_COLL/backup-$STAMP-1/localhost-key.pem" && cmp -s "$T_ROOT/coll-sentinel.pem" "$D_COLL/backup-$STAMP/sentinel.pem"' "앞의 백업 둘 다 그대로"
  coll_dirs=("$D_COLL"/backup-*)
  expect_true '[[ ${#coll_dirs[@]} -eq 3 ]]' "백업 폴더 정확히 3개(${#coll_dirs[@]})"
  expect_no_key_in "$OUT" "$D_COLL/localhost-key.pem" "$T_ROOT/coll-old/localhost-key.pem" "$T_ROOT/coll-mid/localhost-key.pem"
else
  ng "시험 인증서를 만들지 못함"
fi

t "renew(기본 90일): 빈 폴더 → 백업 없음, 새 파일 2개"
D_EMPTY="$T_ROOT/empty/dev-certs"
run_dc "$D_EMPTY" -- renew
expect_rc 0 "$RC" "$OUT"
expect_contains "$OUT" "기존 pem 파일이 없어 백업하지 않았습니다"
expect_contains "$OUT" "남은 날짜: 90일"
expect_true '[[ -f "$D_EMPTY/localhost-cert.pem" && -f "$D_EMPTY/localhost-key.pem" && -z "$(find "$D_EMPTY" -maxdepth 1 -name "backup-*")" ]]' "인증서·키 생김, 백업 폴더 없음"
expect_no_key_in "$OUT" "$D_EMPTY/localhost-key.pem"

t "renew: DEV_CERT_FILE·DEV_KEY_FILE 이름 바꾸기"
D_NAMES="$T_ROOT/names"
run_dc "$D_NAMES" DEV_CERT_FILE=dev.crt.pem DEV_KEY_FILE=dev.key.pem -- renew 7
expect_rc 0 "$RC" "$OUT"
expect_true '[[ -f "$D_NAMES/dev.crt.pem" && -f "$D_NAMES/dev.key.pem" && ! -e "$D_NAMES/localhost-cert.pem" ]]' "지정한 이름으로 만듦"

t "renew: 인증서 생성 실패(가짜 openssl req 실패) → exit 1, 기존 파일·백업 없음·임시 파일 없음"
D_FAIL="$T_ROOT/fail"
if mk_cert "$D_FAIL" 10; then
  mkdir -p "$T_ROOT/fail-old"
  cp -p "$D_FAIL"/*.pem "$T_ROOT/fail-old/"
  run_dc "$D_FAIL" OPENSSL="$STUB" STUB_FAIL_REQ=1 STUB_CAPTURE_KEY="$T_ROOT/fail-newkey.pem" -- renew 30
  expect_rc 1 "$RC" "$OUT"
  expect_contains "$OUT" "기존 파일은 그대로입니다"
  expect_true 'cmp -s "$T_ROOT/fail-old/localhost-cert.pem" "$D_FAIL/localhost-cert.pem" && cmp -s "$T_ROOT/fail-old/localhost-key.pem" "$D_FAIL/localhost-key.pem"' "기존 인증서·키 그대로"
  expect_true '[[ -z "$(find "$D_FAIL" -mindepth 1 -maxdepth 1 ! -name "localhost-*.pem")" ]]' "백업 폴더·임시 파일 없음"
  # FIX1-EXPIRY1: 새로 만든 키(dev-cert.sh 가 실패 뒤 지움)는 가짜 openssl 이 req 직전에 복사해 둔 사본으로 확인
  expect_true '[[ -s "$T_ROOT/fail-newkey.pem" ]] && ! cmp -s "$T_ROOT/fail-newkey.pem" "$D_FAIL/localhost-key.pem"' "새 키 사본을 가로챔(기존 키와 다름)"
  expect_no_key_in "$OUT" "$D_FAIL/localhost-key.pem" "$T_ROOT/fail-newkey.pem"
else
  ng "시험 인증서를 만들지 못함"
fi

# ---- FIX1-EXPIRY1(D39 검토 P2 dev-cert.sh:185): 바꾸기(키 → 인증서 이동) 중 실패·중단 → 백업에서 되돌림, 짝이 어긋난 채 끝나지 않음 ----
# swap_setup <이름> [nokey] : 기존 키·인증서(10일, CN=old-localhost)를 만들고 사본을 <폴더>-old/ 에 둔다. 폴더 경로는 SW 에.
swap_setup() {
  SW="$T_ROOT/$1"
  mk_cert "$SW" 10 old-localhost || return 1
  if [[ "${2:-}" == nokey ]]; then rm -f "$SW/localhost-key.pem"; fi
  mkdir -p "$SW-old"
  cp -p "$SW"/*.pem "$SW-old/"
}

t "renew: 키 이동 뒤 인증서 이동 실패(가짜 mv) → 기존 키를 백업에서 되돌림, exit 1, 갱신 전 인증서·키 그대로·짝 맞음, 임시 파일 없음"
if swap_setup swap-cert; then
  run_dc "$SW" PATH="$FAKE_PATH" FAKE_MV_FAIL=cert FAKE_MV_LOG="$T_ROOT/swap-cert.log" OPENSSL="$STUB" STUB_CAPTURE_KEY="$T_ROOT/swap-cert-newkey.pem" -- renew 30
  expect_rc 1 "$RC" "$OUT"
  expect_true 'grep -q "^\.new-key\.[^ ]* -> localhost-key\.pem$" "$T_ROOT/swap-cert.log" && grep -q "^\.new-cert\.[^ ]* -> localhost-cert\.pem$" "$T_ROOT/swap-cert.log"' "주입 확인: 키 이동이 일어난 뒤 인증서 이동에서 실패"
  expect_contains "$OUT" "새 인증서를 제자리에 두지 못했습니다"
  expect_contains "$OUT" "되돌렸습니다"
  expect_contains "$OUT" "기존 파일은 그대로입니다"
  expect_true 'cmp -s "$SW-old/localhost-cert.pem" "$SW/localhost-cert.pem" && cmp -s "$SW-old/localhost-key.pem" "$SW/localhost-key.pem"' "갱신 전 인증서·키 바이트 그대로"
  expect_true 'pair_ok "$SW/localhost-cert.pem" "$SW/localhost-key.pem"' "제자리 인증서 공개 키 = 제자리 키의 공개 키"
  expect_true '[[ -s "$T_ROOT/swap-cert-newkey.pem" ]] && ! cmp -s "$T_ROOT/swap-cert-newkey.pem" "$SW/localhost-key.pem"' "새 키(가로챈 사본)는 제자리에 없음"
  expect_true '[[ "$(dot_files "$SW")" == 0 ]]' "임시 파일(.new-*·.restore-*·.openssl-*) 남지 않음"
  sw_backup=("$SW"/backup-*)
  expect_true '[[ ${#sw_backup[@]} -eq 1 ]] && cmp -s "$SW-old/localhost-key.pem" "${sw_backup[0]}/localhost-key.pem"' "백업 폴더(기존 키 포함)는 남김"
  expect_no_key_in "$OUT" "$SW/localhost-key.pem" "$T_ROOT/swap-cert-newkey.pem"
else
  ng "시험 인증서를 만들지 못함"
fi

t "renew: 인증서 이동 실패 + 키 되돌리기도 실패 → 새 키와 짝인 새 인증서를 지우지 않고 경로·옮길 명령 안내, exit 1"
if swap_setup swap-stuck; then
  run_dc "$SW" PATH="$FAKE_PATH" FAKE_MV_FAIL=cert,restore OPENSSL="$STUB" STUB_CAPTURE_KEY="$T_ROOT/swap-stuck-newkey.pem" -- renew 30
  expect_rc 1 "$RC" "$OUT"
  expect_contains "$OUT" "되돌리지 못했습니다"
  kept=("$SW"/.new-cert.*)
  expect_true '[[ ${#kept[@]} -eq 1 && -f "${kept[0]}" ]]' "새 인증서 임시 파일 1개를 남김(EXIT 정리가 지우지 않음)"
  expect_contains "$OUT" "${kept[0]}"
  expect_contains "$OUT" "mv -f --"
  expect_true 'cmp -s "$T_ROOT/swap-stuck-newkey.pem" "$SW/localhost-key.pem"' "제자리 키 = 새 키(되돌리지 못함)"
  expect_true 'pair_ok "${kept[0]}" "$SW/localhost-key.pem"' "남긴 새 인증서가 제자리 새 키와 짝"
  expect_true 'cmp -s "$SW-old/localhost-cert.pem" "$SW/localhost-cert.pem"' "제자리 인증서는 갱신 전 그대로"
  expect_true '[[ "$(dot_files "$SW")" == 1 ]]' "남긴 인증서 말고는 임시 파일(.new-key·.restore-*·.openssl-*) 없음"
  expect_no_key_in "$OUT" "$SW/localhost-key.pem" "$SW-old/localhost-key.pem" "$T_ROOT/swap-stuck-newkey.pem"
  # 안내대로 옮기면 새 키·인증서로 맞는다
  "$REAL_MV" -f -- "${kept[0]}" "$SW/localhost-cert.pem"
  expect_true 'pair_ok "$SW/localhost-cert.pem" "$SW/localhost-key.pem"' "안내대로 옮기면 짝이 맞음"
else
  ng "시험 인증서를 만들지 못함"
fi

t "renew: 기존 키 없이 인증서만 있을 때 인증서 이동 실패 → 새 키를 지워 갱신 전 그대로(키 없음·인증서 그대로)"
if swap_setup swap-nokey nokey; then
  run_dc "$SW" PATH="$FAKE_PATH" FAKE_MV_FAIL=cert OPENSSL="$STUB" STUB_CAPTURE_KEY="$T_ROOT/swap-nokey-newkey.pem" -- renew 30
  expect_rc 1 "$RC" "$OUT"
  expect_contains "$OUT" "되돌렸습니다"
  expect_true '[[ ! -e "$SW/localhost-key.pem" ]] && cmp -s "$SW-old/localhost-cert.pem" "$SW/localhost-cert.pem"' "키 없음·인증서 그대로"
  expect_true '[[ "$(dot_files "$SW")" == 0 ]]' "임시 파일 남지 않음"
  # FIX2-EXPIRY1(검토 #11): 되돌리기의 rm 분기(새 키를 지움) — 지운 새 키는 가로챈 사본으로만 확인할 수 있다
  expect_true '[[ -s "$T_ROOT/swap-nokey-newkey.pem" ]]' "새 키 사본을 가로챔"
  expect_no_key_in "$OUT" "$T_ROOT/swap-nokey-newkey.pem"
else
  ng "시험 인증서를 만들지 못함"
fi

t "renew: 키 이동 실패(가짜 mv) → exit 1, 기존 파일 그대로, 임시 파일 없음"
if swap_setup swap-key; then
  run_dc "$SW" PATH="$FAKE_PATH" FAKE_MV_FAIL=key OPENSSL="$STUB" STUB_CAPTURE_KEY="$T_ROOT/swap-key-newkey.pem" -- renew 30
  expect_rc 1 "$RC" "$OUT"
  expect_contains "$OUT" "새 개인 키를 제자리에 두지 못했습니다"
  expect_contains "$OUT" "기존 파일은 그대로입니다"
  expect_true 'cmp -s "$SW-old/localhost-cert.pem" "$SW/localhost-cert.pem" && cmp -s "$SW-old/localhost-key.pem" "$SW/localhost-key.pem"' "갱신 전 인증서·키 그대로"
  expect_true '[[ "$(dot_files "$SW")" == 0 ]]' "임시 파일 남지 않음"
  # FIX2-EXPIRY1(검토 #11): 키 이동 실패의 swap_fail("" 분기) 출력에도 키가 없다
  expect_true '[[ -s "$T_ROOT/swap-key-newkey.pem" ]] && ! cmp -s "$T_ROOT/swap-key-newkey.pem" "$SW/localhost-key.pem"' "새 키 사본을 가로챔(제자리 키와 다름)"
  expect_no_key_in "$OUT" "$SW/localhost-key.pem" "$T_ROOT/swap-key-newkey.pem"
else
  ng "시험 인증서를 만들지 못함"
fi

t "renew: 키 이동 직후 중단(TERM — 두 이동 사이) → EXIT 정리가 기존 키를 되돌림, 짝 맞음·임시 파일 없음"
if swap_setup swap-term; then
  run_dc "$SW" PATH="$FAKE_PATH" FAKE_MV_FAIL=term-after-key OPENSSL="$STUB" STUB_CAPTURE_KEY="$T_ROOT/swap-term-newkey.pem" -- renew 30
  expect_rc 143 "$RC" "$OUT"
  expect_contains "$OUT" "되돌렸습니다"
  expect_true 'cmp -s "$SW-old/localhost-cert.pem" "$SW/localhost-cert.pem" && cmp -s "$SW-old/localhost-key.pem" "$SW/localhost-key.pem"' "갱신 전 인증서·키 그대로"
  expect_true 'pair_ok "$SW/localhost-cert.pem" "$SW/localhost-key.pem"' "짝 맞음"
  expect_true '[[ "$(dot_files "$SW")" == 0 ]]' "임시 파일 남지 않음"
  expect_true '[[ -s "$T_ROOT/swap-term-newkey.pem" ]] && ! cmp -s "$T_ROOT/swap-term-newkey.pem" "$SW/localhost-key.pem"' "새 키(가로챈 사본)는 제자리에 없음"
  expect_no_key_in "$OUT" "$SW/localhost-key.pem" "$T_ROOT/swap-term-newkey.pem"
else
  ng "시험 인증서를 만들지 못함"
fi

t "renew: 두 이동 사이 TERM + 되돌리는 중 TERM 한 번 더 → 되돌리기·정리를 끝까지(짝 맞음·임시 파일 없음, 종료 코드 143)"
if swap_setup swap-term2; then
  run_dc "$SW" PATH="$FAKE_PATH" FAKE_MV_FAIL=term-after-key,term-again OPENSSL="$STUB" STUB_CAPTURE_KEY="$T_ROOT/swap-term2-newkey.pem" -- renew 30
  expect_rc 143 "$RC" "$OUT"
  expect_contains "$OUT" "되돌렸습니다"
  expect_true 'cmp -s "$SW-old/localhost-cert.pem" "$SW/localhost-cert.pem" && cmp -s "$SW-old/localhost-key.pem" "$SW/localhost-key.pem"' "갱신 전 인증서·키 그대로"
  expect_true 'pair_ok "$SW/localhost-cert.pem" "$SW/localhost-key.pem"' "짝 맞음"
  expect_true '[[ "$(dot_files "$SW")" == 0 ]]' "임시 파일 남지 않음"
  expect_true '[[ -s "$T_ROOT/swap-term2-newkey.pem" ]]' "새 키 사본을 가로챔"
  expect_no_key_in "$OUT" "$SW/localhost-key.pem" "$T_ROOT/swap-term2-newkey.pem"
else
  ng "시험 인증서를 만들지 못함"
fi

t "renew: 인증서 자리가 폴더(일반 파일 아님) → exit 1, 키를 만들기 전에 멈춤(백업·임시 파일 없음, 키 그대로)"
if swap_setup swap-dir; then
  rm -f "$SW/localhost-cert.pem"
  mkdir "$SW/localhost-cert.pem"
  run_dc "$SW" OPENSSL="$STUB" STUB_CAPTURE_KEY="$T_ROOT/swap-dir-newkey.pem" -- renew 30
  expect_rc 1 "$RC" "$OUT"
  expect_contains "$OUT" "일반 파일이 아닙니다"
  # FIX2-EXPIRY1(검토 #11): 키를 만들기 전에 멈춘다(가로챌 새 키 없음) — 제자리 기존 키도 출력에 없다
  expect_true '[[ ! -e "$T_ROOT/swap-dir-newkey.pem" ]]' "새 키를 만들지 않음(req 호출 없음)"
  expect_no_key_in "$OUT" "$SW/localhost-key.pem"
  expect_true 'cmp -s "$SW-old/localhost-key.pem" "$SW/localhost-key.pem" && [[ -d "$SW/localhost-cert.pem" && -z "$(ls -A "$SW/localhost-cert.pem")" ]]' "키 그대로·폴더 안에 아무것도 옮기지 않음"
  expect_true '[[ "$(dot_files "$SW")" == 0 && -z "$(find "$SW" -maxdepth 1 -name "backup-*")" ]]' "백업·임시 파일 없음"
else
  ng "시험 인증서를 만들지 못함"
fi

# ---- FIX2-EXPIRY1(검토 #9 dev-cert.sh:176): EXIT trap·swap_fail 안의 errexit — stderr 쓰기 실패(터미널을 닫아 끊긴 tty 의 EIO 등)가 되돌리기 전에
# 셸을 끝내 짝이 어긋난 채(새 키 + 예전 인증서) 임시 파일까지 남았다. stderr 가 /dev/full(쓰기마다 ENOSPC)·닫힌 fd 여도 되돌리기·정리는 끝까지 간다.
# 신호 경우: 두 이동 사이에 TERM·HUP·INT(HUP 은 stderr 정상 경우도 — 광고했지만 시험이 없던 신호). OUT 은 stderr 를 버리는 경우 stdout 만.
for spec in "full term TERM 143" "full hup HUP 129" "full int INT 130" "closed term TERM 143" "closed hup HUP 129" "normal hup HUP 129"; do
  read -r err_mode sig sig_name want_rc <<<"$spec"
  t "renew: 두 이동 사이 ${sig_name} + stderr ${err_mode} → 되돌리기·정리 끝까지(종료 코드 $want_rc, 갱신 전 짝 그대로·임시 파일 없음)"
  if [[ "$err_mode" == full && ! -w /dev/full ]]; then
    skip "/dev/full 이 없는 시스템(닫힌 fd 경우가 같은 경로를 본다)"
    continue
  fi
  if swap_setup "swap-sig-$err_mode-$sig"; then
    if [[ "$err_mode" == normal ]]; then RUN_DC_STDERR=""; else RUN_DC_STDERR="$err_mode"; fi
    run_dc "$SW" PATH="$FAKE_PATH" FAKE_MV_FAIL="$sig-after-key" FAKE_MV_LOG="$T_ROOT/swap-sig-$err_mode-$sig.log" OPENSSL="$STUB" STUB_CAPTURE_KEY="$T_ROOT/swap-sig-$err_mode-$sig-newkey.pem" -- renew 30
    RUN_DC_STDERR=""
    expect_rc "$want_rc" "$RC" "$OUT"
    expect_true 'grep -q "^\.new-key\.[^ ]* -> localhost-key\.pem$" "$T_ROOT/swap-sig-$err_mode-$sig.log"' "주입 확인: 새 키를 제자리로 옮긴 뒤 신호"
    expect_true 'cmp -s "$SW-old/localhost-cert.pem" "$SW/localhost-cert.pem" && cmp -s "$SW-old/localhost-key.pem" "$SW/localhost-key.pem"' "갱신 전 인증서·키 바이트 그대로"
    expect_true 'pair_ok "$SW/localhost-cert.pem" "$SW/localhost-key.pem"' "짝 맞음"
    expect_true '[[ "$(dot_files "$SW")" == 0 ]]' "임시 파일(.new-*·.restore-*·.openssl-*) 남지 않음"
    expect_true '[[ -s "$T_ROOT/swap-sig-$err_mode-$sig-newkey.pem" ]] && ! cmp -s "$T_ROOT/swap-sig-$err_mode-$sig-newkey.pem" "$SW/localhost-key.pem"' "새 키(가로챈 사본)는 제자리에 없음"
    if [[ "$err_mode" == normal ]]; then expect_contains "$OUT" "되돌렸습니다"; fi
    expect_no_key_in "$OUT" "$SW/localhost-key.pem" "$T_ROOT/swap-sig-$err_mode-$sig-newkey.pem"
  else
    ng "시험 인증서를 만들지 못함"
  fi
done
# 읽는 쪽이 닫힌 파이프: FIFO 를 읽기·쓰기로 연 뒤(막히지 않음) 쓰기 fd 를 따로 열고 읽는 fd 를 닫는다 — 쓰기마다 SIGPIPE(무시되면 EPIPE). 결정적.
t "renew: 두 이동 사이 TERM + stderr 가 읽는 쪽이 닫힌 파이프(SIGPIPE) → 되돌리기·정리 끝까지(종료 코드 143, 갱신 전 짝 그대로·임시 파일 없음)"
if ! command -v mkfifo >/dev/null 2>&1; then
  skip "mkfifo 없음"
elif swap_setup swap-sig-pipe; then
  mkfifo "$T_ROOT/broken.fifo"
  exec 5<>"$T_ROOT/broken.fifo"
  exec 6>"$T_ROOT/broken.fifo"
  exec 5<&-
  RUN_DC_STDERR=brokenpipe
  run_dc "$SW" PATH="$FAKE_PATH" FAKE_MV_FAIL=term-after-key OPENSSL="$STUB" STUB_CAPTURE_KEY="$T_ROOT/swap-sig-pipe-newkey.pem" -- renew 30
  RUN_DC_STDERR=""
  exec 6>&-
  expect_rc 143 "$RC" "$OUT"
  expect_true 'cmp -s "$SW-old/localhost-cert.pem" "$SW/localhost-cert.pem" && cmp -s "$SW-old/localhost-key.pem" "$SW/localhost-key.pem"' "갱신 전 인증서·키 바이트 그대로"
  expect_true 'pair_ok "$SW/localhost-cert.pem" "$SW/localhost-key.pem"' "짝 맞음"
  expect_true '[[ "$(dot_files "$SW")" == 0 ]]' "임시 파일 남지 않음"
  expect_no_key_in "$OUT" "$SW/localhost-key.pem" "$T_ROOT/swap-sig-pipe-newkey.pem"
else
  ng "시험 인증서를 만들지 못함"
fi
for err_mode in full closed; do
  t "renew: 인증서 이동 실패 + stderr ${err_mode} → swap_fail 이 되돌리기를 끝까지(exit 1, 갱신 전 짝 그대로·임시 파일 없음)"
  if [[ "$err_mode" == full && ! -w /dev/full ]]; then
    skip "/dev/full 이 없는 시스템(닫힌 fd 경우가 같은 경로를 본다)"
    continue
  fi
  if swap_setup "swap-fail-$err_mode"; then
    RUN_DC_STDERR="$err_mode"
    run_dc "$SW" PATH="$FAKE_PATH" FAKE_MV_FAIL=cert OPENSSL="$STUB" STUB_CAPTURE_KEY="$T_ROOT/swap-fail-$err_mode-newkey.pem" -- renew 30
    RUN_DC_STDERR=""
    expect_rc 1 "$RC" "$OUT"
    expect_true 'cmp -s "$SW-old/localhost-cert.pem" "$SW/localhost-cert.pem" && cmp -s "$SW-old/localhost-key.pem" "$SW/localhost-key.pem"' "갱신 전 인증서·키 바이트 그대로"
    expect_true 'pair_ok "$SW/localhost-cert.pem" "$SW/localhost-key.pem"' "짝 맞음"
    expect_true '[[ "$(dot_files "$SW")" == 0 ]]' "임시 파일 남지 않음"
    expect_no_key_in "$OUT" "$SW/localhost-key.pem" "$T_ROOT/swap-fail-$err_mode-newkey.pem"
  else
    ng "시험 인증서를 만들지 못함"
  fi
done

# ---- FIX2-EXPIRY1(검토 #10): 점으로 시작하는 키 이름 + 기존 키·인증서 — 예전에는 백업 없이 키를 덮어썼다(지금은 이름 단계 exit 2, 아무것도 바꾸지 않음) ----
t "renew: 점으로 시작하는 키 이름(DEV_KEY_FILE=.k.pem) + 기존 키·인증서 → exit 2, 파일·폴더 그대로(백업·임시 파일 없음)"
if swap_setup swap-dotname; then
  "$REAL_MV" -f -- "$SW/localhost-key.pem" "$SW/.k.pem"
  cp -p -- "$SW/.k.pem" "$SW-old/.k.pem"
  run_dc "$SW" DEV_KEY_FILE=.k.pem -- renew 30
  expect_rc 2 "$RC" "$OUT"
  expect_contains "$OUT" "점(.)으로 시작할 수 없습니다"
  expect_true 'cmp -s "$SW-old/.k.pem" "$SW/.k.pem" && cmp -s "$SW-old/localhost-cert.pem" "$SW/localhost-cert.pem"' "기존 키·인증서 바이트 그대로"
  expect_true '[[ "$(dot_files "$SW")" == 1 && -z "$(find "$SW" -maxdepth 1 -name "backup-*")" ]]' "백업·임시 파일 없음(.k.pem 하나뿐)"
else
  ng "시험 인증서를 만들지 못함"
fi

# ---- FIX2-EXPIRY1(검토 #10 방어): 백업에 기존 키가 빠지면(대소문자 무시 파일 시스템에서 *.pem 이 다른 대소문자 확장자를 놓치는 등) 되돌리기의 전제가
# 없으므로 바꾸기 전에 멈춘다 — 예전에는 그대로 바꾸다가 둘째 이동이 실패하면 "되돌리지 못함"(새 키 + 예전 인증서)으로 끝났다. ----
t "renew: 백업에 기존 키가 빠짐(가짜 cp) + 인증서 이동 실패 주입 → 바꾸기 전에 exit 1, 키를 옮기지 않음·갱신 전 짝 그대로·임시 파일 없음"
if swap_setup swap-nobackup; then
  run_dc "$SW" PATH="$FAKE_PATH" FAKE_CP_DROP=localhost-key.pem FAKE_MV_FAIL=cert FAKE_MV_LOG="$T_ROOT/swap-nobackup.log" OPENSSL="$STUB" STUB_CAPTURE_KEY="$T_ROOT/swap-nobackup-newkey.pem" -- renew 30
  expect_rc 1 "$RC" "$OUT"
  expect_contains "$OUT" "백업에 기존 개인 키가 없어"
  expect_contains "$OUT" "기존 파일은 그대로입니다"
  expect_true '! grep -q -- "-> localhost-key\.pem$" "$T_ROOT/swap-nobackup.log" 2>/dev/null' "키 이동을 시작하지 않음"
  expect_true 'cmp -s "$SW-old/localhost-cert.pem" "$SW/localhost-cert.pem" && cmp -s "$SW-old/localhost-key.pem" "$SW/localhost-key.pem"' "갱신 전 인증서·키 바이트 그대로"
  expect_true 'pair_ok "$SW/localhost-cert.pem" "$SW/localhost-key.pem"' "짝 맞음"
  expect_true '[[ "$(dot_files "$SW")" == 0 ]]' "임시 파일 남지 않음"
  expect_no_key_in "$OUT" "$SW/localhost-key.pem" "$T_ROOT/swap-nobackup-newkey.pem"
else
  ng "시험 인증서를 만들지 못함"
fi

# ---- FIX3-EXPIRY1(3차 검토): 같은 가드의 인증서 쪽(dev-cert.sh "백업에 기존 인증서가 없어") — 키는 백업에 있고 인증서만 빠진 경우.
# 이동 실패 주입 없음(가드가 없으면 두 이동이 모두 성공해 예전 인증서를 백업 없이 덮어씀) · 인증서 이동 실패 주입(가드가 없으면 키를 옮겼다 되돌림) 두 경우. ----
for cert_mv_fail in none cert; do
  t "renew: 백업에 기존 인증서가 빠짐(가짜 cp) + 이동 실패 주입 '$cert_mv_fail' → 바꾸기 전에 exit 1, 키를 옮기지 않음·갱신 전 짝 그대로·임시 파일 없음"
  if swap_setup "swap-nobackup-cert-$cert_mv_fail"; then
    mv_fail=""
    [[ "$cert_mv_fail" == none ]] || mv_fail="$cert_mv_fail"
    run_dc "$SW" PATH="$FAKE_PATH" FAKE_CP_DROP=localhost-cert.pem FAKE_MV_FAIL="$mv_fail" FAKE_MV_LOG="$T_ROOT/swap-nobackup-cert-$cert_mv_fail.log" OPENSSL="$STUB" STUB_CAPTURE_KEY="$T_ROOT/swap-nobackup-cert-$cert_mv_fail-newkey.pem" -- renew 30
    expect_rc 1 "$RC" "$OUT"
    expect_contains "$OUT" "백업에 기존 인증서가 없어"
    expect_contains "$OUT" "기존 파일은 그대로입니다"
    expect_true '[[ "$OUT" != *"백업에 기존 개인 키가 없어"* ]]' "키 쪽 가드가 아니라 인증서 쪽 가드에서 멈춤(키는 백업에 있음)"
    expect_true '! grep -q -- "-> localhost-key\.pem$" "$T_ROOT/swap-nobackup-cert-$cert_mv_fail.log" 2>/dev/null' "키 이동을 시작하지 않음"
    expect_true '! grep -q -- "-> localhost-cert\.pem$" "$T_ROOT/swap-nobackup-cert-$cert_mv_fail.log" 2>/dev/null' "인증서 이동을 시작하지 않음"
    expect_true 'cmp -s "$SW-old/localhost-cert.pem" "$SW/localhost-cert.pem" && cmp -s "$SW-old/localhost-key.pem" "$SW/localhost-key.pem"' "갱신 전 인증서·키 바이트 그대로"
    expect_true 'pair_ok "$SW/localhost-cert.pem" "$SW/localhost-key.pem"' "짝 맞음"
    expect_true '[[ "$(dot_files "$SW")" == 0 ]]' "임시 파일 남지 않음"
    expect_no_key_in "$OUT" "$SW/localhost-key.pem" "$T_ROOT/swap-nobackup-cert-$cert_mv_fail-newkey.pem"
  else
    ng "시험 인증서를 만들지 못함"
  fi
done

echo "  $(basename "$0"): $PASS passed, $FAIL failed, $SKIP skipped"
[[ "$FAIL" -eq 0 ]]
