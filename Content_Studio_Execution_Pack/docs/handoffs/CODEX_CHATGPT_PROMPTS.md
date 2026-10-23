# Codex 검증 — ChatGPT(Codex 웹)용 프롬프트

- 같은 검증을 로컬 CLI 대신 ChatGPT 의 Codex(웹)에서 돌릴 때 쓴다. 대기열은 `CODEX_QUEUE.txt` 와 같다(위에서부터, 16건 — 15번 FIX5-FULLREV·16번 FIX1-CODEX 는 2026-10-23 추가). 프롬프트 내용은 `scripts/codex-review-commit.sh` 의 리뷰 지시와 같고, 웹에서는 Codex 가 저장소를 직접 읽도록 바꿨다.
- **Claude 가 만든 준비물이며 Codex 판정이 아니다.** 결과는 사용자가 받아 와야 Codex 검증으로 기록한다.

## 진행 방법(사용자)
1. ChatGPT 에서 Codex(웹, chatgpt.com/codex)를 연다. 환경 설정에서 GitHub 를 연결하고, 저장소 `john-tho1/my-first-project` 접근을 허용한다(비공개 저장소 — 이 단계에서 코드가 OpenAI Codex 로 전달된다). 화면 이름은 바뀌었을 수 있다 [미확인].
2. 새 작업에서 저장소를 고르고 **브랜치 `content-studio/m4`** 를 고른다. 리뷰에는 설치(setup) 스크립트가 필요 없다.
3. 모델을 고를 수 있으면 로컬 규칙과 같은 `gpt-6-astra` / 추론 `xhigh`(Extra High)를 고른다. 없으면 가장 가까운 것을 쓰고, 리포트 "실행 정보"에 실제 모델이 남는다.
4. 아래 프롬프트 하나를 통째로 붙여 넣고 실행한다. 작업마다 새 작업 하나다(여러 개를 동시에 돌려도 된다). 코드 수정 제안이 나오면 적용·PR 생성은 하지 않는다.
5. 결과 리포트를 받아 온다. 방법은 둘 중 하나다.
   - Claude 대화에 그대로 붙여 넣는다(작업명 함께).
   - PC 앱 폴더의 `.handoffs/review-<작업명>.md` 로 저장한다(로컬 실행기 `bash scripts/codex-review-queue.sh` 는 "## 판정" 이 있는 작업을 건너뛰므로 웹·로컬을 섞어 써도 중복되지 않는다).

## 1. LIVEP2 — `ca7228e`

```text
당신은 GitHub 저장소 `john-tho1/my-first-project` 안의 Content Studio 앱(`Content_Studio_Execution_Pack/`)을 검토하는 독립 코드 리뷰어다. 구현자는 다른 에이전트(Claude Code)이며, 당신의 역할은 동의가 아니라 검증이다.

대상: 브랜치 `content-studio/m4` 의 커밋 `ca7228eaf4ed5fc5b52edbc22f97f54a92827a34`(짧은 SHA `ca7228e`, 작업명 `LIVEP2`) 1개.

먼저 읽을 것:
1. `Content_Studio_Execution_Pack/AGENTS.md` — 프로젝트 규칙과 불변 조건(Invariants). 위반 여부를 반드시 확인하라.
2. 인계 문서: `docs/handoffs/LIVEP2_IMPLEMENTATION_HANDOFF.md`
   — 이 커밋을 HEAD_SHA 로 적은 절을 중심으로 읽고, 그 절의 "검토자에게 물을 것"(또는 Questions)에 답하라.
3. 변경분: `git show ca7228e -- Content_Studio_Execution_Pack ':(exclude,glob)**/pnpm-lock.yaml' ':(exclude,glob)**/drizzle/meta/*_snapshot.json'`
   (커밋을 찾지 못하면 `git fetch origin content-studio/m4` 뒤 다시 시도.)

규칙:
- 파일을 수정하지 마라. 커밋·브랜치·PR 을 만들지 말고, 변경 제안(diff)도 만들지 마라 — 리포트만 출력한다.
- 읽기·grep·git log/show/diff 는 써도 된다. 테스트를 실행했다면 실제 명령과 결과를 그대로 적고, 실행하지 않았으면 실행했다고 주장하지 마라.
- 외부 서비스 호출·실계정·비밀값은 쓰지 마라.
- 이 커밋 뒤의 같은 브랜치 커밋이 이미 고친 문제는 `git log` 로 확인해 "이후 커밋 <SHA> 에서 해결됨"이라고 표시하라.
- 추측을 사실처럼 쓰지 마라. 확인하지 못한 것은 '미확인'으로 표시하라.
- 취향 문제(포매팅, 네이밍 선호)는 적지 마라. 동작·정확성·규칙 위반만 적어라.

다음 형식의 마크다운 리포트만 출력하라. 서론·칭찬·요약 인사말은 쓰지 마라.

## 판정
PASS 또는 CHANGES_REQUESTED 중 하나.

## 지적 사항
각 항목을 아래 형식으로. 없으면 '없음'이라고만 쓴다.
- [P0|P1|P2] 파일:줄 — 문제 한 줄 요약
  - 재현/실패 시나리오: 어떤 입력·상태에서 어떻게 잘못되는가
  - 제안: 구체적인 수정 방향
(P0 = 불변 조건 위반·데이터 손상·보안, P1 = 기능 오류·명세 불일치, P2 = 경계값·품질)

## Codex 질문에 대한 답
인계 문서의 질문 각 항목에 번호를 붙여 답하라. 질문이 없으면 '해당 없음'.

## 놓친 케이스
테스트나 수동 확인에서 빠졌을 가능성이 높은 입력·경계값 목록.

## 실행 정보
- 화면에 보이는 모델·추론 강도, 검토한 커밋 SHA, 실제로 실행한 명령 목록
```

## 2. EXPIRY1 — `5739e5a`

