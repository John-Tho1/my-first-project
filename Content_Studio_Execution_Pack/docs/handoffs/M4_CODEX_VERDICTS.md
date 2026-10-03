# Codex 판정 요약 (M4, GPT-6 Astra / xhigh, 로컬 실행)

전문은 로컬 `.handoffs/review-*.md`(gitignore). 판정과 지적 제목만 옮긴다.

## T13 (bf57eae, OAuth·계정·비밀 보호 — 모의·로컬) — CHANGES_REQUESTED
- [P1] packages/db/src/oauth.ts:500 — 키 교체와 갱신이 겹치면 유효한 새 토큰을 잃고 철회된 옛 토큰만 저장된다
- [P1] packages/db/src/oauth.ts:540 — 이전 토큰의 확인 결과가 새 연결 정보의 상태를 덮어쓴다
- [P1] packages/db/src/oauth.ts:603 — 연결 해제가 실제로 철회하지 않은 최신 토큰을 삭제하면서 성공을 반환할 수 있다
- [P1] packages/db/src/restore.ts:48 — 연결 이력 차이를 전부 무시하면 복원 계정의 재연결 차단이 누락된다
- [P2] packages/domain/src/oauth.ts:191 — 설정에서 허용한 query 포함 redirect URI로는 연결을 완료할 수 없다
- 답 요지: 잠금 없는 실행 게이트는 승인 불가(계정 → 연결 정보 공통 잠금 순서 필요); 철회 시 승인 무효화는 보수적이고 타당; 콜백 세션 검사는 state 소비 전에; 회전은 현재 버전 행의 무결성도 검사해야; 실패 응답 헤더·객체 콘솔 출력 검사 보강.

## FIX-T13 (5479a7f, round 1: review-T13 + D25 3·5) — CHANGES_REQUESTED (P1 3)
- [P1] packages/db/src/oauth.ts:439 — 재연결이 `revokedAt`을 지우면 해제 전에 시작한 콜백이 다시 저장될 수 있음
- [P1] packages/db/src/oauth.ts:737 — 중복 해제 요청에서는 `incomplete`가 실행 차단 상태를 보장하지 않음
- [P1] packages/db/src/oauth.ts:575 — 갱신 토큰 저장 중 예외가 발생하면 발급 토큰 정리를 건너뜀
- 답 요지: 세션 검사 후 state 소비·restore 단방향 needs_reconnect·회전 exit 1 은 타당; reconnect_required_accounts 는 복원 화면에도 표시 필요; 실제 PostgreSQL 잠금 대기·프록시 뒤 콜백·서버 접근 로그는 미확인(not_run).

## FIX2-T13 (dfc9842, round 2: review-FIX-T13) — CHANGES_REQUESTED (P1 1·P2 1)
- [P1] packages/db/src/oauth.ts:690 — 갱신 토큰 저장 실패 후 무효화된 기존 토큰을 `active` 상태로 남긴다
- [P2] packages/db/src/secrets-cli.ts:51 — DB 종료 오류를 삼켜 CLI가 성공을 반환한다
- 답 요지: 해제 번호·작업 식별자·저장 결과 불명 시 즉시 철회 안 함은 타당; 결과 불명 T2 의 나중 정리를 보장하려면 내구성 있는 기록 필요; lease 테스트는 시간 확대보다 명시적 장벽·제어 시계 권고.

## FIX3-T13 (round 3: review-FIX2-T13) — (클라우드 세션에서 구현 중, 로컬 복귀 후 Codex 검증)

## FIX3-T13 (79201d6, round 3: review-FIX2-T13, 클라우드 구현) — CHANGES_REQUESTED (P1 3·P2 1)
- [P1] packages/db/src/oauth.ts:1037 — 현재 토큰의 유효성을 확인하지 못해도 pending을 지워 무효 토큰의 실행 차단을 해제한다
- [P1] packages/db/src/oauth.ts:1017 — 되쓰기에서 pending 작업 ID만 확인하여 동시 해제가 남긴 정리 의무를 삭제한다
- [P1] packages/db/src/oauth.ts:908 — `occupied`가 두 번째 미정리 토큰을 기록 없이 버린다
- [P2] packages/db/src/oauth.ts:1293 — 오래된 해독 불가 pending들이 뒤 계정의 자동 정리를 계속 막는다

