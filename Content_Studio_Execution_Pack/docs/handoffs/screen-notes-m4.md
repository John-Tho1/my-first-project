# M4 화면 확인 (2026-10-02, 로컬 내장 브라우저, 커밋 cbb8d38, 오케스트레이터 직접 확인)

확인자: 구현 오케스트레이터(Claude) — 사용자 확인 아님. 모의(MOCK)만, 외부 호출 0.
준비: `.env.local` 에 이 PC 에서 생성한 로컬 시험용 `SECRETS_MASTER_KEY`·`SECRETS_KEY_VERSION=1` 추가(값 비출력, git 무시 파일, 실서비스 키 아님).

## 통과
- 설정 → 배포 계정 연결: 서버 암호화 키 "설정됨(키 버전 1)", redirect URI 표시, live 준비 안 됨 목록(LIVE_OAUTH_ADAPTER T14 미구현) 표시.
- Threads 모의 연결: 연결(모의) → 동의 → 콜백 → "계정을 연결했습니다(MOCK)", 행이 연결됨·만료 2026-12-01·필요/허락 scope(threads_basic, threads_content_publish)·마지막 확인·다시 연결/지금 갱신/연결 확인/연결 해제 버튼.
- YouTube 모의 연결: 연결됨·만료 2027-03-31(refresh token 180일)·scope youtube.upload(mock).
- 화면 HTML 에 토큰·봉인(csk1:)·code 형태 문자열 0건.
- /ops: 배포 계정 연결 — 연결 정보 없음 2·연결됨 2·연결 해제됨 0·다시 연결 필요 0, 차단 규칙 안내.
- /distribute/{id}(T14 이전 승인 전 Threads 계획): 스냅샷 달라짐·예약 지남 → 승인·실행 불가 표시(정상 차단). Threads 단계 패널·모의 시나리오 9종 표시.
- 서버 오류 로그 0건.

## 결함 (화면 표시만 — 데이터·실행에는 영향 없음)
- S1 [P2] /distribute/{id} 에 T14 이전 일반 모의 어댑터로 이미 CONFIRMED 된 Threads 계획이 "Threads 단계 … 아직 원격 단계 없음(게시물 2개 — 컨테이너 생성 → 게시 순서로 진행)"으로 보인다. 패널이 계정의 현재 연결 상태로 어댑터를 고르기 때문(T14 P0 와 같은 종류, 화면 쪽). 기대: 작업의 전송 의도에 기록된 어댑터(없으면 mock_generic) 기준 — 일반 모의로 처리된 작업은 "일반 모의 어댑터로 처리됨 — Threads 단계 기록 없음".
- S2 [P3] /distribute 상단 배너가 "지금 단계(M3)는 모의 배포만 합니다" — M4(모의 어댑터·모의 연결) 기준 문구로.
- S3 [P3] /distribute "배포 계정" 목록이 상태를 `mock_ready` 로만 보여 주고 연결 상태(연결됨·다시 연결 필요 등)를 반영하지 않는다. 문구도 "실제 Threads 계정 연결은 아직 없으며(T14, 별도 승인)" — T14 는 모의 구현됨.

## 확인 못 함
- 새 Threads·YouTube 계획을 화면으로 만들어 승인·실행까지(콘텐츠·채널 초안 검토 상태 준비 필요 — 통합 테스트가 같은 흐름을 덮음).
- 복원 화면의 "배포 계정 다시 연결 필요" 블록(복원 ZIP 업로드 필요).

## 수정(오케스트레이터 지시)
BASE cbb8d38, 커밋 안 함(작업 트리 변경). 화면 표시만 — 작업·승인·조회(reconcile) 로직 변경 없음.
- S1 → `packages/db/src/distribution.ts` getPlanDetail 에 읽기 전용 `latestIntent`(가장 최근 작업의 가장 최근 전송 의도 attempt·sanitized_details) 추가. `apps/web/lib/distribution.ts` `stepsPanelView`: 전송 의도가 있으면 `recordedAdapterIdOf`(adapter_id 없음·null → mock_generic), 없을 때만 현재 선택(`adapterIdFor`). 일반 모의로 처리된 Threads/YouTube 항목은 "일반 모의 어댑터로 처리됨 — Threads 단계 기록 없음(MOCK)" / "… YouTube 업로드 단계 기록 없음(MOCK)", 모르는 adapter_id 는 "확인할 수 없음" 한 줄. `/distribute/[id]` 는 `StepsPanel` 로 이 함수만 따른다(모의 시나리오 선택은 다음 실행용이라 현재 선택 그대로). 테스트: `apps/web/lib/distribution.test.ts` stepsPanelView 11건.
- S2 → `/distribute` 배너: "지금 단계(M4)는 모의 어댑터(일반·Threads·YouTube 모의)와 모의 계정 연결만 … 결과와 원격 ID 는 모두 MOCK". 테스트: 문구(화면) — typecheck·build.
- S3 → `/distribute` 배포 계정 목록이 `listAccountHealth`(설정 화면과 같은 판정·`CREDENTIAL_STATUS_LABEL`)로 연결 상태 표시, 정리 대기는 "정리 대기 차단", 실행 막힘은 "배포 실행 차단"(lib `accountHealthLine`). 라벨은 설정 화면과 같게 둠(곧 만료·만료됨·연결 해제됨). 문구 교체: T14·T15 는 모의 구현, 실제 계정 연결·게시는 별도 승인(D24) 전까지 없음. 테스트: accountHealthLine 5건.

