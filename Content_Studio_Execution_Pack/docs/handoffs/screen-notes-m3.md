# M3 화면 확인 메모 (M3_LOCAL_RETURN §3)
상태: 확인 중(2026-09-25). HEAD 77a152d, dev 서버 http://localhost:3000, 식별자 owner@example.local.
"번호 — 관찰 내용" 으로 적는다. 문제 없으면 "N — OK".

## 진행 기록 (2026-09-30, 구현 담당 Claude 가 이 세션에서 직접 확인 — Codex 독립 검증 아님)
방법: 내장 브라우저 + 같은 세션의 fetch(API 응답 확인용). 테스트 데이터: 원고 3cb6ed1c…(주재원 메모), Threads 파생본 06cdd7f7…, 계획 69feac58…(MOCK). Codex 는 이 PC 에서 앱을 못 돌려 소스 정적 대조만 수행(.handoffs/review-M3-screen-static.md).

- 1 — OK. review 파생본에 `배포 계획 만들기`(MOCK 안내 포함), 승인 뒤 `승인됨` + `배포 계획 보기` 링크.
- 2 — OK(예약 과거 → "예약 시각은 지금부터 1분 뒤 이후여야 합니다(모스크바 시각)"). 계정 선택지는 MOCK Threads 계정 1개뿐. [P3] 오류 뒤 폼이 초기화되어 체크·날짜 입력이 사라짐.
- 3 — OK(나갈 내용·공개 범위·즉시 일정·payload hash·MOCK 배지, 승인 체크 기본 미선택). 미확인: 첨부 checksum·"MSK (UTC)" 병기는 첨부·예약이 있는 계획에서만 보임 → 별도 확인 필요.
- 4 — OK. 확인 체크 없이 승인 → `"내용을 확인했습니다"를 체크해야 승인할 수 있습니다.`; 승인 후 승인 기록(시각·hash)·`철회` 버튼; 파생본 수정 → 승인 자동 철회 `invalidated:body_changed`, 항목 `계획됨(실행 전)`, "스냅샷이 지금과 다릅니다 — 승인·실행할 수 없습니다(새 계획 필요)" 안내.
- 결함 후보
  - D1 [P1] 파생본 편집 폼(화면)이 여러 문단 본문을 저장하지 못함. 원인: 브라우저는 폼 제출 때 textarea 줄바꿈을 \r\n 으로 보내는데 `variantBodyMismatch`(packages/domain/src/channel.ts:204)는 \n\n 으로 이은 thread_parts 와 비교. 재현(검증됨): 같은 내용을 form-urlencoded 로 \r\n → `?error=invalid`, \n → `?variant_saved=threads`. JSON API 는 정상(201).
  - D2 [P2] 같은 폼의 오류 문구가 일반적("저장하지 못했습니다. 입력값을 확인하세요.") — 본문과 metadata(JSON) 중복 필드가 같아야 한다는 설명이 없고, 사용자가 편집 칸에서 원시 JSON 을 직접 맞춰야 함.
  - D3 [P2] 홈 `/` "최근 배포" 카드가 M3 완료 후에도 "배포 기능은 M3에서 활성화됩니다 · 현재 게시: 비활성" 표시(Codex 정적 검토도 page.tsx:200 에서 독립 확인).
  - D4 [P3] 원고 화면 옛 문구: "채널별 배포 기록은 M3 배포함에서 따로 보여 줍니다", 관계 영역 "파생본: M2에서 채널별 초안 추가"; YouTube 카드 "완성 영상 업로드는 아직 지원하지 않습니다(이미지·PDF·텍스트만)" — T08 로 영상 업로드가 열렸으므로 구식.
  - D5 [P2] (Codex 정적) distribute/[id]/page.tsx:303–331 성공 배너가 쿼리값만으로 표시(`?approved=1&executed=1`) — 표시 문제, 서버 승인 우회 아님.
  - D6 [P3] (Codex 정적) 체크리스트 문구와 UI 문구 차이: 5번 `QUEUED · MOCK` ↔ UI `QUEUED · 대기`(작업 제목에 MOCK 표기), 8번 `완료` ↔ UI `처리 끝(MOCK — 실제 발행 아님)`. 실제 화면에서 확인 예정.