## T14 (67ade9e, Threads 텍스트 — 모의, 클라우드 구현) — CHANGES_REQUESTED (P0 1·P1 1·P2 1)
- [P0] packages/db/src/jobs.ts:848 — 기존 전송 의도에 `adapter_id`가 없으면 다른 어댑터가 결과 불명을 확정 미전송으로 오판한다
- [P1] packages/domain/src/bundle.ts:123 — 복원에서 Threads 재확인에 필요한 원격 참조를 버린다
- [P2] packages/providers/src/threads-mock.ts:622 — 만료 컨테이너가 재시도 경로에서는 문서와 달리 `FAILED`로 끝난다

## T15 (427dc71, YouTube 재개 업로드 — 모의, 클라우드 구현) — CHANGES_REQUESTED (P1 3)
- [P1] packages/providers/src/youtube-mock.ts:794 — 파일 읽기 도중 작업이 중단되어도 다음 조각을 전송한다
- [P1] packages/db/src/jobs.ts:683 — 만료된 세션까지 차감하여 새 세션 생성 시 할당량 검사를 건너뛴다
- [P1] apps/web/app/api/worker/tick/route.ts:45 — 웹 요청 안에서 영상 전체 업로드를 수행하는 경로를 추가했다

## FIX4-T13 (ea85ac6, round 4: review-FIX3-T13) — CHANGES_REQUESTED (P1 1·P2 2)
- [P1] packages/db/src/oauth.ts:1524 — 현재 토큰의 철회가 실패해도 `verify_current`를 삭제하여 재정리에 필요한 토큰을 잃는다
- [P2] packages/db/src/oauth.ts:1077 — worker가 선택한 계정의 모든 행을 처리하여 행별 `next_attempt_at`을 무시한다
- [P2] docs/handoffs/T13_IMPLEMENTATION_HANDOFF.md:253 — 인계·리뷰 산출물을 추적되는 저장소 파일에 추가했다 → 코드 결함 아님, D28 로 처리(인계 사본은 docs 전용 커밋으로만, 코드 커밋에 섞지 않음)

## FIX-T14 (6f766d2, T14 round 1) — CHANGES_REQUESTED (P1 1)
- [P1] packages/db/src/jobs.ts:749 — 사용량과 진행 중 예약을 서로 다른 시점에 읽어 계정 한도를 초과할 수 있음

## FIX5-T13 (492b1b9, T13 round 5) — CHANGES_REQUESTED (P1 1·P2 1)
- [P1] packages/db/src/oauth.ts:1541 — 현재 토큰을 복호화하지 못한 경우에도 철회 의무를 남기지 않고 암호문을 삭제한다
- [P2] packages/db/src/oauth.ts:1356 — stale 후처리가 다른 호출이 갱신한 다음 시도 시각을 앞당길 수 있다

## FIX-T15 (cc26535, T15 round 1)
PASS

## FIX-M4screen (f2bb3b9, 화면 S1–S3)
PASS

## M4UI (fa37b1a, 화면 기능 G1·G2)
CHANGES_REQUESTED
- [P1] apps/web/lib/distribution.ts:161 — ‘공개 게시’를 선택해도 남아 있는 예약 공개 시각이 그대로 적용되는 요청을 만든다

## FIX-M4screen2 (8d2cc64, 화면 S4·S5)
CHANGES_REQUESTED
- [P1] apps/web/lib/distribution.ts:860 — `PUBLISHED`라는 결과만으로 예약 공개가 적용되지 않았다고 단정한다

## FIX-drill-mask (0c86db2, 업로드 세션 URI 이중 가림)
CHANGES_REQUESTED
- [P2] packages/db/src/bundle-tables.ts:79 — 가림 예외가 정상 마커 형식보다 넓어 비정상 값까지 그대로 내보낸다

