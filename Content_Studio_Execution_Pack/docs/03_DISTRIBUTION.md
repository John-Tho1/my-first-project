# 배포 계약·API 제약·상태 전이
문서 확인일 2026-09-24. 공식 API가 존재한다는 사실과 사용자 계정에서 동작한다는 사실은 다르다. 세부 출처는 08_SOURCES.md.

## 우선순위
| 채널 | 제공할 결과 | 외부 조건 | 초기 fallback |
| --- | --- | --- | --- |
| Threads | 텍스트 게시, 추후 이미지/영상 | 사용자 OAuth·게시 scope, 계정/앱 상태, token 유효성 | 글 복사·파일 export |
| YouTube | 완성 영상 업로드·메타데이터·조건부 공개/예약 | OAuth·quota·프로젝트 심사·채널 권한 | 영상/설명 패키지 + 수동 업로드 |
| Instagram | 완성 이미지/캐러셀/영상 + 캡션 | professional 계정과 적합한 API login/권한·규격 | 미디어/캡션 패키지 |
| LinkedIn | 선택적 글/미디어 게시 | member/organization 권한과 정체성 적합성 | 원고 export |
| 그 밖의 SNS/블로그 | 공통 export adapter | 별도 공식 API 검토 필요 | 수동 패키지 |

Threads [공식자료]: 컨테이너 생성 후 threads_publish로 게시하며 사용자 인증과 scope가 필요하다. 최소 권한부터 검토하고 reply/insights 권한을 게시에 무조건 함께 요청하지 않는다. 공급자 예제가 legacy처럼 token query를 보여줘도 token이 URL/log에 남지 않는 인증 방식을 확인한다.

YouTube [공식자료]: videos.insert로 업로드 가능. 미검증 API 프로젝트(공식 문서의 해당 조건)는 업로드 영상의 공개가 private로 제한되며 공개 제한 해제에는 감사가 필요하다. OAuth 앱 검증과 YouTube API 감사는 서로 다른 문제로 확인한다. “업로드 성공”을 “공개 게시 성공”으로 표시하지 않는다. publishAt은 private이며 한 번도 공개되지 않은 영상에서만 사용하고, 과거 시각은 즉시 공개 효과가 있으므로 앱은 과거 예약을 거부한다. 재개 업로드 protocol을 사용한다.
Instagram [공식자료·부분 확인]: 공식 검색 결과 및 Meta 공식 collection의 검색 발췌에서 professional 계정과 게시 기능을 확인. 본문 접근이 제한돼 상세 scope/API 경로·미디어 제한은 M4 구현 전에 재확인한다. Instagram Login과 Facebook Login의 계정/권한 조건을 섞지 않는다. Stories는 초기 범위 밖.
LinkedIn [공식자료]: Posts API는 회원과 조직 게시 권한을 구분하며 개인 게시물 읽기는 제한 권한이다. 게시 가능하더라도 조회수·댓글 자동 수집이 가능하다고 가정하지 않는다. 필명을 임의 개인 프로필로 만드는 계획은 수립하지 않는다.

## 한 번의 사용자 승인으로 가능한 자동 실행
“이 버전의 이 글/미디어를, 이 계정의 이 채널에, 이 공개 범위로, 이 시각에 배포”를 한 화면에서 검토하고 승인한다. 이 범위의 정상 재시도·상태 확인에 매번 새 승인을 요구하지 않는다.
새 채널, 다른 계정, 본문·이미지·영상·썸네일·CTA·링크·공개범위·일정 변경은 새로운 승인 대상이다. 대량 배포는 각 채널 결과물을 전부 검토할 수 있어야 하며 기본 전체 선택 금지.

## 승인 스냅샷
canonical publish payload:
content_version_id, variant_version_id, brand_profile_version_id, channel_account_id, provider_account_id,
body/title/description/tags/links/alt_text, ordered asset IDs+checksums,
visibility, scheduled_at_utc, timezone, provider-specific metadata(예: kids/synthetic disclosure).
서버가 canonical JSON→SHA256 생성. 사용자가 본 미리보기와 같은 payload인지 hash 비교.
approval: authenticated owner, approved_at, payload_hash, revoked_at, purpose(upload_private/public_publish), approval_version.
worker는 실행 직전 owner/account 상태·hash·취소·risk·허용 실행 모드와 적합성을 다시 검사한다.
승인 재검사와 SENDING 전환·전송 의도 기록은 같은 DB transaction에서 처리한다. 취소/철회도 동일 item을 직렬화해 검사한다. SENDING 이후의 철회는 외부 전송을 되돌렸다고 주장하지 않고 CANCEL_REQUESTED로 추적한다. 원격 서버까지의 원자적 취소는 보장하지 않는다.
비공개 업로드만 승인한 경우 publishAt 설정이나 public 전환은 허용되지 않는다. 이후 공개는 해당 최종 메타데이터·계정·시각을 포함한 별도 승인 또는 처음부터 명확히 승인한 공개 계획의 범위에서만 실행한다.
asset 교체는 새 asset ID/checksum을 만들고 새 variant version을 생성한다. 승인된 버전의 파일·순서·메타데이터를 제자리 수정하지 않는다. 원고 수정으로 파생본이 stale이 되면 미시작 배포를 보류하고 해당 파생본의 재검토·재승인을 요구한다.
모델이 approval=true를 반환해도 승인으로 사용하지 않는다.
PUBLISH_MODE: disabled(mock/export only) / enabled(연결·사용자 승인 필요). “test”라도 실제 계정으로 전송하면 외부 쓰기다.

