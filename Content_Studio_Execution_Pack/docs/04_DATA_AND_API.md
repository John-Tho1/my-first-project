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
| audit_events | owner_id, action, entity, version/hash, at, sanitized_details — 색인 (action, at)(migration 0048, FIX2-FULLREV2 G15 — 로그인 판정의 시간 창 조회) |
| sessions | owner_id, token_hash(sha256), created_at, expires_at, last_seen_at, revoked_at, user_agent_hash, policy_fingerprint(FIX2-FULLREV2 G16 — 만들 때의 인증 정책 지문, 다르거나 null 이면 거부). 내보내기·복원 대상 아님 |

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
| 수집 | POST /api/captures | input_type, raw_text/url/asset_ref, command_key. 본문 상한 = (원문 20,000 + 메모 2,000 + 제목 200 + URL 2,048) × 12바이트 + 16KiB(약 300KiB — 한국어 urlencoded 최악 인코딩을 덮음), 넘으면 413; 글자 수는 파싱 뒤 검사(400·폼 `?capture_error=invalid`) (FIX3-FULLREV2 G28). 목록 GET 의 has_exact_duplicate 는 상세 정확 중복과 같은 규칙(같은 원문 해시 또는 같은 정규화 URL — 같은 source_id 만으로는 아님, G27) |
| 추출 | POST /api/captures/{id}/extract | job 반환. 내부망 URL 접근 금지 |
| 소재화 | POST /api/captures/{id}/ideas | 입력 버전 고정, AI 제안 저장 |
| 원고 조회/수정 | GET/PATCH /api/contents/{id} | 버전 충돌 검사, 원문 보존 |
| 원고 본문 저장 | POST /api/contents/{id}/versions | {base_version, body, note?} → 201 {content, version, unchanged:false}. 본문이 현재 본문과 줄바꿈 표기(CRLF/CR → LF)만 정리해 같으면 새 버전·승인 철회·파생본 stale 없이 200 {content, version(현재), unchanged:true} — 메모는 저장하지 않음, 폼은 303 `?unchanged=1`('변경 없음' 안내). base_version 이 오래되면 본문이 같아도 409(FIX3-FULLREV2 G29, D40-5) |
| AI 보조 | POST /api/contents/{id}/assist | 개요/질문/수정, 대상 문단·버전 지정. 실패 502 `{error:'llm_failed', message, run_id, failure_code?, permanent?}` — failure_code 는 허용 목록의 안정 코드만(llm_auth_failed·llm_not_found·llm_max_tokens·unverifiable_citation 등, 공급자 원문 없음), permanent=true(인증·권한·모델 없음·요청 형식·출력 상한·호출 전 조건·인용 검증)면 message 가 '다시 시도해도 같은 결과·예약액 확정'을 안내. 채널 AI 초안(POST /api/contents/{id}/variants ai_draft)도 같음. 작성 패널은 실패 run 의 원인을 같은 표의 고정 문구로 보인다(FIX3-FULLREV2 G21). 폼 제출 실패는 303 `?error=llm_failed&failure=<코드>`(코드는 허용 목록에 있을 때만 — 채널 초안 run 은 작성 보조 목록에 없으므로 이 쿼리로 화면 위 안내에 원인·영구 실패 안내를 보인다; 화면은 허용 목록 밖 값을 그리지 않음). 스키마 실패 분류는 두 경로 모두 `invalid_output`. 이번 달 원장에 다른 통화가 있으면 409 budget_currency_mismatch — 폼은 `?error=budget_currency_mismatch`(일반 conflict 아님, G22) |
| Brand Profile 저장 | POST /api/brand | base_version ≠ 현재 → JSON 409 {current, yours}; 폼은 409 HTML 비교 화면(필드별 현재 값/내 입력 + 내 입력이 채워진 재저장 폼, base_version=현재, Referrer-Policy same-origin·CSP — FIX3-FULLREV2 G31) |
| 검색 | GET /api/search | q 를 공백으로 나눈 고유 조각이 8개를 넘으면 400('검색어는 공백으로 나눈 조각 8개까지…') — 조용히 자르지 않는다(FIX3-FULLREV2 G32) |
| 채널 변환 | POST /api/contents/{id}/variants | 채널별 버전 생성 |
| 파일 등록 | POST /api/assets/uploads | 제한된 업로드 권한; 완료 검증 후 VERIFIED |
| 업로드 완료 | POST /api/uploads/sessions/{id}/complete | 조각 없음·조각 sha256 불일치·세션 폴더 자체가 없음(조립 파일 열기 ENOENT·ENOTDIR)만 400 upload_rejected{reason:'assembly_failed'}(세션 rejected·조각 삭제). 조립 중 서버 I/O 오류(열기·쓰기·닫기·stat — ENOSPC·EMFILE 등)는 503 upload_assembly_io_error{retryable:true}: 조립 파일만 지우고 세션 open·조각 유지, 같은 세션으로 다시 완료 (FIX3-FULLREV2 G24). 최종 커밋 실패로 open 으로 되돌릴 때도 조립 파일은 되돌리기 전에 지운다(되돌린 뒤 시작한 다른 완료의 조립 파일을 지우지 않음) |
| 전사 요청 | POST /api/assets/{id}/transcribe | {duration_seconds?, keep_original?, force?} → 202 {job, existing:false}. 진행 중(queued·running) 작업이 있으면 409 transcription_in_progress{job_id}. 진행 중은 없고 성공한 전사(succeeded + 전사 버전)가 있으면 force 가 아닌 요청은 새 작업·비용 예약·감사 없이 200 {job(가장 최근 성공 작업), existing:true} — 커밋 뒤 응답을 잃은 화면의 재시도·같은 파일 다시 고르기가 같은 asset 에 작업·예약을 하나 더 만들지 않는다('최근' 기준 없음: asset 내용은 checksum 으로 불변이라 성공 전사가 현재 전사). 원음 보존을 끈 성공으로 원본이 지워진 asset 도 410 보다 먼저 기존 작업을 돌려준다. 실패·취소만 있으면 새 작업. `force:true` 는 일부러 다시 전사(새 작업·예약, 원본이 지워졌으면 410) — /record 화면은 보내지 않는다. 화면은 폴링 목록에 그 asset 의 진행 중·성공 작업이 보이면 '전사만 다시 요청'·이어 올리기 키를 거둔다(FIX1-FULLREV3 H6 — 원음 보존을 끈 요청이면 keep_original=false 작업일 때만). FIX1-FULLREV3(H6 후속): `keep_original:false` 요청이 기존 성공 작업을 만났고 원본이 아직 있으면 성공 뒤 삭제와 같은 경로(첨부 재확인·의도 먼저·감사 `asset.delete_original`/`_skipped` — 이 경로는 details 에 `trigger:'request_existing'` 을 함께 남긴다: `job_id` 는 원음 보존을 켰던 기존 작업이라, FIX2-FULLREV3 K3. 작업 성공 뒤 삭제의 감사는 전과 같음)로 원본을 지우고 200 {job, existing:true, original_deleted:true}. 채널 초안에 첨부됐거나 앞선 정리 대기면 지우지 않고 {original_deleted:false, original_kept_reason:'asset_in_use'·'cleanup_pending'} — 화면이 원본이 어떻게 됐는지 안내한다. 새 작업·예약은 어느 쪽도 없다. 해당 없으면 두 칸은 없다 |
| 전사 수정 | POST /api/transcripts/{id}/versions | {base_version, text} — base_version 은 화면이 고치기 시작한 버전. 최신이 아니면 409 stale_transcript{current_version} (화면은 초안 유지 + 최신 본문·'다른 곳에서 새 버전이 저장됨' 표시, FIX3-FULLREV2 G23) |
| 배포계획 | POST /api/distribution-plans | 채널별 불변 스냅샷 후보. 201 응답의 `mode` 는 항목 계정 kind 기준(모두 모의 MOCK·모두 실제 LIVE·섞이면 MIXED), 항목마다 `mode`(MOCK·LIVE) — GET 계획 상세와 같은 규칙(FIX3-FULLREV2 G10) |
| 승인 | POST /api/distribution-plans/{id}/approve | item IDs+예상 hash, 명시 확인. 200 응답의 `mode`(MOCK·LIVE·MIXED)와 `approvals[].mode` 는 승인한 항목의 계정 kind 기준(FIX3-FULLREV2 G10). 같은 owner 의 다른 계획에 같은 글(같은 채널 초안 버전+같은 계정 또는 같은 payload_hash)이 이미 게시됨(결과 기록, USER_CONFIRMED 포함)·결과 불명·진행 중(QUEUED·SENDING·REMOTE_PROCESSING·RETRY_WAIT·RECONCILING·CANCEL_REQUESTED·BLOCKED)이면 실제 계정 항목은 acknowledge_duplicate: true(JSON boolean) 필요 — 없으면 409 duplicate_publish_unacknowledged(아무것도 바꾸지 않음), 모의 계정은 경고만(200 duplicate_warnings). PLANNED·CANCELED·FAILED 는 세지 않음(FIX1-FULLREV2 G2, D40-1). 원고의 아이디어(contents.idea_id)·연결 소재(content_captures) 중 위험 표시 risk='needs_check'('확인 필요')가 있으면 409 snapshot_stale(reasons `risk_needs_check`, 해제 안내 문구 — 해제하면 같은 계획에서 다시 승인. 실행·전송 직전(beginSend)도 같은 재검사로 막고 승인을 `invalidated:risk_needs_check` 로 철회, FIX2-FULLREV2 G9, D40-2). 승인·실행은 계정 다음·항목 잠금 전에 그 아이디어·소재 행을 FOR SHARE(id 순)로 잠가 위험 표시 변경과 직렬화(G9 fixup) |
| 실행 | POST /api/distribution-plans/{id}/execute | approval+command key 필수, jobs 생성. 승인과 같은 중복 규칙을 실행 때 다시 조회(실제 게시 항목은 acknowledge_duplicate: true, 없으면 409 — 대기열·실행 키 그대로). 실행 뒤 전송 전에 생긴 중복은 막지 않음(화면 경고만) |
| 계획 상세 | GET /api/distribution-plans/{id} | 항목마다 duplicate_publishes(다른 계획의 같은 글 — plan_id·item_id·status·kind published/unknown/in_progress·mock·verification)·duplicate_ack_required(실행 전 실제 계정 항목에 중복)·risk_needs_check(`{idea_id, capture_ids}` 또는 null — 원고의 아이디어·연결 소재 중 '확인 필요', G9) |
| 아이디어·소재 위험 표시 | PATCH /api/ideas/{id}(폼 POST 포함)·PATCH /api/captures/{id} { risk } | risk 를 'needs_check' 로 저장하면 같은 트랜잭션에서 그 아이디어로 만든 원고(contents.idea_id)·그 소재를 연결한 원고(content_captures)의 배포 항목 활성 승인을 `invalidated:risk_needs_check` 로 철회(대기 작업 BLOCKED·항목 PLANNED·파생본 approved → review). 'none' 으로 바꿔도 철회한 승인은 되살리지 않음(FIX2-FULLREV2 G9, D40-2). 보내는 중·원격 처리 중·확인 중·취소 확인 중(SENDING·REMOTE_PROCESSING·RECONCILING·CANCEL_REQUESTED) 항목의 승인도 철회한다 — 작업·항목 상태는 그대로(지금 시도는 결과를 기록), 해제 뒤 재개·재시도의 다음 전송은 보내기 직전 `approval_missing` 으로 멈춤(게시된 것이 없으면 항목 PLANNED, 스레드 일부가 게시됐으면 UNKNOWN `thread_partial_revoked`) — 계정 상태 변경과 같은 규칙(FIX1-FULLREV3 H2) |
| 취소 | POST /api/distribution-items/{id}/cancel | 취소 완료와 확인 중을 구분 |
| 재시도 | POST /api/distribution-items/{id}/retry | 보류(BLOCKED) 항목을 다시 대기열에. 200 { item_id, job_id, state: 'QUEUED', attempt_next, message, mode } — `mode` 는 계정 kind 기준 MOCK·LIVE(message·감사 기록과 같은 값, FIX3-FULLREV2 G10) |
| 작업 조회 | GET /api/jobs/{id} | 비밀 제거, 실제 상태 반환 |
| 계정 연결 | POST /api/channel-accounts/{id}/connect, GET /api/oauth/callback | state 1회용·PKCE·redirect 정확 일치(callback 은 `APP_BASE_URL` origin + 요청 path 를 등록 redirect URI 와 비교 — 요청 origin 은 쓰지 않음, FIX1-FULLREV3 H1), 토큰은 서버 암호화 저장(D24·D25). 연결 해제가 끝나지 않은(revoking) 계정의 connect 는 409 credential_busy — 연결 요청 행·authorize URL 없음(FIX2-FULLREV2 G14). `OAUTH_REDIRECT_URI` 가 `APP_BASE_URL` origin + `/api/oauth/callback` 과 정확히 같지 않으면(다른 origin → callback 이 언제나 불일치, 같은 origin 다른 경로·끝 `/` → route 없음·불일치) 모의·실제 모두 connect 가 503 `oauth_redirect_uri_mismatch` — 연결 요청 행·감사·authorize URL 없음, 외부 호출 0. 실제 연결 준비 상태에는 `OAUTH_REDIRECT_URI(APP_BASE_URL/api/oauth/callback 과 다름)`(FIX1-FULLREV3 H1 후속 → FIX2-FULLREV3 K1 — 예전 코드 `oauth_redirect_origin_mismatch` 는 origin 만 봤다) |
| 연결 상태·갱신·철회 | GET /api/channel-accounts/{id}/health, POST …/refresh·/check·/revoke | 비밀 제거, 다른 owner 404, 철회 시 해당 계정 승인 무효. 실제 Threads 는 철회 API 없음 → remote_revoke=unsupported + 로컬 삭제(LIVE-T1). live 준비 설정이 빠져 공급자를 만들 수 없어도 같은 결과(outcome revoked, 감사 live_provider_unavailable=true — FIX2-FULLREV2 G13). 실제 Threads 는 공급자가 있어도 현재 토큰을 복호화하지 않는다 — 키 교체로 저장 토큰을 열 수 없어도 해제·worker 재개가 로컬 삭제로 끝남(G13 fixup) |
| 실제 게시 계정 사용(LIVE-P1, D38) | POST /api/channel-accounts/{id}/publish-target { enabled } | 실제 Threads 계정만(묶임·쓸 수 있는 연결 정보일 때 connected, 사용 중지는 disconnected + 그 계정 활성 승인 철회 — 보내는 중·원격 처리 중·확인 중 항목 포함, 작업 상태는 그대로이고 다음 전송은 다시 승인 필요 — 보내는 중 시도가 보류(즉시 중지·인증 거절)로 끝나면 항목 PLANNED(다시 승인 가능), 스레드 일부가 게시됐으면 UNKNOWN(FIX1-FULLREV2 G8)). 외부 호출 없음. 실제 게시는 PUBLISH_MODE=enabled·PUBLISH_LIVE_APPROVAL_REF·PUBLISH_LIVE_MAX_POSTS·서버 승인(hash)이 모두 있을 때만 |
| 실제 게시 즉시 중지·재개(LIVE-P2, D39) | POST /api/live-publish/pause · POST /api/live-publish/resume { confirm_text: '재개' } | 로그인·같은 출처. owner 당 live_publish_controls 한 행(없으면 중지 아님, 내보내기 제외). 중지는 확인 없이 바로, 재개는 확인 문구 필요. 전송 직전(beginSend) 같은 트랜잭션에서 확인 → BLOCKED live_publish_paused(보내지 않음). 감사 live_publish_paused·resumed. 외부 호출 없음. 최근 24시간 상한 PUBLISH_LIVE_DAILY_MAX(없으면 상한 없음) → BLOCKED live_publish_daily_limit |
| 실제 Threads 계정 행(연결 전) | POST /api/channel-accounts (platform=threads, kind=live) | LIVE-T1(D31): owner 범위·같은 출처·멱등, external_account_id `pending:<uuid>` → 첫 실제 연결이 프로필 ID 로 묶음, state disconnected(게시 불가), 외부 호출 없음 |
| 원격 재확인 | POST /api/distribution-items/{id}/reconcile | 기존 결과 조회만 수행 |
| Threads에서 확인함(LIVEP1-USERCONFIRM) | POST /api/distribution-items/{id}/user-confirm { candidate_external_id } | 결과 불명 실제 Threads 게시(UNKNOWN·RECONCILING, 게시 시도 표식 있음, 결과 없음)의 가장 최근 재확인 후보를 사용자가 직접 확인했다는 기록 — 요청 ID = 그 후보일 때만. 결과 verification USER_CONFIRMED(앱 검증 VERIFIED 아님)·confirmed_by owner·confirmed_at, 작업 CONFIRMED. 외부 호출·재게시 없음, 아니면 409 user_confirm_*. 후보 외부 ID 가 같은 owner 의 다른 항목 결과·다른 작업 게시 기록으로 이미 있으면 409 user_confirm_candidate_claimed(글 하나를 두 항목의 게시로 기록하지 않음 — 작업 처리기의 재확인도 그런 글은 후보로 남기지 않는다, FIX1-FULLREV2 G6) |
| 가져오기 | POST /api/imports/preview, /api/imports/{id}/commit | 범위→차이→확정, 외부 원본 보존 |
| 내보내기 | POST /api/exports | Markdown/JSON/assets, 인증 비밀 제외 |
| 복원 미리보기 | POST /api/restores/preview | 버전·checksum·충돌 검사. add_missing: 승인·작업·전송 의도·원격 결과·원격 단계는 부모(배포 항목·작업·의도)가 이번 복원에서 들어간 행일 때만 넣고, 이미 있던(동일) 부모면 충돌 `existing_parent`(FIX2-FULLREV2 G18 — 기존 항목에 승인을 붙이지 않음, 필요하면 이 환경에서 다시 승인). 복원으로 더 높은 브랜드 프로필 버전이 들어와 현재 브랜드가 바뀌면 이 환경의 기존 활성 승인을 `invalidated:brand_changed` 로 무효(대기 작업 BLOCKED·항목 PLANNED)로 하고 미리보기·결과의 `invalidated_approvals`[{approval_id, item_id, reasons:['brand_changed'], blocked_job_ids, partial_job_ids, leased_partial_job_ids, in_flight, restored_review}]로 보고(G19 — 묶음 승인의 `restore_stale` 철회 `revoked_approvals` 와 따로). 이미 있던(동일) 원고에 위험 표시 '확인 필요' 소재를 잇는 content_captures 행이 들어오면 그 원고의 기존 활성 승인도 `invalidated:risk_needs_check` 로 무효로 하고 같은 `invalidated_approvals` 에 reasons:['risk_needs_check'] 로 보고(G9 fixup, 미리보기는 보고만 — 진행 중 항목도 무효로 함, FIX1-FULLREV3 H2). FIX1-FULLREV3(H3): `partial_job_ids` = 이미 일부가 게시됐거나 게시 시도 표식이 있어 실행 전(PLANNED)이 아니라 UNKNOWN(`thread_partial_revoked`)으로 둔 작업(승인 철회의 `partial_job_ids` 와 같은 뜻 — 다시 게시하지 않음), `in_flight` = 진행 중 항목이라 작업·항목 상태를 그대로 두고 승인만 무효로 함. FIX1-FULLREV3(H3 후속): `leased_partial_job_ids` = lease 만 잡고 보내기 전(LEASED)인데 이미 일부가 게시됐거나 게시 시도 표식이 있는 작업 — 작업은 그대로, 항목은 실행 전으로 두지 않고(QUEUED·RETRY_WAIT 그대로) 그 작업의 다음 전송이 다시 보내지 않고 UNKNOWN 으로 정한다. FIX2-FULLREV3(K2): `restored_review` = 이전 복원의 확인 표시(restored_needs_review)가 있는 보류(BLOCKED) 항목이라 승인만 무효로 하고 항목은 BLOCKED 그대로 둠(실행 전으로 가지 않음 — 다시 승인하면 409 `item_not_planned` — 채널에서 직접 확인해 게시물이 없을 때만 새 계획으로 다시 승인). 옛 미리보기·결과에는 이 칸들이 없다(화면은 []·false 로 읽음). 복원 화면은 "실행 전으로 — 다시 계획·승인"을 나머지 항목에만 쓰고, 부분 게시(UNKNOWN — 게시 채널에서 직접 확인)·보내기 직전 부분 게시(다음 전송이 UNKNOWN 으로 정함)·진행 중(다음 전송은 다시 승인 필요)·이전 복원 확인 표시 보류 항목(`restore-restored-review` — 게시물이 없을 때만 새 계획)을 따로 안내 |
| 로그인(공개 예외) | POST /api/auth/login | 같은 출처(CSRF) 필수. AUTH_MODE=dev(D3): 허용 식별자 1개, localhost 전용, **운영 빌드(NODE_ENV 가 development·test·없음 이외)에서는 서버 시작·설정 읽기·로그인 모두 거부**(503 `dev_login_refused_in_production`, T21-P1a/G1a). 시도 횟수 제한: 최근 15분 실패(식별자 불일치·잘못된 본문) 전체 10회 이상이면 식별자와 무관하게 429 `login_rate_limited`(IP 미사용, 마지막 성공 이전 실패는 세지 않음, `auth.login_denied` 감사 기록으로 셈. 재검사·판정·기록은 전역 advisory 잠금 한 트랜잭션에서 직렬화, 순서는 로그인 순번 `version_or_hash` — FIX-T21P1A). AUTH_MODE=oidc 이면 403 `identity_login_disabled`(T21-P1b — 아래 OIDC 로그인). 설정 때문의 거부(`identity_login_disabled`·`dev_login_not_allowed`·`dev_login_refused_in_production`)는 감사 행을 쓰지 않고 서버 로그에 사유 이름만 1분 1회(FIX2-FULLREV2 G15 — 인증 없는 요청이 audit_events 를 키우지 못하게). 세션은 만들 때의 인증 정책 지문을 저장하고 요청마다 지금 정책과 대조한다(G16) |
| OIDC 로그인 시작(공개 예외) | GET /api/auth/oidc/start | T21-P1b. AUTH_MODE=oidc·준비 상태(아니면 503 `oidc_not_configured`, 빠진 이름은 서버 로그에만) · `Sec-Fetch-Site` 가 있으면 same-origin·none 만(아니면 403 `csrf`) · 전역 시도 제한(429) · discovery(캐시 1시간, 실패 502 `oidc_provider_unavailable`) → `auth_oidc_states` 행(state·결합 쿠키 sha256, PKCE verifier·nonce 봉인, 10분, 1회용, 진행 중 최대 100개 — 넘으면 오래된 것부터 삭제) → 303 IdP 인증 URL(response_type=code, PKCE S256, state, nonce, scope, redirect_uri) + `cs_oidc_flow` 쿠키. 응답에 `Referrer-Policy: no-referrer`·`Cache-Control: no-store` |
| OIDC 로그인 완료(공개 예외) | GET /api/auth/oidc/callback | T21-P1b. 전역 시도 제한 조기 검사(429, state 소비 없음·감사 없음) → `APP_BASE_URL` origin + 요청 path(요청 origin·Host·X-Forwarded-Host 는 쓰지 않음 — 운영 프록시 뒤 request.url 은 서버 자신의 주소, FIX1-FULLREV3 H1) = `OIDC_REDIRECT_URI` 정확 일치 → state 1회용 소비(같은 브라우저 결합 쿠키·10분·설정 지문 — 다른 브라우저면 소비하지 않음) → IdP `error` 면 401 `oidc_cancelled` → openid-client 로 code 교환(PKCE)·ID token 검증(서명 JWKS·iss·aud·exp·iat·nonce) → 허용 신원(`AUTH_ALLOWED_IDENTITY` 명시 시 email+email_verified=true, `AUTH_ALLOWED_SUBJECT` 시 sub) → `withLoginAttemptLock`(T21-P1a 와 같은 전역 잠금·순번) 안에서 재검사 후 세션+`auth.login`{mode:'oidc'} 또는 `auth.login_denied`{reason,check,mode}. reason `oidc_invalid`·`oidc_identity_mismatch` 는 실패 횟수에 포함, `oidc_provider_error`·`oidc_cancelled` 는 제외. `oidc_cancelled` 감사 행은 24시간 창 20개 상한(잠금 안에서 셈, 넘으면 기록 없이 같은 401, 서버 로그는 `login_denied_not_audited: oidc_cancelled` 1분 1회뿐 — 요청마다의 `oidc_login_denied` 줄도 남기지 않음, FIX2-FULLREV2 G15). 세션 행에 인증 정책 지문(`policy_fingerprint`)을 저장(G16). 오류: 400 `oidc_state_invalid` · 401 `oidc_login_invalid` · 403 `oidc_identity_denied` · 502 `oidc_provider_unavailable` · 503 `oidc_not_configured`. 브라우저는 303 `/` 또는 `/login?error=<코드>`. 결합 쿠키는 callback 이 지우지 않음(600초 만료, 재사용은 1회용 state 가 막음 — FIX2-T21P1B) |
| 생존 확인(공개 예외) | GET /api/health | 로그인 없음. 응답은 정확히 `{status:'ok'\|'degraded', app, time_utc, db_ok}`(ok 200, degraded 503). 부작용 없음(worker tick 안 돎). 모드·준비 상태·버전·DB 드라이버·worker 정보 없음(T21-P3) |
| 자세한 상태 | GET /api/health/details | 로그인한 owner 만(없으면 401). 모드·llm/stt 준비 상태(빠진 조건 이름만)·`auth`{mode, oidc_ready, missing(이름만) — T21-P1b}·DB 드라이버/migrated·worker 모드/마지막 tick. 읽기 전용(tick 없음). 운영 숫자는 GET /api/ops/summary |
| 보존 정리 | POST /api/ops/retention | 로그인·같은 출처. `{dry_run:true}` → 200 미리보기(+`plan_fingerprint` — 삭제 대상 작업 ID·배포 파일 ID·내보내기 실행 ID·종류의 정렬 목록 sha256). `{confirm:"yes", plan_fingerprint}` → 적용: 지문 없음·형식 틀림 400 `plan_fingerprint_required`, 트랜잭션 안에서 새로 세운 계획의 지문과 다르면 409 `plan_changed`(아무것도 지우지 않음 — 새 미리보기로), confirm 없음 400 `confirm_required`. 폼은 303 `/ops?retention=applied#retention` 또는 `/ops?error=<코드>`. auto 모드(작업 처리기)는 지문 없이 적용(FIX3-FULLREV2 G30) |
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