## FIX2-T14 (746aa3a, T14 round 2) — **PASS** (지적 없음) → T14 종결(모의 범위)
## (참고) FIX-T15 PASS → T15 종결(모의 범위)

## FIX6-T13 (2a974d5, T13 round 6) — CHANGES_REQUESTED (P1 1·P2 1)
- [P1] packages/db/src/oauth.ts:1791 — worker가 오래된 조회 결과로 새로 연결된 자격 증명까지 해제할 수 있다
- [P2] packages/db/src/oauth.ts:1779 — 해독 불가능한 오래된 행들이 재개 후보 한도를 계속 차지한다

## FIX2-drill-mask (75dd988) — **PASS** → 업로드 세션 URI 가림 종결

## FIX-M4UI (2fed5b4, 화면 기능 round 1) — CHANGES_REQUESTED (P2 1)
- [P2] apps/web/lib/revoke-view.ts:14 — 해제 미완료 안내가 오류 해소 여부와 무관하게 자동 완료를 약속함

## FIX7-T13 (f07d96a, T13 round 7) — CHANGES_REQUESTED (P2 1, P1 없음)
- [P2] packages/db/src/oauth.ts:1508 — worker가 잠금 안에서 갱신된 재개 시각을 확인하지 않아 같은 해제를 중복 재개할 수 있다

## FIX2-M4UI (cd0a2aa, 화면 기능 round 2) — **PASS** → 화면 기능 G1·G2·S4·S5·해제 안내 종결

## FIX8-T13 (c82c721, T13 round 8) — **PASS** → T13 종결(모의·로컬 범위)

### M4 모의 범위 종결 요약 (2026-10-03 04:35)
- T13: 구현 bf57eae → FIX1 5479a7f → FIX2 dfc9842 → FIX3 79201d6 → FIX4 ea85ac6 → FIX5 492b1b9 → FIX6 2a974d5 → FIX7 f07d96a → **FIX8 c82c721 PASS**
- T14: 67ade9e → FIX1 6f766d2 → **FIX2 746aa3a PASS**
- T15: 427dc71 → **FIX1 cc26535 PASS**
- 화면: S1–S3 f2bb3b9 PASS · G1·G2 fa37b1a → 2fed5b4 → **cd0a2aa PASS** (S4·S5 8d2cc64 의 지적은 2fed5b4 에서 반영)
- 업로드 세션 가림: 0c86db2 → **75dd988 PASS**

## T16 (620ed86, Instagram — 모의) — CHANGES_REQUESTED (P0 2·P1 1)
- [P0] packages/providers/src/instagram-mock.ts:257 — 실제 읽은 이미지의 checksum을 승인된 checksum과 비교하지 않고 게시한다
- [P0] packages/providers/src/instagram-mock.ts:225 — 적용된 쓰기 5xx 장애가 부작용 없음으로 분류되어 게시를 다시 요청한다
- [P1] packages/providers/src/instagram-mock.ts:908 — 캐러셀 부모 생성 응답을 잃으면 이미 사용된 자식으로 부모를 다시 생성하려 한다

## FIX-T16 (165f0df, T16 round 1) — CHANGES_REQUESTED (P0 1·P1 1)
- [P0] packages/providers/src/instagram-mock.ts:612 — 적용된 쓰기의 sideEffect unknown 을 429 분류에서 여전히 부작용 없음으로 처리한다
- [P1] packages/providers/src/instagram-mock.ts:877 — 부모 요청 표식이 없는 기존 작업을 부모 요청 전으로 오판한다

## FIX2-T16 (914ac36, T16 round 2) — **PASS** → T16 종결(모의 범위)
- T16: 620ed86 → FIX1 165f0df → **FIX2 914ac36 PASS**. M4 의 T13~T16 모의 범위 모두 Codex 종결.

