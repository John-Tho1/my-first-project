# M3 착수 — 클라우드 세션 인계 (작성 2026-09-25, 로컬 세션)

## 상태
- 브랜치 `content-studio/m2` = M2 완료(T06~T09), HEAD 는 `git log -1` 로 확인. origin 에 푸시됨. M1 은 `content-studio/m0-m1-imvkel`(71e16c5).
- Codex(GPT-6 Astra / xhigh) 경계: T07·T09·T08 PASS, T06 의 P1 2건은 **D16(A·B) 로 종결**. M2 잔여 결정 A~G 전부 확정(docs/DECISIONS.md D16). 판정 요약 `M2_CODEX_VERDICTS.md`, 진행 현황·결정 목록 `M2_STATUS.md`, 작업별 인계 `T06~T09_IMPLEMENTATION_HANDOFF.md`, 결정 D7~D15 는 `docs/DECISIONS.md`.
- 검사(HEAD): lint·typecheck·build 통과, unit 26 files/411, integration 16 files/249. 외부 호출·새 의존성·비밀·과금 0.
- 화면 체크리스트(LOCAL_RUNBOOK §3) 사용자 확인 완료(D16-G, `screen-notes.md`).

## 클라우드에서 못 하는 것
- Codex 검증은 **로컬 전용**(사용자 PC 의 Codex CLI, `scripts/codex-review-commit.sh`). 클라우드는 구현 + 인계 문서까지만 하고 Codex 경계에서 멈춘다(M1 클라우드 세션과 같은 방식). Codex 는 사용자가 로컬로 돌아왔을 때 실행한다.
- 실제 계정·키·외부 호출은 여전히 금지(PUBLISH_MODE=disabled, LLM/STT mock).

## M3 범위 (docs/05 §M3, docs/03)
- T10: 불변 payload(canonical JSON → SHA-256)·계정별 미리보기·approval(owner, approved_at, payload_hash, revoked_at, purpose)·revocation·execute idempotency.
- T11: transactional outbox / DB jobs(lease_owner·lease_until·attempt·next_run_at·idempotency_key)·retry·reconciliation·cancel(CANCEL_REQUESTED 추적).
- T12: MockChannelAdapter 로 성공·실패·불명확(UNKNOWN)·부분 성공(PARTIAL) 테스트.
- 통과 조건: 승인 없는 실행 서버 거부 / 수정 뒤 기존 승인 거부(A06) / 더블클릭·worker 2개 중복 전송 방지(A07) / 원격 성공 후 응답 유실은 자동 재게시 없음(A08) / 앱·worker 종료 후 작업 상태 보존. **성공 화면에 MOCK 표시 필수, 실제 발행 실적으로 저장 금지.**
- M2 발판: variants/variant_versions(불변)·variant_assets, 배포 파일 ZIP(packages.ts), 예산 원장(budget.ts), inline worker tick, 불변 트리거 패턴, 복합 same-owner FK 패턴, export/restore PARENTS 패턴.

## 사용자 결정
M2_STATUS.md §3 A~G 는 2026-09-25 권고안대로 전부 확정 → docs/DECISIONS.md **D16**. M3 는 결정 대기 항목 없이 착수한다.

## 클라우드 착수 프롬프트 (붙여넣기)
```
Content Studio M3 착수. origin 의 content-studio/m2 를 가져와 새 브랜치 content-studio/m3 를 만든다(base = m2 HEAD).
앱 루트는 Content_Studio_Execution_Pack/ (자체 AGENTS.md/CLAUDE.md 적용). 먼저 docs/handoffs/M3_CLOUD_KICKOFF.md,
M2_STATUS.md, M2_CODEX_VERDICTS.md, docs/DECISIONS.md D12~D15, docs/03_DISTRIBUTION.md(승인 스냅샷·상태 분리), docs/04(approvals·jobs·
job_events·publications 행), docs/05 M3·A06~A12 를 읽는다.
운영 방식은 M1·M2 와 동일: 오케스트레이터가 계획·diff 검토·커밋, 구현은 Opus 에이전트, 작업마다 .handoffs/T1x_IMPLEMENTATION_HANDOFF.md
(BASE/HEAD SHA, 실행 명령·결과, Codex 질문 4~6개) 작성 후 **Codex 경계에서 멈춘다 — 클라우드에서는 Codex 를 실행하지 않는다**
(로컬 복귀 후 scripts/codex-review-commit.sh 로 검증). 인계 사본은 docs/handoffs/ 에 커밋해 로컬이 볼 수 있게 한다.
순서 T10 → T11 → T12. PUBLISH_MODE=disabled 유지, 채널 어댑터는 Mock 만, OAuth·실계정·외부 호출·새 의존성·비밀 금지.
승인은 서버가 canonical payload 해시로 검증하고 LLM 출력·클라이언트 플래그는 절대 승인이 아니다. job 은 DB 트랜잭션 안에서 lease·상태 전이·
전송 의도 기록을 함께 처리하고, 원격 결과 불명은 UNKNOWN/RECONCILING 으로 남기며 자동 재전송하지 않는다. 모의 성공 화면에는 MOCK 표시.
M2 결정은 D16 으로 전부 확정됐다(재논의 금지, D12~D16 준수). 각 작업 후 lint/typecheck/test/test:integration/build 5종 통과를 인계 문서에 기록한다.
```
