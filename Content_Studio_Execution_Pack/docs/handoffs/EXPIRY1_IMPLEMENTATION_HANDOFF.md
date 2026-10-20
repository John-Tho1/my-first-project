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

---

# FIX round 1 (Claude 독립 검토 — Codex 아님, `D39_CLAUDE_REVIEW.md`)
- BASE_SHA: 4865c23 (LIVE-P2 FIX1 7538492 + 인계) · **HEAD_SHA: 92cd026** (`92cd026a4219b4f7e9389a8d9ed3f353673f9b22`)
- EXPIRY-1 확정 7건(모두 P2) 처리. 기각 1건: "시험 가드가 넘겨준 DEV_CERT_DIR 만 확인"(검증자가 다른 가드로 이미 막힌다고 판단).

| # | 지적 | 변경 | 시험(실패 → 통과 증거) |
|---|---|---|---|
| 1 | 해제 중(revoking) 연결에도 "다시 연결" 경고 | `status` revoked·revoking 또는 `revoked_at` 이면 제외. error·needs_reconnect·expired 는 다시 연결로 풀리므로 계속 경고(파일 머리 규칙) | `credentialHealth({status:'revoking'})` 로 만든 입력 1일·0·지난 만료, 다른 막힘 상태 경계, 홈·설정 렌더 — 이전 실패, 검사 제거 변이 3건 실패 |
| 2 | 페이지가 쓰는 인자 없는 호출의 운영 차단 시험 없음 | 코드 변경 없음 | `dev-cert-default.test.ts`(node:fs·@cs/db 모듈 대체): 운영 + 인자 없음 → 경로 계산·파일 접근 0(DEV_TLS_CERT_PATH 유무), 개발·시험은 읽음, NODE_ENV 항 소스 확인, 홈·설정이 인자 없이 부름 — 변이 4종(env 기본값·NODE_ENV 항 제거·차단 위치 이동·페이지가 env 넘김) 잡힘. 빌드 산출물에 `if("production"===b.NODE_ENV)return null` 확인 |
| 3 | 키 이동 뒤 인증서 이동 실패 시 짝 불일치 + EXIT trap 이 맞는 인증서 삭제 | 같은 폴더 임시 이름 → 백업 → 키·인증서 순 교체, 상태 변수로 추적, 두 번째 이동 실패·오류·HUP/INT/TERM 시 백업에서 옛 키 복원(없었으면 새 키 삭제). 복원도 실패하면 짝 맞는 `.new-cert.*` 보존 + 경로·`mv -f --` 안내, 정리 중 추가 신호 무시. 키·인증서 자리에 폴더면 거부(추가) | 가짜 `mv`(PATH)로 7경우: 인증서 이동 실패, 복원도 실패, 옛 키 없음, 키 이동 실패, 두 이동 사이 TERM(143), TERM 두 번, 자리에 폴더 — 옛 파일 바이트 동일·공개 키 일치·임시 파일 없음·키 미출력. 옛 스크립트에 새 시험 128 통과/31 실패 → 165/0 |
| 4 | 같은 이름 검사가 대소문자 구분(NTFS·APFS 는 무시) | bash `nocasematch` 비교(무 openssl 시험 PATH 에 `tr` 없음) | `Localhost.pem`/`localhost.pem` 등 4쌍 + check → exit 2 "같은 파일" — 되돌림 변이 11 단언 실패 |
| 5a | 백업 이름 충돌 시험이 시각 의존 | 시험에서 가짜 `date` 고정 + 미리 만든 백업 폴더 | `-1`·`-2` 생성·파일 일치·sentinel 동일·폴더 3개 — 반복 없는 `mkdir -p` 변이 9 단언 실패 |
| 5b | 키 누출 탐지가 PEM 형식만 | `PRIVATE KEY`·`Private-Key`·`priv:`(대소문자 무시), 임의 폭으로 다시 감싼 base64(PKCS#8·SEC1), 콜론·줄바꿈 제거한 16진 값 검사. 가짜 openssl 이 `-key` 인자를 복사해 실패 경로에서도 새 키 확인 | 자체 시험(누출 7형식 잡음·공개 전용 4형식 통과). 변이 `pkey -text` 출력·40폭 DER base64·실패 경로 16진: 옛 시험 82/0 통과 → 새 시험 각각 7·7·1 실패 |
| 5c | NTFS 에서 키 권한 검사 거짓 실패 | 탐침 파일 chmod 644 → 600 되읽기, 안 지키면 이유 출력하고 건너뜀, POSIX 에서는 600 단언 유지 | 키 644 남김 변이 실패, 가짜 no-op chmod 로 164/0/1 건너뜀 |

- 명령(클라우드 Node 22.22.2, 오케스트레이터 순차 재실행): install --frozen-lockfile(lockfile 불변) · lint · typecheck · build PASS · unit 81 files / 1906 · integration 51 files / 938 · drill:mock 위반 0 · `test-dev-cert.sh` 165 passed / 0 failed / 0 skipped · `bash -n` ok · `data/dev-certs` 생성 없음. shellcheck 미설치.
- 차이: `./x.pem`·`x.pem/` 정규화는 하지 않음(이름에 `/` 가 있으면 이미 exit 2 — 시험 추가). 해제 중 계정은 "만료 관리" 카드에서도 빠짐. 기존 "renew 두 번" 시험·단언 유지(제목만 명확히).
- 남은 위험: Windows Git Bash 실제 실행 안 함(NTFS 대소문자, 실제 noacl chmod(모의만), 가짜 mv 의 `kill -TERM $PPID`, mintty Ctrl+C, 잠긴 파일에서 MSYS mv 실패 방식, `fold`·`cmp`·`find -maxdepth`). "복원 실패" 경로는 일부러 `data/dev-certs` 에 `.new-cert.*` 를 남김. "복원 중 정지" 정리 분기는 방어 코드로 시험 없음(복원 중 신호 무시라 도달 불가 예상). NODE_ENV 인라인은 이번 빌드 1회만 확인.
- 검토자에게 물을 것:
  1. 정리 대기(pending_cleanup_revoke 등) 때문에 `error` 인 연결도, 다시 연결이 막힌다면 revoking 처럼 제외해야 하는가(OAuth 콜백 동작 미확인)?
  2. NODE_ENV 항 소스 확인으로 충분한가, 빌드 산출물 자동 확인이 필요한가?
  3. 되돌리기가 키만 복원(인증서는 아직 이동 전)하고, "복원 실패" 때 짝 맞는 새 인증서를 점 파일로 남겨 사용자가 옮기게 하는 것이 맞는가?
  4. 정리 중 추가 신호 무시가 허용되는가(짧은 cp·mv 동안 중단 불가)?
  5. 출력 전체를 16진 문자로 줄여 비교하는 누출 검사의 거짓 양성 위험이 허용 가능한가?
  6. 키·인증서 자리 폴더 검사를 이 FIX 에 두는가, 따로 뺄 것인가?

---

# FIX round 2 (2차 Claude 독립 검토 — Codex 아님)
- BASE_SHA: 41bd767 (2차 검토 기록 docs) · **HEAD_SHA: 561bc5f** (`561bc5f9e6c73ca9164913b0e1ab86e786207a68`) — LIVE-P2·EXPIRY-1·LIVEL1-H2 지적을 한 커밋으로 처리.
- 검토: 2차 Claude 독립 검토(Codex 아님, `D39_CLAUDE_REVIEW.md` 2차) 확정 12건(중복 2쌍, 실질 10건, 전부 P2), 기각 2건.
- 명령(클라우드 Node 22.22.2, 오케스트레이터 순차 재실행): install --frozen-lockfile(lockfile 불변) · lint · typecheck · build PASS · unit 81 files / 1934 · integration 51 files / 956 · drill:mock 위반 0 · test-dev-cert.sh 251/251 · bash -n ok · data/dev-certs 생성 없음.
- FIX round 2 자체는 아직 독립 검토하지 않았다(필요하면 3차 검토). Codex 미검증.

| 지적 | 변경 | 시험·증거 |
|---|---|---|
| 해제 중이면서 정리 대기(health error)인 연결에 경고 | `accountHealthView` 가 원래 `credential_status` 노출, `isLiveThreadsCredential` 이 그 값의 revoking/revoked 도 제외. 정리 대기 때문에만 error 인 연결은 계속 경고 | 도메인 시험 + 실제 accountHealthView 를 홈·설정에 넣은 렌더 시험(수정 전 실패, 검사 제거 시 경고 다시 표시) |
| EXIT trap·swap_fail 안 errexit 로 정리·되돌리기가 끊김 | `cleanup()`·`swap_fail()` 시작에서 `set +e`, HUP·INT·TERM·PIPE 무시 | 두 rename 사이 TERM/HUP/INT + stderr `/dev/full`·닫힌 fd, 끊긴 파이프, 인증서 이동 실패 + /dev/full·닫힌 fd: 이전 rc 1/141·짝 불일치·임시 파일 → 이후 rc 143/129/130/1, 원래 짝 바이트 동일·임시 파일 없음 |
| 점으로 시작하는 이름이 백업 glob 에서 빠짐 | `valid_name` 이 앞 점 거부(exit 2, "점(.)으로 시작할 수 없습니다") + 교체할 키·인증서가 백업에 없으면 옮기기 전 중단(대소문자 무시 FS 틈 보완) | 이름 4경우, 실제 `.k.pem` 폴더(그대로·백업 없음), 백업에서 키를 빼는 가짜 cp. 정규식 되돌림 10건·가드 제거 6건 실패 |
| 교체 실패 4경우에 키 누출 단언 없음 | swap-nokey·swap-key·swap-term2·swap-dir 에 새 키 캡처 + `expect_no_key_in`(swap-dir 는 키 미생성도) | 각 경로에서 키를 출력하는 변이 모두 잡힘 |

- test-dev-cert.sh: 이전 스크립트로 198 통과 / 53 실패 → 수정 후 251/251. `/dev/full` 없는 환경은 해당 경우 건너뜀, `mkfifo` 없으면 FIFO 경우 건너뜀. Git Bash·macOS 실행 안 함.
