# 데이터 모델·API 계약
구현 시 DB migration·런타임 schema를 생성한다. 아래 표는 설계이며 실행 가능한 SQL이 아니다.

## 핵심 엔티티
| 테이블 | 주요 필드·관계 |
| --- | --- |
| users | id, allowed_identity, created_at |
| brand_profiles | owner_id, version, pen_name, audience, pillars, style_rules |
| captures | owner_id, raw_text, input_type, source_id, received_at, risk, user_note |
| sources | owner_id, kind, canonical_url?, external_provider/id/revision?, checked_at, content_hash, rights_status |
| source_versions | source_id, raw_hash, fetched_at, excerpt, extraction_state |
| ideas | owner_id, idea, audience, next_question, risk, lifecycle, source_capture_ids |
| contents | owner_id, idea_id, series, title, current_version_id, lifecycle |
| content_versions | content_id, version, body, created_by, ai_run_id?, immutable=true |
| claims | content_version_id, statement, evidence_grade, personal_experience_confirmed, needs_check |
| claim_sources | claim_id, source_version_id, locator, support_note |
| variants | content_id, channel, current_version_id |
| variant_versions | variant_id, version, content_version_id, body, metadata_json, immutable=true |
| assets | owner_id, key, mime, bytes, checksum, rights_status, verification_state |
| variant_assets | variant_version_id, asset_id, order, role |
| channel_accounts | owner_id, platform, external_account_id, display_name, state, capability_snapshot |
| oauth_credentials | channel_account_id, encrypted_token, key_version, expiry, scopes, revoked_at |
| auth_oidc_states | (T21-P1b, owner 없음 — 로그인 전) state_hash, browser_hash, encrypted_payload(PKCE verifier·nonce 봉인), key_version, settings_hash, expires_at(10분), used_at — export/restore 제외 |
| distribution_plans | owner_id, target_summary, status, created_at |
| distribution_items | plan_id, account_id, variant_version_id, payload_json, payload_hash, requested_result, schedule_utc, timezone |
| approvals | owner_id, distribution_item_id, payload_hash, approved_at, revoked_at, purpose |
| jobs | owner_id, kind, item_id?, payload_ref, state, attempt, lease_owner, lease_until, next_run_at, idempotency_key |
| job_events | job_id, event_id, state_before/after, timestamp, sanitized_details |
| publications | item_id, external_id, permalink, result_kind, visibility, verification, verified_at |
| generation_runs | owner_id, input_version_refs, prompt_version, provider/model, output_ref, status |
| usage_ledger | run_id/job_id, reserved_amount, actual_amount?, currency, tokens/audio_seconds, pricing_snapshot |
| import_runs / import_items | provider, scope, source_id/revision, preview, decision, imported_ref, error |
| audit_events | owner_id, action, entity, version/hash, at, sanitized_details |

M1은 users/brand_profiles/captures/sources/ideas/contents/content_versions/assets부터 구현한다. 모든 테이블을 먼저 만들 필요는 없다.
owner 참조는 API뿐 아니라 DB FK와 query 제약에서도 일관되게 적용한다. 다른 owner의 asset이나 account를 배포 항목에 연결하지 못하게 한다.
constraints: unique(content_id,version), unique(variant_id,version), unique(owner_id,provider,external_id,revision) for imports, unique(job idempotency key), unique(item_id,confirmed external_id).
출처가 없는 본인의 생각은 opinion으로 저장할 수 있다. 확인이 필요한 사실·경험은 검토 대기 상태로 두며, 모든 의견에 URL을 요구하지 않는다.

## 버전과 충돌
편집 API에는 If-Match/version을 적용한다. 오래된 버전에서의 수정에는 409를 반환하고, 원문을 잃지 않는 비교 화면을 제공한다.
AI 생성은 input_version을 고정한다. 생성 중 원고가 바뀌어도 자동으로 덮어쓰지 않는다.
승인 시 hash와 snapshot을 한 transaction으로 저장한다. 다른 탭의 동시 편집·asset 교체·재연결 후 외부 계정 ID 변경을 검사한다.
콘텐츠 전체에 published flag 하나만 두지 않는다. 동일 원본의 채널·버전별 배포 결과를 별도 관리한다.

