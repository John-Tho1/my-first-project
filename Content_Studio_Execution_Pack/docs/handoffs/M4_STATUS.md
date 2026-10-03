# M4 현황 (갱신 2026-10-02, 클라우드 세션 → 로컬 인계)

## 브랜치·커밋
- `content-studio/m3` HEAD `dfc9842` = Codex 검증을 거친 마지막 지점(T13 FIX round 2 까지).
- **`content-studio/m4`** = m3 에서 분기. 클라우드 세션에서 T13 FIX round 3·T14·T15 를 구현·커밋·푸시했다. **셋 다 Codex 미검증** — 로컬 복귀 후 아래 순서로 검증한다.

| 작업 | 코드 커밋 | 인계 | 검사(클라우드 Node 22.22.2, 오케스트레이터 순차 재실행) | Codex |
|---|---|---|---|---|
| T13 FIX3 (review-FIX2-T13) | **`79201d6`** (base 666deff WIP) | `T13_IMPLEMENTATION_HANDOFF.md` "FIX round 3" 절 (8e658e5) | lint·typecheck·build PASS, unit 618, integ 475/475, drill:mock 0, migrate 0030 | 대기 |
| T14 Threads 텍스트(모의) | **`67ade9e`** | `T14_IMPLEMENTATION_HANDOFF.md` (00cc27e) | unit 657, integ 495/495, drill:mock 0(M3+Threads 12행), migrate 0031 | 대기 |
| T15 YouTube 재개 업로드(모의) | **`427dc71`** | `T15_IMPLEMENTATION_HANDOFF.md` | unit 697, integ 517/517, drill:mock 0(M3+Threads+YouTube), migrate 0032 | 대기 |

이전 라운드(구현 bf57eae → FIX1 5479a7f → FIX2 dfc9842)의 Codex 판정은 `M4_CODEX_VERDICTS.md`.

공통: 외부 호출 0, 새 의존성 0(lockfile 불변), 비밀 0, 실제 게시 0. 클라우드에서 실행하지 못한 것 — Codex, 실제 PostgreSQL 병렬 트랜잭션, 실제 브라우저 렌더링, Windows/Node 24 위 migration 0030~0032, 실계정.
알려진 불안정: `packages/db/src/lock.test.ts`(다중 프로세스 경합)가 병렬 부하에서 가끔 1건 실패 — FIX3 검사 첫 실행에서 1회, 단독 3/3·전체 재실행 통과. 이번 라운드에서 바뀌지 않은 파일.

## 결정 (docs/DECISIONS.md)
- D20~D25: 이전과 같음(D24 M4 착수·로컬/모의 범위, D25 T13 잠정 판단 확정).
- **D26 (T14, 잠정 — 사용자 확인 요청)**: (a) 연결한 적 있는 모의 Threads 계정만 Threads 모의 어댑터, (b) 401 뒤 refresh 대신 T13 연결 확인 1회, (c) 잠정 요청 제한 24h 250·창 비면 허용, (d) 스레드가 중간에 401·403·400 으로 멈추면 앞 게시물은 원격에 남고 항목은 BLOCKED/FAILED + 단계 목록, (e) 취소 요청 중 일부 게시된 스레드는 UNKNOWN, (f) 모의 공개 범위 = 승인 공개 범위 가정.
- **D27 (T15, 잠정 — 사용자 확인 요청)**: (a) 자리표시 scope `youtube.upload(mock)`(실제 이름은 live 전 재확인), (b) 모의 갱신이 refresh token 회전, (c) 모의 연결 YouTube 계정은 `upload_private`·`public_publish` 허용·`mock_publish` 불가(기본 upload_private), (d) 예약 공개 = `public_publish + private + publish_at`, (e) 잠정 할당량 24h 6회 롤링 창·원격 초과는 초기화 시각까지 대기, (f) 업로드 뒤 취소 = CONFIRMED + "삭제는 범위 밖", (g) 썸네일 첨부 시 실패, (h) export 에서 세션 URI 가림.