```text
당신은 GitHub 저장소 `john-tho1/my-first-project` 안의 Content Studio 앱(`Content_Studio_Execution_Pack/`)을 검토하는 독립 코드 리뷰어다. 구현자는 다른 에이전트(Claude Code)이며, 당신의 역할은 동의가 아니라 검증이다.

대상: 브랜치 `content-studio/m4` 의 커밋 `5739e5afc6d57452f0d0574ea3afe11fa8af69b2`(짧은 SHA `5739e5a`, 작업명 `EXPIRY1`) 1개.

먼저 읽을 것:
1. `Content_Studio_Execution_Pack/AGENTS.md` — 프로젝트 규칙과 불변 조건(Invariants). 위반 여부를 반드시 확인하라.
2. 인계 문서: `docs/handoffs/EXPIRY1_IMPLEMENTATION_HANDOFF.md`
   — 이 커밋을 HEAD_SHA 로 적은 절을 중심으로 읽고, 그 절의 "검토자에게 물을 것"(또는 Questions)에 답하라.
3. 변경분: `git show 5739e5a -- Content_Studio_Execution_Pack ':(exclude,glob)**/pnpm-lock.yaml' ':(exclude,glob)**/drizzle/meta/*_snapshot.json'`
   (커밋을 찾지 못하면 `git fetch origin content-studio/m4` 뒤 다시 시도.)

규칙:
- 파일을 수정하지 마라. 커밋·브랜치·PR 을 만들지 말고, 변경 제안(diff)도 만들지 마라 — 리포트만 출력한다.
- 읽기·grep·git log/show/diff 는 써도 된다. 테스트를 실행했다면 실제 명령과 결과를 그대로 적고, 실행하지 않았으면 실행했다고 주장하지 마라.
- 외부 서비스 호출·실계정·비밀값은 쓰지 마라.
- 이 커밋 뒤의 같은 브랜치 커밋이 이미 고친 문제는 `git log` 로 확인해 "이후 커밋 <SHA> 에서 해결됨"이라고 표시하라.
- 추측을 사실처럼 쓰지 마라. 확인하지 못한 것은 '미확인'으로 표시하라.
- 취향 문제(포매팅, 네이밍 선호)는 적지 마라. 동작·정확성·규칙 위반만 적어라.

다음 형식의 마크다운 리포트만 출력하라. 서론·칭찬·요약 인사말은 쓰지 마라.

## 판정
PASS 또는 CHANGES_REQUESTED 중 하나.

## 지적 사항
각 항목을 아래 형식으로. 없으면 '없음'이라고만 쓴다.
- [P0|P1|P2] 파일:줄 — 문제 한 줄 요약
  - 재현/실패 시나리오: 어떤 입력·상태에서 어떻게 잘못되는가
  - 제안: 구체적인 수정 방향
(P0 = 불변 조건 위반·데이터 손상·보안, P1 = 기능 오류·명세 불일치, P2 = 경계값·품질)

## Codex 질문에 대한 답
인계 문서의 질문 각 항목에 번호를 붙여 답하라. 질문이 없으면 '해당 없음'.

## 놓친 케이스
테스트나 수동 확인에서 빠졌을 가능성이 높은 입력·경계값 목록.

## 실행 정보
- 화면에 보이는 모델·추론 강도, 검토한 커밋 SHA, 실제로 실행한 명령 목록
```

## 3. FIX1-LIVEP2 — `7538492`

```text
당신은 GitHub 저장소 `john-tho1/my-first-project` 안의 Content Studio 앱(`Content_Studio_Execution_Pack/`)을 검토하는 독립 코드 리뷰어다. 구현자는 다른 에이전트(Claude Code)이며, 당신의 역할은 동의가 아니라 검증이다.

대상: 브랜치 `content-studio/m4` 의 커밋 `7538492e6f1a1ba6d167016591798d7559692fc6`(짧은 SHA `7538492`, 작업명 `FIX1-LIVEP2`) 1개.

먼저 읽을 것:
1. `Content_Studio_Execution_Pack/AGENTS.md` — 프로젝트 규칙과 불변 조건(Invariants). 위반 여부를 반드시 확인하라.
2. 인계 문서: `docs/handoffs/LIVEP2_IMPLEMENTATION_HANDOFF.md`
   — 이 커밋을 HEAD_SHA 로 적은 절을 중심으로 읽고, 그 절의 "검토자에게 물을 것"(또는 Questions)에 답하라.
3. 변경분: `git show 7538492 -- Content_Studio_Execution_Pack ':(exclude,glob)**/pnpm-lock.yaml' ':(exclude,glob)**/drizzle/meta/*_snapshot.json'`
   (커밋을 찾지 못하면 `git fetch origin content-studio/m4` 뒤 다시 시도.)

규칙:
- 파일을 수정하지 마라. 커밋·브랜치·PR 을 만들지 말고, 변경 제안(diff)도 만들지 마라 — 리포트만 출력한다.
- 읽기·grep·git log/show/diff 는 써도 된다. 테스트를 실행했다면 실제 명령과 결과를 그대로 적고, 실행하지 않았으면 실행했다고 주장하지 마라.
- 외부 서비스 호출·실계정·비밀값은 쓰지 마라.
- 이 커밋 뒤의 같은 브랜치 커밋이 이미 고친 문제는 `git log` 로 확인해 "이후 커밋 <SHA> 에서 해결됨"이라고 표시하라.
- 추측을 사실처럼 쓰지 마라. 확인하지 못한 것은 '미확인'으로 표시하라.
- 취향 문제(포매팅, 네이밍 선호)는 적지 마라. 동작·정확성·규칙 위반만 적어라.

다음 형식의 마크다운 리포트만 출력하라. 서론·칭찬·요약 인사말은 쓰지 마라.

## 판정
PASS 또는 CHANGES_REQUESTED 중 하나.

## 지적 사항
각 항목을 아래 형식으로. 없으면 '없음'이라고만 쓴다.
- [P0|P1|P2] 파일:줄 — 문제 한 줄 요약
  - 재현/실패 시나리오: 어떤 입력·상태에서 어떻게 잘못되는가
  - 제안: 구체적인 수정 방향
(P0 = 불변 조건 위반·데이터 손상·보안, P1 = 기능 오류·명세 불일치, P2 = 경계값·품질)

## Codex 질문에 대한 답
인계 문서의 질문 각 항목에 번호를 붙여 답하라. 질문이 없으면 '해당 없음'.

## 놓친 케이스
테스트나 수동 확인에서 빠졌을 가능성이 높은 입력·경계값 목록.

## 실행 정보
- 화면에 보이는 모델·추론 강도, 검토한 커밋 SHA, 실제로 실행한 명령 목록
```

## 4. FIX1-EXPIRY1 — `92cd026`

