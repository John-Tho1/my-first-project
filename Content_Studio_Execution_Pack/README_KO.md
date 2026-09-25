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

### 수집 (M1, T03)
필수 입력은 원문 하나다. 오늘 화면(`/`)의 **빠른 수집**에서 저장한다.

1. **텍스트**: `원문` 칸에 한 문장만 붙여 넣고 `서버에 저장`. `메모(왜 저장했는지)`·`제목`은 선택.
2. **URL**: `URL(선택)` 칸을 채우면 URL 수집으로 저장된다. `원문` 칸에 쓴 말은 URL 과 함께 보존된다(원문 = 입력한 URL 그대로 + 줄바꿈 + 내 말).
3. 저장이 끝나면 상세 화면(`/captures/{id}`)으로 이동하고 `서버에 저장됨 ✓ (YYYY-MM-DD HH:mm MSK)` 이 보인다. 이 표시는 **서버가 저장을 확인한 뒤에만** 나온다(A19). 기기 임시 저장(오프라인)은 아직 없으므로, 저장 버튼을 누르기 전 내용은 서버에 없다.
4. 소재함(`/captures`)은 최근 순 목록(원문 앞 120자·수집일(MSK)·유형·출처 URL·위험·중복 표시)이며 `더 보기` 로 다음 페이지를 연다.

- **원문은 수정할 수 없다.** 상세 화면에서 바꿀 수 있는 것은 메모·제목·위험 표시뿐이고, 저장할 때마다 `수정 이력`에 한 줄씩 남는다.
- **수정 충돌**: 두 탭에서 같은 소재를 고치면 늦게 저장한 쪽은 저장되지 않고 `현재 서버 내용 | 내가 입력한 내용` 비교표가 나온다. 내 입력은 폼에 그대로 남아 있으니 비교 후 다시 저장한다(API 는 `If-Match: "<revision>"` 또는 `expected_revision`, 충돌 시 409 + `current`/`yours`).
- **같은 제출 두 번**(더블클릭·새로고침 재전송)은 폼마다 붙는 `command_key` 로 한 건만 저장된다.
- **중복 후보**: `정확 중복`은 정규화 URL 이 같거나(추적 파라미터 `utm_*`·`fbclid`·`gclid`, `#…`, 끝 `/`, 대소문자 차이 무시) 원문이 같은(공백·유니코드 정규화 후) 소재다. `유사 (xx%)`는 한국어 음절 2글자 조각이 45% 이상 겹치는 소재다(결정 D4). 둘 다 **제안일 뿐** 자동으로 합치거나 지우지 않는다.
- **원문 추출은 M5 전까지 막혀 있다.** URL 소재의 `원문 추출 요청`은 외부 사이트에 접속하지 않고 차단 기록만 남긴다(`수집 기능이 비활성 상태입니다(M5에서 활성화)`).
- **내부 주소는 추출 대상이 될 수 없다**(A05): `localhost`, `*.local`/`*.internal`, `127.0.0.1`·`10.x`·`192.168.x` 같은 사설/루프백 IP, `169.254.169.254` 같은 클라우드 메타데이터 주소 등은 `내부망·로컬 주소는 추출할 수 없습니다` 로 거부된다. 서버가 내 PC·사내망에 대신 접속하는 통로(SSRF)가 되지 않게 하기 위해서다. 이런 URL 도 메모와 함께 **저장은 된다**.

| API | 설명 |
| --- | --- |
| `POST /api/captures` | `{input_type:'text'\|'url', raw_text?, url?, user_note?, title?, command_key}` → 201 `{capture, created:true, duplicates:{exact,similar}}`, 같은 `command_key` 재요청은 200 `created:false` |
| `GET /api/captures?cursor=&limit=` | 최근 순 목록(최대 50), `next_cursor` |
| `GET /api/captures/{id}` | capture·source·중복 후보·수정 이력(ETag = revision). 다른 사용자 ID 는 404 |
| `PATCH /api/captures/{id}` | 메모·제목·위험만. `raw_text` 를 보내면 400 `raw_text_immutable`, 오래된 revision 은 409 |
| `POST /api/captures/{id}/extract` | 내부 주소 400 `url_not_allowed`, 기본 모드 403 `collector_disabled`. 어떤 경우에도 외부 접속 없음 |

### 카드·원고·검색 (M1, T04)
상단 메뉴: `오늘 · 소재함 · 카드 · 아카이브 · 검색`.

