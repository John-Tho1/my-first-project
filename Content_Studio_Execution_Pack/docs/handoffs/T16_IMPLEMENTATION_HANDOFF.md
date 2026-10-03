# Implementation handoff — T16
- Task ID / milestone: T16 / M4 ("Instagram 계정·공식 규격 재확인 후 media adapter" — **모의 어댑터만**, 공식 규격은 재확인하지 못했으므로 모든 숫자·scope 이름은 잠정)
- Purpose and changed behavior: Meta 형 모의 OAuth 로 연결한 Instagram 계정의 배포 항목을, VERIFIED 이미지(1장) 또는 캐러셀(2~10장)로 Instagram 형 2단계(미디어 컨테이너 → media_publish)로 보낸다. 이미지는 `PublicMediaUrlProvider` 의 **모의 구현**(`mock://public-media/<불투명 값>`, 실제 호스팅 없음)으로만 모의 원격에 전달되고 컨테이너 생성 직후 철회된다. 승인 전(approval blocker)·보내기 직전(어댑터) 두 번 잠정 규격(JPEG·8MiB·4:5~1.91:1·가로 ≥320·캡션 2200·해시태그 30·언급 20)을 파일 헤더로 검사한다. 원격 참조는 다음 원격 호출 전에 `remote_steps`(`ig_container`·`ig_publish`)에 기록하고, 응답 유실·처리 지연은 조회로 확인해 같은 컨테이너로 이어 간다(재게시 0). 결과는 `mock_publish` → `PUBLISHED/public`(MOCK)만. 실제 Instagram/Meta 호출 0, 실계정 시험 `blocked_external`.
- BASE_SHA: 296b396
- HEAD_SHA: 620ed86 (code only, D28; orchestrator reran lint·typecheck·build·unit 792·integration 616·drill:mock 0·db:migrate 0036·real-DB drill:restore PASS)(오케스트레이터 커밋 — 이 파일은 커밋하지 않음)
- Clean tracked tree confirmed: 작업 전 yes(`?? .claude/` 만). 커밋은 오케스트레이터.
- Relevant acceptance IDs: M4 T16, A08(응답 유실 → 조회 확인, 재게시 0), A09(부분 성공 — 기존 PARTIAL 규칙 그대로), A12 의 Instagram 대응(비공개·예약 결과 없음 — 요청 결과·공개 범위를 public/PUBLISHED 로만 허용), A20(결과 불명 뒤 맹목 재전송 금지), docs/03 Instagram 행(professional 계정·권한·규격 재확인, Instagram 로그인/Facebook 로그인 조건 섞지 않음, Stories 범위 밖), 승인 스냅샷·중복·재시도 규칙, D24~D28
- External calls performed: none. 모든 시험·훈련에서 `fetch` 를 막고 0회 확인.
- Mock-only functionality: 전부. `kind='live'` 계정은 기존대로 `LiveChannelNotConfiguredError`, live OAuth 는 `LiveOAuthNotConfiguredError`.

## 변경 파일
- 신규: `packages/domain/src/instagram.ts`(+test) · `packages/providers/src/instagram-mock.ts`(+test) · `packages/providers/src/public-media.ts` · `packages/db/src/media-spec.ts` · `packages/db/drizzle/0036_t16_instagram_media.sql`(+`meta/0036_snapshot.json`, `_journal.json`) · `packages/db/scripts/drill-instagram.ts` · `apps/web/app/api/oauth/mock-instagram/authorize/route.ts` · `tests/integration/instagram.test.ts`
- 수정: domain `jobs.ts`·`oauth.ts`·`bundle.ts`·`index.ts`, db `schema.ts`·`distribution.ts`·`jobs.ts`(mediaPortFor 를 media-spec.ts 로 옮김 — 동작 그대로)·`index.ts`·`scripts/drill.ts`, providers `oauth.ts`·`channel-adapter.ts`·`index.ts`, web `lib/distribution.ts`·`lib/oauth.ts`·`distribute/[id]/page.tsx`·`distribute/new/page.tsx`·`settings/page.tsx`·`api/distribution-plans/[id]/route.ts`·`api/distribution-plans/[id]/approve/route.ts`, `README_KO.md`
- 기존 시험 수정(단언 약화 없음 — "연결 공급자가 없는 채널" 예시만 instagram → blog 로 바꿈, 같은 단언): `tests/integration/oauth.test.ts`(400 oauth_not_supported), `packages/providers/src/oauth.test.ts`(OAuthNotSupportedError), `packages/providers/src/threads-mock.test.ts`(adapterIdFor → mock_generic), `packages/domain/src/oauth.test.ts`(requiredScopesForPlatform → [] 는 blog, Instagram scope 시험 추가)
- `docs/DECISIONS.md`·`M4_CODEX_VERDICTS.md`·`M4_STATUS.md` 는 수정하지 않음(D29 는 아래 "Proposed D29").

