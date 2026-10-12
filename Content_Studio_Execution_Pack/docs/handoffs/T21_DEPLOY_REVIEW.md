# T21 운영 배포 검토 (결정 문서 초안)
작성: 2026-10-12 (Europe/Moscow) · 작성자: Claude Code(조사 서브에이전트) · 기준 HEAD `bfcc93f`(content-studio/m4)
상태: **결정 대기**. 이 문서를 쓰는 동안 배포·가입·구매·계정 생성·외부 연결은 하지 않았다. `.env.local`·`./data` 는 열지 않았다.
가격은 아래 표의 URL 을 2026-10-12 에 직접 열어 본 값만 적었다. 확인하지 못한 값은 "미확인"으로 둔다.

## 0. 요약
- **지금 코드로는 인터넷 운영 배포를 할 수 없다.** 운영 로그인 수단이 없다. `AUTH_MODE=oidc` 는 모든 로그인을 거부하고, `dev` 는 localhost 에서만 동작한다. 이 문제는 설정으로 풀 수 없고 코드를 바꿔야 한다.
- PostgreSQL 드라이버가 구현되지 않았다. 그래서 운영 1단계는 **PGlite + inline worker 단일 프로세스**만 가능하다. 그런데 inline worker 에는 타이머가 없어서 요청이 들어올 때만 작업이 진행된다.
- 권고:
  1. 선행 작업 T21-P1~P4 를 로컬·모의 범위에서 끝낸다(§2).
  2. 그다음 **작은 VPS 1대**에 Caddy(TLS)와 Node 24 를 올리고 PGlite 를 영속 디스크에 둔다. `PUBLISH_MODE`·수집·OAuth live 는 모두 끈다.
  3. 실기기 사용성과 장애·복원 훈련(T21 통과 조건)만 확인한다.
- 사용자 위치(러시아) 관련 제약 세 가지는 공급자 문서나 보도로 확인했다(§3.4). 공급자를 고르기 전에 사용자가 직접 확인해야 한다.

## 1. 운영에 필요한 것
| 항목 | 필요 사항 | 현재 코드 근거 |
| --- | --- | --- |
| 프로세스 | Next 웹(`pnpm build` → `pnpm start`, `apps/web/scripts/next.mjs` 가 텔레메트리 끔). worker 는 별도 프로세스(`pnpm worker -- --loop`)이거나 web 안 inline | `apps/worker/src/index.ts:76-77` — `WORKER_MODE=separate` + `pglite` 조합은 거부 |
| DB | 설계는 PostgreSQL(docs/02). 현재 실제로 동작하는 것은 PGlite(단일 프로세스·단일 연결, PID 잠금) | `packages/db/src/client.ts` `createDb` — `postgres` 면 `DbDriverNotImplementedError`. `pg` 의존성 없음 |
| 영속 디스크 | `DATABASE_URL`(PGlite 디렉터리), `STORAGE_LOCAL_DIR`, `EXPORT_LOCAL_DIR`, `RESTORE_LOCAL_DIR`, `IMPORT_LOCAL_DIR` 가 모두 로컬 경로. 재시작·재배포 뒤에도 남는 디스크가 필요하다 | `packages/providers/src/storage.ts:151` — `STORAGE_DRIVER=object` 미구현 |
| TLS | 리버스 프록시(Caddy 등)에서 HTTPS 를 종단한다. `APP_BASE_URL=https://<도메인>` 이면 쿠키 Secure 가 자동으로 켜진다(`AUTH_COOKIE_SECURE=auto`) | `.env.example`, `packages/domain/src/config.ts:150-151` |
| 인증 | 단일 사용자 allowlist. 검증된 라이브러리 + OIDC 를 쓰고 자체 비밀번호는 금지(docs/02). **`AUTH_MODE=dev` 운영 사용 금지** | `packages/domain/src/auth.ts:30-38`, `errors.ts:133`(oidc → `oidc_not_configured`) |
| 비밀 | `SECRETS_MASTER_KEY`(32바이트 base64. DB·백업·export 와 분리), `ANTHROPIC_API_KEY`, `THREADS_APP_ID/SECRET`. 서버 환경 파일(권한 600)에만 두고 저장소·로그·브라우저에는 두지 않는다 | `apps/web/next.config.ts` 가 루트 `.env.local`/`.env` 를 읽음. D24·D31·D34 |
| OAuth redirect | 실제 Threads 연결에는 `https://<도메인>/api/oauth/callback` 을 Meta 앱 대시보드에 정확히 등록해야 한다(D31: http 거부 가능성) | `OAUTH_REDIRECT_URI`, `packages/domain/src/oauth.ts:429-455` |
| 공개 미디어 URL | Instagram 실게시(D30-1)에는 앱이 인터넷에서 HTTPS 로 짧은 수명의 서명 URL 을 제공해야 한다 | `packages/providers/src/public-media.ts` — 모의(`mock://`)만 있고 실제 경로는 없음 |
| 백업·복원 | 일별 DB+asset 백업, 운영 전 복원 훈련 1회 통과(docs/02·07). 앱 기능: `POST /api/exports`(ZIP), `/api/ops/restore-drill`, `/ops` 백업 나이(24시간) | D22·D23. CLI `pnpm export`·`drill:restore` 는 web 이 PGlite 를 열고 있으면 잠금 때문에 exit 1 |
| 시간대 | 시각은 UTC 로 저장하고 화면에는 MSK 로 표시한다. 서버 로컬 시간대에 의존하지 않는다 | `packages/domain/src/time.ts:5` `DISPLAY_TIMEZONE='Europe/Moscow'`. 서버는 `TZ=UTC` 권장 |
| 기본 OFF 유지 | `PUBLISH_MODE=disabled`, `COLLECTOR_MODE=disabled`, `COLLECTOR_SCHEDULER=off`, `IMPORT_CONNECTOR_MODE=disabled`, `OAUTH_MODE=mock`, `STT_MODE=mock` | `.env.example` |