1. **소재 → 카드**: 소재 상세(`/captures/{id}`)의 `발전시키기`에서 카드 문구(원문 앞 100자가 채워져 있음)를 고치고 `카드로 발전`. 카드(`/ideas/{id}`)는 **Idea(핵심 아이디어) / Audience(독자) / Evidence(근거) / Risk(위험) / Next Decision(다음 결정)** 과 태그를 담고, 연결된 소재는 `원문(수집)`에 링크로 남는다. AI 제안은 없다(M2).
2. **원고 시작**: 소재 상세나 카드에서 `원고 시작`. 소재에서 시작하면 원문이 `> 원문:` 인용 블록으로 들어간 초안(버전 1)이, 카드에서 시작하면 카드 항목을 인용한 초안이 만들어지고 소재가 원고의 `원문(수집)`으로 연결된다. 원문 자체는 바뀌지 않는다.
3. **작성실**(`/contents/{id}`): 본문을 고쳐 `새 버전으로 저장`하면 이전 버전은 그대로 두고 버전이 하나 늘어난다(버전은 DB 에서도 수정·삭제 불가). 버전 목록에서 각 버전을 읽기 전용으로 열고 `이전과 비교`로 줄 단위 차이(+ 추가 / − 삭제)를 본다.
4. **본문 충돌**: 두 탭에서 같은 원고를 고치면 늦게 저장한 쪽은 저장되지 않고 **현재 서버 본문과 내 본문을 둘 다 전부 보여 주는 비교 화면**(차이 표시 포함)이 나온다. 내 본문은 그 화면의 폼에 그대로 있으니 확인 후 `내 본문으로 새 버전 저장`을 누른다(A02).
5. **원고 정보**: 제목·연재·독자·태그·상태. 상태는 `초안 → 검토 중 → 준비됨 → 보관`이며 한 단계씩 되돌릴 수 있다(보관 → 초안 가능). 건너뛰기(예: 초안 → 준비됨)는 거부된다. "게시됨" 상태는 없다 — 실제 배포 여부는 채널·버전별로 M3 배포함에서 따로 기록한다.
6. **아카이브**(`/contents`): 최근 수정 순, 연재·태그·상태 필터. 오늘 화면의 `이어 쓸 초안`은 가장 최근에 고친 초안/검토 중 원고 1건을 보여 준다.
7. **검색**(`/search`): 소재(원문·메모·제목)·원고(제목·현재 버전 본문)·카드(아이디어·근거·다음 결정)를 **글자 그대로** 찾는다. 한국어는 형태소 분석 없이 부분 문자열로 찾으므로 `주재원`은 “주재원으로”도, `재고 리스`는 “재고 리스크”도 찾는다. 영문은 대소문자를 구분하지 않는다. 공백으로 나눈 여러 단어는 모두 들어 있는 항목만 나온다. 연재·상태 필터는 원고에만, 위험 필터는 소재·카드에만 적용된다(결정 D5). 날짜 필터는 MSK 기준.

| API | 설명 |
| --- | --- |
| `POST /api/ideas` · `GET /api/ideas?cursor=&limit=` | 카드 생성 `{idea, audience?, evidence?, risk?, next_question?, next_decision?, tags?, capture_ids?}` → 201 · 목록 |
| `GET/PATCH /api/ideas/{id}` | 카드 + 연결 소재 + 파생 원고(ETag = revision). PATCH 는 `If-Match` 또는 `expected_revision`, 오래되면 409 `current`/`yours` |
| `POST /api/captures/{id}/ideas` | 소재가 연결된 카드 생성 → 201 |
| `POST /api/captures/{id}/contents` · `POST /api/ideas/{id}/contents` | 소재/카드에서 원고 시작 → 201 `{content, version, capture_ids}` |
| `POST /api/contents` · `GET /api/contents?series=&tag=&lifecycle=&cursor=` | 원고 생성(버전 1) · 아카이브 목록 |
| `GET /api/contents/{id}` | 원고 + 현재 본문 + 버전 목록(바이트 길이) + 원문(수집) + 카드 (ETag = 정보 revision) |
| `PATCH /api/contents/{id}` | 제목·연재·독자·태그·상태만(본문은 400). 잘못된 전이 400 `invalid_transition`, 오래된 revision 409 |
| `POST /api/contents/{id}/versions` | `{base_version, body, note?}` → 201 새 버전. `base_version` 이 현재가 아니면 409 `{current:{version, body}, yours:{base_version, body}}` |
| `GET /api/contents/{id}/versions/{n}` · `GET /api/contents/{id}/diff?from=&to=` | 버전 본문(불변) · 줄 단위 diff `{stats, lines:[{type, text}]}` |
| `GET /api/search?q=&type=&series=&tag=&risk=&lifecycle=&from=&to=&cursor=&limit=` | `type=all` 은 종류별 첫 `limit` 건 + `more`/`next_cursors`, `type=captures\|contents\|ideas` 는 `next_cursor` 로 이어 보기 |

- 다른 사용자의 카드·원고·소재 ID 는 모두 404 이며, 다른 사용자의 소재를 카드·원고에 연결하는 것은 DB 복합 FK 로도 막힌다(A01).
- 같은 폼을 두 번 제출하면 카드·원고가 두 개 생길 수 있다(수집과 달리 `command_key` 없음).

### 내보내기·복원 (M1, T05)
상단 메뉴 `설정`(`/settings`). 결정 D6(docs/DECISIONS.md).