## 완료 기록 (2026-09-30 21:0x MSK) — 12항목 전부 확인, 결함 후보 정리
검증자: 구현 담당 Claude(이 세션, 내장 브라우저 + 같은 세션 fetch). Codex 는 이 PC 에서 앱을 못 돌려 소스 정적 대조만(.handoffs/review-M3-screen-static.md, gpt-6-astra/xhigh) — 체크리스트 자체는 독립 검증이 아님.
테스트 데이터: 원고 3cb6ed1c…, 파생본 4채널(Threads 06cdd7f7 v3·블로그 4a88016d·Instagram 562fe17e(PNG 5eb9590f)·YouTube b50fc995(MP4 8cd81c24)), 계획 6~7개(94cff7ac 예약·미승인, 18ac2e2d 단일 성공, f64e53c6 4채널, be1348c0 UNKNOWN+취소, 3aea0eeb hang+취소, 그 밖에 탐색 중 만든 미승인 계획 1개). 업로드 세션 1개(미완료, 24h 만료).

- 5 — OK. 지금 실행 → `QUEUED · 대기 · 시도 0/5`(제목 "작업(MOCK — 모의 어댑터)"). 같은 command_key 재제출 → "같은 실행 요청 — 기존 결과", 새 키 → "이미 실행한 항목입니다. 중복 작업을 만들지 않았습니다."(error=already_executed). 작업 ID 1개.
- 6 — OK. 처리 실행 → `CONFIRMED · MOCK 확인(실제 발행 아님)`, publication `mock://threads/…`, "실제 발행 실적 아님", "게시 완료" 류 문구 없음.
- 7 — OK. auth → "계정 다시 연결 필요"(작업 "BLOCKED · 계정 인증 필요(자동 재시도 안 함)"); transient_then_success → "재시도 대기 (1/5, 다음 20:50 MSK)" 뒤 성공; ambiguous_sent → "등록 여부 확인 필요" → 재확인 → CONFIRMED; reconcile_unsupported → 자동 확인 3회 뒤 "확인 불가 — 자동 재전송 안 함, 재확인 또는 새 계획 필요"(UNKNOWN).
- 8 — OK(문구 차이 D6). 4채널 중 Instagram 만 auth → 계획 "부분 성공(MOCK…)", 시나리오를 success 로 바꾸고 재시도 → 처리 → "처리 끝(MOCK — 실제 발행 아님)". 재시도 채널만 시도 2·의도 2, 성공한 채널은 다시 보내지 않음(각 publication 1건).
- 9 — OK. YouTube success → 먼저 "비공개 업로드 처리 중 — 확인 대기"(REMOTE_PROCESSING) → 재확인 → "비공개 업로드 완료, 공개 전환 확인 필요" + MOCK + "실제 발행 실적 아님". 공개 성공 표시 없음.
- 10 — OK. QUEUED 취소 → "취소됨"(작업 0회 시도); hang 시나리오 전송 중(SENDING) 취소 → "취소 확인 중"(CANCEL_REQUESTED), 시간 초과 처리 뒤에도 취소 성공을 단정하지 않고 유지.
- 11 — OK. /api/health: jobs{queued,leased,retry_wait,reconciling,unknown,blocked,attention_plans} 집계만, 비밀·경로 없음(문자열 pglite 는 DB 드라이버명).
- 12 — OK(핵심). dev 서버 재시작 전후 4개 계획의 작업 상태·시도·이벤트·의도·publication·permalink 동일(취소 확인 중 작업만 이벤트 5→7, 재시작 뒤 확인 진행). 단 재시작 직후 동적 경로가 404 → 결함 D9.
- 2·3 보충 — OK. 예약 "일정: 2026-10-02 10:00 (MSK) (UTC 2026-10-02T07:00:00.000Z)", 첨부 "1. video · 8cd81c24 · video/mp4 · sha256 b6f0c2bbc163", "1. image · 5eb9590f · image/png · sha256 497790947d46"(업로드 때 계산한 값과 일치). 승인 없는 실행은 `approval_required` 로 거부, 승인은 payload hash 와 함께만 성립.
- 보너스: M2 분할 업로드(세션→조각→완료)로 영상 자산이 VERIFIED / scope=signature_size_checksum 으로 만들어져 YouTube 파생본이 검토·계획까지 통과.