```text
당신은 GitHub 저장소 `john-tho1/my-first-project` 안의 Content Studio 앱(`Content_Studio_Execution_Pack/`)을 검토하는 독립 코드 리뷰어다. 구현자는 다른 에이전트(Claude Code)이며, 당신의 역할은 동의가 아니라 검증이다.

대상: 브랜치 `content-studio/m4` 의 커밋 `92cd026a4219b4f7e9389a8d9ed3f353673f9b22`(짧은 SHA `92cd026`, 작업명 `FIX1-EXPIRY1`) 1개.

먼저 읽을 것:
1. `Content_Studio_Execution_Pack/AGENTS.md` — 프로젝트 규칙과 불변 조건(Invariants). 위반 여부를 반드시 확인하라.
2. 인계 문서: `docs/handoffs/EXPIRY1_IMPLEMENTATION_HANDOFF.md`
   — 이 커밋을 HEAD_SHA 로 적은 절을 중심으로 읽고, 그 절의 "검토자에게 물을 것"(또는 Questions)에 답하라.
3. 변경분: `git show 92cd026 -- Content_Studio_Execution_Pack ':(exclude,glob)**/pnpm-lock.yaml' ':(exclude,glob)**/drizzle/meta/*_snapshot.json'`
   (커밋을 찾지 못하면 `git fetch origin content-studio/m4` 뒤 다시 시도.)

규칙:
- 파일을 수정하지 마라. 커밋·브랜치·PR 을 만들지 말고, 변경 제안(diff)도 만들지 마라 — 리포트만 출력한다.
- 읽기·grep·git log/show/diff 는 써도 된다. 테스트를 실행했다면 실제 명령과 결과를 그대로 적고, 실행하지 않았으면 실행했다고 주장하지 마라.
- 외부 서비스 호출·실계정·비밀값은 쓰지 마라.
- 이 커밋 뒤의 같은 브랜치 커밋이 이미 고친 문제는 `git log` 로 확인해 "이후 커밋 <SHA> 에서 해결됨"이라고 표시하라.
- 추측을 사실처럼 쓰지 마라. 확인하지 못한 것은 '미확인'으로 표시하라.
- 취향 문제(포매팅, 네이밍 선호)는 적지 마라. 동작·정확성·규칙 위반만 적어라.

다음 형식의 마크다운 리포트만 출력하라. 서론·칭찬·요약 인사말은 쓰지 마라.

## 판정
PASS 또는 CHANGES_REQUESTED 중 하나.

## 지적 사항
각 항목을 아래 형식으로. 없으면 '없음'이라고만 쓴다.
- [P0|P1|P2] 파일:줄 — 문제 한 줄 요약
  - 재현/실패 시나리오: 어떤 입력·상태에서 어떻게 잘못되는가
  - 제안: 구체적인 수정 방향
(P0 = 불변 조건 위반·데이터 손상·보안, P1 = 기능 오류·명세 불일치, P2 = 경계값·품질)

## Codex 질문에 대한 답
인계 문서의 질문 각 항목에 번호를 붙여 답하라. 질문이 없으면 '해당 없음'.

## 놓친 케이스
테스트나 수동 확인에서 빠졌을 가능성이 높은 입력·경계값 목록.

## 실행 정보
- 화면에 보이는 모델·추론 강도, 검토한 커밋 SHA, 실제로 실행한 명령 목록
```

## 5. LIVEL1H2 — `990fd5d`

```text
당신은 GitHub 저장소 `john-tho1/my-first-project` 안의 Content Studio 앱(`Content_Studio_Execution_Pack/`)을 검토하는 독립 코드 리뷰어다. 구현자는 다른 에이전트(Claude Code)이며, 당신의 역할은 동의가 아니라 검증이다.

대상: 브랜치 `content-studio/m4` 의 커밋 `990fd5d3b8d40a4bf415e46a0ffd58531a8e28ec`(짧은 SHA `990fd5d`, 작업명 `LIVEL1H2`) 1개.

먼저 읽을 것:
1. `Content_Studio_Execution_Pack/AGENTS.md` — 프로젝트 규칙과 불변 조건(Invariants). 위반 여부를 반드시 확인하라.
2. 인계 문서: `docs/handoffs/LIVEL1H2_IMPLEMENTATION_HANDOFF.md`
   — 이 커밋을 HEAD_SHA 로 적은 절을 중심으로 읽고, 그 절의 "검토자에게 물을 것"(또는 Questions)에 답하라.
3. 변경분: `git show 990fd5d -- Content_Studio_Execution_Pack ':(exclude,glob)**/pnpm-lock.yaml' ':(exclude,glob)**/drizzle/meta/*_snapshot.json'`
   (커밋을 찾지 못하면 `git fetch origin content-studio/m4` 뒤 다시 시도.)

규칙:
- 파일을 수정하지 마라. 커밋·브랜치·PR 을 만들지 말고, 변경 제안(diff)도 만들지 마라 — 리포트만 출력한다.
- 읽기·grep·git log/show/diff 는 써도 된다. 테스트를 실행했다면 실제 명령과 결과를 그대로 적고, 실행하지 않았으면 실행했다고 주장하지 마라.
- 외부 서비스 호출·실계정·비밀값은 쓰지 마라.
- 이 커밋 뒤의 같은 브랜치 커밋이 이미 고친 문제는 `git log` 로 확인해 "이후 커밋 <SHA> 에서 해결됨"이라고 표시하라.
- 추측을 사실처럼 쓰지 마라. 확인하지 못한 것은 '미확인'으로 표시하라.
- 취향 문제(포매팅, 네이밍 선호)는 적지 마라. 동작·정확성·규칙 위반만 적어라.

다음 형식의 마크다운 리포트만 출력하라. 서론·칭찬·요약 인사말은 쓰지 마라.

## 판정
PASS 또는 CHANGES_REQUESTED 중 하나.

## 지적 사항
각 항목을 아래 형식으로. 없으면 '없음'이라고만 쓴다.
- [P0|P1|P2] 파일:줄 — 문제 한 줄 요약
  - 재현/실패 시나리오: 어떤 입력·상태에서 어떻게 잘못되는가
  - 제안: 구체적인 수정 방향
(P0 = 불변 조건 위반·데이터 손상·보안, P1 = 기능 오류·명세 불일치, P2 = 경계값·품질)

## Codex 질문에 대한 답
인계 문서의 질문 각 항목에 번호를 붙여 답하라. 질문이 없으면 '해당 없음'.

## 놓친 케이스
테스트나 수동 확인에서 빠졌을 가능성이 높은 입력·경계값 목록.

## 실행 정보
- 화면에 보이는 모델·추론 강도, 검토한 커밋 SHA, 실제로 실행한 명령 목록
```

## 6. FIX2-D39 — `561bc5f`

```text
당신은 GitHub 저장소 `john-tho1/my-first-project` 안의 Content Studio 앱(`Content_Studio_Execution_Pack/`)을 검토하는 독립 코드 리뷰어다. 구현자는 다른 에이전트(Claude Code)이며, 당신의 역할은 동의가 아니라 검증이다.

대상: 브랜치 `content-studio/m4` 의 커밋 `561bc5f9e6c73ca9164913b0e1ab86e786207a68`(짧은 SHA `561bc5f`, 작업명 `FIX2-D39`) 1개.

먼저 읽을 것:
1. `Content_Studio_Execution_Pack/AGENTS.md` — 프로젝트 규칙과 불변 조건(Invariants). 위반 여부를 반드시 확인하라.
2. 인계 문서: `docs/handoffs/LIVEP2_IMPLEMENTATION_HANDOFF.md` , `docs/handoffs/EXPIRY1_IMPLEMENTATION_HANDOFF.md` , `docs/handoffs/LIVEL1H2_IMPLEMENTATION_HANDOFF.md`
   — 이 커밋을 HEAD_SHA 로 적은 절을 중심으로 읽고, 그 절의 "검토자에게 물을 것"(또는 Questions)에 답하라.
3. 변경분: `git show 561bc5f -- Content_Studio_Execution_Pack ':(exclude,glob)**/pnpm-lock.yaml' ':(exclude,glob)**/drizzle/meta/*_snapshot.json'`
   (커밋을 찾지 못하면 `git fetch origin content-studio/m4` 뒤 다시 시도.)

규칙:
- 파일을 수정하지 마라. 커밋·브랜치·PR 을 만들지 말고, 변경 제안(diff)도 만들지 마라 — 리포트만 출력한다.
- 읽기·grep·git log/show/diff 는 써도 된다. 테스트를 실행했다면 실제 명령과 결과를 그대로 적고, 실행하지 않았으면 실행했다고 주장하지 마라.
- 외부 서비스 호출·실계정·비밀값은 쓰지 마라.
- 이 커밋 뒤의 같은 브랜치 커밋이 이미 고친 문제는 `git log` 로 확인해 "이후 커밋 <SHA> 에서 해결됨"이라고 표시하라.
- 추측을 사실처럼 쓰지 마라. 확인하지 못한 것은 '미확인'으로 표시하라.
- 취향 문제(포매팅, 네이밍 선호)는 적지 마라. 동작·정확성·규칙 위반만 적어라.

다음 형식의 마크다운 리포트만 출력하라. 서론·칭찬·요약 인사말은 쓰지 마라.

## 판정
PASS 또는 CHANGES_REQUESTED 중 하나.

## 지적 사항
각 항목을 아래 형식으로. 없으면 '없음'이라고만 쓴다.
- [P0|P1|P2] 파일:줄 — 문제 한 줄 요약
  - 재현/실패 시나리오: 어떤 입력·상태에서 어떻게 잘못되는가
  - 제안: 구체적인 수정 방향
(P0 = 불변 조건 위반·데이터 손상·보안, P1 = 기능 오류·명세 불일치, P2 = 경계값·품질)

## Codex 질문에 대한 답
인계 문서의 질문 각 항목에 번호를 붙여 답하라. 질문이 없으면 '해당 없음'.

## 놓친 케이스
테스트나 수동 확인에서 빠졌을 가능성이 높은 입력·경계값 목록.

## 실행 정보
- 화면에 보이는 모델·추론 강도, 검토한 커밋 SHA, 실제로 실행한 명령 목록
```