## 로컬에서 먼저 할 일
1. "로컬 복귀 시" 명령(`M4_CLOUD_KICKOFF.md` 하단)으로 체크아웃·설치·migration(0030~0032)·전체 검사·`drill:restore`.
2. Codex 3건을 순서대로: FIX3-T13 → T14 → T15. 판정 요약은 이 폴더 `M4_CODEX_VERDICTS.md` 에 옮긴다.
3. D26·D27 확인(위 항목별로 유지/변경). 변경이 있으면 FIX 라운드에서 함께 반영.
4. 화면 확인(브라우저): 설정의 Threads·YouTube 모의 연결, `/distribute/{id}` Threads 단계 목록(게시물 n/m), YouTube 패널(업로드 n%·세션 재개·처리 중·"비공개 업로드 완료, 공개 전환 확인 필요"), 복원 화면의 "배포 계정 다시 연결 필요".

## 클라우드 세션이 남긴 화면·흐름 공백 (FIX 또는 다음 작업 후보)
- 배포함 승인 폼은 목적 1개만 보낸다 → YouTube(upload_private)와 Threads 항목이 섞인 계획은 폼 한 번으로 승인 불가(API 로 목적별 승인 가능).
- `/distribute/new` 에 요청 결과·publish_at 입력 없음(YouTube 기본 upload_private, 공개·예약 계획은 API 전용).
- live 어댑터 전 필요: `remote_steps.remote_id LIKE 'mock%'` CHECK 를 바꾸는 migration, 조각 진행에 따라 늘어나는 submit timeout(현재 30 s / UI 10 s), 공식 rate limit·quota·scope 이름 재확인.

## 남은 작업
- **T16 Instagram**(모의 — 계정 유형·권한·미디어 규격은 공식 재확인 전 잠정), **T17**(추가 채널 — 사용자 선택 필요), **M5**: T18 Notion·Drive 선택 가져오기(파일·모의), T19 허용 소스 수집(모의 수집기, 기본 OFF), T21 운영 배포(승인 필요). T20 은 이미 구현(`T20_IMPLEMENTATION_HANDOFF.md`).
- 실계정 연결 전 사용자에게 받을 것(D24): Meta 앱 등록·앱 ID 보관 방식, 테스트 Threads 계정, Google Cloud 프로젝트·OAuth 동의 화면·YouTube API 감사 여부, redirect URI(로컬/운영), 마스터 키 위치, 첫 실계정 시험 원고·공개 범위.

## 남은 위험 / not_run
- 실제 PostgreSQL 다중 연결 동시성(경합 테스트는 PGlite 단일 연결 위 순서 주입).
- 프록시 뒤 콜백 URL·서버 접근 로그의 비밀 노출, 브라우저 렌더링.
- 공개 /api/health 의 jobs·uploads·db.captures 를 세션 뒤로 옮길지(사용자 결정 대기, D23).
- T13 FIX3: 계정당 정리 대기 슬롯 1개(두 번째 정리 실패는 감사만), 열 수 없는 pending 기록은 키를 고칠 때까지 계정 차단.
- T14/T15: 각 인계 문서 "Known risks" 참조(부분 스레드 공개 잔존, 고아 컨테이너, 세션 만료 not_found 판정 근거, 업로드 뒤 취소 처리).

---

# 로컬 복귀 후 진행 (2026-10-02~03, 로컬 세션, Opus 5.5 구현 · Codex 검증)

## 로컬 복귀 검사 (7634bb1, Windows 10 · Node 24.21.0)
설치·migration 0030~0032·lint·typecheck·build·unit 697·integration 517·drill:mock(M3·T14·T15) 0건·실제 DB drill:restore PASS.

