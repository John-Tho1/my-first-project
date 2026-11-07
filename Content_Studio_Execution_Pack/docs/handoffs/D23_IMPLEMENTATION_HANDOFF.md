# D23(e) Implementation Handoff — 공개 /api/health 에서 운영 숫자 제거, 로그인 뒤 GET /api/ops/summary
- Task: 사용자 결정 D23(e) (Codex T20 Q6 채택). D23 (a)(b)(c)(d) 는 코드 변경 없음(기록만).
- BASE_SHA: e1aeffa · HEAD_SHA: f7fbae8
- Implementer: Claude Code (Opus 5.5). Verifier: Codex.

## Change
| Area | Change | Test |
|---|---|---|
| `apps/web/app/api/health/route.ts` | `ops` 블록 제거(정상·degraded 응답 모두). `jobs`·`uploads`·`db.captures` 는 이번 결정 범위 밖이라 그대로. | health 응답에 `ops` 와 숫자 키(backup_age_hours·repeated_failures·pending_deletes·disk_partial) 없음 |
| `packages/db/src/ops.ts` | `healthOps(db, config, now)`(모든 owner 합계) → `opsSummary(db, ownerId, config, now)`(owner 범위: 마지막 export·확인 필요 계획·반복 실패·삭제 대기). 폴더 바이트는 PC 폴더 전체 측정(owner 구분 없음), 60초 공유 캐시 그대로. | — |
| `apps/web/app/api/ops/summary/route.ts` (new) | `GET` — `requireOwner` 필수, `{ ops }`, `json()` 이 no-store. 읽기 전용이라 Origin 검사 없음(다른 GET API 와 같음). | 세션 없음·잘못된 토큰 → 401 + 숫자 키 미노출; 새 owner → 0·null(다른 owner 미집계); A 의 attention_plans = opsSnapshot total; 키 집합 고정; 경로·UUID 미노출; 51개 계획 owner 정확히 51 |
| Docs | README_KO 운영 숫자 줄, DECISIONS D23 | — |

## Commands (Windows 10, Git Bash, Node 24.21.0, dev server down)
- lint pass · typecheck pass · build pass (`/api/ops/summary` listed) · unit 33 files / 589 · integration 25 files / 415 (was 412) · drill:mock 불변식 위반 0.

## Questions for Codex
1. 공개 health 에 남은 `jobs`(상태별 수·attention_plans)·`uploads`·`db.captures` 도 같은 이유로 세션 뒤로 옮겨야 하는가? (D23 에 사용자 결정 대상으로 기록함)
2. 폴더 바이트를 owner 범위 응답에 포함하는 것(다른 owner 의 파일 양이 섞임)은 단일 owner 배포 전제에서 허용 가능한가?
