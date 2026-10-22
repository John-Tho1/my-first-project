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
- **T16 Instagram(모의)**: 구현 620ed86(D29 잠정) → FIX1 165f0df(체크섬 대조·쓰기 5xx ambiguous·캐러셀 부모 요청 표식 0037) → FIX2 914ac36(sideEffect unknown 전 상태 코드 조회·표식 없는 옛 작업 부모 조회) — **Codex PASS(07:33) → 종결**.
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

## 2026-10-03 10:00 — 아침 마감
- M4-DEV1(모의 OAuth 재수화, dev 서버 재시작 뒤 모의 연결 유지): 0d9911b → FIX1 b3041c0 → **FIX2 63ad062 Codex PASS**.
- 열린 Codex 지적 없음. M4 모의 범위(T13~T16)·화면·가림·재수화 모두 종결.
- 마지막 검사(63ad062): lint·typecheck·build·unit 831·integration 647·drill:mock(M3·Threads·YouTube·Instagram) 0건·실제 로컬 DB drill:restore PASS.
- Codex 상주 실행기는 정지(`.handoffs/codex-daemon.stop`). 다시 쓰려면 stop 파일을 지우고 `nohup bash .handoffs/run-codex-daemon.sh &`.

## 2026-10-03 23:00 — T19 종결
- T19(허용 소스 수집, 모의·기본 OFF): 4a2e02f → FIX1 66e1257 → **FIX2 f07153c Codex PASS**. 마지막 검사(f07153c): lint·typecheck·build·unit 1269·integration 738·drill:mock 0건·db:migrate·drill:restore PASS.
- M5 모의 범위(T18·T19) 종결. 남은 것: T17(보류), T21 운영 배포(승인 필요 — D30-1 서명 URL 의 전제), Threads 2단계(사용자와 함께, D31), D32·D33 사용자 확인.
- 다음(로컬·결정 불필요): T19 남은 위험 중 소스 등록 상한 경쟁(동시 등록으로 51개) 보강.
- T19-H1(소스 상한 동시 등록 경쟁): 1e47574 **Codex PASS**.

## 2026-10-10 — LIVE-L1(D34 1단계, 실제 Claude 어댑터) 종결
- D34(사용자 결정): 첫 실제 AI = Claude(Anthropic), 기본 모델 `claude-opus-5-5`, 월 상한 10 USD. 1단계 = 코드·기록된 응답 시험만(실제 호출 0, 과금 0).
- 2cbcb49 → FIX1 d7da959 → FIX2 ea5954b → FIX3 a4da041 → **FIX4 2b05044 Codex PASS**. 인계: `LIVEL1_IMPLEMENTATION_HANDOFF.md`.
- 마지막 검사(2b05044): lint·typecheck·build·unit 1401·integration 786·drill:mock 0건·db:migrate·drill:restore PASS.
- 핵심: 공식 SDK 0.128.0 고정·재시도 0·목적지/헤더 고정·오류 원문 차단, 예약 = 보수적 추정(상한 증명 아님) + 실제 usage 정산(출처 provider/estimate/none/provider_unstorable), `LLM_LIVE_MAX_RUNS`(승인 기록별 실제 호출 수 제한), 본문 1인칭 문단 → 확인 필요 claim.
- 남은 위험: 동시 초과 누적(LLM_LIVE_MAX_RUNS=1 이면 1회분), provider_unstorable 해제는 수동, Postgres 다중 연결 동시성 미검증, 사용자가 직접 쓴 1인칭은 게이트 대상 아님(기존 설계).
- 다음: D34 2단계(실제 호출 1회) — 사용자 승인 필요.
- LIVEL1-H1(Codex FIX4 놓친 케이스 보강): 259f4f9 **Codex PASS**. 검사: unit 1405·integration 789·drill·restore PASS. NFD 1인칭 탐지 수정 1줄, 나머지는 시험 추가.
- 남은 보강 후보(Codex LIVEL1H1 놓친 케이스, 우선순위 낮음): resolution 형식 검증, 모의 provider 도 공통 1인칭 판별 함수 사용, NFC/NFD 교차 중복, 복원 후 월 예산 반영, 복원 실패 시 필드 값 보존, Postgres 다중 연결(미검증).

