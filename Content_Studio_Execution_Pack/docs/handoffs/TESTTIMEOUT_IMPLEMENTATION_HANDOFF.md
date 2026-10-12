# Implementation handoff — TEST-TIMEOUT (시험 전용)
- BASE 9afaedd → HEAD f71f7ad78c463cd2daf46104aa2e139dca5cd2f5 (test only). 구현: 오케스트레이터 직접.
- 문제: `packages/domain/src/imports-fix1.test.ts`(HTML 선형 처리 it.each)·`imports-fix3.test.ts`(round 3 선형성 it.each)가 전체 단위 실행(병렬 부하)에서 vitest 기본 5초 벽시계 제한에 걸려 판정 전에 끊김 — T21-P1a·FIX2-T21P1A·T21-P2 검사에서 반복(단독 실행은 통과).
- 변경: 두 it.each 의 시간 제한 인자만 30_000ms. 단언(글자당 걸음 ≤ 상수×입력, 크기 비율 대비 걸음 비율, CPU 시간 3회 최소 < 1초)은 그대로. 제곱 구현이면 걸음 수 단언이 16KB 에서 이미 실패한다는 기존 설계도 그대로.
- 검사: lint 0 · typecheck 0 · unit 61 파일 · 1458 통과(UNIT=0, 전체 실행).
- Codex 질문: 벽시계 제한 완화가 선형성 회귀를 숨길 가능성이 있는가(걸음 수 단언이 주 판정이라는 전제)?
