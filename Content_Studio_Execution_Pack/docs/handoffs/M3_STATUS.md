# M3 마감 현황 (2026-09-25, 로컬 세션)

브랜치 `content-studio/m3`, HEAD `d80919b`(origin 동기). 클라우드 T10~T12(d1844d6·a2a9670·240080b) + 로컬 FIX 커밋 6개.
검사(HEAD, Windows/Node 24): lint·typecheck·build 통과, unit 30 files/550, integration 24 files/332, `drill:mock` 불변식 위반 0(fetch 0).
migration 0016~0023 로컬 DB 적용, 모의 계정 4개. 외부 호출·새 의존성·비밀·실제 게시 0.

## Codex(GPT-6 Astra / xhigh) 경계
| 작업 | 원본 판정 | 수정 라운드 | 최종 |
| --- | --- | --- | --- |
| T10 승인 스냅샷·철회·실행 멱등 | P0 1·P1 3·P2 1 | FIX(5319cc7) P1 2 → FIX2(d67dde9) | **PASS** |
| T11 작업함·lease·재시도·재확인·취소 | P0 1·P1 2·P2 1 | FIX(b0ab90c) → FIX2(80f2881) P1 1 → FIX3(d80919b) | **PASS** |
| T12 모의 시나리오·M3 게이트 | P0 1·P1 1·P2 1 | FIX(b0ab90c) → FIX2(80f2881) | **PASS**(FIX3 는 T11 항목만) |
판정 요약 `M3_CODEX_VERDICTS.md`, 라운드별 표·Codex 질문은 `T10~T12_IMPLEMENTATION_HANDOFF.md`.

## 결정 기록
D17~D19(클라우드) → D20(로컬 확정: D19-a~d 권고안, M4 보류) + D20 후속 단락(0019/0021 트리거 규칙, D19(d) 뒤집음 = BLOCKED 항목 편집도 승인 무효화, 0023 정규화 전제).

## 주요 수정 요지
- 복원: UNKNOWN 보존(BLOCKED 로 덮지 않음), jobs·send_intents·publications 를 읽기 전용 이력으로 복원(restored_needs_review), CONFIRMED 인데 publication 없으면 UNKNOWN.
- 잠금: 계정(id 순) → 원고 → 파생본 → 계획 → 항목 → 승인 → 작업 순서 한 곳에 명문화, 승인·계획 생성·실행이 계정을 먼저 잠금, 첨부 추가는 파생본 잠금 후 재검사(+ 트리거 backstop).
- 작업: lease 1건씩, attempt 는 send intent 기록 시에만 증가, 의도 전 만료는 별도 카운터(5회), 진행 중 전송은 원격 조회에서 unknown, lease 상실 시 원격 쓰기 전 중단, 늦은 결과는 RECONCILING.
- 승인: BLOCKED 항목 편집도 승인 무효화(작업은 BLOCKED 유지), 계획 상태 SQL 재계산(0020), 활성 승인이 과거 보류 사유보다 우선.
- payload: 채널별 엄격 스키마로 복원 검증, canonical JSON 키 충돌 거부·__proto__ 안전.

## 남은 위험 / not_run
- 실제 PostgreSQL 2연결 동시성 미검증(PGlite 직렬화 증명만). M3 → PostgreSQL 전환 시 재검증.
- 모의 어댑터의 "전송 전 중단" 은 실어댑터에서는 보장되지 않음 — unknown 판정·late_result 가드가 방어선(M4 설계 입력).
- worker package.json 의 @cs/providers 의존 선언, 수동 재확인의 현재 시도 확인, 복원 환경 브랜드 상이 케이스는 Codex "놓친 케이스" 로 남음.
- M3 화면 체크리스트(M3_LOCAL_RETURN §3) 사용자 확인 결과는 `.handoffs/screen-notes-m3.md`.

## 다음
D20: M4/T13(OAuth·비밀 암호화)은 사용자가 첫 채널(Threads 권고)·앱 등록·scope·테스트 계정·마스터 키 보관 방식을 확인해 줄 때까지 착수하지 않음. 그 전 가능한 것: T20(모니터링·백업) mock 부분.