## 2026-10-12 — D34 2단계(실제 Claude 호출 1회) 완료
- 사용자 승인("2단계 승인") → 가상 소재(`LIVEL1_STAGE2_MATERIAL.md`)로 작성 보조 '개요' 1회: **성공**. 예약 0.105476 USD / 실제 0.035192 USD, 토큰 입력 1988 · 출력 1362(공급자 보고). 허용 목록 밖 출처 4건 서버가 버림. 직후 승인 기록 제거로 잠금.
- 준비 중 발견·수정: LIVE-UI(a9898a6) → FIX 5bd62f3 **Codex PASS** — 실제 모드에서 화면이 "모의"로 표시되던 문제, 결과 출처 mock/live/출처 미확인 구분.
- 다음 후보: 예약 추정 교정(실제 입력이 추정의 약 1/3), 실사용(D34 범위 확장)은 사용자 승인 필요.

## 2026-10-12 저녁 — T21 선행 작업(로컬, 사용자 부재 중 자율 진행)
- D35 일시 중지(Anthropic 지원 지역 확인 전 — 사용자 확인 필요). Threads 2단계는 설정 완료·형식 확인, 실제 OAuth 는 사용자 로그인 필요로 대기.
- T21-P3(공개 health 생존 확인만·상세는 세션): 449da0f **Codex PASS**. 검사 unit 1411·integration 793·drill·restore PASS.
- 진행 순서: P1a(운영 빌드 dev 로그인 차단·로그인 횟수 제한) → P2(tick 타이머·배포 설정 파일) → P1b(일반 OIDC, 가짜 IdP 시험).
- T21-P1a(운영 빌드 dev 로그인 거부·로그인 실패 15분 10회 제한·판정 원자화): e70f7d4 → FIX1 e57cfa5 → FIX2 a448b78 → **FIX3 6f7a2a7 Codex PASS**. 검사 unit 1437·integration 816·drill·restore PASS. 남은 위험: Postgres 다중 연결 미검증(G2), 공격자의 전역 잠금으로 새 로그인 15분 차단 가능(기존 세션 유지), 순번 소진 시 관리자 정리 필요.
- T21-P2(inline 주기 타이머·오래된 예약 60분 차단(D36 잠정)·deploy/ 예시와 스크립트): b73fc65 → FIX1 f351b7a → FIX2 69bf4b0 → FIX3 4e3490a → FIX4 47917f3 → **FIX5 e1025ba Codex PASS**. 앱 검사 unit 1466·integration 833 PASS, 배포 bash 시험 286(가짜 명령). 남은 위험: 배포 스크립트는 실제 Linux·root·flock·bind mount·PGlite 백업→복원→기동 미실행(서버 생긴 뒤 1회 확인 필요).
- TEST-TIMEOUT(import 2MB 선형성 시험 벽시계 30초): f71f7ad Codex PASS.
- T21-P1b(일반 OIDC 로그인 — openid-client 6.8.8, PKCE·state·nonce, 서명 검증 강제, 허용 이메일·sub, 가짜 IdP 시험): af9860c → FIX1 e75fa0c → **FIX2 1beee05 Codex PASS**. 검사 unit 1550·integration 878 PASS. migration 0043(auth_oidc_states). 남은 위험: 실제 IdP·프록시 뒤 callback URL 미확인(첫 배포 때 확인 — 불일치면 로그인 실패가 전역 제한에 누적), 미고지 JWKS 키 교체 후 최대 1분 실패, Postgres 다중 연결 미검증.

## 2026-10-13 낮 — T21 로컬 선행 작업 종결
- P3(health)·P1a(dev 로그인 차단·제한)·P2(타이머·배포 파일)·P1b(OIDC) 모두 Codex PASS. 운영 배포에 남은 것은 **사용자 결정·승인**: IdP 선택·등록, 호스팅·도메인 선택(T21_DEPLOY_REVIEW §3), 서버 밖 백업 위치(P4/G5), D36(60분) 확인, D35 재개 여부(Anthropic 지원 지역), Threads 2단계(사용자 로그인 필요). 선택 과제: Postgres 드라이버(P5/G2).

