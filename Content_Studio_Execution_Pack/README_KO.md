# 개인 콘텐츠 스튜디오 — 실행계획·개발 착수 패키지
기준일: 2026-09-24 (Europe/Moscow) · 설계 v1.0 · 개발용 가칭: Content Studio

이 패키지는 **실행 가능한 앱이 아니라 구현 명세와 Claude Code/Codex 인계 자료**다. 앱 코드·OAuth 연결·실제 게시·배포는 아직 수행하지 않았다.

## Idea — 권고안
모바일과 PC에서 쓰는 개인용 웹앱으로 시작한다. 메모·링크·음성을 쉽게 모으고, AI의 짧은 질문으로 소재를 글로 발전시키며, 작성한 원본을 검색·재사용한다. 사용자가 채널별 최종본과 계정을 확인하고 배포를 실행하면 게시 작업을 추적한다.

기술 권고 [실험 가정]: Next.js/TypeScript 웹앱 + PostgreSQL + 별도 Node.js 작업 처리기 + 비공개 파일 저장소. 하나의 저장소·하나의 도메인 모델을 쓰는 모듈형 단일 앱. 초기에는 Redis, 벡터 DB, 마이크로서비스를 추가하지 않는다. React/Next.js 등 실제 버전은 M0에서 지원·보안 상태를 확인하고 잠근다.

핵심 효과의 가설은 “더 많은 글을 자동 생산”이 아니라 **포착한 생각을 잃지 않고, 쓰기 시작하는 부담을 줄이며, 완성한 글을 다시 활용하는 것**이다. 매체 수와 자동화율보다 사용자가 실제로 이어서 쓰는지를 먼저 확인한다.

## Audience — 확정된 독자와 운영자
- 운영자: 1명, 필명/별도 채널명으로 시작. 얼굴 공개는 후속 결정.
- 콘텐츠 독자: 해외 사업·영업 실무자 및 관리자이면서 해외 근무에도 관심 있는 사람.
- 전문 영역: 해외 사업·영업 운영.
- 연재 축: 해외 사업·영업 운영 / 전문성의 AI 적용 / 해외·러시아·주재원·조직 차이 경험.
- 목표: 독립적인 배포 구조, 원본·아이디어 아카이브, 장래 수익 아이디어 축적.
- 언어: 한국어 우선. 영어 파생본은 명시적 선택. 앱 시간표시: Europe/Moscow.

## Evidence — 근거와 확인 범위
[확실] 위 방향과 Claude Code 주 구현·Codex 검증 방식은 이번 대화에서 사용자가 정했다.
[확실] 직전 단계에서 관련 Notion·Drive를 실제 조회했다. Content Vault 속성 16건, 그중 본문 4건을 읽었다. 이전 조회값은 마이그레이션 직전에 재확인한다.
[공식자료] API 및 코딩 도구의 공식 자료를 검색·확인했다. 출처·접근 제한은 docs/08_SOURCES.md에 기록했다.
[미확인] 사용자 PC의 Claude Code/Codex 설치·인증·기존 연결 설정, Git 저장소, 도메인, 서버, SNS 계정 종류·API 승인, 실행 지역의 서비스 지원, 예산.
[확실] 이 대화의 실행 환경에서는 claude/codex 실행파일이 PATH에서 발견되지 않았다. 사용자 PC의 설치 상태를 의미하지 않는다. 외부 Claude Code를 실행하거나 그 결과를 대신 주장하지 않았다.
ChatGPT에서 연결된 Notion·Drive 권한은 새 웹앱으로 이전되지 않는다. 앱용 인증을 따로 구성한다.

