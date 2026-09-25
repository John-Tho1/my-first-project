# M2 밤샘 진행 현황 · 아침 결정 요청 (2026-09-25 새벽, 로컬 세션)

브랜치 `content-studio/m2` (base 71e16c5 = M1 최종). 커밋 23개, 원격 미푸시(아래 §5 참고). dev 서버 http://localhost:3000 (migration 0015 적용).
검사(HEAD 5ec8d3b): lint·typecheck·build 통과, unit 26 files/411, integration 16 files/249. 외부 호출 0, 새 의존성 0, 비밀 0, 과금 0.

## 1. 작업별 Codex(GPT-6 Astra / xhigh) 경계 결과
| 작업 | 원본 → 수정 라운드 | 최종 판정 | 남은 것 |
| --- | --- | --- | --- |
| T06 브랜드·질문·모의 작성 보조 | a6fc08a → e5fab50 → 5af8de7 | 2차 CHANGES_REQUESTED(P1 1) | **사용자 결정**: 'removed'(본문에서 뺐음) 의 의미 — 문자열 비교로는 어미 변경 삭제를 증명 못함 (§3-A) + 수동 복사 우회 (§3-B) |
| T07 근거·예산·live 경계 | bad21ed → 7라운드 → 90da2fa | **PASS** | 인용 정제는 "구조화 인용만·자유 텍스트 URL fail-closed" 로 확정. 오탐(README.md, 1.2.3.4, 사용자 원문 URL) 은 §3-C 결정 |
| T09 채널 초안·패키지 | f45072f → 2라운드 → e7a14f2 | **PASS** | D14 결정 (§3-D) |
| T08 업로드·모의 전사 | f147847 → 4라운드 → 5ec8d3b | **PASS**(4차) | D15 결정 (§3-E) |
| 잠금(lock.ts) Windows EPERM 2건 | 2dd392d, c6ef0c5 | PASS, PASS | — |

리뷰 원문: `.handoffs/review-*.md`(판정·지적), `.handoffs/review-*.log`(세션 헤더: model gpt-6-astra / reasoning effort xhigh).
인계 문서: `.handoffs/T06~T09_IMPLEMENTATION_HANDOFF.md` (각 라운드 표 + Codex 질문). 결정 기록: docs/DECISIONS.md D12~D15.

## 2. 무엇이 생겼나 (사용자 관점)
- `/brand`: 브랜드 프로필 새 버전 저장(존댓말/평어·피할 표현·CTA·예문). `/contents/{id}`: 인터뷰 질문 3개, AI 제안(모의)→diff→채택/무시, 경험 claim 확인/제외, 프롬프트 복사용 보기, 출처 선택(≤50), 채널 초안(Threads/Instagram/YouTube/Blog)·미디어 첨부·검토 전환·배포 파일 ZIP(수동 게시용, 자동 게시 아님).
- `/settings`: AI 모드·이번 달 사용/상한(통화별)·live 준비 안 됨 목록, STT 라인. `/record`: 기기 fallback 안내 + 분할 업로드(재개)·전사 job 진행.
- 서버 게이트: A03(미확인 경험 claim → ready/review 차단), A15(예산 예약·초과 기록·통화 불일치 거부), stale 파생본 review 거부, 미디어 완성 검사, 인용 fail-closed.
- live LLM/STT: 코드에 HTTP 호출 없음. 모든 전제(모드·provider·model·가격·월 한도·승인 참조)가 있어도 503.

## 3. 아침에 결정해 주실 것
A. **T06 'removed' 의미** (Codex P1, review-FIX2-T06): (a) 현재 방식 유지 + 한계 명시(권고) (b) removed 제거, '사실 아님(부인)' 추가해 ready 계속 차단 (c) claim–본문 구간 연결 구현(별도 작업).
B. **T06 수동 복사 우회**: 제안을 손으로 복사해 저장하면 A03 미적용. (a) 한계로 수용(권고, M3 이후) (b) 에디터 붙여넣기 감지 구현.
C. **T07 인용 오탐**: 자유 텍스트에 URL/도메인 유사 토큰(README.md, 1.2.3.4, 사용자 원문 URL)이 있으면 모의 제안이 실패. (a) 유지(권고: live 도입 전까지) (b) 프롬프트 입력에서 URL 을 [출처 n] 으로 치환.
D. **D14(T09)**: YouTube 파생본 review 조건(영상 첨부 필수 vs 대본만 허용 — T08 로 영상 업로드가 열림), 채널 글자 수 한도 공식 재확인 시점, 새 버전마다 draft 복귀 유지, 패키지 파일 보존 기간.
E. **D15(T08)**: 한도(음성 200MB·영상 2GB·24h·8MiB 조각), VERIFIED 범위(서명·크기·checksum) 유지 vs 디코딩 검증, 원음 보존 기본값(켬), sha256 을 서버 필수로 할지(현재 선택), 실제 STT 공급자·가격·승인(D9).
F. **D13(T07) 예산**: 월 한도·건당 상한·통화 값, D8(live 공급자·모델·가격·LLM_LIVE_APPROVAL_REF), 실패 호출 전액 과금 유지, 월 경계 넘는 예약의 귀속 월.
G. **화면 체크리스트 12항목**(LOCAL_RUNBOOK §3)은 미확인 — dev 서버가 떠 있으니 확인 후 `.handoffs/screen-notes.md` 에 기록.

## 4. 알아두실 운영 메모
- 이 PC 에서 `codex review --commit` 은 무용(샌드박스가 셸 차단) → `scripts/codex-review-commit.sh <SHA> <라벨> [인계문서]` 사용.
- dev 서버가 켜진 채 `pnpm build` 하면 `.next/dev` 캐시가 깨져 /api/* 가 404 → 서버 중지 후 빌드(밤중 1회 발생·복구).
- `git add -A` 로 에이전트 작업 중 파일이 섞여 커밋 1개를 재작성(319f30d). 이후 명시 경로만 스테이징.
- 잠금 테스트는 병렬 부하에서 flaky 했음 → 유지 시간·대기 상향 + Windows EPERM 처리 2건(Codex PASS).

## 5. 다음 단계
- m2 푸시 완료 → §3 결정 뒤 M3 착수 브리프(승인·job·모의 배포).
