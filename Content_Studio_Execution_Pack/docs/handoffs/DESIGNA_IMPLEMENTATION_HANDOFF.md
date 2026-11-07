# Implementation handoff — DESIGN-A (시스템 다크)

- **Task ID / milestone:** DESIGN-A — 사용자가 고른 스타일 "A · 시스템 다크"(macOS 설정 앱 같은 다크) 앱 전체 적용. M4 화면 다듬기.
- **Purpose and changed behavior:** 화면 모양만 바뀐다(서버·도메인·API·DB·문구 판정 동작 변경 없음). 다크가 기본(`:root`), `prefers-color-scheme: light` 이면 Apple 라이트 변형. 대부분 `apps/web/app/globals.css` 토큰·공통 클래스로, 마크업은 패턴이 필요한 곳만 조금 바꿈(아래 "패턴").
- **BASE_SHA:** 685e99f
- **HEAD_SHA:** uncommitted — orchestrator commits.
- **Clean tracked tree confirmed:** 아니오 — 아래 변경 파일이 커밋되지 않은 상태(의도). `.claude/` 는 원래 untracked, 건드리지 않음.
- **Relevant acceptance IDs:** 지시문 DESIGN-A 의 견본·하드 제약(안전 표시 유지·기존 시험 통과·AA 대비·새 의존성 없음·375px). AGENTS.md 불변식은 서버 쪽이며 이번 변경과 무관.

## 색 토큰(globals.css)

| 토큰 | 다크(기본 `:root`) | 라이트(`prefers-color-scheme: light`) | 쓰임 |
|---|---|---|---|
| `--bg` | `#000000` | `#f2f2f7` | 페이지 바탕 |
| `--card` | `#1c1c1e` | `#ffffff` | 묶음 패널(.card, .group-list) |
| `--surface-2` | `#2c2c2e` | `#e5e5ea` | 보조 버튼, code, 원문 상자, 하위 내비 활성 |
| `--surface-3` | `#3a3a3c` | `#ffffff` | 보조 버튼 hover |
| `--text` | `#f5f5f7` | `#1d1d1f` | 본문 |
| `--muted` | `#98989d` | `#6e6e73` | 보조 글자(.note·.meta·breadcrumb) |
| `--border` | `#38383a` | `#c6c6c8` | 0.5px 구분선 |
| `--field-bg` / `--field-border` | `#1c1c1e` / `#6e6e73` (polish, 3.36:1) | `#ffffff` / `#86868b` (polish, 3.62:1) | 입력·textarea·select (1px) |
| `--accent` | `#0a84ff` | `#007aff` | 포커스 링, 분할 컨트롤·`.card.empty` 강조 |
| `--primary-fill` (polish) | `#0071e3` | `#0071e3` | 주 버튼 채움(흰 글자 4.70:1) |
| `--link` | `#409cff` | `#0058b0` | 링크 글자(AA 위해 강조색과 분리) |
| `--seg-track` / `--seg-active` | `#1c1c1e` / `#3a3a3c` | `#e3e3e8` / `#ffffff`(+0.5px `#c6c6c8`) | 윗줄 분할 컨트롤 |
| `--success` · `-bg` · `-text` | `#30d158` · 15% · `#30d158` | `#34c759` · 15% · `#1a6e30` | VERIFIED, 저장됨, diff 추가 |
| `--warning` · `-bg` · `-text` | `#ff9f0a` · 15% · `#ff9f0a` | `#ff9500` · 15% · `#9a4a00` | 실제 게시(.tag.live), 경고 태그(.tag.warn), .notice 배경 |
| `--warning-border` | `rgba(255,159,10,.4)` | `rgba(255,149,0,.55)` | .tag.live·.badge.live·.notice 테두리 |
| `--notice-text` | `#ffb340` | `#7a3d00` | .notice 긴 글자, mark |
| `--danger` · `-bg` · `-text` | `#ff453a` · 15% · `#ff6961` | `#ff3b30` · 15% · `#b0121b` | diff 삭제, .tag.danger |
| `--purple` · `-bg` · `-text` | `#bf5af2` · 15% · `#da8fff` | `#af52de` · 15% · `#8030b0` | 사용자 확인(.tag.user-confirmed) |
| `--info-bg` / `--info-text` | 15% `#0a84ff` / `#409cff` | 15% `#007aff` / `#0058b8` | (예비) |
| `--neutral` · `-bg` · `-text` | `#8e8e93` · 24% · `#d1d1d6` | `#8e8e93` · 24% · `#48484a` | 일반 태그, MOCK(.tag.mock), 배지 |
| `--radius` / `--radius-sm` | 12px / 8px | 같음 | 패널 / 버튼·입력·분할 칸 |
| `--font` | `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif` | 같음 | 외부 글꼴 없음 |

