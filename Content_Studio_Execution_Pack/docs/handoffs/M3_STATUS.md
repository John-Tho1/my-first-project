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
- 체크리스트 문구 ↔ 화면 문구(화면 확인 D6, 2026-10-01 체크리스트 쪽을 화면에 맞춤): 5번 `QUEUED · MOCK` → 작업 제목 `작업(MOCK — 모의 어댑터)` + 상태 `QUEUED · 대기`, 8번 `완료` → 계획 상태 `처리 끝(MOCK — 실제 발행 아님)`(`completed`). MOCK 표기는 상태 문구가 아니라 작업 제목·배지에 있다.

## 다음
D20: M4/T13(OAuth·비밀 암호화)은 사용자가 첫 채널(Threads 권고)·앱 등록·scope·테스트 계정·마스터 키 보관 방식을 확인해 줄 때까지 착수하지 않음. 그 전 가능한 것: T20(모니터링·백업) mock 부분.

## M3 화면 검증 FIX (2026-09-30~10-01, 로컬)
사용자 체크리스트 12항목은 구현 담당(Claude)이 내장 브라우저로 직접 확인(Codex 는 소스 정적 대조 보조). 결함 11건(P1 1·P2 6·P3 4) → 커밋 3개(d2b1db8, 7548f12, cf13ae5)로 전부 수정, Codex 최종 PASS.
핵심: 폼 편집 CRLF 정규화·본문 우선 파생(D21), 재확인 결과 4종 표시, 배너는 저장 상태·이벤트에서 파생, 홈 최근 배포, dev Turbopack 파일 캐시 끔(재시작 404 재발 방지), worker @cs/providers 선언, 수동 재확인 stale 검사, UI tick 10s 상한.
기록: docs/handoffs/screen-notes-m3.md, T12_IMPLEMENTATION_HANDOFF.md(FIX 라운드), docs/DECISIONS.md D21.

## T20 운영·복원 훈련·보존 — 모의·로컬 부분 (2026-10-01~02, 로컬, M4 보류 중 선행) — Codex 최종 PASS (FIX6-T20)
커밋 41ff399(구현) → 0c0d969(FIX round 1, review-T20) → cef5eaf(FIX2, 보존 정리 놓친 케이스) → 9458dff(FIX3, review-FIX-T20 + review-FIX2-T20 반영) → 19986fc(FIX4, review-FIX3-T20 반영) → 82cde4a(FIX5, review-FIX4-T20 반영) → 6e99eef(FIX6, review-FIX5-T20 반영). 외부 알림·외부 저장소·실계정 없음(D22).
- `/ops`(owner 전용): 작업 상태 수, 확인 필요 계획·작업(실제 합계 + 50건 표시 상한 명시), 반복 실패, 대기 중 삭제, 용량(complete/partial/unavailable, 경로 미노출), 비용, 백업 나이, 마지막 복원 훈련, 모드. 원천 없으면 "측정 없음".
- 복원 훈련 `pnpm drill:restore` / `POST /api/ops/restore-drill`: 임시 export → 비밀 없음 확인(ZIP 엔트리 해제 후 검사) → 메모리 PGlite + 빈 임시 저장소에 empty_only 복원 → **전 컬럼 비교**(restore-expect.ts 가 복원 규칙을 독립 재계산, 부정 테스트 7건) → `restore_drills` 기록(0024, 예외도 fail+error_code 0025). 실제 로컬 DB 1회 PASS(표 29·행 89·파일 2).
- 보존 정리: 대상은 job_events(끝난 작업, JSONL 내보낸 뒤 삭제, 트리거 `job_events_guard`)·배포 ZIP·내보내기 ZIP 만. **내보내기 보존은 사용 가능한 백업 파일 기준, 최신 사용 가능 ZIP 1개는 항상 보존**. 기본 수동(미리보기 → confirm=yes), `RETENTION_SWEEP_MODE=auto` 는 설정으로만.
- 검사(6e99eef): lint·typecheck·build 통과, unit 33 files/589, integration 25 files/412, drill:mock 위반 0. migration 0024·0025·0026 로컬 적용.
- 실제 로컬 DB `drill:restore`(9458dff~6e99eef 매 라운드, 전 컬럼 비교): **PASS** — 표 29·행 89·파일 2·검색 found, 복원 규칙 적용 행 items 2·approvals 3·jobs 8, 빈 표 10개 표시(부분 검증 범위 명시).
- FIX3 요지: 보존은 **검증된 백업**(크기 + 전 엔트리 해제·checksum + manifest sha256 = export_runs 저장값)만 keep 으로 셈, 검증된 백업이 keep 미만이면 아무것도 삭제 안 함; ZIP absent/damaged/unreadable 구분(폴더 정리는 absent 만); 3단계 sweep(계획 감사 커밋 → 파일 삭제 → 결과 감사). 훈련은 철회·강등 기대값을 묶음에서 독립 재계산, 복원 호출 구간으로 시각 검사 축소, scope_json 으로 "PASS(부분 검증)" 표시. FIX4: 삭제 직전 남길 ZIP 캐시 없이 실제 바이트 재검증(실패 시 아무것도 삭제 안 함), 복원 판정 시각 주입으로 철회 결정론화, sweep_id 로 계획·결과 연결 + 미완료 sweep 전부 표시, 전부 ENOENT 도 결과 감사.
- Codex: T20 P0 1·P1 2·P2 2 → FIX1 → FIX-T20 P0 1·P1 1·P2 2 → FIX2(보존 놓친 케이스) P1 1·P2 1 → FIX3 → FIX3-T20 P0 1·P1 2·P2 1 → FIX4 → FIX4-T20 P1 2 → FIX5 → FIX5-T20 P2 1 → FIX6(6e99eef) → **FIX6-T20 PASS**. 라운드별 상세 `T20_IMPLEMENTATION_HANDOFF.md`, 판정 `M3_CODEX_VERDICTS.md`.

