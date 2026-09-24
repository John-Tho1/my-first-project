# 로컬 이관 런북 — M0+M1 Codex 검증 → 화면 확인 → M2 착수 준비
작성: 2026-09-24 (Europe/Moscow), 클라우드 세션(Fable 5.1 오케스트레이션). 대상: 사용자 Windows PC (Node v24.21.0 포터블, pnpm 12.6.0, Codex CLI 0.155.1).

이 폴더(`docs/handoffs/`)는 **클라우드→로컬 인계용 임시 추적 사본**이다. 원칙(AGENTS.md)상 인계 산출물은 gitignore 된 `.handoffs/`에 두므로, 로컬에서 아래 0단계로 옮긴 뒤 이 폴더는 삭제 커밋해도 된다. 비밀값은 없다.

## 0. 브랜치 가져오기·환경
```bash
# Git Bash, 저장소 루트(my-first-project)
git fetch origin content-studio/m0-m1-imvkel
git checkout content-studio/m0-m1-imvkel
git log --oneline 2182224..HEAD          # T01~T05 커밋 5개 + 이 런북 커밋
cd Content_Studio_Execution_Pack
source tools/env.sh                      # PowerShell: . .\tools\env.ps1
node -v && corepack pnpm -v              # v24.21.0 / 12.6.0 이어야 함
mkdir -p .handoffs && cp docs/handoffs/T0*_IMPLEMENTATION_HANDOFF.md .handoffs/
```
[미확인] Windows/Node 24에서의 실행은 아직 한 번도 확인되지 않았다(클라우드 Node 22.22.2 결과만 있음). 아래 1단계가 첫 확인이다.

## 1. 로컬 구동 확인 (Codex 전에 5분)
```bash
corepack pnpm install --frozen-lockfile
cp .env.example .env.local
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test && corepack pnpm test:integration
corepack pnpm db:seed                    # 10 inserted / 10 total
corepack pnpm dev                        # http://localhost:3000
```
문제가 나면 그 출력 그대로 로컬 Claude Code 세션에 붙여 넣는다(예상 지점: `tools/env.sh`의 cygpath, `process.loadEnvFile`, PGlite 잠금 `process.kill(pid,0)` Windows 동작, eslint 10 peer 경고).

## 2. Codex 검증 (작업별 커밋 1개 = 리뷰 1회)
| 작업 | BASE_SHA | HEAD_SHA(커밋) | 인계 문서 |
| --- | --- | --- | --- |
| T01 | 2182224 | 43112a9 | T01_IMPLEMENTATION_HANDOFF.md |
| T02 | 43112a9 | f20f5bb | T02_IMPLEMENTATION_HANDOFF.md |
| T03 | f20f5bb | 55be710 | T03_IMPLEMENTATION_HANDOFF.md |
| T04 | 55be710 | 97dd427 | T04_IMPLEMENTATION_HANDOFF.md |
| T05 | 97dd427 | be3fd8f | T05_IMPLEMENTATION_HANDOFF.md |

> **로컬 확인(2026-09-24, Windows)**: `codex --sandbox read-only review --commit` 은 이 PC 에서 read-only 샌드박스가 셸 명령을 모두 막아
> 빈 결과("confidence is low")만 나온다. 대신 `./scripts/codex-review-commit.sh <SHA> <작업명> [인계문서]` (codex exec + stdin diff,
> GPT-6 Astra / xhigh 고정)를 쓴다. 결과는 `.handoffs/review-<작업명>.md`, 실제 model/effort 헤더는 `.log`.
>
docs/06 절차대로 **별도 worktree**에서 read-only 로 돌린다. 상위 저장소의 `scripts/codex-review.sh`는 diff를 stdin에 싣는 방식이라 200KB 한도(lockfile 포함 T01 diff가 초과)에 걸리므로 쓰지 않는다.
```bash
# 저장소 루트에서
git worktree add --detach ../content-studio-review be3fd8f
cd ../content-studio-review/Content_Studio_Execution_Pack
codex --help && codex review --help      # 0.155.1 옵션 확인(--commit / --base)

# 작업별 diff 리뷰 (한 번에 하나, 옵션 혼합 금지)
codex --sandbox read-only review --commit 43112a9    # T01
codex --sandbox read-only review --commit f20f5bb    # T02
codex --sandbox read-only review --commit 55be710    # T03
codex --sandbox read-only review --commit 97dd427    # T04
codex --sandbox read-only review --commit be3fd8f    # T05
# M1 전체 누적 리뷰(선택): codex --sandbox read-only review --base 2182224
```
구조화 보고서가 필요하면(선택) `prompts/CODEX_REVIEW.md` + 해당 인계 문서를 함께 주고 `review/review.schema.json` 형식으로 받는다:
```bash
codex exec --sandbox read-only --output-schema review/review.schema.json -o ../../.handoffs/review-T05.json \
  "$(cat prompts/CODEX_REVIEW.md) $(cat .handoffs/T05_IMPLEMENTATION_HANDOFF.md)"
```
동작 검증(테스트 실행)은 read-only 코드 검토와 분리해 disposable worktree에서 `corepack pnpm install --frozen-lockfile && corepack pnpm test && corepack pnpm test:integration`으로 한다. 운영 비밀·계정은 주지 않는다.

