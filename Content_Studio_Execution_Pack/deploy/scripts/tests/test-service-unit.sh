#!/usr/bin/env bash
# FIX2-FULLREV2(G33): systemd unit(deploy/content-studio.service)이 데이터 볼륨이 빠진 채 시작하지 않는지 — systemctl·실제 마운트 없이 파일만 본다.
#  - [Unit] 에 RequiresMountsFor=/srv/content-studio/data
#  - [Service] ExecStartPre 표시 검사: 그 줄의 명령을 그대로 꺼내 운영 경로만 시험 임시 폴더로 바꾸고 가짜 mountpoint 로 실행한다
#    (표시 없음 → 통과, 표시 있음 + 마운트 아님 → 실패, 표시 있음 + 마운트 → 통과, mountpoint 오류·없음 → 실패).
source "$(dirname "$0")/lib.sh"

UNIT="$SCRIPTS_DIR/../content-studio.service"

echo "content-studio.service 마운트 요구"
t "[Unit] 에 RequiresMountsFor=/srv/content-studio/data"
unit_section="$(sed -n '/^\[Unit\]/,/^\[/p' "$UNIT")"
expect_contains "$unit_section" $'\nRequiresMountsFor=/srv/content-studio/data'
t "ReadWritePaths 의 데이터 폴더와 같은 경로"
expect_contains "$(grep '^ReadWritePaths=' "$UNIT")" "/srv/content-studio/data "

pre_lines="$(grep -c '^ExecStartPre=' "$UNIT")"
t "[Service] 에 ExecStartPre 표시 검사가 정확히 하나, ExecStart 보다 앞"
expect_rc 1 "$pre_lines" "ExecStartPre 줄 수"
service_section="$(sed -n '/^\[Service\]/,/^\[/p' "$UNIT")"
pre_at="$(grep -n '^ExecStartPre=' <<<"$service_section" | cut -d: -f1)"
start_at="$(grep -n '^ExecStart=' <<<"$service_section" | cut -d: -f1)"
if [[ -n "$pre_at" && -n "$start_at" && "$pre_at" -lt "$start_at" ]]; then ok "ExecStartPre $pre_at < ExecStart $start_at"; else ng "ExecStartPre 가 [Service] 의 ExecStart 앞에 없음"; fi

# ExecStartPre=+/bin/sh -c '<명령>' 에서 <명령>을 꺼낸다(작은따옴표 안)
pre="$(grep '^ExecStartPre=' "$UNIT" | head -1)"
cmd="${pre#*\'}"
cmd="${cmd%\'*}"
t "검사 명령이 표시 파일·데이터 폴더·mountpoint 를 쓴다"
expect_contains "$cmd" "/srv/content-studio/.data-must-be-mount"
expect_contains "$cmd" "mountpoint -q /srv/content-studio/data"
FAKE_SRV="$T_ROOT/srv-unit"
mkdir -p "$FAKE_SRV/data"
fake_cmd="${cmd//\/srv\/content-studio/$FAKE_SRV}"
t "운영 경로가 모두 시험 경로로 바뀜"
expect_not_contains "$fake_cmd" "/srv/content-studio"
run_pre() { env PATH="$STUB_BIN:$PATH" "$@" /bin/sh -c "$fake_cmd"; }

rm -f "$FAKE_SRV/.data-must-be-mount"
t "표시 없음 + 마운트 아님 → 시작 허용(rc 0)"
run_capture r run_pre
expect_rc 0 "$r_rc" "$r_out"
: >"$FAKE_SRV/.data-must-be-mount"
t "표시 있음 + 데이터 폴더가 마운트 아님(볼륨 빠짐) → 시작 거부"
run_capture r run_pre
expect_nonzero "$r_rc" "$r_out"
t "표시 있음 + 데이터 폴더가 마운트 지점 → 시작 허용"
run_capture r run_pre STUB_MOUNTPOINT="$FAKE_SRV/data"
expect_rc 0 "$r_rc" "$r_out"
t "표시 있음 + mountpoint 오류 → 시작 거부"
run_capture r run_pre STUB_MOUNTPOINT="$FAKE_SRV/data" STUB_MOUNTPOINT_FAIL=1
expect_nonzero "$r_rc" "$r_out"
t "표시 있음 + mountpoint 명령 없음 → 시작 거부"
run_capture r env PATH="$T_ROOT/empty-bin" /bin/sh -c "$fake_cmd"
expect_nonzero "$r_rc" "$r_out"

finish
