# CLAUDE.md

프로젝트 규칙의 원본은 `AGENTS.md` 하나다. 아래로 import 한다.

@AGENTS.md

---

## Claude Code 전용 운영 규칙

### Codex 호출 시점
다음 상황에서는 스스로 판단하지 말고 Codex에 교차 검증을 요청한다.

1. 계산 로직(환율·마진·합계)을 수정했을 때
2. 한 번에 3개 이상의 함수/블록을 건드렸을 때
3. 사용자가 "검증", "리뷰", "확인해줘"라고 요청했을 때

```bash
./scripts/codex-review.sh              # 커밋 안 된 변경 전체를 리뷰
./scripts/codex-review.sh --base main  # main 대비 브랜치 전체를 리뷰
```

리뷰 결과는 `.ai/handoff/review-<timestamp>.md`에 저장된다.
**리포트 전문을 대화에 붙여넣지 말고, 지적 항목만 요약해 사용자에게 보고한다.**

### 서브 개발 위임
주 세션 컨텍스트를 아끼려면 독립적인 단위 작업은 Codex에 넘긴다.

```bash
./scripts/codex-task.sh "입력값 검증 함수에 음수·빈 문자열 처리를 추가해줘"
```

위임 후에는 반드시 `git diff`로 결과를 직접 확인한다. Codex의 변경을 검토 없이 커밋하지 않는다.

### 컨텍스트 절약
- `AGENTS.md`에 있는 내용을 대화에서 다시 설명하지 않는다.
- `quote-calculator.html` 전체를 반복해서 읽지 말고, `sed -n 'A,Bp'`로 필요한 구간만 읽는다.
- Codex 리포트는 파일 경로로 참조하고, 필요한 줄만 발췌한다.
