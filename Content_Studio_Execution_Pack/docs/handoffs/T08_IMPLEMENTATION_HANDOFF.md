# Implementation handoff
- Task ID / milestone: T08 (M2) — 음성 파일 전사 job · 업로드 진행(조각 업로드 세션, A14) · 지원 기기 fallback. **모의 전사만(D9) — 외부 STT 호출 없음.**
- Purpose and changed behavior:
  - 새 표(migration 0012): `upload_sessions`(kind audio|video, declared_mime/bytes, received_bytes, chunk_size 4–8MiB CHECK, checksum_expected/actual, state open|completed|verified|rejected|aborted|expired, reject_reason, asset_id owner 복합 FK, expires_at), `upload_chunks`(session 복합 FK cascade, unique(session_id, chunk_index), bytes, sha256), `transcription_jobs`(asset owner 복합 FK, state queued|running|succeeded|failed|canceled, provider 'mock', model, progress 0–100, transcript_version_id(FK 없음 — 순환, 앱·묶음 검사), error, attempts, keep_original, audio_seconds, 진행 중 job 은 asset 당 1개 — 부분 unique 색인), `transcripts`(job 복합 FK, unique(job_id, version), segments jsonb, created_by mock|owner, **추가 전용 트리거**). 열: `assets.verification_scope`(기본 'signature_size_checksum')·`assets.deleted_at`, `captures.capture_transcript_id`(transcripts 복합 FK), `usage_ledger.run_id` nullable + `transcription_job_id`(unique, 복합 FK) + `audio_seconds` + CHECK num_nonnulls(run_id, transcription_job_id)=1.
  - `@cs/domain/upload.ts`(순수): 한도(음성 200MiB·영상 2GiB), 조각 4–8MiB(기본 8), 24h 만료, `planUpload`(415/413/400), 조각 계획(`chunkCount`·`expectedChunkBytes`·`missingChunks`·`uploadProgress`), `sniffMedia`(MP3 ID3v2.2–4·MPEG 프레임, WAV RIFF/WAVE, ftyp mp4/m4a/mov, EBML+DocType webm — matroska 거부), `mediaMatches`. `media.ts` 확장자·Content-Type 에 음성·영상 추가(작은 업로드 `sniffMime` 는 그대로 — 음성·영상 불가).
  - `@cs/domain/stt.ts`: `sttBudgetPolicy`(통화·상한 = LLM_BUDGET_* 공용, 가격 STT_PRICE_PER_MINUTE), `estimateAudioSeconds`(duration_seconds 또는 ⌈bytes/16000⌉), `sttCostMicro`(bigint ⌈초×1분가격/60⌉), `sttLiveReadiness`(이름만, 항상 not ready + 'LIVE_STT_ADAPTER(T08 미구현, 별도 승인 후)'), `LiveSttNotConfiguredError`(GuardError → 503). config: STT_MODE(mock 기본)·STT_PROVIDER·STT_MODEL·STT_LIVE_APPROVAL_REF·STT_PRICE_PER_MINUTE. `checkBudget` 은 `BudgetLimits`(LLM·STT 공용) 를 받는다(동작 동일). `GoneError`(410, kind 'gone').
  - `@cs/providers/stt.ts`: `MockTranscriber`(checksum 시드 결정적 한국어 자리표시 구간, `MOCK_TRANSCRIPT_WARNING`, 실패 주입), `LiveTranscriber`(HTTP 없음 — assertReady/transcribe 항상 throw). `LocalStorageAdapter.putFile`(rename, EXDEV 면 복사→rename)·`openStream`(다운로드 스트리밍).
  - `@cs/db/uploads.ts`: `UploadStore`(<STORAGE_LOCAL_DIR>/uploads/<owner>/<session>/<index>, UUID·정수만, root 밖 거부), 세션 생성·조회·뷰, `putUploadChunk`(세션 행 잠금 → 크기·번호 → 기존 조각 같은 sha 200/다른 sha 409 → 임시파일+rename → 행·received_bytes), `completeUploadSession`(잠금 아래 open→completed 후 트랜잭션 밖 스트림 조립: 조각별 sha 재확인·전체 sha·앞 64바이트 서명 → 통과 시 asset VERIFIED+verified(같은 checksum asset 재사용, 지운 원본이면 되살림), 실패 시 rejected+조각 삭제+UploadRejectedError(415/400), 예기치 못한 오류는 open 으로 되돌림), `abortUploadSession`, `expireUploadSessions`.
  - `@cs/db/transcription.ts`: `requestTranscription`(asset 잠금 → 404/410/415/409 asset_not_verified·asset_in_use·transcription_in_progress → `reserveMicroOrThrow`(T07 원장·통화·상한) → job queued + 원장 reserved), `advanceTranscriptionJobs`(tick 당 한 단계 25→50→75→전사(트랜잭션 밖)→job 재잠금 후 running 일 때만 v1 기록·원장 확정, 실패 = failed + 예약액 확정), `cancelTranscriptionJob`(queued → released 0 / running → 예약액 확정 failed), keep_original=false → 성공 뒤 deleted_at(첨부된 파일은 건너뜀+감사) 후 파일 삭제, `createTranscriptVersion`(job 잠금, base_version 최신 아니면 409 stale_transcript), `transcriptToCapture`(command_key `transcript-<id>` 멱등, raw_text = 본문, note "음성 전사(모의)", capture_transcript_id). `budget.ts`: `reserveMicroOrThrow`(reserveOrThrow 가 사용 — 동작 동일), `insertReservedSttLedger`, `releaseLedger`, `settleSttLedgerSucceeded`, `getSttLedger`.
  - worker: `runWorkerTick({config, db, transcriber?, files?, now?})` — 만료 정리 + (전사기 있으면) job 한 단계. web 은 `runInlineWorker`(WORKER_MODE=inline 일 때 모의 전사기 + 저장소)를 `/api/health`·`GET /api/transcription-jobs` 에서 호출. CLI 는 전사기 없이 만료 정리만.
  - API: `POST /api/uploads/sessions`, `GET·DELETE /api/uploads/sessions/{id}`, `PUT /api/uploads/sessions/{id}/chunks/{index}`(선택 x-chunk-sha256), `POST /api/uploads/sessions/{id}/complete`, `POST /api/assets/{id}/transcribe`, `GET /api/transcription-jobs?asset_id=`, `GET /api/transcription-jobs/{id}`, `POST /api/transcription-jobs/{id}/cancel`, `GET /api/transcripts/{id}`, `POST /api/transcripts/{id}/versions`, `POST /api/transcripts/{id}/to-capture`. `GET /api/assets/{id}`: deleted_at → 410 asset_deleted, 음성·영상은 스트림. 채널 초안 첨부는 지운 파일을 410 으로 거부.
  - UI: `/record`(상단 "음성") — 서버 안내(모의·형식·한도·VERIFIED 범위·live 준비 안 됨) + client 컴포넌트: `MediaRecorder` 감지("이 기기에서는 브라우저 녹음을 지원하지 않습니다 → 파일 업로드"), 조각 업로드(진행률, localStorage 세션 ID → 새로고침 뒤 같은 파일 재선택 시 GET 으로 이어 올림), 원음 보존 체크, 전사 목록 1.5초 폴링·취소·수정본 저장·소재로 보내기, `mock_warning` 표시. 설정 화면 AI 절에 음성 전사 모드·1분 가격·live 준비 안 됨 줄. `/api/health` 에 `stt {mode, live_ready:false, missing}`·`uploads {sessions, files, bytes}`.
  - 감사: upload.session_create·complete·reject·abort·expire, asset.upload/restore(via upload_session), asset.delete_original(_skipped), transcription.request·cancel·succeeded·failed, transcript.version_create·to_capture, capture.create(from_transcript).
