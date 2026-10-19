#!/usr/bin/env bash
# scripts/dev-cert.sh 시험(EXPIRY-1, 결정 D39) — pnpm·node 없이 일반 bash 로:
#   bash scripts/tests/test-dev-cert.sh
# 모든 실행은 mktemp 로 만든 임시 폴더의 DEV_CERT_DIR 에서만 한다(실제 data/dev-certs 를 건드리지 않음 — run_dc 가 경로를 확인).
# 진짜 openssl 이 있으면 진짜로 키·인증서를 만들어 검사하고, 만료된 인증서·생성 실패는 가짜 openssl(진짜 openssl 을 감싼 stub)로 흉내 낸다.
# openssl 이 없으면 openssl 이 필요 없는 시험(사용법 오류·openssl 없음)만 하고 나머지는 SKIP 으로 표시한다.
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
  OUT="$(env -u OPENSSL -u DEV_CERT_FILE -u DEV_KEY_FILE DEV_CERT_DIR="$dir" "${envs[@]+"${envs[@]}"}" "$BASH_BIN" "$SCRIPT" "$@" 2>&1)"
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
expect_no_key_in() { # expect_no_key_in <output> <key file>...
  local out="$1" f line leaked=0
  shift
  for f in "$@"; do
    while IFS= read -r line; do
      [[ -n "$line" && "$out" == *"$line"* ]] && leaked=1
    done < <(key_lines "$f")
  done
  if [[ "$out" == *"PRIVATE KEY"* ]]; then leaked=1; fi
  if [[ "$leaked" == 0 ]]; then ok "키 내용 출력 없음"; else ng "개인 키 내용이 출력에 있음"; fi
}

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
STUB="$T_ROOT/stub-openssl"
cat >"$STUB" <<EOF
#!/usr/bin/env bash
if [[ -n "\${STUB_ENDDATE:-}" && "\$1" == x509 && " \$* " == *" -enddate "* ]]; then echo "notAfter=\$STUB_ENDDATE"; exit 0; fi
if [[ "\${STUB_FAIL_REQ:-0}" == 1 && "\$1" == req ]]; then echo "stub: req 실패(시험)" >&2; exit 1; fi
exec "$REAL_OPENSSL" "\$@"
EOF
chmod +x "$STUB"

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
  if mode="$(stat -c %a "$D_RENEW/localhost-key.pem" 2>/dev/null)"; then
    expect_true '[[ "$mode" == 600 ]]' "개인 키 권한 600 (got $mode)"
  else
    skip "stat -c 없음 — 키 권한 확인 못 함"
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

t "renew 를 연달아 두 번 → 백업 폴더가 겹치지 않는다(같은 초면 -1 접미사)"
run_dc "$D_RENEW" -- renew 30
r1=$RC
run_dc "$D_RENEW" -- renew 30
r2=$RC
backups=("$D_RENEW"/backup-*)
expect_true '[[ "$r1" == 0 && "$r2" == 0 && ${#backups[@]} -eq 3 ]]' "백업 폴더 3개(rc $r1/$r2, ${#backups[@]}개)"

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
  run_dc "$D_FAIL" OPENSSL="$STUB" STUB_FAIL_REQ=1 -- renew 30
  expect_rc 1 "$RC" "$OUT"
  expect_contains "$OUT" "기존 파일은 그대로입니다"
  expect_true 'cmp -s "$T_ROOT/fail-old/localhost-cert.pem" "$D_FAIL/localhost-cert.pem" && cmp -s "$T_ROOT/fail-old/localhost-key.pem" "$D_FAIL/localhost-key.pem"' "기존 인증서·키 그대로"
  expect_true '[[ -z "$(find "$D_FAIL" -mindepth 1 -maxdepth 1 ! -name "localhost-*.pem")" ]]' "백업 폴더·임시 파일 없음"
  expect_no_key_in "$OUT" "$D_FAIL/localhost-key.pem"
else
  ng "시험 인증서를 만들지 못함"
fi

echo "  $(basename "$0"): $PASS passed, $FAIL failed, $SKIP skipped"
[[ "$FAIL" -eq 0 ]]