1. **내보내기**: `지금 내보내기` → `data/exports/<export_id>/`(풀어 둔 파일)와 `data/exports/<export_id>.zip` 이 만들어지고 화면에 `내보내기 파일 생성됨 (sha256 …)` 이 표시된다. 목록에서 MSK 시각·크기·건수를 보고 `다운로드`(파일명 `content-studio-export-<yyyymmdd-hhmm>-msk.zip`).
   - 들어 있는 것: `manifest.json`(모든 파일 크기·sha256, 표별 행 수·sha256, 파일 목록, 적용된 migration), `data/<표>.json`(소재·수정 이력·출처·카드·원고·**모든 원고 버전 본문**·원문 관계·파일 메타데이터·감사 기록), `markdown/`(사람이 읽는 사본 — 소재 원문 그대로, 원고 버전 이력), `assets/`(파일 바이트), `README.md`.
   - 들어 있지 않은 것: 로그인 세션·토큰·OAuth/API key(표 `sessions`, 그리고 운영 기록 `export_runs`·`restore_runs` 는 제외 목록에 있고 단위 테스트가 schema 와 대조한다). 허용 식별자는 `ow***@example.local` 처럼 가린 형태만.
   - 묶음은 **암호화되지 않은 개인 데이터**다. 보관 위치는 직접 정한다. `data/` 는 gitignore 대상.
2. **복원 미리보기**: ZIP(최대 256MB)을 올리거나 목록의 `이 파일로 복원 미리보기`. **이 단계에서는 DB 가 바뀌지 않는다.** 모든 파일의 sha256 을 manifest 와 대조(하나라도 다르면 `manifest_mismatch` 와 문제 경로를 보여 주고 끝), 형식 버전·DB migration 호환·행 형식·묶음 안 ID 참조를 검사한 뒤, 표별 `새로 추가 / 동일 / 충돌` 건수와 파일 checksum 확인 결과를 보여 준다.
3. **복원**: 방식 선택 + `내용을 확인했습니다` 체크 → `복원`. 결과 화면은 `복원 완료: 표별 건수`.
   - `빈 환경에만 복원`(기본): 이 계정에 소재·카드·원고·파일·출처가 하나도 없고 충돌이 0일 때만. 아니면 409.
   - `없는 항목만 추가`: 없는 ID 만 넣고, 같은 행은 건너뛰고, **내용이 다른 기존 행은 덮어쓰지 않고 충돌로 보고**한다.
   - 모든 항목의 소유자는 복원하는 계정으로 바뀌고 **ID 는 그대로** 유지된다(원고↔버전↔소재 관계 보존). 파일은 원래 저장 key 그대로 저장소에 쓰고 sha256 을 다시 확인한다.
   - 커밋은 미리보기를 믿지 않고 올려 둔 ZIP(`data/restores/<restore_id>.zip`)을 다시 검증한다. 같은 미리보기는 한 번만 커밋된다(두 번째는 409).

CLI(dev 서버를 끈 상태에서 — PGlite 단일 연결):
```bash
pnpm export                                    # AUTH_ALLOWED_IDENTITY 의 데이터 → data/exports/<id>.zip (JSON 출력: export_id, zip, totals, 표 sha256)
pnpm restore:preview data/exports/<id>.zip     # 미리보기(DB 변경 없음, restore_runs 에 기록)
pnpm restore:commit data/exports/<id>.zip --mode empty_only --confirm    # --confirm 없으면 거부(exit 2)
pnpm restore:commit data/exports/<id>.zip --mode add_missing --confirm
```

**M1 게이트**(10개 가상 소재 입력→검색→원고 수정→export→빈 DB 복원 후 ID 관계·본문·checksum 일치, A18):
```bash
pnpm exec vitest run --project integration tests/integration/export-restore.test.ts
```
CLI 로 직접 확인하려면 버리는 DB 두 개로:
```bash
DATABASE_URL=./data/pglite-t05 pnpm db:seed
DATABASE_URL=./data/pglite-t05 pnpm export                               # zip 경로 확인
DATABASE_URL=./data/pglite-t05-restore pnpm db:migrate
DATABASE_URL=./data/pglite-t05-restore pnpm restore:preview <zip>
DATABASE_URL=./data/pglite-t05-restore pnpm restore:commit <zip> --mode empty_only --confirm
DATABASE_URL=./data/pglite-t05-restore pnpm export                       # 두 manifest 의 tables.*.sha256 비교(users·audit_events 제외 모두 같아야 함)
```

