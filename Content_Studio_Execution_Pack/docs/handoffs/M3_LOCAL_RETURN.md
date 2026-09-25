# M3 완료 — 로컬 복귀 런북 (Codex 검증 → 화면 확인 → M4 결정)
작성: 2026-09-25 (Europe/Moscow), 클라우드 세션(Fable 5.1 오케스트레이션, Opus 구현). 브랜치 `content-studio/m3` (base 5d78a95 = M2 최종).

## 0. 상태 한눈에
| 작업 | 코드 커밋 | 인계 사본 | 검증(클라우드, Node 22.22.2) |
| --- | --- | --- | --- |
| T10 승인 스냅샷·철회·실행 멱등 | `d1844d6` | `T10_IMPLEMENTATION_HANDOFF.md` | unit 436 · integration 270 |
| T11 DB 작업함·lease·재시도·재확인·취소 | `a2a9670` | `T11_IMPLEMENTATION_HANDOFF.md` | unit 515 · integration 295 |
| T12 모의 시나리오·PARTIAL·재시도·M3 게이트 | `240080b` | `T12_IMPLEMENTATION_HANDOFF.md` | unit 530(2회) · integration 312 · `drill:mock` 위반 0 |

세 작업 모두 lint·typecheck·build 통과, lockfile 불변(새 의존성 0), 외부 호출 0, 비밀 0, 실제 게시 0(모의 계정만). **Codex 미검증**(클라우드에 CLI 없음). 결정 기록 D17·D18·D19(`docs/DECISIONS.md`). 인계 사본은 `docs/handoffs/`(추적)에 있고 원본 규칙상 `.handoffs/`로 옮겨 쓴다.

## 1. 로컬에서 시작 (Git Bash, 저장소 루트)
```bash
git fetch origin content-studio/m3 && git checkout content-studio/m3
cd Content_Studio_Execution_Pack && source tools/env.sh          # PowerShell: . .\tools\env.ps1
mkdir -p .handoffs && cp docs/handoffs/T1*_IMPLEMENTATION_HANDOFF.md .handoffs/
corepack pnpm install --frozen-lockfile
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test && corepack pnpm test:integration && corepack pnpm build
corepack pnpm db:migrate && corepack pnpm db:seed              # 0016~0018 적용, 모의 계정 4개
corepack pnpm drill:mock                                        # M3 게이트 표, exit 0 이어야 함
```
[미확인] Windows/Node 24 에서 0016~0018 migration·drill 은 아직 실행된 적 없다. 실패 출력은 그대로 로컬 Claude Code 에 붙여 넣는다. dev 서버가 켜진 채 `pnpm build`/`db:*` 를 돌리지 않는다(M2_STATUS §4).

## 2. Codex 검증 (작업별 커밋, 순서대로)
```bash
./scripts/codex-review-commit.sh d1844d6 T10 .handoffs/T10_IMPLEMENTATION_HANDOFF.md
./scripts/codex-review-commit.sh a2a9670 T11 .handoffs/T11_IMPLEMENTATION_HANDOFF.md
./scripts/codex-review-commit.sh 240080b T12 .handoffs/T12_IMPLEMENTATION_HANDOFF.md
```
결과는 `.handoffs/review-T1x.md|.log`. 지적 항목만 로컬 Claude Code 에 전달 → `prompts/CLAUDE_FIX.md` 절차(재현 → 최소 수정 → 새 HEAD → 같은 스크립트로 재검증). 각 인계 문서 말미 "Questions specifically for Codex" 6개가 우선 확인 지점이다. T12 인계의 위험 항목 중 **DB 트리거 미강제(assets.checksum·variant_assets)** 와 **D17(d) 뒤집음(브랜드 무효화)** 은 Codex 판정과 함께 사용자 결정으로 닫는다(§4).