## 앱에서 실제로 하는 일
| 화면 | 사용자 행동 | 앱이 돕는 것 |
| --- | --- | --- |
| 오늘 | “지금 10분만 쓰기” 선택 | 작성 중 1건, 다시 볼 소재 2건, 확인이 필요한 사실 제시 |
| 빠른 수집 | 한 문장·URL·파일·음성 입력 | 원문 즉시 저장, 나중에 분류, 중복 후보 제안 |
| 소재함 | 관심 소재를 선택 | 독자 문제·핵심 주장·필요 근거를 제안 |
| 작성실 | 질문에 답하고 편집 | 개요 → 초안 → 수정 비교, 실제 경험 확인, 버전 기록 |
| 아카이브 | 주제·독자·근거로 검색 | 원본과 파생본·발행 결과를 연결 |
| 배포함 | 계정·채널별 미리보기 확인 후 실행 | 작업별 업로드/게시/실패/확인 필요 상태 추적 |

기술 오류를 제외한 일상 화면에는 큐, API, 토큰 같은 구현 용어를 노출하지 않는다. 배포 화면은 예를 들어 “YouTube: 비공개 업로드 완료, 공개 전환 확인 필요”처럼 실제 결과를 표현한다.

## 범위와 단계
| 단계 | Claude Code 구현 | Codex 통과 기준 | 참고 기간 [추정] |
| --- | --- | --- | --- |
| M0 환경·결정 | 저장소/버전/명령 점검, UI 뼈대, 가상 데이터, 외부 호출 차단 | 문서 정합성·clean-room·기본 구동 | 1–2 개발일 |
| M1 수집·아카이브 | 텍스트/URL 저장, 편집·검색·태그, 원문 내보내기/복원 | 저장 손실·중복·접근 제어·복원 | 3–5 개발일 |
| M2 작성 보조 | 문답·초안·버전·채널별 초안·비용 제한, 음성 파일 전사 | 경험 날조 방지·출처 연결·원본 보존 | 3–5 개발일 |
| M3 배포 엔진 | 승인 스냅샷·DB 작업함·모의 어댑터·수동 배포 파일 | 중복/동시실행/수정 후 승인/취소/불명확 응답 | 3–5 개발일 |
| M4 채널 연결 | Threads 텍스트 → YouTube 업로드 → IG 조건부, 각 채널 별도 PR | 각 계정과 실제 API로 승인된 시험 | 채널당 2–5 개발일 + 외부 심사 대기 |
| M5 지속 운영 | 선택 소스 수집, Notion·Drive 선택 가져오기, 백업·알림·재사용 | 복구 훈련·오류 가시성·재수집 중복 방지 | 3–5 개발일 |

개발일은 집중 작업량의 대략적인 가정이며 사용자에게 요구하는 시간이나 완료 약속이 아니다. 작은 PR과 검증 통과를 기준으로 진행한다. 외부 API 심사는 위 기간과 별개다. M1부터 사용하며 M4를 기다리지 않는다.

### 첫 버전에서 제외
영상 자동 생성·자동 편집, 네이티브 모바일 앱, 멀티테넌트 SaaS, 유료 결제, DM/댓글 자동응답, 모든 SNS 동시 연결, 웹사이트 무차별 수집, Notion 양방향 동기화, 회사 시스템 연결. 영상은 사용자가 완성한 파일을 등록한다. 원본 영상 보관·업로드와 공개 게시를 구분한다.

## 아키텍처 한눈에
~~~mermaid
flowchart TD
  U["개인 웹앱"] --> A["인증·콘텐츠 API"]
  A --> D["PostgreSQL"]
  A --> F["비공개 파일 저장소"]
  A --> Q["승인·작업함"]
  Q --> W["별도 작업 처리기"]
  W --> D
  W --> G["작성·수집 어댑터"]
  W --> P["채널별 게시 어댑터"]
  P --> S["SNS·YouTube"]
  G --> R["허용한 자료·AI API"]
~~~

웹 화면을 닫아도 작업이 지속되려면 서버와 작업 처리기가 켜져 있어야 한다. 로컬 PC만 사용하는 단계에서는 종료 중 예약 실행을 보장하지 않는다. 운영 배포는 HTTPS가 있는 한 개의 관리 가능한 서버부터 검토하고, 예약 기능을 켜기 전에 상시 실행 여부를 확인한다.

