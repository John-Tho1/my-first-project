#!/usr/bin/env bash
# Content Studio — 로컬 개발용 HTTPS 인증서 확인·갱신(결정 D39, EXPIRY-1). 외부 호출 없음 — 이 PC 의 openssl 만 쓴다.
#
#   bash scripts/dev-cert.sh check           # 인증서 만료 시각(notAfter)과 남은 날짜
#   bash scripts/dev-cert.sh renew [days]    # 기존 pem 백업 → 새 EC P-256 키 + 자체 서명 인증서(CN=localhost,
#                                            #   SAN DNS:localhost,IP:127.0.0.1), 유효 기간 days 일(기본 90, 1~825)
#
# 경로(앱 루트 = 이 파일의 상위 폴더):
#   DEV_CERT_DIR   인증서 폴더(기본 <앱 루트>/data/dev-certs — gitignore 된 data/ 아래). 시험은 임시 폴더를 준다.
#   DEV_CERT_FILE  인증서 파일 이름(기본 localhost-cert.pem — 서버의 기본 DEV_TLS_CERT_PATH 와 같은 이름)
#   DEV_KEY_FILE   개인 키 파일 이름(기본 localhost-key.pem). dev 서버 실행 설정이 다른 이름을 쓰면 이 값을 맞춘다.
#   OPENSSL        openssl 실행 파일(기본: PATH 의 openssl — Git for Windows 의 Git Bash 에는 보통 들어 있다)
#
# 규칙: 개인 키 내용은 어떤 경우에도 화면에 내보내지 않는다(openssl 출력은 버리거나 키가 없는 오류만 보인다).
#       renew 는 새 키·인증서를 임시 파일에 다 만들고 검사한 뒤에만 기존 파일을 백업(backup-YYYYMMDD-HHMMSS/ 에 복사)하고 바꾼다 —
#       중간에 실패하면 기존 파일은 그대로다. 백업 폴더에는 예전 개인 키도 들어 있으니 data/ 밖으로 옮기지 않는다.
# 종료 코드: 0 성공 · 1 실행 실패(openssl 없음·파일 없음·읽기/생성 실패) · 2 사용법 오류
set -euo pipefail
umask 077

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${DEV_CERT_DIR:-$APP_ROOT/data/dev-certs}"
CERT_NAME="${DEV_CERT_FILE:-localhost-cert.pem}"
KEY_NAME="${DEV_KEY_FILE:-localhost-key.pem}"
WARN_DAYS=14
DEFAULT_DAYS=90
MAX_DAYS=825

usage() {
  cat >&2 <<'EOF'
사용법:
  bash scripts/dev-cert.sh check
  bash scripts/dev-cert.sh renew [유효 일수(1~825, 기본 90)]
EOF
  exit 2
}

die() {
  echo "[dev-cert] 오류: $*" >&2
  exit 1
}

valid_name() { [[ "$1" =~ ^[A-Za-z0-9._-]+\.pem$ ]]; }

need_openssl() {
  OPENSSL_BIN="${OPENSSL:-openssl}"
  if ! command -v "$OPENSSL_BIN" >/dev/null 2>&1; then
    die "openssl 을 찾을 수 없습니다. Git Bash(Git for Windows)에는 보통 들어 있습니다 — PATH 를 확인하거나 OPENSSL=<openssl 경로> 로 지정하세요. 아무것도 바꾸지 않았습니다."
  fi
}

# notAfter 문자열(예: "Nov 12 12:00:00 2026 GMT") → 유닉스 초. GNU date(리눅스·Git Bash) → BSD date(macOS) 순서. 실패하면 빈 값.
to_epoch() {
  local s="$1" out=""
  out="$(date -u -d "$s" +%s 2>/dev/null)" || out=""
  if [[ -z "$out" ]]; then out="$(date -u -j -f '%b %e %T %Y %Z' "$s" +%s 2>/dev/null)" || out=""; fi
  [[ "$out" =~ ^-?[0-9]+$ ]] && echo "$out"
  return 0
}

# 인증서 파일의 notAfter 값(키 내용은 읽지 않는다 — x509 만). 실패하면 빈 값.
cert_not_after() {
  local line=""
  line="$("$OPENSSL_BIN" x509 -in "$1" -noout -enddate 2>/dev/null)" || return 0
  line="${line#notAfter=}"
  [[ -n "$line" ]] && echo "$line"
  return 0
}