## 설계 표 (영역 → 변경 → 시험)
| 영역 | 변경 | 시험 |
|---|---|---|
| 모의 OAuth | `MockInstagramOAuthProvider`(provider `mock_instagram`, Threads 형: code + PKCE S256 + state, 장기 토큰 `mockig_at_` 60일·refresh token 없음·만료 전 같은 토큰 갱신(이전 무효)·철회). scope 자리 표시 `instagram_basic(mock)`·`instagram_content_publish(mock)`, 댓글·메시지·통계 기본 요청 안 함. 동의 화면 `/api/oauth/mock-instagram/authorize`(운영에서 시험 매개변수 거부 — D25-3 그대로). `resolveOAuthProvider` instagram 분기. T13 저장·봉인·세대·잠금·정리 경로 변경 없음 | 단위 `instagram-mock.test.ts`(PKCE·갱신·철회·다른 공급자 토큰 거절·scope 거부), `domain/oauth.test.ts`(scope 목록·(mock) 표시). 통합: route 로 연결 → `oauth_credentials.provider = mock_instagram`·scopes·봉인 |
| 어댑터 선택 | `adapterIdFor`: 모의 + instagram + credential_state ≠ none → `mock_instagram`(seed 는 `mock_generic` 그대로). 레지스트리 4번째 인자·`getAdapterById('mock_instagram')`. 전송 의도 `adapter_id` 로 조회(T14 규칙) | 단위 선택 표, 통합(seed 계정은 M3 그대로 — 9:16 이미지도 승인됨, 기본 공개 범위 private) |
| 요청 결과·공개 범위 | createPlan: Instagram 모의 연결 계정은 `mock_publish` 만(기존 모의 규칙), 공개 범위는 **public 만**(생략 시 public, private·unlisted → 400 `instagram_visibility_public_only`). 어댑터 validate 도 `mock_only`·`instagram_visibility_public_only` 로 다시 확인. 앱 실행 예약(`schedule`)은 그대로 허용(원격 예약 아님), `publish_at` 은 기존대로 YouTube 만 | 통합 계획 규칙 시험, 단위 validate 표 |
| 잠정 규격(승인 전) | domain `instagramSpecProblems`(형식·크기·비율·가로·개수·역할·캡션·해시태그·언급) + `imageDimensions`(JPEG SOF·PNG IHDR·WebP VP8/VP8L/VP8X 헤더만). db `instagramSpecProblemsForItems` — **트랜잭션 밖**에서 헤더(≤256KiB)만 읽고 `approveItems`(opts.media)·`getPlanDetail`(opts.media)이 `media_spec:<코드>[:<순서>]` 를 문제로 합친다 → 승인 409 `snapshot_stale`, 계획 화면 problems. 창구 없으면 `media_spec:unchecked`(fail closed). `snapshotProblems`(beginSend 의 무효화 경로)에는 넣지 않았다 — 파일·스냅샷이 불변이라 규격은 승인 뒤 바뀌지 않고, 보내기 직전 검사는 어댑터가 FAILED 로 닫는다 | 단위 domain 표(경계 4:5·1.91:1 포함)·헤더 파서, 통합 9:16 → 409 + problems, PNG → mime_not_allowed, 승인·작업 0 |
| 잠정 규격(보내기 직전) | 어댑터 submit 이 원격 호출 전에 MediaPort(VERIFIED·같은 checksum)로 다시 검사 → 어긋나면 `rejected/permanent invalid_media_spec:<코드>`(FAILED, 재시도 없음, URL 발급 0) | 단위(비율 밖·파일 바뀜), 통합(규격 상수 변경 흉내 → FAILED, createImageContainer 0, 의도 1) |
| 공개 미디어 URL | domain `PublicMediaUrlProvider` 인터페이스 + providers `MockPublicMediaUrlProvider`(난수 18바이트 `mock://public-media/<opaque>`, 수명 10분, `resolve` 는 모의 원격 전용, `revoke` 멱등). 어댑터는 컨테이너 생성 직전에 발급하고 성공·실패와 관계없이 **바로 철회**. URL 은 단계·이력·감사·로그·응답·내보내기에 없음 | 단위(형식·asset ID/checksum 미포함·만료·철회·activeCount 0), 통합·drill(살아 있는 URL 0, DB·내보내기·응답·로그에 `mock://public-media/` 0) |
| 시뮬레이터 | `InstagramMockApi`: createImageContainer(공개 URL 을 resolve 해 파일을 읽고 원격 규격 재검사 → 400 `invalid_image_spec`, 받은 이미지 sha256 기록)·createCarouselContainer(자식 FINISHED·미사용·2~10)·getContainer(IN_PROGRESS→FINISHED|ERROR, EXPIRED, PUBLISHED)·publish(같은 컨테이너 두 번째 거절 — 모의 가정)·getMedia·findPublishedByContainer·게시 예산(429)·장애 주입·reset. 오류 401/403/400/404/429/5xx(side_effect)/timeout | 단위 시뮬레이터 4건 + 오류 분류 표 |
| 원격 단계 | migration **0036**: `remote_steps.kind` 에 `ig_container`(created|finished|error)·`ig_publish`(published) 추가(CHECK 2개 교체), `mock_scenarios` 에 instagram_* 9개, oauth 공급자 CHECK 에 `mock_instagram`(is_mock 포함). 트리거·`remote_id LIKE 'mock%'` CHECK 변경 없음. 순번: post_index 0 = 게시할 컨테이너(단일 이미지 또는 캐러셀 부모), 1..n = 캐러셀 자식. **Threads 의 container/publish 를 재사용하지 않고 새 종류를 둔 이유**: (1) 캐러셀 부모·자식 순번 규칙이 Threads 의 "게시물마다 컨테이너·게시 1쌍"과 다르다, (2) 요청 제한 단위(`rateStepKinds=['ig_publish']`)·화면 패널·내보내기에서 단계 종류만으로 플랫폼을 구분, (3) 같은 종류를 공유하면 Threads 조회 판정(스레드 순서)이 Instagram 기록을 잘못 해석할 수 있다 | 통합 DB 시험(ig_publish 상태 변경·원격 ID 변경·삭제·모의 아닌 ID·ig_publish+created 거부) |
| 게시 흐름 | 단일: [URL 발급 → 컨테이너(post 0) → 철회 → 기록 → FINISHED 까지 조회(예산 3) → 게시 → `ig_publish` 기록 → permalink]. 캐러셀: 자식(post 1..n)마다 같은 순서·FINISHED 확인 → 부모(post 0) → 게시. 이미 기록된 컨테이너는 다시 만들지 않고 게시 기록이 있으면 다시 게시하지 않는다. 처리 지연 → processing(REMOTE_PROCESSING). 오류 ERROR → 단계 error + FAILED | 단위 단일·캐러셀·처리 지연·429·401·403·ERROR, 통합 단일·캐러셀·처리 지연 |
| 조회(reconcile) | 단계 없음 → not_found / 게시 기록 → found / 부모 컨테이너: IN_PROGRESS → processing, PUBLISHED·FINISHED → 컨테이너로 미디어 찾기(있으면 기록·found, 없고 FINISHED → **resumable**), ERROR → **failed**, EXPIRED·모름·읽기 실패 → unknown / 부모 없음(자식만) → 자식 상태로 processing·failed·unknown·resumable. 복원한 작업은 기존 규칙(`usesRemoteSteps`)으로 not_found 를 믿지 않음 | 단위 판정 표(재시작·만료·연결 정보 없음 → unknown), 통합 A08(응답 유실 → 조회 확인, 게시 1회), 복원 시험 |
| 요청 제한 | 잠정 계정당 24시간 게시 25개(`INSTAGRAM_PROVISIONAL_RATE_LIMIT`, 확인일 없음). 기존 `accountRateSnapshot`·`rateUnitsRemaining` 훅(게시 단계 있으면 0, 없으면 1). 원격 429 는 기존 Retry-After 규칙 | 통합 로컬 제한(의도 0 대기 → 창 뒤 CONFIRMED)·원격 429 → 같은 컨테이너, drill 로컬 제한 행 |
| 내보내기·복원 | 새 단계 종류를 묶음 스키마(`ROW_SCHEMAS.remote_steps.kind`)에 추가 — 읽기 전용 이력으로 복원(D26 후속 그대로). 가림 대상 없음(컨테이너·미디어 ID 는 권한이 없는 모의 ID, 공개 URL 은 저장하지 않음) | 통합: 응답 유실 항목 내보내기 → 복원 → 같은 단계·재확인 unknown·전송 0, 단계 없는 묶음 → `restored_steps_missing`, 묶음에 공개 URL·토큰 없음 |
| 화면 | `/distribute/[id]` Instagram 단계 패널(MOCK — `이미지 1개 · 컨테이너 1/1 준비 · 게시 대기`, 캐러셀 `컨테이너 n/m`, 단계 줄 `캐러셀 이미지 2/3 · 컨테이너 준비됨 · mockig_ct_…`, 모의 링크, 공개 URL 은 바로 철회된다는 안내), 항목 문구 `Instagram 컨테이너 처리 중 — 확인 대기(MOCK)`·`MOCK 게시 확인(Instagram 모의 — 실제 발행 아님)`, 문제 `Instagram 규격(잠정): …`. `/distribute/new`: 계정 줄 `모의 연결 — MOCK 실행만(공개 범위 public 만)`, 잠정 규격 안내, 공개 범위 기본값 public. 설정: Instagram 모의 계정 `연결(모의)` | web 단위(`distribution.test.ts` T16 절 — 패널 선택·단계 줄·진행·문구·계정 줄·시나리오 선택지). 브라우저 확인은 하지 않음 |
| drill:mock | `drill-instagram.ts` — 단일·캐러셀·컨테이너 지연(단일·캐러셀)·게시 응답 유실·게시 시간 초과(미게시)·429·401·원격 규격 거부(400)·컨테이너 오류·승인 전 규격 위반(9:16)·로컬 제한 2행·재시작 UNKNOWN. 불변식: 순번별 컨테이너 ≤1·게시 ≤1·컨테이너별 게시 ≤1, 원격 미디어 수 = 게시 단계 수, 받은 이미지 sha256(순서) = 승인 checksum, CONFIRMED ⇒ publication 1(MOCK·PUBLISHED/public·mock: 접두), 살아 있는 공개 URL 0, DB 에 공개 URL 0, fetch 0 | 통합 `drill:mock 의 Instagram 행` + `pnpm drill:mock` |