## 2026-10-13 오후 — D31 2단계 완료 · D35 재개 · D36 확정 · D37 배포 대기
- Threads 실제 연결 성공(@yongho.tho, 만료 2026-12-12, 게시 없음). 로컬 HTTPS(`content-studio-dev-https`, 127.0.0.1 바인드)로 전환 — Meta 가 http redirect 거부.
- D35 재개(사용자가 지원 지역 확인). D36(오래된 예약 60분) 확정. D37 운영 배포 대기.
- DEV-LOG(콜백 query 로그 제외) 4f0bc1d **Codex PASS**.
- LIVE-P1(D38 1단계 — 실제 Threads 글 게시 어댑터, fixture 시험만): 320dadb → FIX1 1a22434 → **FIX2 b8a7200 Codex PASS**. 검사 unit 1630·integration 895 PASS. migration 0044 로컬 적용(백업 data/pglite.bak-20261013-pre0044). 남은 위험: 결과 불명 게시는 항상 UNKNOWN(사용자 확인), GET 질의 토큰의 앱 밖 기록 미검증, Postgres 독립 연결 동시성 미검증, 화면은 브라우저 미확인(2단계 때 확인).
- LIVEP1-TIMEOUT(98f11cd → FIX e708106 PASS)·LIVEP1-USERCONFIRM(a67f462 → FIX 2af529b PASS) 종결. migration 0045 로컬 적용(백업 data/pglite.bak-20261014-pre0045), drill:restore PASS.
- UI-CLEAN(fdb6aea → FIX 254ee5e PASS): 메뉴 5묶음+소메뉴·현재 위치 강조, 모든 화면 위치 경로, 긴 설명 '자세히'로 접기(안전 표시 유지·ui-safety 시험), 실제/MOCK 안내를 계정·기록 상태로. 검사 unit 1788·integration 917 PASS. 브라우저 확인: 데스크톱·375px 가로 넘침 없음.
- DESIGN-A(9bbf96a PASS): 사용자 선택 샘플 A(Apple 시스템 다크) — 순흑 배경·세그먼트 메뉴·묶음 목록 행·시스템 색, 실제(주황 tag live)/MOCK(회색 점선 tag mock) 분리, AA 대비 시험, 밝은 모드 대응. 브라우저 확인(데스크톱·375px).

## 2026-10-19 — D39 승인 · 클라우드 인계
- 사용자 승인: Threads 평상시 실제 게시(최근 24시간 3건 상한·즉시 중지 스위치) + 만료 관리 → D39. 계획 `LIVEP2_EXPIRY_PLAN.md`.
- 로컬 PC 메모리 부족(dev 서버 컴파일 중 V8 OOM 2회)으로 구현·검사는 클라우드로 인계: `M4_CLOUD_KICKOFF_D39.md`. Codex 검증·실제 설정 적용은 로컬.
- 게시는 계속 잠김(PUBLISH_MODE=disabled). 로컬 dev 서버·Codex 실행기 꺼짐.