- `X-text` 는 "같은 색 15% 틴트 위 글자"가 AA 4.5:1 이 되도록 고른 같은 계열 색(다크의 빨강·보라·파랑, 라이트 전부는 견본 색 그대로 쓰면 4.5:1 미만이라 조정). 견본 색 자체(`--success` 등)는 그대로 있고 채움·테두리·diff 막대에 쓴다.
- 이전 토큰 이름(`--badge-bg`, `--warn-bg/-text`, `--live-bg/-text`, `--verified-*`, `--userconf-*`)은 새 토큰 별칭으로 남김. `--live-*` 는 빨강 → 주황으로 바뀜(실제 = 주황).

## 도입한 패턴
1. **분할 컨트롤 내비**: 윗줄 `.site-nav-groups` = `#1c1c1e` 트랙, 3px 안쪽 여백, 활성(`aria-current`) 칸 `#3a3a3c`·8px·굵게. 375px 에서는 폭을 채워 칸을 나눠 가짐(6칸 약 295px), 720px 이상은 내용 폭. 둘째 줄 `.site-subnav` = 조용한 알약 링크(보조 글자, 활성만 `#2c2c2e` 알약). 마크업 변경 없음(site-nav.tsx 그대로) — 검색은 이제 오른쪽 끝이 아니라 마지막 칸.
2. **breadcrumb** 12px 보조 글자, 현재 조각만 본문 색. **제목** `.screen-title` 26px(720px 이상 28px)·`.header h1` 28px, weight 600, letter-spacing −0.3px. 카드 h3 17px/600, h4 는 13px 보조 글자 묶음 머리글.
3. **묶음 패널**: `.card` = `#1c1c1e`·12px·테두리 없음(패널 색으로 구분), 목록 구분선 0.5px.
4. **`.group-list` 키-값 행**(새, 재사용): `<dl className="group-list"><div className="row"><dt/><dd/></div></dl>` — 행 12px 14px, 행 사이 0.5px 구분선(왼쪽 들여쓰기), dt 본문색·dd 보조색 오른쪽 정렬, 좁으면 줄바꿈. `.card` 안에서는 패널 가장자리까지 펼침. 적용: 배포 계획 항목 카드(공개 범위·일정·요청 결과), 설정 카드(로그인 방식 / AI·월 상한·가격 / 음성 전사·1분 가격·예산 / 서버 암호화 키·redirect URI). 문구는 그대로이고 "라벨:" 접두어만 dt 로 옮김(예: "AI: 모의(…)" → dt "AI" + 태그 "모의(…)").
5. **태그 = 알약**(999px, 같은 색 15% 틴트): `.tag`(회색) · `.tag.warn`(주황) · **새 `.tag.live`**(주황 + 1px 주황 테두리 + 굵게 — 실제 게시·실제 계정) · **새 `.tag.mock`**(회색 + 점선 테두리 + 굵게 — MOCK, 일반 회색 태그와도 구분) · `.tag.verified`(초록) · `.tag.user-confirmed`(보라) · `.tag.danger`(빨강, 예비).
   - 이전에는 MOCK 과 실제 게시가 둘 다 `tag warn`(같은 색)이었음 → 지시("실제는 주황, MOCK 은 회색, 섞이지 않게")대로 **글자 그대로의 MOCK 태그 13곳은 `tag mock`, "실제 …" 태그 12곳은 `tag live`** 로 바꿈(`실제 게시 대상 미지정` 은 경고라 `tag warn` 유지). `planRowTag` 는 `MOCK_TAG_CLASS`/`LIVE_TAG_CLASS` 상수, 운영 「배포 작업」 태그는 새 `opsJobsTagClass()`(opsJobsTag 와 같은 기준), 운영·설정의 live 모드 태그도 `tag live`.