- BASE_SHA: 296c040
- HEAD_SHA: f14784721b016c0b57e03e685f14bb898cce041f
- Clean tracked tree confirmed: 아니오 — 커밋 전(추적 30개 수정 + 신규 25개 파일). `.claude/`(launch.json) 는 이 작업과 무관한 미추적 폴더.
- Relevant acceptance IDs: T08 행(음성 파일 전사 job·업로드 진행·지원 기기 fallback), A14(네트워크 단절 → 같은 업로드 세션으로 재개), A15(전사도 비용 예약), A01(owner 격리), docs/01 음성 줄, docs/02 §장시간 영상 업로드(세션 owner·형식·크기·checksum 검사 후 VERIFIED), D9·D11(VERIFIED 범위 → D15).
- Changed files: Domain `packages/domain/src/{upload(신규),stt(신규),media,budget,config,errors,bundle,index}.ts` · Providers `packages/providers/src/{stt(신규),storage,index}.ts` · DB `packages/db/src/{uploads(신규),transcription(신규),schema,budget,restore,bundle-tables,queries,variants,index}.ts`, `packages/db/drizzle/0012_t08_uploads_transcription.sql`(drizzle-kit + 머리 주석·transcripts 트리거 수동), `meta/0012_snapshot.json`, `meta/_journal.json` · Worker `apps/worker/src/index.ts` · Web `apps/web/lib/{stt(신규),server,api}.ts`, `apps/web/app/api/uploads/sessions/**`(4), `apps/web/app/api/assets/[id]/{route,transcribe/route}.ts`, `apps/web/app/api/transcription-jobs/**`(3), `apps/web/app/api/transcripts/**`(3), `apps/web/app/api/health/route.ts`, `apps/web/app/record/{page,RecordClient}.tsx`, `apps/web/app/{layout,settings/page}.tsx` · Tests `packages/domain/src/{upload,stt}.test.ts`(신규), `packages/providers/src/stt.test.ts`(신규), `packages/domain/src/bundle.test.ts`(T08 describe 3개 추가 + 픽스처 새 열/표), `packages/domain/src/writing.test.ts`(픽스처에 빈 표 2개만), `packages/db/src/bundle-tables.test.ts`·`tests/integration/export-restore.test.ts`(제외 표 목록에 upload_chunks·upload_sessions 추가), `tests/integration/uploads-transcription.test.ts`(신규 24) · Docs `docs/DECISIONS.md` D15, `README_KO.md` T08 절, `.env.example` STT_* 자리.
- Migrations / restore implications: 0012 는 새 표 4개 + 열 추가 + usage_ledger.run_id NOT NULL 해제(기존 행은 run_id 가 있어 새 CHECK 통과). EXPORTED 순서: source_versions 다음 assets·transcription_jobs·transcripts(captures.capture_transcript_id 때문에 captures 보다 먼저 — assets 위치를 앞으로 옮김), usage_ledger 는 그대로(뒤). EXCLUDED: upload_sessions·upload_chunks. TABLE_INTRODUCED_IN: 두 전사 표 = 0012(이전 묶음은 빈 표, 새 열은 기본값/null). PARENTS: captures→transcripts, transcription_jobs→assets, transcripts→transcription_jobs(owned), usage_ledger→transcription_jobs(owned). checkIntegrity: 원장 run_id/job 중 정확히 하나, (job, version) 중복, transcript_version_id = 같은 job 의 전사, succeeded 인데 전사 없음 거부, captures.capture_transcript_id 는 묶음 안. 복원 사후: 들어간 job 의 첫 전사가 inserted/same 아니면 전체 중단, 진행 중(queued·running) job 은 canceled + 원장 예약액 확정(`interrupted_transcriptions` 미리보기·결과). 지운 원본(deleted_at)은 파일 없이 `asset_deleted` 경고. 이 작업에서는 ./data/pglite 에 아무것도 실행하지 않았다 — dev 서버 재시작 시 0005–0012 자동 적용.
- Actual commands and results (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0, pnpm 12.6.0):
  - 기준선(296c040): `pnpm test` 22 files / 374, `pnpm test:integration` 15 files / 209
  - `cd packages/db && pnpm exec drizzle-kit generate --name t08_uploads_transcription` → 0012 생성(DB 연결 없음), SQL 머리 주석·트리거 수동 추가
  - `pnpm lint` → pass / `pnpm typecheck` → pass
  - `pnpm test` → pass, 25 files / 398 tests
  - `pnpm test:integration` → pass, 16 files / 233 tests
  - `pnpm build` → pass(/record·새 API 12개 경로 포함)
  - 수동 확인: 메모리 DB·임시 STORAGE_LOCAL_DIR 로 `next start -p 3100`(별도 프로세스) + curl — health `stt`·`uploads` → 로그인 → 세션 201 → 조각 201 → 완료 200(verified) → 전사 202 → 전사 목록 4회 조회 시 running 25·50·75 → succeeded 100 → `/record` HTML(녹음 안내·업로드 버튼) 확인 후 프로세스 종료·임시 폴더 삭제. 브라우저 클릭(파일 선택·MediaRecorder 감지·이어 올리기) E2E not_run.