## 2026-10-19~20 — D39 구현(클라우드 세션)
- 사용자 지시(2026-10-19): 로컬로 돌아가지 않고 **클라우드에서 계속** 진행. 클라우드에는 Codex CLI·OpenAI 인증이 없어 Codex 검증은 미실행으로 남고, 대신 Claude 독립 검토(여러 관점 + 지적마다 반박 검증, **Codex 판정 아님**)를 돌린다.
- **LIVE-P2**(Task A, 최근 24시간 실제 게시 상한 + 즉시 중지 스위치, migration 0046): 코드 **ca7228e**, 인계 c5597e1(`LIVEP2_IMPLEMENTATION_HANDOFF.md`). 검사(클라우드 Node 22.22.2, 오케스트레이터 순차 재실행): lint·typecheck·build PASS, unit 76 files / 1838, integration 51 files / 928, drill:mock 위반 0, test-check-env.sh 58/58, lockfile 불변.
- **EXPIRY-1**(Task B, Threads 실제 연결·로컬 인증서 만료 14일 전 경고, `scripts/dev-cert.sh check|renew`): 코드 **5739e5a**, 인계 0b7220f(`EXPIRY1_IMPLEMENTATION_HANDOFF.md`). 검사: lint·typecheck·build PASS, unit 79 files / 1885, integration 51 files / 928, drill:mock 위반 0, test-dev-cert.sh 82/82, lockfile 불변. `renew` 는 임시 디렉터리에서만 시험(실제 경로 실행 안 함).
- not_run: Codex(클라우드 불가), 실제 Postgres 다중 연결(LIVE-P2 경쟁 시험은 PGlite 단일 연결이라 advisory 잠금 자체를 증명하지 못함), 브라우저 렌더링, 사용자 PC 의 실제 인증서·Windows Git Bash, `./data` migrate(0046)·`drill:restore`, 실제 Threads.
- 알려진 불안정: `packages/db/src/lock.test.ts`(다중 프로세스 시간 시험) 첫 단위 실행 1건 실패 → 단독·재실행 PASS(이번 작업과 무관한 파일).
- Codex 큐 줄(나중에 로컬에서 쓸 경우): `ca7228e LIVEP2 docs/handoffs/LIVEP2_IMPLEMENTATION_HANDOFF.md`, `5739e5a EXPIRY1 docs/handoffs/EXPIRY1_IMPLEMENTATION_HANDOFF.md`.
- D39 실제 적용(`.env.local` 의 PUBLISH_MODE=enabled·PUBLISH_LIVE_APPROVAL_REF=D39·PUBLISH_LIVE_MAX_POSTS=1000·PUBLISH_LIVE_DAILY_MAX=3, `./data` 백업 → `db:migrate`(0046))은 사용자 PC 또는 운영 배포(D37, 승인 필요)에서만 가능 — 그 전까지 게시는 잠김(PUBLISH_MODE=disabled).
- (이 줄은 아래 "2026-10-20 — 독립 검토·FIX·보강" 절로 완료됨.)
- 푸시 메모: 2026-10-19 한때 GitHub 앱 권한 403 → 사용자가 앱 권한 정리 후 해결. 1회 `commit_refs` 일시 오류는 재시도로 해결.

## 2026-10-20 — 독립 검토·FIX·보강(클라우드 세션, Codex 대신 Claude 독립 검토)
- 방식: 읽기 전용 검토자 5명(관점별) + 지적마다 반박 검증(P0·P1 3표 중 2표, P2 1표). **Codex 판정 아님.** 기록 `D39_CLAUDE_REVIEW.md`(1차 bc24fbe, 2차 41bd767).
- 1차(LIVE-P2 ca7228e · EXPIRY-1 5739e5a): 확정 21(중복 포함, P1 2 = 같은 시험 누락)·기각 3.
  - **LIVE-P2 FIX1 7538492**(인계 4865c23): 다음 가능 시각(상한 초과·분 올림), 중지 시험(P1), 결과 불명 → resume → 중지/상한 보류 재시도 가능, 게시 시도 표식 전 중지 재확인, 화면 중지 표시, 오래된 예약 재시도, 잠금 순서 시험, 모의 미집계·화면 연결 시험. unit 1896 · integration 938.
  - **EXPIRY-1 FIX1 92cd026**(인계 1cb9d3c): 해제 중 연결 경고 제외, 운영 기본 경로 시험, 인증서 교체 되돌리기·원자성, 대소문자 무시 같은 이름, bash 시험 보강. unit 1906 · integration 938 · test-dev-cert 165.
- 보강 후보 조사(읽기 전용 워크플로): 7개 중 2개는 이미 처리됨(목적 섞인 계획 승인·계획 만들기 입력 = M4UI cd0a2aa, Codex PASS — 위 "클라우드 세션이 남긴 화면·흐름 공백" 문구는 오래된 기록).
  - **LIVEL1-H2 990fd5d**(인계 41addc3): 복원 시 수동 해결(resolution) 형식 검증, 모의 provider 공통 1인칭(NFC), 경험 claim NFC 중복 제거, 복원 예산·실패 시 값 보존 시험. unit 1931 · integration 952.
- 2차(7538492 · 92cd026 · 990fd5d): 확정 12(중복 2쌍, 실질 10, **전부 P2**)·기각 2.
  - **FIX2 561bc5f**: 재개 증명 + 표식만 있는 경우 거부 시험, 잠금끼리 순서 시험, 마지막 시도 표식 전 중지 → 재시도 가능(그 시도 미집계), 설정 다음 가능 시각·오래된 예약 경로 시험, 해제 중 + 정리 대기 연결 경고 제외, dev-cert 정리 중 errexit·신호, 점 이름 거부·백업 누락 가드, 키 누출 단언, 운영자 수동 해결 절차 갱신 + 읽기 전용 `pnpm bundle:check <zip>`.
  - 마지막 검사(561bc5f, 클라우드 Node 22.22.2): lint·typecheck·build PASS, **unit 81 files / 1934 · integration 51 files / 956** · drill:mock 위반 0 · test-dev-cert.sh 251/251 · lockfile 불변(새 의존성 0) · 외부 호출 0.