검사(Node 24.21.0, corepack pnpm): lint 통과 · typecheck 통과 · build 통과 · test 39 파일 731 통과 · test:integration(단독) 30 파일 563 통과 · drill:mock 통과(불변식 위반 0건, YouTube fetch 0). 화면 재확인은 하지 않음(dev 서버 꺼짐).

- Orchestrator: 코드 커밋 f2bb3b9 (docs 분리, D28) — lint·typecheck·build·unit 731·integration 563·drill:mock 0·실제 DB drill:restore PASS. Codex 대기열 FIX-M4screen.

## 재확인 (f2bb3b9, 내장 브라우저)
- S1: T14 이전 일반 모의로 CONFIRMED 된 Threads 계획 → "일반 모의 어댑터로 처리됨 — Threads 단계 기록 없음(MOCK)". 전송 의도 없는 계획은 그대로 "아직 원격 단계 없음(게시물 2개 …)".
- S2: 배너 "지금 단계(M4)는 모의 어댑터(일반·Threads·YouTube 모의)와 모의 계정 연결만 …".
- S3: 배포 계정 목록 연결 상태 — 블로그·Instagram 연결 정보 없음, Threads·YouTube 연결됨, 실계정은 별도 승인(D24) 문구.
- 서버 오류 로그 0건.

## G1·G2 화면 확인 (fa37b1a, 내장 브라우저, 오케스트레이터 직접 — 모의만)
- G2 /distribute/new?content_id=…: YouTube(모의 연결) 초안에 요청 결과 3종(비공개 업로드·공개 게시·예약 공개)과 예약 공개 날짜·시각(MSK), 블로그·Instagram 은 "MOCK 실행만" 고정. 예약 공개 + 블로그로 계획 생성 → YouTube `public_publish` + 원격 publishAt 2026-10-04 10:00 MSK, 블로그 `mock_publish`.
- G1 /distribute/{id}: 승인 폼에 항목별 숨김 purpose(public_publish·mock_publish), 한 번 제출로 2개 승인(`approved=2`).
- 실행 → tick: 블로그 CONFIRMED(MOCK). YouTube 는 **BLOCKED credential_refresh_failed** — 연결 뒤 dev 서버가 재시작돼 모의 공급자(프로세스 메모리)가 refresh token 을 모름(D26 후속에 적힌 재시작 동작과 같음, 전송 0·거짓 성공 없음). 설정 화면도 "오류 · invalid_token · 이 계정 배포 실행 차단" 표시. 다시 연결(모의) → 재시도 → 웹 tick(각 40–180 ms) → 업로드 완료 → REMOTE_PROCESSING → CONFIRMED **UPLOADED_PRIVATE**(미검증 프로젝트 강제 비공개, D27). 화면: "비공개 업로드 완료, 공개 전환 확인 필요", 요청 공개 범위와 원격 보고 공개 범위 분리 표시.
- 첨부가 매우 작아 조각 1개로 끝나 "웹 요청당 조각 1개" 분할은 화면에서 보이지 않음(통합 테스트가 덮음).
- 서버 오류 로그 0건.

## 추가 결함 (표시만)
- S4 [P3] YouTube 업로드 패널이 세션이 없을 때 "아직 업로드 세션 없음" 과 "세션 URI 는 … 표시하지 않습니다(세션 있음)" 를 함께 보여 준다. 기대: 세션이 있을 때만 "(세션 있음)" 문구.
- S5 [P3] 예약 공개를 요청했는데 원격이 비공개로 강제하고 publishAt 을 버린 결과(UPLOADED_PRIVATE)인데도 "예약 공개(원격 publishAt): 2026-10-04 10:00 (MSK)" 만 보인다. 기대: "요청한 예약 공개 시각 — 원격이 적용하지 않음(미검증 프로젝트, 비공개 강제)" 처럼 원격 결과와 구분.
- 참고: 모의 OAuth 발급 기록이 프로세스 메모리라 dev 서버를 재시작할 때마다 모의 연결 계정이 다음 전송에서 차단된다(의도된 모의 한계, 실계정 어댑터는 DB 봉인 토큰 사용). 개발 중 불편 — 필요하면 모의 공급자 기록을 DB 에서 재수화하는 개선 후보.

