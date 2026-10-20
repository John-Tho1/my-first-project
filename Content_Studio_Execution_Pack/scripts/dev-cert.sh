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
#       renew 는 새 키·인증서를 같은 폴더의 임시 파일에 다 만들고 검사한 뒤에만 기존 파일을 백업(backup-YYYYMMDD-HHMMSS[-n]/ 에 복사)하고
#       키 → 인증서 순서로 이름을 바꿔(rename) 넣는다. 만들기·검사·백업 중에 실패하면 기존 파일은 그대로다.
#       두 이동 사이에서 실패하거나 멈추면(오류·INT/TERM/HUP) 백업에서 기존 키를 되돌려(기존 키가 없었으면 새 키를 지워) 갱신 전 상태로
#       돌아간다. 되돌리지도 못하면 새 키와 짝인 새 인증서 임시 파일을 지우지 않고 경로와 옮길 명령을 알려 준다(짝이 어긋난 채 끝나지 않게).
#       백업 폴더에는 예전 개인 키도 들어 있으니 data/ 밖으로 옮기지 않는다.
#       DEV_CERT_FILE·DEV_KEY_FILE 은 대소문자만 달라도 같은 파일로 보고 거부한다(Git Bash 의 NTFS·macOS 기본 APFS 는 대소문자를 가리지 않음).
#       두 이름은 점(.)으로 시작할 수 없다(숨김 파일은 백업의 *.pem 에 잡히지 않아 예전 키가 백업 없이 덮어써진다). 백업에 바꿀 키·인증서가 없으면
#       (대소문자 무시 파일 시스템의 다른 대소문자 확장자 등) 바꾸기 전에 멈춘다 — 되돌리기는 그 백업에 기댄다.
#       정리·되돌리기(EXIT trap·이동 실패)는 errexit 를 끄고 SIGPIPE 를 무시한 채 끝까지 한다 — 터미널을 닫아 stderr 쓰기가 실패해도 되돌린다.
# 종료 코드: 0 성공 · 1 실행 실패(openssl 없음·파일 없음·읽기/생성/바꾸기 실패) · 2 사용법 오류 · 129/130/143 신호로 중단(HUP/INT/TERM)
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

# FIX2-EXPIRY1: 첫 글자는 점이 아니다(숨김 파일 — 백업 glob *.pem 에서 빠진다).
valid_name() { [[ "$1" =~ ^[A-Za-z0-9_-][A-Za-z0-9._-]*\.pem$ ]]; }

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
# 정리할 때 지우지 않을 임시 파일(되돌리기에 실패해 새 키와 짝인 새 인증서를 남길 때만 채운다)
KEEP_FILE=""

# ---- renew 의 바꾸기(키 → 인증서 이동) 상태 — 실패·중단 시 되돌리기용 ----
# SWAP_STATE: "" → key_moving → key_moved → cert_moving → done.  되돌리기: rolling_back → rolled_back | stuck
SWAP_STATE=""
SWAP_TMP_KEY="" SWAP_TMP_CERT="" SWAP_KEY="" SWAP_CERT="" SWAP_BACKUP="" SWAP_HAD_KEY=0

# 이동 중(key_moving·cert_moving)에 멈췄으면 임시 파일이 아직 있는지로 실제 이동 여부를 정한다(rename 은 한 번에 일어나거나 안 일어남).
swap_settle() {
  case "$SWAP_STATE" in
    key_moving) if [[ -e "$SWAP_TMP_KEY" ]]; then SWAP_STATE=""; else SWAP_STATE=key_moved; fi ;;
    cert_moving) if [[ -e "$SWAP_TMP_CERT" ]]; then SWAP_STATE=key_moved; else SWAP_STATE=done; fi ;;
  esac
  return 0
}

