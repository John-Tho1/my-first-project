# Implementation handoff — UI-CLEAN

- **Task ID / milestone:** UI-CLEAN (M4 화면 정리). Plan: `.handoffs/UICLEAN_PLAN.md` (orchestrator-approved).
- **Purpose and changed behavior:** 사용자 요청 "메뉴도 산만하고 글자가 너무 많아서 복잡" · "대항목 밑에 소항목이 있으면 hierarchy가 안보여서 엄청 불편".
  - 12개 평면 메뉴 → 대항목 5개 + 검색, 활성 표시(굵게 + 2px 강조 밑줄, `aria-current`), 활성 대항목의 소항목만 둘째 줄에 표시.
  - 모든 화면(오늘·로그인 제외)에 현재 위치(breadcrumb) 추가, 제각각이던 "← …" 뒤로 링크와 소재함 화면의 중복 "Content Studio" h1 제거.
  - 긴 안내문은 한 줄로 줄이고 나머지는 `<details className="more"><summary>자세히</summary>` 로 접음. 안전 표시(실제 게시/MOCK, 실제 발행 실적 아님, 승인 경고, 공개 범위·확인 상태, 결과 불명 안내, 확인 후보·"Threads에서 확인함" 버튼과 경고, 사용자 확인/확인됨 태그, Threads 오류 코드 줄, 준비 안 됨 줄, AI 출처·MOCK_WARNING, 1인칭 미확인 경고, 내보내기 "개인 원문")는 모두 접힌 곳 밖에 그대로 둠.
  - 서버·도메인·API 동작 변경 없음(화면 문구·구조만). `lib/*.ts` 기존 문자열은 수정하지 않음.
- **BASE_SHA:** 90a2660 (작업 시작 시점). 작업 중 orchestrator 가 docs 전용 커밋 59d9485(docs/DECISIONS.md 1줄)를 올렸고, 이 작업과 겹치는 파일은 없음.
- **HEAD_SHA:** uncommitted — orchestrator commits.
- **Clean tracked tree confirmed:** 아니오 — 아래 변경 파일이 커밋되지 않은 상태(의도한 상태). `.claude/` 는 원래부터 untracked 였고 건드리지 않음.
- **Relevant acceptance IDs:** UICLEAN_PLAN §1–§4. 기존 승인·게시 불변식(AGENTS.md Invariants)은 서버 쪽이며 이번 변경과 무관.

## 최종 내비게이션 구조
| 윗줄(대항목) | 열리는 곳 | 둘째 줄(소항목) | 활성 경로 |
|---|---|---|---|
| 오늘 | `/` | — | `/` 정확히 일치만 |
| 모으기 | `/captures` | 소재함 `/captures` · 음성 메모 `/record` · 가져오기 `/imports` · 자동 수집 `/collect` | 각 접두사 |
| 쓰기 | `/contents` | 원고 `/contents` (+`/distribute/new`) · 카드 `/ideas` | 각 접두사 |
| 배포 | `/distribute` | 배포함 `/distribute` · 배포 계정 `/settings#accounts`(바로가기, 활성 안 됨) | `/distribute` |
| 관리 | `/settings` | 설정 `/settings` · 브랜드 프로필 `/brand` · 운영 `/ops` | 각 접두사 |
| 검색(오른쪽 끝) | `/search` | — | `/search` |

- 판정: `path === p || path.startsWith(p + '/')`, 가장 긴 접두사 우선(`/distribute/new` → 쓰기 › 원고). 쿼리·해시·끝 `/` 무시. `/login` 에서는 내비게이션 숨김.
- 대항목 링크: 소항목이 있으면 `aria-current="true"`, 없으면(오늘·검색) `"page"`. 소항목: `aria-current="page"`. 호버 드롭다운 없음.
- 구현: 순수 로직 `apps/web/lib/nav.ts`(NAV_GROUPS, navState, crumbsFor, crumbTitle), 클라이언트 컴포넌트는 `apps/web/app/site-nav.tsx` 하나(`usePathname`), 서버 컴포넌트 `apps/web/lib/breadcrumbs.tsx`.
- Breadcrumb: `<nav aria-label="현재 위치" class="crumbs"><ol>`. 대항목 이름은 링크 아님(분류 이름), 중간 소항목·제목은 링크, 마지막은 `aria-current="page"` 이고 링크 아님. 제목은 40자(코드 포인트)+말줄임, 비면 "(제목 없음)", 계획 이름이 비면 "이름 없음". 화면이 이미 읽은 데이터만 씀(추가 조회 없음).

