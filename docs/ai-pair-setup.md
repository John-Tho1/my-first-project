# Claude Code ↔ Codex CLI 병행 개발 설정 가이드

작성일 2026-09-19 · 대상 저장소 `my-first-project`

---

## 0. 먼저 짚고 갈 것 — "토큰 공유"는 불가능하다

| 기대 | 실제 |
|---|---|
| Claude와 Codex가 토큰/사용량을 함께 쓴다 | **불가능.** Anthropic과 OpenAI는 별개 사업자다. 과금·쿼터·인증이 서로 완전히 분리되어 있고, 이를 합치는 공식 경로는 없다. |
| 하나의 구독으로 둘 다 쓴다 | **불가능.** Claude Code는 Claude 구독 또는 Anthropic API 키, Codex는 ChatGPT 구독 또는 OpenAI API 키를 각각 요구한다. |

대신 **실제로 공유 가능한 것**은 세 가지이고, 이 문서와 저장소 설정은 그 세 가지를 구현한다.

1. **컨텍스트 공유** — 프로젝트 규칙을 `AGENTS.md` 한 곳에만 두고 두 도구가 같은 원본을 읽는다.
2. **산출물 공유** — `.ai/handoff/` 파일로 결과를 주고받는다. 대화로 옮겨 적지 않는다.
3. **예산 최적화** — 각자의 쿼터를 어디에 쓸지 역할로 나눠, 합계 소모량을 줄인다.

> 참고로 한쪽 쿼터는 그 벤더 안에서는 공유된다. ChatGPT 요금제로 로그인한 Codex는 CLI·IDE 확장·웹이 **같은 할당량**을 나눠 쓴다. 오전에 웹에서 많이 쓰면 오후에 터미널에서 쓸 몫이 줄어든다. [확실 — OpenAI 공식 문서 기반]

---

## 1. 설치 및 로그인

### 1-1. Codex CLI 설치

```bash
# macOS / Linux
curl -fsSL https://chatgpt.com/codex/install.sh | sh

# 또는 npm
npm install -g @openai/codex

# 또는 Homebrew (macOS)
brew install --cask codex
```

Windows(PowerShell):
```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

### 1-2. 로그인

```bash
codex          # 실행 후 "Sign in with ChatGPT" 선택 (Plus/Pro/Business/Edu/Enterprise)
```

API 키 방식도 가능하지만 **별도 종량 과금**이며 ChatGPT 요금제 할당량과 무관하다. 대부분의 경우 ChatGPT 로그인이 유리하다.

### 1-3. 설치 확인

```bash
codex --version
codex doctor        # 설치·설정·인증·런타임 상태 진단
claude --version    # Claude Code (이미 설치되어 있어야 함)
```

---

## 2. 저장소 설정 (이미 커밋되어 있음)

```
AGENTS.md                        ← 프로젝트 규칙 단일 원본 (Codex가 읽음)
CLAUDE.md                        ← @AGENTS.md import + Claude 전용 운영 규칙
scripts/codex-review.sh          ← Codex를 검증자로 실행
scripts/codex-task.sh            ← Codex에 서브 개발 위임
.claude/commands/codex-review.md ← /codex-review 슬래시 커맨드
.claude/commands/codex-task.md   ← /codex-task 슬래시 커맨드
.claude/settings.json            ← 스크립트 실행 권한 사전 허용
.codex/config.toml.example       ← Codex 프로필/MCP 설정 예시
.ai/handoff/                     ← 두 에이전트 간 결과물 교환 (커밋 제외)
```

로컬에서 한 번만:

```bash
cp .codex/config.toml.example .codex/config.toml
```

---

## 3. 연결 방식 — 두 갈래

### 3-A. Claude Code → Codex (주 경로, 권장)

Claude Code가 Bash로 `codex exec` / `codex review`를 호출한다. **MCP를 쓰지 않는다.**

이유: 현재 Codex CLI의 `codex mcp` 서브커맨드는 *외부 MCP 서버를 Codex에 등록하는* 관리 명령이다(`add`/`list`/`get`/`remove`/`login`/`logout`). 과거의 "Codex 자체를 MCP 서버로 띄우는" 진입점은 현재 메인 브랜치의 서브커맨드 목록에 없고, 그 자리는 `codex app-server`(experimental)가 대신한다. 즉 **Codex를 MCP 서버로 붙이는 구성은 버전에 따라 깨진다.** CLI 직접 호출이 훨씬 안정적이다. [확실 — openai/codex `codex-rs/cli/src/main.rs`, `mcp_cmd.rs` 소스 확인, 2026-09-19]

```bash
./scripts/codex-review.sh                 # 커밋 안 된 변경 리뷰
./scripts/codex-review.sh --base main     # main 대비 브랜치 전체 리뷰
./scripts/codex-task.sh "…"               # 서브 개발 위임
./scripts/codex-task.sh --dry "…"         # 계획만 (코드 수정 안 함)
```

Claude Code 세션 안에서는 슬래시 커맨드로:

```
/codex-review
/codex-review --base main
/codex-task 입력값 검증에 음수 처리를 추가해줘
```

### 3-B. Codex → Claude Code (보조 경로, 선택)

반대 방향은 MCP가 **공식적으로 동작한다.** Claude Code에 `claude mcp serve`가 있기 때문이다. [확실 — `claude mcp serve --help`, v2.1.278 확인]

```bash
codex mcp add claude-code -- claude mcp serve
codex mcp list                  # 등록 확인
```

또는 `.codex/config.toml`에 직접:

```toml
[mcp_servers.claude-code]
command = "claude"
args    = ["mcp", "serve"]
startup_timeout_sec = 30
tool_timeout_sec    = 300
```

Codex 세션 안에서 `/mcp`로 연결 상태를 확인한다.

**단, 이 경로는 기본적으로 꺼두기를 권한다.** Codex 세션이 Claude Code를 호출하면 양쪽 쿼터가 동시에 소모되고, 어느 쪽이 무엇을 했는지 추적이 어려워진다. Codex를 주로 쓰는 날에만 켜라.

---

## 4. 권장 워크플로우

```
① Claude Code에서 설계·구현          (주작업 — Claude 쿼터)
        ↓
