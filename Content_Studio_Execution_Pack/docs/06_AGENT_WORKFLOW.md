# Claude Code 구현 → Claude 독립 검토 → Claude Code 수정
2026-11-07 사용자 결정(D42): **Codex 를 쓰지 않는다.** 구현·독립 검토·수정·재검토를 모두 Claude Code 에서 진행한다.
독립성은 도구를 바꾸는 대신 **새 컨텍스트·읽기 전용 검토자 서브에이전트**와 **반박(refute) 절차**로 확보한다.

## 1. 공유 계약
공통 규칙은 AGENTS.md. CLAUDE.md 는 @AGENTS.md 를 가져오고 구현·검토 역할을 더한다.
작업마다 task ID·목표·수용 조건·변경 범위·제외 범위·BASE_SHA·HEAD_SHA·테스트 결과를 인계한다(templates/IMPLEMENTATION_HANDOFF.md).
두 에이전트가 같은 작업 트리에서 동시에 파일을 수정하지 않는다. 구현자는 차례로 일하고, 검토자는 읽기 전용이라 동시에 돌려도 된다.

## 2. 작은 작업 루프
1. 주 세션은 tasks.json·사용자 지시에서 한 작업(또는 확정 지적 묶음)을 고른다.
2. 기존 지시문과 코드를 읽고 최소 변경계획을 세운 뒤 구현한다. 범위가 크면 겹치지 않는 묶음으로 나눠 구현 서브에이전트에게 **하나씩 차례로** 맡긴다. 구현자 규칙:
   - git 상태 변경·커밋 금지
   - 단일 시험 파일만 실행
   - 제품 변경마다 변이 확인(되돌리면 새 시험이 실패 → 원복 뒤 cmp)
   - 새 의존성·외부 호출·실계정 금지
   - 단언 약화 금지
3. **독립 검토**(prompts/CLAUDE_REVIEW.md): 영역별 검토자 서브에이전트를 새 컨텍스트로 띄운다.
   - 검토자에게는 대상 diff 를 얻는 명령, 적용 규칙, 이미 받아들인 위험(DECISIONS 결과·인계 '남은 위험')만 주고, 구현자의 결론은 주지 않는다.
   - 검토자는 지적마다 스스로 반박을 시도하고, 살아남은 것만 파일:줄·재현 시나리오·수정 제안과 함께 보고한다.
4. **확정 규칙**: P0·P1 은 서로 다른 관점(코드 추적·방어 장치·명세)의 검증자 3명 중 2명이 유지할 때, P2 는 검증자 1명이 유지할 때 확정한다. 기각한 지적과 이유도 기록한다.
5. **보완**(prompts/CLAUDE_FIX.md): 주 세션이 확정 지적을 코드로 재현한 뒤 고친다(직접 또는 보완 서브에이전트). 보완분은 새 검토자로 짧게 재검토한다. 재검토에서 확정된 것도 같은 방식으로 처리한다.
6. **전체 검사**를 최종 트리에서 순차로 돌리고, 단계별 종료코드를 근거로 삼는다. 묶음 스크립트의 종료코드는 근거가 아니다.
   - install --frozen-lockfile(lockfile 불변), lint, typecheck, build, unit, integration, drill:mock, test-dev-cert.sh
   - deploy 셸 시험 `bash deploy/scripts/tests/run-all.sh` — root 로는 거부한다(guard.sh). 클라우드 컨테이너처럼 root 셸이면 `setpriv --reuid=nobody --regid=nogroup --clear-groups -- env HOME=/tmp TMPDIR=/tmp bash deploy/scripts/tests/run-all.sh` 로 비root 실행한다(저장소 권한을 넓히지 않는다 — 읽기 권한이 없으면 not_run 으로 남긴다). (FULLREV3 H7 — `TMPDIR=/tmp` 은 root 의 TMPDIR(비root 가 쓸 수 없는 경로)을 물려받지 않게)
   - 검사 중 파일이 바뀌었으면 결과를 쓰지 않고 다시 돌린다.