## Proposed D29 (DECISIONS.md 에 넣지 않음 — 오케스트레이터·사용자 확인용 초안)
## D29 — T16 Instagram 이미지·캐러셀(모의 어댑터·Meta 형 모의 OAuth 만): 공급자·scope 자리 표시, 어댑터 선택, 요청 결과·공개 범위, 잠정 규격과 두 번 검사, 공개 미디어 URL 인터페이스(모의만), 단계 종류 ig_container·ig_publish, 잠정 요청 제한, 실계정 시험 blocked_external
- Decision ID / date: D29 / 2026-10-03 (Europe/Moscow). 구현자 잠정 판단 — 사용자 확인 요청 항목은 아래 "User decision required".
- Question: docs/05 T16("Instagram 계정·공식 규격 재확인 후 media adapter")을 공식 규격 재확인·앱 등록·실계정 없이(D24) 어떻게 구현하고, docs/03 Instagram 행(professional 계정·권한·규격, Instagram 로그인과 Facebook 로그인 조건을 섞지 않음, Stories 범위 밖)·승인 스냅샷·A08·A20 을 서버·DB 에서 강제하는가? 실제 API 는 공개 URL 에서 미디어를 가져가는데 이 앱은 파일을 공개하지 않는다.
- Options: (1) OAuth: Threads 모의 공급자 재사용 / **Instagram 전용 Meta 형 모의 공급자(mock_instagram)** — Instagram 로그인과 Threads·Facebook 조건을 섞지 않게. (2) 단계 기록: container/publish 재사용 + 플랫폼 구분 / **새 종류 ig_container·ig_publish**. (3) 규격 검사: 어댑터에서만 / **승인 전(approval blocker) + 보내기 직전(어댑터) + 모의 원격** (4) 공개 URL: 이 앱이 서명 URL 제공 / 제3자 호스팅 / **인터페이스만 두고 모의 구현만(실제 방식은 사용자 결정)**.
- Chosen option: 각 굵은 선택. 세부:
  - 모의 공급자 `mock_instagram`: code + PKCE S256 + state, 장기 토큰 60일(refresh token 없음, 만료 전 같은 토큰으로 갱신 — 모의 가정), scope 자리 표시 `instagram_basic(mock)`·`instagram_content_publish(mock)`(**"(mock) — 공식 이름 live 전 재확인"**), 댓글·메시지·통계 기본 요청 안 함. 모의 사용자는 비즈니스·크리에이터 계정으로 가정. DB CHECK(0036): 공급자·is_mock 에 mock_instagram.
  - 어댑터 선택: 모의 + instagram + credential_state ≠ none → `mock_instagram`, seed 는 `mock_generic`(M3 불변).
  - 요청 결과: `mock_publish` 만 → `PUBLISHED/public`(MOCK). 공개 범위 public 만(생략 시 public). Instagram 에는 비공개·원격 예약 결과가 없다고 보고 UPLOADED_PRIVATE·SCHEDULED_REMOTE 를 만들지 않는다. 앱 쪽 실행 예약은 허용.
  - 범위: 이미지 1장 + 캐러셀 2~10장. 영상·Reels·스토리·썸네일 첨부는 규격 문제(`video_not_supported_t16`·`role_not_supported_t16`)로 승인 전에 막는다.
  - 잠정 규격: JPEG 만·8MiB·가로세로 4:5~1.91:1(±0.005)·가로 ≥320px·캡션 2,200 코드 포인트·해시태그 30·언급 20, 크기는 파일 헤더(≤256KiB)로만 읽음(디코딩 없음). 승인 전(`approveItems`·계획 화면 — 트랜잭션 밖, 창구 없으면 `media_spec:unchecked` 로 거절) + 보내기 직전(어댑터, 원격 호출 0 → FAILED) + 모의 원격(400 `invalid_image_spec` → FAILED). `snapshotProblems`(승인 무효화)에는 넣지 않음 — 스냅샷·파일 불변.
  - 공개 미디어 URL: `PublicMediaUrlProvider` 인터페이스와 `MockPublicMediaUrlProvider`(`mock://public-media/<opaque>`, 10분, 컨테이너 생성 직후 철회)만. URL 은 저장·기록·내보내지 않는다.
  - 단계: `ig_container`(post 0 = 게시할 컨테이너, 1..n = 캐러셀 자식)·`ig_publish`(post 0). 각 참조는 다음 원격 호출 전에 기록, 기록된 컨테이너로만 게시. 조회 판정은 위 설계 표. 만료 컨테이너는 새로 만들지 않고 unknown(Threads 와 같은 종료 정책).
  - 잠정 요청 제한: 계정당 24시간 게시 25개(`ig_publish` 기준, 캐러셀도 1개).
  - 401 → BLOCKED + T13 확인 1회(T14 와 같음), 403·400 → FAILED, 429 → Retry-After, 쓰기 5xx 부작용 불명 → 조회.
  - 실계정 시험: `blocked_external` — Meta 앱 등록·Instagram 로그인 설정·실제 권한 이름·professional 테스트 계정·redirect URI·공개 URL 방식·첫 시험 이미지와 캡션을 받고 정확한 범위를 승인받기 전에는 하지 않는다.
