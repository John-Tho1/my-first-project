#!/usr/bin/env bash
# Content Studio — 지정한 커밋을 서버에서 빌드한다(T21-P2 · FIX1 · FIX2, 실제 서버에서 실행한 적 없음 — bash -n·로컬 stub 시험만).
# 사용(서비스 사용자로, 서비스를 멈춘 뒤):
#   sudo systemctl stop content-studio
#   sudo -u content-studio -H bash /srv/content-studio/repo/Content_Studio_Execution_Pack/deploy/scripts/build-release.sh <40자리 SHA>
#   처음 설치(아직 unit 을 등록하지 않음): ... build-release.sh --first-install <40자리 SHA>
# 어느 단계든 실패하면 즉시 멈추고 0 이 아닌 종료 코드로 끝난다(이전 코드를 빌드하는 일이 없게).
# 경로: 저장소 루트(git checkout) = CS_REPO_ROOT(기본 /srv/content-studio/repo), 앱 루트 = <저장소 루트>/Content_Studio_Execution_Pack.
set -euo pipefail
umask 022
CS_SCRIPT_TAG=build-release
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

FIRST_INSTALL=0
if [[ "${1:-}" == "--first-install" ]]; then
  FIRST_INSTALL=1
  shift
fi
[[ $# -eq 1 ]] || die "인수는 [--first-install] <커밋 SHA(40자리 16진수)> 입니다"
SHA="$1"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "SHA 는 40자리 소문자 16진수여야 합니다(짧은 SHA·브랜치 이름 금지)"

REPO_ROOT="$(cs_path CS_REPO_ROOT /srv/content-studio/repo)" || exit 1
APP_ROOT="$REPO_ROOT/Content_Studio_Execution_Pack"
SERVICE_USER="$(cs_opt CS_SERVICE_USER content-studio)" # FIX3: CS_* 는 시험 표식이 있을 때만(lib/common.sh)

[[ "$(id -un)" == "$SERVICE_USER" ]] || die "서비스 사용자($SERVICE_USER)로 실행하세요"
# FIX2-T21P2: systemd 가 멈춤(inactive/failed)을 확인해 줄 때만 진행 — 조회 실패·systemctl 없음·activating 등은 중단(lib/common.sh)
cs_lock # FIX4: 배포 스크립트끼리 동시 실행 금지
require_service_stopped content-studio.service "$FIRST_INSTALL"
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