### 결함 후보 최종 (앞선 D1~D6 + 추가)
- D1 [P1] 파생본 편집 폼(화면)이 여러 문단 본문을 저장하지 못함(CRLF vs \n\n 비교). 검증됨.
- D2 [P2] 같은 폼의 일반 오류 문구·원시 JSON 중복 입력 노출.
- D3 [P2] 홈 "최근 배포" 옛 안내("M3에서 활성화"). Codex 정적 검토도 독립 확인.
- D4 [P3] 원고 화면 옛 문구(배포함 안내, "파생본: M2에서 …", YouTube "영상 업로드 미지원").
- D5 [P2] 성공 배너가 쿼리 문자열만으로 표시됨 — 미승인·작업 0건 계획에 ?approved=1&executed=1 → "1개 항목을 승인했습니다/대기열에 넣었습니다"(실제 검증됨, 서버 상태는 불변).
- D6 [P3] 체크리스트 문구 ↔ UI 문구(`QUEUED · MOCK` ↔ `QUEUED · 대기`, `완료` ↔ `처리 끝(MOCK — …)`). 체크리스트 쪽을 고치는 것이 자연스러움.
- D7 [P3] hang 시나리오에서 `작업 처리 실행` 요청이 시간 초과(약 30초)까지 화면을 붙잡음.
- D8 [P2] 수동 「재확인」 결과 배너가 unsupported·unknown 까지 "원격에서 결과를 찾지 못했습니다"로 표시(route.ts:32 가 found/not_found 로 뭉갬) — 불명을 "없음"으로 읽게 만들어 재전송 오해 유발. 실제 이벤트 기록은 `reconcile: unsupported` 로 정확.
- D9 [P2·환경] dev 서버가 재시작/빌드 뒤 동적·하위 경로를 404 로 돌려줌(오늘 2회 + 09-25 1회): `/api/uploads/sessions/{id}/chunks/…`, `/distribute/new`, `/distribute/{id}`, `/api/jobs/{id}`. 프로덕션 빌드 라우트 목록에는 모두 있음. `.next/dev`·`.next/cache` 삭제 후 재기동하면 복구. 재발 방지책 필요(Turbopack dev 파일 캐시 끄기 또는 dev 시작 시 정리).
- D10 [P3] 오류 리다이렉트 뒤 폼 입력(체크·날짜)이 초기화됨. 승인 체크는 안전상 의도일 수 있음.
- D11 [P3] 채널 초안 제목이 "카드: …" 접두어를 포함("제목: 카드: 주재원으로…") — 원고 본문의 "> 카드:" 스캐폴드가 그대로 변환됨.

## 수정 뒤 재확인 (2026-10-01 새벽, HEAD d2b1db8 — D1·D2·D3·D5·D8·D9)
- D9 — OK. `pnpm build` 직후 dev 재기동에서 /distribute/{id} 200, /distribute/new 200, /api/jobs/{id} 401(경로 존재) — 404 없음. turbopackFileSystemCacheForDev=false 적용.
- D5 — OK. 미승인 계획에 ?approved=1&executed=1&canceled=1&retried=1 → 배너 없음.
- D8 — OK. reconcile_unsupported 항목 재확인 → ?reconciled=unsupported, "이 채널은 원격 조회를 지원하지 않아 확인하지 못했습니다. 원격에 없다는 뜻이 아닙니다. 다시 보내지 않았습니다."
- D3 — OK. 홈 "최근 배포" 에 최근 계획(이름·MOCK·상태 라벨·채널·MSK) 표시, 옛 "M3에서 활성화" 문구 없음.
- D1 — OK. 폼 경로(form-urlencoded, CRLF 3문단) → ?variant_saved=threads, Threads 버전 4 "문단 하나 / 문단 둘 / 문단 셋". 
- D2 — OK. JSON 칸은 나머지 필드만({}), 도움말 "본문이 곧 채널 본문입니다…", 깨진 JSON → ?error=metadata_json "채널 형식(JSON)을 읽을 수 없어 저장하지 않았습니다."
- 남은 P3(D4·D6·D7·D10·D11)는 미수정. Codex 정적 재검증: .handoffs/review-FIX-M3screen.md(진행 중).

## 종결 (2026-10-01 밤)
- 수정 커밋: d2b1db8(D1·D2·D3·D5·D8·D9) → 7548f12(P3 D4·D6·D7·D10·D11 + Codex 놓친 케이스 2건) → cf13ae5(배너 조건 분리·재시도 이벤트 기준·스캐폴드 보존).
- Codex(gpt-6-astra/xhigh) 판정: FIX-M3screen CHANGES_REQUESTED(P1 1·P2 1) → FIX-M3p3 CHANGES_REQUESTED(P2 1) → FIX2-M3screen **PASS**. 11건 결함 전부 종결.
- 실제 화면 재확인(d2b1db8 기준) 전부 통과. 7548f12·cf13ae5 의 변경은 테스트로 검증(화면 재확인은 아침 선택).
