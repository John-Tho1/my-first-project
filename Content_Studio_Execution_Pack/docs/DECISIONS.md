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
