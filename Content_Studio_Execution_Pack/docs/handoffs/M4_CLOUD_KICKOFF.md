# M4 계속 — 클라우드 세션 인계 (작성 2026-10-02, 로컬 세션)

## 상태 요약
- 브랜치 **`content-studio/m4`** 에서 이어간다(m3 HEAD dfc9842 에서 분기). 마지막 커밋은 **T13 FIX round 3 WIP**: 테스트·인계 미작성, typecheck 만 통과. 먼저 `M4_STATUS.md` 를 읽는다.
- 앱 루트 `Content_Studio_Execution_Pack/`(자체 AGENTS.md/CLAUDE.md). 결정 D20~D25(`docs/DECISIONS.md`).

## 클라우드에서 못 하는 것
- **Codex 검증은 로컬 전용**(사용자 PC 의 Codex CLI, `scripts/codex-review-commit.sh`, 모델 gpt-6-astra / xhigh 고정). 클라우드는 구현 + 검사 + 인계 문서까지 하고 Codex 경계에서 다음 작업으로 넘어가지 않는다 — 단, T14 의 모의 구현은 T13 Codex PASS 전이라도 진행 가능(T13 FIX 결과에 의존하지 않는 부분만, 별도 커밋).
- 실제 계정·키·외부 호출·앱 등록·새 의존성 금지(PUBLISH_MODE=disabled, OAUTH_MODE=mock, LLM/STT mock).
- `.handoffs/` 는 gitignore. 인계·리뷰 사본은 `docs/handoffs/` 에 커밋해야 로컬이 본다.

## 클라우드 착수 프롬프트 (붙여넣기)
```
Content Studio M4 계속. origin 의 content-studio/m4 를 체크아웃한다(마지막 커밋 = T13 FIX round 3 WIP).
앱 루트는 Content_Studio_Execution_Pack/ (자체 AGENTS.md/CLAUDE.md 적용). 먼저 docs/handoffs/M4_CLOUD_KICKOFF.md, M4_STATUS.md,
T13_CODEX_REVIEW_FIX2.md, T13_IMPLEMENTATION_HANDOFF.md, M4_CODEX_VERDICTS.md, docs/DECISIONS.md D20~D25 를 읽는다.
1) T13 FIX round 3 을 끝낸다(M4_STATUS.md "FIX round 3 할 일" 1~5). WIP 의 migration 0030·oauth.ts·secrets-cli.ts 변경을 이어서 완성하고 테스트를 쓴다.
   lint/typecheck/build/test/test:integration(단위와 동시 실행 금지)/drill:mock 통과 후 커밋, T13_IMPLEMENTATION_HANDOFF.md 에
   "FIX round 3 (Codex review-FIX2-T13)" 절(지적 → 변경 → 테스트, 명령·결과, BASE/HEAD SHA, Codex 질문)을 추가해 docs/handoffs/ 에 커밋한다.
   Codex 는 실행하지 않는다(로컬 복귀 후 검증).
2) 그다음 T14(Threads 텍스트, 모의 어댑터만): 컨테이너 생성 → publish 2단계, 컨테이너 참조 저장, 성공 확인(조회), 요청 제한,
   실패·불명 → RECONCILING/UNKNOWN(맹목 재게시 금지), T13 연결 상태 게이트 사용. docs/03 Threads 행·docs/05 M4·A08·A09 준수.
   실제 Threads API 호출·앱 등록·실계정 금지(D24). 같은 방식으로 검사·커밋·docs/handoffs/T14_IMPLEMENTATION_HANDOFF.md 작성 후 멈춘다.
운영 방식: 오케스트레이터가 계획·diff 검토·커밋, 구현은 Opus 에이전트. 승인 검증·불변식을 테스트·서버에서 강제하고 assertion 을 약화하지 않는다.
마지막에 docs/handoffs/M4_STATUS.md 를 갱신하고 origin 에 push 한다. 로컬 복귀용 명령(아래 "로컬 복귀 시")은 그대로 둔다.
```

## 로컬 복귀 시 (사용자 PC)
```bash
cd Content_Studio_Execution_Pack && git fetch origin && git checkout content-studio/m4 && git pull
source tools/env.sh && corepack pnpm install --frozen-lockfile
corepack pnpm db:migrate        # 0030~0032 (dev 서버 끈 상태)
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm build && corepack pnpm test && corepack pnpm test:integration && corepack pnpm drill:mock
corepack pnpm drill:restore     # 실제 로컬 DB 복원 훈련
./scripts/codex-review-commit.sh 79201d6 FIX3-T13 docs/handoffs/T13_IMPLEMENTATION_HANDOFF.md
./scripts/codex-review-commit.sh 67ade9e T14 docs/handoffs/T14_IMPLEMENTATION_HANDOFF.md
./scripts/codex-review-commit.sh 427dc71 T15 docs/handoffs/T15_IMPLEMENTATION_HANDOFF.md
```
Codex 판정은 `.handoffs/review-<label>.md` 에 생기고, 요약은 `docs/handoffs/M4_CODEX_VERDICTS.md` 에 옮긴다.

## 클라우드 세션 결과 (2026-10-02 갱신)
FIX3-T13 `79201d6`, T14 `67ade9e`, T15 `427dc71` 커밋·푸시 완료(모두 Codex 미검증). 상세·결정 확인 항목(D26·D27)은 `M4_STATUS.md`.

## 로컬 Claude Code 착수 프롬프트 (붙여넣기)
```
Content Studio M4 로컬 복귀. content-studio/m4 를 pull 하고 docs/handoffs/M4_STATUS.md, M4_CLOUD_KICKOFF.md "로컬 복귀 시"를 따른다.
1) 설치·db:migrate(0030~0032)·lint/typecheck/build/test/test:integration(단위와 동시 실행 금지)/drill:mock/drill:restore 를 실행하고 결과를 기록한다.
2) Codex 검증 3건을 순서대로 실행한다: 79201d6 FIX3-T13, 67ade9e T14, 427dc71 T15 (scripts/codex-review-commit.sh, 인계 문서 경로는 docs/handoffs/).
   판정 요약을 docs/handoffs/M4_CODEX_VERDICTS.md 에 옮기고, P0/P1 은 prompts/CLAUDE_FIX.md 절차로 재현 → 최소 수정 → 재검증한다.
3) D26·D27 확인 항목은 내가 답할 때까지 잠정값 유지. T16·M5 는 내가 지시할 때 착수한다.
```
