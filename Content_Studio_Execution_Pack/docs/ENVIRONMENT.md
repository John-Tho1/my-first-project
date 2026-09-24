# ENVIRONMENT.md — T00 환경·저장소 점검 결과
점검일: 2026-09-24 (Europe/Moscow) · 점검자: Claude Code (Fable 5.1, 오케스트레이션) · 상태: **T00 완료, T01 착수 전 결정 대기**

이 문서는 사용자 PC에서 실제로 실행한 명령의 결과만 기록한다. 비밀값은 출력하지 않았고 기존 설정은 변경하지 않았다.

## 1. OS·셸
| 항목 | 값 | 근거 |
| --- | --- | --- |
| OS | Windows 10 Enterprise 10.0.19044 | 세션 환경 |
| 관리자 권한 | **없음** | `WindowsPrincipal.IsInRole(Administrator)` = False |
| 셸 | PowerShell 5.1(기본), Git Bash(보조) | 세션 환경 |
| WSL | 미확인(사용하지 않음) | — |
| 패키지 관리자 | winget v1.3.2091 | `winget --version` |

## 2. 런타임·도구 설치 여부
| 도구 | 상태 | 근거 |
| --- | --- | --- |
| git | 2.55.0.windows.4 | `git --version` |
| **Node.js / npm / pnpm** | **설치 완료(2026-09-24, T00 중)**: Node v24.21.0 (LTS), npm 11.19.0, pnpm 12.6.0 (corepack 0.36.0) | 사용자 승인 후 `nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip`(37.6MB)을 `%LOCALAPPDATA%\Programs\node\`에 압축 해제, SHASUMS256.txt 대조 OK. 시스템 PATH 미변경, 세션마다 `tools/env.sh` 또는 `tools/env.ps1`로 지정 |
| nvm / fnm / volta | 없음 | `Get-Command` 실패 |
| deno / bun | 없음 | `Get-Command` 실패 |
| .NET | 런타임 6.0.5만 있음, **SDK 없음** | `dotnet --list-sdks` 빈 출력 |
| Python | 없음(Microsoft Store 스텁만, 0바이트) | `python --version` → Store 안내 |
| PostgreSQL(psql) | 없음 | `Get-Command psql` 실패 |
| Docker | 없음 | `Get-Command docker` 실패 |
| sqlite3 CLI | 없음 | `Get-Command sqlite3` 실패 |
| Claude Code | 설치됨 (`~/.local/bin/claude`) | `which claude` |
| **Codex CLI** | **0.155.1 설치됨, 인증 파일 존재** | `codex --version`, `~/.codex/auth.json` 존재(내용 미열람) |

Codex 설정(`~/.codex/config.toml`)에는 `projects.'c:\users\i0211533\documents\my-first-project'.trust_level`이 있어 상위 저장소가 신뢰 프로젝트로 등록돼 있다. 값은 열람하지 않았다.

Codex CLI 0.155.1 확인된 하위 명령: `exec`, `review`(`--uncommitted`, `--base <BRANCH>`), `exec --output-schema <FILE>`, `exec -o/--output-last-message <FILE>`, `--sandbox <MODE>`. docs/06_AGENT_WORKFLOW.md의 예시 명령과 일치한다.

## 3. 네트워크
| 대상 | 결과 |
| --- | --- |
| https://nodejs.org/dist/index.json | 응답 OK (최신 Current v26.10.0; LTS 목록은 별도 확인 필요) |
| https://registry.npmjs.org/ | HTTP 200 |
| winget `OpenJS.NodeJS.LTS` | 24.19.0 검색됨 (설치는 미실행) |

## 4. 기존 저장소 상태
- Git 저장소: `C:\Users\i0211533\Documents\my-first-project` (origin: github.com/John-Tho1/my-first-project, branch main, HEAD 0487edc).
- 이 패키지는 그 저장소 안의 **추적되지 않은 하위 폴더** `Content_Studio_Execution_Pack/`로 존재한다. ZIP 원본 `Content_Studio_Execution_Pack_2026-09-24.zip`도 추적되지 않은 상태로 상위 폴더에 있다.
- 상위 저장소의 기존 내용: `quote-calculator.html`, `expense-converter.html`(순수 HTML 앱), `scripts/codex-review.sh`, `scripts/codex-task.sh`, `.ai/handoff/`(Codex 리뷰 산출물 13건, gitignore 처리됨), `docs/ai-pair-setup.md`.
- 기존 앱 코드나 Content Studio 구현은 없다. 패키지 문서와 충돌하는 코드는 없다.

### AGENTS.md 계층 차이·충돌 보고
| 항목 | 상위 `my-first-project/AGENTS.md` | 이 폴더 `AGENTS.md` | 판단 |
| --- | --- | --- | --- |
| 프로젝트 정의 | 단일 HTML 견적 계산기 | Content Studio 웹앱 | 별개 프로젝트 |
| 의존성 | 외부 라이브러리·빌드·패키지 매니저 **금지** | Next.js/TS + lockfile 요구 | **충돌** |
| 검증 | 테스트 러너 없음, 브라우저 수동 확인 | pnpm lint/typecheck/test/build | **충돌** |
| 핸드오프 위치 | `.ai/handoff/` (gitignore) | `.handoffs/` 또는 저장소 밖 | 경로 상이 |
| Codex 역할 | read-only 리뷰, `scripts/codex-review.sh` | read-only 리뷰, worktree 기반 | 호환 |
| 금지 옵션 | `--yolo`, `danger-full-access` 금지 | 우회 플래그 금지 | 호환 |

Claude Code는 작업 폴더에 가장 가까운 CLAUDE.md/AGENTS.md를 우선 적용하므로 이 폴더 안에서는 이 폴더의 규칙이 적용된다. Codex도 하위 AGENTS.md를 함께 읽는다. 다만 상위 규칙의 "패키지 매니저 금지"가 문자 그대로 전체 저장소에 걸려 있어, **상위 AGENTS.md에 "`Content_Studio_Execution_Pack/`은 자체 AGENTS.md를 따른다"는 범위 조항 1줄을 추가하는 것을 권고**한다(사용자 확인 후 반영, T00에서는 변경하지 않음).

## 5. 결정 필요 사항 (T01 착수 차단)
설계 권고(Next.js/TypeScript + PostgreSQL)를 실행할 런타임이 이 PC에 없다. 관리자 권한이 없으므로 시스템 전역 설치는 실패할 수 있다.

| 결정 | 선택지 | 비고 |
| --- | --- | --- |
| D1. JS 런타임 | (a) Node.js LTS를 사용자 폴더에 포터블 zip으로 설치(관리자 불필요) (b) winget MSI 설치(UAC 필요) (c) 사용자가 직접 설치 | 어느 쪽이든 **파일 다운로드**이므로 사용자 승인 필요 |
| D2. 데이터베이스 | (a) PGlite(PostgreSQL WASM, npm 의존성만, 설치 없음) (b) PostgreSQL 포터블 바이너리 zip(EDB, 관리자 불필요) (c) 사용자가 PostgreSQL 설치 | (a)는 단일 프로세스·단일 연결 제약이 있어 M3 worker 동시성 검증 시 (b)/(c)로 전환 필요 |

결정 전까지 T01 이후의 코드 생성은 시작하지 않는다.

## 6. 미확인·미실행
- Node.js LTS 정확한 버전과 보안 지원 상태: 설치 시 `nodejs.org/dist/index.json`의 `lts` 필드로 확정해 여기에 추가 기록.
- Codex 인증 유효성: `codex doctor`는 실행하지 않았다(대화형 출력 가능성). 실제 리뷰 실행 시 확인.
- 프록시·회사 정책에 의한 npm 설치 차단 여부: 레지스트리 응답 200만 확인.
- 도메인·서버·SNS 계정·API 승인·예산: 이번 세션 범위 밖, 여전히 미확인.

## 7. M0 기술 결정 (2026-09-24, 사용자 확인)
| 결정 | 선택 | 근거 |
| --- | --- | --- |
| D1 JS 런타임 | Node.js v24.21.0 LTS, 포터블 zip, 사용자 폴더 | 관리자 권한 없음. LTS 라인이며 nodejs.org `index.json`의 `lts` 필드로 확인. pnpm은 corepack으로 고정 |
| D2 개발 DB | **PGlite**(PostgreSQL WASM, `@electric-sql/pglite`) | PostgreSQL·Docker 미설치, 설치 승인 부담 없음. PostgreSQL SQL 방언을 유지하므로 운영 PostgreSQL로 전환 시 스키마 재작성 불필요 |
| D2 제약 | PGlite는 단일 프로세스·단일 연결 | web과 worker가 같은 데이터 파일을 동시에 열 수 없다. M0–M2는 worker를 web 프로세스 안에서 inline 실행(`WORKER_MODE=inline`), M3 lease/동시성 검증(A07·A20)은 실제 PostgreSQL(`DB_DRIVER=postgres`)에서 수행해야 한다 |
| 접근 계층 | Drizzle ORM + drizzle-kit SQL migration | PGlite·node-postgres 드라이버를 모두 지원해 전환 비용이 낮음. ORM은 한 가지만(설계 요구) |
| 웹 | Next.js(App Router) + TypeScript | 설계 권고. 정확한 버전은 T01 lockfile에 고정 |
| 테스트 | vitest(단위·통합). E2E(Playwright)는 브라우저 바이너리 다운로드 승인이 필요해 M0에서는 `not_run` | 다운로드는 사용자 승인 사항 |
| 저장소 위치 | `my-first-project/Content_Studio_Execution_Pack/` 하위 유지, 상위 AGENTS.md에 범위 예외 1줄 추가(사용자 승인) | 사용자 지시("추가한 폴더 기준"). 별도 저장소 분리는 후속 결정 |