## M4DEV1 (0d9911b, 모의 OAuth 재수화) — CHANGES_REQUESTED (P1 2)
- [P1] apps/web/app/api/channel-accounts/[id]/check/route.ts:25 — 재주입 실패를 무시하고 진행하여 일시적 로딩 실패가 연결 오류로 굳어질 수 있다
- [P1] packages/db/src/oauth.ts:781 — 정리 대기를 무시하면 회전으로 무효화된 이전 토큰을 유효하게 복원한다

## FIX-M4DEV1 (b3041c0, 재수화 round 1) — CHANGES_REQUESTED (P1 1)
- [P1] packages/db/src/oauth.ts:778 — cleanup_revoke 해소 후에도 현재 토큰의 검증 상태가 복구되지 않는다

## FIX2-M4DEV1 (63ad062, 재수화 round 2) — **PASS** → 모의 OAuth 재수화 종결

## D30H (e76ff43, 공개 health 정리) — CHANGES_REQUESTED (P1 1)
- [P1] packages/db/src/uploads.ts:129 — 디렉터리 읽기 실패를 삼켜 ops.uploads 가 null 대신 0 또는 불완전한 수치를 반환한다

## LIVET1 (1f16583, Threads 실제 OAuth 코드 — D31 1단계) — CHANGES_REQUESTED (P0 1·P1 1·P2 2)
- [P0] packages/providers/src/threads-live-oauth.ts:104 — 오류 메시지 분류가 5xx보다 먼저 적용되어 결과 불명이 확정 실패로 기록될 수 있음
- [P1] packages/providers/src/threads-live-oauth.ts:199 — D31에서 제외한 실제 갱신을 서버 실행 경계에서 차단하지 않음
- [P2] packages/domain/src/oauth.ts:401 — 화면의 연결 준비 판정과 실제 공급자의 설정 검증이 불일치함
- [P2] tests/setup/no-meta-network.ts:37 — fetch 래퍼만으로는 문서에 명시한 Meta 요청 차단 범위를 보장하지 못함

## FIX-D30H (a25fa47) — **PASS** → 공개 health 정리(D23·D30-3) 종결

## FIX-LIVET1 (1b01226, LIVE-T1 round 1) — CHANGES_REQUESTED (P0 1·P2 2)
- [P0] packages/providers/src/threads-live-oauth.ts:138 — 메시지 분기가 일시 오류 코드를 덮어써 결과 불명을 확정 실패로 기록한다
- [P2] packages/providers/src/threads-live-oauth.ts:127 — HTTP 429 이외의 제한 응답에서 Retry-After 정보가 유실된다
- [P2] tests/setup/no-meta-network.ts:169 — DNS 가드가 모듈 함수 일부만 감싸므로 Resolver 인스턴스 경로가 남는다

## T18 (1427118, Notion·Drive 가져오기 — 파일·모의) — CHANGES_REQUESTED (P0 3·P1 2·P2 1)
- [P0] `packages/domain/src/imports.ts:293` — HTML 원본을 추출 텍스트로 대체하고 원본 바이트를 보존하지 않는다
- [P0] `packages/domain/src/imports.ts:328` — 중첩 ZIP의 누적 압축 해제량과 전체 항목 수 제한을 우회할 수 있다
- [P0] `packages/domain/src/imports.ts:248` — HTML 제거 정규식에 서비스 거부를 일으킬 수 있는 반복 탐색 경로가 있다
- [P1] `packages/db/src/imports.ts:244` — 서로 다른 실행의 동시 확정에서 출처 재판정과 삽입이 직렬화되지 않는다
- [P1] `apps/web/lib/imports.ts:122` — 실제 선택 항목이 없어도 미리보기를 확정하고 ZIP을 삭제한다
- [P2] `packages/domain/src/imports.ts:339` — ZIP의 unsigned 크기를 DB의 signed `integer`에 그대로 저장한다

## FIX2-LIVET1 (e51ae72, LIVE-T1 round 2) — CHANGES_REQUESTED (P0 1)
- [P0] packages/providers/src/threads-live-oauth.ts:212 — 숫자 코드가 없는 일시 오류는 여전히 메시지 때문에 확정 실패로 바뀐다

