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
