# 애플리케이션 아키텍처
상태: 제안. 배포 공급자·버전·계정은 미정. 모든 외부 연결은 기본 OFF.

## 선택과 대안
| 선택지 | 판단 |
| --- | --- |
| Notion 기반 관리 + 외부 자동화 | 빠른 시험에 유리하나 전용 작성 경험·승인 스냅샷·중복 배포 통제가 분산되기 쉬움. 기존 자료의 선택 소스로 활용 |
| 개인 웹앱 + DB + 작업 처리기 | 권고. 원본·작성·승인·작업 결과를 연결하며 이식 가능한 파일로 보유 |
| 처음부터 완전한 SNS SaaS | 다중 사용자·결제·심사·운영 범위가 과도해 보류 |
판단은 이 프로젝트의 요구에 대한 설계 의견이며 보편적 제품 비교 결과가 아니다.

## 구성
- web: Next.js + TypeScript, 반응형 UI 및 서버 API. 정적 공개 사이트와 분리된 비공개 서비스.
- domain: 수집/콘텐츠/승인/배포/비용/통합의 공통 규칙. UI와 worker가 같은 규칙 사용.
- persistence: PostgreSQL, SQL migrations와 타입 기반 접근 계층. ORM은 M0에서 한 가지만 선정.
- worker: 별도 Node.js 프로세스. 전사·자료 추출·생성·미디어 처리 상태 확인·배포·후속 조회.
- media: 비공개 object storage. 개발에는 local-file adapter, 운영에는 S3 호환 서비스 등 선택. DB에는 메타데이터·checksum만.
- auth: 검증된 인증 라이브러리 + OIDC 등 한 방식. 단일 사용자 allowlist. 자체 암호화/비밀번호 구현 금지. 공급자는 운영 환경에서 확정.
- LLM: provider interface, 초기 live provider 하나. 모델 ID·상한·문체 profile 설정. 이후 공급자 교체 가능.
- publisher: 채널별 adapter와 capabilities. 지원하지 않는 기능은 export/manual 모드.
- collector: 허용 URL/RSS/선택 Notion·Drive importer. 게시 권한과 분리.
- deploy: 로컬 Docker Compose 개발; 운영은 reverse proxy/TLS + web + worker + DB + 외부/별도 파일저장. 처음에는 web/worker 각 1 replica.

## 제안 저장소 레이아웃
~~~text
apps/web
apps/worker
packages/domain
packages/db
packages/providers
packages/shared
tests/fixtures
tests/integration
tests/e2e
docs
handoffs
~~~
이 패키지에는 위 앱 소스가 아직 없으며 Claude Code가 M0에서 만든다. 과도한 패키지 분리는 피하고, 핵심 경계만 유지한다.

## 작업함 설계
DB 작업 테이블을 큐로 사용. 승인·배포계획·outbox/job 생성은 한 DB transaction.
worker는 FOR UPDATE SKIP LOCKED로 다음 작업을 짧은 transaction에서 lease하고 commit한다. 외부 API 호출 중 DB row lock을 유지하지 않는다.
lease_owner/lease_expires_at/attempt_count/next_run_at을 기록. heartbeat와 lease 만료 복구가 필요하다. 만료한 publish 작업은 무조건 재전송하지 않고 provider 부작용 가능 여부에 따라 RECONCILING/UNKNOWN으로 이동.
API 측 exactly-once를 보장한다고 주장하지 않는다. 로컬 중복 명령은 unique key로 막고 원격 불확실성은 reconciliation으로 처리.
worker 재시작·동시 처리·네트워크 단절이 주요 검증 대상이다. cron/setTimeout만으로 장기 예약 작업의 정본을 만들지 않는다.

## 장시간 영상 업로드
브라우저→파일저장소로 제한된 업로드 권한을 발급. 업로드 세션 owner·파일형식·크기·checksum 검사 후 VERIFIED asset 상태.
worker가 검증된 파일에서 업로드; session URI/offset/video ID를 보관해 재개한다. 일반 웹 요청의 실행시간 안에 전체 영상을 처리하지 않는다.
일시적으로 외부에서 접근 가능한 미디어 URL을 요구하는 채널은 승인된 파생 미디어만 별도 전달한다. 원본 bucket 전체 공개 금지. 공급자 처리 시간을 고려한 제한된 URL 수명·청소; 게시 확정 전 만료 방지.
사용자가 작성 화면에 넣은 URL을 무조건 공개 미디어 URL로 넘기지 않는다.

## 데이터의 정본과 통합
앱이 도입된 이후 생성한 콘텐츠와 배포 상태는 앱 DB가 정본이다. 기존 Notion·Drive는 선택 가져오기 또는 참조 소스.
양방향 동기화 없음. source provider/external_id/revision/hash로 재가져오기 중복 방지, 충돌은 사용자 선택. 원본 시스템을 수정·삭제하지 않음.
Drive 대용량 영상은 선택적으로 앱 저장소에 복사하거나 승인된 다운로드 작업으로 가져오며, 단순 Drive 공유 링크가 SNS의 직접 미디어 URL로 동작한다고 가정하지 않는다.
관련 ChatGPT 커넥터의 인증이 개인 앱에 전달된다고 가정하지 않는다.

## 접근 제어·비밀
모든 읽기/쓰기 API와 파일 URL에서 로그인·owner를 서버가 확인. 단일 사용자라도 다른 계정의 ID를 받아 데이터에 접근하지 못하게 한다.
OAuth state/redirect URI 검증, 가능한 흐름에서 PKCE, 최소 scope, token expiry·refresh·revoke 처리. 토큰은 서버 암호화 저장, master key는 DB/백업과 별도.
AI prompt·브라우저·오류 로그에 토큰/세션 URI/비공개 raw URL을 포함하지 않는다. 테스트와 Codex review 환경에는 운영 credentials를 주지 않는다.
승인 검사와 PUBLISH_MODE는 서버/worker에서 강제. UI 버튼이나 AGENTS.md만으로 막지 않는다.
외부 HTML/Markdown sanitize, active content 실행 금지. URL fetch는 HTTP(S) 한정, private/loopback/link-local/metadata IP 및 redirect 재검사, DNS rebinding·큰 파일·시간 초과 대응. 지원 어려운 웹페이지는 수동 발췌.
AI에게 외부 문서의 지시를 따르거나 게시 도구를 호출할 권한을 주지 않는다.

## 운영·복원
- job 지연, 반복 실패, token 만료, UNKNOWN, DB/파일 용량, 비용 한도, backup age를 표시.
- 외부 알림은 M5 선택 기능. 기본은 앱 알림이며 이메일/메시지 전송은 별도 설정.
- 일별 DB+asset manifest 백업, 주기적으로 별도 환경 복원. 운영 전 최소 1회 통과.
- export에서는 OAuth/API key 제외. backup의 개인 데이터는 암호화하고 접근/보존 기간을 정함.
- 예약시간은 UTC 저장 + 원래 timezone 보관, 화면 MSK. 서버 local timezone에 의존하지 않음.
- 배포 취소는 아직 시작하지 않은 작업만 즉시 확정. 이미 외부 전송 중이면 “취소 확인 중”. 공개된 글 삭제는 별도 명시 동작.
- 비용: generation_jobs와 usage_ledger에서 호출 전 budget reservation, 완료 후 실제 사용량 확정. 가격 미설정/한도 초과면 live 호출 차단. 미확정 비용·실패 재시도도 예약량에 반영.

