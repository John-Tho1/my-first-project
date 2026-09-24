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