## 7. FIX3-D39 — `e7c73c9`

```text
당신은 GitHub 저장소 `john-tho1/my-first-project` 안의 Content Studio 앱(`Content_Studio_Execution_Pack/`)을 검토하는 독립 코드 리뷰어다. 구현자는 다른 에이전트(Claude Code)이며, 당신의 역할은 동의가 아니라 검증이다.

대상: 브랜치 `content-studio/m4` 의 커밋 `e7c73c9c13d03ea4a268179291c2d97e8bda4a59`(짧은 SHA `e7c73c9`, 작업명 `FIX3-D39`) 1개.

먼저 읽을 것:
1. `Content_Studio_Execution_Pack/AGENTS.md` — 프로젝트 규칙과 불변 조건(Invariants). 위반 여부를 반드시 확인하라.
2. 인계 문서: `docs/handoffs/EXPIRY1_IMPLEMENTATION_HANDOFF.md` , `docs/handoffs/LIVEL1H2_IMPLEMENTATION_HANDOFF.md`
   — 이 커밋을 HEAD_SHA 로 적은 절을 중심으로 읽고, 그 절의 "검토자에게 물을 것"(또는 Questions)에 답하라.
3. 변경분: `git show e7c73c9 -- Content_Studio_Execution_Pack ':(exclude,glob)**/pnpm-lock.yaml' ':(exclude,glob)**/drizzle/meta/*_snapshot.json'`
   (커밋을 찾지 못하면 `git fetch origin content-studio/m4` 뒤 다시 시도.)

규칙:
- 파일을 수정하지 마라. 커밋·브랜치·PR 을 만들지 말고, 변경 제안(diff)도 만들지 마라 — 리포트만 출력한다.
- 읽기·grep·git log/show/diff 는 써도 된다. 테스트를 실행했다면 실제 명령과 결과를 그대로 적고, 실행하지 않았으면 실행했다고 주장하지 마라.
- 외부 서비스 호출·실계정·비밀값은 쓰지 마라.
- 이 커밋 뒤의 같은 브랜치 커밋이 이미 고친 문제는 `git log` 로 확인해 "이후 커밋 <SHA> 에서 해결됨"이라고 표시하라.
- 추측을 사실처럼 쓰지 마라. 확인하지 못한 것은 '미확인'으로 표시하라.
- 취향 문제(포매팅, 네이밍 선호)는 적지 마라. 동작·정확성·규칙 위반만 적어라.

다음 형식의 마크다운 리포트만 출력하라. 서론·칭찬·요약 인사말은 쓰지 마라.

## 판정
PASS 또는 CHANGES_REQUESTED 중 하나.

## 지적 사항
각 항목을 아래 형식으로. 없으면 '없음'이라고만 쓴다.
- [P0|P1|P2] 파일:줄 — 문제 한 줄 요약
  - 재현/실패 시나리오: 어떤 입력·상태에서 어떻게 잘못되는가
  - 제안: 구체적인 수정 방향
(P0 = 불변 조건 위반·데이터 손상·보안, P1 = 기능 오류·명세 불일치, P2 = 경계값·품질)

## Codex 질문에 대한 답
인계 문서의 질문 각 항목에 번호를 붙여 답하라. 질문이 없으면 '해당 없음'.

## 놓친 케이스
테스트나 수동 확인에서 빠졌을 가능성이 높은 입력·경계값 목록.

## 실행 정보
- 화면에 보이는 모델·추론 강도, 검토한 커밋 SHA, 실제로 실행한 명령 목록
```

## 8. FIX4-D39 — `fb1fa58`

```text
당신은 GitHub 저장소 `john-tho1/my-first-project` 안의 Content Studio 앱(`Content_Studio_Execution_Pack/`)을 검토하는 독립 코드 리뷰어다. 구현자는 다른 에이전트(Claude Code)이며, 당신의 역할은 동의가 아니라 검증이다.

대상: 브랜치 `content-studio/m4` 의 커밋 `fb1fa58a1d6a196a230701a9341fba4d95181154`(짧은 SHA `fb1fa58`, 작업명 `FIX4-D39`) 1개.

먼저 읽을 것:
1. `Content_Studio_Execution_Pack/AGENTS.md` — 프로젝트 규칙과 불변 조건(Invariants). 위반 여부를 반드시 확인하라.
2. 인계 문서: `docs/handoffs/LIVEL1H2_IMPLEMENTATION_HANDOFF.md`
   — 이 커밋을 HEAD_SHA 로 적은 절을 중심으로 읽고, 그 절의 "검토자에게 물을 것"(또는 Questions)에 답하라.
3. 변경분: `git show fb1fa58 -- Content_Studio_Execution_Pack ':(exclude,glob)**/pnpm-lock.yaml' ':(exclude,glob)**/drizzle/meta/*_snapshot.json'`
   (커밋을 찾지 못하면 `git fetch origin content-studio/m4` 뒤 다시 시도.)

규칙:
- 파일을 수정하지 마라. 커밋·브랜치·PR 을 만들지 말고, 변경 제안(diff)도 만들지 마라 — 리포트만 출력한다.
- 읽기·grep·git log/show/diff 는 써도 된다. 테스트를 실행했다면 실제 명령과 결과를 그대로 적고, 실행하지 않았으면 실행했다고 주장하지 마라.
- 외부 서비스 호출·실계정·비밀값은 쓰지 마라.
- 이 커밋 뒤의 같은 브랜치 커밋이 이미 고친 문제는 `git log` 로 확인해 "이후 커밋 <SHA> 에서 해결됨"이라고 표시하라.
- 추측을 사실처럼 쓰지 마라. 확인하지 못한 것은 '미확인'으로 표시하라.
- 취향 문제(포매팅, 네이밍 선호)는 적지 마라. 동작·정확성·규칙 위반만 적어라.

다음 형식의 마크다운 리포트만 출력하라. 서론·칭찬·요약 인사말은 쓰지 마라.

## 판정
PASS 또는 CHANGES_REQUESTED 중 하나.

## 지적 사항
각 항목을 아래 형식으로. 없으면 '없음'이라고만 쓴다.
- [P0|P1|P2] 파일:줄 — 문제 한 줄 요약
  - 재현/실패 시나리오: 어떤 입력·상태에서 어떻게 잘못되는가
  - 제안: 구체적인 수정 방향
(P0 = 불변 조건 위반·데이터 손상·보안, P1 = 기능 오류·명세 불일치, P2 = 경계값·품질)

## Codex 질문에 대한 답
인계 문서의 질문 각 항목에 번호를 붙여 답하라. 질문이 없으면 '해당 없음'.

## 놓친 케이스
테스트나 수동 확인에서 빠졌을 가능성이 높은 입력·경계값 목록.

## 실행 정보
- 화면에 보이는 모델·추론 강도, 검토한 커밋 SHA, 실제로 실행한 명령 목록
```