- Evidence / assumption: 단위 `packages/domain/src/instagram.test.ts`, `packages/providers/src/instagram-mock.test.ts`, `apps/web/lib/distribution.test.ts`(T16 절), `packages/domain/src/oauth.test.ts`. 통합 `tests/integration/instagram.test.ts`(16건). `pnpm drill:mock` Instagram 표. 공식 Instagram 문서는 이번에도 확인하지 않았다(네트워크 금지) — 숫자·이름·흐름 모양은 모두 가정.
- Reversible?: 예. 선택 규칙 한 곳, 규격 숫자는 `INSTAGRAM_PROVISIONAL_MEDIA_SPEC` 한 곳, 요청 제한은 어댑터 상수, 공개 URL 은 인터페이스 뒤, 단계 종류는 0036 CHECK 만.
- User decision required?: 확인 요청 —
  - (a) **공개 미디어 URL 방식(live 전 필수)**: ① 이 앱이 짧은 수명의 서명 URL 로 직접 제공(앱을 인터넷에 노출해야 함 — HTTPS·대역폭·접근 로그, URL 이 Meta 쪽 로그에 남음) / ② 제3자 객체 저장소·CDN 에 잠시 올림(새 공급자 계약·자격 증명·삭제 시점, 파일이 우리 서버 밖에 머묾) / ③ 자동 게시 없이 수동 게시(배포 파일 ZIP + 체크리스트, MANUAL_REPORTED). 개인정보 영향: 누가·언제까지 파일을 볼 수 있는지, 철회 가능 시점(원격이 비동기로 가져가면 즉시 철회가 실패를 낳을 수 있음).
  - (b) scope 자리 표시 이름 → 공식 이름(Instagram 로그인 기준, 게시에 필요한 최소)으로 교체.
  - (c) 규격 숫자(JPEG 만인지 PNG 허용인지, 크기·비율·가로·캡션·해시태그·언급 한도)와 확인일·API 버전 기록.
  - (d) 요청 제한 값(24시간 25개)과 단위(캐러셀 = 1).
  - (e) 범위: 캐러셀 포함 유지 여부, 영상·Reels 를 다음 작업으로 둘지(지금은 승인 전 차단).
  - (f) 계정 종류: 비즈니스·크리에이터(professional) 확인 방법과 개인 계정이면 수동 fallback 으로 보낼지.
  - (g) 공개 범위 public 만·요청 결과 mock_publish 만으로 둔 것.