| API | 설명 |
| --- | --- |
| `POST /api/exports` · `GET /api/exports` | 내보내기 생성 → 201 `{export_id, zip_bytes, manifest_sha256, totals, tables, warnings, download_url}` · 최근 20건 |
| `GET /api/exports/{id}` | ZIP 스트림(`application/zip`, attachment, no-store). 다른 사용자·없는 ID → 404 |
| `POST /api/restores/preview` | multipart `file` 또는 `application/zip` 본문(≤256MB, 임시 파일로 받은 뒤 검사), 또는 JSON `{export_id}` → 200 `{restore_id, preview}`. 검증 실패 → 400 `manifest_mismatch`·`invalid_zip`·`schema_incompatible` 등 + 문제 경로 |
| `GET /api/restores/{id}` | 미리보기·결과 |
| `POST /api/restores/{id}/commit` | `{mode: "empty_only"\|"add_missing", confirm: true}` → 200 `{restored, skipped_identical, conflicts, assets_written, assets_verified}`. confirm 없음 400, 비어 있지 않음 409 `restore_target_not_empty`, 두 번째 409 `already_committed` |

- 이 화면·API 는 "안전"·"백업 완료"라고 표시하지 않는다. 복원이 되는지는 실제 복원(미리보기 → 커밋) 결과로만 판단한다(docs/07).
- 경로는 `EXPORT_LOCAL_DIR`(기본 `./data/exports`)·`RESTORE_LOCAL_DIR`(기본 `./data/restores`)로 바꿀 수 있다.

### 작성 지원 — Brand Profile·인터뷰·모의 AI (M2, T06)
결정 D7(모의 AI 만)·D12(docs/DECISIONS.md). **외부 AI 호출 없음** — `LLM_MODE=mock`(기본)에서 결정적 모의 응답만 쓰고, 모든 모의 출력에 `모의 응답: 실제 AI 호출 아님` 이 보인다.

1. **Brand Profile**(상단 메뉴 `브랜드`, 또는 `설정` → `/brand`): 필명·독자·연재 축·말투(존댓말/평어)·문체 원칙·피할 표현·CTA 원칙·직접 쓴 예문. 저장할 때마다 **새 버전**이 추가되고 이전 버전은 바뀌지 않는다(seed 는 v1). 회사 문서·다른 프로젝트 메모리 자동 가져오기는 없다.
2. **인터뷰 질문 3개**(작성실 `/contents/{id}`): 상황 / 판단 / 독자에게 남길 한 가지. 답변은 직접 쓰고, 다시 답하면 새 행이 추가된다(질문별 최신이 현재). AI 는 답변을 채우지 않는다.
3. **AI 작성 보조**(작성실): 모드 개요/초안/다듬기 → 입력(현재 본문 버전·Brand Profile 버전·답변 ID)을 고정해 실행 기록(`generation_runs`)을 남기고, 제안을 **현재가 아닌 버전**(`AI 제안(모의)`)으로 저장한다. 본문은 바뀌지 않는다. 화면에서 현재 본문 ↔ 제안 diff, `제안 채택`(새 사용자 버전) 또는 `무시`. 실패해도 본문은 그대로이고 실행 기록은 `실패`.
4. **A03**: 채택한 제안에 1인칭 경험 주장(모의는 "저는/제가…" 문장)이 있으면, 작성실에서 `내 경험이 맞음(확인)` 또는 (문장을 본문에서 뺀 뒤) `본문에서 뺐음(제외)` 을 누르기 전에는 상태를 `준비됨` 으로 바꿀 수 없다(서버 409).
5. **프롬프트 복사용 보기**(작성실 `<details>`): 모의·실제 AI 가 받을 프롬프트 원문(읽기 전용). 다른 AI 결과를 붙여 넣어 가져오는 기능은 아직 없다(T06 범위 밖).

| API | 설명 |
| --- | --- |
| `GET /api/brand` · `POST /api/brand` | `{current, versions}` · 새 버전 `{base_version, pen_name, audience, pillars[], style_rules[], tone, avoid_phrases[], cta_rules[], sample_texts[]}` → 201, base_version 이 현재가 아니면 409 |
| `GET`·`POST /api/contents/{id}/answers` | `{questions, current, history}` · `{answers:{situation?, judgment?, takeaway?}}` → 201 `{inserted, current}` |
| `POST /api/contents/{id}/assist` | `{mode, base_version, brand_profile_version, answer_ids[]}` → 201 `{run, proposal_version, diff, claims, followup_questions, warnings, mock_warning}`. 현재가 아닌 base → 409 `stale_base`, 실패 → 502 `llm_failed`, `LLM_MODE=live` → 503(fail-closed, 실행 기록 없음) |
| `POST /api/contents/{id}/assist/{run_id}/adopt` | `{base_version}` → 201 새 사용자 버전(현재). 제안의 기준 버전이 현재가 아니면 409 `stale_base` |
| `POST /api/contents/{id}/claims/confirm` | `{run_id, claim_indexes[], resolution?: "confirmed"|"removed"}` → 200 `{confirmed, unconfirmed}`. `removed` = 그 문장을 본문에서 뺐다는 표시 — 현재 본문에 문장(공백·문장부호 무시)이 남아 있으면 409 `claim_still_in_body`, 나중에 다시 넣으면 다시 미해결 |