## 9. FIX5-D39 — `4769c4e`

```text
당신은 GitHub 저장소 `john-tho1/my-first-project` 안의 Content Studio 앱(`Content_Studio_Execution_Pack/`)을 검토하는 독립 코드 리뷰어다. 구현자는 다른 에이전트(Claude Code)이며, 당신의 역할은 동의가 아니라 검증이다.

대상: 브랜치 `content-studio/m4` 의 커밋 `4769c4ec8a957abf46a9c74dcb079e1750e11dcf`(짧은 SHA `4769c4e`, 작업명 `FIX5-D39`) 1개.

먼저 읽을 것:
1. `Content_Studio_Execution_Pack/AGENTS.md` — 프로젝트 규칙과 불변 조건(Invariants). 위반 여부를 반드시 확인하라.
2. 인계 문서: `docs/handoffs/LIVEL1H2_IMPLEMENTATION_HANDOFF.md`
   — 이 커밋을 HEAD_SHA 로 적은 절을 중심으로 읽고, 그 절의 "검토자에게 물을 것"(또는 Questions)에 답하라.
3. 변경분: `git show 4769c4e -- Content_Studio_Execution_Pack ':(exclude,glob)**/pnpm-lock.yaml' ':(exclude,glob)**/drizzle/meta/*_snapshot.json'`
   (커밋을 찾지 못하면 `git fetch origin content-studio/m4` 뒤 다시 시도.)

규칙:
- 파일을 수정하지 마라. 커밋·브랜치·PR 을 만들지 말고, 변경 제안(diff)도 만들지 마라 — 리포트만 출력한다.
- 읽기·grep·git log/show/diff 는 써도 된다. 테스트를 실행했다면 실제 명령과 결과를 그대로 적고, 실행하지 않았으면 실행했다고 주장하지 마라.
- 외부 서비스 호출·실계정·비밀값은 쓰지 마라.
- 이 커밋 뒤의 같은 브랜치 커밋이 이미 고친 문제는 `git log` 로 확인해 "이후 커밋 <SHA> 에서 해결됨"이라고 표시하라.
- 추측을 사실처럼 쓰지 마라. 확인하지 못한 것은 '미확인'으로 표시하라.
- 취향 문제(포매팅, 네이밍 선호)는 적지 마라. 동작·정확성·규칙 위반만 적어라.

다음 형식의 마크다운 리포트만 출력하라. 서론·칭찬·요약 인사말은 쓰지 마라.

## 판정
PASS 또는 CHANGES_REQUESTED 중 하나.

## 지적 사항
각 항목을 아래 형식으로. 없으면 '없음'이라고만 쓴다.
- [P0|P1|P2] 파일:줄 — 문제 한 줄 요약
  - 재현/실패 시나리오: 어떤 입력·상태에서 어떻게 잘못되는가
  - 제안: 구체적인 수정 방향
(P0 = 불변 조건 위반·데이터 손상·보안, P1 = 기능 오류·명세 불일치, P2 = 경계값·품질)

## Codex 질문에 대한 답
인계 문서의 질문 각 항목에 번호를 붙여 답하라. 질문이 없으면 '해당 없음'.

## 놓친 케이스
테스트나 수동 확인에서 빠졌을 가능성이 높은 입력·경계값 목록.

## 실행 정보
- 화면에 보이는 모델·추론 강도, 검토한 커밋 SHA, 실제로 실행한 명령 목록
```

## 10. FIX6-D39 — `1b6e4f4`

```text
당신은 GitHub 저장소 `john-tho1/my-first-project` 안의 Content Studio 앱(`Content_Studio_Execution_Pack/`)을 검토하는 독립 코드 리뷰어다. 구현자는 다른 에이전트(Claude Code)이며, 당신의 역할은 동의가 아니라 검증이다.

대상: 브랜치 `content-studio/m4` 의 커밋 `1b6e4f49a7ff50ee9825c7538fbb450b7f4be609`(짧은 SHA `1b6e4f4`, 작업명 `FIX6-D39`) 1개.

먼저 읽을 것:
1. `Content_Studio_Execution_Pack/AGENTS.md` — 프로젝트 규칙과 불변 조건(Invariants). 위반 여부를 반드시 확인하라.
2. 인계 문서: `docs/handoffs/LIVEL1H2_IMPLEMENTATION_HANDOFF.md`
   — 이 커밋을 HEAD_SHA 로 적은 절을 중심으로 읽고, 그 절의 "검토자에게 물을 것"(또는 Questions)에 답하라.
3. 변경분: `git show 1b6e4f4 -- Content_Studio_Execution_Pack ':(exclude,glob)**/pnpm-lock.yaml' ':(exclude,glob)**/drizzle/meta/*_snapshot.json'`
   (커밋을 찾지 못하면 `git fetch origin content-studio/m4` 뒤 다시 시도.)

규칙:
- 파일을 수정하지 마라. 커밋·브랜치·PR 을 만들지 말고, 변경 제안(diff)도 만들지 마라 — 리포트만 출력한다.
- 읽기·grep·git log/show/diff 는 써도 된다. 테스트를 실행했다면 실제 명령과 결과를 그대로 적고, 실행하지 않았으면 실행했다고 주장하지 마라.
- 외부 서비스 호출·실계정·비밀값은 쓰지 마라.
- 이 커밋 뒤의 같은 브랜치 커밋이 이미 고친 문제는 `git log` 로 확인해 "이후 커밋 <SHA> 에서 해결됨"이라고 표시하라.
- 추측을 사실처럼 쓰지 마라. 확인하지 못한 것은 '미확인'으로 표시하라.
- 취향 문제(포매팅, 네이밍 선호)는 적지 마라. 동작·정확성·규칙 위반만 적어라.

다음 형식의 마크다운 리포트만 출력하라. 서론·칭찬·요약 인사말은 쓰지 마라.

## 판정
PASS 또는 CHANGES_REQUESTED 중 하나.

## 지적 사항
각 항목을 아래 형식으로. 없으면 '없음'이라고만 쓴다.
- [P0|P1|P2] 파일:줄 — 문제 한 줄 요약
  - 재현/실패 시나리오: 어떤 입력·상태에서 어떻게 잘못되는가
  - 제안: 구체적인 수정 방향
(P0 = 불변 조건 위반·데이터 손상·보안, P1 = 기능 오류·명세 불일치, P2 = 경계값·품질)

## Codex 질문에 대한 답
인계 문서의 질문 각 항목에 번호를 붙여 답하라. 질문이 없으면 '해당 없음'.

## 놓친 케이스
테스트나 수동 확인에서 빠졌을 가능성이 높은 입력·경계값 목록.

## 실행 정보
- 화면에 보이는 모델·추론 강도, 검토한 커밋 SHA, 실제로 실행한 명령 목록
```

