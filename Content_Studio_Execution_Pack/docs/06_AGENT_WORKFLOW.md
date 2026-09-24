# Claude Code 구현 → Codex 검증 → Claude Code 수정
이번 계획은 사용자가 지정한 개발 방식이다. 기존 PC 연결·설정의 정상 동작을 확인했다는 뜻은 아니다.

## 1. 공유 계약
공통 규칙은 AGENTS.md. CLAUDE.md는 @AGENTS.md를 가져오고 구현 역할만 추가한다.
작업마다 task ID·목표·수용 조건·변경 범위·제외 범위·BASE_SHA·HEAD_SHA·테스트 결과를 인계한다.
두 에이전트가 같은 작업 폴더에서 동시에 파일을 수정하지 않는다.
검증은 읽기 중심. 재현을 위한 테스트 파일/빌드 산출물은 별도의 disposable worktree에서만. 구현 수정이 필요하면 Claude에게 findings를 돌려준다.

## 2. 작은 PR 루프
1. Claude는 tasks.json에서 선행 작업이 충족된 한 작업을 선택.
2. 기존 지시문과 코드를 읽고 최소 변경계획을 제시한 뒤 해당 작업을 구현. 처음부터 모든 milestone을 한 번에 만들지 않음.
3. 실제 test/build 결과와 미실행 이유 기록. 코드 commit 후 HEAD SHA 고정.
4. templates/IMPLEMENTATION_HANDOFF.md 작성. .handoffs/ 또는 저장소 밖에 보관해 HEAD를 다시 바꾸지 않음.
5. Codex는 BASE/HEAD·diff·test 로그·수용 조건을 읽고 검증.
6. P0/P1 및 해당 gate의 필수 실패는 수정 후 재검증. P2는 수정하거나 사용자에게 잔여 위험으로 기록.
7. 수정 commit이 생기면 새 HEAD로 검증. 과거 pass는 새 commit을 승인하지 않음.
8. merge/production deploy는 검토 결과와 구체 변경을 확인한 사용자의 승인 범위에서 수행.
코딩 단계에서 외부 API/게시 승인이 없어도 mock로 내부 구현을 계속한다.

## 3. 격리된 검증 예시
다음은 사용자 개발 PC에서 사용할 예시이며 이 환경에서는 실행하지 않았다.
placeholder를 실제 SHA/작업 ID로 교체하고 기존 이름과 충돌하지 않는지 확인한다.

~~~bash
git status --short
git rev-parse HEAD
git branch review-base/T03 BASE_SHA
git worktree add --detach ../content-studio-review-T03 HEAD_SHA
~~~

BASE_SHA/HEAD_SHA는 문자 그대로 실행하지 말고 인계에 적힌 실제 commit hash로 교체.
그 다음 review worktree로 이동해 CLI 도움말 확인 후:

~~~bash
codex --help
codex review --help
codex --sandbox read-only review --base review-base/T03
~~~

--base, --commit, --uncommitted, custom prompt를 섞지 않는다. 누적 작업 검증은 --base, 단일 commit 검증은 --commit의 의미를 구분한다. 설치 버전이 다르면 --help에 맞춰 조정하고 기록한다.

프로젝트 요구사항/검증 보고서가 필요하면 Codex 대화에 prompts/CODEX_REVIEW.md와 인계 기록을 제공한다. 비대화형 구조화 보고서는 codex exec의 --output-schema와 --output-last-message를 사용할 수 있으나, 설치 버전 도움말·실제 JSON 검증 후 자동화한다.
CLI 종료 코드 0만으로 합격 처리하지 않는다. 보고서의 reviewed_head·수용 조건·실제 테스트 증거를 확인한다.

## 4. 검증 두 모드
- 코드 검토: read-only sandbox, diff와 설계·인계 기록 확인. credentials 없는 환경.
- 동작 검증: owner가 준비한 disposable worktree/container에서 의존성·DB fixture를 준비하고 테스트. 산출물 쓰기가 필요하므로 read-only 코드 검토와 구분. 운영 DB/API/계정은 연결하지 않는다.
두 모드 모두 sandbox/approval 우회 플래그를 사용하지 않는다. 차단되면 필요한 접근과 이유를 보고하고 가능한 읽기·모의 테스트를 계속한다.

## 5. 자동 협업은 후속 단계
처음 2~3개 작업은 수동 인계로 report 품질과 명령을 확정한다.
이후 로컬 명령 또는 CI가 테스트→Codex review→report 저장을 실행하게 할 수 있다. 이 실행은 명시적으로 시작한 작업에 한하며 반복 호출 상한·비용·timeout을 둔다.
자동 merge·무한 자기 수정 루프·리뷰 모델의 승인만으로 운영 배포는 하지 않는다.
Codex 리뷰가 unavailable이면 “미검증”으로 남긴다. Claude의 자체 리뷰를 Codex 결과라고 표기하지 않는다.

## 6. 구조화 보고서
review/review.schema.json에 형식을 제공한다. verdict=pass/fail/blocked, 검토한 HEAD, findings, 실제 실행한 테스트, 미실행 테스트와 이유, 공개/외부 호출 유무.
형식이 유효하다는 사실은 검토가 정확하다는 증거가 아니다. P0/P1=0, 필수 조건 pass, HEAD 일치, 별도 실제 승인이라는 gate를 확인한다.