# 키만 바뀐 상태(key_moved)를 갱신 전으로 되돌린다. 기존 키가 있었으면 백업 사본을 같은 폴더 임시 파일로 복사한 뒤 rename
# (반쯤 쓴 키가 제자리에 놓이지 않게), 없었으면 새 키를 지운다. 인증서는 아직 바뀌지 않았다(인증서 임시 파일이 남아 있음).
# 성공 0 — 새 키가 사라졌으니 새 인증서 임시 파일은 정리 대상 그대로.
# 실패 1 — 새 키가 제자리에 남았으므로 짝인 새 인증서 임시 파일을 지우지 않고(KEEP_FILE) 경로·옮길 명령을 알린다.
rollback_swap() {
  swap_settle
  [[ "$SWAP_STATE" == key_moved ]] || return 0
  SWAP_STATE=rolling_back
  local tmp_restore=""
  if [[ "$SWAP_HAD_KEY" == 1 ]]; then
    if [[ -n "$SWAP_BACKUP" && -f "$SWAP_BACKUP/$KEY_NAME" ]] &&
      tmp_restore="$(mktemp "$DIR/.restore-key.XXXXXX")" &&
      TMP_FILES+=("$tmp_restore") &&
      cp -p -- "$SWAP_BACKUP/$KEY_NAME" "$tmp_restore" &&
      mv -f -- "$tmp_restore" "$SWAP_KEY"; then
      SWAP_STATE=rolled_back
      echo "[dev-cert] 되돌렸습니다: 기존 개인 키를 백업($SWAP_BACKUP)에서 제자리에 두었습니다 — 인증서·키는 갱신 전 그대로입니다." >&2
      return 0
    fi
  elif rm -f -- "$SWAP_KEY"; then
    SWAP_STATE=rolled_back
    echo "[dev-cert] 되돌렸습니다: 새 개인 키를 지웠습니다(갱신 전에는 키 파일이 없었음) — 인증서·키는 갱신 전 그대로입니다." >&2
    return 0
  fi
  SWAP_STATE=stuck
  KEEP_FILE="$SWAP_TMP_CERT"
  echo "[dev-cert] 기존 개인 키를 되돌리지 못했습니다. 지금 $SWAP_KEY 는 새 키이고, 짝이 맞는 새 인증서를 $SWAP_TMP_CERT 에 남겨 두었습니다." >&2
  echo "[dev-cert] 해결: mv -f -- \"$SWAP_TMP_CERT\" \"$SWAP_CERT\"  (새 키·인증서로 맞춤) — 또는 ${SWAP_BACKUP:-백업 폴더}의 파일을 복사해 갱신 전으로 되돌리세요." >&2
  return 1
}

# 두 이동 중 하나가 실패했을 때: 되돌리고 결과를 알린 뒤 exit 1. 되돌리는 동안 신호(두 번째 Ctrl+C 등)는 무시해 끝까지 한다.
swap_fail() {
  # FIX2-EXPIRY1: errexit 를 끄고(이 함수는 `mv … || swap_fail` 의 마지막 명령이라 errexit 가 켜진 채 돈다) SIGPIPE 도 무시한다 — 끊긴 터미널(EIO)·
  # 닫힌 stderr·읽는 쪽이 끝난 파이프에 대한 echo 실패가 되돌리기 전에 셸을 끝내지 않게. 메시지는 실패해도 되돌리기·exit 1 은 그대로.
  set +e
  trap '' HUP INT TERM PIPE
  echo "[dev-cert] 오류: $1" >&2
  rollback_swap || exit 1
  case "$SWAP_STATE" in
    "" | rolled_back) echo "[dev-cert] 기존 파일은 그대로입니다${SWAP_BACKUP:+(백업 $SWAP_BACKUP)}." >&2 ;;
    done) echo "[dev-cert] 이동은 끝났습니다 — 새 키·인증서가 제자리에 있습니다. bash scripts/dev-cert.sh check 로 확인하세요." >&2 ;;
  esac
  exit 1
}

cleanup() {
  # FIX2-EXPIRY1: EXIT trap 안에서도 errexit 는 켜져 있다 — 끄지 않으면 stderr 쓰기 실패(터미널을 닫아 끊긴 tty 의 EIO 등) 한 번에 되돌리기·임시 파일
  # 정리 전에 셸이 rc 1 로 끝나 짝이 어긋난 채(새 키 + 예전 인증서) 남는다. SIGPIPE 도 무시한다(읽는 쪽이 끝난 파이프로 가는 stderr).
  set +e
  local f
  # 정리·되돌리기는 끝까지 한다 — 그동안 들어온 신호(두 번째 Ctrl+C·TERM)는 무시(종료 코드는 처음 멈춘 이유 그대로).
  trap '' HUP INT TERM PIPE
  # 두 이동 사이에서 멈춤(신호·예상 못 한 종료) → 되돌린다. 되돌리는 도중에 멈췄으면 새 인증서를 남긴다(새 키가 제자리일 수 있음).
  case "$SWAP_STATE" in
    key_moving | key_moved | cert_moving)
      echo "[dev-cert] 중단: 키와 인증서를 바꾸는 도중에 멈췄습니다." >&2
      rollback_swap || true
      ;;
    rolling_back)
      KEEP_FILE="$SWAP_TMP_CERT"
      echo "[dev-cert] 중단: 되돌리는 도중에 멈췄습니다. 새 키와 짝인 새 인증서를 $SWAP_TMP_CERT 에 남겨 두었습니다 — ${SWAP_BACKUP:-백업 폴더}와 비교해 직접 정리하세요." >&2
      ;;
  esac
  for f in "${TMP_FILES[@]+"${TMP_FILES[@]}"}"; do
    [[ -n "$KEEP_FILE" && "$f" == "$KEEP_FILE" ]] && continue
    rm -f -- "$f"
  done
}
trap cleanup EXIT
# 신호로 멈춰도 EXIT 정리(위 되돌리기 포함)를 거치게 명시한다(bash·Git Bash 공통).
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