## 채널별 실행 원칙
- Threads: 공식 API로 텍스트 게시부터. 실제 계정 권한·테스터/앱 공개 조건은 M0/M4에서 확인.
- YouTube: 완성된 영상의 재개 가능한 업로드. 최초 통합 검증은 승인된 비공개 영상 1건. 미검증 API 프로젝트의 공개 제한을 숨기지 않는다.
- Instagram: 프로 계정·권한·미디어 규격 확인 후. 본문만으로 이미지/영상 게시물을 완성했다고 표시하지 않는다.
- LinkedIn: 선택 기능. 필명 정체성·계정 정책·권한 적합성 확인 전 연결하지 않는다.
- 미지원/미승인 채널: 원고·미디어·제목·설명·체크리스트를 담은 ZIP 내보내기. “파일 준비 완료”와 “게시 완료”는 별개다.
채널 상태는 지원됨/구현됨/인증됨/실계정 검증됨을 따로 기록한다. 구체 제약은 docs/03_DISTRIBUTION.md 참고.

## Risk — 핵심 통제
1. 발행 버튼은 선택한 계정·최종 원문·미디어·공개 수준·시간을 보여준 뒤 승인한다.
2. 글·미디어·계정·공개 범위·예약 시간이 바뀌면 그 채널 승인은 무효화한다.
3. 응답을 잃어 게시 여부가 불명확하면 자동 재게시하지 않는다. 상태 조회 또는 사용자 확인으로 해결한다.
4. 외부 콘텐츠는 명령이 아니라 자료다. AI에 게시 권한·OAuth 비밀을 제공하지 않는다.
5. 원문·근거·AI 생성·사용자 확인을 구분한다. 경험담을 만들어 넣지 않는다.
6. 고용주·고객·직원의 비공개 자료는 제외한다. 기존 데이터도 선택 미리보기·확인 후 가져온다.
7. AI/API 비용은 서비스 요금과 별개다. 가격을 가정하지 않고 설정한 상한·사용량을 기록한다.
8. DB+파일 백업과 복원 시험이 운영 배포의 조건이다.

## Claude Code와 Codex 역할
사용자: 독자·문체·공개 범위 및 실제 연결/게시/운영 배포 결정.
Claude Code: 하나의 작업을 구현하고 테스트·변경 내역·검증할 커밋을 인계.
Codex: 별도 worktree의 같은 HEAD를 읽고 위험 중심으로 검증. 기본은 수정 없이 보고; 동작 테스트는 비밀 없는 격리 환경에서 실행.
Claude Code: 지적사항 수정 → 새로운 HEAD → Codex 재검증.
Codex “문제 없음”은 테스트 통과나 사용자 발행 승인과 같지 않다. 자세한 절차는 docs/06_AGENT_WORKFLOW.md.

## Next Decision — 지금 시작하는 방법
1. ZIP을 개인 프로젝트 폴더에 푼다. 기존 저장소가 있다면 통째로 덮어쓰지 않고 문서를 검토해 합친다.
2. Claude Code에서 prompts/CLAUDE_START.md를 읽게 한다. 첫 작업 범위는 M0+M1.
3. 인계 커밋이 만들어지면 Codex에 prompts/CODEX_REVIEW.md와 인계 기록을 준다.
4. 결과를 prompts/CLAUDE_FIX.md와 함께 Claude Code에 전달한다.
5. M3까지는 가상 데이터·모의 게시를 기본으로 계속 구현할 수 있다. 실제 계정 연결·API 과금·게시·운영 배포는 구체 실행안을 확인하고 사용자가 결정한다.

채널 우선순위·환경 정보가 없어도 M0–M3 설계와 구현은 시작 가능하다. 정확한 서비스·예산·주간 루틴은 M0에서 선택한다.