## 화면별 전/후
| 화면 | 전 | 후 |
|---|---|---|
| 공통 레이아웃 | 12개 평면 링크, 로그인 화면에도 표시 | 묶음 내비 2줄, 로그인에서 숨김 |
| `/` 오늘 | 빠른 수집 아래 안내 2줄 | 안내 2줄 → `자세히` 하나로. 세션 바·모드 배지 그대로 |
| `/captures`, `/captures/[id]` | 중복 h1 "Content Studio" + "← 오늘"(· 소재함) | 모으기 › 소재함(› 제목/원문 미리보기) |
| `/record` | 전사 안내 + 형식 제한 2문단 | "전사: 모의(실제 음성 인식 아님) · live 준비 안 됨: …" 보임, D9·형식·제한은 `자세히` |
| `/imports[/id]`, `/collect[/runs/id]` | "← 가져오기", "← 수집" | 모으기 › 가져오기 › {원본 종류 + 시각} / 모으기 › 자동 수집 › {label ?? host} |
| `/contents` | 제목 "아카이브" | 쓰기 › 원고, 제목 "원고"(메뉴 이름과 맞춤) |
| `/contents/[id]` | "← 아카이브", 배포 안내 긴 문장, 편집 안내, 원고 정보 폼 항상 펼침 | 쓰기 › 원고 › 제목, "배포 상태는 배포함에서 봅니다.", 편집 안내 `자세히`, 원고 정보 폼은 `<details>` "원고 정보 편집(…)". 1인칭 미확인 경고 그대로 |
| 작성 보조(writing-panel) | 입력·자동 거부 긴 문단, 주장 확인 긴 문단 | "입력: 본문(버전 n)·Brand Profile·답변 n개·출처 n개." + `자세히`. 주장: "확인하거나 본문에서 빼기 전에는 "준비됨"으로 바꿀 수 없습니다." 보임 + 나머지 `자세히`. MOCK_WARNING·모드 안내·출처 미검증 태그 그대로 |
| 채널 초안(variants-panel) | 3줄 안내, 긴 배포 링크 문구 | "채널별 초안 — 자동 게시 없음(…)" + `자세히`. 배포 링크 문구 단축(실제/모의 구분 유지). 승인됨 문구가 실제 계정 채널이면 "(MOCK)" 대신 "(실제 게시 계정 승인일 수 있음 — 계획에서 확인)" |
| `/contents/[id]/versions/[n]`, `/diff` | "← 작성실" | 쓰기 › 원고 › 제목 › 버전 n / 버전 비교 a→b |
| `/ideas[/id]` | "← 카드 목록" | 쓰기 › 카드(› 카드 문구) |
| `/distribute/new` | 긴 안내, "← 원고로 돌아가기", 긴 라벨 | 쓰기 › 원고 › 제목 › 배포 계획 만들기. 실제 계정 있음: "실제 계정을 고르고 승인·실행하면 **실제로 게시**됩니다(모의 계정은 MOCK). 계획 생성만으로는 승인·게시되지 않습니다." / 모의만: "MOCK — 계획을 만들어도 승인·게시되지 않습니다." 나머지·요청 결과 설명·예약 공개 설명·Instagram 이미지 규격은 `자세히`. Instagram "MOCK 게시뿐이고 공개 범위는 공개(public)만" 보임. 라벨 단축(예: "실행 예약 날짜(모스크바·선택 — 비우면 즉시)") |
| `/distribute` | "MOCK — 지금 단계(M4)… 모의만" 고정 문구(실제 계정이 있어도) | 실제 게시 계정(live_publish_target) 유무에 따라 문구 분기. 계정 안내 한 줄 + `자세히` |
| `/distribute/[id]` | 메타 줄의 "배포함" 링크, 긴 상단 안내, 작업 처리 설명, 취소·재시도 2줄, 모의 시나리오 폼 항상 표시 | 배포 › 배포함 › 계획 이름. 상단 안내 2줄(실제로 게시·되돌리기 없음·결과 모르면 자동 재게시 안 함·MOCK 실제 발행 실적 아님) + `자세히`. 실행 노트 한 줄씩 + `자세히`. 취소·재시도 → 하나의 `자세히`. 모의 ID 안내 첫 문장 보임. 모의 시나리오 폼 → `<details><summary>개발용: 모의 시나리오</summary>`. 실행 버튼 단축, 작업 처리 버튼은 "작업 처리 실행(1회 — 실제 게시 항목은 실제로 게시)" 유지. 항목 카드의 Threads 오류 코드 줄·확인 후보(미확인) 줄·"Threads에서 확인함" 버튼과 경고·사용자 확인/확인됨 태그·LIVE_UNKNOWN_GUIDANCE 는 그대로 |
| `/settings` | AI·계정·내보내기·복원 긴 안내, Brand Profile 카드 | 관리 › 설정. D7/D13/D34 → `자세히`. 계정: "모의 연결은 실제 게시에 쓰이지 않습니다. 실제 게시는 "실제 게시 계정으로 사용"한 Threads 계정의 승인 글만 합니다." + 나머지 `자세히`. 준비 상태 줄 그대로. 내보내기 "개인 원문…" 보임. 복원 "미리보기 단계에서는 데이터가 바뀌지 않습니다." Brand Profile 카드 삭제(메뉴가 대신). `id="accounts"` 는 이미 있었음 |
| `/settings/restores/[id]` | "← 설정" | 관리 › 설정 › 복원 미리보기 |
| `/brand` | "← 설정", 제목 "Brand Profile" | 관리 › 브랜드 프로필, 제목 "브랜드 프로필(Brand Profile)" |
| `/ops` | 긴 안내 3곳 | 관리 › 운영. 측정 안내 한 줄 + `자세히`, 복원 훈련 노트 `자세히`, 보존 정책 수치 `자세히`("원문 소재·출처·원고 버전은 지우지 않습니다" 보임). 준비 안 됨 줄 그대로 |
| `/search` | — | 검색(위치) |