7. **gate**: 확정 P0/P1 = 0, 전체 검사 통과(같은 트리), 확정 P2 는 반영 또는 남은 위험으로 기록. 보이지 않는 문자 검사와 지워진 시험 줄 확인을 직접 한다.
8. 코드 커밋과 docs 전용 커밋(D28)을 나눈다. docs 커밋에는 인계 문서 절(BASE/HEAD 전체 SHA, 처리·시험·명령·남은 위험·검토자에게 물을 것)과 M4_STATUS 를 넣는다. 전체 SHA 는 `git rev-parse` 로 확인해 적는다(짐작 금지).
9. 새 커밋이 생기면 새 HEAD 로 다시 검증한다. 과거 pass 는 새 커밋을 승인하지 않는다.
10. merge/production deploy 는 검토 결과와 구체 변경을 확인한 사용자의 승인 범위에서만 한다.
코딩 단계에서 외부 API/게시 승인이 없어도 mock 으로 내부 구현을 계속한다.

## 3. 검토 대상 지정
- 커밋 하나: `git show <SHA>` / 범위: `git diff <BASE> <HEAD>` / 미커밋: `git diff HEAD` + 새 파일 목록.
- 검토자는 파일을 고치거나 git 상태를 바꾸지 않는다. 시험이 필요하면 단일 파일만 돌린다. 주 세션이 전체 검사를 돌리는 동안에는 CPU 경합을 피하려고 시험을 돌리지 않게 한다.
- 대량 검토(전체 코드 검토 등)는 영역별 검토자 → 지적별 검증자 파이프라인으로 돌린다(FULLREV1·FULLREV2 방식). 사용자가 다중 에이전트 실행을 승인한 경우에만 Workflow 로 오케스트레이션한다.

## 4. 검증 두 모드
- **코드 검토**: 읽기 전용. diff 와 설계·인계 기록을 확인한다. 자격 증명이 없는 환경에서 한다.
- **동작 검증**: 합성 데이터(scratch PGlite·임시 저장소)로 시험·브라우저 E2E(Playwright·Chromium, `pnpm dev`·모의 설정)를 돌린다. 운영 DB·API·계정은 연결하지 않고, `.env.local`·`./data` 는 쓰지 않는다.
두 모드 모두 권한·샌드박스 우회 옵션을 쓰지 않는다. 막히면 필요한 접근과 이유를 보고하고 가능한 읽기·모의 시험을 계속한다.

## 5. 표기 원칙
- 검토 결과는 "Claude 독립 검토"로 기록한다. 다른 도구의 판정이라고 표기하지 않는다.
- 검토자·구현자가 보고한 내용(변이 확인 수 등)과 주 세션이 직접 실행한 증거(전체 검사 결과)를 구분해 적는다.
- 실행하지 않은 것(실제 PostgreSQL 다중 연결·실계정·브라우저 종류·OS 등)은 not_run 으로 남긴다.

## 6. 구조화 보고서
review/review.schema.json 형식: verdict=pass/fail/blocked, 검토한 HEAD, findings, 실제 실행한 테스트, 미실행 테스트와 이유, 외부 호출 유무.
형식이 유효하다는 사실은 검토가 정확하다는 증거가 아니다. P0/P1=0, 필수 조건 pass, HEAD 일치, 별도 실제 승인이라는 gate 를 확인한다.

## 7. 이전 방식(기록)
2026-11-06 까지는 Claude Code 구현 → Codex(사용자 PC) 검증 방식이었다. 그 기록은 docs/handoffs/*CODEX* 와 CODEX_QUEUE.txt·CODEX_CHATGPT_PROMPTS.md 에 이력으로 남는다(D42 로 종료). Codex 실행 스크립트(codex-review-commit.sh·codex-review-queue.sh)와 상위 저장소의 codex 스크립트·설정은 삭제했다.