### 파일 안내
- docs/01_PRODUCT_AND_UX.md: 수집·아이디어·작성·아카이브 경험
- docs/02_ARCHITECTURE.md: 배포 구조·보안·소유권·운영
- docs/03_DISTRIBUTION.md: 채널 어댑터·승인·재시도 상태
- docs/04_DATA_AND_API.md: 데이터·API 계약
- docs/05_BACKLOG_AND_ACCEPTANCE.md + tasks.json: 구현 순서·완료 조건
- docs/06_AGENT_WORKFLOW.md: Claude Code ↔ Codex 진행법
- docs/07_MIGRATION_AND_OPERATIONS.md: 선택 가져오기·운영/백업
- docs/08_SOURCES.md: 공식 근거·미확인 사항
- AGENTS.md, CLAUDE.md: 저장소 작업 규칙
- prompts/: 시작·검증·수정 지시문
- templates/, review/: 인계·결정·검증 양식


## 실행 방법 (M0, T01)
T01은 앱 뼈대(web·worker·DB·모의 provider·가상 데이터)다. 외부 키 없이 동작하며 **기본 모드에서 외부 쓰기는 0**이다(AI 모의, 게시 비활성, 수집 비활성). 게시·수집 가드는 서버/worker 코드(`packages/domain/src/guards.ts`)에서 기본 거부로 강제된다.

### 준비
- Node.js ≥ 22.12 (사용자 PC: v24.21.0, 클라우드 검증: v22.22.2)
- pnpm 12.6.0 — 루트 `package.json`의 `packageManager`로 고정. `corepack pnpm …`으로 실행하면 이 버전이 자동 선택된다. 아래 `pnpm`은 모두 `corepack pnpm`으로 바꿔 써도 된다.

### 설치·실행
~~~bash
corepack pnpm install --frozen-lockfile   # lockfile 고정 설치
cp .env.example .env.local                # placeholder 만 있음. 기본값으로도 동작
pnpm db:seed                              # migration + owner·brand profile·가상 소재 10건 (재실행해도 중복 없음)
pnpm dev                                  # http://localhost:3000 , 상태: http://localhost:3000/api/health
~~~
`pnpm dev`는 첫 요청에서 migration을 자동 적용하므로 `db:seed` 없이도 뜬다(이때 화면에 `pnpm db:seed 를 실행하세요`가 보인다).

### 로그인 (M1, T02)
M1에는 운영 인증 공급자(OIDC)가 아직 없어 **개발용 로그인(`AUTH_MODE=dev`)** 만 제공한다(결정 D3, `docs/DECISIONS.md`). 비밀번호 없이 허용된 식별자 1개(`AUTH_ALLOWED_IDENTITY`)만 접속할 수 있고, `APP_BASE_URL` 이 `localhost`/`127.0.0.1` 일 때만 동작한다.

1. `.env.local` 에서 `AUTH_ALLOWED_IDENTITY` 를 본인이 쓸 식별자로 바꾼다(기본 placeholder: `owner@example.local`).
2. `pnpm dev` 후 http://localhost:3000 을 열면 `/login` 으로 이동한다. 식별자를 입력하면 `/`(오늘)로 돌아간다.
3. 오늘 화면 상단에 `로그인: ow***@example.local`(가린 식별자)·`세션 만료: … (MSK)`·로그아웃 버튼이 보인다. `파일` 섹션에서 PNG·JPEG·WebP·PDF·텍스트(UTF-8, Markdown 포함)를 최대 10MB 까지 올리고 내려받을 수 있다.

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `AUTH_MODE` | `dev` | `dev` = 개발용 로그인(localhost 전용). `oidc` = 운영 인증(T13 예정) — 지금은 모든 로그인을 `운영 인증 공급자는 아직 설정되지 않았습니다(T13)` 로 거부 |
| `AUTH_ALLOWED_IDENTITY` | `owner@example.local` | 로그인 가능한 유일한 식별자. 바꾸면 기존 세션도 무효 |
| `AUTH_SESSION_TTL_MINUTES` | `720` | 세션 유효 시간(분, 5~43200). 연장(sliding) 없음 |
| `AUTH_COOKIE_SECURE` | `auto` | `auto` = `http://localhost`·`127.0.0.1` 이면 Secure 끔, 그 외 켬 |
| `STORAGE_DRIVER` / `STORAGE_LOCAL_DIR` | `local` / `./data/assets` | 업로드 파일 저장 위치(워크스페이스 루트 기준, gitignore). `object` 는 미구현 |