- Demo route / local start steps: dev 서버 재시작(0012 적용) → 상단 "음성"(/record) → 녹음 지원 안내 확인 → MP3/M4A/WAV/WebM/MP4/MOV 파일 선택 → "올리고 전사 요청" → 업로드 진행률 → 목록의 진행률 25·50·75·100(1.5초 폴링) → 전사 본문(모의) 수정 → "수정본 저장(새 버전)" → "이 버전을 소재로 보내기" → 소재함에서 "음성 전사(모의)" 메모 확인. 업로드 중 새로고침 후 같은 파일을 다시 고르면 받은 위치부터 이어 올린다.
- External calls performed (exact scope, or none): none. 새 의존성 0(워크스페이스 링크도 추가 안 함 — worker 는 전사기를 주입받음), 비밀 0, 유료 사용 0, STT HTTP 어댑터 없음.
- Mock-only functionality: 전사 전체(MockTranscriber — 음성을 해석하지 않음, 자리표시 문장). 테스트 미디어는 형식 서명 + 결정적 채움 바이트(합성 — 실제 재생 불가). 브라우저 녹음 없음(지원 여부 안내만).
- Known risks / not run:
  - VERIFIED 는 앞 64바이트 서명·크기·sha256 만 — 뒤가 깨진 파일도 통과(범위를 `verification_scope`·화면에 표시, 디코딩 검증은 사용자 결정).
  - 내보내기(T05)·배포 파일(T09) ZIP 은 여전히 메모리에서 만든다 — 큰 영상이 들어가면 메모리 사용이 크다(업로드·다운로드는 스트림).
  - 완료 도중 프로세스가 죽으면 세션이 completed 로 남고 24h 만료 때 정리(그 전 재완료는 409 upload_in_progress — 새 세션 필요). asset 파일을 옮긴 뒤 DB 기록이 실패하면 파일 삭제를 시도하고 세션을 open 으로 되돌린다.
  - 원음 삭제: DB(deleted_at) 확정 뒤 파일 삭제 — 파일 삭제 실패 시 파일만 남음(다운로드는 410). 첨부된 파일 원본 삭제 거부(409 asset_in_use)·처리 시 건너뜀 경로와 지운 파일 첨부 410 은 **통합 테스트 없음**(코드만).
  - inline worker 는 조회 요청(/api/health, 전사 목록)으로만 돈다 — 화면을 닫으면 진행이 멈춘다(모의라 영향 없음, 실제 STT 전 재검토). tick 은 전역(모든 owner)의 job 을 최대 20개 처리.
  - `usage()`(health) 는 uploads 폴더를 매 요청 순회한다(세션 폴더 수에 비례).
  - 길이 추정 bytes/16000(≈128kbps)은 가정 — 영상·무손실 WAV 는 크게 과대 추정(가격이 있을 때 예약이 커짐, duration_seconds 로 보정 가능).
