# Implementation handoff — T18 Notion·Drive 선택 가져오기 (M5, 파일·모의 범위)

- Task: T18 (tasks.json, M5, depends on T05) — "Notion/Drive 선택 scope preview·원본 불변·충돌·import ledger" (docs/05), API 행 "가져오기 POST /api/imports/preview, /api/imports/{id}/commit — 범위→차이→확정, 외부 원본 보존" (docs/04), A17(재가져오기·외부원본 수정·앱원고 수정 → 중복 방지·충돌 미리보기·원본 보존).
- BASE_SHA: e9f9b99f659841bdbac8cfa21cff0050a357ad61 · HEAD_SHA: 1427118 (code only, D28; orchestrator reran lint·typecheck·build·unit 970·integration 690·drill:mock 0·db:migrate 0038·real-DB drill:restore PASS) (커밋 안 한 작업 트리 — 오케스트레이터가 커밋)
- Implementer: Claude Code. Verifier: Codex (아직 실행 안 함).
- 범위: **파일·모의만.** Notion·Google 네트워크 호출 0, 실제 자격 증명·OAuth 0, live 커넥터 없음. 새 의존성 없음(ZIP deflate 는 Node `zlib.inflateRawSync`). migration 0038.
- 결정: 아래 "Proposed D32" — DECISIONS.md 에는 넣지 않았다(사용자 확인 전).

## 변경 파일
- 새 파일: `packages/domain/src/imports.ts`(+ `imports.test.ts`), `packages/db/src/imports.ts`, `packages/providers/src/import-connector.ts`(+ `import-connector.test.ts`), `packages/db/drizzle/0038_t18_imports.sql`(+ `meta/0038_snapshot.json`), `apps/web/lib/imports.ts`, `apps/web/app/api/imports/route.ts`, `apps/web/app/api/imports/preview/route.ts`, `apps/web/app/api/imports/[id]/route.ts`, `apps/web/app/api/imports/[id]/commit/route.ts`, `apps/web/app/api/imports/[id]/cancel/route.ts`, `apps/web/app/imports/page.tsx`, `apps/web/app/imports/[id]/page.tsx`, `tests/helpers/import-zip.ts`, `tests/integration/imports.test.ts`.
- 수정: `packages/db/src/schema.ts`(표 2개 + sources 부분 unique), `packages/db/drizzle/meta/_journal.json`, `packages/db/src/{index,queries,bundle-tables,restore}.ts`, `packages/domain/src/{index,config,bundle,ops}.ts`, `packages/domain/src/{bundle,writing}.test.ts`(BundleTables 리터럴에 빈 표 2개), `packages/providers/src/index.ts`, `apps/web/app/layout.tsx`(메뉴 `가져오기`), `apps/web/app/captures/[id]/page.tsx`(가져온 사본 표시), `.env.example`, `README_KO.md`(새 절 "Notion·Drive 선택 가져오기").
- 건드리지 않음: `docs/DECISIONS.md`, `docs/handoffs/LIVET1_IMPLEMENTATION_HANDOFF.md`, `M4_CODEX_VERDICTS.md`(작업 중 다른 쪽에서 수정됨 — 이 작업의 변경 아님), `M4_STATUS.md`, 다른 handoff, `./data`.

