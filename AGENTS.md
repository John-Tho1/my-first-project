# AGENTS.md — 공용 에이전트 컨텍스트 (SSOT)

> 이 파일은 **Claude Code와 Codex CLI가 공유하는 단일 컨텍스트 원본**이다.
> Codex는 `AGENTS.md`를, Claude Code는 `CLAUDE.md`를 읽는다.
> `CLAUDE.md`는 이 파일을 `@AGENTS.md`로 import만 하므로, **프로젝트 규칙은 항상 여기에만 쓴다.**
> 같은 내용을 두 파일에 중복 기재하면 두 모델 모두에서 토큰이 이중으로 소모된다.

## 1. 프로젝트 개요

- 이름: my-first-project
- 내용: 단일 HTML 견적 계산기(`quote-calculator.html`) — USD/RUB 환율 기반 견적 산출
- 스택: 의존성 없는 순수 HTML + CSS + 바닐라 JS (빌드 도구·패키지 매니저 없음)
- 배포: 파일을 브라우저에서 직접 열면 동작해야 한다
- **범위 예외**: `Content_Studio_Execution_Pack/` 하위는 별개 프로젝트(Content Studio)이며 그 폴더의 자체 `AGENTS.md`/`CLAUDE.md`를 따른다. 아래 규칙(의존성 금지·검증 방법 등)은 그 폴더에 적용하지 않는다.

## 2. 코딩 규칙

- 외부 라이브러리·CDN·빌드 스텝을 추가하지 않는다. 단일 파일로 동작하는 구조를 유지한다.
  - **예외 (승인됨)**: `expense-converter.html`의 영수증 사진 인식에 한해 Tesseract.js를 jsDelivr에서 **버전 고정 + SRI**로 쓴다.
    사진을 첨부할 때만 지연 로드하며, 이 기능을 뺀 계산은 오프라인·`file://`에서 그대로 동작해야 한다. 다른 파일·기능으로 확대하지 않는다.
- UI 문자열은 한국어, 코드 식별자는 영어.
- 기존 CSS 변수(`:root`의 `--bg`, `--card`, `--accent` 등)를 재사용한다. 새 색상 하드코딩 금지.
- 통화 계산은 부동소수점 누적 오차에 주의하고, 표시 단계에서만 반올림한다.
- 커밋 메시지는 한 줄 요약 + 필요 시 본문. 영어/한국어 무관하되 한 커밋 안에서 일관되게.

## 3. 검증 방법

이 저장소에는 테스트 러너가 없다. 변경 후 최소한 다음을 확인한다.

```bash
# 1) 구문 오류 확인 (node가 있으면)
node --check <(sed -n '/<script>/,/<\/script>/p' quote-calculator.html | sed '1d;$d') 2>/dev/null || true

# 2) 브라우저에서 열어 계산 결과 수동 확인
#    - 환율 입력 → 견적 합계가 즉시 갱신되는지
#    - 0·음수·빈 값 입력 시 NaN이 노출되지 않는지
```

## 4. 역할 분담 (Claude Code ↔ Codex)

| 역할 | 담당 | 근거 |
|---|---|---|
| 설계·구현·리팩터링(주작업) | **Claude Code** | 멀티파일 편집·계획 수립 |
| 코드 리뷰·회귀 검증·반대 의견 | **Codex CLI** (`scripts/codex-review.sh`) | 독립된 컨텍스트에서 교차 검증 |
| 격리된 서브 태스크 | **Codex CLI** (`scripts/codex-task.sh`) | 주 세션 컨텍스트를 오염시키지 않음 |

**핸드오프 규칙**
- 두 에이전트 간 결과물은 반드시 `.ai/handoff/` 디렉터리의 파일로 주고받는다. 대화 본문에 리포트 전문을 붙여넣지 않는다.
- 리뷰어(Codex)는 **read-only 샌드박스**로 실행한다. 리뷰어가 코드를 직접 고치지 않는다.
- Codex의 지적은 그대로 수용하지 않고, Claude Code가 근거를 확인한 뒤 반영 여부를 판단한다.

## 5. 금지 사항

- `.ai/handoff/` 산출물을 커밋하지 않는다(`.gitignore` 처리됨).
- 인증 토큰·API 키를 이 파일이나 `.codex/config.toml`에 직접 쓰지 않는다. 환경변수를 참조한다.
- `--sandbox danger-full-access` / `--yolo` 류 옵션은 이 저장소에서 사용하지 않는다.