## Changed files
- 새 파일: `apps/web/lib/nav.ts`, `apps/web/lib/breadcrumbs.tsx`, `apps/web/app/site-nav.tsx`, `apps/web/lib/nav.test.ts`, `apps/web/lib/nav-render.test.ts`, `apps/web/lib/ui-safety.test.ts`
- 수정: `apps/web/app/layout.tsx`, `apps/web/app/globals.css`, `apps/web/app/page.tsx`, `apps/web/app/captures/page.tsx`, `apps/web/app/captures/[id]/page.tsx`, `apps/web/app/record/page.tsx`, `apps/web/app/imports/page.tsx`, `apps/web/app/imports/[id]/page.tsx`, `apps/web/app/collect/page.tsx`, `apps/web/app/collect/runs/[id]/page.tsx`, `apps/web/app/contents/page.tsx`, `apps/web/app/contents/[id]/page.tsx`, `apps/web/app/contents/[id]/writing-panel.tsx`, `apps/web/app/contents/[id]/variants-panel.tsx`, `apps/web/app/contents/[id]/versions/[n]/page.tsx`, `apps/web/app/contents/[id]/diff/page.tsx`, `apps/web/app/ideas/page.tsx`, `apps/web/app/ideas/[id]/page.tsx`, `apps/web/app/distribute/page.tsx`, `apps/web/app/distribute/new/page.tsx`, `apps/web/app/distribute/[id]/page.tsx`, `apps/web/app/settings/page.tsx`, `apps/web/app/settings/restores/[id]/page.tsx`, `apps/web/app/brand/page.tsx`, `apps/web/app/ops/page.tsx`, `apps/web/app/search/page.tsx`
- 새 의존성 없음. CSS 는 기존 `:root`/`prefers-color-scheme: dark` 토큰만 사용(새 색 토큰 없음).