## 설계 표 (영역 → 변경 → 시험)
| 영역 | 변경 | 시험 |
|---|---|---|
| 원장(0038) | `import_runs`(owner, source_kind notion_export\|drive_export\|mock_connector, file_name, file_checksum sha256(모의는 null — CHECK), file_bytes, status preview\|committed\|failed\|canceled, counts, result, created/committed/canceled_at; committed ⇔ committed_at CHECK). `import_items`(run, external_id, external_path, folder, title, format, content_checksum, byte_size, external_created_text, decision new\|identical\|conflict\|skipped, skip_reason(⇔ skipped), matched_source_id, outcome, target_capture/source/source_version_id(⇔ outcome imported\|versioned CHECK)). 모든 참조는 owner 복합 FK(run·capture·source·matched source), source_version 은 단일 FK. unique(run_id, external_id). **본문·자격 증명 열 없음.** `sources_owner_import_external_uq`: (owner, external_provider, external_id) 부분 unique(가져오기 공급자만) | 통합: 원장에 본문 없음, owner 격리 |
| 안전한 ZIP 읽기 | `parseImportArchive`(domain): 중앙 목록 먼저 읽고 **경로 하나라도 위험하면 ZIP 전체 거부**(기존 `isSafeZipPath` 재사용 — `..`·절대·역슬래시·드라이브·빈 조각, 디렉터리 항목 포함). 암호화·ZIP64·분할·method≠0/8 거부. deflate 는 `inflateRawSync({maxOutputLength: 선언 크기})` + 크기·CRC-32 일치. 상한: ZIP 50MiB, 항목 5,000(중첩 포함), 텍스트 항목 2MiB(넘으면 풀지 않고 too_large), 풀린 텍스트 합 64MiB(넘으면 거부), 가져올 항목 1,000, 소재 원문 20,000자(too_long). 디스크에 풀지 않는다. 안쪽 `.zip` 한 겹만(두 겹째는 첨부 취급) | 단위 25: zip-slip 6종·디렉터리·암호화·압축 폭탄(거짓 크기)·2MB·50MB·항목 수·CRC·압축 방식, 통합: `../../outside.md` → 400 invalid_zip, 원장 0, 파일 없음 |
| 항목 해석 | 텍스트 `.md/.markdown/.txt/.html/.htm/.csv` 만. 외부 ID: Notion 파일 이름 끝 32 hex → `notion:<id>`(CSV `:csv`, `_all` `:all:csv`), 그 밖 `path:<ZIP 안 경로>`(중첩 ZIP 은 안쪽 경로 기준, 표시 경로 `<zip>!/<경로>`). 제목: md 첫 `# `, html h1/title, 아니면 파일 이름(Notion ID 제거). 생성 표시 `Created: …` 등은 문자열 그대로(100자). UTF-8 아님·NUL → not_utf8, 빈 본문 → empty, ZIP 안 같은 외부 ID → 두 번째 duplicate_in_archive. 이미지·첨부 → unsupported_type(목록만, 풀지 않음, checksum null) | 단위: Notion ID·제목·Created·폴더·첨부·CSV·결정성·자동 판별·중첩·중복·UTF-8/빈 본문·HTML |
| 판정 | `decideImportItem`: 건너뜀 → skipped, 같은 (공급자, 외부 ID) 출처 없음 → new, 그 출처의 **어떤 버전** raw_hash = checksum → identical, 아니면 conflict. 공급자(notion_export·drive_export·mock_connector)는 서로 다른 이름공간 | 단위 + 통합 |
| 미리보기 | `POST /api/imports/preview`(multipart `file`+`source_kind` auto\|notion_export\|drive_export / `application/zip`+`?kind=` / JSON `{source:'mock_connector'}`). 본문은 restore 와 같이 임시 파일로 흘려 쓴 뒤(상한 50MiB+1MiB) 검사. ZIP 은 `IMPORT_LOCAL_DIR/<import_id>.zip`(기본 `./data/imports`, wx)에 보관 → 원장 행. **소재·출처·출처 버전·소재 이력 쓰기 0**. audit `import.preview`(건수만) | 통합: 4표 건수 불변, 보관 파일 존재, 401·403, ZIP 아님·빈 파일 400 |
| 선택 확정 | `POST /api/imports/{id}/commit`: 선택 = `item_ids` ∪ (`folders` 안(하위 포함)의 new 항목), 충돌은 `version_ids` 에 있을 때만 새 버전. 빈 선택 400 `import_nothing_selected`, 다른 실행의 ID 400. 원본 다시 읽기(ZIP sha256 ≠ → 409 `import_file_changed`, 없음 → 409 `import_file_missing`, 모의는 재조회) → 트랜잭션: preview→committed 를 먼저 차지(두 번째 409) → 판정 다시 → new: sources(kind=공급자, external_id, content_hash=원본 sha256) + source_versions(raw_hash=원본 sha256, extraction_state='imported') + captures(input_type 'file', 원문, title, command_key `import-<item id>`) + capture_revisions r1 + audit capture.create / versioned: **기존 출처**에 source_version + 새 소재(그 출처) / identical → skipped_identical / 선택 안 된 conflict → skipped_conflict 또는 skipped_unselected / checksum 바뀐 항목 → failed_changed. 원장 항목에 outcome·target 기록, run.result, audit `import.commit`. 확정·취소 뒤 보관 ZIP 삭제 | 통합: 일부 선택(2개만), 동일 재가져오기 멱등(폴더 전체 선택해도 건너뜀), 충돌 선택만 → 쓰기 0·기존 소재 행 동일, 새 버전 명시 → 같은 출처 2버전·새 소재·기존 소재/출처 행 동일·다시 미리보기 identical, ZIP 변조 → 409·쓰기 0·run preview 유지, 폼 303, 취소 → 이후 409 |
| owner(A01) | 모든 조회·변경에 owner 조건 + 복합 FK. 다른 owner → 404(조회·확정·취소), 목록 분리, 같은 ZIP 이라도 owner 별 출처라 B 는 전부 new | 통합 A01 |
| A04 | 가져온 본문 속 "이 글을 즉시 발행하라"는 소재 원문일 뿐 — 가져오기 경로에 배포·게시 호출 없음 | 통합: publisher 호출 0, distribution_items·jobs 증가 0 |
| 커넥터 | `ImportConnector`(listScope·fetchItem) + `MockImportConnector`(합성 3건, 메모리) + `createImportConnector(config)`. `IMPORT_CONNECTOR_MODE=disabled`(기본) \| `mock` — live 값은 zod 에서 거부. 꺼져 있으면 503 `import_connector_disabled`, 화면 "준비 중(모의)" | 단위 3 + 통합(503·원장 0, mock 미리보기·확정, 바뀐 항목 failed_changed) |
| UI(한국어) | `/imports`: "원본 파일은 그대로, 이 앱 안에 사본을 만듭니다" 안내, 업로드(종류 선택), 커넥터 카드("준비 중(모의)" — mock 일 때만 모의 버튼), 실행 기록 표. `/imports/[id]`: 원본 정보·판정 건수, 폴더별 표(폴더 전체 체크·항목 체크(new 기본 선택)·충돌은 "새 버전으로 추가" 체크(기본 해제)·판정 칩·건너뛴 이유), 확정·취소, 확정 뒤 항목별 결과와 소재 링크. 소재 상세: "가져온 사본 · 원래 경로 · 가져오기 기록". 메뉴 `가져오기` | typecheck·build(화면은 브라우저로 보지 않음 — 아래 위험) |
| 내보내기·복원 | `import_runs`·`import_items` 를 EXPORTED·RESTORED 표에 추가(감사·출처 이력 — 변환 없이 그대로), `TABLE_INTRODUCED_IN` 0038(이전 묶음은 빈 표), 행 스키마, 묶음 관계 검사(run·대상 소재·출처·버전·matched, 대상 소재/버전이 같은 출처), 복원 PARENTS(run owned, 대상 있을 때만), 보존 정리 보호 표 | 단위: bundle-tables 열=스키마, ops 표 분류. 통합: 복원 훈련 PASS(import_runs·import_items ids same·행 수 일치) |