- Exact authorized scope (if applicable): 외부 호출 0(모의 시뮬레이터·모의 공급자·모의 공개 URL 만, 네트워크 없음), 새 의존성 0, 비밀 0(시험 키는 실행 중 난수), 실계정·앱 등록 0.
- Consequences: 모의 연결한 Instagram 계정으로 개발 화면에서 이미지·캐러셀 2단계 게시·재개·요청 제한·규격 거절을 끝까지 볼 수 있다. 모든 결과는 MOCK 이며 실제 발행 실적이 아니다. `remote_steps` 모의 ID CHECK 는 그대로라 live 어댑터는 새 migration 없이 붙일 수 없다(의도된 차단). 실제 공개 URL 구현이 없으므로 live Instagram 은 (a) 결정 전까지 불가능하다.
- When to revisit: 실계정 연결 승인 시(공식 scope·규격·한도·컨테이너 만료·같은 컨테이너 재게시 동작·캐러셀 규칙·토큰 수명과 갱신·professional 계정 조건 재확인, 공개 URL 방식 구현, remote_steps CHECK 개정), PostgreSQL 전환.

## 명령과 결과 (로컬 Windows 10, Node 24.21.0, `corepack pnpm`, 순차 — 단위와 통합 동시 실행 안 함)
- `corepack pnpm exec drizzle-kit generate --name t16_instagram_media`(packages/db) → 0036 생성(스키마 diff 그대로 + 머리 주석)
- `pnpm lint` → pass(exit 0)
- `pnpm typecheck` → pass
- `pnpm build` → pass(개발 서버 꺼진 상태)
- `pnpm test` → pass 42 files / 792 tests
- `pnpm test:integration`(단독) → pass 32 files / 616 tests, 420.5 s (instagram.test.ts 16건 포함)
- `pnpm drill:mock` → exit 0, `불변식 위반 0건 — M3 게이트 통과(MOCK), T14 Threads 모의 불변식 통과(MOCK), T15 YouTube 모의 불변식 통과(MOCK), T16 Instagram 모의 불변식 통과(MOCK)`, Instagram fetch 0
- 실행하지 않음: 개발 서버·브라우저 smoke(화면은 단위 문구 시험만), 실제 PostgreSQL 동시성, `pnpm db:migrate`(파일 DB — `./data` 를 열지 않음; 0036 은 통합 시험의 메모리 DB 적용으로만 확인), Codex 검증.