cmd_renew() {
  [[ $# -le 1 ]] || usage
  local days="${1:-$DEFAULT_DAYS}"
  [[ "$days" =~ ^[0-9]{1,4}$ ]] || usage
  days=$((10#$days))
  ((days >= 1 && days <= MAX_DAYS)) || usage
  need_openssl

  mkdir -p -- "$DIR" || die "인증서 폴더를 만들지 못했습니다: $DIR"
  local cert="$DIR/$CERT_NAME" key="$DIR/$KEY_NAME" target
  # 자리가 폴더 등 일반 파일이 아니면 mv 가 그 안으로 옮겨 버린다 — 아무것도 만들기 전에 멈춘다.
  for target in "$key" "$cert"; do
    [[ ! -e "$target" || -f "$target" ]] || die "일반 파일이 아닙니다: $target. 기존 파일은 그대로입니다."
  done
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

  # FIX2-EXPIRY1(방어): 바꿀 키·인증서가 백업에 없으면(대소문자 무시 파일 시스템에서 *.pem 이 다른 대소문자 확장자를 놓치는 등) 되돌리기의 전제가
  # 없으므로 아무것도 옮기기 전에 멈춘다(예전 키를 백업 없이 덮어쓰지 않음).
  if [[ -f "$key" ]] && ! [[ -n "$backup" && -f "$backup/$KEY_NAME" ]]; then
    die "백업에 기존 개인 키가 없어 바꾸지 않았습니다($key → ${backup:-백업 없음}). 기존 파일은 그대로입니다."
  fi
  if [[ -f "$cert" ]] && ! [[ -n "$backup" && -f "$backup/$CERT_NAME" ]]; then
    die "백업에 기존 인증서가 없어 바꾸지 않았습니다($cert → ${backup:-백업 없음}). 기존 파일은 그대로입니다."
  fi

  # 5) 바꾸기(같은 폴더 안 rename — 키 먼저, 그다음 인증서). 둘째 이동이 실패하거나 그 사이에 멈추면 rollback_swap 이 되돌린다.
  SWAP_TMP_KEY="$tmp_key" SWAP_TMP_CERT="$tmp_cert" SWAP_KEY="$key" SWAP_CERT="$cert" SWAP_BACKUP="$backup" SWAP_HAD_KEY=0
  if [[ -f "$key" ]]; then SWAP_HAD_KEY=1; fi
  SWAP_STATE=key_moving
  mv -f -- "$tmp_key" "$key" || swap_fail "새 개인 키를 제자리에 두지 못했습니다."
  SWAP_STATE=cert_moving
  mv -f -- "$tmp_cert" "$cert" || swap_fail "새 인증서를 제자리에 두지 못했습니다."
  SWAP_STATE=done
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
# 이름 검사(valid_name). 거부 문구만 경우에 따라 다르다 — 점으로 시작하면 그 이유를 말한다(FIX2-EXPIRY1).
for name_var in DEV_CERT_FILE:"$CERT_NAME" DEV_KEY_FILE:"$KEY_NAME"; do
  valid_name "${name_var#*:}" && continue
  if [[ "${name_var#*:}" == .* ]]; then
    echo "[dev-cert] ${name_var%%:*} 은 점(.)으로 시작할 수 없습니다(숨김 파일은 백업에서 빠짐): ${name_var#*:}" >&2
  else
    echo "[dev-cert] ${name_var%%:*} 은 폴더 없는 파일 이름(영문·숫자·._-, 점으로 시작하지 않음, .pem)이어야 합니다" >&2
  fi
  exit 2
done
# 인증서·키가 같은 파일이면 안 된다(인증서 이동이 새 키를 덮어씀) — 대소문자만 다른 이름도 같은 파일로 본다: Git Bash 의 NTFS·macOS 기본
# APFS 는 대소문자를 가리지 않아 Localhost.pem 과 localhost.pem 이 한 파일이다. 이름에는 폴더·"/"가 들어올 수 없어(valid_name)
# "./x.pem"·"x.pem/" 꼴은 위에서 이미 사용법 오류이고, 두 파일은 같은 DIR 안이라 이름만 비교하면 된다.
# nocasematch(bash 3.1+) — 외부 명령(tr 등)이 없어도 동작한다.
same_name_ci() {
  local rc=1
  shopt -s nocasematch
  [[ "$1" == "$2" ]] && rc=0
  shopt -u nocasematch
  return "$rc"
}
if same_name_ci "$CERT_NAME" "$KEY_NAME"; then
  echo "[dev-cert] DEV_CERT_FILE 과 DEV_KEY_FILE 이 같은 파일입니다(대소문자만 다른 이름도 같은 파일로 봄): $CERT_NAME / $KEY_NAME" >&2
  exit 2
fi
cmd="$1"
shift
case "$cmd" in
  check) cmd_check "$@" ;;
  renew) cmd_renew "$@" ;;
  -h | --help | help) usage ;;
  *) usage ;;
esac