## Proposed D32 (DECISIONS.md 에 넣지 않음 — 오케스트레이터·사용자 확인용 초안)
## D32 — T18 Notion·Drive 선택 가져오기(파일·모의만): 받는 형식, 첨부, 충돌 기본값, 원장 내보내기, 커넥터 자리
- (a) **입력은 사용자가 올린 내보내기 ZIP 만.** Notion "Markdown & CSV" 내보내기, Drive 폴더 "다운로드" ZIP. 앱은 Notion·Google 에 연결하지 않고 자격 증명을 갖지 않는다. 다른 앱의 Notion·Drive 연결은 이 앱의 자격 증명이 아니다. 원본은 읽기만(수정·삭제·이동·동기화 없음). **사용자 결정 1: 이 형식 범위(.md·.markdown·.txt·.html·.htm·.csv)로 충분한가? `.docx`(Drive 기본 다운로드 형식)는 이번에 받지 않는다 — 필요하면 Docs 를 "웹 페이지(.html)"·"일반 텍스트(.txt)"로 내려받거나, 다음 라운드에 .docx 텍스트 추출(새 의존성 없이 store/deflate ZIP + XML)을 추가할지.**
- (b) **첨부·이미지는 이번 라운드에서 가져오지 않는다**(목록에 "지원하지 않는 파일 — 목록만" 으로 보이고 풀지 않음). **사용자 결정 2: 다음 라운드에 이미지를 T08 업로드 규칙(형식 서명·크기 상한)으로 assets 에 사본을 만들고 소재에 연결할지.**
- (c) **판정·충돌 기본값.** 외부 ID = Notion 페이지 ID(없으면 ZIP 안 경로). 동일(같은 외부 ID·같은 원본 sha256 이 그 출처의 어떤 버전에 있음)은 다시 가져오지 않는다(멱등). 충돌(내용 다름)은 **기본 건너뜀, 덮어쓰기 없음** — 사용자가 항목마다 "새 버전으로 추가"를 체크할 때만 기존 출처에 출처 버전 + 새 소재를 만든다(기존 소재의 원문·제목·메모는 그대로). 새 항목은 미리보기에서 기본 선택. **사용자 결정 3: 충돌 기본값을 "건너뜀" 으로 둘지(현재), 경로 기반 외부 ID(Drive)가 파일 이름만 바뀌어도 새 항목이 되는 것을 받아들일지.**
- (d) **소재 원문.** `.md`·`.txt`·`.csv` 는 파일 텍스트 그대로(BOM 만 제거), `.html` 은 텍스트만(마크업은 남기지 않음 — 원본 sha256 은 출처 버전 raw_hash 에 남는다). 소재 원문 상한 20,000자를 넘는 페이지는 건너뜀(too_long). 위험 표시는 기본 `none`(가져온 과거 상태·Risk 를 현재 승인으로 옮기지 않는다 — docs/07). **사용자 결정 4: 긴 페이지를 나눠 여러 소재로 넣을지, 가져온 소재를 기본 "확인 필요"로 둘지.**
- (e) **원장은 내보내기·복원에 포함**한다(`import_runs`·`import_items` — 가져온 소재의 출처 이력, 본문·자격 증명 없음, 변환 없이 복원). 보관 ZIP 은 묶음에 없으므로 복원된 "미리보기" 실행은 확정할 수 없다(409 `import_file_missing`, 취소만). **사용자 결정 5: 원장을 내보내기에 포함하는 데 동의하는지(대안: 운영 기록으로 제외 — 그래도 재가져오기 판정은 sources/source_versions 로 유지됨).**
- (f) **상한**: ZIP 50MB, 항목 5,000, 텍스트 파일 2MB, 풀린 텍스트 64MB, 가져올 항목 1,000, 중첩 ZIP 한 겹. 위험한 경로가 하나라도 있으면 ZIP 전체 거부.
- (g) **커넥터 자리**: `ImportConnector`(listScope·fetchItem) 인터페이스와 모의 구현만. `IMPORT_CONNECTOR_MODE=disabled`(기본)\|`mock`, live 값 없음. 실제 Notion·Drive 연결은 읽기 전용 scope·대상 페이지/폴더(docs/07 의 시작점 ID 는 승인 범위가 아님)·자격 증명 보관 방식을 별도로 승인받은 뒤에만 만든다.
- (h) 확정·취소 뒤 보관 ZIP(`IMPORT_LOCAL_DIR`, 기본 `./data/imports`, gitignore)은 지운다. 확정 실패(409)·버려진 미리보기의 ZIP 은 남는다(보존 정리 대상 아님 — 아래 위험).