## 2. 운영을 막는 공백 (코드 근거)
| ID | 공백 | 근거 | 영향 / 필요한 일 |
| --- | --- | --- | --- |
| G1 **차단** | 운영 인증 없음 | `auth.ts:36-37`(oidc 는 항상 거부), D3 "인터넷 노출 배포에 쓸 수 없음", 로그인 시도 횟수 제한 없음(D3) | 운영 로그인 수단을 구현해야 한다(**T21-P1**). 예: 검증된 OIDC 라이브러리 + 외부 IdP + `AUTH_ALLOWED_IDENTITY` 일치 + 로그인 횟수 제한. IdP 선택과 IdP 계정은 사용자 결정 사항 |
| G1a 위험 | 잘못된 설정의 위험: `APP_BASE_URL=http://localhost:3000` 인 채로 프록시를 통해 외부에 노출하면 dev 로그인 가드를 통과한다 | `isLocalhostBaseUrl` 은 요청 Host 가 아니라 설정값만 본다. `assertSameOrigin` 의 Origin 은 브라우저가 아닌 클라이언트가 위조할 수 있다 | 비밀번호 없이 허용 식별자(이메일)만 맞히면 세션이 생긴다. P1 에서 운영 빌드(`NODE_ENV=production`)이면 dev 모드 시작 자체를 거부하도록 가드를 추가해야 한다 |
| G2 **차단(2단계)** | PostgreSQL 드라이버 미구현 | `client.ts` `createDb`, `packages/db/package.json`(pglite 만), ENVIRONMENT.md §7 D2 제약 | `WORKER_MODE=separate` 불가. A07·A20 동시성, D22 트리거·`set_config` 호환을 실제 Postgres 에서 검증한 적이 없다. 1단계 운영은 PGlite 단일 프로세스로 하고, Postgres 전환은 별도 과제(**T21-P5**, 선택) |
| G3 **차단** | inline worker 를 주기적으로 실행하는 장치 없음 | inline tick 은 `GET /api/health`, `/api/transcription-jobs`, `POST /api/worker/tick` 에서만 돈다(`apps/web/lib/stt.ts:15`). `setInterval`·instrumentation 은 없다 | 예약 작업, 업로드 24시간 만료, `RETENTION_SWEEP_MODE=auto`(시간당), 수집 스케줄러가 요청이 없으면 멈춘다. **T21-P2**: 서버 내부 타이머(systemd timer 등)로 `127.0.0.1` 의 tick 경로를 주기 호출하거나 web 안에 타이머를 둔다. 장시간 오프라인 후 오래된 예약을 자동 공개하지 않는 규칙(docs/07)은 그대로 둔다 |
| G4 **차단** | 공개 `/api/health` 의 부작용과 노출 | `apps/web/app/api/health/route.ts` — 인증 없는 GET 이 worker tick(최대 5건)을 실행하고, 모드·`llm.missing` 조건 이름·버전·DB 드라이버를 반환 | 외부 누구나 작업 처리를 일으킬 수 있고 요청을 반복해 부하를 줄 수 있다. **T21-P3**: 공개 health 는 생존 여부만 반환하고, tick 은 로그인 또는 내부 호출에서만 돌게 한다. 또는 프록시에서 `/api/health` 를 내부망으로만 허용한다 |
| G5 | 서버 밖 백업 없음 | D23(c) "백업을 이 PC 밖으로 옮기지 않는다". export 는 수동(화면) | 서버 디스크 하나가 고장 나면 원본과 백업을 함께 잃는다. **T21-P4**: 백업 위치를 사용자가 다시 결정해야 한다(예: 사용자 PC 로 주기적으로 내려받기, 공급자 스냅샷). 자동 일별 export 는 없음 |
| G6 | 공개 미디어 서명 URL 미구현 | `public-media.ts`(모의) | Instagram 실게시는 불가. 1단계 범위 밖으로 둔다 |
| G7 | 배포 산출물 없음 | 저장소에 Dockerfile·compose·systemd unit·Caddyfile 이 없다. Next `output` 설정도 없다 | 서버에서 `pnpm install --frozen-lockfile` + build 를 해야 한다(메모리 2GB 이상 권장 — 근거는 경험칙이며 실측하지 않음). unit·Caddyfile 은 P2 에서 저장소에 추가 |
| G8 | migration 자동 적용 | `client.ts` `openDb` 가 첫 연결 때 migrate 실행 | 배포하면 schema 가 곧바로 앞으로 이동한다. 되돌리는 방법은 "배포 직전 export → 이전 빌드 + 빈 DB 에 restore" 뿐이다(down migration 없음) |
| G9 | 실계정 연결 범위 | D31: Threads 2단계는 localhost 기준. 운영 redirect URI 등록과 외부 노출은 "승인 범위 밖" | 운영 도메인으로 Threads 를 연결하려면 별도 승인이 필요하다. 로컬과 운영의 `SECRETS_MASTER_KEY` 가 다르면 연결 정보는 옮겨지지 않는다(설계상 "다시 연결 필요") |
| G10 | E2E·실기기 미검증 | `scripts/e2e-not-run.mjs`(E2E not_run) | T21 "실기기 사용성"은 아직 수동 확인 계획만 있다 |

