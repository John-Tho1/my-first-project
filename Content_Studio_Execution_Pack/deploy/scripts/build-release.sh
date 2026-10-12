#!/usr/bin/env bash
# Content Studio — 지정한 커밋을 서버에서 빌드한다(T21-P2 · FIX1, 실제 서버에서 실행한 적 없음 — bash -n 만 확인).
# 사용(서비스 사용자로, 서비스를 멈춘 뒤):
#   sudo systemctl stop content-studio
#   sudo -u content-studio -H bash /srv/content-studio/repo/Content_Studio_Execution_Pack/deploy/scripts/build-release.sh <40자리 SHA>
# 어느 단계든 실패하면 즉시 멈추고 0 이 아닌 종료 코드로 끝난다(이전 코드를 빌드하는 일이 없게).
# 경로: 저장소 루트(git checkout) = CS_REPO_ROOT(기본 /srv/content-studio/repo), 앱 루트 = <저장소 루트>/Content_Studio_Execution_Pack.
set -euo pipefail
umask 022

die() {
  echo "[build-release] 실패: $*" >&2
  exit 1
}

[[ $# -eq 1 ]] || die "인수는 커밋 SHA 하나(40자리 16진수)입니다"
SHA="$1"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "SHA 는 40자리 소문자 16진수여야 합니다(짧은 SHA·브랜치 이름 금지)"

REPO_ROOT="${CS_REPO_ROOT:-/srv/content-studio/repo}"
APP_ROOT="$REPO_ROOT/Content_Studio_Execution_Pack"
SERVICE_USER="${CS_SERVICE_USER:-content-studio}"

[[ "$(id -un)" == "$SERVICE_USER" ]] || die "서비스 사용자($SERVICE_USER)로 실행하세요"
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet content-studio; then
  die "content-studio 서비스가 실행 중입니다 — 먼저 멈추세요(실행 중인 서버가 읽는 .next 를 덮어쓰지 않게)"
fi
[[ -d "$REPO_ROOT/.git" ]] || die "저장소 루트가 아닙니다: $REPO_ROOT"

cd "$REPO_ROOT"
git diff --quiet || die "추적 파일에 커밋되지 않은 변경이 있습니다"
git diff --cached --quiet || die "스테이징된 변경이 있습니다"
git fetch --quiet origin || die "git fetch 실패"
git cat-file -e "${SHA}^{commit}" || die "커밋을 찾을 수 없습니다: $SHA"
git checkout --quiet --detach "$SHA" || die "checkout 실패"
HEAD_SHA="$(git rev-parse HEAD)"
[[ "$HEAD_SHA" == "$SHA" ]] || die "checkout 뒤 HEAD($HEAD_SHA)가 요청 SHA 와 다릅니다"

[[ -f "$APP_ROOT/pnpm-workspace.yaml" ]] || die "앱 루트가 아닙니다: $APP_ROOT"
cd "$APP_ROOT"
# next.config 는 앱 루트의 .env / .env.local 을 읽는다 — 서버 설정은 /etc/content-studio/env 하나뿐이어야 한다
for f in .env .env.local; do
  [[ ! -e "$f" ]] || die "$APP_ROOT/$f 가 있습니다 — 지우세요(설정은 /etc/content-studio/env 만)"
done

corepack pnpm install --frozen-lockfile || die "pnpm install --frozen-lockfile 실패"
corepack pnpm build || die "pnpm build 실패"
[[ -f "$APP_ROOT/apps/web/.next/BUILD_ID" ]] || die "빌드 결과(apps/web/.next/BUILD_ID)가 없습니다"

echo "[build-release] BUILD_OK sha=$HEAD_SHA app_root=$APP_ROOT"
