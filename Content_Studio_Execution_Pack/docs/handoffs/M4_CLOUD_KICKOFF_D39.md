# D39 — 클라우드 세션 인계 (작성 2026-10-19, 로컬 세션)

## 왜 클라우드인가
로컬 PC 메모리 여유(커밋)가 부족해 dev 서버·Next 빌드·통합 시험이 OOM 으로 죽는다("Fatal process out of memory: Zone"). 구현·검사는 클라우드에서, Codex 검증(가벼운 CLI)과 실제 설정 적용·화면 확인은 로컬에서 한다.

## 상태
- 브랜치 `content-studio/m4`. 이 문서를 담은 docs 커밋이 출발점(BASE). 이전 코드 HEAD 9bbf96a(DESIGN-A, Codex PASS). 열린 Codex 지적 없음.
- 결정 **D39**(`docs/DECISIONS.md` 끝): Threads 평상시 실제 게시 — 최근 24시간 3건 상한, 즉시 중지 스위치, 만료 관리. 구현 계획 `docs/handoffs/LIVEP2_EXPIRY_PLAN.md`(Task A LIVE-P2, Task B EXPIRY-1).
- 로컬에서 시작했던 LIVE-P2 에이전트는 파일 변경 없이 중단됨 — 처음부터 시작.
- 사용자 확인 대기 1건: D39 에 "승인된 예약 게시" 포함 여부(잠정: 포함 — 계획대로 진행, 사용자가 빼라고 하면 FIX 로 서버에서 막는다).

## 클라우드에서 하는 것 / 못 하는 것
- 한다: Task A → Task B 순서로 구현, lint·typecheck·build·test·test:integration(단위와 동시 실행 금지)·drill:mock, 커밋·푸시, 인계 문서 `docs/handoffs/LIVEP2_IMPLEMENTATION_HANDOFF.md`·`EXPIRY1_IMPLEMENTATION_HANDOFF.md`(templates/IMPLEMENTATION_HANDOFF.md 형식, BASE/HEAD SHA·명령·결과·남은 위험·Codex 질문) — 인계는 코드 커밋과 분리된 docs 전용 커밋(D28).
- 못 한다: Codex 검증(로컬 전용, gpt-6-astra / xhigh 고정), 실제 계정·키·외부 호출·`.env.local`·`./data`·실제 DB migrate, 새 의존성, 실제 게시. PUBLISH_MODE=disabled·OAUTH_MODE=mock·LLM mock 으로만 시험.
- `scripts/dev-cert.sh renew` 는 만들기만 하고 실행하지 않는다(로컬 인증서는 사용자 PC 에 있다).

## 클라우드 착수 프롬프트 (붙여넣기)
```
Content Studio D39 진행. origin 의 content-studio/m4 를 pull 한다. 앱 루트는 Content_Studio_Execution_Pack/ (자체 AGENTS.md/CLAUDE.md 적용).
먼저 docs/handoffs/M4_CLOUD_KICKOFF_D39.md, docs/handoffs/LIVEP2_EXPIRY_PLAN.md, docs/DECISIONS.md 의 D38·D39, docs/handoffs/M4_STATUS.md 끝부분을 읽는다.
1) Task A LIVE-P2(PUBLISH_LIVE_DAILY_MAX 최근 24시간 상한 + 즉시 중지 스위치, migration 0046)를 구현한다. packages/db/src/jobs.ts beginSend 의 기존 승인 기록 상한(LIVE-P1)과 같은 잠금·시험 방식을 따른다.
   lint/typecheck/build/test/test:integration/drill:mock 통과 → 코드 커밋 → docs/handoffs/LIVEP2_IMPLEMENTATION_HANDOFF.md 를 docs 전용 커밋으로.
2) 이어서 Task B EXPIRY-1(Threads 연결·로컬 인증서 만료 14일 전 경고, scripts/dev-cert.sh check|renew — 실행은 하지 않음). 같은 방식으로 검사·커밋·EXPIRY1_IMPLEMENTATION_HANDOFF.md.
Codex 는 실행하지 않는다(로컬에서 검증). 실제 외부 호출·실계정·새 의존성 금지, assertion 약화 금지.
운영: 오케스트레이터가 계획·diff 검토·커밋, 구현은 Opus 에이전트. 끝나면 docs/handoffs/M4_STATUS.md 에 결과(커밋 SHA·검사 수치·not_run)를 추가하고 origin 에 push 한다.
```

## 로컬 복귀 시 (사용자 PC — dev 서버 없이 Codex 만, 가벼움)
```bash
git pull
export PATH="/usr/bin:/mingw64/bin:/c/Users/i0211533/AppData/Local/Programs/OpenAI/Codex/bin:$PATH"
# .handoffs/codex-queue.txt 에 "<코드 sha> LIVEP2 docs/handoffs/LIVEP2_IMPLEMENTATION_HANDOFF.md" 와 EXPIRY1 줄 추가 후
rm -f .handoffs/codex-daemon.stop && bash .handoffs/run-codex-daemon.sh
```
PASS 뒤: dev 서버 끈 상태에서 data 백업 → `db:migrate`(0046) → `.env.local` 에 PUBLISH_MODE=enabled, PUBLISH_LIVE_APPROVAL_REF=D39, PUBLISH_LIVE_MAX_POSTS=1000, PUBLISH_LIVE_DAILY_MAX=3 → 메모리 여유 확인 후 서버 → health·설정 화면 확인.