## Tests added
- `lib/nav.test.ts`: app 의 page.tsx 목록 = 기대표(새 화면이 생기면 실패), 모든 화면이 정확히 한 대항목·소항목, `/contentsx`·`/opsx`·`/searching` 등 경계, `/` 정확히 일치, `/distribute/new` 예외, 배포 계정 바로가기 비활성, `/login` 숨김, 경로 정규화, 모든 crumbsFor 경로·40자 자르기·말줄임(이모지 포함)·"(제목 없음)"·"이름 없음", 마지막 조각 비링크.
- `lib/nav-render.test.ts`: `renderToStaticMarkup` + `next/navigation` 가짜 — SiteNav 활성·aria-current·둘째 줄·검색 오른쪽·로그인 빈 출력·모르는 경로, Breadcrumbs 구조·escape·자르기·오늘 빈 출력.
- `lib/ui-safety.test.ts`: 바뀐 화면 소스에서 `<details>…</details>`(중첩 포함, 짝 불일치면 실패)를 지운 뒤 안전 토큰이 남아 있는지(LIVE_UNKNOWN_GUIDANCE, LIVE_CANDIDATE_LABEL, 미확인 태그, USER_CONFIRM_BUTTON/WARNING, USER_CONFIRMED_NOTICE, user-confirm 폼, diagLine, LIVE_THREADS_VISIBILITY_TEXT, liveVerificationLabel/Tag, 실제로 게시, 되돌리기 없음, MOCK 태그 + 실제 발행 실적 아님, MOCK_WARNING, resultLabel, 1인칭 미확인, livePublish.missing 등 준비 안 됨 줄, 개인 원문 …). 반대로 `<details>` 안에 안전 상수가 들어가지 않았는지, 모든 화면이 `<Breadcrumbs>` 를 그리고 `←` 가 없는지.
- 기존 시험·assertion 은 수정하지 않음.

## Migrations / restore implications
없음(스키마·데이터·내보내기 형식 변경 없음).

## Actual commands and results
환경: `export PATH="/usr/bin:/mingw64/bin:$PATH"; source tools/env.sh;` 후 `corepack pnpm …` (스크립트 `.handoffs/run-checks-UICLEAN.sh`, 요약 `.handoffs/checks-UICLEAN.log`).
| 명령 | 결과 | 로그 |
|---|---|---|
| `corepack pnpm lint` | PASS (0) | checks-UICLEAN.lint.log |
| `corepack pnpm typecheck` | PASS (0) | checks-UICLEAN.typecheck.log |
| `corepack pnpm exec vitest run --project unit` | PASS — 72 files · 1766 tests | checks-UICLEAN.unit.log |
| `corepack pnpm exec vitest run --project integration` (기본 maxWorkers 3) | **크래시** — 워커 node "Fatal process out of memory: Zone"; 그 직전 `ops-retention.test.ts` "P1: 미완료 정리 1개 뒤에 완료된 계획이 1,000개 넘게…" 1건 60179ms 시간 초과로 실패, 요약 줄 없음(`INTEG=0-NO-SUMMARY`) | checks-UICLEAN.integ.log |
| `corepack pnpm exec vitest run --project integration --maxWorkers=2` (재실행) | PASS — 49 files · 915 tests (892.6s) | checks-UICLEAN.integ2.log |
| `corepack pnpm drill:mock` (1차) | PASS — 불변식 위반 0건 (주의: 크래시한 1차 통합 시험의 vitest 프로세스가 아직 살아 있는 동안 실행됨) | checks-UICLEAN.drill.log |
| 포트 3000 확인 → FREE, `corepack pnpm build` | PASS (0) — Compiled successfully | checks-UICLEAN.build.log |
| `corepack pnpm drill:mock` (2차, 단독) | PASS — 불변식 위반 0건 | checks-UICLEAN.drill2.log |
| db:migrate, drill:restore | not_run (지시에 따라) | — |