## drill:mock Instagram 표
| 시나리오(Instagram 모의) | 이미지 | 최종 job 상태 | 항목 상태 | intent 수 | 컨테이너 | 게시 | publication(MOCK) | 재게시 |
|---|---|---|---|---|---|---|---|---|
| instagram_success · 이미지 1장 | 1 | CONFIRMED | CONFIRMED | 1 | 1 | 1 | MOCK PUBLISHED/public | 없음 |
| instagram_success · 캐러셀 3장 | 3 | CONFIRMED | CONFIRMED | 1 | 4 | 1 | MOCK PUBLISHED/public | 없음 |
| instagram_container_slow → 같은 컨테이너로 게시 | 1 | CONFIRMED | CONFIRMED | 2 | 1 | 1 | MOCK PUBLISHED/public | 없음 |
| instagram_container_slow · 캐러셀 → 부모 지연 뒤 게시 | 3 | CONFIRMED | CONFIRMED | 2 | 4 | 1 | MOCK PUBLISHED/public | 없음 |
| instagram_publish_timeout_sent(응답 유실) → 조회로 확인 | 1 | CONFIRMED | CONFIRMED | 1 | 1 | 1 | MOCK PUBLISHED/public | 없음 |
| instagram_publish_timeout_not_sent → 같은 컨테이너로 게시 | 1 | CONFIRMED | CONFIRMED | 2 | 1 | 1 | MOCK PUBLISHED/public | 없음 |
| instagram_rate_limited(429) → 재시도 | 1 | CONFIRMED | CONFIRMED | 2 | 1 | 1 | MOCK PUBLISHED/public | 없음 |
| instagram_token_invalid(401) | 1 | BLOCKED | BLOCKED | 1 | 0 | 0 | 없음 | 없음 |
| instagram_invalid_spec_remote(400) | 1 | FAILED | FAILED | 1 | 0 | 0 | 없음 | 없음 |
| instagram_container_error(ERROR) | 3 | FAILED | FAILED | 1 | 4 | 0 | 없음 | 없음 |
| 승인 전 규격 위반(9:16 세로) → 승인 거절 | 1 | (없음) | PLANNED | 0 | 0 | 0 | 없음 | 없음 |
| 로컬 요청 제한 · 1번째 | 1 | CONFIRMED | CONFIRMED | 1 | 1 | 1 | MOCK PUBLISHED/public | 없음 |
| 로컬 요청 제한 · 2번째(창 뒤, 의도 없이 대기) | 1 | CONFIRMED | CONFIRMED | 1 | 1 | 1 | MOCK PUBLISHED/public | 없음 |
| 재시작(모의 Instagram 기록 유실) → UNKNOWN | 1 | UNKNOWN | UNKNOWN | 1 | 1 | 0 | 없음 | 없음 |