## 3. 호스팅 선택지 (단일 사용자·비공개 앱)
### 3.1 A — 작은 VPS 1대: Caddy(TLS) + Node 24 + PGlite(영속 디스크), systemd
- 구성: Caddy 가 :443 을 받아 web(127.0.0.1:3000)으로 넘긴다. systemd timer 가 tick 을 실행한다(P2). 데이터 폴더는 `/srv/content-studio/data` 하나에 둔다.
- 장점: 현재 코드(PGlite·local 저장소) 그대로 동작한다. 비용이 낮다. 디스크가 영속적이다. 백업 대상이 폴더 하나다.
- 단점: OS 패치·방화벽·디스크 관리를 사용자가 직접 해야 한다. 서버 1대가 단일 장애점이다.
- 후보 공급자(확인한 가격):

| 공급자 | 요금제 | 사양 | 월 가격 | 출처(열람 2026-10-12) |
| --- | --- | --- | --- | --- |
| Timeweb Cloud | MSK 30 (Premium, 모스크바) | 1 vCPU / 2 GB / NVMe 30 GB | 2 140 ₽ | https://timeweb.cloud/services/vds-vps |
| Timeweb Cloud | MSK 50 | 2 vCPU / 4 GB / 50 GB | 3 840 ₽ | 같은 페이지. 더 싼 다른 요금제 5개는 펼치지 못해 **미확인**. 백업 가격 **미확인**(별도 유료로만 표기). 페이지 위치 목록: 모스크바·상트페테르부르크·노보시비르스크·카자흐스탄·네덜란드·독일·뉴욕 |
| DigitalOcean | Basic Droplet | 1 vCPU / 2 GiB / 50 GiB / 2 000 GiB 전송 | 12.00 USD | https://www.digitalocean.com/pricing/droplets — 백업은 주간 +20%, 일간 +30%(일간이면 15.60 USD) |
| DigitalOcean | Volumes(선택) | 블록 스토리지 | 0.10 USD/GiB | https://docs.digitalocean.com/products/volumes/details/pricing/ |
| Hetzner Cloud | CPX12 등 | 1 vCPU / 2 GB / 40 GB | **미확인**(가격 칸이 비어 있었고 "currently unavailable" 로 표시) | https://www.hetzner.com/cloud/regular-performance/ — §3.4 의 제약 때문에 후보에서 제외 |

