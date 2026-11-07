#!/usr/bin/env bash
# FIX4-T21P2(Codex review-FIX3-T21P2 P0 tests/lib.sh:7): 시험 실행기는 root 로 돌지 않는다.
# root 면 시험 경로 바꿔치기가 무시되어(lib/common.sh cs_test_mode) 운영 데이터를 건드릴 수 있으므로 **다른 어떤 일보다 먼저** 중단한다.
# lib.sh·run-all.sh 의 첫 명령이 이 파일을 source 하고 cs_harness_refuse_root "$EUID" 를 부른다($EUID 는 bash 내장 읽기 전용 — 속일 수 없음).
cs_harness_refuse_root() {
  if [[ "$1" -eq 0 ]]; then
    echo "[deploy-tests] 중단: root 로 시험을 실행하지 않습니다(운영 경로를 건드릴 수 있음). 일반 사용자로 실행하세요." >&2
    exit 2
  fi
}
