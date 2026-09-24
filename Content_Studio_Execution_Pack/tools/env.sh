#!/usr/bin/env bash
# 세션 전용 PATH 설정 (Git Bash). Node는 사용자 폴더 포터블 설치이며 시스템 PATH에는 등록하지 않았다.
#   source tools/env.sh
# 주의: corepack의 bash shim은 POSIX 경로를 요구하므로 cygpath로 변환한다.
NODE_DIR="$(cygpath -u "$LOCALAPPDATA")/Programs/node/node-v24.21.0-win-x64"
export PATH="$NODE_DIR:$PATH"