# 만료 상태 한 줄 출력(앱과 같은 경계: 남은 시간 ≤ 0 만료, ≤ 14일 경고)
report_expiry() {
  local not_after="$1" end now left days
  echo "notAfter: $not_after"
  end="$(to_epoch "$not_after")"
  if [[ -z "$end" ]]; then
    echo "남은 날짜: 계산하지 못했습니다(이 셸의 date 가 notAfter 형식을 읽지 못함) — 위 notAfter 를 직접 확인하세요."
    return 0
  fi
  now="$(date -u +%s)"
  left=$((end - now))
  if ((left <= 0)); then
    days=$(((-left) / 86400))
    echo "남은 날짜: 만료됨(${days}일 지남) — bash scripts/dev-cert.sh renew 로 새로 만드세요."
    return 0
  fi
  days=$(((left + 86399) / 86400))
  echo "남은 날짜: ${days}일"
  if ((left <= WARN_DAYS * 86400)); then
    echo "경고: ${WARN_DAYS}일 안에 만료됩니다 — bash scripts/dev-cert.sh renew 로 갱신하세요."
  fi
}

cmd_check() {
  [[ $# -eq 0 ]] || usage
  need_openssl
  local cert="$DIR/$CERT_NAME" not_after
  [[ -f "$cert" ]] || die "인증서 파일이 없습니다: $cert (DEV_CERT_DIR·DEV_CERT_FILE 확인, 새로 만들려면 renew)"
  not_after="$(cert_not_after "$cert")"
  [[ -n "$not_after" ]] || die "인증서를 읽지 못했습니다(PEM 인증서가 아님): $cert"
  echo "인증서: $cert"
  report_expiry "$not_after"
}

TMP_FILES=()
cleanup() {
  local f
  for f in "${TMP_FILES[@]+"${TMP_FILES[@]}"}"; do rm -f -- "$f"; done
}
trap cleanup EXIT

cmd_renew() {
  [[ $# -le 1 ]] || usage
  local days="${1:-$DEFAULT_DAYS}"
  [[ "$days" =~ ^[0-9]{1,4}$ ]] || usage
  days=$((10#$days))
  ((days >= 1 && days <= MAX_DAYS)) || usage
  need_openssl

  mkdir -p -- "$DIR" || die "인증서 폴더를 만들지 못했습니다: $DIR"
  local cert="$DIR/$CERT_NAME" key="$DIR/$KEY_NAME"
  local tmp_key tmp_cert tmp_cfg err
  tmp_key="$(mktemp "$DIR/.new-key.XXXXXX")" || die "임시 파일을 만들지 못했습니다: $DIR"
  TMP_FILES+=("$tmp_key")
  tmp_cert="$(mktemp "$DIR/.new-cert.XXXXXX")" || die "임시 파일을 만들지 못했습니다: $DIR"
  TMP_FILES+=("$tmp_cert")
  tmp_cfg="$(mktemp "$DIR/.openssl-cnf.XXXXXX")" || die "임시 파일을 만들지 못했습니다: $DIR"
  TMP_FILES+=("$tmp_cfg")
  err="$(mktemp "$DIR/.openssl-err.XXXXXX")" || die "임시 파일을 만들지 못했습니다: $DIR"
  TMP_FILES+=("$err")

  # -subj "/CN=…" 대신 설정 파일: Git Bash 는 "/" 로 시작하는 인수를 Windows 경로로 바꿔 버린다(MSYS 경로 변환).
  cat >"$tmp_cfg" <<'EOF'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = localhost
[v3_dev]
subjectAltName = DNS:localhost,IP:127.0.0.1
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
EOF

  # 1) 새 개인 키(EC P-256) — 파일로만 쓴다(표준 출력 버림). 오류 출력에는 키가 들어 있지 않다.
  if ! "$OPENSSL_BIN" genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -pkeyopt ec_param_enc:named_curve -out "$tmp_key" >/dev/null 2>"$err"; then
    head -n 5 -- "$err" >&2 || true
    die "새 개인 키를 만들지 못했습니다. 기존 파일은 그대로입니다."
  fi
  chmod 600 -- "$tmp_key" 2>/dev/null || true
  # 2) 자체 서명 인증서(CN=localhost, SAN DNS:localhost,IP:127.0.0.1)
  if ! "$OPENSSL_BIN" req -new -x509 -key "$tmp_key" -out "$tmp_cert" -days "$days" -sha256 -config "$tmp_cfg" -extensions v3_dev >/dev/null 2>"$err"; then
    head -n 5 -- "$err" >&2 || true
    die "새 인증서를 만들지 못했습니다. 기존 파일은 그대로입니다."
  fi
  # 3) 검사: 인증서를 읽을 수 있고, 인증서의 공개 키가 새 개인 키의 공개 키와 같다(공개 키만 비교 — 개인 키는 출력하지 않음)
  local not_after pub_cert pub_key
  not_after="$(cert_not_after "$tmp_cert")"
  [[ -n "$not_after" ]] || die "만든 인증서를 읽지 못했습니다. 기존 파일은 그대로입니다."
  pub_cert="$("$OPENSSL_BIN" x509 -in "$tmp_cert" -noout -pubkey 2>/dev/null)" || pub_cert=""
  pub_key="$("$OPENSSL_BIN" pkey -in "$tmp_key" -pubout 2>/dev/null)" || pub_key=""
  [[ -n "$pub_cert" && "$pub_cert" == "$pub_key" ]] || die "만든 인증서와 개인 키가 맞지 않습니다. 기존 파일은 그대로입니다."

  # 4) 기존 pem 파일 백업(복사 — 원본은 아래에서 새 파일로 바뀔 때까지 그대로)
  local existing=() f backup="" stamp
  for f in "$DIR"/*.pem; do
    [[ -f "$f" ]] && existing+=("$f")
  done
  if ((${#existing[@]})); then
    stamp="$(date +%Y%m%d-%H%M%S)"
    backup="$DIR/backup-$stamp"
    local n=1
    while ! mkdir -- "$backup" 2>/dev/null; do
      ((n < 100)) || die "백업 폴더를 만들지 못했습니다: $DIR/backup-$stamp. 기존 파일은 그대로입니다."
      backup="$DIR/backup-$stamp-$n"
      n=$((n + 1))
    done
    chmod 700 -- "$backup" 2>/dev/null || true
    cp -p -- "${existing[@]}" "$backup/" || die "기존 파일을 백업하지 못했습니다($backup). 기존 파일은 그대로입니다."
  fi

  # 5) 바꾸기(같은 폴더 안 mv — 키 먼저, 그다음 인증서)
  mv -f -- "$tmp_key" "$key" || die "새 개인 키를 제자리에 두지 못했습니다(${backup:-백업 없음})."
  mv -f -- "$tmp_cert" "$cert" || die "새 인증서를 제자리에 두지 못했습니다 — 키만 바뀌었을 수 있습니다. ${backup:+$backup 의 파일로 되돌리세요.}"
  chmod 600 -- "$key" 2>/dev/null || true
  chmod 644 -- "$cert" 2>/dev/null || true

  echo "[dev-cert] 새 인증서를 만들었습니다(EC P-256, CN=localhost, SAN DNS:localhost,IP:127.0.0.1, ${days}일)."
  echo "인증서: $cert"
  echo "개인 키: $key (내용은 출력하지 않음, 권한 600 — 지원되는 파일 시스템에서만)"
  if [[ -n "$backup" ]]; then
    echo "백업: $backup (기존 pem ${#existing[@]}개 — 예전 개인 키 포함, data/ 밖으로 옮기지 마세요)"
  else
    echo "백업: 기존 pem 파일이 없어 백업하지 않았습니다."
  fi
  report_expiry "$not_after"
  echo "다음: dev 서버를 다시 시작하세요(실행 중이면 끄고 다시 켬). 자체 서명 인증서가 바뀌었으므로 브라우저에서 https://localhost:3000 을 열어 인증서 경고를 다시 수락하세요."
}

[[ $# -ge 1 ]] || usage
valid_name "$CERT_NAME" || { echo "[dev-cert] DEV_CERT_FILE 은 폴더 없는 파일 이름(영문·숫자·._-, .pem)이어야 합니다" >&2; exit 2; }
valid_name "$KEY_NAME" || { echo "[dev-cert] DEV_KEY_FILE 은 폴더 없는 파일 이름(영문·숫자·._-, .pem)이어야 합니다" >&2; exit 2; }
[[ "$CERT_NAME" != "$KEY_NAME" ]] || { echo "[dev-cert] DEV_CERT_FILE 과 DEV_KEY_FILE 이 같습니다" >&2; exit 2; }
cmd="$1"
shift
case "$cmd" in
  check) cmd_check "$@" ;;
  renew) cmd_renew "$@" ;;
  -h | --help | help) usage ;;
  *) usage ;;
esac
