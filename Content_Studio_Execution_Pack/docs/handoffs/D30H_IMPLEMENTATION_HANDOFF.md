# Implementation handoff — D30-3 (D23 남은 health 숫자 로그인 뒤로)
- Task ID / milestone: D30 항목 3 / M4 후속(D23(e) 의 "남은 범위") — 공개 `GET /api/health` 는 생존·준비 상태만, `jobs`·`uploads`·`db.captures` 는 로그인 뒤 `GET /api/ops/summary`(owner 범위)로.
- Purpose and changed behavior:
  - 공개 `/api/health` 응답(ok·degraded 모두)에서 `jobs`(상태별 작업 수·`attention_plans`), `uploads`(업로드 임시 영역 사용량), `db.captures`(소재 수)를 뺐다. 남은 키: `app, version, time_utc, time_msk, timezone, status, modes, llm, stt, db{driver, ok, migrated}, worker{mode, last_tick_utc}`.
  - `WORKER_MODE=inline` 의 요청당 worker tick(업로드 만료·모의 전사·배포 작업 최대 5개)은 그대로 health 에서 실행한다.
  - `GET /api/ops/summary`(로그인 필요)의 `ops` 에 `jobs{queued, leased, retry_wait, reconciling, unknown, blocked}`(owner 범위), `captures`(owner 범위), `uploads{sessions, files, bytes} | null`(그 owner 의 업로드 폴더 `<uploads>/<owner>` 만, 요청마다 측정, 읽기 실패 → null)를 추가했다. `attention_plans` 는 기존 최상위 키(owner 범위)를 그대로 쓰고 `jobs` 안에 중복하지 않았다.
- BASE_SHA: 1a4dcc0
- HEAD_SHA: e76ff43 (code only, D28; orchestrator reran lint·typecheck·build·unit 831·integration 654·drill:mock 0·real-DB drill:restore PASS) (커밋하지 않음 — 오케스트레이터가 커밋)
- Clean tracked tree confirmed: 작업 전 yes(`?? .claude/` 만).
- Relevant acceptance IDs: D23(e)·D30-3, AGENTS.md "credentials/private data never in public output"(숫자 노출 최소화), owner 격리.
- External calls performed: none. Mock-only functionality: 변경 없음.

## 변경 파일
- 코드: `apps/web/app/api/health/route.ts`, `apps/web/app/api/ops/summary/route.ts`(주석), `packages/db/src/ops.ts`(OpsSummary·opsSummary), `packages/db/src/jobs.ts`(`jobStateCounts(db, ownerId)` owner 범위로, 전역 `attentionPlanCount` 제거 — 다른 사용처 없음), `packages/db/src/uploads.ts`(`UploadStore.usage(ownerId?)`)
- 시험: `tests/integration/health.test.ts`, `tests/integration/ops-retention.test.ts`, `tests/integration/jobs.test.ts`, `tests/integration/m3-gate.test.ts`, `tests/integration/uploads-transcription.test.ts`
- 문서: `README_KO.md`(stt live 경계 줄, T11·T12 API 표의 health 행, T20 운영 숫자 절 + 공개 health 키 목록)
- `docs/DECISIONS.md`·`M4_CODEX_VERDICTS.md`·`M4_STATUS.md`·기존 handoff 는 수정하지 않음.

## 변경 → 시험
| 변경 | 시험 |
|---|---|
| health ok 응답: 생존·준비 키만 | `health.test.ts` "D30-3: ok 응답…" — 최상위 키 집합 정확히 11개, `db` 키 `driver/migrated/ok`, `worker` 키 `last_tick_utc/mode`, `"jobs" "uploads" "captures" "attention_plans" "ops" "queued" "sessions" "bytes"` 키 문자열 없음. `ops-retention.test.ts` D30-3 첫 시험도 같은 확인(다른 owner 데이터가 있는 DB) |
| health degraded(503) 응답도 같은 키만 | `health.test.ts` "D30-3: degraded…" — `vi.doMock('@cs/db')` 로 `getDb` 를 거부시켜 503·`status:'degraded'`·`db{ok:false}` 확인 + 같은 키 검사 + 오류 메시지 미노출 |
| 기존 health 기본 시험 | `db.captures: 10` 단언을 빼고 나머지 그대로(`captures` 는 summary 시험으로 옮김) |
| summary 세션 필요 | `ops-retention.test.ts` "summary: 세션 없음 401" — 401, 본문에 `jobs/uploads/captures/queued` 없음. 기존 D23(e) 401 시험(세션 없음·잘못된 세션)은 `OPS_KEYS` 에 새 키 3개를 더해 그대로 |
| summary jobs·captures = owner DB 행 | `ops-retention.test.ts` "summary: A 의 jobs·captures…" — `ops.jobs` 가 A 의 jobs 행 상태별 직접 집계와 같음(blocked ≥ 1), `captures` 가 A 의 captures 행 수와 같음, `uploads` 숫자 3개 |
| owner 격리(jobs·captures·uploads) | `ops-retention.test.ts` "owner 격리…" — 새 owner C: jobs 전부 0·attention 0·uploads 0. D 에 배포 1회 + BLOCKED 작업 + 소재 1개 추가 → D 의 숫자는 D 의 행과 같고(blocked 1, captures = C+1), C 의 숫자는 그대로 |
| jobs 상태별 수(T11 시험 이전) | `jobs.test.ts` worker/tick 시험 — health 대신 summary: 키 집합 6개·숫자, o(작업 CONFIRMED) 전부 0, other(QUEUED 1) 의 summary 는 queued 1 → 서로 섞이지 않음. 이어서 health 에 `jobs`·`attention_plans` 없음(health 의 inline tick 이 other 작업을 처리할 수 있어 summary 확인 뒤에 호출) |
| attention_plans(T12 시험 이전) | `m3-gate.test.ts` HTML 폼 시험 — health `jobs.attention_plans >= 1` → summary `attention_plans` **정확히 1**·`jobs.blocked` 1(새 owner 라 단언을 강화) |
| uploads(T08 시험 이전) | `uploads-transcription.test.ts` — health 에 `uploads` 없음 + 새 시험: A 의 summary `uploads` = `usage(ownerA)`, A 가 조각 1개(3000B) 올리면 sessions/files +1·bytes +3000, B 의 summary 는 변하지 않음, 중단(DELETE) 뒤 원래 값 |

