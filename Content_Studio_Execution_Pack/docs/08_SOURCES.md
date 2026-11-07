# 근거·접근 범위
조회일: 2026-09-24 (Europe/Moscow). 날짜 없는 문서는 “수정일 미표시”로 기록하며 조회일을 게재일로 바꾸지 않는다. 아래 링크는 실제 검색/열기에서 확인했다. 문서에 나온 기능이 사용자 계정에서 검증된 것은 아니다.

## 프로젝트 사실
P1. 이번 대화: 필명·배포구조 소유·아카이브, 독자, 해외 사업/영업 운영, Claude Code 주 구현·Codex 검증. [확실]
P2. 첨부 Context and Sources / Workflows and Templates: 이 대화에서 전문 확인. 공개 가능한 개인 콘텐츠와 회사 내부정보 분리.
P3. 직전 단계 Notion/Drive 읽기 결과: Content Vault 16건 속성·본문 4건, 관련 구조·사업 기획 문서. 현재 importer를 실행하기 전 다시 조회할 것.
P4. 이 환경에서 claude/codex PATH 조회 결과 없음. 사용자 PC의 설치·연결은 미확인.

## 공식자료
| ID | 문서·URL | 확인 내용과 접근 범위 | 문서 날짜 |
| --- | --- | --- | --- |
| S01 | [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) | 본문 확인. 로컬 리뷰와 CLI 워크플로 | 수정일 미표시 |
| S02 | [Codex 명령](https://learn.chatgpt.com/docs/developer-commands?surface=cli) | 본문 확인. review 대상 선택, exec의 schema/output 옵션 | 수정일 미표시 |
| S03 | [Claude Code workflows](https://code.claude.com/docs/en/common-workflows) | 본문 확인. 독립 worktree·Git commit 전제 | 수정일 미표시 |
| S04 | [Claude Code memory](https://code.claude.com/docs/en/memory) | 본문 확인. CLAUDE.md의 AGENTS.md import, 지시문과 강제 통제 구분 | 수정일 미표시 |
| S05 | [Threads 공식 collection](https://www.postman.com/meta/threads/documentation/dht3nzz/threads-api?entity=request-34203612-5753b234-2a84-4b3f-844d-9f47940e718e) | Meta 공식 collection 본문 확인. OAuth·scope·컨테이너 게시 | 수정일 미표시 |
| S06 | [YouTube videos.insert](https://developers.google.com/youtube/v3/docs/videos/insert) | 본문 확인. 업로드와 미검증 프로젝트 공개 제한 | 조회 결과에서 확정 수정일 기록하지 않음 |
| S07 | [YouTube videos](https://developers.google.com/youtube/v3/docs/videos) | 본문 확인. privacyStatus, publishAt 조건·과거시간 동작 | 조회 결과에서 확정 수정일 기록하지 않음 |
| S08 | [YouTube resumable upload](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol) | 본문 확인. 업로드 세션·재개 protocol | 검색 결과 표기 2026-06-01 |
| S09 | [Instagram Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login) | 공식 검색 발췌만 확인. businesses/creators 계정. 본문 열기 실패 | 미확인 |
| S10 | [Instagram 공식 collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api) | Meta 공식 검색 발췌로 professional 게시 확인. 전체 본문 추출 제한. 상세 조건 재검증 필요 | 미확인 |
| S11 | [LinkedIn Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-06) | 본문 확인. member/organization scope, member 읽기 제한, 생성 결과 ID | 2026-05-13 |
| S12 | [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting) | 본문 확인. Node/Docker 운영 가능. 본 설계의 플랫폼 선택은 별도 판단 | 수정일은 별도 확정하지 않음 |
| S13 | [PostgreSQL SELECT](https://www.postgresql.org/docs/current/sql-select.html) | 본문 확인. SKIP LOCKED의 queue table 용도와 제한 | 버전 문서, 날짜 미표시 |
| S14 | [MDN share_target](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target) | 본문 확인. 제한적 브라우저 지원. 핵심 수집 기능으로 의존하지 않음 | 수정일 미표시 |

추가로 Meta 개발자 본문의 Threads/Instagram 일부 페이지 열기는 오류 또는 빈 extraction을 반환했다. Threads는 공식 Postman 본문으로 보완했으며 Instagram의 세부 구현조건은 확인 완료로 표시하지 않았다.

## 설계 판단과 사실의 분리
Next.js/PostgreSQL/별도 worker·기능 순서·UI·데이터 구조·개발일 추정·테스트 기준은 이 프로젝트의 요구에서 도출한 [실험 가정/설계 제안]이다. 공식자료가 “이 아키텍처가 최적”이라고 말한 것으로 인용하지 않는다.
서비스 가격·모델명·SNS 계정 상태·검증 완료·기존 연결 정상 동작을 추정하지 않았다.
플랫폼 지원 한도는 implementation-time 공식 문서 확인을 요구한다. 새로운 버전/요금/API 조건은 코드 작성 시 다시 확인한다.