## 3. 화면 확인 체크리스트 (M3, `corepack pnpm dev`, owner@example.local)
| # | 화면 | 확인 |
| --- | --- | --- |
| 1 | `/contents/{id}` 파생본 패널 | review 파생본에 `배포 계획 만들기`; approved 파생본에 계획 링크·`승인됨` |
| 2 | `/distribute/new?content_id=` | 채널별 MOCK 계정만 선택 가능, 예약 MSK 입력, 과거 시각 → 오류 |
| 3 | `/distribute/{id}` 미리보기 | 나갈 글 그대로(채널별 모양), 첨부 checksum, 공개 범위, `MSK (UTC)`, 해시, **기본 미선택**, MOCK 배지 |
| 4 | 승인 | 확인 체크 없이 → 오류; 선택 승인 → 승인 목록·`철회` 버튼; 원고/파생본 수정 후 돌아오면 승인 자동 철회(`invalidated:*`) |
| 5 | 실행 | `지금 실행` → job `QUEUED · MOCK`; 새로고침 후 재클릭해도 job 1개 |
| 6 | 처리 | `작업 처리 실행(모의 1회)` → `CONFIRMED · MOCK`, publication `mock://…` + `실제 발행 실적 아님`; `게시 완료` 문구 없음 |
| 7 | 시나리오 | 새 계획에서 항목별 `개발용 · 모의 결과 선택`: auth → `계정 다시 연결 필요`; transient_then_success → `재시도 대기 (n/5, 다음 HH:mm MSK)` → 성공; ambiguous_sent → `등록 여부 확인 필요` → 재확인 → CONFIRMED; reconcile_unsupported → `확인 불가 — 자동 재전송 안 함` |
| 8 | PARTIAL | 4채널 계획 + 1채널 auth → 목록 `부분 성공`; 재시도 → `완료` |
| 9 | YouTube | 성공해도 `비공개 업로드 완료, 공개 전환 확인 필요`(공개 성공 표시 없음) |
| 10 | 취소 | QUEUED 취소 → `취소됨`; 전송 중(hang 시나리오) 취소 → `취소 확인 중` |
| 11 | `/api/health` | `jobs{queued,…,attention_plans}` 집계만, 비밀·경로 없음 |
| 12 | 재시작 | dev 서버 재시작 후 job/이벤트/publication 그대로(DB 보존) |
관찰 사항은 `.handoffs/screen-notes-m3.md` 에 번호와 함께 기록.

## 4. M4 착수 전 사용자 결정 (권고안)
| # | 결정 | 권고 |
| --- | --- | --- |
| D19-a | 브랜드 프로필 새 버전 → 활성 승인 무효화(D17(d) 뒤집음) | **유지**(브랜드 버전이 해시에 들어가므로 일관) |
| D19-b | `assets.checksum`·기존 버전 `variant_assets` 불변을 DB 트리거로 강제 | **트리거 추가**(Codex 판정 뒤 FIX 라운드에서, 작은 migration) |
| D19-c | 항목별 모의 시나리오의 production 동작(모의 계정 한정) | 유지하되 M4 에서 live 계정 도입 시 `NODE_ENV` 게이트 재검토 |
| D19-d | 재시도 수치(30s·15min·±20%·5회·lease 60s·timeout 30s) | 잠정 유지, 실계정 연결 전 공식 rate limit 로 재조정 |
| M4 | T13(OAuth·비밀 암호화)은 **실계정·외부 승인** 필요: 첫 채널(Threads 권고), 앱 등록·scope·테스트 계정·마스터 키 보관 방식 | 사용자가 계정·앱 준비 상태를 확인한 뒤 착수. 준비 전에는 M3 FIX 라운드와 T20(모니터링·백업)의 mock 가능 부분만 진행 가능 |

## 5. 로컬 Claude Code 착수 프롬프트 (Codex 결과 수신 후)
```
Content Studio M3 FIX 라운드. 브랜치 content-studio/m3(HEAD 240080b 이후). .handoffs/review-T10.md, review-T11.md, review-T12.md 의
P0/P1 을 재현 → 최소 수정 → 회귀 테스트 → 커밋 → scripts/codex-review-commit.sh 재검증 순으로 처리한다(prompts/CLAUDE_FIX.md).
D19-a~d 는 docs/handoffs/M3_LOCAL_RETURN.md §4 권고안대로 확정한다(내가 바꾸면 그때 말한다). 5종 검사(lint/typecheck/test/test:integration/build)
+ drill:mock 통과를 인계 문서에 기록. M4(T13)는 내가 실계정·외부 승인 범위를 확인해 줄 때까지 착수하지 않는다.
```