## 내부 HTTP API(안)
모든 API는 로그인한 owner 범위에서만 동작한다. 상태 변경 POST는 CSRF를 방어하고 GET으로 상태를 바꾸지 않는다. 목록은 cursor pagination.
| 작업 | 메서드/경로 | 계약 |
| --- | --- | --- |
| 수집 | POST /api/captures | input_type, raw_text/url/asset_ref, command_key |
| 추출 | POST /api/captures/{id}/extract | job 반환. 내부망 URL 접근 금지 |
| 소재화 | POST /api/captures/{id}/ideas | 입력 버전 고정, AI 제안 저장 |
| 원고 조회/수정 | GET/PATCH /api/contents/{id} | 버전 충돌 검사, 원문 보존 |
| AI 보조 | POST /api/contents/{id}/assist | 개요/질문/수정, 대상 문단·버전 지정 |
| 채널 변환 | POST /api/contents/{id}/variants | 채널별 버전 생성 |
| 파일 등록 | POST /api/assets/uploads | 제한된 업로드 권한; 완료 검증 후 VERIFIED |
| 배포계획 | POST /api/distribution-plans | 채널별 불변 스냅샷 후보 |
| 승인 | POST /api/distribution-plans/{id}/approve | item IDs+예상 hash, 명시 확인 |
| 실행 | POST /api/distribution-plans/{id}/execute | approval+command key 필수, jobs 생성 |
| 취소 | POST /api/distribution-items/{id}/cancel | 취소 완료와 확인 중을 구분 |
| 작업 조회 | GET /api/jobs/{id} | 비밀 제거, 실제 상태 반환 |
| 계정 연결 | POST /api/channel-accounts/{id}/connect, GET /api/oauth/callback | state 1회용·PKCE·redirect 정확 일치, 토큰은 서버 암호화 저장(D24·D25) |
| 연결 상태·갱신·철회 | GET /api/channel-accounts/{id}/health, POST …/refresh·/check·/revoke | 비밀 제거, 다른 owner 404, 철회 시 해당 계정 승인 무효. 실제 Threads 는 철회 API 없음 → remote_revoke=unsupported + 로컬 삭제(LIVE-T1) |
| 실제 Threads 계정 행(연결 전) | POST /api/channel-accounts (platform=threads, kind=live) | LIVE-T1(D31): owner 범위·같은 출처·멱등, external_account_id `pending:<uuid>` → 첫 실제 연결이 프로필 ID 로 묶음, state disconnected(게시 불가), 외부 호출 없음 |
| 원격 재확인 | POST /api/distribution-items/{id}/reconcile | 기존 결과 조회만 수행 |
| 가져오기 | POST /api/imports/preview, /api/imports/{id}/commit | 범위→차이→확정, 외부 원본 보존 |
| 내보내기 | POST /api/exports | Markdown/JSON/assets, 인증 비밀 제외 |
| 복원 미리보기 | POST /api/restores/preview | 버전·checksum·충돌 검사 |
| 로그인(공개 예외) | POST /api/auth/login | 같은 출처(CSRF) 필수. AUTH_MODE=dev(D3): 허용 식별자 1개, localhost 전용, **운영 빌드(NODE_ENV 가 development·test·없음 이외)에서는 서버 시작·설정 읽기·로그인 모두 거부**(503 `dev_login_refused_in_production`, T21-P1a/G1a). 시도 횟수 제한: 최근 15분 실패(식별자 불일치·잘못된 본문) 전체 10회 이상이면 식별자와 무관하게 429 `login_rate_limited`(IP 미사용, 마지막 성공 이전 실패는 세지 않음, `auth.login_denied` 감사 기록으로 셈. 재검사·판정·기록은 전역 advisory 잠금 한 트랜잭션에서 직렬화, 순서는 로그인 순번 `version_or_hash` — FIX-T21P1A). AUTH_MODE=oidc 이면 403 `identity_login_disabled`(T21-P1b — 아래 OIDC 로그인) |
| OIDC 로그인 시작(공개 예외) | GET /api/auth/oidc/start | T21-P1b. AUTH_MODE=oidc·준비 상태(아니면 503 `oidc_not_configured`, 빠진 이름은 서버 로그에만) · `Sec-Fetch-Site` 가 있으면 same-origin·none 만(아니면 403 `csrf`) · 전역 시도 제한(429) · discovery(캐시 1시간, 실패 502 `oidc_provider_unavailable`) → `auth_oidc_states` 행(state·결합 쿠키 sha256, PKCE verifier·nonce 봉인, 10분, 1회용, 진행 중 최대 100개 — 넘으면 오래된 것부터 삭제) → 303 IdP 인증 URL(response_type=code, PKCE S256, state, nonce, scope, redirect_uri) + `cs_oidc_flow` 쿠키. 응답에 `Referrer-Policy: no-referrer`·`Cache-Control: no-store` |
| OIDC 로그인 완료(공개 예외) | GET /api/auth/oidc/callback | T21-P1b. 전역 시도 제한 조기 검사(429, state 소비 없음·감사 없음) → 요청 origin+path = `OIDC_REDIRECT_URI` 정확 일치 → state 1회용 소비(같은 브라우저 결합 쿠키·10분·설정 지문 — 다른 브라우저면 소비하지 않음) → IdP `error` 면 401 `oidc_cancelled` → openid-client 로 code 교환(PKCE)·ID token 검증(서명 JWKS·iss·aud·exp·iat·nonce) → 허용 신원(`AUTH_ALLOWED_IDENTITY` 명시 시 email+email_verified=true, `AUTH_ALLOWED_SUBJECT` 시 sub) → `withLoginAttemptLock`(T21-P1a 와 같은 전역 잠금·순번) 안에서 재검사 후 세션+`auth.login`{mode:'oidc'} 또는 `auth.login_denied`{reason,check,mode}. reason `oidc_invalid`·`oidc_identity_mismatch` 는 실패 횟수에 포함, `oidc_provider_error`·`oidc_cancelled` 는 제외. 오류: 400 `oidc_state_invalid` · 401 `oidc_login_invalid` · 403 `oidc_identity_denied` · 502 `oidc_provider_unavailable` · 503 `oidc_not_configured`. 브라우저는 303 `/` 또는 `/login?error=<코드>`. 결합 쿠키는 callback 이 지우지 않음(600초 만료, 재사용은 1회용 state 가 막음 — FIX2-T21P1B) |
| 생존 확인(공개 예외) | GET /api/health | 로그인 없음. 응답은 정확히 `{status:'ok'\|'degraded', app, time_utc, db_ok}`(ok 200, degraded 503). 부작용 없음(worker tick 안 돎). 모드·준비 상태·버전·DB 드라이버·worker 정보 없음(T21-P3) |
| 자세한 상태 | GET /api/health/details | 로그인한 owner 만(없으면 401). 모드·llm/stt 준비 상태(빠진 조건 이름만)·`auth`{mode, oidc_ready, missing(이름만) — T21-P1b}·DB 드라이버/migrated·worker 모드/마지막 tick. 읽기 전용(tick 없음). 운영 숫자는 GET /api/ops/summary |
| 작업 처리 실행 | POST /api/worker/tick | 로그인·같은 출처(CSRF) 필수, 이 owner 의 작업만(모의 어댑터). 세션 없음 401 — 아무 작업도 건드리지 않음 |