- 다른 사용자의 원고·실행 기록·답변은 404. 새 표(`interview_answers`·`generation_runs`·`claim_confirmations`)와 Brand Profile 새 열은 내보내기·복원에 포함된다(M1 묶음은 새 표를 빈 표로 읽는다).
- migration `0005_t06_writing`·`0006_t06_claim_resolution`·`0007_t06_removed_binding` 은 다음 `pnpm dev`/`pnpm db:migrate` 때 기존 DB 에 적용된다(기존 Brand Profile 행은 말투=존댓말, 나머지 빈 목록).

### 근거·비용·live 경계 (M2, T07 — 모의 경계까지)
결정 D13(docs/DECISIONS.md). **외부 호출·과금·비밀 0.** 실제 AI 호출은 사용자의 별도 승인 뒤에만 연결한다(D7·D8).

- **허용 출처**: 작성실의 AI 작성 보조는 이 원고에 연결된 소재의 출처(source_version)만 근거로 넘긴다(`source_version_ids`, 그 밖이면 404). 입력 버전(`generation_runs.input_version_refs`)에 함께 고정된다.
- **claim–근거**: 제안의 주장마다 `claims` 행(불변)과 허용 출처 연결 `claim_sources`(locator)가 남는다. AI 가 목록 밖 출처(만든 URL 등)를 내면 저장하지 않고 "출처 미확인"·확인 필요로만 표시한다. 경험 주장을 사용자가 확인하면 근거 등급이 "사용자 확인"으로 보인다(파생).
- **비용 예약(A15)**: 호출 전 `usage_ledger` 에 예약(프롬프트 글자/3 토큰 추정 × 단가 + 출력 여유분), 호출 후 실제 사용량으로 확정. 이번 달(MSK) 합계 + 예약이 `LLM_BUDGET_MONTHLY_LIMIT` 또는 1회 예약이 `LLM_BUDGET_PER_RUN_MAX` 를 넘으면 429 `budget_exceeded`(아무것도 기록하지 않음). 실패한 호출은 예약액 전체를 비용으로 확정. 가격(`LLM_PRICE_*`)이 비어 있으면 모의는 0 으로 기록만, live 는 차단.
- **live 경계**: `LLM_MODE=live` 는 공급자·모델·가격·월 상한·승인 기록(`LLM_LIVE_APPROVAL_REF`)이 모두 있어도 T07 에는 어댑터가 없어 503 으로 거부된다(아무것도 기록하지 않음). `GET /api/health` 의 `llm.live_ready`(항상 false)와 `llm.missing`(빠진 조건 이름만), 설정 화면의 "AI 모드·비용"(이번 달 사용액/상한, live 준비 안 됨 목록)으로 확인한다.
- migration `0008_t07_budget_claims`(claims·claim_sources·usage_ledger). 새 표는 내보내기·복원에 포함된다.

### 채널 초안·배포 파일 (M2, T09)
결정 D14(docs/DECISIONS.md). **게시하지 않는다**(PUBLISH_MODE=disabled, 채널 어댑터·OAuth 없음). 작성실 `/contents/{id}` 의 "채널 초안" 영역.

- **초안 만들기**: Threads·Instagram·YouTube·블로그마다 원고 현재 버전을 채널 모양으로 바꾼 초안(결정적). "AI 초안(모의)"은 채택하기 전까지 현재 초안이 아니다(예산 원장·claim 저장은 T07 규칙). 편집은 본문 + 채널 형식(JSON), 첨부는 올린 파일 중에서 역할(이미지·영상·썸네일·첨부)을 골라 붙인다.
- **stale**: 원고가 바뀌면 "원문이 바뀜 — 재검토 필요". 저장 값이 아니라 파생 판정이며, 수정만으로는 풀리지 않는다 — "현재 원문으로 다시 초안". AI 가 자동으로 다시 만들지 않는다.
- **검토로**: stale 이 아니고, 채널 필수 미디어(Instagram 이미지 1개 이상, YouTube 완성 영상 1개)가 있고, 미해결 1인칭 경험 주장이 없을 때만. 완성 영상은 T08 업로드 세션으로 올려 첨부할 수 있다(D15).
- **배포 파일 만들기**: 채널별 현재 초안의 본문·메타데이터·첨부 파일(sha256 확인)·manifest 를 ZIP 으로 — "배포 파일(수동 게시용). 자동 게시 아님". 승인·게시 기록이 아니다. 위치 `EXPORT_LOCAL_DIR/packages/<owner>/<id>.zip`.