6. **경고 안내 `.notice`**: 주황 15% 틴트 + 0.5px 주황 테두리 + `--notice-text` 글자. 안의 보조 글자(`--muted`)·링크는 안내 글자색을 이어받아 대비 유지. `.saved` 는 초록 틴트.
7. **버튼**: 기본은 채운 보조(`#2c2c2e`, 8px). 주 버튼은 `className="primary"`(강조색 채움·흰 글자·600) — 폼(묶음)마다 하나, 저장·만들기 류 12곳에만: 홈 "서버에 저장", 로그인 2, 원고 "원고 저장(버전 1)", 원고 편집 "새 버전으로 저장", 소재 저장, 카드 저장 2, 브랜드 저장, 가져오기 미리보기 만들기, 수집 소스 추가, "배포 계획 만들기(승인 전 …)". **승인·실행·작업 처리·재시도·사용자 확인 같은 게시 관련 버튼은 일부러 주 버튼으로 만들지 않음**(보조 그대로).
8. **입력·textarea·select**: `#1c1c1e` + 1px 테두리, 포커스 시 강조색 테두리 + 3px 파란 링. 체크박스·라디오 `accent-color`.
9. **"자세히" `<details class="more">`**: 기본 표시 삼각형 숨김, CSS 셰브런(›, 열리면 ⌄로 회전) + 보조 글자, hover 시 본문색. 마크업 그대로.
10. 그라디언트·무거운 그림자 없음(테두리 강조는 `inset 0 0 0 1px` 한 줄). 표(`.compare`)는 아래 구분선만, 머리글 12px 보조 글자.

## Changed files
- 스타일: `apps/web/app/globals.css`(전면 재작성 — 기존 클래스 이름 모두 유지 + `.group-list/.row`, `.tag.live`, `.tag.mock`, `.tag.danger`, `button.primary`)
- 마크업(작은 변경):
  - 태그 클래스(`tag warn` → `tag mock`/`tag live`): `apps/web/app/distribute/[id]/page.tsx`, `apps/web/app/distribute/new/page.tsx`, `apps/web/app/distribute/page.tsx`, `apps/web/app/collect/runs/[id]/page.tsx`, `apps/web/app/settings/page.tsx`, `apps/web/app/ops/page.tsx`
  - 묶음 목록 행: `apps/web/app/distribute/[id]/page.tsx`(항목 카드), `apps/web/app/settings/page.tsx`(로그인·AI·계정 카드)
  - 주 버튼 `className="primary"`: `apps/web/app/page.tsx`, `apps/web/app/login/page.tsx`, `apps/web/app/contents/page.tsx`, `apps/web/app/contents/[id]/page.tsx`, `apps/web/app/captures/[id]/page.tsx`, `apps/web/app/ideas/page.tsx`, `apps/web/app/ideas/[id]/page.tsx`, `apps/web/app/brand/page.tsx`, `apps/web/app/imports/page.tsx`, `apps/web/app/collect/page.tsx`, `apps/web/app/distribute/new/page.tsx`
- 순수 함수: `apps/web/lib/record-labels.ts` — `LIVE_TAG_CLASS`, `MOCK_TAG_CLASS`, `opsJobsTagClass()` 추가, `planRowTag` 클래스만 변경(문구 동일).
- 시험: 새 `apps/web/lib/design-tokens.test.ts`; 수정 `apps/web/lib/ui-safety.test.ts`, `apps/web/lib/record-labels.test.ts`, `apps/web/lib/plan-detail-render.test.ts`, `apps/web/lib/distribute-list-render.test.ts`
- 새 의존성 없음, 외부 글꼴·CDN 없음. 마이그레이션 없음.

