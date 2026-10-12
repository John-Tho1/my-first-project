# Implementation handoff — LIVE-UI (D34 2단계 준비: 실제 모드 화면 문구)
- Task ID: LIVE-UI. BASE fb32a09 → HEAD a9898a650cd924e2a5360bead21a5e6b7a65e027 (code only, D28). 구현: 오케스트레이터 직접(작은 화면 수정).
- 발견: LLM_MODE=live 로 dev 서버를 띄워 확인하니 작성 보조 버튼이 "모의 제안 만들기", 안내가 "지금은 모의 AI 만 동작", 제안 이름표 "AI 제안(모의)", 채널 초안 버튼 "AI 초안(모의)", 토큰 "(추정)", 실패 "예약액 전체 반영"으로 고정되어 있었다 — 실제 호출·과금을 모의로 보이게 함(AGENTS.md "실제 상태를 보여 줄 것").
- 변경: `apps/web/lib/ai-labels.ts`(새 helper: assistModeText(mode)·isMockResult({provider|createdBy})·resultLabel·usageSourceLabel(snapshot)·failedSettlementLabel(snapshot)), `writing-panel.tsx`·`variants-panel.tsx`(llmMode prop, helper 사용), `page.tsx`(config.LLM_MODE 전달). 결과 이름표는 설정이 아니라 그 결과의 provider(run.provider) 또는 버전 createdBy('ai:mock'|'ai:live')로 정하고, 모르면 모의라고 하지 않는다.
- 시험: `apps/web/lib/ai-labels.test.ts`(live 문구에 '모의' 없음·과금 안내, mock 문구 불변, 결과 이름표 출처, usage_source 4가지 + 키 없음, 실패 확정 문구).
- 화면 확인(dev, LLM_MODE=live, 키 없음 — 실제 호출 0): 안내 "실제 AI(Claude) 모드입니다 — 요청할 때마다 Anthropic 으로 실제 호출하고 비용이 기록됩니다", 버튼 "실제 AI 제안 요청(호출·과금) (버전 1 기준)", 채널 초안 "AI 초안(실제 호출·과금)", 작성 보조 영역의 '모의' 0회. 서버 오류 없음.
- 검사(checks-LIVEUI): lint 0 · typecheck 0 · build 0 · unit 0(57 파일 · 1409) · integration 0(37 파일 · 789) · drill:mock 0 · db:migrate 0 · drill:restore 0(PASS).
- 외부 호출 0. 남은 위험: 서버 컴포넌트 렌더 자체의 자동 시험은 없음(helper 시험 + 수동 화면 확인).
- Codex 질문: (1) 결과 이름표를 provider/createdBy 로 정하는 것이 맞는가(설정을 mock 으로 되돌린 뒤 과거 실제 결과가 '실제 AI'로 남는가)? (2) 그 밖에 live 에서 '모의'로 남는 화면(배포·ops 등 AI 관련)이 있는가?
