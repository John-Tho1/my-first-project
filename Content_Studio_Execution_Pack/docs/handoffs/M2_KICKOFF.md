# M2 착수 준비 — 작성 지원 (T06~T09)
작성: 2026-09-24 (Europe/Moscow). 전제: M0+M1(T01~T05) 커밋 완료(HEAD be3fd8f), Codex 검증은 로컬에서 수행 예정. **M2 코드는 아직 한 줄도 없다.**

## 1. M1에서 M2로 넘어가는 조건
- [ ] Codex 리뷰 5건(T01~T05) 완료, P0/P1 = 0, 수정 커밋은 재검증 완료 (LOCAL_RUNBOOK §2)
- [ ] 로컬(Windows, Node 24.21.0)에서 lint/typecheck/test/test:integration/build 통과 확인
- [ ] 화면 체크리스트 12항목 확인, 불편 사항 `.handoffs/screen-notes.md` 기록
- [ ] 아래 §3 결정 5개 확정

## 2. M2 범위 (docs/05, tasks.json)
| 작업 | 내용 | 외부 승인 | 선행 |
| --- | --- | --- | --- |
| T06 | Brand Profile(버전) · 인터뷰 질문 ≤3개 · outline/draft · 수정 diff · **모의 AI** | 불필요 | T05 |
| T07 | 입력 버전 고정 · claim–source 연결 · 경험 확인(user_confirmed) · 비용 예약(budget reservation) · live provider 1개 연결 **조건** | **필요**(live 호출·과금) | T06 |
| T08 | 음성 파일 전사 job · 업로드 진행 · 지원 기기 fallback | **필요**(외부 STT) | T07 |
| T09 | 채널별 초안(Threads/Instagram/YouTube/Blog) · stale 표시 · 미디어 완성 여부 · 배포 파일 export(ZIP) | 불필요 | T07 |

M2 통과 조건(docs/05): AI 실패·중단에도 사용자 원문 보존 / 미제공 1인칭 경험 생성 시 검토에서 차단(A03) / 원본 수정 뒤 파생본 stale / 동시 AI 호출이 비용 상한을 넘지 않음(A15) / live 호출은 허용된 API 설정 후 별도 확인.

M1에 이미 있는 M2 발판: `MockLlmProvider`(결정적, 경험 claim → needs_user_confirmation), `assertLiveLlmAllowed`(fail-closed), LLM 구조화 출력 zod 스키마(`result_type/input_version/claims/followup_questions/warnings`), `content_versions` 불변 버전 + `ai_run_id` 컬럼, `brand_profiles`(seed v1), `diffLines`, `sources/source_versions`.

권장 순서: **T06 → T07(모의 경계까지) → T09 → T08**. T09는 T07만 선행이고 외부 승인이 없으므로 T08보다 먼저 두는 편이 외부 대기 없이 진행된다.

## 3. 착수 전 사용자 결정 (5개)
| # | 결정 | 권고안 | 비고 |
| --- | --- | --- | --- |
| D3 | M1 개발용 로그인(AUTH_MODE=dev, 비밀번호 없음, localhost 전용) 유지 | **유지**, 운영 OIDC는 T13 | docs/DECISIONS.md D3 |
| D7 | M2의 AI는 모의만으로 진행할지 | **T06·T09는 모의만**. T07에서 live 경계(provider adapter·예산·차단)를 구현하되 **실제 키·호출은 별도 승인** | 저장소·브라우저·프롬프트에 키 금지 |
| D8 | 첫 live LLM 공급자·모델 | T07 착수 시 결정. 후보는 사용자가 정함(공식 자료 재확인 후 모델 ID·요금 상한 설정) | 요금·모델 ID는 그 시점 공식 자료로 확인, 문서에 숫자 고정 금지 |
| D9 | T08 음성 전사의 외부 STT 사용 여부 | T08은 **업로드·job·진행 상태까지 모의로** 만들고, 실제 전사 서비스는 승인 후 | 원음 보존 선택 포함 |
| D10 | Content Studio를 별도 저장소로 분리할지 | M2 동안은 **현 위치 유지**(`my-first-project/Content_Studio_Execution_Pack/`), M3 전 재검토 | docs/ENVIRONMENT.md §7 |

## 4. T06 상세 (첫 작업 브리프 초안)
- Brand Profile: `/settings` 또는 `/brand`에서 버전 편집(pen_name·audience·pillars·style_rules·존댓말/평어·피할 표현·CTA 원칙·예문). 새 버전은 append(`brand_profiles(owner_id, version)` unique 활용), 고용주 문서·다른 프로젝트 메모리 자동 가져오기 없음.
- 인터뷰 질문: capture/idea 단위로 ≤3개("어떤 상황 → 무엇을 판단 → 독자에게 남길 한 가지"). 답변은 사용자가 입력, 가상 경험으로 보충하지 않음. 저장 테이블 신설(`interview_answers`, 불변).
- outline/draft: `POST /api/contents/{id}/assist` (docs/04) — 모드 `outline|draft|revise`, `input_version` 고정(현재 content_version id + brand_profile version + 답변 ID 목록). `generation_runs` 테이블 신설(owner, input_version_refs, prompt_version, provider/model, output_ref, status). 결과는 **제안**으로 저장(`content_versions.created_by='ai:mock'`, `ai_run_id`), 사용자 본문을 덮어쓰지 않음. 화면: 제안 vs 현재 본문 diff, "제안 채택"(새 사용자 버전 생성) / "취소".
- 실패·중단: 모의 provider에 실패 주입 옵션(테스트) → 에디터 내용 유지, run 상태 failed.
- A03: 모의 출력의 `experience` claim 은 `needs_user_confirmation=true` → 확인 전에는 원고 lifecycle `ready` 전이 차단(서버 검증).
- 외부 호출 0, 새 의존성 0, 테스트: 단위 + 통합(원문 보존·A03·input_version 불일치 시 409·타 owner 404).

## 5. 로컬 Claude Code 착수 프롬프트 (M1 게이트 통과 후 붙여넣기)
```
Content Studio M2 착수. 브랜치 content-studio/m0-m1-imvkel(HEAD <M1 최종 SHA>)에서 새 브랜치 content-studio/m2 를 만든다.
앱 루트는 Content_Studio_Execution_Pack/ (자체 AGENTS.md/CLAUDE.md 적용). 운영 방식은 M1과 동일:
오케스트레이터가 계획·diff 검토·커밋, 구현은 Opus 5.5 에이전트, 작업마다 .handoffs/T0x_IMPLEMENTATION_HANDOFF.md 작성 후
Codex 검증 경계에서 멈춘다(로컬이므로 codex --sandbox read-only review --commit <SHA> 실제 실행).
결정: D3 유지, D7 모의 AI만(T06·T09), D8 미정(T07에서), D9 T08 모의까지, D10 현 위치 유지.
순서 T06 → T07(모의 경계) → T09 → T08. 새 의존성·외부 호출·비밀값 금지. M3 이후 구현 금지.
먼저 docs/handoffs/M2_KICKOFF.md §4 의 T06 브리프와 docs/01 §4, docs/04 "AI 구조화 출력", docs/05 M2·A03·A15 를 읽고
T06 최소 변경 계획을 제시한 뒤 구현하라. Codex 지적(.handoffs/review-*)이 남아 있으면 그것부터 처리한다.
```
`<M1 최종 SHA>`는 Codex 수정 커밋이 있으면 그 최종 HEAD로 바꾼다.
