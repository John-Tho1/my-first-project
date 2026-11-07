# Implementation handoff
- Task ID / milestone: T09 (M2) — 채널별 초안(variants) · stale 표시 · 미디어 완성 여부 · 배포 파일 export(ZIP). **파일·미리보기만 — 게시·승인·배포 작업 없음**(PUBLISH_MODE=disabled).
- Purpose and changed behavior:
  - 새 표(migration 0009): `variants`(원고×채널 unique, lifecycle draft|review, current_version_id 앱 검증, owner 복합 FK), `variant_versions`(불변 트리거, unique(variant_id, version), content_version_id = 파생 기준 원고 버전, metadata_json, created_by 'owner'|'ai:…', ai_run_id), `variant_assets`(불변 트리거, unique(variant_version_id, position), role image|video|thumbnail|attachment, 파생본 버전·파일 모두 owner 복합 FK — 이를 위해 `assets_id_owner_uq` 추가). `generation_runs.variant_id`(mode='variant' ⇔ variant_id not null, CHECK) + owner 복합 FK, `claims.variant_version_id`, claims unique 를 (content_version_id, claim_index) → (run_id, claim_index) 로 변경.
  - `@cs/domain/channel.ts`(순수): 채널 모양 결정적 변환(`channelDraft`: threads 문단별 ≤500 코드 포인트·긴 문단 분할·최대 20, instagram 캡션 ≤2200 + 카드 ≤10×≤300, youtube 제목 ≤100 + 설명 ≤5000 + 대본 + 태그, blog 제목 ≤200 + Markdown), 채널별 메타데이터 zod 검증(`parseChannelMetadata`), `isVariantStale`, `mediaCompleteness`(instagram 이미지 ≥1, youtube 영상 정확히 1 — 역할과 실제 형식 image/*·video/* 모두 맞아야 인정), `roleMatchesMime`, 입력 스키마, 오류(`media_incomplete`·`stale_variant`·`conflict`).
  - `@cs/db/variants.ts`: `createVariantDraft`(원고 현재 버전에서, base 불일치 409 stale_base), `runVariantAssist`(모의 AI — 현재 Brand Profile·원고 현재 버전으로 입력 고정, T07 예산 예약·원장·claims(variant_version_id), 결과는 비현재 `ai:mock` 버전, 실패 시 run failed·원장 전액), `appendVariantVersion`(사용자 수정, 원래 원고 버전 유지 → stale 은 수정만으로 안 풀림), `adoptVariantProposal`(제안이 원고 현재 버전에서 나왔을 때만), `setVariantAssets`(목록 전체 교체, owner 파일만·역할/형식·순서 검사), `setVariantLifecycle`(review 조건: 현재 버전·stale 아님·미디어·원고와 파생본의 미해결 경험 claim 없음). 새 현재 버전은 첨부를 이어받고 lifecycle 을 draft 로 되돌린다. 사용자 수정·첨부 변경은 ai_run_id 도 이어받는다(채택한 AI 제안의 claim 게이트 유지). 잠금 순서 원고 → 파생본 → (예약 시) users.
  - `@cs/db/packages.ts`: 배포 파일 ZIP(store-only `writeZip`) — 채널별 현재 버전 `body.txt|.md`·`metadata.json`·`assets.json`·첨부 파일(저장소 sha256 = assets.checksum 일 때만, 아니면 missing + 경고)·`manifest.json`(`is_approval:false`, `is_publication:false`, `publish_mode`, `mock`, 파생본별 stale·미디어·lifecycle, 파일 sha256). 저장 `EXPORT_LOCAL_DIR/packages/<owner>/<id>.zip` — 표 없이 owner 폴더 경로로 범위 강제.
  - T07 코드 정리: 예산 예약·원장 기록/확정을 `budget.ts` 의 `reserveOrThrow`·`insertReservedLedger`·`settleLedgerFailed`·`settleLedgerSucceeded` 로 옮겨 원고 assist 와 채널 AI 초안이 같이 쓴다(동작 동일, 기존 테스트 그대로 통과). `insertClaims` 에 선택 인자 `variantVersionId`.
  - 기존 경로 영향: `listGenerationRuns`(작성실 원고 AI 목록)가 mode='variant' run 을 뺀다. `confirmClaims` 의 'removed' 는 채널 초안 run 이면 그 파생본의 현재 본문에서 검사한다(`variantCurrentBody`). `writingFormFailure` 가 T09 오류 코드를 그대로 전달.
  - API: `GET/POST /api/contents/{id}/variants`, `POST /api/variants/{id}/versions`, `POST /api/variants/{id}/adopt/{versionId}`, `POST /api/variants/{id}/assets`(폼은 한 개 덧붙이기), `POST /api/variants/{id}/lifecycle`, `POST /api/contents/{id}/package`, `GET /api/packages/{id}`. 감사: variant.version_create·assist·adopt_ai·assets·lifecycle, package.create·download.
  - UI: 작성실 "채널 초안" 영역(`variants-panel.tsx`) — 채널별 카드(본문 미리보기·stale 배지·미디어 완성·lifecycle·첨부), 초안 만들기/현재 원문으로 다시 초안/AI 초안(모의, MOCK_WARNING)/AI 초안 채택/편집/미디어 붙이기/검토로, 배포 파일 만들기·목록("배포 파일(수동 게시용). 자동 게시 아님").
- BASE_SHA: bad21ed
- HEAD_SHA: f45072f74553ad6720e5de351bee7f6a276de7ae
- Clean tracked tree confirmed: 아니오 — 커밋 전(추적 16개 수정 + 신규 13개 경로). `.claude/` 는 무관한 기존 미추적 폴더.
- Relevant acceptance IDs: M2 통과 조건 "원본 수정 뒤 기존 파생본은 stale", T09 행(채널별 초안·stale·미디어 완성·배포 파일 export), A03(파생본 검토), A15(채널 AI 초안도 예약), docs/03 "stale 이면 재검토 요구"·"asset 교체는 새 variant version".
- Changed files: DB `packages/db/src/{schema,variants(신규),packages(신규),budget,writing,restore,bundle-tables,queries,index}.ts`, `packages/db/drizzle/0009_t09_variants.sql`(drizzle-kit + 수동: assets_id_owner_uq 를 variant_assets FK 앞으로, 트리거 2개), `meta/0009_snapshot.json`, `meta/_journal.json` · Domain `packages/domain/src/{channel(신규),bundle,index}.ts` · Web `apps/web/lib/{variants(신규),writing}.ts`, `apps/web/app/api/contents/[id]/{variants,package}/route.ts`, `apps/web/app/api/variants/[id]/{versions,adopt/[versionId],assets,lifecycle}/route.ts`, `apps/web/app/api/packages/[id]/route.ts`, `apps/web/app/contents/[id]/{page.tsx,variants-panel.tsx}` · Tests `packages/domain/src/channel.test.ts`(신규 25), `packages/domain/src/{bundle,writing}.test.ts`(픽스처에 빈 표 3개·variant_id:null 만 추가), `tests/integration/variants.test.ts`(신규 13) · Docs `docs/DECISIONS.md` D14, `README_KO.md` T09 절.
- Migrations / restore implications: 0009 는 새 표 + 열 추가 + claims unique 교체 + generation_runs mode CHECK 교체(기존 행은 mode 가 outline/draft/revise, variant_id null 이라 새 CHECK 통과). EXPORTED 순서: content_captures 다음 variants·variant_versions(generation_runs·claims 보다 먼저), assets 다음 variant_assets. PARENTS: variants→contents(owned), variant_versions→variants(owned)·content_versions, variant_assets→variant_versions(owned)·assets. 복원 사후 처리: 이번에 넣은 파생본의 current_version_id 를 원고처럼 나중에 연결(버전이 안 들어가면 전체 중단), variant_versions.ai_run_id 의 run 이 inserted/same 이 아니면 전체 중단(T06 FIX 규칙 확장). checkIntegrity: 파생본·버전·run·claims·첨부의 같은 원고/같은 파생본 관계. 0009 이전 묶음은 새 표를 빈 표로, generation_runs.variant_id·claims.variant_version_id 를 null 로 읽는다. 배포 파일 ZIP 은 DB 기록이 없어 묶음에 들어가지 않는다. 실행 중인 dev 서버는 재시작하면 0005–0009 를 자동 적용한다(이 작업에서는 ./data/pglite 에 아무것도 실행하지 않음).
- Actual commands and results (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0, pnpm 12.6.0):
  - 기준선(bad21ed): `pnpm test` 20 files / 323, `pnpm test:integration` 14 files / 172
  - `cd packages/db && pnpm exec drizzle-kit generate --name t09_variants` → 0009 생성(DB 연결 없음), SQL 수동 수정
  - `pnpm lint` → pass / `pnpm typecheck` → pass
  - `pnpm test` → pass, 21 files / 348 tests
  - `pnpm test:integration` → pass, 15 files / 185 tests
  - `pnpm build` → pass
  - 수동 확인: 메모리 DB 로 `next start -p 3100`(별도 프로세스) + curl — 로그인·브랜드·원고 → threads 초안 폼 303 → AI 초안(모의) 폼 303 → 배포 파일 폼 303 → 작성실 HTML 에 "채널 초안"·버전·미디어 준비됨·편집(JSON)·"모의 응답: 실제 AI 호출 아님 — AI 초안(모의, 버전 2)은 채택하기 전까지 현재 초안이 아닙니다"·"배포 파일(수동 게시용). 자동 게시 아님"·배포 파일 목록 확인 후 프로세스 종료. 브라우저 클릭 E2E not_run.
- Demo route / local start steps: dev 서버 재시작 → 작성실 → "채널 초안"에서 초안 만들기 → 소재함에서 이미지를 올린 뒤 Instagram 에 "미디어 붙이기" → "검토로" → 원고 본문 저장 후 stale 배지 확인 → "현재 원문으로 다시 초안" → "배포 파일 만들기(ZIP)" → 내려받기.
- External calls performed (exact scope, or none): none. 새 의존성 0, 비밀 0, 게시 0(채널 어댑터·OAuth·배포 작업 표 없음).
- Mock-only functionality: AI 초안(모의 provider — 채널 모양은 모의 제안 문장을 결정적 변환으로 감싼 것). 영상 파일은 업로드 경로가 없어 테스트에서 DB 에 직접 넣은 video/mp4 행으로만 YouTube 미디어 완성을 확인했다.
- Known risks / not run:
  - **YouTube 파생본은 실제로는 검토로 갈 수 없다** — 업로드 허용 형식에 영상이 없다(D14 사용자 결정 필요).
  - 채널 한도·모양은 잠정값(공식 자료 재확인 전). 글자 수는 코드 포인트 기준이라 플랫폼의 실제 계산(예: 이모지·URL 가중치)과 다를 수 있다.
  - 원고가 바뀌어도 이미 review 인 파생본은 review 로 남는다(stale 로만 표시, 차단은 M3 배포 작업에서).
  - 배포 파일은 표가 없어 목록이 파일 시스템(mtime) 기준이며 자동 정리·보관 기한이 없다. ZIP 작성 후 감사 기록이 실패하면 파일만 남는다.
  - 채널 AI 초안의 claim 은 파생본 검토 게이트에만 걸린다(원고 `ready` 게이트 무관). 채널 AI 초안 화면에는 claim 확인 버튼이 없다(API `POST /claims/confirm` 는 run_id 로 동작).
  - 수동 복사 A03 우회(T06, 사용자 결정 필요)는 채널 초안 편집에도 그대로 해당한다(편집 본문에 경험 문장을 직접 넣으면 추적하지 않음).
- Questions specifically for Codex:
  1. stale 파생 판정: `current.content_version_id ≠ content.current_version_id` 만으로 충분한가? 사용자 수정(원래 원고 버전 유지)·첨부 변경(현재 버전 복사)·AI 제안 채택(제안의 원고 버전) 각각이 stale 을 부당하게 풀거나 남기는 경로가 있는가? 원고 복원·채택으로 current_version_id 가 "과거와 같은 본문의 새 버전"이 되는 경우는?
  2. 미디어 완성 우회: 역할/형식 검사를 `setVariantAssets` 에서만 하고, review 판정은 `attachedAssets` 의 실제 mime 으로 다시 계산한다. 파일 행(assets.mime)이 복원·가져오기로 달라지거나, review 이후 첨부가 바뀌는 경로(새 버전 → draft 로 되돌림)에서 미완성 파생본이 review 로 남을 수 있는가?
  3. 배포 파일 무결성: 첨부는 저장소 바이트 sha256 = assets.checksum 일 때만 넣고 manifest 가 모든 파일 sha256 을 담는다. 경로(`<channel>/assets/<순서>-<역할>.<ext>`)·ZIP 경로 안전성, 누락 파일 처리(missing+경고 vs 실패), manifest 의 `is_approval:false` 등 표시로 "승인 아님"이 충분히 드러나는가?
  4. owner 격리: variant_assets 는 (variant_version_id, owner_id)·(asset_id, owner_id) 복합 FK, 배포 파일은 owner 폴더 경로. 파생본·버전·run·claims 의 교차 원고/교차 owner 참조가 DB·앱·복원 검사 어디서든 새는가(특히 generation_runs.variant_id 가 같은 원고의 파생본인지 DB 가 강제하지 않는 점)?
  5. A03 on variants: 파생본 review 는 원고의 미해결 claim + 파생본 현재 버전의 ai_run 미해결 claim(파생본 본문 기준 'removed')을 본다. 사용자 수정·첨부 변경은 ai_run_id 를 이어받아 게이트가 유지된다. "원문에서 다시 초안"(결정적 변환)은 ai_run_id 를 끊는데, 이것이 채택한 AI 제안의 미해결 claim 을 합법적으로 없애는 경로로 괜찮은가(새 본문이 원고에서 새로 나온 것이므로)?
- Next authorized task: T08(음성 전사 job·업로드 진행·fallback — 모의까지) 또는 Codex 지적 처리. 게시·승인(M3)은 범위 밖.

---

# FIX round 1 (Codex review-T09)
- Review: `.handoffs/review-T09.md` (CHANGES_REQUESTED, 1×P0 + 3×P1 + 2×P2, review HEAD f45072f)
- BASE_SHA: 5705445 (T07 FIX 커밋 위)
- HEAD_SHA: TBD (orchestrator commits)
- Migration: `0011_t09_fix_proposals.sql`(+ `meta/0011_snapshot.json`, journal idx 11) — `generation_runs.proposal_status`(proposed|adopted|dismissed, CHECK) + 기존 채택 run(ai_run_id 를 가진 사용자 원고·파생본 버전) 'adopted' 채움(수동 추가).

| Finding | Change | Test |
| --- | --- | --- |
| P0 writing.ts:738 — 메타데이터에 남은 경험 주장을 removed 처리 | `@cs/domain renderVariantText`(채널별 모든 노출 글)로 `variantCurrentBody`('removed' 검사)·`unresolvedVariantClaims`(파생본 검토 게이트) 판정, 배포 파일에 `<channel>/output.txt`(같은 글)·manifest `output_text_sha256`. 사용자 수정은 본문 중복 칸(threads 이어지는 글·text / instagram 캡션 / youtube 대본 / blog Markdown)이 본문과 다르면 400 `metadata_body_mismatch`(`variantBodyMismatch`) — 서버 재생성 대신 거부를 택함(D14) | integration "P0: 경험 문장을 본문(캡션)에서만 빼고 카드에 남기면 removed 409·검토 409, 카드에서도 빼면 둘 다 통과"(output.txt 내용까지), "P0: … 400 metadata_body_mismatch"; unit channel.test 2개 |
| P1 bundle.ts:917 — ai_run_id 가 같은 파생본인지 미검사 | checkIntegrity: 파생본 버전 ai_run_id → 같은 파생본의 mode='variant' run(ai:* 버전의 ai_run_id 누락도 거부), 원고 버전 ai_run_id → 원고 run, claims.variant_version_id → 그 run 의 제안 버전(같은 파생본·ai_run_id·input_version), 원고 claim → run.output_ref. 복원 사후 검사(inserted/same run)는 그대로 — 'same' run 은 묶음 행과 값이 같아 묶음 검사가 곧 DB 검사 | unit writing.test "Threads 버전이 같은 원고의 Blog run 을 가리키면 integrity 거부"; integration "P1: 묶음의 Threads 버전 ai_run_id 를 … Blog run 으로 바꾸면 복원 미리보기 거부" |
| P1 restore.ts:222 — 미디어 없는 review 복원 | `applyBundle` 끝에서 이번에 넣은 review 파생본을 복원된 행으로 재검사(현재 버전 없음·stale·`mediaCompleteness(attachedAssets)`) → draft 로 낮추고 `downgraded_variants`({variant_id, channel, reasons}) 를 미리보기·커밋 결과에 | integration "P1: 첨부 없는 review Instagram 파생본을 복원하면 draft 로 …"; 기존 왕복 테스트는 stale review 파생본이 draft 로 낮아지는 것을 명시적으로 기대하도록 바꿈(나머지 행은 그대로 비교) |
| P1 variants.ts:674 — 미채택 제안이 뒤의 수정 후 숨음 | `proposal_status`: 파생본 제안 목록 = proposal_status='proposed' 인 성공 run 의 제안 버전(최근 run), 채택 시 'adopted'(행 잠금, 이미 채택·무시 → 409), `dismissProposal` + 라우트 2개(파생본·원고), 원고 채택도 무시한 run 은 409(재채택은 기존대로 stale_base 가 먼저). 작성실 원고 패널 "무시"는 이제 실제 무시(POST), 파생본 카드에 "무시" 버튼 | integration "P1: 미채택 AI 제안은 뒤의 수정·첨부 후에도 …(무시하면 사라지고 무시한 제안 채택 → 409, 다른 owner 404)", "P1: 원고 AI 제안도 무시하면 채택 불가"; migration "0011: …" |
| P2 assets route:33 — 폼이 첨부 상한 우회 | 폼으로 만든 전체 목록을 `variantAssetsSchema` 로 검사, `setVariantAssets` 도 개수 ≤ `MAX_VARIANT_ASSETS`(20)·position 1..`MAX_ASSET_POSITION`(50) 검사 | integration "P2: 폼 첨부도 개수 20·순서 50 상한(DB 함수도 검사)" |
| P2 page.tsx:72 — 다른 원고의 배포 파일 표시 | 저장 경로 `packages/<owner>/<content>/<id>.zip`, `listPackages(…, contentId)`, 내려받기는 `findPackageZip`(owner 폴더 안 원고 폴더들 + T09 첫 경로), 패널 제목에 원고 제목 | integration "P2: 작성실 배포 파일 목록은 그 원고의 것만"; 기존 ZIP 테스트의 저장 위치 단언을 새 경로로 |

- Actual commands and results (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0):
  - 기준선(5705445): `pnpm test` 21 files / 354, `pnpm test:integration` 15 files / 191
  - `cd packages/db && pnpm exec drizzle-kit generate --name t09_fix_proposals` → 0011(DB 연결 없음), 채움 UPDATE 수동 추가
  - `pnpm lint` → pass / `pnpm typecheck` → pass
  - `pnpm test` → 21 files / 357 tests pass
  - `pnpm test:integration` → 15 files / 200 tests pass
  - `pnpm build` → pass
- Known risks (추가):
  - 본문 중복 칸 불일치는 사용자 수정에서만 거부한다. 결정적 초안·AI 제안은 `channelDraft` 가 둘을 같게 만든다(단위 테스트로 확인).
  - 복원 downgrade 는 lifecycle 을 바꾸므로, 같은 묶음을 다시 add_missing 하면 그 파생본은 'different' 충돌로 보고된다.
  - 복원 downgrade 는 A03 claim 을 검사하지 않는다(review 를 다시 요청할 때 게이트가 건다).
  - T09 첫 경로(`packages/<owner>/<id>.zip`)의 배포 파일은 내려받기는 되지만 원고별 목록에 나오지 않는다.
- Questions specifically for Codex (FIX round 1):
  1. `renderVariantText` 가 모든 사용자 노출 글을 담는가(예: instagram 카드 index, youtube 태그 외 다른 칸, 앞으로의 필드)? 'removed' 검사가 합친 글에서 문장 경계를 넘는 우연한 일치(예: 캡션 끝 + 카드 시작)로 거짓 양성을 낼 수 있는가?
  2. `proposal_status` 전이: 채택(행 잠금 후 'proposed' 확인 → 'adopted')·무시(행 잠금 → 'dismissed')·원고 채택의 stale 검사 순서가 경합(동시 채택·무시)과 복원(묶음의 'adopted'/'dismissed' 를 그대로 신뢰)에서 일관적인가? 묶음의 proposal_status 가 버전 행(채택 버전 존재 여부)과 모순되면 거부해야 하는가?
  3. 복원 downgrade: stale·미디어 부족만 보고 draft 로 낮추는 것(거부 대신)이 docs/03 의 "stale 이면 재검토" 요구에 맞는가? 기존 행('same')이 review 로 남아 있는 add_missing 경로는 검사하지 않는데 문제인가?

---

# FIX round 2 (Codex review-FIX-T09)
- Review: `.handoffs/review-FIX-T09.md` (CHANGES_REQUESTED, 3×P1 + 1×P2)
- BASE_SHA: ef8bbc7 (T07 FIX round 2 커밋 위)
- HEAD_SHA: TBD (orchestrator commits)
- Migration: 없음.

| Finding | Change | Test |
| --- | --- | --- |
| P1 bundle.ts:249 — 0011 이전 묶음의 채택 제안이 proposed 로 복원 | 행 스키마의 `proposal_status` 를 선택 칸으로, `fillProposalStatus` 가 채택 이력(ai_run_id 를 가진 created_by='owner' 원고·파생본 버전)으로 'adopted'/'proposed' 채움(migration 0011 과 같은 규칙). checkIntegrity: 'adopted' 인데 채택 버전 없음, 채택 버전 있는데 'proposed'/'dismissed' → integrity | unit writing.test "0011 이전 묶음(상태 없음) …", "명시한 상태가 채택 이력과 모순이면 integrity 거부"(FIX-T06 픽스처는 채택 이력과 맞게 상태만 맞춤 — 단언 동일) |
| P1 restore.ts:306 — 복원 review 파생본에 claim 게이트 없음 | `variantReviewBlockers(tx, owner, variantId)`(variants.ts): 현재 버전 없음·stale·미디어 부족·미해결 경험 claim(원고 게이트 + 파생본 채택 run, `renderVariantText`, 복원된 claim_confirmations). 복원 사후 검사가 이 함수를 써서 draft 로 낮추고 `unresolved_claims` 등 이유 기록 | integration "P1 복원 claim 게이트: 본문에서만 빠지고 카드에 남은 경험 문장 … unresolved_claims" |
| P1 restore.ts:299 — add_missing 이 동일 버전에 첨부 추가 | 동일('same') 파생본 버전을 가리키는 새 variant_assets 행은 삽입하지 않고 `immutable_version` 충돌(재검증 대신 거부 — D14) | integration "P1 add_missing: 이미 있는(동일) 파생본 버전에 첨부를 … immutable_version 충돌, 첨부·review 그대로"(YouTube 영상 2개 시나리오) |
| P2 writing-panel.tsx:224 — 채택 불가 제안은 무시 버튼 없음 | `apps/web/lib/proposals.ts proposalActions`(순수): 무시 = 성공한 'proposed' run 이면 항상, 채택 = 그중 현재 원고 버전 기준·미채택. 작성실 패널은 무시 버튼을 채택 폼 밖에 따로 표시. 파생본 카드는 이미 채택 가능 여부와 무관하게 무시 버튼 표시 | unit `apps/web/lib/proposals.test.ts` 3개 |

- Actual commands and results (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0):
  - 기준선(ef8bbc7): `pnpm test` 21 files / 363, `pnpm test:integration` 15 files / 205
  - `pnpm lint` → pass / `pnpm typecheck` → pass
  - `pnpm test` → 22 files / 368 tests pass
  - `pnpm test:integration` → 15 files / 207 tests pass
  - `pnpm build` → pass
- Known risks (추가):
  - 채택 이력 판정은 "ai_run_id 를 가진 사용자 버전"이다. 파생본의 사용자 수정·첨부 변경도 ai_run_id 를 이어받으므로 같은 run 의 채택으로 본다(정상 경로에서는 채택 뒤에만 생긴다).
  - 복원 사후 검사는 이번에 넣은 review 파생본만 본다. 이미 있던(동일) review 파생본은 그 환경에서 이미 검사된 상태로 간주한다.
- Questions specifically for Codex (FIX round 2):
  1. `fillProposalStatus`·모순 검사: 채택 판정을 created_by='owner' ∧ ai_run_id 로 하는 규칙이 실패·미완료 run(status≠succeeded)·채널 초안의 결정적 재생성(ai_run_id 끊김) 조합에서 거짓 거부를 낼 수 있는가?
  2. `immutable_version` 거부의 범위: variant_assets 외에 동일(불변) 버전에 새 자식이 붙는 표(claims.variant_version_id, claim_sources 등)가 add_missing 에서 게이트 조건을 바꿀 수 있는가?
  3. 복원 사후 검사에서 원고 게이트(`listUnconfirmedExperienceClaims`)가 복원된 원고 버전·확인 행만으로 계산되는가, add_missing 으로 이미 있던 원고에 새 채택 버전이 붙는 경우 원고 lifecycle(`ready`)도 다시 검사해야 하는가?
