# .ai/handoff — 에이전트 간 핸드오프 영역

Claude Code와 Codex CLI가 결과물을 주고받는 디렉터리다.

| 파일 | 생성 주체 | 내용 |
|---|---|---|
| `review-<timestamp>.md` | `scripts/codex-review.sh` | Codex의 코드 리뷰 리포트 |
| `task-<timestamp>.md`   | `scripts/codex-task.sh`   | Codex가 수행한 서브 작업 보고 |

규칙
- 이 디렉터리의 산출물은 **커밋하지 않는다**(`.gitignore` 처리됨).
- 리포트 전문을 대화 본문에 붙여넣지 않는다. 경로로 참조하고 필요한 줄만 발췌한다.
  대화에 붙여넣는 순간 그 토큰이 이후 모든 턴에 누적된다.
- 오래된 파일은 주기적으로 지운다: `rm -f .ai/handoff/review-* .ai/handoff/task-*`