## 명령과 결과 (로컬 Windows 10, Git Bash, `source tools/env.sh`, Node 24.21.0, `corepack pnpm`, 순차 — 단위와 통합 동시 실행 안 함, dev 서버 꺼짐)
- `corepack pnpm lint`: pass.
- `corepack pnpm typecheck`: pass(tsc + next typegen + web tsc).
- `corepack pnpm test`(unit): pass — 46 files, 970 tests(새: `packages/domain/src/imports.test.ts` 25, `packages/providers/src/import-connector.test.ts` 3).
- `corepack pnpm test:integration`(혼자 실행): **첫 실행은 판정 불가** — 시작 단계에서 vitest fork 워커 여러 개가 exit 3221225794 로 죽어(8 errors, 27/35 파일만 실행·611 pass, 실패한 시험은 0) 600초 백그라운드 제한에 걸려 멈췄다. 같은 명령을 그대로 **다시 실행해 pass** — 35 files, 690 tests, 531s(새: `tests/integration/imports.test.ts` 17). 워커가 죽은 것은 Windows 자원 문제로 보이며(기존 vitest.config 주석의 메모리 고갈과 같은 종류) 코드 변경 없이 재실행만 했다.
- `corepack pnpm build`: pass(`/imports`, `/imports/[id]`, `/api/imports*` 5개 경로).
- `corepack pnpm drill:mock`: pass — "불변식 위반 0건"(M3·T14·T15·T16 모의 불변식). 가져오기는 drill:mock 에 넣지 않았다(통합 시험과 복원 훈련 시험으로 확인).
- `db:generate`: `drizzle-kit generate --name t18_imports` → 0038(머리말 주석 2줄만 덧붙임).