| API | 설명 |
| --- | --- |
| `GET`·`POST /api/contents/{id}/variants` | 파생본 목록 · `{channel, mode: draft\|ai_draft, base_version(원고 현재 버전)}` → 201, 원고 버전 불일치 409 `stale_base` |
| `POST /api/variants/{id}/versions` | `{base_version, body, metadata}` → 201 새 현재 버전(draft), 오래된 base 409, 채널 형식 위반 400 `invalid_metadata` |
| `POST /api/variants/{id}/adopt/{versionId}` | AI 초안 채택 `{base_version}` → 201 |
| `POST /api/variants/{id}/assets` | `{base_version, assets:[{asset_id, position, role}]}` → 201, 다른 사용자 파일 404, 역할·형식 불일치 400 |
| `POST /api/variants/{id}/lifecycle` | `{lifecycle: draft\|review, base_version}` → 200, `stale_variant`·`media_incomplete`·`unconfirmed_experience_claims` 409 |
| `POST /api/contents/{id}/package` · `GET /api/packages/{id}` | 배포 파일 ZIP 생성 → 201 · 내려받기(다른 사용자·없는 ID 404) |

- migration `0009_t09_variants`(variants·variant_versions·variant_assets, generation_runs.variant_id, claims.variant_version_id). 새 표는 내보내기·복원에 포함된다.

### 음성 전사·큰 파일 업로드 (M2, T08 — 모의 전사)
결정 D9·D15(docs/DECISIONS.md). **외부 호출·과금·비밀 0.** 전사는 모의(`STT_MODE=mock`, 파일 checksum 으로 정해지는 자리표시 문장 — 실제 음성 인식 아님). 화면 `/record`(상단 "음성").

- **업로드 세션(A14)**: 음성(MP3·M4A·WAV·WebM, 최대 200MB)·영상(MP4·WebM·MOV, 최대 2GB)을 4–8MiB 조각(기본 8MiB)으로 올린다. 끊기면 같은 세션을 `GET` 해 받은 위치(`next_index`)부터 이어 올린다. 화면은 먼저 파일 전체 sha256 을 계산해 세션에 신고하고(`sha256`), 이어 올릴 때는 신고 sha256·크기·이미 받은 조각별 sha256(`GET` 의 `chunks`)이 이 파일과 모두 같을 때만 재사용한다(다르면 새 세션). 같은 조각 재전송은 그대로(200), 다른 내용이면 409. 세션은 24시간 뒤 만료되고 worker 가 조각을 지운다.
- **완료 검사**: 서버가 조각을 이어 붙이며(메모리에 전체를 올리지 않음) 크기·앞부분 형식 서명·sha256 을 확인한다. 통과하면 asset `VERIFIED`(`verification_scope=signature_size_checksum` — 재생 가능 여부·디코딩은 확인하지 않음). 실패하면 세션 rejected + 조각 삭제(415 형식, 400 크기·checksum).
- **전사 job**: `queued → running(25·50·75) → succeeded(100)`. inline worker 가 tick 마다 한 단계(`/api/health`·전사 목록 조회 때). 비용은 T07 원장·통화·상한을 같이 쓴다(1분 가격 `STT_PRICE_PER_MINUTE`, 길이 = `duration_seconds` 또는 bytes/16000초, 가격이 비면 0 으로 기록). 실패는 예약액 확정, 시작 전 취소는 예약 해제(0), 처리 중 취소는 예약액 확정.
- **전사 본문**: 버전 불변. 수정은 새 버전(`base_version` 이 최신이 아니면 409). "이 버전을 소재로 보내기" → 소재(원문 = 전사 본문, 메모 "음성 전사(모의)").
- **원음 보존**(기본 켬): 끄면 전사 성공 뒤 원본 파일을 지우고 `assets.deleted_at` 을 남긴다(다운로드 410, 채널 초안에 첨부된 파일은 지우지 않음). 내보내기에는 메타데이터만(`asset_deleted` 경고).
- **live 경계**: `STT_MODE=live` 는 공급자·모델·가격·월 상한·승인 기록(`STT_LIVE_APPROVAL_REF`)이 모두 있어도 T08 에는 어댑터가 없어 503(아무것도 기록하지 않음). `GET /api/health` 의 `stt`(모드·`live_ready:false`·빠진 조건 이름)와 `uploads`(임시 영역 세션 폴더·파일 수·바이트), 설정 화면 "AI 모드·비용"에서 확인.
- **브라우저 녹음**: `/record` 는 `MediaRecorder` 지원 여부만 알려 준다(미지원 → "이 기기에서는 브라우저 녹음을 지원하지 않습니다 → 파일 업로드"). 녹음 기능은 기기 확인 뒤 추가(docs/01).

