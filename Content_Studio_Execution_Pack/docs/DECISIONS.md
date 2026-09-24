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