1차 통합 실행의 vitest 프로세스(PID 8912 외 워커)는 pnpm 이 끝난 뒤에도 남아 있었고, 아무것도 종료하지 않고 스스로 끝나기를 기다림(약 3분 뒤 종료). 그 뒤 2-워커 재실행이 통과. OOM 은 이번 변경(화면 문구·순수 함수)과 무관한 부하 문제로 보임 — ops-retention 1,000건 시험이 Windows 3-워커에서 메모리를 많이 씀.

## Demo route / local start steps
개발 서버를 켜지 않았음(지시). 확인할 때: `corepack pnpm dev` → `/`, `/captures/<id>`, `/distribute/new?content_id=<id>`, `/distribute/<id>`, `/settings` 에서 둘째 줄·위치·`자세히` 확인. 375px 폭(16px 여백, 가로 스크롤 없음)은 CSS 로 맞췄으나 **브라우저에서 눈으로 확인하지 않음**.

## External calls performed
없음(네트워크 0, `.env.local`·`./data` 열지 않음).

## Mock-only functionality
변경 없음. 화면 문구만 실제/모의 구분을 유지하거나(배포함) 더 정확하게 바꿈.

## Known risks / not run
1. 375px·데스크톱·다크 모드 화면을 실제 브라우저로 보지 않음(렌더 시험·빌드만). 6개 대항목 윗줄은 약 300px 로 계산했고 `flex-wrap` 이라 줄바꿈은 되지만 가로 스크롤은 없음. 표(`.table-scroll`)는 원래대로 표 안에서만 가로 스크롤.
2. ui-safety 는 소스 문자열 검사라 조건부 렌더 경로 자체는 보지 않음(토큰이 접힌 곳 밖에 있다는 것만 보장).
3. 원고 정보 폼을 `<details>` 로 접어 상태(준비됨 등) 변경이 한 번 더 클릭해야 함. 저장 오류 시 자동으로 열리지 않음.
4. 계획 범위 밖 변경 2건: `/contents` 제목 "아카이브"→"원고", `/brand` 제목 "Brand Profile"→"브랜드 프로필(Brand Profile)"(메뉴·위치 이름과 맞춤). 원치 않으면 되돌리기 쉬움.
5. 남아 있는 오래된 문구(이번에 손대지 않음): `/ops` 의 "현재 연결은 모두 모의(MOCK)입니다"·"배포 작업(MOCK)" 제목은 실제 Threads 계정이 있으면 사실이 아님. `/distribute/[id]` 의 요청 결과 혼합 안내 "(MOCK — 실제 게시 아님)"도 원래 문구 그대로. 별도 작업 권장.
6. 1차 통합 실행 OOM(위 표). 재실행은 PASS.

## Questions specifically for Codex
1. `<details>` 로 옮긴 문장 중 안전 표시로 봐야 할 것이 있는지(특히 `/distribute/[id]` 실제 게시 안내의 "실제 게시 조건(PUBLISH_MODE·게시 승인 기록·게시 수 상한)이 없으면 보류" 와 LiveThreadsSteps 의 "확인 후보(미확인)" 설명).
2. `/distribute` 목록 안내 분기(`!a.mock && a.live_publish_target`)가 맞는 기준인지.
3. variants-panel 승인됨 문구 "(실제 게시 계정 승인일 수 있음 — 계획에서 확인)" 이 `livePlatforms`(판정 아님) 기준이라 충분히 보수적인지.
4. `/distribute/new` 를 쓰기 › 원고로 두는 활성 판정이 사용자 흐름에 맞는지.

## Next authorized task
orchestrator 결정(커밋 → Codex 검증).
