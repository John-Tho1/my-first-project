# Implementation handoff — EXPIRY-1 (D39 Task B)
- Task ID / milestone: EXPIRY-1 / M4 (D39 — 만료 관리: Threads 실제 연결·로컬 개발 인증서 만료 14일 전 경고, 인증서 확인·갱신 스크립트)
- Purpose and changed behavior: 실제(live) Threads 연결의 만료가 14일 안이면 홈·설정에 "다시 연결" 경고를, 만료됐으면 "실제 게시가 되지 않습니다" 경고를 보인다. 개발 모드에서만 로컬 HTTPS 인증서(`data/dev-certs/localhost-cert.pem` 또는 `DEV_TLS_CERT_PATH`)의 만료일을 읽어 같은 기준으로 경고한다. `scripts/dev-cert.sh check|renew` 추가(로컬 openssl, 외부 호출 없음). 다시 연결은 기존 연결 버튼 — 토큰 갱신 API 호출은 추가하지 않음(D31).
- BASE_SHA: c5597e1 (LIVE-P2 코드 ca7228e + 인계)
- HEAD_SHA: 5739e5afc6d57452f0d0574ea3afe11fa8af69b2
- Clean tracked tree confirmed: yes
- Relevant acceptance IDs: D39 만료 관리(Threads 연결 만료 현재 2026-12-12, 로컬 인증서 만료 2026-11-12, 14일 전부터 경고, 개발 모드만, 갱신 스크립트), D31(연결 범위 — 갱신 API 미추가)
- Changed files: `git show --stat 5739e5a`.
  - 신규: `packages/domain/src/expiry.ts`(+test 27), `apps/web/lib/dev-cert.ts`(+test 11), `apps/web/lib/expiry-view.tsx`, `apps/web/lib/expiry-render.test.ts`(10), `scripts/dev-cert.sh`(755), `scripts/tests/test-dev-cert.sh`, `tests/fixtures/dev-cert/TEST-ONLY-throwaway-cert.pem`(공개 인증서만, 개인 키 없음 — 시험에서 단언)
  - 수정: `apps/web/app/page.tsx`, `apps/web/app/settings/page.tsx`, `apps/web/lib/ui-safety.test.ts`, `packages/domain/src/index.ts`, `.env.example`(DEV_TLS_CERT_PATH 주석 자리표시), `README_KO.md`("만료 관리 (D39, EXPIRY-1)" + 명령 표 행)