- not_run: Codex(클라우드 불가), FIX2 에 대한 3차 독립 검토, 실제 Postgres 다중 연결, 브라우저, Windows Git Bash·macOS 의 dev-cert.sh, 사용자 PC 의 실제 인증서, `./data` migrate(0046)·`drill:restore`, 실제 Threads·Claude.
- 확인 필요(잠정 적용):
  1. LIVE-P2: 게시 시도 표식 전 중지로 끝난 시도를 max_attempts 에 세지 않음(사용자 중지·재개·재시도가 있어야 하므로 유한). 시도 표시가 6/5 처럼 보일 수 있음.
  2. LIVE-P2: 다음 가능 시각 표시는 다음 분으로 올림. 상한 미설정 = 상한 없음(D39 적용 값 3 으로 해소).
  3. EXPIRY-1: error·needs_reconnect·expired 실제 연결은 계속 경고, 해제 중·해제됨만 제외. 만료된 인증서도 `check` 는 exit 0.
  4. LIVEL1-H2: settled_amount 는 actual 과 같음, 단 actual > reserved(상향 재정산·상한)일 때만 더 클 수 있음. 실제 Claude 출력에서 NFC 만 다른 경험 claim 을 합침(확인 수·경고 수가 줄 수 있음). **실제 `./data` 에 옛 형식의 수동 해결 행이 있으면 그 백업 복원이 거부될 수 있으니 적용 전 `pnpm bundle:check` 로 확인.**
- Codex 큐 줄(나중에 로컬에서 쓸 경우, 순서대로): `ca7228e LIVEP2`, `5739e5a EXPIRY1`, `7538492 FIX1-LIVEP2`, `92cd026 FIX1-EXPIRY1`, `990fd5d LIVEL1H2`, `561bc5f FIX2-D39` — 인계 문서는 각각 `docs/handoffs/{LIVEP2,EXPIRY1,LIVEL1H2}_IMPLEMENTATION_HANDOFF.md`.
- D39 실제 적용(`.env.local`·`./data` migrate 0046·실제 게시)은 여전히 사용자 PC 또는 운영 배포(D37, 승인 필요)에서만. 게시는 잠긴 상태(PUBLISH_MODE=disabled).

## 2026-10-21 — 3차 독립 검토·FIX3(클라우드 세션)
- 3차 Claude 독립 검토(Codex 아님, FIX2 561bc5f 대상, 에이전트 10개): 확정 3(**전부 P2**)·기각 3. 라운드별 확정 21 → 12(실질 10) → 3 — 수렴.
- **FIX3 e7c73c9**: dev-cert 인증서 쪽 백업 가드 시험(271/271), 운영자 수동 해결 SQL 안전화(잘못 채우면 0행·returning 1행·확인 질의) + 이미 resolution 이 있는 행용 수정문(original_reported 보존), `bundle:check` 미해결 건수 표시, 7-④ 의 RESTORE_LOCAL_DIR 쓰기 경로 안내. 인계: EXPIRY1·LIVEL1H2 "FIX round 3" 절.
- 마지막 검사(e7c73c9, 클라우드 Node 22.22.2): lint·typecheck·build PASS, **unit 81 files / 1934 · integration 51 files / 959** · drill:mock 위반 0 · test-dev-cert.sh 271/271 · lockfile 불변 · 외부 호출 0.
- not_run: Codex, FIX3 에 대한 4차 독립 검토, 실제 Postgres 다중 연결, 브라우저, Windows Git Bash·macOS, `./data` migrate(0046)·`drill:restore`, 실제 Threads·Claude.
- 확인 필요(추가, 잠정 적용): 수정문이 usage_source 도 가드 아래 다시 씀, SQL 은 none ⇒ actual = reserved 를 강제(검증기보다 엄격), 추가 키·original_reported 없는 옛 수동 해결 행은 "멈춤"만 안내.
- Codex 큐 줄(추가): `e7c73c9 FIX3-D39 docs/handoffs/LIVEL1H2_IMPLEMENTATION_HANDOFF.md`(FIX2 줄 다음).