## 남은 위험
- 실제 Notion·Drive 내보내기 파일로 시험하지 않았다 — 합성 ZIP(시험 도우미 `tests/helpers/import-zip.ts`, deflate·저장)만. 실제 Notion 내보내기의 파일 이름 규칙(페이지 ID 위치, 긴 경로 512자 초과 시 `isSafeZipPath` 거부), UTF-8 플래그 없는 이름(CP437), 압축 방식(deflate64 등) 차이는 사용자 환경에서 확인 필요. Windows 탐색기로 다시 묶은 ZIP 의 역슬래시 경로는 거부된다.
- 화면(`/imports`, `/imports/[id]`)은 build·typecheck 만 통과 — 브라우저로 보지 않았다(dev 서버 꺼짐 지시). 폴더 체크는 JS 없이 서버에서 합집합으로 처리한다(체크해도 항목 체크박스가 화면에서 바뀌지는 않음).
- 버려진 미리보기의 보관 ZIP(최대 50MB)과 실패한 확정의 ZIP 은 지워지지 않는다(보존 정리 RETENTION_TARGETS 에 없음 — 취소하면 지움). `/ops` 디스크 사용량에도 `data/imports` 는 아직 없다.
- 확정은 한 트랜잭션에서 최대 1,000 항목을 만든다 — PGlite 에서 큰 묶음의 소요 시간은 측정하지 않았다.
- `sources_owner_import_external_uq` 부분 unique: 다른 환경에서 같은 외부 ID 출처를 다른 ID 로 만든 묶음을 add_missing 으로 복원하면 그 출처 행은 unique 충돌로 들어가지 않고(insertBundleRow `on conflict do nothing`), 의존 항목이 dependency 충돌로 남을 수 있다 — 시험하지 않음.
- 원장 행은 확정 뒤에도 DB 트리거로 불변을 강제하지 않는다(앱 경로만 — outcome·target 은 확정 때 한 번 씀).
- `import_items.target_source_version_id` 는 owner 복합 FK 가 아니다(source_versions 에 owner_id 없음) — 묶음 관계 검사(같은 출처의 버전)와 앱 경로로만 묶는다.

## Codex 에게 질문
1. zip-slip·압축 폭탄 방어가 충분한가? 특히 `listZip` 이 중앙 목록 크기만 믿고 local header 의 크기·플래그(데이터 디스크립터 bit 3)를 보지 않는 점, `inflateRawSync` 의 `maxOutputLength` 를 선언 크기로 두는 방식, 중첩 ZIP(한 겹)에서 총량 상한이 바깥·안쪽 합으로 지켜지는지.
2. 확정의 "미리보기를 믿지 않음" 경계: 보관 ZIP sha256 재확인 + 트랜잭션 안 재판정이, 같은 owner 가 두 미리보기를 엇갈려 확정할 때(둘 다 new 로 본 같은 외부 ID) 중복 출처·소재를 막는가(부분 unique + 재판정)? PGlite 단일 연결 밖(Postgres)에서도 맞는가?
3. 충돌 처리: "새 버전"이 기존 출처에 source_version + **새 소재**를 만드는 방식이 "원문 불변·기존 사용자 글 수정 없음" 불변식에 맞는가? sources.content_hash 를 첫 버전 값으로 두는 것이 혼동을 주는가?
4. 원장을 EXPORTED·RESTORED 로 둔 결정(D32 e)과 복원 PARENTS(대상 소재·출처·버전이 없으면 dependency 충돌) — 복원된 preview 실행이 남는 것, add_missing 에서 부분 unique 충돌이 생길 때의 동작이 받아들일 만한가?
5. 미리보기·확정 API 의 선택 해석(폴더 합집합, 빈 선택 400, 다른 실행 ID 400, 충돌은 version_ids 만)과 폼(같은 이름 여러 값)이 우회 없이 같은 규칙인가?
6. 원장·감사 기록에 개인 원문이 새는 경로가 있는가? (원장에는 경로·제목·생성 표시·checksum 이 있고 본문은 없음, audit 은 건수만, 소재 상세는 원래 경로를 보인다.)

## FIX round 1 (Codex review-T18)
- Orchestrator: HEAD_SHA 6e7ff92 (code only, D28) — reran lint·typecheck·build·unit 1036·integration 699·drill:mock 0·db:migrate 0039·real-DB drill:restore PASS.
- 입력: `.handoffs/review-T18.md`(CHANGES_REQUESTED, 1427118 대상). BASE_SHA: 8bd31388e355cc723d8810e4096f639b09756b55 · HEAD_SHA: TBD(커밋 안 한 작업 트리 — 오케스트레이터가 커밋).
- 범위: 파일·모의만. 네트워크·자격 증명·live 커넥터 0, 새 의존성 0, migration 0039(`0039_t18_fix1_originals`), `./data` 열지 않음, dev 서버 꺼짐.
- 건드리지 않음: `docs/DECISIONS.md`, `M4_CODEX_VERDICTS.md`(작업 중 다른 쪽에서 수정된 상태 — 이 작업의 변경 아님), `M4_STATUS.md`, `LIVET1_IMPLEMENTATION_HANDOFF.md`, 다른 handoff.