- Questions specifically for Codex:
  1. 조각 조립 무결성: 완료 시 조각을 번호 순 스트림으로 이어 붙이며 조각별 sha256(DB 기록)·전체 sha256·크기·앞 64바이트 서명을 확인한다. 조각 파일이 완료 사이에 바뀌거나(파일 시스템 직접 수정), 조립 파일(`assembled.part`)·rename 경로에서 검사한 바이트와 다른 바이트가 asset 이 될 수 있는가? 서명 판정(`sniffMedia`)에 우회(폴리글랏: 예 ID3 머리 + 다른 내용)가 있는데 이것이 VERIFIED 의 표시 범위("형식 서명·크기·checksum")를 넘어서는 위험인가?
  2. 이어 올리기·멱등 경쟁: 같은 조각 동시 PUT(세션 행 잠금으로 직렬화), 다른 sha 재전송 409, 완료 open→completed 전이(동시 완료 1건만), 완료 실패 시 open 되돌림, 만료 tick 과 완료가 겹칠 때(completed 세션을 expired 로 바꾸는 경로) 조각이 지워진 뒤 asset 이 생기거나 verified 세션의 파일이 사라질 수 있는가?
  3. 조각 경로 owner 격리: 경로는 세션 행(owner WHERE)으로 찾은 뒤 `<root>/<ownerId>/<sessionId>/<index>`(UUID·정수 검사, root 밖 거부)로 만든다. 다른 owner 가 세션 ID 를 알아도 파일을 쓰거나 읽거나 지울 수 있는 경로(라우트·worker 만료·완료 실패 정리)가 있는가?
  4. 원장 — 취소·실패: 시작 전 취소 = released(0), 처리 중 취소 = 예약액 확정 failed=true, 실패 = 예약액 확정, 성공 = 예약 때 가격 스냅숏으로 확정. 전사기가 결과를 낸 뒤 job 재잠금에서 canceled 를 보면 결과를 버린다. 취소·tick·예약의 잠금 순서(job 행 → users 행)에서 교착·이중 확정·월 합계 누락이 있는가? 가격 없는 mock 0원 기록이 한도 검사를 건너뛰는 것은 T07 과 같다.
  5. 전사 복원: transcription_jobs ↔ transcripts 순환(transcript_version_id 는 FK 없음 — 묶음 검사 + 복원 사후 검사), captures.capture_transcript_id 를 위해 assets·전사 표를 captures 앞으로 옮긴 순서, 진행 중 job 을 canceled 로 바꿔 넣는 처리(재복원 add_missing 에서는 그 행이 'different' 충돌로 보임)가 T05 "덮어쓰지 않음·ID 보존" 규칙과 맞는가?