| API | 설명 |
| --- | --- |
| `POST /api/uploads/sessions` | `{kind: audio\|video, mime, bytes, sha256?, chunk_size?}` → 201(`chunk_size`·`chunk_count`·`expires_at`), 형식 415, 한도 413 |
| `GET`·`DELETE /api/uploads/sessions/{id}` | 진행 상태(`received_bytes`·`next_index`·`missing_indexes`·`progress`) · 중단(open 만) |
| `PUT /api/uploads/sessions/{id}/chunks/{index}` | 조각 바이트(선택 `x-chunk-sha256`) → 새 조각 201 · 같은 내용 200 · 다른 내용 409 `chunk_mismatch` |
| `POST /api/uploads/sessions/{id}/complete` | 검사 → 200 `{asset(VERIFIED), session}` · 조각 부족 409 `upload_incomplete` · 거부 415/400 `upload_rejected` |
| `POST /api/assets/{id}/transcribe` | `{duration_seconds?, keep_original?}` → 202 job · 음성·영상 아님 415 · 진행 중 409 · 원본 삭제됨 410 · 예산 429 · live 503 |
| `GET /api/transcription-jobs?asset_id=` · `GET /api/transcription-jobs/{id}` | 목록(inline tick 1회 후) · 한 작업(버전 목록·최신 본문·`mock_warning`) |
| `POST /api/transcription-jobs/{id}/cancel` | queued·running → canceled, 끝난 작업 409 |
| `GET /api/transcripts/{id}` · `POST /api/transcripts/{id}/versions` | 전사 버전 · `{base_version, text}` → 201 새 버전, 오래된 base 409 `stale_transcript` |
| `POST /api/transcripts/{id}/to-capture` | 소재 저장 → 201(같은 버전 재요청 200) |

- 다른 사용자의 세션·조각·파일·작업·전사는 모든 경로에서 404. 조각 파일 위치 `STORAGE_LOCAL_DIR/uploads/<owner>/<session>/<index>`(UUID·정수만으로 경로를 만듦).
- migration `0012_t08_uploads_transcription`(upload_sessions·upload_chunks·transcription_jobs·transcripts, assets.verification_scope·deleted_at, captures.capture_transcript_id, usage_ledger.transcription_job_id·audio_seconds — run_id 와 둘 중 하나). 업로드 세션·조각은 내보내기에서 **제외**(전송 중 임시 상태), 전사 job·버전은 **포함**. 복원 시 진행 중이던 job 은 canceled 로 넣고 예약 원장은 예약액으로 확정한다.

### 배포 계획·승인·실행 (M3, T10)
결정 D17(docs/DECISIONS.md). **MOCK 만 — 실제 게시는 하지 않는다.** 배포 계정은 seed 가 만드는 플랫폼별 모의 계정(`MOCK Threads 계정` 등, `external_account_id` 는 `mock:` 접두어)뿐이고, OAuth·인증 비밀·채널 어댑터는 없다(M4). "MOCK" 은 "이 앱 안에서만 기록하고 외부로 아무것도 보내지 않는다"는 뜻이며 모의 결과는 발행 실적이 아니다. 화면: 상단 "배포함"(`/distribute`).

- **계획 만들기**: 작성실 채널 초안이 "검토 중"이면 "배포 계획 만들기" → 채널 초안 × 그 플랫폼의 모의 계정, 공개 범위, 선택 예약(모스크바 날짜·시각 → 서버가 UTC 로 저장, 지금 + 1분 이하·과거는 400 `schedule_in_past`). 기본 선택 없음. 검토 중이 아닌 초안·stale·미디어 부족·미해결 경험 주장·채널과 계정 플랫폼 불일치는 거부된다.
- **불변 스냅샷**: 항목마다 "정확히 나갈 내용"(원고·파생본·브랜드 버전, 계정·외부 계정 ID, 채널별 글, 첨부 ID·checksum·순서, 공개 범위, 예약 UTC·시간대)을 canonical JSON 으로 만들고 SHA-256 hash 를 저장한다. 항목의 스냅샷은 DB 트리거로 바꾸거나 지울 수 없다.
- **승인**: 계획 화면에서 항목 카드(계정 `MOCK` 배지·채널별 글·미디어 checksum 앞 12자·공개 범위·`MSK (UTC)` 또는 `즉시`·hash)를 확인하고, 항목을 직접 체크 + "내용을 확인했습니다" → "선택 승인". 서버는 화면의 hash 와 저장된 hash, 그리고 지금의 실제 행(파생본 현재 버전·원고 현재 버전·첨부·계정 상태·예약 시각)을 다시 대조한다. 클라이언트·AI 가 보낸 `approved` 같은 값은 무시된다(승인이 아님). 승인되면 채널 초안은 "승인됨".
- **승인 무효(A06)**: 승인 뒤 채널 초안 수정·AI 채택·다시 초안·첨부 변경·원고 수정·계정 상태 변경은 같은 트랜잭션에서 그 항목의 승인을 철회한다(`invalidated:body_changed|assets_changed|content_changed|account_changed`). 실행할 때도 다시 검사해 어긋나면 전체를 거부하고 승인을 철회한다. 바뀐 내용을 배포하려면 새 계획을 만든다.
- **실행(MOCK)**: "지금 실행"은 승인된 항목을 작업 대기열(`jobs`, `QUEUED`)에 넣기까지만 한다 — 결과는 항상 `MOCK`, 처리(lease·재시도·확인)는 **T11 작업 처리기**가 맡는다(아직 없음 → 작업은 `QUEUED · MOCK · T11에서 처리` 로 남는다). 버튼을 두 번 눌러도 작업은 하나(같은 `command_key` 재호출은 저장된 결과, 다른 key 는 409 `already_executed`). 승인 없음 403 `approval_required`(아무것도 넣지 않음).
- **철회**: 승인 기록의 "철회" → 대기 중(QUEUED) 작업은 `BLOCKED`(작업 이력 기록), 항목은 실행 전 상태로, 채널 초안은 "검토 중"으로. 같은 계획에서 다시 승인할 수 있다(새 승인 → 새 작업 key).