### 지적 → 변경 → 시험
| 지적 | 변경 | 시험 |
|---|---|---|
| [P0] domain imports.ts:293 HTML 원본이 추출 텍스트로 대체됨(원본 바이트 미보존) | 새 표 `source_version_originals`(0039): 출처 버전마다 하나(unique), `content_base64`(원본 바이트 그대로 — 문자열 디코딩을 거치지 않아 BOM·CRLF 가 드라이버/JSON 에서 바뀌지 않음), `byte_size`, `sha256`, `format`, owner. DB CHECK: 길이(decode)=byte_size, sha256(decode)=sha256. 트리거: INSERT 때 sha256 = 출처 버전 raw_hash 이고 owner = 출처 owner, UPDATE·DELETE 금지(`append_only_immutable`). 파서는 `original`(UTF-8 fatal + ignoreBOM 디코딩, 변환 없음)을 함께 돌려주고 확정 때 버전과 같은 트랜잭션에 넣는다. 소재 원문은 파생 값 그대로(.html 은 추출 텍스트). 내보내기·복원: EXPORTED/RESTORED 표, `TABLE_INTRODUCED_IN` 0039(이전 묶음은 빈 표), 행 스키마, 묶음 무결성(버전 존재·버전당 하나·sha256=raw_hash=sha256(바이트)·크기), 복원 PARENTS(source_versions), 보존 정리 보호 표. 받기: `GET /api/imports/originals/{출처 버전 ID}`(owner 조건, text/plain + attachment + nosniff + sandbox CSP, `x-content-sha256`), 소재 상세에 "원본 파일 그대로 받기" 링크 | 단위: HTML(링크·표·BOM·CRLF) original 이 바이트 동일·sha256=checksum, md BOM 은 original 에만. 통합: HTML 확정 → 소재 원문에 href·script 없음, 원본 행 바이트 동일·sha256=raw_hash, 받기 경로 바이트 동일·헤더, 다른 owner 404, UPDATE·DELETE 거부, raw_hash 불일치·owner 불일치 INSERT 를 트리거가 거부(오류 메시지로 트리거 확인), md(BOM·CRLF) 바이트 동일. 복원 훈련: `source_version_originals` ids same·행 수 일치 |
| [P0] imports.ts:328 중첩 ZIP 이 누적 해제량·전체 항목 수 상한 우회 | 바깥·안쪽이 함께 쓰는 예산 하나: 중앙 목록 **레코드 수(디렉터리 포함)** 를 전역 5,000 에 합산, 실제로 푸는 바이트(중첩 컨테이너 + 텍스트) 합계 128MiB 를 **풀기 전에** 선언 크기로 검사, 중첩 ZIP 16개 상한, 깊이 1(두 겹째 ZIP 은 첨부·풀지 않음). 텍스트 64MiB 상한은 그대로 | 단위: 안쪽 ZIP 17개 → 거부(16개는 받음), 9MiB 첨부만 든 안쪽 ZIP 15개(올린 파일 < 5MB) → ImportTooLargeError(14개는 받음), 디렉터리 3,000개짜리 안쪽 ZIP 2개 → 거부, 바깥 디렉터리 5,001개 → 거부, 두 겹째 ZIP 은 첨부 |
| [P0] imports.ts:248 HTML 제거 정규식 ReDoS | `htmlToText` 를 한 번 훑는 토큰 순회로 교체(indexOf 는 현재 위치에서 앞으로만, 찾은 곳까지 소비하거나 못 찾으면 끝냄 — 같은 구간 재탐색 없음). 닫히지 않은 주석·script/style/noscript/template/title 과 `>` 없는 태그 시작은 나머지를 버림(브라우저와 같음), 태그가 아닌 `<` 는 글자. 닫는 태그 이름 비교는 글자 단위. title·h1 추출 정규식(경계 반복)도 제거. 입력 상한 2MiB(`HTML_TO_TEXT_MAX_INPUT`, 넘으면 ImportInvalidError) + `parseImportFile` 도 2MiB 초과는 too_large | 단위: 적대 입력 10종(닫히지 않은 `<script>`·`<style x>`·주석 반복, `<a` 반복, `<`·`</` 반복, `<title>`+`</titl` 반복, `<script>`+`</scrip` 반복, `<h1>`+짧은 태그 반복, 엔티티 흉내) 2MB 각각 **CPU 시간 < 200ms**(3회 중 최소) + 선형성(2MB 1회 < 512KB 4회 × 2.5 + 32ms). 참고: 고치기 전 정규식은 `<script>` 반복 32KB 41ms → 64KB 130ms → 128KB 482ms(제곱, 이 PC). 닫히지 않은 태그·주석·대소문자·self-closing script·h1/title 제목 |
| [P1] db/imports.ts:244 다른 실행의 동시 확정이 직렬화되지 않음 | 확정 트랜잭션에서 실행을 차지한 직후 `pg_advisory_xact_lock(hashtext('cs.import:<owner>:<공급자>'))` → 그 뒤에 출처를 다시 읽어 판정(잠금 뒤 문장은 먼저 커밋된 출처를 봄). 새 출처 INSERT 는 savepoint(`tx.transaction`) 안 — `sources_owner_import_external_uq` 위반이면 그 INSERT 만 되돌리고 다시 읽어 동일 → `skipped_identical`, 다르면 `skipped_conflict`(사용자가 새 버전을 고르지 않았으므로 덮어쓰지 않음). 다른 제약 위반은 그대로 throw | 통합: 같은 새 항목을 가진 두 실행을 `Promise.all` 로 확정 → 둘 다 200, 출처 1·소재 1, 결과 imported 1 + skipped_identical 1, 원장 target 일관. 시험 전용 훅 `beforeSourceInsert`(같은 트랜잭션, savepoint 밖에서 같은 외부 ID 출처+버전을 먼저 넣음) → 동일 내용이면 skipped_identical, 다른 내용이면 skipped_conflict, 500 없음, 소재·이력 0 증가 |
| [P1] apps/web/lib/imports.ts:122 실제 선택 0개로 확정·ZIP 삭제 | `effectiveImportChoice`(domain): 원장 판정 기준 new 는 item_ids·폴더, conflict 는 version_ids 일 때만 쓰기. `commitImportRun` 이 상태 변경·원본 재읽기 **전에** 유효 선택이 0개면 400 `import_nothing_selected`(실행 preview 유지, 라우트가 ZIP 을 지우지 않음). version_ids 가 충돌 항목이 아니면 400 `import_invalid_selection`(폼 문구 추가). 폼·JSON 같은 경로 | 통합: 없는 폴더 → 400·preview·ZIP 남음·쓰기 0, 새 항목에 version_ids → 400 invalid_selection, 동일 항목만 → 400, 반복 `folder` 폼 → 두 폴더만 imported 2·skipped_unselected 1, 반복 `version` 폼(충돌 아님) → 303 `?error=import_invalid_selection`. 기존 "충돌만 선택 → skipped_conflict" 시험은 바뀐 규칙에 맞춰 "충돌만 선택 → 400, 새 항목과 함께 선택 → 충돌은 skipped_conflict·새 항목 imported·기존 소재 그대로" 로 바꿈(단언을 줄이지 않고 두 경로 모두 확인) |
| [P2] imports.ts:339 unsigned ZIP 크기를 signed integer 에 저장 | 0039 에서 `import_items.byte_size` → bigint. 파서는 원장에 넣기 전 0 ≤ size ≤ 0xffffffff·safe integer 확인(벗어나면 ZipFormatError) | 단위: 선언 크기 2^31−1·2^31·0xfffffffe 첨부 → byteSize 그대로. 통합: 2^31−1·2^31 첨부가 든 ZIP 미리보기 200, 원장 byte_size 그대로 |