### 기존 시험 변경 — 이름 바꾸기만(같은 강도), 약화 없음
클래스가 바뀌어 **정확한 문자열을 고정하던 단언의 토큰만** 새 이름으로 바꿈. 단언 수·조건은 그대로.
| 파일 | 전 | 후 |
|---|---|---|
| ui-safety.test.ts | `MOCK_TAG = '<span className="tag warn">MOCK</span>'` | `…"tag mock">MOCK…` |
| ui-safety.test.ts | `"tag warn">실제 게시 — 실제 계정`, `실제 게시 승인`, `실제 게시 준비됨`, 설정 `MOCK : 실제 계정` | 같은 문자열의 `tag live`/`tag mock` |
| ui-safety.test.ts | `'공개 범위: {live ? \`${LIVE_THREADS_VISIBILITY_TEXT}(승인 값 public)\`'` | `'<dt>공개 범위</dt><dd>{live ? \`${LIVE_THREADS_VISIBILITY_TEXT}(승인 값 public)\`'` (묶음 행으로 옮김 — 같은 식이 접힌 곳 밖에 있어야 함은 그대로) |
| distribute-list-render / plan-detail-render | `<span class="tag warn">MOCK</span>` | `<span class="tag mock">MOCK</span>` |
| distribute-list-render | `toContain('실제 게시 포함')` | `toContain('<span class="tag live">실제 게시 포함</span>')`(더 엄격) |
| record-labels.test.ts | `planRowTag` → `className: 'tag warn'` ×2 | `'tag mock'` / `'tag live'` |
plan-detail-render 의 상태 태그 정규식(`<p class="meta"><span class="tag">`)은 바꾸지 않음 — 항목 카드의 첫 메타 줄을 상태 태그로 유지해 그대로 통과.