리뷰 결과는 `.handoffs/review-T0x-*.md|json`으로 저장하고, 전문을 대화에 붙이지 말고 **지적 항목만** 로컬 Claude Code에 전달한다. 수정은 `prompts/CLAUDE_FIX.md` 절차(재현 → 최소 수정 → 새 HEAD → 재검증). 인계 문서 말미의 "Questions specifically for Codex"가 각 작업의 핵심 위험 지점이다.

## 3. 화면 확인 체크리스트 (`corepack pnpm dev`, 식별자 `owner@example.local`)
| # | 화면 | 확인 |
| --- | --- | --- |
| 1 | `/api/health` | modes mock/disabled/disabled, db.captures 10, worker inline |
| 2 | `/login` | 개발용 로그인 안내, 틀린 식별자 → 일반 오류 문구(허용 식별자 노출 없음) |
| 3 | `/` 오늘 | 상단 배지 `LLM: 모의` `게시: 비활성` `수집: 비활성`, MSK 시각, 세션 만료, 이어 쓸 초안·추천 소재·확인 필요·최근 배포(M3 안내) |
| 4 | 빠른 수집 | 텍스트 1건 저장 → `/captures/{id}?saved=1`에 `서버에 저장됨 ✓`; URL(`https://example.com/a?utm_source=x`) 저장 → 같은 URL 다른 utm 으로 재저장 시 `정확 중복` |
| 5 | `/captures/{id}` | 원문 읽기 전용, 메모 수정 → 수정 이력 증가; **탭 2개**에서 같은 항목 수정 → 두 번째 탭 409 비교 화면, 입력값 보존 |
| 6 | 추출 | URL 소재에서 `추출` → `수집 기능이 비활성` 안내; `http://127.0.0.1/x` 소재는 저장되지만 추출 시 내부 주소 거부 |
| 7 | 카드 | `카드로 발전` → `/ideas/{id}` Idea/Audience/Evidence/Risk/Next Decision 편집·저장 |
| 8 | 원고 | `원고 시작` → `/contents/{id}` 본문 저장 → v2; 버전 목록·`/versions/1` 읽기 전용·diff 화면; 탭 2개 stale 저장 → 409 비교+diff; 상태 전이(초안→검토) |
| 9 | `/search?q=주재원` | 소재 fx-007 + 관련 원고; `재고 리스`, `ai` 대소문자 무관 |
| 10 | 파일 | PNG 업로드 201, 같은 파일 재업로드 `duplicate`, 다운로드는 첨부 저장, 텍스트를 .png 로 올리면 415 |
| 11 | `/settings` | 내보내기 → zip 다운로드(manifest.json·markdown/·assets/); 그 zip 을 복원 미리보기 → 충돌 0·`없는 항목만 추가`로 커밋 → 0 복원 14 동일 |
| 12 | 로그아웃 | 뒤로 가기·`/` 재접속 시 `/login` |

모바일 폭(≤ 480px)에서 3·4·8번을 한 번 더 본다. 관찰한 불편·오류는 `.handoffs/screen-notes.md`에 화면 번호와 함께 적어 두면 M2 착수 시 반영한다.

## 4. M2 착수 준비
`docs/handoffs/M2_KICKOFF.md`를 읽고 그 안의 결정 5개를 확정한 뒤, 문서 끝의 "로컬 Claude Code 착수 프롬프트"를 붙여 넣는다. Codex P0/P1 지적이 남아 있으면 M2 착수 전에 먼저 수정·재검증한다.