- Next authorized task: M2 마감 검토(Codex T08 리뷰·FIX). 실제 STT 연결·브라우저 녹음·object storage 는 범위 밖(별도 승인).

---

# FIX round 1 (Codex review-T08)
- Review: `.handoffs/review-T08.md` (CHANGES_REQUESTED, 3×P0 + 3×P1, review HEAD f147847)
- BASE_SHA: 9c09ea0 (T07 FIX round 4 커밋 위)
- HEAD_SHA: TBD (orchestrator commits)
- Migration: 없음. 변경 파일: `packages/db/src/{uploads,transcription,variants}.ts`, `apps/web/app/api/uploads/sessions/[id]/chunks/[index]/route.ts`, `apps/web/app/record/RecordClient.tsx`, `apps/web/lib/upload-client.ts`(신규 — 증분 Sha256·resumeDecision·pollDelay·startPolling), 테스트 `apps/web/lib/upload-client.test.ts`(신규 7), `tests/integration/uploads-transcription.test.ts`(+7), `docs/DECISIONS.md` D15, `README_KO.md`.

| Finding | Change | Test |
| --- | --- | --- |
| P0 transcription.ts:299 — 늦은 원음 삭제가 재업로드 복구 파일을 지움 | `deleteOriginal`: asset 행 잠금 트랜잭션 안에서 첨부 재확인 → `files.delete` → deleted_at(삭제 실패 시 throw → 롤백, tick 은 삭제 실패를 삼키고 원본 유지). 완료의 복구 경로: 지운 원본·없는 파일이면 **새 key**(`buildAssetKey(owner, randomUUID())`)로 옮기고 `assets.key`·deleted_at 을 같은 행 잠금 아래 갱신 | integration "원음 삭제 뒤 재업로드는 새 key … 옛 key 늦은 삭제가 새 파일을 지우지 못한다"(다운로드 바이트 일치), "파일 삭제가 실패하면 deleted_at 도 남지 않는다" |
| P0 variants.ts:576 — 첨부 검사와 삭제 비직렬 | `setVariantAssets` 가 붙일 asset 을 id 오름차순 `FOR UPDATE` 후 deleted_at 재확인(410). 삭제는 같은 행 잠금 아래 variant_assets 재확인 | integration "첨부 ↔ 삭제: 지운 파일 첨부 410, 첨부된 파일 삭제 안 함, 동시 요청도 둘 다 성립하지 않음" |
| P0 uploads.ts:372 — 부분 쓰기 | `writeFully`(bytesWritten 만큼 반복, 0 진행 실패), 크기·sha256·앞부분 서명은 실제로 쓴 바이트로, 닫은 뒤 `stat` 크기 대조. 테스트 주입 `CompleteHooks.openWrite` | integration "한 번에 777바이트 핸들 → 원본과 같은 파일", "진행 0 → assembly_failed, 쓴 척만 하는 핸들(크기 불일치)도 거부" |
| P1 uploads.ts:409 — 완료가 expired 세션을 verified 로 | 최종 커밋: 세션 행 재잠금 → state='completed' 확인 후에만 putFile·asset·verified(아니면 409 `upload_expired`/`upload_not_open`, 옮긴 파일 삭제). `finishVerified` 는 completed 조건 update. 거부·되돌림도 세션 행 먼저 잠금(세션 → 조각 순서 통일). 테스트 주입 `beforeFinish` | integration "완료 중 만료: asset 없음·세션 expired·옮긴 파일 없음" |
| P1 RecordClient.tsx:65 — 재개 파일 내용 미확인 | 화면이 파일 전체 sha256(8MiB 씩 증분 해시)을 계산해 세션 생성에 `sha256`·`chunk_size` 신고, localStorage 키 = sha256. 재개는 `resumeDecision`(open·신고 sha256 일치·크기·받은 조각 범위 WebCrypto 재해시 = 서버 조각 sha) 통과 시만. 서버 GET 이 `chunks[{index,sha256}]`·`checksum_expected`·`resumable` 반환 | unit "resumeDecision" 3개·"Sha256 = node crypto" 2개; integration "GET 조각 sha·resumable, 신고 sha 와 다른 조각 섞으면 checksum_mismatch" |
| P1 RecordClient.tsx:118 — 한 번 실패하면 폴링 중단 | `startPolling`: 결과와 관계없이 다음 조회 예약(`pollDelay`: 진행 중 1.5초·없음 10초·실패 2→4→8→10초), 언마운트 시 stop, 업로드·취소 뒤 poke. 실패 문구는 목록 위에 표시 | unit "pollDelay", "실패 뒤에도 다음 조회 예약·stop 뒤 예약 없음" |