### 놓친 케이스(리뷰 파일)에서 함께 처리한 것
- 정상 데이터 디스크립터(bit 3) ZIP 읽기(local 크기·CRC 0) — 시험 도우미에 `dataDescriptor` 추가, 단위 시험.
- local/central 불일치(이름·압축 방식·암호화 플래그) → 거부. 시험 도우미 `localName`, 단위 시험.
- 지원하지 않는 압축 방식은 첨부·디렉터리·too_large 항목(풀지 않는 항목)에서도 거부 — `rawMethod`, 단위 시험.
- 닫히지 않은 태그·주석 반복, 원본 링크·표 보존과 복원, 없는 폴더·새 항목의 version_ids·반복 folder/version 폼, byte_size 2^31−1/2^31 경계.
- 처리하지 않음: `add_missing` 의 외부 ID 같고 출처 UUID 다른 충돌 집계, 확정·취소 뒤 ZIP 삭제 실패 재정리, 실제 Notion·Drive ZIP 파일명 인코딩(아래 위험).

### 변경 파일
- 수정: `packages/domain/src/imports.ts`, `packages/db/src/imports.ts`, `packages/db/src/schema.ts`, `packages/db/drizzle/meta/_journal.json`, `packages/db/src/{bundle-tables,restore}.ts`, `packages/domain/src/{bundle,ops}.ts`, `packages/domain/src/{bundle,writing}.test.ts`(BundleTables 리터럴에 빈 표), `apps/web/lib/imports.ts`(오류 문구), `apps/web/app/captures/[id]/page.tsx`(원본 받기 링크), `tests/helpers/import-zip.ts`, `tests/integration/imports.test.ts`, `README_KO.md`(가져오기 절 두 문장).
- 새 파일: `packages/db/drizzle/0039_t18_fix1_originals.sql`(drizzle-kit 출력 + 머리말 2줄 + 손으로 더한 트리거 함수 1·트리거 2), `packages/db/drizzle/meta/0039_snapshot.json`, `apps/web/app/api/imports/originals/[versionId]/route.ts`, `packages/domain/src/imports-fix1.test.ts`.