### 사용자 결정 대기 (D22)
(a) 기준값 24h·180d·30d·keep 10 확인, (b) 보존 정리 기본 manual 유지 여부, (b2) FIX3 규칙: 손상·접근 불가 ZIP 과 그 폴더는 무기한 보존(자동 삭제 안 함) — 유지할지, (c) 백업을 이 PC 밖으로 옮길지(Codex Q5: 백업 나이는 사용 가능한 파일·확인된 외부 사본 기준이어야 함), (d) 외부 알림 사용 여부, (e) Codex Q6: 공개 `/api/health` 의 `ops` 숫자(사용량·운영 상태 노출)를 세션 뒤로 옮길지.
### 남은 위험
- 보존 정리의 동시 실행·JSONL 줄 수는 같지만 내용 손상·삭제 도중 부분 실패는 테스트 밖(Codex 놓친 케이스).
- 훈련 PASS 는 "지금 DB 를 빈 환경에 복원하면 같아진다"는 뜻. 보관 중인 과거 ZIP 의 온전함은 별도 훈련이 필요(Q5).
- 운영(PostgreSQL) 환경 훈련 통과는 M7/운영 전 별도.

## D23 — D22 사용자 결정 확정 (2026-10-02)
(a) 기준값 확정, (b)(b2) manual·손상 ZIP 무기한 보존 유지, (c) 백업은 PC 안, 백업 나이는 마지막 완료 export 기준 유지, (d) 외부 알림 없음 — 코드 변경 없음.
(e) 공개 `/api/health` 에서 `ops` 제거, 로그인 필요한 `GET /api/ops/summary`(owner 범위)로 이동 — 커밋 f7fbae8, Codex **PASS**. 검사: lint·typecheck·build·unit 589·integration 415·drill:mock 0. 실서버 확인: health 200(ops 없음), summary 무세션 401.
남은 사용자 결정: 공개 health 의 `jobs`·`uploads`·`db.captures` 도 세션 뒤로 옮길지(Codex 권고: 옮김).