### 추가한 시험
- `design-tokens.test.ts`(globals.css 를 읽음): 다크·라이트 견본 값 일치, 틴트 = 같은 색 15%, **AA 4.5:1** — 본문/보조/링크 글자(바탕·패널, 본문은 #2c2c2e 위도), 태그 글자 6종(경고·회색·초록·보라·빨강·파랑)을 실제 바탕·패널 위에 틴트 합성해 계산, .notice·.saved 글자, 안내 안의 주황·MOCK 태그(틴트 2겹), 주 버튼 흰 글자·포커스 링 3:1(아래 위험 1). `.tag.live`(주황 토큰+테두리) vs `.tag.mock`(회색+점선, warning 토큰 없음) 규칙, 두 모드 모두 주황≠회색, `.notice` 주황 틴트, `.tag` 999px, 그라디언트·`@import`·`@font-face`·`url(` 없음, 글꼴 스택.
- `ui-safety.test.ts` DESIGN-A 블록: `app/**/*.tsx` 전체에서 글자 그대로의 `MOCK` 태그는 모두 `tag mock`, "실제 …" 태그는 모두 `tag live`(예외 "실제 게시 대상 미지정" = `tag warn`), `tag live` 안에 MOCK/모의 문구 없음.
- `plan-detail-render.test.ts`: 실제 카드 = `tag live` 있고 `tag mock` 없음 + 공개 범위(승인 값 public)·일정·요청 결과 행, 모의 카드 = `tag mock` 있고 `tag live` 없음 + 요청 결과 행 "MOCK 실행(실제 게시 아님)".
- `record-labels.test.ts`: `opsJobsTagClass`(없음/모의만/섞임/실제만, opsJobsTag 와 같은 기준), 상수 값.

## Actual commands and results
환경: `export PATH="/usr/bin:/mingw64/bin:$PATH"; source tools/env.sh;` 후 `corepack pnpm …` — 스크립트 `.handoffs/run-checks-DESIGNA.sh`, 요약 `.handoffs/checks-DESIGNA.log`(세부 `checks-DESIGNA.{lint,typecheck,unit,integ,build,drill}.log`).

| 명령 | 결과 | 로그 |
|---|---|---|
| 대상 단위 5파일(design-tokens·ui-safety·record-labels·plan-detail-render·distribute-list-render), 작성 중 | PASS — 69 tests | (콘솔) |
| `corepack pnpm lint` | PASS (0) | checks-DESIGNA.lint.log |
| `corepack pnpm typecheck` | PASS (0) | checks-DESIGNA.typecheck.log |
| `corepack pnpm exec vitest run --project unit` | PASS — 76 files · 1822 tests | checks-DESIGNA.unit.log |
| `corepack pnpm exec vitest run --project integration --maxWorkers=2` | PASS — 50 files · 917 tests | checks-DESIGNA.integ.log |
| 포트 3000 확인(비어 있음) → `corepack pnpm build` | PASS (0) — Compiled successfully | checks-DESIGNA.build.log |
| `corepack pnpm drill:mock` | PASS — 불변식 위반 0건 | checks-DESIGNA.drill.log |
| db:migrate · drill:restore · 개발 서버 | not_run(지시) | — |

시작 전 node 프로세스 0개, 끝난 뒤에도 0개. 아무 프로세스도 종료하지 않음.

## Demo route / local start steps
개발 서버를 켜지 않음(지시 — orchestrator 가 브라우저 확인). 볼 곳: `/`(분할 컨트롤·제목·주 버튼·모드 배지), `/distribute/<id>`(항목 카드 묶음 행, 실제=주황 테두리 태그 / MOCK=회색 점선, .notice, 확인 후보·"Threads에서 확인함"·오류 코드 줄), `/settings`(묶음 행, 계정 표의 MOCK/실제 계정 태그), `/distribute/new`, `/ops`, 아무 화면의 `자세히`. 375px·라이트 모드(OS 설정)도.

## External calls performed
없음(네트워크 0, `.env.local`·`./data` 열지 않음, db:migrate·drill:restore 안 함).

## Mock-only functionality
변경 없음(모양만).

## Known risks / not run
1. **[polish 에서 해결 — #0071e3, 4.70:1]** **주 버튼 글자 대비**: 견본대로 흰 글자 on `#0a84ff`(다크) = 3.65:1, on `#007aff`(라이트) = 4.02:1 — 큰 글자/비텍스트 기준(3:1)은 넘지만 일반 글자 AA(4.5:1)는 못 넘음(Apple 시스템 파랑 자체의 한계). 시험은 3:1 로 고정. 4.5:1 이 필요하면 `--accent` 를 버튼에만 `#0071e3`(4.70:1, apple.com 버튼 색) 로 바꾸면 됨(토큰 1개).
2. **링크 색**: 다크 `--link #409cff`, 라이트 `#0058b0` — 견본 강조색(`#0a84ff`/`#007aff`)을 링크 글자에 그대로 쓰면 다크 #2c2c2e·주황 틴트 위, 라이트 흰 바탕 위에서 4.5:1 미만이라 분리함. 강조 채움·포커스 링은 견본 색 그대로.
3. **[polish 에서 해결 — 3:1 이상]** 입력 테두리(`#48484a` on `#1c1c1e`, 라이트 `#c6c6c8` on 흰색)는 "가는 선" 견본을 따랐고 WCAG 1.4.11(3:1)에는 못 미침 — 포커스 링은 3:1 이상.
4. 0.5px 구분선은 1x 화면에서 브라우저가 1px 로 그리거나 옅게 그릴 수 있음.
5. 브라우저로 보지 않음(375px·데스크톱·다크·라이트 모두 CSS 계산·렌더 시험·빌드만). 분할 컨트롤 6칸 폭은 글자 크기로 계산(약 295px < 343px).
6. 검색 링크가 윗줄 오른쪽 끝이 아니라 분할 컨트롤의 마지막 칸이 됨(`li.end` 의 margin-left:auto 를 뺌 — 마크업은 그대로라 되돌리기 쉬움).
7. **[polish 에서 해결 — h1.app-name]** 홈은 `h1 "Content Studio"`(28px) 아래 `h2 "오늘"`(26–28px) 두 제목이 비슷한 크기 — 원하면 h1 을 작게.
8. 다크 기본이므로 OS 가 라이트를 알리면 라이트 변형이 보임(지시대로). 사용자가 항상 다크를 원하면 라이트 블록을 빼거나 수동 전환이 필요(이번 범위 밖).

## Questions specifically for Codex
1. `tag mock`/`tag live` 분리로 바꾼 시험 토큰(위 표)이 강도를 유지하는지, 빠진 MOCK/실제 태그 경로(식으로 만드는 클래스 — `jobsTag`, `planRowTag`, `b.live`)가 있는지.
2. 항목 카드의 공개 범위·요청 결과를 `<dl class="group-list">` 행으로 옮긴 것이 안전 표시(공개 범위·실제/MOCK 요청 결과)를 약하게 만들지 않는지.
3. 주 버튼을 게시 관련 동작(승인·실행·작업 처리)에 주지 않은 판단이 맞는지.

## Next authorized task
orchestrator 결정(브라우저 확인 → 커밋 → Codex 검증).

---

# DESIGN-A polish (coordinator 브라우저 확인 후 결정 5건)
- **BASE_SHA:** 685e99f (DESIGN-A 와 같은 작업 트리, 아직 커밋 전). **HEAD_SHA:** uncommitted — orchestrator commits.

| 결정 | 변경 | 시험(design-tokens.test.ts) |
|---|---|---|
| 1 주 버튼 채움 | 새 토큰 `--primary-fill: #0071e3`(두 모드), `button.primary` 가 이것으로 채움. hover 는 `brightness(0.92)`(더 어둡게 → 대비 유지; 전엔 1.08 로 밝게). `--accent` `#0a84ff`/`#007aff` 는 포커스 링·분할 컨트롤 등에 그대로 | 두 모드 `--primary-fill` = #0071e3, 흰 글자 대비 **4.5:1 이상**(4.70). 이전의 "on-accent/accent 3:1" 단언은 이 4.5:1 단언으로 대체(대상이 버튼 채움 토큰으로 바뀜 — 더 엄격). 규칙: `button.primary` 배경 = `var(--primary-fill)`, hover 에 밝게(brightness 1.x) 없음, `:focus-visible` = `var(--accent)` |
| 2 입력 테두리 | `--field-border` 다크 `#48484a`→`#6e6e73`(on #1c1c1e 3.36:1), 라이트 `#c6c6c8`→`#86868b`(on #fff 3.62:1). 1px 선 그대로 | `field-border/field-bg` **3:1 이상**(WCAG 1.4.11), 포커스 링 3:1 유지, 입력 규칙이 `1px solid var(--field-border)` |
| 3 검색 위치 | 변경 없음(분할 컨트롤 마지막 칸) | — |
| 4 홈 제목 | 홈 `<h1>` 에 `className="app-name"`(`apps/web/app/page.tsx` 한 줄) → 16px·600·보조 글자색. 화면 제목 "오늘"(26/28px)이 유일한 큰 제목. 로그인 화면의 `<h1>` 은 그 화면의 유일한 제목이라 그대로(큰 제목) | `.header h1.app-name` 이 보조 글자색이고 15–17px 범위, `.screen-title` 보다 작음 |
| 5 묶음 행 구분선 | 카드 안 `.group-list` 의 위·아래 전체 폭 선(패널 왼쪽 끝까지 가던 선)을 없애고, 모든 구분선을 들여 있는 `.row`(margin-left 16px — 라벨 시작 위치)에만 그림: 각 행 위 0.5px, 마지막 행 아래 0.5px(목록이 카드 마지막이면 생략). 카드 밖 독립 `.group-list` 는 원래대로 행 사이만(14px 들여) | `.card .group-list` 에 border 선언 없음, `.card .group-list .row` 에 margin-left 16px + border-top, 독립 행 margin 14px·padding-left 0 |

## Changed files (polish)
`apps/web/app/globals.css`, `apps/web/app/page.tsx`(h1 className 하나), `apps/web/lib/design-tokens.test.ts`(단언 추가·버튼 단언 4.5:1 로 강화). 다른 시험·마크업 변경 없음. 새 의존성 없음.

## Commands (polish) — `.handoffs/run-checks-DESIGNA-POLISH.sh`, 요약 `.handoffs/checks-DESIGNA-POLISH.log`
| 명령 | 결과 |
|---|---|
| design-tokens.test.ts 단독(작성 중) | 1차 1 실패(`border-radius` 가 "border" 에 걸린 시험 자체 오류 → 정규식을 border/-top/-bottom/-left 선언으로 고침) → PASS 22 tests |
| lint · typecheck | PASS · PASS |
| unit | PASS — 76 files · 1828 tests |
| integration `--maxWorkers=2` | PASS — 50 files · 917 tests |
| 포트 3000 비어 있음 확인 → build | PASS |
| drill:mock | PASS — 불변식 위반 0건 |
| db:migrate · drill:restore · 개발 서버 | not_run(지시) |

외부 호출 없음. node 프로세스 시작 전·후 0개, 아무것도 종료하지 않음.

## Remaining risks (polish)
1. 브라우저로 polish 를 다시 보지 않음(개발 서버 금지) — 특히 카드 안 묶음 행의 첫 행 위 들여쓴 선이 위 내용과 자연스러운지, 입력 테두리 굵기감.
2. 남은 견본 차이: 링크 글자 `#409cff`/`#0058b0`(위 위험 2), 주 버튼 `#0071e3`(견본 #0a84ff 보다 약간 어두움 — 결정 1).