## FIX-T18 (6e7ff92, T18 round 1) — CHANGES_REQUESTED (P0 1·P1 1·P2 1)
- [P0] packages/domain/src/imports.ts:499 — 겹치는 ZIP 항목으로 같은 압축 데이터를 반복 해제하면 현재 예산으로 CPU 사용량을 제한할 수 없습니다
- [P1] apps/web/app/captures/[id]/page.tsx:123 — 원본이 없는 기존 가져오기에도 다운로드 링크가 표시되며, 동일 파일 재가져오기로도 원본을 복구할 수 없습니다
- [P2] packages/domain/src/imports.ts:366 — `<script/>`·`<style/>`를 자체 종료 태그로 취급하여 코드가 소재 본문에 남습니다

## FIX3-LIVET1 (9273517, LIVE-T1 round 3) — CHANGES_REQUESTED (P0 1)
- [P0] packages/providers/src/threads-live-oauth.ts:89 — 문자열 error 분기가 일시 신호와 잘못된 코드 필드를 버려 확정 실패를 만든다

## FIX2-T18 (e294aca, T18 round 2) — CHANGES_REQUESTED (P1 1·P2 1)
- [P1] packages/domain/src/imports.ts:453 — 가짜 raw-text 닫는 태그와 따옴표가 결합하면 정상 HTML의 뒤쪽 본문까지 버린다
- [P2] packages/domain/src/imports.ts:338 — 따옴표 없는 속성 값 내부의 = 를 새 속성 값 시작으로 해석한다

## FIX4-LIVET1 (f6c3736, LIVE-T1 round 4 정규화 일원화) — **PASS** → D31 1단계(Threads 실제 OAuth 코드, 실제 호출 없음) 종결
- LIVE-T1: 1f16583 → FIX1 1b01226 → FIX2 e51ae72 → FIX3 9273517 → **FIX4 f6c3736 PASS**. 2단계(실계정 연결·프로필 조회)는 사용자와 함께 진행(D31).

## FIX3-T18 (d9e482d, T18 round 3 WHATWG 상태 기계) — CHANGES_REQUESTED (P2 1, P0·P1 없음)
- [P2] packages/domain/src/imports.ts:706 — textarea·xmp 의 닫는 태그를 소비하면서 블록 구분 줄바꿈을 누락한다

## T19 (4a2e02f, 허용 소스 수집·재추천 — 모의) — CHANGES_REQUESTED (P0 1·P1 3·P2 1)
- [P0] `packages/domain/src/collector.ts:605` — BOM이 있는 HTML의 원본 바이트가 보존되지 않는다
- [P1] `packages/db/drizzle/0041_t19_collector.sql:31` — accepted CHECK가 NULL outcome에 연결 필드가 채워진 행을 허용한다
- [P1] `packages/db/src/collector.ts:552` — 기한 검사 전에 50개로 제한하여 실행할 daily 소스가 계속 제외될 수 있다
- [P1] `packages/db/src/collector.ts:396` — 재수집으로 바뀐 상대 링크의 해석 결과를 검사하지 않는다
- [P2] `packages/domain/src/collector.ts:318` — 기본 엔티티 검사에 Object

## FIX4-T18 (e6f643b, T18 round 4) — **PASS** → T18 Notion·Drive 선택 가져오기(파일·모의) 종결
- T18: 1427118 → FIX1 6e7ff92 → FIX2 e294aca → FIX3 d9e482d → **FIX4 e6f643b PASS**.

## FIX-T19 (66e1257, T19 round 1) — CHANGES_REQUESTED (P2 2, P0·P1 없음)
- [P2] packages/domain/src/collector.ts:560 — `Buffer` 입력에서는 원본 바이트가 복사되지 않고 입력 버퍼와 공유된다
- [P2] packages/db/src/collector.ts:563 — 주간 SQL 기한의 `interval '7 days'`가 고정 168시간 규칙과 DST에서 달라진다
