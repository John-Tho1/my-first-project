# 기존 자료 가져오기와 운영

## 선택 가져오기
직전 대화에서 직접 확인한 범위:
- Notion Content Vault: https://app.notion.com/p/68b18b614f254b559f1f023bdbc17c1c
- 해당 data source: collection://b9fd6519-028c-4b37-8c03-2de58a004957
- Content Studio: https://app.notion.com/p/3bfd7859efb8814eb056f467ed859e3c
- Drive 콘텐츠 루트: https://drive.google.com/drive/folders/1NzoI78SEv79qDPU4iUUzOQOqnITXI_HF
이 ID는 검색 시작점이다. 저장소 전체·부모 OS 전체를 가져오는 승인으로 취급하지 않는다.
실행 직전 live schema·수정일·접근 범위를 다시 읽고, 목록→미리보기→선택→확정 순서로 진행한다.
앱용 credentials와 최소 read scopes는 별도 준비. 연결 전 export 파일을 사용한 수동 importer도 가능하다.

| 이전 속성 | 앱 후보 필드 | 변환 원칙 |
| --- | --- | --- |
| 제목 | content.title/idea.title | 원문 유지 |
| Lane | series | 자동화/빌드로그를 신규 연재에 후보 매핑, 자동 확정 금지 |
| Status, Production Stage | lifecycle | 충돌·빈값은 검토 대기. Draft가 자동 승인되는 것 아님 |
| Source note | provenance note | 실제 경험 확인이나 사용권 증거로 자동 승격하지 않음 |
| Risk | imported_risk | 과거 Green도 현재 공개 승인 아님 |
| Platform, Format | desired variants | 실제 파생본문이 없으면 새 초안 후보 |
| Parent Content | core/variant relation | 외부 ID 먼저 보존, 연결 못 하면 unresolved |
| Asset Folder | source folder reference | URL을 public 미디어 URL로 사용하지 않음 |
| 발행 링크 | publication reference | MANUAL_REPORTED, 실게시 확인 전 verified=false |
| Performance | raw note | 기존 의미 보존, 플랫폼 공식 metric과 분리 |

원문/본문/태그/첨부/관계 읽기 지원을 확인하고 missing 내용을 적는다. 수정·삭제·archive 이동·중복 정리는 이 importer의 권한 밖이다.
앱 로컬 수정과 외부 수정이 모두 있으면 원문을 덮어쓰지 않고 conflict 카드로 남긴다.
기존 초안의 AI가 추정한 1인칭 장면은 needs_user_confirmation으로 가져온다.

## 운영 순서
1. 앱과 worker 건강 확인, unresolved/UNKNOWN 작업 확인.
2. 연결·token 만료·quota·cost budget 확인.
3. 승인된 수집 범위와 보존정책 확인. 수집 기본 OFF, 사용자가 ON한 뒤만 주기 실행.
4. 배포 결과 remote ID/visibility/permalink를 저장하고 실제 성공과 수동 기록을 구분.
5. 원고·assets·DB backup을 독립적으로 확인.
6. 발행한 글의 질문/피드백은 사용자가 넣거나 허용된 읽기 API로 수집; DM/댓글 자동응답은 범위 밖.

## 장애별 처리
| 상황 | 처리 |
| --- | --- |
| 서버/worker 종료 | 예약은 DB에 남김. 복구 뒤 오래 지난 예약을 자동 공개하지 않고 확인 요청 |
| API 응답 유실 | RECONCILING → UNKNOWN, 기존 결과 확인 전 신규 submit 금지 |
| 토큰 만료/해제 | 계정 BLOCKED, 사용자 재연결 후 승인 hash·계정 ID 재검사 |
| 파일 누락/변조 | checksum 불일치로 배포 차단, 재업로드 후 재승인 |
| 모델/API 비용 초과 | 작성 화면 유지, live 생성 일시 중지, 수동 경로 제공 |
| 서비스/API 미지원 지역 | 해당 live provider를 사용하지 않고 지원되는 적법한 대안·수동 경로 검토; 우회 설계 금지 |
| Notion/Drive 권한 부족 | 해당 source만 보류, 새 메모 작성은 계속 |
| 플랫폼 기능 변경 | capability disable, 해당 채널은 export fallback |

## 백업/보존 초안 [실험 가정]
운영 전 사용자와 주기·기간·저장 위치를 확정. 초기 후보는 일별 DB+asset manifest, 변경 asset 복사, 주별 별도 환경 복원 샘플. credentials는 일반 export에서 제외.
실제 복원 결과 없이는 “백업으로 안전”이라고 표시하지 않는다. DB migration은 forward/rollback 또는 restore 경로를 기록한다.
키 분실·서비스 탈퇴 때 콘텐츠 export가 가능해야 한다. 앱 삭제가 SNS 원격 게시물 삭제를 의미하지 않음.