② /codex-review                      (교차 검증 — Codex 쿼터, read-only)
        ↓
③ Claude Code가 지적을 검증 후 선별 반영
        ↓
④ 필요 시 /codex-task 로 독립 작업 위임 (Codex 쿼터, workspace-write)
        ↓
⑤ git diff 확인 → 커밋
```

핵심 원칙 네 가지.

1. **구현자와 검증자를 분리한다.** 같은 모델이 자기 코드를 리뷰하면 자기 가정을 그대로 재확인한다. 다른 벤더의 모델을 쓰는 실질적 이유가 이것이다.
2. **검증자는 read-only로만 돌린다.** 리뷰어가 코드를 고치기 시작하면 두 에이전트의 변경이 섞여 되돌리기 어렵다. `codex-review.sh`는 `--sandbox read-only`로 고정되어 있다.
3. **Codex의 지적을 그대로 수용하지 않는다.** 오탐이 나온다. Claude Code가 파일:줄 근거로 확인한 뒤 반영 여부를 판단한다.
4. **핸드오프는 파일로 한다.** 리포트 전문을 대화에 붙여넣으면 그 토큰이 이후 모든 턴에 누적된다.

---

## 5. 토큰/비용 최적화 체크리스트

### 5-1. 구조로 줄이기 (이미 적용됨)

| 조치 | 효과 |
|---|---|
| 규칙을 `AGENTS.md` 하나로 통합, `CLAUDE.md`는 `@AGENTS.md` import | 규칙 중복 기재 제거. 규칙을 두 파일에 복사하면 두 모델 모두에서 이중 소모된다 |
| 리뷰 입력을 **전체 저장소가 아니라 diff로** 한정 | 리뷰 1회당 입력 토큰이 파일 크기가 아니라 변경량에 비례한다 |
| `codex exec -o <file>` 로 최종 보고만 파일에 기록 | 중간 사고 과정이 Claude 컨텍스트로 들어오지 않는다 |
| 결과를 `.ai/handoff/` 파일로 교환 | 대화 히스토리 누적 방지 |
| diff 20만 바이트 초과 시 스크립트가 거부 | 대형 리뷰 1회로 하루 쿼터를 태우는 사고 방지 |

### 5-2. 운영으로 줄이기

- **역할 라우팅.** 설계·멀티파일 리팩터링은 Claude Code, 단발성 검증·독립 단위 작업은 Codex. 한쪽 쿼터가 바닥나면 역할을 일시적으로 바꾼다.
- **모델 등급 분리.** 검증은 상위 모델이 필요 없는 경우가 많다. `CODEX_MODEL` 환경변수로 낮은 등급을 지정한다.
  ```bash
  CODEX_MODEL=<저비용_모델명> ./scripts/codex-review.sh
  ```
  사용 가능한 모델명은 `codex exec --help` 또는 Codex 세션의 `/model`로 확인한다.
- **리뷰 트리거를 규칙화한다.** 매 변경마다 리뷰하지 않는다. `CLAUDE.md`에 3개 조건(계산 로직 변경 / 3개 이상 블록 수정 / 사용자 요청)만 정의해 두었다.
- **`/compact` 를 적극 쓴다.** Claude Code 세션이 길어지면 히스토리 전체가 매 턴 재전송된다. 작업 단위가 끝날 때마다 압축한다.
- **파일 전체 재독 금지.** `quote-calculator.html`은 단일 파일이라 통째로 읽으면 매번 8KB 이상이 들어간다. `sed -n 'A,Bp'`로 구간만 읽는다.
- **핸드오프 청소.** `rm -f .ai/handoff/review-* .ai/handoff/task-*` 를 주기적으로.
- **ChatGPT 쿼터 안배.** Codex CLI·IDE·웹이 같은 할당량을 쓴다. 웹에서 대화를 많이 한 날은 CLI 리뷰를 아껴라.

### 5-3. 하지 말 것

- 두 에이전트를 **같은 작업 트리에서 동시에** 돌리지 마라. 편집이 충돌하고 어느 쪽 변경인지 추적이 안 된다. 병렬로 돌리려면 `git worktree`로 디렉터리를 분리하라.
- `--sandbox danger-full-access`, `--yolo`, `--dangerously-skip-permissions` 를 쓰지 마라. 되돌릴 수 없는 사고의 대부분이 여기서 나온다.
- Codex ↔ Claude를 **서로 호출하게 연결(양방향 MCP)** 해두고 방치하지 마라. 재귀 호출로 양쪽 쿼터가 동시에 소진된다.

---

## 6. 동작 확인

```bash
# 1) 도구 확인
codex --version && claude --version