## Codex 판정과 수정 라운드
| 대상 | 코드 커밋 | Codex |
|---|---|---|
| T13 FIX3 (클라우드) | 79201d6 | P1 3·P2 1 |
| T14 (클라우드) | 67ade9e | P0 1·P1 1·P2 1 |
| T15 (클라우드) | 427dc71 | P1 3 |
| T13 FIX4 (oauth_pending_tokens, 0033) | ea85ac6 | P1 1·P2 2(1건은 D28 로 처리) |
| T14 FIX1 (기록 어댑터·remote_steps 복원·resume_count 0034) | 6f766d2 | **대기열** |
| T13 FIX5 (해제 시 현재 토큰 철회 의무 보존·행별 백오프) | 492b1b9 | **대기열** |
| T15 FIX1 (조각 읽기 뒤 중단·할당량 단위·웹 경로 조각 예산) | cc26535 | **대기열** |
| 화면 S1–S3 | f2bb3b9 | **대기열** |
| 화면 기능 G1(항목별 목적 승인)·G2(요청 결과·예약 공개 입력) | fa37b1a | **대기열** |
| 화면 S4·S5 | 8d2cc64 | **대기열** |
| 업로드 세션 URI 이중 가림(실제 DB drill:restore 실패 수정) | 0c86db2 | **대기열** |
판정 요약 `M4_CODEX_VERDICTS.md`. 각 코드 커밋의 인계는 `T13/T14/T15_IMPLEMENTATION_HANDOFF.md`, `M4UI_IMPLEMENTATION_HANDOFF.md`, `screen-notes-m4.md`, `FIX_DRILL_MASK_HANDOFF.md`.
마지막 검사(0c86db2): lint·typecheck·build·unit 745·integration 570·drill:mock 0건·db:migrate(0034)·실제 DB drill:restore PASS.

## Codex 사용 한도
2026-10-02 21:31 FIX-T14 검토 중 Codex 사용 한도 도달("try again at Oct 3rd, 2026 10:06 PM"). 모델은 바꾸지 않는다(gpt-6-astra / xhigh 고정). 로컬 `.handoffs/codex-queue.txt` + `run-codex-queue.sh` 가 10-03 22:15 까지 기다렸다가 위 **대기열** 7건을 순서대로 검토한다(PC·앱이 켜져 있어야 함). 결과는 `.handoffs/review-<label>.md`.

## 결정
- D28: 인계·판정 사본은 docs/handoffs/ 에 추적하되 docs 전용 커밋으로만(코드 커밋과 분리).
- D26·D27 후속: 클라우드 잠정 판단 위에 FIX 라운드 변경을 기록. D26(a~f)·D27(a~h) 사용자 확인은 아직 받지 않음 — 잠정대로 진행 중.

## 화면 확인 (오케스트레이터 직접, 모의만) — `screen-notes-m4.md`
Threads·YouTube 모의 연결, /ops 계정 집계, 배포 계획 생성(예약 공개)·항목별 승인·실행·YouTube 업로드 → UPLOADED_PRIVATE("비공개 업로드 완료, 공개 전환 확인 필요") 확인. 결함 S1–S5 수정. 로컬 `.env.local` 에 이 PC 에서 만든 시험용 마스터 키 추가(값 비공개, git 무시).

## 남은 것
- Codex 대기열 7건 결과 → 수정 라운드.
- 사용자 확인: D26(a~f)·D27(a~h), 공개 /api/health 의 jobs·uploads·db.captures 를 세션 뒤로 옮길지(D23).
- 다음 작업 후보(검증이 따라온 뒤): T16 Instagram(모의), 모의 OAuth 발급 기록 DB 재수화(dev 서버 재시작마다 다시 연결해야 하는 불편).
- 실계정 연결 전 사용자 준비물(D24): Meta 앱·Threads 테스트 계정, Google Cloud 프로젝트·OAuth 동의 화면·YouTube API 감사, redirect URI, 마스터 키 위치, 첫 실계정 시험 원고·공개 범위.