## 11. FIX1-FULLREV — `af1d0b5`

```text
당신은 GitHub 저장소 `john-tho1/my-first-project` 안의 Content Studio 앱(`Content_Studio_Execution_Pack/`)을 검토하는 독립 코드 리뷰어다. 구현자는 다른 에이전트(Claude Code)이며, 당신의 역할은 동의가 아니라 검증이다.

대상: 브랜치 `content-studio/m4` 의 커밋 `af1d0b56cbf8c5ce475517c62d8581d87af6349b`(짧은 SHA `af1d0b5`, 작업명 `FIX1-FULLREV`) 1개.

먼저 읽을 것:
1. `Content_Studio_Execution_Pack/AGENTS.md` — 프로젝트 규칙과 불변 조건(Invariants). 위반 여부를 반드시 확인하라.
2. 인계 문서: `docs/handoffs/FULLREV1_IMPLEMENTATION_HANDOFF.md`
   — 이 커밋을 HEAD_SHA 로 적은 절을 중심으로 읽고, 그 절의 "검토자에게 물을 것"(또는 Questions)에 답하라.
3. 변경분: `git show af1d0b5 -- Content_Studio_Execution_Pack ':(exclude,glob)**/pnpm-lock.yaml' ':(exclude,glob)**/drizzle/meta/*_snapshot.json'`
   (커밋을 찾지 못하면 `git fetch origin content-studio/m4` 뒤 다시 시도.)

규칙:
- 파일을 수정하지 마라. 커밋·브랜치·PR 을 만들지 말고, 변경 제안(diff)도 만들지 마라 — 리포트만 출력한다.
- 읽기·grep·git log/show/diff 는 써도 된다. 테스트를 실행했다면 실제 명령과 결과를 그대로 적고, 실행하지 않았으면 실행했다고 주장하지 마라.
- 외부 서비스 호출·실계정·비밀값은 쓰지 마라.
- 이 커밋 뒤의 같은 브랜치 커밋이 이미 고친 문제는 `git log` 로 확인해 "이후 커밋 <SHA> 에서 해결됨"이라고 표시하라.
- 추측을 사실처럼 쓰지 마라. 확인하지 못한 것은 '미확인'으로 표시하라.
- 취향 문제(포매팅, 네이밍 선호)는 적지 마라. 동작·정확성·규칙 위반만 적어라.

다음 형식의 마크다운 리포트만 출력하라. 서론·칭찬·요약 인사말은 쓰지 마라.

## 판정
PASS 또는 CHANGES_REQUESTED 중 하나.

## 지적 사항
각 항목을 아래 형식으로. 없으면 '없음'이라고만 쓴다.
- [P0|P1|P2] 파일:줄 — 문제 한 줄 요약
  - 재현/실패 시나리오: 어떤 입력·상태에서 어떻게 잘못되는가
  - 제안: 구체적인 수정 방향
(P0 = 불변 조건 위반·데이터 손상·보안, P1 = 기능 오류·명세 불일치, P2 = 경계값·품질)

## Codex 질문에 대한 답
인계 문서의 질문 각 항목에 번호를 붙여 답하라. 질문이 없으면 '해당 없음'.

## 놓친 케이스
테스트나 수동 확인에서 빠졌을 가능성이 높은 입력·경계값 목록.

## 실행 정보
- 화면에 보이는 모델·추론 강도, 검토한 커밋 SHA, 실제로 실행한 명령 목록
```

## 12. FIX2-FULLREV — `13f29b3`

```text
당신은 GitHub 저장소 `john-tho1/my-first-project` 안의 Content Studio 앱(`Content_Studio_Execution_Pack/`)을 검토하는 독립 코드 리뷰어다. 구현자는 다른 에이전트(Claude Code)이며, 당신의 역할은 동의가 아니라 검증이다.

대상: 브랜치 `content-studio/m4` 의 커밋 `13f29b34b192f40065a2b9753a85d102b28e75de`(짧은 SHA `13f29b3`, 작업명 `FIX2-FULLREV`) 1개.

먼저 읽을 것:
1. `Content_Studio_Execution_Pack/AGENTS.md` — 프로젝트 규칙과 불변 조건(Invariants). 위반 여부를 반드시 확인하라.
2. 인계 문서: `docs/handoffs/FULLREV1_IMPLEMENTATION_HANDOFF.md`
   — 이 커밋을 HEAD_SHA 로 적은 절을 중심으로 읽고, 그 절의 "검토자에게 물을 것"(또는 Questions)에 답하라.
3. 변경분: `git show 13f29b3 -- Content_Studio_Execution_Pack ':(exclude,glob)**/pnpm-lock.yaml' ':(exclude,glob)**/drizzle/meta/*_snapshot.json'`
   (커밋을 찾지 못하면 `git fetch origin content-studio/m4` 뒤 다시 시도.)

규칙:
- 파일을 수정하지 마라. 커밋·브랜치·PR 을 만들지 말고, 변경 제안(diff)도 만들지 마라 — 리포트만 출력한다.
- 읽기·grep·git log/show/diff 는 써도 된다. 테스트를 실행했다면 실제 명령과 결과를 그대로 적고, 실행하지 않았으면 실행했다고 주장하지 마라.
- 외부 서비스 호출·실계정·비밀값은 쓰지 마라.
- 이 커밋 뒤의 같은 브랜치 커밋이 이미 고친 문제는 `git log` 로 확인해 "이후 커밋 <SHA> 에서 해결됨"이라고 표시하라.
- 추측을 사실처럼 쓰지 마라. 확인하지 못한 것은 '미확인'으로 표시하라.
- 취향 문제(포매팅, 네이밍 선호)는 적지 마라. 동작·정확성·규칙 위반만 적어라.

다음 형식의 마크다운 리포트만 출력하라. 서론·칭찬·요약 인사말은 쓰지 마라.

## 판정
PASS 또는 CHANGES_REQUESTED 중 하나.

## 지적 사항
각 항목을 아래 형식으로. 없으면 '없음'이라고만 쓴다.
- [P0|P1|P2] 파일:줄 — 문제 한 줄 요약
  - 재현/실패 시나리오: 어떤 입력·상태에서 어떻게 잘못되는가
  - 제안: 구체적인 수정 방향
(P0 = 불변 조건 위반·데이터 손상·보안, P1 = 기능 오류·명세 불일치, P2 = 경계값·품질)

## Codex 질문에 대한 답
인계 문서의 질문 각 항목에 번호를 붙여 답하라. 질문이 없으면 '해당 없음'.

## 놓친 케이스
테스트나 수동 확인에서 빠졌을 가능성이 높은 입력·경계값 목록.

## 실행 정보
- 화면에 보이는 모델·추론 강도, 검토한 커밋 SHA, 실제로 실행한 명령 목록
```

