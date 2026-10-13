# Implementation handoff — DEV-LOG (dev 요청 로그의 콜백 query 제외)
- BASE d893211 → HEAD 4f0bc1db35518ffa55b73204e1d4db9748cf7403 (code only). 구현: 오케스트레이터 직접.
- 발견: D31 2단계 실제 Threads 연결 중 next dev 로그에 `GET /api/oauth/callback?code=<인가 코드>&state=<state> 303` 한 줄이 그대로 남았다(인가 코드는 이미 교환돼 재사용 불가, 로그는 이 PC 의 dev 서버 stdout 에만). OIDC 콜백(`/api/auth/oidc/callback`)도 같은 형태.
- 변경: `apps/web/next.config.ts` `logging.incomingRequests.ignore = [/\/api\/oauth\//, /\/api\/auth\/oidc\//]`(Next 16.3.6 IncomingRequestLoggingConfig — node_modules d.ts 로 확인). next start 는 요청 줄을 쓰지 않는다.
- 확인(수동, HTTPS dev): `/api/oauth/callback?code=SENTINELCODE123…`(401)·`/api/auth/oidc/callback?code=SENTINELCODE456…`(503) 요청 뒤 dev 로그에 두 줄 모두 없음(SENTINEL 문자열 0), `/api/health` 줄은 그대로 남음.
- 검사: lint 0 · typecheck 0 · build 0. 단위·통합은 이 설정을 실행하지 않아 not_run(설정 파일만 변경).
- 남은 위험: 콜백 외 경로에 비밀이 query 로 오는 경우는 없다고 보았으나 전수 확인은 하지 않음. 오류 시 Next 오류 오버레이·스택이 URL 을 포함할 가능성은 미확인.
- Codex 질문: (1) 제외 패턴이 충분한가(다른 query 비밀 경로)? (2) 경로 전체를 빼는 대신 query 만 가리는 방법이 나은가?