## 남은 위험
- **공식 규격·scope·흐름 미확인**: docs/08 S09·S10 은 여전히 "미확인". 시뮬레이터의 컨테이너·캐러셀·게시 모양, 같은 컨테이너 재게시 거절, 만료 동작, 429 단위는 모두 모의 가정이다.
- **공개 URL 은 모의뿐**: live 로 가려면 (a) 결정·구현이 필요하다. 실제 원격이 이미지를 비동기로 가져가면 "생성 직후 철회"는 처리 실패(ERROR)를 낳을 수 있다 — live 어댑터는 FINISHED 확인 뒤 철회로 바꿔야 할 수 있다.
- 승인 전 규격 검사는 계획 화면을 열 때마다 이미지 헤더(≤256KiB/장)를 읽는다(최대 10장). 큰 계획에서 화면 비용이 늘 수 있다.
- 규격 검사는 헤더 크기만 본다(디코딩·색 공간·EXIF 회전 미확인). EXIF 회전된 JPEG 는 실제 표시 비율과 다를 수 있다.
- 캐러셀 중간에 401·403·400 이 나면 앞 자식 컨테이너는 원격에 게시되지 않은 채 남는다(게시물은 없음 — 부분 게시 문제는 Threads 와 달리 생기지 않음).
- 컨테이너 생성 응답을 기록 전에 잃으면 고아 컨테이너가 원격에 남고 다음 시도는 새 컨테이너를 만든다(게시는 기록된 컨테이너로만 — 이중 게시 없음).
- 별도 `pnpm worker` 프로세스는 web 이 발급한 모의 토큰·모의 공개 URL 창구를 모른다(프로세스 메모리) → 원격 401 → BLOCKED(D26 후속과 같은 모의 한계).
- `approveItems`·`getPlanDetail` 에 선택 인자 `opts.media` 를 더했다 — 창구 없이 부르는 호출자(스크립트 등)는 Instagram 모의 연결 항목을 `media_spec:unchecked` 로 승인하지 못한다(fail closed, 의도).
- `mediaPortFor` 를 `jobs.ts` → `media-spec.ts` 로 옮겼다(동작 동일, `@cs/db` 에서 같은 이름으로 내보냄).