## 13. FIX3-FULLREV — `a9873af`

```text
당신은 GitHub 저장소 `john-tho1/my-first-project` 안의 Content Studio 앱(`Content_Studio_Execution_Pack/`)을 검토하는 독립 코드 리뷰어다. 구현자는 다른 에이전트(Claude Code)이며, 당신의 역할은 동의가 아니라 검증이다.

대상: 브랜치 `content-studio/m4` 의 커밋 `a9873afdf10ee09d44fae30a7addd948125f3291`(짧은 SHA `a9873af`, 작업명 `FIX3-FULLREV`) 1개.

먼저 읽을 것:
1. `Content_Studio_Execution_Pack/AGENTS.md` — 프로젝트 규칙과 불변 조건(Invariants). 위반 여부를 반드시 확인하라.
2. 인계 문서: `docs/handoffs/FULLREV1_IMPLEMENTATION_HANDOFF.md`
   — 이 커밋을 HEAD_SHA 로 적은 절을 중심으로 읽고, 그 절의 "검토자에게 물을 것"(또는 Questions)에 답하라.
3. 변경분: `git show a9873af -- Content_Studio_Execution_Pack ':(exclude,glob)**/pnpm-lock.yaml' ':(exclude,glob)**/drizzle/meta/*_snapshot.json'`
   (커밋을 찾지 못하면 `git fetch origin content-studio/m4` 뒤 다시 시도.)

규칙:
- 파일을 수정하지 마라. 커밋·브랜치·PR 을 만들지 말고, 변경 제안(diff)도 만들지 마라 — 리포트만 출력한다.
- 읽기·grep·git log/show/diff 는 써도 된다. 테스트를 실행했다면 실제 명령과 결과를 그대로 적고, 실행하지 않았으면 실행했다고 주장하지 마라.
- 외부 서비스 호출·실계정·비밀값은 쓰지 마라.
- 이 커밋 뒤의 같은 브랜치 커밋이 이미 고친 문제는 `git log` 로 확인해 "이후 커밋 <SHA> 에서 해결됨"이라고 표시하라.
- 추측을 사실처럼 쓰지 마라. 확인하지 못한 것은 '미확인'으로 표시하라.
- 취향 문제(포매팅, 네이밍 선호)는 적지 마라. 동작·정확성·규칙 위반만 적어라.

다음 형식의 마크다운 리포트만 출력하라. 서론·칭찬·요약 인사말은 쓰지 마라.

## 판정
PASS 또는 CHANGES_REQUESTED 중 하나.

## 지적 사항
각 항목을 아래 형식으로. 없으면 '없음'이라고만 쓴다.
- [P0|P1|P2] 파일:줄 — 문제 한 줄 요약
  - 재현/실패 시나리오: 어떤 입력·상태에서 어떻게 잘못되는가
  - 제안: 구체적인 수정 방향
(P0 = 불변 조건 위반·데이터 손상·보안, P1 = 기능 오류·명세 불일치, P2 = 경계값·품질)

## Codex 질문에 대한 답
인계 문서의 질문 각 항목에 번호를 붙여 답하라. 질문이 없으면 '해당 없음'.

## 놓친 케이스
테스트나 수동 확인에서 빠졌을 가능성이 높은 입력·경계값 목록.

## 실행 정보
- 화면에 보이는 모델·추론 강도, 검토한 커밋 SHA, 실제로 실행한 명령 목록
```

## 14. FIX4-FULLREV — `fc74b3a`

```text
당신은 GitHub 저장소 `john-tho1/my-first-project` 안의 Content Studio 앱(`Content_Studio_Execution_Pack/`)을 검토하는 독립 코드 리뷰어다. 구현자는 다른 에이전트(Claude Code)이며, 당신의 역할은 동의가 아니라 검증이다.

대상: 브랜치 `content-studio/m4` 의 커밋 `fc74b3aae5795b63c1385b84b9460757c4c249cb`(짧은 SHA `fc74b3a`, 작업명 `FIX4-FULLREV`) 1개.

먼저 읽을 것:
1. `Content_Studio_Execution_Pack/AGENTS.md` — 프로젝트 규칙과 불변 조건(Invariants). 위반 여부를 반드시 확인하라.
2. 인계 문서: `docs/handoffs/FULLREV1_IMPLEMENTATION_HANDOFF.md`
   — 이 커밋을 HEAD_SHA 로 적은 절을 중심으로 읽고, 그 절의 "검토자에게 물을 것"(또는 Questions)에 답하라.
3. 변경분: `git show fc74b3a -- Content_Studio_Execution_Pack ':(exclude,glob)**/pnpm-lock.yaml' ':(exclude,glob)**/drizzle/meta/*_snapshot.json'`
   (커밋을 찾지 못하면 `git fetch origin content-studio/m4` 뒤 다시 시도.)

규칙:
- 파일을 수정하지 마라. 커밋·브랜치·PR 을 만들지 말고, 변경 제안(diff)도 만들지 마라 — 리포트만 출력한다.
- 읽기·grep·git log/show/diff 는 써도 된다. 테스트를 실행했다면 실제 명령과 결과를 그대로 적고, 실행하지 않았으면 실행했다고 주장하지 마라.
- 외부 서비스 호출·실계정·비밀값은 쓰지 마라.
- 이 커밋 뒤의 같은 브랜치 커밋이 이미 고친 문제는 `git log` 로 확인해 "이후 커밋 <SHA> 에서 해결됨"이라고 표시하라.
- 추측을 사실처럼 쓰지 마라. 확인하지 못한 것은 '미확인'으로 표시하라.
- 취향 문제(포매팅, 네이밍 선호)는 적지 마라. 동작·정확성·규칙 위반만 적어라.

다음 형식의 마크다운 리포트만 출력하라. 서론·칭찬·요약 인사말은 쓰지 마라.

## 판정
PASS 또는 CHANGES_REQUESTED 중 하나.

## 지적 사항
각 항목을 아래 형식으로. 없으면 '없음'이라고만 쓴다.
- [P0|P1|P2] 파일:줄 — 문제 한 줄 요약
  - 재현/실패 시나리오: 어떤 입력·상태에서 어떻게 잘못되는가
  - 제안: 구체적인 수정 방향
(P0 = 불변 조건 위반·데이터 손상·보안, P1 = 기능 오류·명세 불일치, P2 = 경계값·품질)

## Codex 질문에 대한 답
인계 문서의 질문 각 항목에 번호를 붙여 답하라. 질문이 없으면 '해당 없음'.

## 놓친 케이스
테스트나 수동 확인에서 빠졌을 가능성이 높은 입력·경계값 목록.

## 실행 정보
- 화면에 보이는 모델·추론 강도, 검토한 커밋 SHA, 실제로 실행한 명령 목록
```