## 상태를 분리
콘텐츠: CAPTURED → IDEA → DRAFT → REVIEW → READY → ARCHIVED.
파생본: DRAFT → REVIEW → APPROVED; 수정 시 REVIEW로 돌아간다.
배포 child job:
PLANNED → QUEUED → PREPARING → SENDING → REMOTE_PROCESSING → CONFIRMED.
보조 상태: RETRY_WAIT / BLOCKED / RECONCILING / UNKNOWN / CANCEL_REQUESTED / CANCELED / FAILED.
원격 결과: UPLOADED_PRIVATE / SCHEDULED_REMOTE / PUBLISHED / MANUAL_REPORTED.
CONFIRMED라고 해서 public인 것은 아니다. verified remote visibility/result_kind를 함께 표시한다.
여러 채널 중 일부만 성공하면 parent plan은 PARTIAL. 성공한 child는 다시 보내지 않는다.
수동 URL 입력은 MANUAL_REPORTED(사용자 기록), 실제 상태 조회로 확인한 결과만 VERIFIED.
세부 상태 전이는 domain 함수 한 곳에서 관리하고 이력은 append-only 기록.

~~~mermaid
stateDiagram-v2
  [*] --> QUEUED
  QUEUED --> SENDING: 승인 재검사
  SENDING --> REMOTE_PROCESSING: 원격 ID 확보
  SENDING --> RECONCILING: 응답 불명확
  REMOTE_PROCESSING --> CONFIRMED: 목표 상태 확인
  RECONCILING --> CONFIRMED: 기존 결과 확인
  RECONCILING --> UNKNOWN: 확인 불가
  SENDING --> RETRY_WAIT: 부작용 없는 일시 오류
  RETRY_WAIT --> QUEUED: 승인 유지
  QUEUED --> CANCELED: 시작 전 취소
~~~

## 중복·재시도 규칙
로컬 key: owner+distribution_plan+channel_account+variant_version+payload_hash의 unique 제약. HTTP command idempotency key도 저장하고 재호출이면 기존 결과 반환.
동일 본문을 새 plan으로 의도적으로 재게시하는 경우 경고 후 새 사용자 승인. 기존 key를 억지로 재활용하지 않는다.
네트워크 timeout/worker crash 뒤 원격 성공 여부가 불명확하면 조회·기존 upload session 재개가 우선. 재조회 불가능하면 UNKNOWN으로 보류한다. 사용자의 재전송 결정에는 중복 가능성을 표시한다.
429/5xx라도 전송 부작용이 발생했는지 분류한다. “모든 5xx를 무조건 retry” 금지. Retry-After + backoff/jitter, 횟수·시간 한도.
401은 허용 범위의 refresh 한 번 후 재검증, 실패하면 BLOCKED. 권한 부족·형식 위반은 자동 반복하지 않음.
플랫폼별 rate limit/본문 길이/미디어 규격을 capabilities에 기록하고 확인일·API version을 보관. 코드 작성 시 최신 공식 한도를 확인하며 이 설계서에서 숫자를 고정하지 않는다.
삭제/수정은 게시와 다른 command와 승인. 삭제 불가를 허위 성공으로 처리하지 않는다.

## ChannelAdapter 계약(설계)
capabilities(account), validate(snapshot), prepare(snapshot, context), submit(prepared, context),
reconcile(reference, context), cancel(reference, context).
return: status, result_kind, external_id, permalink?, remote_visibility?, retry_class, provider_request_id?.
read capability가 없으면 reconcile 결과는 unsupported/unknown. 연결이 없는 adapter가 성공을 반환하면 안 됨.
Mock adapter는 명확한 mock prefix의 ID/화면 배지를 사용하고 실제 URL을 꾸며내지 않는다.