## Codex 에게 질문
1. 규격 검사를 `snapshotProblems`(beginSend 무효화 경로)에 넣지 않고 승인 전(approve/계획 화면) + 어댑터(보내기 직전 FAILED)로 나눈 것이 docs/03 "실행 직전 재검사"와 맞는가? 아니면 beginSend 에서 승인 무효화(PLANNED)로 돌려야 하는가?
2. `ig_container`·`ig_publish` 새 종류 대신 Threads 의 `container`·`publish` 를 플랫폼별 post_index 규칙으로 재사용해야 할 근거가 있는가? 0036 의 CHECK 교체만으로 기존 행·묶음 호환이 충분한가?
3. 조회에서 부모 컨테이너 ERROR → `failed`(FAILED)로 닫는 것이 건전한가(원격 처리 거부 = 게시물 없음이 확실하다는 모의 전제)? 만료(EXPIRED)를 unknown 으로 두고 새 컨테이너를 만들지 않는 정책이 Instagram 에서도 맞는가?
4. 공개 URL 을 "생성 직후 철회"하는 수명 규칙과, URL 을 어디에도 기록하지 않는 것(결과 불명 뒤 조회는 컨테이너 ID 만 씀)이 A08·개인정보 규칙에 충분한가? 철회 실패(프로세스 종료)로 남는 모의 URL 은 10분 만료에만 기댄다.
5. 승인 전 검사를 트랜잭션 밖에서(파일 헤더 읽기) 한 뒤 트랜잭션 안의 거절 목록에 합치는 순서가 안전한가? 항목 payload 불변·계정 변경은 `snapshotProblems` 가 따로 잡는다는 전제.
6. Instagram 계정의 공개 범위를 public 만 허용하고 결과를 `PUBLISHED/public` 으로 기록하는 것(계정이 비공개 계정이어도)이 "원격이 보고한 공개 범위만 기록" 원칙(A12 계열)과 충돌하지 않는가 — 모의에서 계정 공개 여부를 조회해 기록해야 하는가?
