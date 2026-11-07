# .ai/handoff — 검토·위임 산출물 영역

Claude Code 주 세션과 Claude 서브에이전트(독립 검토자·위임 작업)가 결과물을 남기는 디렉터리다. (2026-11-07부터 Codex 는 쓰지 않는다.)

| 파일 | 생성 주체 | 내용 |
|---|---|---|
| `review-<timestamp>.md` | `/claude-review` | Claude 독립 검토자의 코드 리뷰 리포트 |
| `task-<timestamp>.md`   | `/claude-task`   | Claude 서브에이전트가 수행한 서브 작업 보고 |

규칙
- 이 디렉터리의 산출물은 **커밋하지 않는다**(`.gitignore` 처리됨).
- 리포트 전문을 대화 본문에 붙여넣지 않는다. 경로로 참조하고 필요한 줄만 발췌한다.
  대화에 붙여넣는 순간 그 토큰이 이후 모든 턴에 누적된다.
- 오래된 파일은 주기적으로 지운다: `rm -f .ai/handoff/review-* .ai/handoff/task-*`
