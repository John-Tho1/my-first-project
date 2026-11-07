# T19-H1 구현 인계 — 수집 소스 상한(50) 동시 등록 경쟁 보강

- 작업: T19 "남은 위험"(round 1 인계) 중 결정 없이 고칠 수 있는 항목 — 소스 49개에서 두 등록이 동시에 오면 count 뒤 insert 라 51개가 될 수 있었다.
- BASE: `b1a79b3`(T19 PASS 기록 docs 커밋, 코드는 f07153c 와 같음) · HEAD: 아래 "리뷰 대상" 줄.
- 브랜치 `content-studio/m4`. migration·새 의존성·네트워크 없음.

## 무엇을 바꿨나
| 파일 | 변경 |
| --- | --- |
| `packages/db/src/collector.ts` `createCollectorSource` | 개수 확인·추가·감사를 한 트랜잭션에서, 맨 앞에 `pg_advisory_xact_lock(hashtext('cs.collector:<ownerId>'))`(받아들이기 `acceptCollectedItems` 와 같은 키). URL 정책 검사·정규화는 잠금 전(요청 없음). 오류 코드·메시지 그대로. |
| `tests/integration/collector.test.ts` | 'T19 남은 위험 — 소스 상한 동시 등록': 이 시험만의 owner 에 49개를 넣고 `createCollectorSource` 두 번을 `Promise.allSettled` 로 동시에 → 하나만 성공, 다른 하나는 `collector_too_many_sources`, 최종 50개. 끝나면 그 owner 의 감사·소스·사용자 행 삭제. |

## 확인
- 옛 코드(HEAD 의 collector.ts)로 임시 되돌림 → 이 시험 실패("to have a length of 1 but got 2" = 51개). 원복 후 통과.
- 처음 쓴 시험은 ownerB 를 썼는데 다른 시험이 ownerB 에 소스를 상한 무시하고 직접 넣어(58개) 전체 실행에서 실패 → 전용 owner 로 바꿈.

## 명령과 결과 (로컬 Windows 10, Git Bash, Node 24.21.0, `corepack pnpm`, 순차, dev 서버 꺼짐)
- `.handoffs/run-checks.sh T19H1`(전용 owner 로 바꾸기 전): lint 0, typecheck 0, build 0, unit pass(1269), integration 1 failed(위 ownerB 문제)/738 passed, drill:mock 0건, db:migrate 0, drill:restore PASS.
- 고친 뒤: `vitest run --project integration tests/integration/collector.test.ts` → 29 passed. `corepack pnpm lint` 0, `corepack pnpm typecheck` 0.
- `.handoffs/run-integ.sh T19H1b`(혼자 실행): pass — "Test Files 36 passed (36)", "Tests 739 passed (739)". unit·build·drill·migrate·restore 는 코드 변경이 시험 파일 + 이 함수뿐이라 위 T19H1 결과를 그대로 씀(재실행 안 함).

## 리뷰 대상
- BASE: b1a79b3 / HEAD: 1e47574

## 남은 위험
- 소스 설정 변경(`updateCollectorSourceSettings`)·삭제 경로는 잠금 없음 — 상한과 관계없어 그대로 둠.
- T19 의 다른 남은 위험(실제 PostgreSQL 동시 수락, collector 출처 DB unique, 화면 브라우저 미확인, UTF-8 만)은 이번 범위 밖.

## Codex 에게 질문
1. 받아들이기와 같은 advisory 키를 쓰는 것이 교착 위험 없이 맞는가(등록은 다른 잠금을 잡지 않음)?
2. PGlite 시험은 트랜잭션 직렬화로 통과한다 — 실제 PostgreSQL 다중 연결에서도 이 잠금이 count→insert 를 직렬화하는가?
