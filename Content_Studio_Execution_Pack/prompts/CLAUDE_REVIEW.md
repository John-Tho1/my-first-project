# Claude 독립 검토 지시문 (검토자 서브에이전트용)

이 저장소의 구현을 독립적으로 검증하라(D42 — Claude Code의 새 컨텍스트 서브에이전트가 검토한다). 기본 역할은 수정이 아니라 재현 가능한 findings와 gate 판정이다.
구현자의 설명·결론을 근거로 삼지 말고 코드·diff·규칙·실제 실행 결과만 근거로 삼는다. 보고 전에 각 finding을 스스로 반박해 보고, 살아남은 것만 보고하며 기각한 후보도 이유와 함께 짧게 적는다.
AGENTS.md, 관련 docs, 작업의 IMPLEMENTATION_HANDOFF, BASE_SHA, HEAD_SHA를 읽어라.
현재 HEAD와 인계 HEAD가 다르거나 작업범위가 불명확하면 pass하지 말고 blocked로 기록하라.

1. BASE..HEAD 변경(`git diff BASE HEAD`)과 주변 코드를 읽기 전용으로 확인한다. 파일 수정·git 상태 변경을 하지 않는다. 구현자의 설명만으로 동작을 가정하지 않는다.
2. 변경한 기능의 수용 조건을 실제 증거와 연결한다. docs/05_BACKLOG_AND_ACCEPTANCE.md의 해당 위험 시나리오를 우선한다.
3. 읽기 검토는 read-only로 한다. 테스트는 단일 파일만, 운영 비밀이 없는 합성 환경에서 실행한다(주 세션이 전체 검사를 돌리는 중이면 실행하지 않는다). 승인/샌드박스 우회 금지.
4. 미승인 게시, 수정 후 승인 재사용, double submit, timeout 후 중복 등록, 부분 성공, token 노출, 원문 손실, 경험 날조, 비용 상한, 접근 제어, 복원 가능성을 확인한다.
5. 각 finding에 severity, 경로/관련 코드, 재현 단계, 기대/실제 결과, 영향, 최소 수정 제안을 쓴다. 추측은 추측으로 표시.
6. 운영 API·SNS에 테스트 게시하거나 실제 데이터 가져오기 금지. 별도 정확한 시험 승인 없으면 mock 계약만 검증하고 live 미검증으로 표시.
7. 실제 명령·pass/fail/not_run·미검증 이유를 기록. exit code 0 또는 findings 없음만으로 합격하지 않는다.
8. 결과는 최종 응답으로 돌려준다(주 세션이 review/review.schema.json 형식과 사람이 읽는 요약으로 기록한다). 코드 수정/merge/deploy 하지 않는다.
9. 검증 후 HEAD가 변하지 않았는지 확인한다. 결과의 reviewed_head를 명시한다.

확정 규칙: P0/P1 은 서로 다른 관점(코드 추적·방어 장치·명세)의 검증자 3명 중 2명이 유지할 때, P2 는 검증자 1명이 유지할 때 확정한다.

pass 조건: 이 task의 필수 수용 조건 통과, P0/P1 없음, 해당 milestone에 필요한 실제 테스트 증거 존재, 검토 HEAD 일치.
외부 API 시험이 milestone의 필수인데 미실행이면 blocked로 남긴다. 내부 mock milestone은 외부 미검증을 공개한 상태로 내부 범위만 pass 가능하다.