## S4·S5 수정 (BASE 5b92b2e, 미커밋 작업 트리 — 표시만, 작업·승인·재확인·어댑터 로직 변경 없음)
- S4 → `apps/web/lib/distribution.ts` `youtubeSessionNote({ hasSession })`·`YOUTUBE_MOCK_DISCLAIMER`. `apps/web/app/distribute/[id]/page.tsx` YouTubeSteps 가 최근 작업의 upload_session 단계 수(`sessions.length > 0`)로 호출 — 세션 있을 때만 "세션 URI 는 화면·로그에 표시하지 않습니다(세션 있음)" + 공통 MOCK 안내, 없으면 "아직 업로드 세션 없음(…)" 줄 + 공통 MOCK 안내만.
  - 테스트: `distribution.test.ts` 「M4 화면 FIX(S4)」 2건(세션 없음: "세션 있음"·"세션 URI" 없음 / 세션 있음: 문구 + 공통 안내).
- S5 → `publishAtView({ publishAt, resultKind, isMock })` → `{ state: requested | applied | not_applied, text, warn }` 또는 null. ItemCard 메타 줄이 승인 스냅샷 `provider_metadata.publish_at` 과 최근 작업의 원격 결과(`latestPub.resultKind`, D27 원격 보고값)로 표시:
  - 결과 전: "요청한 예약 공개 시각: <MSK> — 원격 결과 전(요청만)"
  - SCHEDULED_REMOTE: "예약 공개(원격 publishAt 적용): <MSK> (MOCK)"
  - UPLOADED_PRIVATE: "요청한 예약 공개 시각: <MSK> — 원격이 적용하지 않음(미검증 프로젝트 등으로 비공개로 강제, MOCK)" (경고 태그)
  - 그 밖(PUBLISHED 등): "… — 원격이 적용하지 않음(원격 결과: <종류>)"
  - 테스트: 「M4 화면 FIX(S5, D27)」 6건(없음 → null / 요청만 / 적용 / 비공개 강제로 미적용 / 다른 결과로 미적용 / 잘못된 시각).
- 명령(`source tools/env.sh`, Node 24.21.0, `corepack pnpm`):
  - `lint` pass · `typecheck` pass · `build` pass
  - `test` pass — 39 파일 / 745 테스트
  - `test:integration`(단독) pass — 31 파일 / 569 테스트
  - `drill:mock` pass — 불변식 위반 0건, YouTube fetch 호출 0
- 브라우저 재확인: not_run(dev 서버 내려 둠) — 다음 화면 확인에서 S4(세션 없는 YouTube 항목)·S5(publish_at + UPLOADED_PRIVATE) 육안 확인 필요.

## M4-DEV1 재시작 확인 (0d9911b, 내장 브라우저, 2026-10-03 08:17)
- dev 서버 새로 시작 뒤 설정 → 배포 계정 연결: Threads·YouTube 연결됨 유지(00:08 연결분).
- YouTube "연결 확인" → `token_expired`(1시간 access token 만료 — 공급자가 토큰을 알아봄, 예전처럼 unknown token/invalid 아님). "지금 갱신" → "연결 정보를 갱신했습니다", 만료 2027-04-01 08:17 로 갱신 — 다시 연결 없이 성공.
- 서버 오류 로그 0건.

## 2026-10-03 23:40 — T18·T19 화면 확인(dev 서버, 코드 05bb2bb, .env.local 기본값 COLLECTOR_MODE=disabled)
- `/collect`: "꺼짐(기본)·주기 실행 꺼짐" 표시, 소스·실행 기록 빈 상태 문구. `https://127.0.0.1/feed.xml` 추가 → `?error=collector_url_blocked` "허용되지 않는 주소입니다 … 저장하지 않았습니다", 소스 목록 그대로(빈 상태). 콘솔 오류 0, 서버 오류 0.
- `/imports`: 업로드 안내·원본 종류 선택·"커넥터 꺼짐(IMPORT_CONNECTOR_MODE=disabled)"·빈 기록 문구 정상.
- 확인 안 함: 모의 수집 실행·미리보기·받아들이기 화면(로컬 DB 에 시험 행을 남기지 않으려고 COLLECTOR_MODE 를 바꾸지 않음 — 그 흐름은 통합 시험이 다룸), ZIP 업로드 흐름.
