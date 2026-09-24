# 결정 기록 (Decision log)
형식: `templates/DECISION_LOG.md`. 결정마다 한 항목.

## D3 — M1 로그인은 비밀번호 없는 개발용 세션 모드
- Decision ID / date: D3 / 2026-09-24 (Europe/Moscow)
- Question: 운영 인증 공급자(OIDC)와 운영 환경이 아직 없고, 규칙상 자체 비밀번호·암호 구현이 금지된 상태에서 T02(단일 사용자 로그인·owner 제한·세션 만료·파일 접근 제어)를 어떻게 구현하는가?
- Options:
  1. OIDC 공급자를 지금 선정·연결 — 외부 계정·운영 환경이 필요해 M1 범위를 넘고 외부 연결 승인이 필요.
  2. 자체 비밀번호 로그인 — docs/02 "자체 암호화/비밀번호 구현 금지" 위반.
  3. 비밀번호 없는 개발용 세션 모드(localhost 전용) + OIDC 자리만 남김.
- Chosen option: 3. `AUTH_MODE=dev|oidc`(기본 dev). dev 로그인은 `APP_BASE_URL` 이 localhost/127.0.0.1 일 때만, 허용 식별자 1개(`AUTH_ALLOWED_IDENTITY`)와 상수 시간 비교로 일치할 때만 세션을 만든다. `oidc` 는 T13 전까지 모든 로그인 시도를 거부한다. 세션 토큰은 32바이트 CSPRNG 난수(Node `crypto`), DB 에는 sha256 해시만, 쿠키는 HttpOnly·SameSite=Lax·(설정에 따라) Secure, 만료·폐기는 요청마다 서버가 확인한다. 상태 변경 요청은 Origin/Referer + Sec-Fetch-Site 로 CSRF 를 막는다. owner 제한은 route 와 DB query 계층 모두에서 강제한다.
- Evidence / assumption: 앱은 현재 개발자 PC(localhost)에서만 실행된다. 단일 사용자이며 외부 노출이 없다는 가정. 새 의존성 없이 Node `crypto` 와 Next 기본 기능만 사용.
- Reversible?: 예. `sessions` 테이블·쿠키·접근 제어 계층은 OIDC 도입 후에도 그대로 쓰고, 로그인 수단만 교체한다.
- User decision required?: 확인 요청 — 오케스트레이터가 결정했으며 사용자 확인을 요청한다.
- Exact authorized scope (if applicable): 로컬 개발 환경(localhost) 한정. 외부 연결·운영 배포 없음.
- Consequences: 인증 강도는 "localhost 에 접근할 수 있는 사람 = owner" 수준이다. 로그인 시도 횟수 제한(rate limit)은 구현하지 않았다. 인터넷에 노출되는 배포에는 쓸 수 없으며(서버 가드가 localhost 외 APP_BASE_URL 에서 dev 로그인을 거부) 운영 전 T13 이 선행되어야 한다.
- When to revisit: T13(OIDC·비밀 암호화) 착수 시, 또는 localhost 밖에서 앱을 열어야 할 필요가 생길 때.

## D4 — T03 유사 소재 판정은 문자 bigram Jaccard, 폼 충돌은 query 리다이렉트(+긴 입력은 409 HTML)
- Decision ID / date: D4 / 2026-09-24 (Europe/Moscow)
- Question: (1) 외부 라이브러리·AI 호출 없이 한국어 소재의 "주제 유사" 후보를 어떻게 고르는가? (2) HTML 폼 수정이 409 충돌일 때 사용자가 입력한 값을 어떻게 잃지 않는가?
- Options: (1) 단어 단위 Jaccard / 문자 bigram Jaccard / 임베딩(외부 호출·비용) (2) 409 HTML 직접 렌더 / 입력값을 query 에 실어 303 / 세션 임시 저장
- Chosen option: (1) NFC·소문자·URL·공백·문장부호 제거 후 문자 bigram Jaccard, 기준 0.45, 최근 200건 대상. 정확 중복(정규화 URL·content_hash)은 따로 판정하고 유사 목록에서 뺀다. (2) 제출 값을 `?conflict=1&y_…` 로 실어 303(퍼센트 인코딩 후 2000자 이하). 넘으면 잘라내지 않고 같은 비교표·폼을 담은 409 HTML 을 직접 응답한다.
- Evidence / assumption: 한국어는 조사·띄어쓰기 차이로 단어 집합이 크게 달라져 단어 Jaccard 가 근사 중복을 놓친다. bigram 은 테스트 문장(근사 중복 ≥0.45, 무관 <0.45)에서 구분됐다. 기준값은 가정이며 실사용 데이터로 조정해야 한다. 한국어 메모 200자 정도면 인코딩 후 2000자를 넘기 쉬워 query 만으로는 입력 손실이 생긴다.
- Reversible?: 예. 유사도 함수와 기준은 `packages/domain/src/similarity.ts` 한 곳, 충돌 처리는 `apps/web/app/api/captures/[id]/route.ts` 한 곳.
- User decision required?: 아니오(구현 세부). 기준값 조정은 사용 후 확인.
- Exact authorized scope (if applicable): 해당 없음(외부 연결 없음).
- Consequences: 짧은 문장(몇 글자)은 점수가 불안정하다. 200건 밖의 오래된 소재는 유사 후보에서 빠진다. 충돌 query 에 메모 내용이 실려 브라우저 기록에 남는다(본인 브라우저·본인 데이터, 외부 링크는 no-referrer).
- When to revisit: T04 검색(한국어 FTS) 도입 시, 또는 소재가 수천 건을 넘어 최근 200건 비교가 부족할 때.