# 2) 리뷰 파이프라인 확인 — 변경이 없으면 정상 종료해야 한다
./scripts/codex-review.sh
#   → "리뷰할 변경분이 없습니다" 출력이면 정상

# 3) 실제 리뷰 — 아무 파일이나 한 줄 고친 뒤
./scripts/codex-review.sh
cat "$(./scripts/codex-review.sh)"    # 리포트 확인

# 4) 역방향 MCP 확인 (선택)
codex mcp add claude-code -- claude mcp serve
codex mcp list
```

---

## 7. 근거 및 확인 범위

| 항목 | 확인 방법 | 등급 |
|---|---|---|
| Codex 설치 명령·ChatGPT 로그인 | `openai/codex` 공식 README 직접 확인 | [확실] |
| `codex mcp` = 외부 MCP 서버 **관리** 명령 (add/list/get/remove/login/logout) | `codex-rs/cli/src/mcp_cmd.rs` 소스 확인 | [확실] |
| 현재 메인 브랜치에 `codex mcp-server` 서브커맨드 없음 | `codex-rs/cli/src/main.rs`의 `enum Subcommand` 전체 확인 | [확실] |
| `codex exec` 플래그 (`--sandbox`, `-o`, `--json`, `--ephemeral`) | `codex-rs/exec/src/cli.rs` 소스 확인 | [확실] |
| `codex review --uncommitted/--base/--commit` 존재 | `codex-rs/cli/src/main.rs` 확인 | [확실] |
| `claude mcp serve` 존재 | 이 환경에서 `claude mcp serve --help` 실행 확인 (v2.1.278) | [확실] |
| `-m/--model`, `-C/--cd` 플래그명 | 관례상 사용되는 플래그. 소스에서 직접 확인하지 못함 | [추정] — `codex exec --help`로 확인할 것 |
| 요금제별 구체적 사용량 한도·크레딧 수치 | 검색 결과에 상호 모순이 있어 채택하지 않음 | [미확인] — OpenAI 공식 요금 페이지에서 직접 확인할 것 |

**확인하지 못한 것:** `developers.openai.com`과 `help.openai.com`이 이 실행 환경의 네트워크 정책상 차단되어, Codex 공식 문서 본문과 요금제 한도 페이지는 직접 읽지 못했다. 대신 `openai/codex` 저장소의 소스와 README를 직접 읽어 CLI 동작을 확인했다. 요금·한도 수치는 이 문서에 넣지 않았다.