## 2026-10-21 — 4차 독립 검토·FIX4(클라우드 세션)
- 4차 Claude 독립 검토(Codex 아님, FIX3 e7c73c9 대상, 기록 8bff163): 확정 11(**실질 전부 P2**)·기각 4. 대부분 손으로 채워 실행하는 운영자 수동 해결 SQL 에서 나옴 → 가드를 더하지 않고 SQL 자체를 없앰.
- **FIX4 fb1fa58**: 수동 해결 SQL → 검증기(`isValidResolution`)를 그대로 쓰는 CLI `corepack pnpm ledger:resolve` (`--list` 읽기 전용 · 기본 미리보기 · `--confirm` 정확히 1행 + 재검증 + 감사 · 이미 해결된 행은 `--correct` 필수). 운영 절차(LIVEL1 인계 2·4~7단계)·README 갱신, `bundle:check` 미해결 건수 시험, 7-④ `.env.local` 우선순위 시험. 인계: LIVEL1H2 "FIX round 4" 절(a490261).
- 마지막 검사(fb1fa58, 클라우드 Node 22.22.2, 순차): install --frozen-lockfile(lockfile 불변) · lint·typecheck·build PASS, **unit 81 files / 1934 · integration 52 files / 980** · drill:mock 위반 0 · test-dev-cert.sh 271/271 · 보이지 않는 문자 0 · 외부 호출 0 · 실제 `./data` 미접근.
- not_run: Codex, FIX4 에 대한 5차 독립 검토(이어서 진행), 실제 Postgres 다중 연결, 브라우저, Windows Git Bash·macOS(CLI 인자 인용·UTF-8 포함), `./data` migrate(0046)·`drill:restore`, 실제 Threads·Claude.
- 확인 필요(추가, 잠정 적용): 운영 절차가 SQL → CLI 로 바뀜(손으로 쓰는 SQL 미지원), `--list` 는 보고 값을 출력, 수정 모드는 original_* 증거가 있으면 현재 usage_source 를 가리지 않음, 버리는 DB 경로는 `./data/pglite-check-<날짜>`(기본 data 폴더와 겹치지 않는 하위 폴더).
- Codex 큐 줄(추가): `fb1fa58 FIX4-D39 docs/handoffs/LIVEL1H2_IMPLEMENTATION_HANDOFF.md`(FIX3 줄 다음).

## 2026-10-21 오후 — 5차 독립 검토·FIX5(클라우드 세션)
- 5차 Claude 독립 검토(Codex 아님, FIX4 fb1fa58 대상, 에이전트 30개 — 첫 실행이 세션 한도로 일부 실패해 한도 해제 뒤 이어 실행, 기록 cacfd05·4edf71e): 확정 9(**전부 P2**, P0·P1 없음)·기각 16.
- **FIX5 4769c4e**: `ledger:resolve` 적용은 미리보기 확인 지문 `--expect` 필수(`expect_mismatch`), by/reason 을 받은 그대로 이스케이프 표시 + `"`·`%`·`\` 거부(`text_shell_unsafe`)·문서 `MSYS_NO_PATHCONV=1`, 이미 유효한 행 정정은 `--overwrite-valid`(`already_valid`), DB 폴더 없으면 만들지 않음, 해결 owner 를 1단계 export 범위로(`owner_not_exported`), 원자성(트리거)·누출·큰 수·형제 단언 시험. 인계: LIVEL1H2 "FIX round 5" 절.
- 마지막 검사(4769c4e, 클라우드 Node 22.22.2, 순차): install --frozen-lockfile(lockfile 불변) · lint·typecheck·build PASS, **unit 81 files / 1934 · integration 52 files / 999** · drill:mock 위반 0 · test-dev-cert.sh 271/271 · 보이지 않는 문자 0 · 외부 호출 0 · 실제 `./data` 미접근.
- not_run: Codex, FIX5 에 대한 6차 독립 검토, 실제 Postgres 다중 연결, 브라우저, Windows Git Bash·macOS(cmd.exe 스크립트 셸·MSYS 변환 포함), `./data` migrate(0046)·`drill:restore`, 실제 Threads·Claude.
- 확인 필요(추가, 잠정 적용): 운영 명령이 두 번(미리보기 → `--expect <지문> --confirm`)으로 바뀜, by/reason 에 `"`·`%`·`\` 를 쓸 수 없음, 다른 owner 는 모든 명령 앞 `AUTH_ALLOWED_IDENTITY=` 로만, 적용 실행이 실패해도 by/reason 이 터미널에 남음.
- Codex 큐 줄(추가): `4769c4e FIX5-D39 docs/handoffs/LIVEL1H2_IMPLEMENTATION_HANDOFF.md`(FIX4 줄 다음).