- 결정: 서버의 세션 `sha256` 은 **선택**으로 유지했다(필수로 바꾸면 기존 API 사용자·테스트 계약이 바뀜). 대신 `resumable` = open ∧ checksum 있음, 화면은 항상 신고하고 checksum 없는 세션은 이어 쓰지 않는다. 필수화는 사용자 결정.
- Actual commands and results (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0):
  - 기준선(9c09ea0): `pnpm test` 25 files / 399, `pnpm test:integration` 16 files / 234
  - `pnpm lint` → pass / `pnpm typecheck` → pass
  - `pnpm test` → pass, 26 files / 406 tests
  - `pnpm test:integration` → pass, 16 files / 241 tests
  - `pnpm build` → pass
  - 브라우저 E2E(실제 파일 선택·해시·재개·오프라인 폴링) not_run.
- Known risks:
  - 파일 삭제는 트랜잭션 안에서 먼저 하므로, 삭제 뒤 COMMIT 이 실패하면 파일만 없고 deleted_at 이 없다(다운로드 404 asset.missing, 같은 바이트 재업로드로 새 key 복구 가능).
  - 브라우저 JS 증분 SHA-256 은 2GB 파일에서 수십 초 걸릴 수 있다(진행률 표시). WebCrypto 는 조각 비교에만 쓴다.
  - 완료 처리 중(completed) 프로세스가 죽은 세션은 여전히 24시간 만료로만 정리된다.
- Questions specifically for Codex (FIX round 1):
  1. 잠금 순서: 완료 최종 커밋(세션 → asset), 첨부(원고·파생본 → asset 들 id 순), 삭제(asset), 전사 요청(asset → users), 만료(세션 → 조각) — PostgreSQL 에서 이들 사이에 교착이나 "잠금 전 읽은 값으로 결정"하는 경로가 남아 있는가?
  2. 새 key 복구: 지운 원본·없는 파일만 새 key 로 옮기고 옛 key 파일은 그대로 두지 않는다(없음). 복원(restore)·내보내기가 `assets.key` 변경(행 내용 변경)을 add_missing 에서 'different' 충돌로 보는 것이 맞는가, 그리고 옛 key 를 가진 묶음이 복원될 때 문제가 있는가?
  3. 재개 확인: 서버의 조각별 sha256 을 클라이언트가 비교하는 방식에서, 조각 크기·경계(마지막 조각)나 sha256 미신고 세션(`resumable:false`)을 다른 클라이언트가 이어 쓸 때 혼합 파일이 VERIFIED 가 되는 경로가 남는가(신고 sha 가 없으면 서버는 혼합을 막지 못함 — 필수화 필요 여부)?

---

# FIX round 2 (Codex review-FIX-T08)
- Review: `.handoffs/review-FIX-T08.md` (CHANGES_REQUESTED, 1×P0 + 1×P1 + 1×P2, review HEAD 725b5cd)
- BASE_SHA: c02509a (T07 FIX round 5 커밋 위)
- HEAD_SHA: TBD (orchestrator commits)
- Migration: `0013_t08_fix_pending_delete.sql`(+ `meta/0013_snapshot.json`, journal idx 13) — `assets.pending_delete_key text` + 기존 deleted_at 행 채움(수동 추가). 변경 파일: `packages/db/src/{asset-cleanup(신규),transcription,uploads,schema,bundle-tables,queries,index}.ts`, `apps/worker/src/index.ts`(tick 에 cleanup), `apps/web/lib/upload-client.ts`, `apps/web/app/record/RecordClient.tsx`, 테스트, `docs/DECISIONS.md` D15. 잠금 테스트 파일은 건드리지 않음.