inline tick 의존: health 를 tick 구동용으로 쓰던 시험은 없었다(모두 응답 숫자만 읽음). m3-gate 시험은 health 호출(= inline tick 1회)이 summary 호출로 바뀌어 그 지점의 tick 이 사라졌지만, 해당 owner 작업은 BLOCKED 이고 이후 단계는 `retryPOST` 응답만 본다 — 전체 통과로 확인.

## 실행한 명령과 결과(Windows 10, Git Bash, `source tools/env.sh`, Node 24.21.0)
| 명령 | 결과 |
|---|---|
| `corepack pnpm lint` | PASS (1차: `jobs.ts` 미사용 import `distributionPlans` → 제거 뒤 PASS) |
| `corepack pnpm typecheck` | PASS (1차: m3-gate 변수 이름 `s` 중복 → `sum` 으로 바꾼 뒤 PASS) |
| `corepack pnpm build` | PASS |
| `corepack pnpm test` (unit) | PASS — 42 files, 831 tests |
| `vitest run --project integration` 영향 5개 파일(health·jobs·m3-gate·ops-retention·uploads-transcription) | PASS — 149 tests (전체 실행 전 확인용) |
| `corepack pnpm test:integration` (단독) | PASS — 33 files, 654 tests |
| `corepack pnpm drill:mock` | PASS (exit 0) — "불변식 위반 0건 — M3 게이트·T14·T15·T16 모의 불변식 통과(MOCK)", fetch 0 |

dev 서버는 켜지 않았다(빌드만). `./data` 는 열지 않았다.

## 남은 위험
- `/api/ops/summary` 응답 모양이 넓어졌다(키 3개 추가). 이 경로를 읽는 화면·스크립트는 저장소 안에 없다(시험만). 외부에서 공개 health 의 `jobs`·`uploads`·`db.captures` 를 보던 모니터링이 있었다면 깨진다 — 로그인 뒤 summary 로 옮겨야 한다.
- `uploads` 는 요청마다 그 owner 폴더를 걷는다(`disk` 처럼 60초 캐시 없음). 업로드 세션은 24시간 만료라 폴더가 작다고 보지만, 아주 많은 조각이 남은 경우 summary 응답이 느려질 수 있다.
- `UploadStore.usage()`(인자 없음, 영역 전체)는 남겼다 — 지금 호출처는 없다. `countCaptures(db)`(owner 없음)는 worker tick 결과(`captures`)·seed 시험이 계속 쓴다(공개 응답에는 나가지 않음).
- degraded 시험은 `vi.doMock`+`vi.resetModules` 로 route 모듈을 다시 불러온다. 같은 파일의 이후 시험은 없고 `finally` 에서 원복한다.

## Codex 에게 묻는 것
1. `ops.uploads` 를 **owner 폴더(`<uploads>/<owner>`)만** 세도록 했다(지시는 "폴더 측정, disk 처럼 문서화"). 업로드 경로가 `<root>/<owner UUID>/<session UUID>` 로 고정돼 있어 owner 범위가 가능했다. 영역 전체 측정(disk.uploads 와 같은 성격)이 더 맞다고 보는가, 아니면 owner 범위가 D23 의도에 맞는가? 또 측정 실패를 `null` 로 내는 처리(`usage(ownerId).catch(() => null)`)가 충분한가(owner ID 가 UUID 가 아니면 throw → null)?
2. `attention_plans` 를 `ops.jobs` 안에 다시 두지 않고 기존 최상위 `ops.attention_plans` 하나로만 낸 선택, 그리고 전역 `attentionPlanCount`·owner 없는 `jobStateCounts(db)` 를 제거한 것이 다른 경로(worker CLI·/ops 화면·drill)에 숨은 의존을 깨지 않는지 확인 부탁한다(저장소 grep 으로는 사용처 없음).