- 세션: 쿠키 `cs_session`(HttpOnly, SameSite=Lax, Path=/). 토큰 원문은 쿠키에만 있고 DB(`sessions`)에는 sha256 해시만 저장한다. 로그아웃은 POST 로만 가능하다.
- 상태를 바꾸는 요청(로그인·로그아웃·업로드)은 `Origin`(없으면 `Referer`)이 `APP_BASE_URL` 과 같아야 한다. 그래서 `APP_BASE_URL=http://localhost:3000` 이면 `http://127.0.0.1:3000` 으로 열었을 때 403 이 난다 — 주소창 주소를 `APP_BASE_URL` 과 맞춘다.
- 다른 사용자의 capture·파일 ID 로는 조회·다운로드할 수 없다(항상 404).
- **주의**: 이 모드는 인증이 아니라 개발 편의 장치다. 로그인 시도 횟수 제한은 없다. 인터넷에 노출된 서버에서 쓰지 않는다. 운영 인증(OIDC)은 T13 에서 추가한다.

### 검증 명령
| 명령 | 내용 | 기대 |
| --- | --- | --- |
| `pnpm lint` | ESLint(flat config, typescript-eslint + eslint-config-next) | exit 0 |
| `pnpm typecheck` | `tsc --noEmit`(패키지·worker·테스트) + `next typegen && tsc`(web) | exit 0 |
| `pnpm test` | vitest 단위 테스트(`packages/**`, `apps/**`) | exit 0 |
| `pnpm test:integration` | vitest 통합 테스트(`tests/integration`, PGlite 메모리 DB) | exit 0 |
| `pnpm test:e2e` | Playwright E2E — M0에서는 실행하지 않음 | **exit 2 = NOT_RUN** (통과 아님) |
| `pnpm build` | Next.js 프로덕션 빌드 | exit 0 |
| `pnpm start` | 빌드 결과 실행(포트 3000) | `/api/health` 200 |
| `pnpm db:migrate` / `pnpm db:seed` | SQL migration 적용 / 시드 | exit 0 |
| `pnpm worker` | worker tick 1회(M0: DB 연결 확인만) 후 종료 | exit 0, JSON 출력 |

### PGlite 단일 연결 주의
- 개발 DB는 PGlite(PostgreSQL WASM)이며 데이터는 `./data/pglite`(워크스페이스 루트 기준, gitignore)에 있다.
- PGlite는 한 데이터 디렉터리를 **한 프로세스만** 열 수 있다. 그래서 worker는 web 안에서 inline 실행한다(`WORKER_MODE=inline`, `/api/health` 호출 시 tick 1회).
- `pnpm dev`/`pnpm start`가 켜져 있는 동안 `pnpm db:seed`·`pnpm db:migrate`·`pnpm worker`는 잠금 파일(`data/pglite/.content-studio.lock`) 때문에 한국어 안내와 함께 exit 1로 거부된다. 서버를 끄고 실행한다.
- `WORKER_MODE=separate`는 `DB_DRIVER=postgres`(M3 예정, 아직 미구현)에서만 허용된다.

### 기본 모드에서 외부 쓰기 0
- LLM: `MockLlmProvider`(결정적, 네트워크 없음, 경고 `모의 응답: 실제 AI 호출 아님`). `LLM_MODE=live`는 M0에 공급자가 없어 거부된다.
- 게시: `DisabledPublisher`는 항상 예외(`PUBLISH_MODE=disabled` → PublishDisabledError, `enabled`여도 서버 승인 기능이 없어 ApprovalRequiredError). MOCK/DISABLED 결과는 발행 실적으로 저장할 수 없다.
- 수집: `DisabledCollector`는 항상 CollectorDisabledError.
- Next.js 텔레메트리는 `apps/web/scripts/next.mjs`에서 `NEXT_TELEMETRY_DISABLED=1`로 끈다(사용자 전역 설정은 변경하지 않음).