| Finding | Change | Test |
| --- | --- | --- |
| P0 transcription.ts:299 — 파일 먼저 지우고 COMMIT 실패 | 의도 먼저: 행 잠금 아래 deleted_at + pending_delete_key 커밋 → 커밋 뒤 `cleanupPendingDelete`(파일 삭제 → 같은 값일 때만 표시 비움). 실패·중단 시 표시가 남고 `cleanupPendingDeletes`(worker tick)가 재시도. 살아 있는 key(삭제 안 된 asset 이 쓰는 key)는 지우지 않음. 표시 칸에 다른 옛 key 가 있으면 먼저 정리, 못 하면 원음 삭제를 건너뛰고 감사 | integration "의도 커밋 뒤 중단 → 파일 남음·deleted_at+pending·410, tick 이 지우고 재실행 안전", "파일 삭제 실패 → 의도 남고 다음 정리에서 지움", "살아 있는 key 는 지우지 않음" |
| P1 uploads.ts:563 — 복구 시 옛 key 고아 | 복구가 옛 key 를 pending_delete_key 로 넘기고(표시 칸의 더 옛 key 는 잠금 아래 먼저 삭제) 새 key 커밋 뒤 정리. deleted_at 이 있어도 파일이 없다고 가정하지 않음 | integration "지운 원본인데 옛 파일이 남아 있어도 재업로드 복구 뒤 옛 파일 삭제·새 파일 제공" |
| P2 upload-client.ts:185 — 겹치는 폴링 | `startPolling(fetch, apply, timers)`: 조회 중 poke 는 "끝나면 바로 한 번 더" 표시만, `createSequencer` 로 응답 순번이 최신일 때만 apply | unit "순번 — 오래된 응답 반영 안 함", "조회 중 poke 는 겹치지 않고 끝난 직후 한 번으로 합친다" |

- 대체한 테스트: FIX round 1 의 "파일 삭제가 실패하면 deleted_at 도 남지 않는다"(롤백 설계)는 새 설계(의도 먼저)와 반대라 위 두 테스트로 바꿨다. 폴링 루프 단위 테스트는 새 시그니처(fetch, apply)로만 바꾸고 단언은 그대로.
- 내보내기: pending_delete_key 는 `bundleColumns` 에서 뺐다(운영 상태) — 복원 행은 null.
- Actual commands and results (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0):
  - 기준선(c02509a): `pnpm test` 26 files / 407, `pnpm test:integration` 16 files / 241
  - `cd packages/db && pnpm exec drizzle-kit generate --name t08_fix_pending_delete` → 0013(DB 연결 없음), 채움 UPDATE 수동 추가
  - `pnpm lint` → pass / `pnpm typecheck` → pass
  - `pnpm test` → pass, 26 files / 409 tests
  - `pnpm test:integration` → pass, 16 files / 244 tests
  - `pnpm build` → pass
- Known risks: 정리 재시도는 inline tick(저장소가 있는 web 경로)에서만 돈다 — CLI worker 는 저장소를 받지 않아 정리하지 않는다. 표시 칸이 하나라 같은 asset 에 옛 key 두 개가 쌓이면 먼저 정리해야 다음 삭제가 진행된다(그동안 원음 삭제는 건너뛰고 감사).
- Questions specifically for Codex (FIX round 2):
  1. 의도 먼저 + 커밋 뒤 삭제 + 재시도에서, "살아 있는 key" 판정(삭제 안 된 asset 의 key 와 같음)과 복구가 늘 새 key 를 쓴다는 전제로 재시도가 살아 있는 파일을 지울 수 있는 경로가 남는가(동시 정리 두 개, 복구와 정리의 경합 포함)?
  2. 0013 채움(기존 deleted_at 행 → 현재 key 를 삭제 대상으로)이 안전한가 — 그 key 에 새 파일이 들어갈 수 있는 경로가 있었는가?

---

# FIX round 3 (Codex review-FIX2-T08)
- Review: `.handoffs/review-FIX2-T08.md` (P2 1건 — asset-cleanup.ts:63 배치 독점)
- BASE_SHA: 2dd392d — HEAD_SHA: TBD (orchestrator commits)
- Migration: `0014_t08_fix_cleanup_backoff.sql`(+ snapshot, journal idx 14) — `assets.pending_delete_attempts int not null default 0`, `assets.pending_delete_next_at timestamptz`. 변경: `packages/db/src/{asset-cleanup,schema,bundle-tables,transcription,uploads}.ts`, 테스트. `lock.ts`·잠금 테스트 파일은 건드리지 않음(작업 중인 조정자 변경과 분리).