런타임 입력·출력 validation은 M0/M1에서 이 계약에 맞춰 구현한다.

## AI 구조화 출력
AI는 result_type, input_version, proposed_text, proposed_tags, claims[{text,kind,source_refs,needs_user_confirmation}], followup_questions, warnings를 반환한다.
claim의 source_ref는 실제 허용 source_version 목록에 포함되어야 한다. 그럴듯한 URL을 모델이 생성하면 확인 전 채택하지 않는다.
HTML·코드·외부 명령은 자료로만 저장하고 실행하지 않는다. structured output은 출처 진위나 공개 승인 증거가 아니다.

## 환경변수 계약(실제 키 없음)
APP_BASE_URL, APP_TIMEZONE=Europe/Moscow, DATABASE_URL, AUTH_*(AUTH_MODE=dev 는 NODE_ENV=production 등 운영 빌드에서 설정 오류 — T21-P1a; AUTH_ALLOWED_SUBJECT 선택 — T21-P1b),
OIDC_ISSUER_URL(https), OIDC_CLIENT_ID, OIDC_CLIENT_SECRET(서버 환경만, 설정 스키마 밖), OIDC_REDIRECT_URI(= APP_BASE_URL origin + /api/auth/oidc/callback), OIDC_SCOPES(기본 "openid email") — T21-P1b,
STORAGE_DRIVER=local|object, STORAGE_*, ENCRYPTION_KEY_REF,
LLM_MODE=mock|live, LLM_PROVIDER, LLM_MODEL, LLM_BUDGET_*,
PUBLISH_MODE=disabled|enabled, COLLECTOR_MODE=disabled|enabled,
WORKER_MODE=inline|separate, WORKER_INLINE_INTERVAL_SECONDS=0(끔, 기본)|5~600(web 안 주기 tick 간격 초 — T21-P2. 직전 tick 이 끝난 뒤 간격, 겹치지 않음),
THREADS_*, YOUTUBE_*, INSTAGRAM_*, NOTION_*, GOOGLE_DRIVE_*.
환경 예시에는 placeholder만. source control에 .env.local/credential/log/raw source를 넣지 않는다.
설정 미완료 시 로컬 mock 경로는 동작하며 live 기능은 명확한 설명과 함께 차단한다.