## 15. FIX5-FULLREV — `39aa665`

```text
당신은 GitHub 저장소 `john-tho1/my-first-project` 안의 Content Studio 앱(`Content_Studio_Execution_Pack/`)을 검토하는 독립 코드 리뷰어다. 구현자는 다른 에이전트(Claude Code)이며, 당신의 역할은 동의가 아니라 검증이다.

대상: 브랜치 `content-studio/m4` 의 커밋 `39aa665d5f8e708a20fb926801e8e789f1bb8a25`(짧은 SHA `39aa665`, 작업명 `FIX5-FULLREV`) 1개.

먼저 읽을 것:
1. `Content_Studio_Execution_Pack/AGENTS.md` — 프로젝트 규칙과 불변 조건(Invariants). 위반 여부를 반드시 확인하라.
2. 인계 문서: `docs/handoffs/FULLREV1_IMPLEMENTATION_HANDOFF.md`
   — 이 커밋을 HEAD_SHA 로 적은 절을 중심으로 읽고, 그 절의 "검토자에게 물을 것"(또는 Questions)에 답하라.
3. 변경분: `git show 39aa665 -- Content_Studio_Execution_Pack ':(exclude,glob)**/pnpm-lock.yaml' ':(exclude,glob)**/drizzle/meta/*_snapshot.json'`
   (커밋을 찾지 못하면 `git fetch origin content-studio/m4` 뒤 다시 시도.)

규칙:
- 파일을 수정하지 마라. 커밋·브랜치·PR 을 만들지 말고, 변경 제안(diff)도 만들지 마라 — 리포트만 출력한다.
- 읽기·grep·git log/show/diff 는 써도 된다. 테스트를 실행했다면 실제 명령과 결과를 그대로 적고, 실행하지 않았으면 실행했다고 주장하지 마라.
- 외부 서비스 호출·실계정·비밀값은 쓰지 마라.
- 이 커밋 뒤의 같은 브랜치 커밋이 이미 고친 문제는 `git log` 로 확인해 "이후 커밋 <SHA> 에서 해결됨"이라고 표시하라.
- 추측을 사실처럼 쓰지 마라. 확인하지 못한 것은 '미확인'으로 표시하라.
- 취향 문제(포매팅, 네이밍 선호)는 적지 마라. 동작·정확성·규칙 위반만 적어라.

다음 형식의 마크다운 리포트만 출력하라. 서론·칭찬·요약 인사말은 쓰지 마라.

## 판정
PASS 또는 CHANGES_REQUESTED 중 하나.

## 지적 사항
각 항목을 아래 형식으로. 없으면 '없음'이라고만 쓴다.
- [P0|P1|P2] 파일:줄 — 문제 한 줄 요약
  - 재현/실패 시나리오: 어떤 입력·상태에서 어떻게 잘못되는가
  - 제안: 구체적인 수정 방향
(P0 = 불변 조건 위반·데이터 손상·보안, P1 = 기능 오류·명세 불일치, P2 = 경계값·품질)

## Codex 질문에 대한 답
인계 문서의 질문 각 항목에 번호를 붙여 답하라. 질문이 없으면 '해당 없음'.

## 놓친 케이스
테스트나 수동 확인에서 빠졌을 가능성이 높은 입력·경계값 목록.

## 실행 정보
- 화면에 보이는 모델·추론 강도, 검토한 커밋 SHA, 실제로 실행한 명령 목록
```

## 16. FIX1-CODEX — `d88c31a`

```text
당신은 GitHub 저장소 `john-tho1/my-first-project` 안의 Content Studio 앱(`Content_Studio_Execution_Pack/`)을 검토하는 독립 코드 리뷰어다. 구현자는 다른 에이전트(Claude Code)이며, 당신의 역할은 동의가 아니라 검증이다.

대상: 브랜치 `content-studio/m4` 의 커밋 `d88c31a2ffd3f570b4c4f51c6df0bb35d100ae79`(짧은 SHA `d88c31a`, 작업명 `FIX1-CODEX`) 1개.

먼저 읽을 것:
1. `Content_Studio_Execution_Pack/AGENTS.md` — 프로젝트 규칙과 불변 조건(Invariants). 위반 여부를 반드시 확인하라.
2. 인계 문서: `docs/handoffs/EXPIRY1_IMPLEMENTATION_HANDOFF.md`
   — 이 커밋을 HEAD_SHA 로 적은 절을 중심으로 읽고, 그 절의 "검토자에게 물을 것"(또는 Questions)에 답하라.
3. 변경분: `git show d88c31a -- Content_Studio_Execution_Pack ':(exclude,glob)**/pnpm-lock.yaml' ':(exclude,glob)**/drizzle/meta/*_snapshot.json'`
   (커밋을 찾지 못하면 `git fetch origin content-studio/m4` 뒤 다시 시도.)

규칙:
- 파일을 수정하지 마라. 커밋·브랜치·PR 을 만들지 말고, 변경 제안(diff)도 만들지 마라 — 리포트만 출력한다.
- 읽기·grep·git log/show/diff 는 써도 된다. 테스트를 실행했다면 실제 명령과 결과를 그대로 적고, 실행하지 않았으면 실행했다고 주장하지 마라.
- 외부 서비스 호출·실계정·비밀값은 쓰지 마라.
- 이 커밋 뒤의 같은 브랜치 커밋이 이미 고친 문제는 `git log` 로 확인해 "이후 커밋 <SHA> 에서 해결됨"이라고 표시하라.
- 추측을 사실처럼 쓰지 마라. 확인하지 못한 것은 '미확인'으로 표시하라.
- 취향 문제(포매팅, 네이밍 선호)는 적지 마라. 동작·정확성·규칙 위반만 적어라.

다음 형식의 마크다운 리포트만 출력하라. 서론·칭찬·요약 인사말은 쓰지 마라.

## 판정
PASS 또는 CHANGES_REQUESTED 중 하나.

## 지적 사항
각 항목을 아래 형식으로. 없으면 '없음'이라고만 쓴다.
- [P0|P1|P2] 파일:줄 — 문제 한 줄 요약
  - 재현/실패 시나리오: 어떤 입력·상태에서 어떻게 잘못되는가
  - 제안: 구체적인 수정 방향
(P0 = 불변 조건 위반·데이터 손상·보안, P1 = 기능 오류·명세 불일치, P2 = 경계값·품질)

## Codex 질문에 대한 답
인계 문서의 질문 각 항목에 번호를 붙여 답하라. 질문이 없으면 '해당 없음'.

## 놓친 케이스
테스트나 수동 확인에서 빠졌을 가능성이 높은 입력·경계값 목록.

## 실행 정보
- 화면에 보이는 모델·추론 강도, 검토한 커밋 SHA, 실제로 실행한 명령 목록
```