| API | 설명 |
| --- | --- |
| `GET /api/channel-accounts` | 배포 계정(모의만, 비밀 없음) |
| `GET`·`POST /api/distribution-plans` | 계획 목록(cursor) · `{items:[{variant_id, channel_account_id, requested_result?, visibility?, schedule?:{date,time}}], target_summary?}` → 201(항목 payload·hash) |
| `GET /api/distribution-plans/{id}` | 계획·항목(payload·hash·계정·활성 승인·작업·지금 검사한 문제) |
| `POST /api/distribution-plans/{id}/approve` | `{item_ids, expected_hashes:{id: sha256}, confirm: true, purpose}` → 200, confirm 없음 400, hash 불일치 409 `hash_mismatch`, 스냅샷 변경 409 `snapshot_stale` |
| `POST /api/distribution-plans/{id}/execute` | `{command_key(8~64), item_ids?}` → 200 `{queued:[{item_id, job_id, mode:'MOCK'}], mode:'MOCK', notice, idempotent_replay}` |
| `POST /api/approvals/{id}/revoke` | `{reason?}` → 200, 이미 철회 409 |

- migration `0016_t10_distribution`(channel_accounts·distribution_plans·distribution_items·approvals·jobs·job_events·execute_commands, variants.lifecycle 에 `approved`). 내보내기에는 모두 들어가고, 복원은 계정·계획·항목·승인만(hash 그대로). 작업·작업 이력·실행 명령은 복원하지 않는다 — 진행 중이던 항목은 `BLOCKED` 로, 복원된 행과 스냅샷이 맞지 않는 활성 승인은 `restore_stale` 로 철회해 넣는다.

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
| `pnpm worker` | worker tick 1회(T08: 만료된 업로드 세션 정리만 — 전사는 web inline worker) 후 종료 | exit 0, JSON 출력 |
| `pnpm export` · `pnpm restore:preview <zip>` · `pnpm restore:commit <zip> --mode … --confirm` | 내보내기 / 복원 미리보기 / 복원(T05) | exit 0, JSON 출력 |

### PGlite 단일 연결 주의
- 개발 DB는 PGlite(PostgreSQL WASM)이며 데이터는 `./data/pglite`(워크스페이스 루트 기준, gitignore)에 있다.
- PGlite는 한 데이터 디렉터리를 **한 프로세스만** 열 수 있다. 그래서 worker는 web 안에서 inline 실행한다(`WORKER_MODE=inline`, `/api/health` 호출 시 tick 1회).
- `pnpm dev`/`pnpm start`가 켜져 있는 동안 `pnpm db:seed`·`pnpm db:migrate`·`pnpm worker`는 잠금 파일(`data/pglite/.content-studio.lock`) 때문에 한국어 안내와 함께 exit 1로 거부된다. 서버를 끄고 실행한다.
- `WORKER_MODE=separate`는 `DB_DRIVER=postgres`(M3 예정, 아직 미구현)에서만 허용된다.

### 기본 모드에서 외부 쓰기 0
- LLM: `MockLlmProvider`(결정적, 네트워크 없음, 경고 `모의 응답: 실제 AI 호출 아님`). `LLM_MODE=live`는 M0에 공급자가 없어 거부된다.
- 게시: `DisabledPublisher`는 항상 예외(`PUBLISH_MODE=disabled` → PublishDisabledError, `enabled`여도 서버 승인 객체가 없어 ApprovalRequiredError). MOCK/DISABLED 결과는 발행 실적으로 저장할 수 없다.
- 배포 실행(T10): 모의 계정은 `PUBLISH_MODE` 와 무관하게 `MOCK` 작업(QUEUED)만 만든다. 실제 계정은 `PUBLISH_MODE=enabled` + 서버 승인이 있어도 어댑터가 없어 503(`LiveChannelNotConfiguredError`).
- 수집: `DisabledCollector`는 항상 CollectorDisabledError.
- 음성 전사(T08): `MockTranscriber`(결정적, 네트워크 없음, 경고 `모의 전사: 실제 음성 인식 결과가 아닙니다(자리표시 문장)`). `STT_MODE=live`는 어댑터가 없어 거부된다.
- Next.js 텔레메트리는 `apps/web/scripts/next.mjs`에서 `NEXT_TELEMETRY_DISABLED=1`로 끈다(사용자 전역 설정은 변경하지 않음).