## 2026-10-03 04:35 — M4 모의 범위 Codex 종결
- T13(FIX8 c82c721)·T14(FIX2 746aa3a)·T15(FIX1 cc26535)·화면(cd0a2aa)·가림(75dd988) 모두 Codex(gpt-6-astra/xhigh) PASS. 라운드별 판정은 `M4_CODEX_VERDICTS.md` 하단 요약.
- 마지막 검사(c82c721): lint·typecheck·build·unit 759·integration 600·drill:mock(M3·T14·T15) 0건·db:migrate(0035)·실제 로컬 DB drill:restore PASS.
- migration 0030~0035 로컬 적용. 외부 호출·새 의존성·비밀·실제 게시 0.
- 실계정 연결은 여전히 사용자 준비물·승인 대기(D24). D26(a~f)·D27(a~h) 사용자 확인 대기(잠정대로 진행 중).

## 2026-10-03 아침 — 밤사이 진행 (Codex 한도 복귀 후 00:55 ~)
- Codex 대기열 → 상주 실행기(`.handoffs/run-codex-daemon.sh`, 대기열 파일에 줄을 추가하면 자동 검토).
- **종결(Codex PASS)**: T13(FIX8 c82c721) · T14(FIX2 746aa3a) · T15(FIX1 cc26535) · 화면(S1–S5, G1·G2, 해제 안내 cd0a2aa) · 업로드 세션 가림(75dd988).
- **T16 Instagram(모의)**: 구현 620ed86(D29 잠정) → FIX1 165f0df(체크섬 대조·쓰기 5xx ambiguous·캐러셀 부모 요청 표식 0037) → FIX2 914ac36(sideEffect unknown 전 상태 코드 조회·표식 없는 옛 작업 부모 조회) — Codex 재검증 중.
- 마지막 검사(914ac36): lint·typecheck·build·unit 825·integration 628·drill:mock(M3·Threads·YouTube·Instagram) 0건·db:migrate(0037)·실제 로컬 DB drill:restore PASS. migration 0030~0037 로컬 적용.
- 외부 호출·새 의존성·비밀·실제 게시 0. 모의 연결용 로컬 시험 마스터 키는 `.env.local`(git 무시)에만.

## 사용자 결정 대기 (모아 보기)
1. **D26 (Threads, T14)** a~f — 잠정대로 진행 중(모의 Threads 어댑터 선택 규칙, 401 뒤 연결 확인, 잠정 요청 제한 250/24h, 부분 스레드 처리, 취소 중 부분 → UNKNOWN, 모의 공개 범위 가정).
2. **D27 (YouTube, T15)** a~h — 잠정(자리표시 scope, 갱신 시 refresh token 회전, 요청 결과 규칙, 예약 공개 표현, 잠정 할당량 6/24h, 업로드 뒤 취소, 썸네일 실패, 세션 URI 가림).
3. **D29 (Instagram, T16)** — 특히 **공개 미디어 URL 방식**(실제 Instagram 은 공개 URL 로 미디어를 가져감 — 이 앱이 짧은 서명 URL 을 열지/외부 호스트/수동 게시), scope 이름, 미디어 규격 수치, 요청 제한 25/24h, 캐러셀·영상 범위, Business/Creator 계정 유형, 공개 게시만.
4. **D23 남은 항목** — 공개 /api/health 의 jobs·uploads·db.captures 를 세션 뒤로 옮길지(Codex 권고: 옮김).
5. **D28** — 인계 사본을 docs/handoffs/ 에 추적하는 방식 유지 여부(AGENTS.md 규칙의 예외).
6. **실계정 연결 준비물(D24)** — Meta 앱(Threads·Instagram)·Google Cloud/YouTube API 감사, 테스트 계정, redirect URI, 마스터 키 보관 위치, 첫 실계정 시험 원고·공개 범위.

## 다음 후보
- T16 Codex 결과 반영(필요 시 FIX3).
- 모의 OAuth 발급 기록 DB 재수화(dev 서버 재시작마다 다시 연결해야 하는 불편).
- T17(추가 채널) — 사용자 선택 필요. M5: T18 Notion·Drive 가져오기(모의), T19 허용 소스 수집(모의, 기본 OFF).