## D5 — T04 검색은 pg_trgm 색인 + ILIKE 부분 문자열 일치, 페이지는 종류별 cursor
- Decision ID / date: D5 / 2026-09-24 (Europe/Moscow)
- Question: 외부 검색 엔진·형태소 분석기 없이(PGlite, 새 의존성 금지) 한국어 소재·원고·카드를 어떻게 찾고, 세 종류를 섞은 결과를 어떻게 페이지로 나누는가? docs/05 M1 은 "영문 FTS 만으로 충분하다고 가정하지 않음"을 요구한다.
- Options: (1) PostgreSQL `to_tsvector('simple')` FTS — 한국어는 띄어쓰기 단위 토큰이라 "주재원"으로 "주재원으로"를 못 찾음. (2) pg_trgm 유사도(`%`) 일치 — 오타를 허용하지만 관련 없는 결과가 섞이고, 짧은 한국어 질의는 유사도가 낮아 놓칠 수 있음. (3) ILIKE 부분 문자열 일치 + pg_trgm GIN 색인으로 가속, 유사도는 점수로만. 페이지: (a) 세 종류 UNION + 합성 cursor (b) 종류별 keyset cursor.
- Chosen option: (3) + (b). PGlite 0.5.8 의 `@electric-sql/pglite/contrib/pg_trgm` 이 동작함을 확인했다(한국어 trigram 생성, GIN 색인, plpgsql 트리거 포함). `createDb` 가 메모리·파일 DB 모두에 확장을 등록하고 migration 0003 이 `CREATE EXTENSION IF NOT EXISTS pg_trgm` 과 GIN(gin_trgm_ops) 색인(captures.raw_text, contents.title, content_versions.body, ideas.idea)을 만든다. 일치 = 검색어를 공백으로 나눈 조각이 모두 대상 필드 중 하나에 ILIKE 로 포함(`%`·`_`·`\` 는 escape). `word_similarity` 는 `score` 로만 돌려주고 정렬·일치에 쓰지 않는다. 결과는 종류별 (시각 desc, id desc) keyset: `type=all` 은 종류별 첫 limit 건(+ 종류별 다음 cursor), `type=<종류>` 는 `next_cursor` 로 이어 본다. 필터가 그 종류에 없는 속성이면(소재의 연재·상태, 원고의 위험 등) 그 종류는 빈 결과. 날짜 필터는 MSK(UTC+3) 하루 경계.
- Evidence / assumption: 통합 테스트(tests/integration/search.test.ts)가 `주재원`→fx-007, `재고 리스`→fx-001, `ai`→"AI" 2건 이상, 무관 질의 0건, 다른 owner 행 미포함, 종류별 cursor 누락·중복 없음을 확인한다. 색인 효과(실행 계획)는 소량 데이터라 측정하지 않았다 — 가정. 원고 본문은 현재 버전만 검색한다(이전 버전 문구는 안 걸림).
- Reversible?: 예. 검색은 `packages/db/src/search.ts` 한 곳, 색인은 migration 으로 추가/삭제 가능. PostgreSQL(M3 DB_DRIVER=postgres) 에서도 pg_trgm 은 표준 contrib 확장이다(운영 DB 에 확장 설치 권한 필요 — 확인 필요).
- User decision required?: 아니오(구현 세부).
- Exact authorized scope (if applicable): 해당 없음(외부 연결·새 의존성 없음 — pg_trgm 은 이미 설치된 PGlite 패키지에 포함).
- Consequences: 오타·띄어쓰기 변형("재고리스")은 못 찾는다. 관련도 순 정렬이 아니라 최근 순이다. 2글자 이하 질의는 trigram 색인을 못 타고 순차 검색이 된다(개인용 데이터량에서는 문제 없다고 가정). 종류를 섞은 한 줄 순위는 없다.
- When to revisit: 소재·원고가 수천 건을 넘어 검색이 느려질 때, 또는 관련도 순·오타 허용이 필요해질 때(M2 이후).

## D6 — T05 내보내기 묶음은 store-only ZIP, owner 재지정·ID 보존, asset key 유지, add_missing 은 덮어쓰지 않음
- Decision ID / date: D6 / 2026-09-24 (Europe/Moscow)
- Question: 새 의존성 없이(ZIP 라이브러리 금지) 이식 가능한 export 를 어떤 형식으로 만들고, 다른 환경(다른 owner id)으로 복원할 때 ID·관계·파일을 어떻게 다루는가? 이미 데이터가 있는 곳에 복원하면 무엇을 하는가?
- Options: (1) 형식: 폴더만 / tar / deflate ZIP(직접 구현) / **store-only ZIP**(method 0, `zlib.crc32`). (2) owner: 원래 owner id 로 users 행까지 복원 / **현재 로그인 owner 로 재지정**. (3) 엔터티 ID: 새로 발급(관계 재매핑) / **그대로 보존**. (4) asset 저장 key: 새 owner 로 다시 만들기 / **원래 key(`assets/<원래 owner>/<uuid>`) 그대로**. (5) 기존 데이터: 덮어쓰기 / **빈 환경에만(empty_only)** / **없는 것만 추가(add_missing, 덮어쓰기 없음)**.
- Chosen option: store-only ZIP(ZIP64·암호화·압축 없음, 2 GiB 상한) + 같은 내용을 풀어 둔 폴더. 표 JSON 은 owner_id 열 없이(owner 는 manifest.owner) 키 정렬·2칸 들여쓰기로 직렬화해, 같은 데이터면 다른 owner 로 복원한 뒤 다시 내보내도 표 sha256 이 같다(users·audit_events 제외). 복원은 모든 행의 owner_id 를 현재 owner 로 바꾸고 ID 는 그대로 둔다. asset key 는 그대로 쓴다 — 저장소 adapter 는 owner 를 모르고 접근 권한은 `assets.owner_id` 로 강제되며, key 는 전역 unique 라 충돌하지 않는다. 기본은 empty_only(소재·카드·원고·파일·출처 0건 + 충돌 0). add_missing 은 없는 ID 만 INSERT(`ON CONFLICT DO NOTHING`), 같은 행은 건너뛰고, 다른 행·다른 owner 가 쓰는 ID·부모가 복원되지 않은 행·다른 unique 충돌은 모두 "충돌"로 보고만 한다. 기존 행 UPDATE 는 없다(예외: 이번에 넣은 원고의 current_version_id null → 버전 id). 미리보기는 커밋과 같은 코드를 트랜잭션 안에서 실행하고 rollback 해서 계산한다.
- Evidence / assumption: `tests/integration/export-restore.test.ts` 가 빈 DB 복원 후 11개 복원 표의 모든 행(ID·값·관계·원고 본문 바이트·current_version_id·asset checksum·저장소 파일 sha256)과 한국어 검색 결과가 일치함을, 한 바이트 변조가 `manifest_mismatch` 로 거부되고 DB 가 그대로임을, add_missing 이 바뀐 행을 덮어쓰지 않음을 확인한다. 시각은 마이크로초까지 보존한다(JS Date 를 거치지 않음). Node 22.12+ 의 `zlib.crc32` 사용.
- Reversible?: 예. 형식은 `format_version` 으로 구분하고(v1 외 거부), 복원 규칙은 `packages/db/src/restore.ts` 한 곳.
- User decision required?: 확인 요청 — 묶음은 암호화하지 않는다(docs/02 "backup 의 개인 데이터는 암호화"는 운영 백업(T20) 범위로 남김). 보관 위치·보존 기간은 사용자가 정한다.
- Exact authorized scope (if applicable): 해당 없음(로컬 파일만, 외부 전송 없음).
- Consequences: 다른 도구로 압축해 다시 묶은 ZIP(deflate)은 거부된다 — 이 앱이 만든 ZIP 만 복원 가능. 업로드 미리보기는 ZIP 전체를 메모리에 올린다(≤256MB, multipart 는 임시 파일 → 메모리). 같은 DB 안에서 다른 owner 에게 같은 묶음을 복원하면 ID 가 이미 쓰이고 있어 전부 충돌(id_in_use)이 된다 — 새 ID 발급 복원은 없다. 커밋 도중 실패하면 DB 는 rollback 되지만 이미 쓴 asset 파일은 고아로 남을 수 있다. users(식별자 원문)·audit_events 는 복원하지 않는다.
- When to revisit: 대용량 asset(M2 T08) 또는 운영 백업·복원 drill(T20)에서 암호화·스트리밍 ZIP·ZIP64 가 필요해질 때, 또는 여러 owner 를 한 DB 에 합칠 필요가 생길 때.

## D7 — M2 의 AI 는 모의(mock)로 진행, live 경계는 T07 에서 구현하되 실제 키·호출은 별도 승인
- Decision ID / date: D7 / 2026-09-24 (Europe/Moscow)
- Question: M2(T06~T09) 작성 지원 기능을 실제 LLM 호출 없이 어디까지 만들 것인가?
- Options: (1) 처음부터 live provider 연결 (2) 전부 모의 (3) T06·T09 는 모의만, T07 에서 provider adapter·예산 예약·차단(fail-closed)까지 구현하고 실제 키·호출은 별도 승인 후.
- Chosen option: (3). 저장소·브라우저·프롬프트·로그에 키를 두지 않는다. 기본값은 LLM_MODE=mock 유지.
- Evidence / assumption: M1 의 MockLlmProvider(결정적, experience claim → needs_user_confirmation)와 assertLiveLlmAllowed 가 이미 있다.
- Reversible?: 예. live 전환은 환경변수와 승인으로만.
- User decision required?: 확정됨(사용자, 2026-09-24).
- Exact authorized scope: 외부 호출 0, 과금 0.
- Consequences: T07 의 live 경로는 모의 provider 로만 검증된다. 실제 모델 품질·비용은 승인 뒤에야 측정된다.
- When to revisit: T07 완료 후 사용자가 D8 을 정할 때.

## D8 — 첫 live LLM 공급자·모델은 T07 착수 시 결정(미정)
- Decision ID / date: D8 / 2026-09-24 (Europe/Moscow)
- Question: 어떤 공급자·모델을 첫 live 연결로 쓰는가?
- Chosen option: 미정. 후보·모델 ID·요금 상한은 사용자가 그 시점 공식 자료로 확인해 정한다. 문서에 요금·모델 ID 숫자를 미리 고정하지 않는다.
- User decision required?: 예 — T07 착수 시.
- When to revisit: T07 착수.

## D9 — T08 음성 전사는 업로드·job·진행 상태까지 모의, 실제 STT 는 승인 후
- Decision ID / date: D9 / 2026-09-24 (Europe/Moscow)
- Chosen option: 업로드 세션·job 상태·진행 표시·지원 기기 fallback·원음 보존(선택)을 모의 전사기로 구현한다. 외부 STT 연결은 공급자·범위·비용을 적은 승인 뒤에만.
- User decision required?: 확정됨(사용자, 2026-09-24). 외부 STT 는 별도 승인.
- Consequences: 전사 품질은 M2 에서 측정되지 않는다.

## D10 — Content Studio 는 M2 동안 현 위치(my-first-project/Content_Studio_Execution_Pack/) 유지
- Decision ID / date: D10 / 2026-09-24 (Europe/Moscow)
- Chosen option: 별도 저장소 분리는 M3 전에 재검토(docs/ENVIRONMENT.md §7). 상위 저장소의 Codex 스크립트·규칙과 공존한다.
- User decision required?: 확정됨(사용자, 2026-09-24).
- When to revisit: M3 착수 전.

## D11 — M1 Codex 잔존 P1(파일 복구 감사의 COMMIT 실패 창)은 잔존 위험으로 기록, VERIFIED 상태 분리는 T08 로 이관
- Decision ID / date: D11 / 2026-09-24 (Europe/Moscow)
- Question: Codex 재검증(GPT-6 Astra / xhigh)에서 남은 P1 — `POST /api/assets/uploads` 의 유실 파일 복구에서 `storage.put` 성공 뒤 DB COMMIT 이 실패하면 파일만 남고 `asset.restore` 감사가 영구 누락 — 을 M2 전에 해결할 것인가? "서명 몇 바이트로 VERIFIED" 지적은 상태값을 나눌 것인가?
- Options: (a) 잔존 위험으로 기록하고 M2 착수, 파일 저장소–DB 정합성(outbox/reconciliation)은 T08 업로드 세션·job 설계와 함께 (b) M2 전에 asset 복구 outbox 를 구현·재검증.
- Chosen option: (a). VERIFIED 는 상태값·명세를 유지하고 UI 라벨을 "서버 확인됨(형식 서명·크기·checksum)" 으로 바꿔 실제 검증 범위를 표시(16a9e5b). 상태 분리·구조 검증 도입 여부는 T08 결정으로 이관.
- Evidence / assumption: 로컬 PGlite 는 단일 연결·단일 프로세스라 put 성공 뒤 COMMIT 만 실패하는 경우는 프로세스 크래시 수준의 장애에서만 발생한다고 가정(측정 없음). 복구 자체는 행 잠금 트랜잭션으로 직렬화되어 동시 복구·감사 중복은 막힌다(테스트 있음).
- Reversible?: 예. T08 에서 복구 의도 테이블을 추가하면 해소된다.
- User decision required?: 확정됨(사용자, 2026-09-24, 권고안 채택).
- Consequences: 그 장애 창에서는 파일은 복구되지만 감사 이력이 없다. 화면 체크리스트 12항목은 M2 착수 뒤 사용자가 확인한다(.handoffs/screen-notes.md).
- When to revisit: T08 착수 시(업로드 세션·job 상태 설계).

## D12 — T06 작성 지원: 제안은 현재가 아닌 ai:mock 버전, 질문 3개 고정, 채택 = 새 사용자 버전, A03 은 `ready` 전이에서 서버 차단
- Decision ID / date: D12 / 2026-09-24 (Europe/Moscow)
- Question: 모의 AI 로 outline/draft/revise 를 만들 때 제안을 어디에 두고, 사용자 원문 보존·입력 버전 고정·A03(미확인 1인칭 경험 차단)을 어떻게 서버에서 강제하는가?
- Options: (1) 제안 저장: 별도 proposals 표 / run 의 jsonb 에만 / **content_versions 의 현재가 아닌 불변 버전**(created_by='ai:mock', ai_run_id). (2) 인터뷰 질문: AI 가 생성 / **고정 3개**(상황·판단·독자에게 남길 한 가지). (3) 채택: current_version_id 를 제안 버전으로 옮김 / **제안 본문으로 새 사용자 버전 추가**. (4) A03 차단 지점: 화면 경고만 / 게시 승인(M3) / **상태 `ready` 전이(서버)**.
- Chosen option: 제안은 `content_versions` 에 현재가 아닌 버전으로 저장(버전 번호 = 최대+1, `contents.current_version_id` 불변). 기존 본문 저장도 번호를 "현재+1" 에서 "최대+1" 로 바꿨다(제안 번호와 충돌 방지). `generation_runs` 에 입력 버전(현재 본문 버전 id·브랜드 프로필 id/버전·답변 id 정렬 목록)·prompt_version(`t06-assist-v1`)·provider/model(mock)·status(running→succeeded|failed)·output_ref·output_json(claims·followup_questions·warnings)을 남긴다. 채택은 제안 본문으로 `created_by='owner'`, `ai_run_id=<run>` 인 새 버전을 만들어 현재로 옮긴다(작업 지시의 'user' 대신 기존 사용자 버전 값 `owner` 를 그대로 사용 — 사용자 문장 판정이 한 값으로 유지됨). 채택 조건: base_version = 현재 **그리고** run 의 입력 버전 = 현재(그 사이 본문이 바뀌었거나 이미 채택했으면 409 `stale_base`). A03: 채택한 **모든** run(마지막 run 만이 아님)의 `experience` 또는 `needs_user_confirmation` claim 중 `claim_confirmations` 에 없는 것이 있으면 `updateContentMeta` 가 잠금 안에서 `ready` 전이를 409 `unconfirmed_experience_claims` 로 거부하고, 이미 `ready` 인 원고에서 그런 제안을 채택하는 것도 같은 409 로 거부한다(우회 방지 — 확인은 채택 전에도 할 수 있다). 확인은 사용자 요청(`POST /claims/confirm`)으로만 저장한다. `interview_answers`·`claim_confirmations` 는 DB 트리거로 UPDATE·DELETE 금지. live 모드는 `getLlm` 이 `assertLiveLlmAllowed` 후에도 `LiveProviderNotConfiguredError` 로 거부(503, run 없음). 실패 주입은 `NODE_ENV=test` 이고 `LLM_MOCK_FAIL_NEXT=1` 일 때만.
- Evidence / assumption: `tests/integration/writing.test.ts`(18개)가 브랜드 append·409·owner 범위, 답변 append·최신·불변, assist 성공(현재 버전 불변·ai:mock·MOCK_WARNING)·stale 409(run·버전 0)·실패 주입(run failed·본문 그대로)·live 503(run 0), 채택·재채택 409, A03 409 → 확인 → ready 200, 새 표 export→빈 DB 복원 왕복을 확인한다. 모의 provider 는 답변→본문 순 자료의 앞 3문장으로 claim 을 만든다(1인칭 표현 → experience).
- Reversible?: 예. 제안·채택·확인은 모두 추가 행이라 되돌릴 데이터 변환이 없다. 게이트 위치는 `packages/db/src/claims-gate.ts` 한 곳.
- User decision required?: 확인 요청 — (a) 채택 버전 created_by 를 `owner` 로 둔 것, (b) A03 을 `ready` 전이에서 막는 것(게시 승인은 M3), (c) **수동 복사는 추적하지 않음 — 사용자 결정 필요**: 제안을 채택하지 않고 본문에 직접 복사해 저장하면(`aiRunId` 없는 사용자 버전) A03 게이트가 걸리지 않는다. 현재 구현은 이것을 A03 전체 충족으로 보지 않는다(Codex review-T06 P1, 미구현·명시적 한계). (d) `resolution='removed'` 는 서버가 본문을 대조하지 않는 사용자 표시라는 것.
- Exact authorized scope (if applicable): 외부 호출 0, 과금 0(D7).
- Consequences: 버전 목록에 AI 제안 버전이 섞여 보인다("AI 제안(모의)" 표시). 채택하지 않은 제안의 경험 claim 은 막지 않는다. 복원(add_missing)에서 run 이 충돌로 빠지고 채택 버전만 들어가면 게이트가 그 run 을 보지 못한다. 프롬프트 내보내기는 보기만 있고, 결과 붙여넣기 가져오기는 T06 범위 밖. run 이 `running` 인 채로 프로세스가 죽으면 그대로 남는다(재시도는 새 run).
- When to revisit: T07(claim–source 연결·user_confirmed 근거·live provider 경계·비용 예약) 착수 시.
- FIX round 1(Codex review-T06, 2026-09-24): (P0) 묶음 검증이 `content_versions.ai_run_id` 가 **같은 원고**의 run 인지 확인하고, 복원은 모든 표를 적용한 뒤 "이번에 넣은 버전의 run 이 이번에 넣었거나 동일"인지 사후 확인해 아니면 `restore_conflict`(dependency)로 전체 중단한다(버전↔run 순환이라 PARENTS 대신 사후 검사). (P1) `claim_confirmations.resolution`('confirmed' = 내 경험이 맞음 / 'removed' = 본문에서 뺐음, 기본 confirmed, migration 0006) — 둘 다 사용자 주장이고 게이트는 둘 다 해결로 본다. 거짓 경험을 사실이라고 확인하지 않고도 검토를 끝낼 수 있다. (P1) 작성실은 최근 10개 run 에 더해 미해결 경험 claim 이 남은 run 과 URL 의 `?run=`(owner·원고 범위 직접 조회)을 항상 보여 준다. (P2) `interview_answers.seq`(원고 잠금 안에서 최대+1, 0006 에서 기존 행을 (created_at, id) 순으로 채움, (content_id, seq) unique)로 최신 답변을 판정한다. (P2) Brand Profile 저장은 owner 행을 잠가 직렬화하고, 409 본문의 current 는 응답 시점에 다시 읽는다. 수동 복사 우회(P1)는 위 (c) 로 남긴다.