| Finding | Change | Test |
| --- | --- | --- |
| P2 asset-cleanup.ts:63 — 계속 실패하는 50개가 배치 독점 | tick 선택 = `pending_delete_key IS NOT NULL AND (next_at IS NULL OR next_at <= now)`, 순서 `next_at NULLS FIRST, id`, limit 50. 실패 시 attempts+1, next_at = now + min(2^attempts 분, 6시간)(같은 key 일 때만). 성공·새 의도 기록 시 key·attempts·next_at 초기화. 세 열은 운영 상태라 묶음에서 빼고, `insertBundleRow` 는 묶음 열 + owner_id 만 넣어 빠진 열은 DB 기본값을 받는다 | integration "계속 실패하는 의도 50개가 배치를 독점하지 않는다 — 51번째는 다음 tick, backoff 2분→4분, 최대 6시간, 성공 시 초기화" |

- 조정한 기존 테스트: round 2 "파일 삭제 실패 → 다음 정리에서 지운다"는 이제 backoff 때문에 즉시 재시도되지 않으므로 정리 시각을 +3분으로 넘겨 호출(단언은 그대로).
- 문서: D15 에 FIX round 3 한 줄(T07 round 6 커밋 확인 뒤 추가).
- Actual commands and results (BASE 2dd392d 위, `source tools/env.sh`): `drizzle-kit generate --name t08_fix_cleanup_backoff` → 0014; `pnpm lint` pass; `pnpm typecheck` pass; `pnpm test` 26 files / 410 pass; `pnpm test:integration` 16 files / 245 pass; `pnpm build` pass.
- Question for Codex: backoff 선택 조건(next_at 도래 + NULLS FIRST)에서, 새 의도가 계속 들어오면 이미 실패한 의도가 굶는 경로가 있는가(새 의도는 NULL 이라 항상 먼저 50개를 채울 수 있음)?

---

# FIX round 4 (Codex review-FIX3-T08)
- Review: `.handoffs/review-FIX3-T08.md` (2×P2 — asset-cleanup.ts:77 순서 굶김, :50 동시 실패 기록 덮어쓰기)
- BASE_SHA: c6ef0c5 — HEAD_SHA: TBD (orchestrator commits)
- Migration: `0015_t08_fix_cleanup_order.sql`(custom, + snapshot, journal idx 15) — 삭제 의도가 있는데 next_at 이 NULL 인 행을 `created_at` 으로 채움. 변경: `packages/db/src/{asset-cleanup,transcription,uploads,schema}.ts`, 테스트, D15. 잠금 파일은 건드리지 않음.

| Finding | Change | Test |
| --- | --- | --- |
| P2 :77 새 의도(NULL)가 재시도를 굶김 | 의도 생성(원음 삭제·복구) 시 next_at = now. 선택·순서 = `coalesce(next_at, -inf) <= now` 를 `next_at, id` 순 한 시간축 | integration "새 의도가 tick 마다 60개씩 들어와도 기한 지난 실패 의도는 다음 tick 에 처리(첫 번째로), 남은 옛 의도는 새 의도보다 먼저" |
| P2 :50 동시 실패가 오래된 값으로 덮어씀 | `claimDue`: 한 트랜잭션에서 `FOR UPDATE SKIP LOCKED` 로 때가 된 행을 잡고 next_at = now+60초(lease) 후 커밋 → 처리. 실패 = SQL 한 문장 `attempts+1`, `next_at = GREATEST(next_at, now + LEAST(power(2, attempts+1) 분, 6h))`, `WHERE id AND owner AND pending_delete_key = key`. 성공 = 같은 key 일 때만 비움. 개별 `cleanupPendingDelete` 도 같은 claim 을 거침(때가 된 경우만) | integration "동시 tick 두 개 → 시도 1회·횟수 1·next_at = t+2분, 과거 now 의 실패 기록도 next_at 을 앞당기지 못함(GREATEST)" |

- 기존 round 2·3 테스트(51개 배치·backoff 2→4분·정리 재시도)는 수정 없이 통과.
- Actual commands and results (`source tools/env.sh`): `drizzle-kit generate --custom --name t08_fix_cleanup_order` → 0015; `pnpm lint` pass; `pnpm typecheck` pass; `pnpm test` 26 files / 411 pass; `pnpm test:integration` 16 files / 249 pass; `pnpm build` pass.
- Question for Codex: lease(60초) 안에 처리가 끝나지 않으면(느린 저장소) 다른 tick 이 같은 의도를 다시 가져갈 수 있다 — 파일 삭제는 멱등(rm force)이고 표시 갱신은 같은 key 조건이라 안전하다고 보는데, lease 를 backoff 최소값(2분)보다 짧게 둔 것이 문제인가?