### 명령과 결과(로컬 Windows 10, Git Bash, `source tools/env.sh`, Node 24.21.0, `corepack pnpm`, 순차 — 단위와 통합 동시 실행 안 함, dev 서버 꺼짐)
- `drizzle-kit generate --name t18_fix1_originals` → 0039.
- `corepack pnpm lint`: pass(중간에 no-useless-assignment 2건을 고친 뒤).
- `corepack pnpm typecheck`: pass.
- `corepack pnpm build`: pass(`/api/imports/originals/[versionId]` 포함).
- `corepack pnpm test`(unit): pass — 47 files, 1036 tests(새 `packages/domain/src/imports-fix1.test.ts` 26). 첫 전체 실행에서 HTML 시간 시험이 병렬 부하로 벽시계 200ms 를 넘어 실패 → 시간 측정을 이 워커 프로세스의 CPU 시간(3회 중 최소)으로 바꾸고 `<` 만 반복 경로를 빠르게 고친 뒤 pass(상한 200ms 는 그대로).
- `corepack pnpm test:integration`(혼자): pass — 35 files, 699 tests, 508s(`tests/integration/imports.test.ts` 24, 새 9 포함).
- `corepack pnpm drill:mock`: pass — "불변식 위반 0건".
- 실제 로컬 DB `db:migrate`·`drill:restore`: not_run(`./data` 를 열지 말라는 지시 — 오케스트레이터 단계).

### 남은 위험
- 동시 확정 시험은 PGlite 단일 연결이라 두 트랜잭션이 실제로 엇갈리지 않는다(PGlite 가 트랜잭션을 줄 세움). advisory lock 이 별도 연결에서 직렬화하는지는 DB_DRIVER=postgres 가 없어 관찰하지 못했다 — unique 위반 복구 경로는 훅으로만 확인.
- 잠금은 owner·공급자 단위(외부 ID 단위 아님) — 같은 owner 의 같은 공급자 확정은 모두 직렬화된다(개인 앱이라 받아들임, 교착 없음).
- 원본은 base64 text(최대 2MiB → 약 2.7MiB/행)로 DB·묶음에 들어간다 — 가져오기 1회 최대 1,000 항목이면 묶음이 커질 수 있다. 원본은 DB 에 있고 파일 저장소(assets)를 쓰지 않는다.
- 0039 이전에 확정한 가져오기(1427118 로 만든 로컬 데이터)는 원본 행이 없다 — 받기 링크가 404, 복원·무결성은 통과(원본은 선택적). 다시 가져오면 동일 판정이라 채워지지 않는다.
- HTML 처리 시간 시험은 CPU 시간 기준이다(Windows 눈금 약 15.6ms). 벽시계는 병렬 부하에 따라 더 길 수 있다. `<` 만 2MB 는 CPU 약 30~90ms.
- `htmlToText` 는 속성 값 안의 `>` 를 태그 끝으로 본다(이전 정규식과 같음) — 추출 텍스트가 조금 달라질 수 있으나 원본은 보존된다.
- 화면은 build·typecheck 만 — 브라우저로 보지 않음.

### Codex 에게 질문
1. 원본을 `source_version_originals.content_base64`(DB CHECK + INSERT 트리거 raw_hash·owner 일치 + 추가 전용)로 둔 방식이 "원본 보존" 불변식과 내보내기·복원(무결성 검사 포함)에 충분한가? 0039 이전 가져오기에 원본이 없는 것을 어떻게 다뤄야 하는가?
2. owner·공급자 단위 `pg_advisory_xact_lock` + 잠금 뒤 재조회 + savepoint unique 복구가 PostgreSQL READ COMMITTED 다중 연결에서 중복 출처·500 을 막는가? 같은 기존 출처에 같은 버전을 동시에 추가하는 경우(versioned)도 이 잠금으로 충분한가?
3. 중첩 예산(레코드 수 디렉터리 포함 5,000 · 실제 푸는 바이트 128MiB · 안쪽 ZIP 16개 · 깊이 1)과 local/central 일치 검사에 남은 우회가 있는가? 특히 같은 local header 를 여러 중앙 레코드가 가리키는 겹침(overlapping entries)은 아직 검사하지 않는다.
4. `htmlToText` 토큰 순회에 선형이 아닌 경로가 남았는가(decodeEntities·줄 정리 정규식 포함)? CPU 시간 기준 200ms 시험이 회귀 방지로 충분한가?
5. "유효 선택 0개 → 400" 을 미리보기 판정 기준으로 둔 것(확정 때 재판정으로 결과가 모두 skipped 가 될 수는 있음)과 version_ids 를 충돌 항목으로만 제한한 것이 받아들일 만한가?