### 3.2 B — VPS + 관리형 PostgreSQL (2단계, G2 해결 뒤)
- 구성은 A 와 같고 DB 만 관리형 Postgres 로 바꾼다. web 과 worker 를 분리(`WORKER_MODE=separate`)할 수 있고 공급자의 자동 백업을 쓸 수 있다.
- 가격 예: DigitalOcean Managed PostgreSQL 최저 15.15 USD/월(1 GiB RAM, 1 vCPU, 10~30 GiB) — https://www.digitalocean.com/pricing/managed-databases (2026-10-12). A 와 합치면 약 27 USD/월(백업 제외).
- 지금은 **불가**: Postgres 드라이버(P5)와 A07·A20 실 Postgres 검증이 먼저 필요하다.

### 3.3 C — PaaS(Render): 웹 서비스 + (worker) + Postgres + 디스크
- Render 공식 글(2026-07-08 작성, 2026-10-12 열람): https://render.com/articles/how-much-does-cloud-application-hosting-cost-for-small-businesses — Starter 웹 + Basic-256mb Postgres(Hobby 워크스페이스)가 **약 13 USD/월**, 영속 디스크 0.25 USD/GB·월, Postgres 저장공간 0.30 USD/GB·월, Hobby 0 USD.
  - Starter 단가 7 USD(512 MB)와 Postgres 6 USD 는 제3자 자료로만 확인했다. 공식 가격 페이지(https://render.com/pricing)는 본문을 읽지 못해 **미확인**.
- 현재 코드에서는 Postgres 를 쓸 수 없으므로(G2) 실제로는 **웹 서비스 1개 + 디스크에 PGlite** 구성만 가능하다. 그러면 관리형 DB 의 이점이 없다. 512 MB 메모리에서 Next 와 PGlite 가 돌아가는지도 확인하지 않았다.
- 판단: 지금 단계에서는 A 보다 나은 점이 없다. P5 이후에 다시 검토한다.

### 3.4 사용자 위치(러시아) 관련 — 문서·보도로 확인한 것만
| 사항 | 확인 내용 | 출처 | 등급 |
| --- | --- | --- | --- |
| Anthropic 지원 지역 | 지원 국가 목록에 러시아가 **없다**. 정책은 API 를 포함한 모든 제품에 적용되고, 지원되지 않는 지역에 **물리적으로 있는 사람**도 대상에 포함한다 | https://www.anthropic.com/supported-countries (2026-10-12 열람, 갱신일 표기 없음) | 공식 |
| Hetzner | 2023-12 러시아 우편 주소 고객 계약 해지를 통보했다고 보도됨 | https://mangohost.net/blog/hetzner-announces-termination-of-services-to-russian-customers-migrate-asap/ , https://rozetked.me/news/31618-nemeckiy-hosting-hetzner-prekratit-rabotu-s-rossiyskimi-pol-zovatelyami | 보도(공식 원문 미확인) |
| DigitalOcean | 2024-04-10 Roskomnadzor 가 러시아 내 접근 차단을 발표했다고 기록됨. 모스크바에서 앱에 접속하지 못할 수 있다. 가입·결제 조건은 **미확인** | https://digitalpolicyalert.org/event/19120-announced-roskomnadzor-ban-of-digitalocean-llc-for-violating-local-operational-requirements | 규제 추적 사이트 |
| Render·Timeweb | 러시아 관련 가입·결제·접속 제약 문서는 찾지 못했다(**미확인**) | — | — |

- docs/07: "서비스/API 미지원 지역 → 해당 live provider 를 쓰지 않고 적법한 대안·수동 경로, **우회 설계 금지**."
- 따라서 이 검토는 **서버 위치를 지역 정책을 맞추는 수단으로 제안하지 않는다**. 운영 서버에서 `LLM_MODE=live` 를 켤지는 배포 승인과 따로, 사용자가 위 정책을 확인한 뒤 결정한다. D35 는 로컬 사용에 대한 결정이다.
- Meta(Threads·Instagram)를 러시아에서 쓸 수 있는지, 러시아 IP 에서 Meta API 를 호출할 수 있는지는 이 조사에서 확인하지 않았다. 실계정 단계 전에 확인이 필요하다.

## 4. 권고·승인 범위 초안·단계
### 4.1 권고
1. **지금 배포 승인을 요청하지 않는다.** 먼저 로컬·모의 범위의 선행 작업을 각각 Codex 검증까지 끝낸다.
   - P1: 운영 인증(OIDC + allowlist + 횟수 제한 + 운영 빌드에서 dev 금지)
   - P2: 주기 tick + systemd unit/Caddyfile 예시
   - P3: 공개 health 를 생존 여부만으로 축소하고 tick 분리
   - P4: 백업을 서버 밖에 둘 위치를 사용자가 결정
2. 그 뒤 **선택지 A(VPS 1대)** 로 1단계 운영을 한다.
   - 공급자는 사용자가 결제 수단·모스크바 접속 가능 여부·약관을 확인한 뒤 고른다.
   - 확인 가능한 범위에서는 Timeweb Cloud(루블 결제, 러시아 내 접속 문제 보도 없음)가 1순위 후보다. 가격 확인 2 140 ₽/월(2 GB).
   - DigitalOcean 은 가격은 확인했지만(12 USD/월, 일간 백업 포함 15.60 USD) 러시아 내 차단 기록이 있어 2순위다.
3. 1단계 목표는 **T21 통과 조건만**이다: 실기기(휴대폰) 사용성, 서버 재시작, 만료 token(모의), DB 복원, 파일 누락. 실제 게시·수집·실계정 연결은 포함하지 않는다.

### 4.2 승인 범위 초안 (P1~P4 완료 후 사용자에게 제시)
| 항목 | 정확한 내용 |
| --- | --- |
| 생성 | 공급자 계정 1개(사용자 본인이 가입·결제), VPS 1대(1 vCPU / 2 GB / 30 GB 이상), 방화벽 규칙(22 = 사용자 IP 만, 80/443 공개), 도메인 1개 또는 서브도메인 1개 + A 레코드 |
| 비용 상한 | VPS 월 ____(선택한 요금제 그대로. 예: 2 140 ₽ 또는 12~15.60 USD). 도메인 연간 ____(**미확인**, 사용자 확인). 그 밖의 유료 부가 서비스 없음 |
| 도메인·TLS | `https://<사용자 도메인>` 하나. Caddy 자동 인증서(Let's Encrypt). 다른 공개 경로 없음 |
| 넣을 비밀(사용자가 서버 환경 파일에 직접 입력, 권한 600) | `SECRETS_MASTER_KEY`(운영 전용 새 키 — 로컬 키 재사용 안 함), IdP client 설정(P1 결과). **넣지 않음**: `ANTHROPIC_API_KEY`, `THREADS_APP_ID/SECRET`(각각 별도 승인) |
| 고정 설정 | `AUTH_MODE=<P1 운영 모드>`, `APP_BASE_URL=https://<도메인>`, `DB_DRIVER=pglite`, `WORKER_MODE=inline`, `STORAGE_DRIVER=local`, `PUBLISH_MODE=disabled`, `COLLECTOR_MODE=disabled`, `COLLECTOR_SCHEDULER=off`, `IMPORT_CONNECTOR_MODE=disabled`, `OAUTH_MODE=mock`, `LLM_MODE=mock`, `STT_MODE=mock`, `LLM_LIVE_APPROVAL_REF`·`OAUTH_LIVE_APPROVAL_REF` 비움, `RETENTION_SWEEP_MODE=manual`, `TZ=UTC` |
| 데이터 | 처음에는 빈 DB. 로컬 데이터 이전(export ZIP → restore `empty_only`)은 사용자가 고른 묶음만, 별도 확인 후. 고용주 기밀·실명 자료 없음(AGENTS.md) |
| 범위 밖 | 실제 게시, 실계정 OAuth(운영 redirect URI 등록), 실제 AI·STT 호출, 실제 수집, 공개 미디어 URL, Postgres, 외부 알림, 자동 배포(CI/CD) |

### 4.3 단계와 되돌리기
| # | 단계 | 확인 | 되돌리기 |
| --- | --- | --- | --- |
| 1 | 사용자가 공급자에 가입·결제하고 VPS 를 만든다. SSH 키만 허용하고 방화벽을 설정한다 | SSH 접속, 22 포트 외부 차단 | 서버 삭제(과금 중지) |
| 2 | OS 업데이트, Node 24.x(저장소 `engines`·ENVIRONMENT.md 판), corepack pnpm 12.6.0, Caddy 설치 | 버전 기록 | 서버 재생성 |
| 3 | 리뷰 통과한 HEAD 를 checkout → `pnpm install --frozen-lockfile` → `pnpm build`(dev 서버 없이) | build 종료 코드·HEAD SHA 기록 | 이전 SHA 로 다시 build |
| 4 | 환경 파일 작성(§4.2 고정 설정, 비밀은 사용자가 입력), systemd 로 web 기동 | `curl 127.0.0.1:3000/api/health` 가 ok, `modes` 가 모두 OFF/mock | 서비스 중지 |
| 5 | DNS A 레코드 → Caddy 로 HTTPS | 인증서 발급, http→https, `/api/health` 응답 범위(P3) | Caddy 중지 = 외부 차단 |
| 6 | 운영 로그인(P1)과 허용 식별자 외 거부를 확인 | 다른 계정·세션 없이 401/403, 감사 기록 | `AUTH_MODE` 를 잠금 상태로 두고 서비스 중지 |
| 7 | T21 훈련: 재시작 중 예약 유지, 모의 만료 token → BLOCKED, `/ops` 복원 훈련 PASS, asset 파일 1개 삭제 → checksum 차단 | 결과·명령을 pass/fail/not_run 으로 기록 | 훈련용 데이터는 모의·합성만 |
| 8 | 첫 export ZIP 을 사용자 PC(또는 P4 에서 정한 위치)로 옮기고, 빈 환경 복원 1회 | A18 일치 | — |
| 9 | 실기기(휴대폰) 사용성 확인, 첫 회고 기록 | 화면 노트 | — |

- 업데이트 배포 순서: ① export ZIP 을 서버 밖에 보관 ② 새 SHA build ③ 재시작.
- 실패 시: 이전 SHA 로 재build → 데이터 폴더 백업본(정지 상태에서 복사) 복구. migration 은 자동으로 앞으로만 적용되므로(G8) "코드만 되돌리기"는 하지 않는다.
- 철수: export → 서비스 중지 → 서버 삭제 → DNS 레코드 삭제. 원격 SNS 게시물은 없다(게시 disabled).

## 5. 남은 위험
1. 인증 구현(P1)은 보안 핵심이다. 라이브러리 선택, IdP 계정, 러시아에서의 IdP 접속 가능 여부를 아직 정하지 않았다. 구현 후 Codex 검증과 외부 노출 전 점검이 필요하다.
2. PGlite 를 장기 운영에 쓴 근거가 없다. 단일 프로세스 crash 때의 일관성이나 큰 데이터에서의 성능을 실측하지 않았다. 정지 상태 복사가 아니면 데이터 폴더 스냅샷의 일관성도 보장할 수 없다(백업은 앱 export 를 정본으로).
3. 서버 밖 백업 부재(D23(c))가 운영에서는 실제 데이터 손실 위험이 된다. 사용자 재결정이 필요하다.
4. 지역 제약(§3.4): Anthropic 지원 지역 정책, 해외 호스트에 대한 러시아 내 차단, 결제 수단. 공급자 문서로 확인하지 못한 항목은 실제 가입 전에 사용자가 확인한다.
5. inline tick 을 타이머로 돌리면 웹 요청 처리와 같은 프로세스에서 작업이 실행된다. 영상 조각(5초 상한)과 전송 timeout 은 있지만, 실기기 부하에서 응답 지연을 측정하지 않았다.
6. 공개 health·로그인 경로에 대한 자동화 공격(G1·G4)은 P1·P3 전까지 막을 수 없다. 프록시 수준의 요청 제한을 추가로 권장한다.
7. 가격은 2026-10-12 열람값이다. Render 단가와 Timeweb 백업·도메인 가격은 미확인이다. 실제 청구액은 세금과 환율에 따라 달라질 수 있다.
8. 이 문서의 어떤 내용도 배포·가입·외부 연결이 실행되었다는 뜻이 아니다. 실행 결과는 아직 없다(not_run).