## 2026-10-21 저녁 — 6차 독립 검토·FIX6(클라우드 세션)
- 6차 Claude 독립 검토(Codex 아님, FIX5 4769c4e 대상, 에이전트 22개·실패 0, 기록 7340e8b): 확정 6(**실질 전부 P2** — #5 는 검증자 1명 P1·2명 P2)·기각 9. 라운드별 확정 21 → 12 → 3 → 11 → 9 → 6.
- **FIX6 1b6e4f4**: FIX5 의 `MSYS_NO_PATHCONV=1` 앞붙임 제거(Git Bash 의 corepack shim 이 시작하지 못할 수 있음 [추정]) + `/` 로 시작하는 값 거부, 셸 문자 거부에 `& | < > ^` 추가·문구 정정(도착한 문자만 봄), 보이지 않는 기본 무시 문자(한글 채움 문자 등) 이스케이프 표시, 불필요한 `--overwrite-valid` 거부(`overwrite_not_needed`), 정정 전 settled_amount·resolved_at 표시·감사, 시험 보강(정정·반쯤 끝난 행 거부, `updated 1` 뒤 exit 1), 1단계 기준값 보완. 인계: LIVEL1H2 "FIX round 6" 절.
- 마지막 검사(1b6e4f4, 클라우드 Node 22.22.2, 순차): install --frozen-lockfile(lockfile 불변) · lint·typecheck·build PASS, **unit 81 files / 1934 · integration 52 files / 1002** · drill:mock 위반 0 · test-dev-cert.sh 271/271 · 보이지 않는 문자 0 · 외부 호출 0 · 실제 `./data` 미접근.
- not_run: Codex, FIX6 에 대한 7차 독립 검토, 실제 Postgres 다중 연결, 브라우저, **Windows Git Bash 에서 `corepack pnpm ledger:resolve` 실제 실행**(인용·경로 변환·corepack shim), macOS, `./data` migrate(0046)·`drill:restore`, 실제 Threads·Claude.
- 확인 필요(추가, 잠정 적용): 운영 명령 앞붙임 없음, by/reason 에 `" % \ & | < > ^` 와 앞 `/` 를 쓸 수 없음(`R&D` 등도 거부), 정정 감사에 정정 전 settled_amount·resolved_at 을 남김. **사용자 PC 에서 처음 쓸 때 `corepack pnpm ledger:resolve --list` 가 Git Bash 에서 실행되는지 먼저 확인.**
- Codex 큐 줄(추가): `1b6e4f4 FIX6-D39 docs/handoffs/LIVEL1H2_IMPLEMENTATION_HANDOFF.md`(FIX5 줄 다음).

## 2026-10-22 — 전체 코드 Claude 독립 검토 1차·FIX1-FULLREV(클라우드 세션)
- 사용자 지시(2026-10-21 "현재까지의 전체 코드 리뷰를 클로드 코드 리뷰로 진행해줘", "권고사항대로 진행해줘"). Claude 독립 검토이며 Codex 아님. 대상 `origin/main...a0521fe` 의 앱 전체(631 files), 기록 b533650(`FULLREV1_CLAUDE_REVIEW.md`).
  - 지적 10 → 확정 7(F1·F2·F3 P1, F5·F6·F7·F9 P2) · 기각 3(F4 D12·D13 수용 위험, F8 작업 키로 감사 연결 유지, #10 D28·D30).
- **FIX1-FULLREV af1d0b5**:
  - 승인 철회 뒤 남은 보류 작업을 상한에서 세지 않음.
  - 일부 게시 뒤 승인 철회·무효·취소·작업 처리기 멈춤은 모두 UNKNOWN 이다(다시 게시 안 함). 판정은 하나를 공유한다.
  - 업로드 MIME 별칭 정규화, 복원 ZIP 구간 겹침 거부, mock 시험 인자 판정을 빌드 때 고정, 검색 날짜 왕복 확인.
  - **migration 0047**(send_intents 부분 인덱스 2개).
  - 고친 결과 반박 검토 3회 + 보완 3회(확정 1 → 10 → 2 → 0). 인계: `FULLREV1_IMPLEMENTATION_HANDOFF.md`.
- 마지막 검사(af1d0b5 와 같은 코드, 클라우드 Node 22.22.2, 순차):
  - install --frozen-lockfile(lockfile 불변) · lint·typecheck·build PASS
  - **unit 83 files / 1974 · integration 56 files / 1047**
  - drill:mock 위반 0 · test-dev-cert.sh 271/271 · 보이지 않는 문자 0 · 외부 호출 0 · 실제 `./data` 미접근
- not_run: Codex, 실제 Postgres 다중 연결, 브라우저(.m4a 실제 업로드 포함), Windows Git Bash·macOS, `./data` **migrate(0046·0047)**·`drill:restore`, 실제 Threads·Claude.
- 확인 필요(추가, 잠정 적용):
  - 부분 게시 뒤 멈춘 항목은 "실행 전"으로 돌아가지 않고 결과 불명으로 남는다(다시 승인·실행 불가 — Threads 에서 직접 확인).
  - 실제 계정은 게시 시도 표식 뒤 동시 취소면 UNKNOWN 이다.
  - 사용자 PC 에서 다음에 DB 를 열면 0046 과 0047 이 함께 적용된다(서버 끈 상태, 백업 먼저).
- Codex 큐 줄(추가): `af1d0b5 FIX1-FULLREV docs/handoffs/FULLREV1_IMPLEMENTATION_HANDOFF.md`(FIX6 줄 다음).

## 2026-10-22 오후 — FIX2-FULLREV(클라우드 세션)
- 사용자 결정(2026-10-22 "다 권고 사항으로 진행해줘"): FULLREV1 검토자 질문 1~4 모두 권고안이다.
- **FIX2-FULLREV 13f29b3**:
  - 부분 게시 뒤 최종 실패·조회 한도는 FAILED 대신 UNKNOWN(`thread_partial_failed`·`thread_partial_unresolved`)이다.
  - 부분 게시·복원 미확정 UNKNOWN 은 상태 태그·작업 줄·안내 어디에서도 새 계획을 권하지 않는다(모의 카드는 모의 문구).
  - 복원한 작업 취소는 기록이 증명할 때만 "보내지 않음"이다(`restored_cancel_unverified`).
  - 취소 요청 시각은 처음 값을 유지한다.
  - 반박 검토 2회(확정 5 → 3, 모두 P2) 뒤 보완했다. 인계: `FULLREV1_IMPLEMENTATION_HANDOFF.md` "FIX round 2".
- 마지막 검사(13f29b3 와 같은 코드, 클라우드 Node 22.22.2, 순차):
  - install --frozen-lockfile(lockfile 불변) · lint·typecheck·build PASS
  - **unit 83 files / 1990 · integration 58 files / 1063**
  - drill:mock 위반 0 · test-dev-cert.sh 271/271 · 보이지 않는 문자 0 · 외부 호출 0 · 실제 `./data` 미접근
- not_run: Codex, 실제 Postgres 다중 연결, 브라우저, Windows Git Bash·macOS, `./data` migrate(0046·0047)·`drill:restore`, 실제 Threads·Claude.
- 확인 필요(추가, 잠정 적용):
  - 일부 게시된 스레드가 뒤에서 실패하면 "실패" 대신 "결과 불명"이다.
  - 옛 묶음(0031 이전)에서 복원한 작업을 취소하면 "결과 불명"이 될 수 있다.
- Codex 큐 줄(추가): `13f29b3 FIX2-FULLREV docs/handoffs/FULLREV1_IMPLEMENTATION_HANDOFF.md`(FIX1-FULLREV 줄 다음).