- 설계 요점:
  - 경계: `remaining = expiresAt − now`(ms). `≤ 0` → expired(기존 연결 상태 판정과 같은 규칙), `0 < remaining ≤ 14×24h` → warn(정확히 14일 포함), 14일 + 1ms → 없음. 모두 시험.
  - 대상: `kind==='live'`, 모의 아님, platform threads, 만료일 있음, 철회되지 않은 연결. 알림 `{kind, level, text, href, expiresAt, accountId?}`, href `/settings#accounts`(Threads)·`/settings#expiry`(인증서). 정렬 expired → warn → 이른 만료 → Threads 먼저.
  - 문구: 계획 그대로("Threads 연결이 {MSK}에 만료됩니다 — 설정에서 다시 연결하세요" / "Threads 연결이 만료되었습니다 — 다시 연결 전에는 실제 게시가 되지 않습니다" / "로컬 인증서가 {MSK}에 만료됩니다 — scripts/dev-cert.sh renew"). 계획에 없던 인증서 만료됨 문구는 "로컬 인증서가 {MSK}에 만료되었습니다 — scripts/dev-cert.sh renew". `{날짜}` 는 `formatMsk`(시각 포함).
  - 인증서 읽기: 운영 빌드(`NODE_ENV=production`)는 경로 계산·파일 접근 전에 null(Next 가 운영 빌드에서 `NODE_ENV` 를 상수로 바꿔 `next start` 는 파일을 열지 않음 — 구현 에이전트 확인). 64KB 초과·빈 파일·디렉터리 → null, `X509Certificate(...).validTo`, 모든 오류 → null, 기록 없음.
  - 화면: 홈 머리 아래(오늘 위, LIVE-P2 상태 줄은 머리 안 그대로), 설정 상단 목록 + "만료 관리" 카드(#expiry: 실제 Threads 만료·로컬 인증서 날짜·check/renew 명령), 계정 표 만료 칸 옆 `14일 안에 만료 — 다시 연결하세요` / `만료됨 — 다시 연결 필요`.
  - `dev-cert.sh`: `check` = notAfter + 남은 일수(올림, 앱과 같은 14일 규칙). `renew [days=90]` = 임시 파일에 EC P-256 키(`genpkey`, 600)·자체 서명 인증서(CN=localhost, SAN `DNS:localhost,IP:127.0.0.1`, Git Bash 의 `/` 인자 변환을 피해 `-subj` 대신 설정 파일) → 인증서 공개 키와 키 일치 확인 → 기존 `*.pem` 을 `backup-YYYYMMDD-HHMMSS[-n]/` 로 복사 → 새 파일 이동, 키 출력 없음, 끝에 "dev 서버 재시작·브라우저 경고 다시 수락" 안내. 중간 실패 시 기존 파일 그대로. openssl 없음 → 한국어 안내 exit 1, 사용법 오류 exit 2. `DEV_CERT_DIR`·`DEV_CERT_FILE`·`DEV_KEY_FILE`·`OPENSSL` 로 바꿀 수 있음. 키 파일 이름은 `localhost-key.pem` 으로 가정(`content-studio-dev-https` 실행기가 저장소에 없어 확인 못 함).
- Migrations / restore implications: 없음.
- Actual commands and results (클라우드 Node v22.22.2, pnpm 12.6.0, 오케스트레이터 순차 재실행):
  - `corepack pnpm install --frozen-lockfile` → exit 0, lockfile sha256 `8db0ef8abda74fda…` 그대로(새 의존성 0)
  - `pnpm lint` / `pnpm typecheck` / `pnpm build` → exit 0
  - `pnpm test` → 79 files / 1885 tests PASS(LIVE-P2 기준 76/1838 → +3 files, +47)
  - `pnpm test:integration`(단독) → 51 files / 928 tests PASS, 299 s(기준과 같음)
  - `pnpm drill:mock` → exit 0, 불변식 위반 0
  - `bash scripts/tests/test-dev-cert.sh` → 82 passed, 0 failed, 0 skipped(실제 openssl 3.0.13 + 만료·생성 실패용 가짜 openssl, 임시 디렉터리 밖 실행 거부 가드)
  - `bash -n scripts/dev-cert.sh` → ok. `data/dev-certs` 생성되지 않음 확인.
  - 구현 에이전트: 첫 단위 실행에서 기존 `packages/db/src/lock.test.ts`(다중 프로세스 시간 시험, 이번에 안 바뀐 파일) 1건 실패 → 단독 7/7·재실행 PASS(알려진 부하 민감). 변이 확인: 단위·화면 8개 모두 잡힘, bash 7개 중 1개(openssl 없음이 즉시 멈추지 않음)가 처음엔 통과 → 시험 강화 후 잡힘.
- Demo route / local start steps: 홈·`/settings`(#accounts·#expiry). 인증서 갱신은 사용자 PC 에서 `bash scripts/dev-cert.sh check` → 필요 시 `bash scripts/dev-cert.sh renew` → dev 서버 재시작.
- External calls performed: none(앱 코드). 참고: 구현 에이전트가 시험 1회를 `corepack pnpm exec` 대신 `npx` 로 돌려 npm 이 자기 버전 확인으로 공개 npm 레지스트리에 접속함 — 앱 코드·계정과 무관.
- Mock-only functionality: 해당 없음(읽기·표시·로컬 스크립트).
- Known risks / not run:
  - Codex 검증 **미실행**(클라우드에 Codex CLI 없음). 브라우저·좁은 화면 렌더링 미확인.
  - 사용자 PC 의 실제 인증서·실행기 미확인: 파일 이름 일치 여부, 재시작 후 dev 서버가 새 키를 읽는지.
  - Windows Git Bash 특이점 미확인: openssl 경로(`/mingw64/bin/openssl`), GNU `date -d`, NTFS 에서 `chmod` 무효, `mktemp`·`mv` 동작.
  - `renew` 의 키 `mv` 와 인증서 `mv` 사이 실패 시 백업에서 되돌릴 때까지 키·인증서 불일치 가능(원자적 디렉터리 교체 아님).
  - 홈 렌더마다 계정 조회 1회 추가, 요청마다 인증서 동기 읽기(작은 파일).
  - `DEV_TLS_CERT_PATH` 는 설정 스키마 밖(다른 개발 전용 변수와 같은 방식), shellcheck 미설치, `deploy/scripts/tests/run-all.sh` 미실행, 시험 스크립트는 root 를 거부하지 않음(임시 디렉터리만 다룸).
- Questions specifically for Codex:
  1. 철회된 실제 연결을 제외하는 것이 맞는가? `error`·`needs_reconnect` 상태인데 만료일이 미래인 실제 연결도 14일 경고를 보여야 하는가?
  2. `DEV_TLS_CERT_PATH` 를 설정 스키마 대신 환경에서 직접 읽는 것과, 요청마다 크기 제한 동기 읽기가 허용 가능한가?
  3. `renew` 의 키 이동과 인증서 이동 사이 실패 창이 원자적 디렉터리 교체를 할 만큼 위험한가?
  4. 실제 Threads 계정이 여러 개면 경고에 계정 이름을 넣어야 하는가(지금은 계획 문구 그대로)?
  5. `check` 가 만료된 인증서에도 exit 0("만료됨" 출력만)인 것이 맞는가, 스크립트가 감지할 수 있게 0 이 아닌 값을 줘야 하는가?
  6. 설명 머리글이 붙은 공개 전용 시험 인증서를 커밋하는 것이 저장소의 비밀 금지 규칙에 맞는가?
- Next authorized task: 클라우드 계속 진행(사용자 지시 2026-10-19) — LIVE-P2·EXPIRY-1 독립 검토(Claude, Codex 아님) → 확인된 지적 FIX.
