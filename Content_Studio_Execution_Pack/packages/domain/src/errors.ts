/** 외부 효과를 막는 가드의 오류. 모두 "기본 거부(fail closed)"를 표현한다. */
export class GuardError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class PublishDisabledError extends GuardError {
  constructor() {
    super('PUBLISH_DISABLED', '게시가 비활성화되어 있습니다(PUBLISH_MODE=disabled). 외부 게시를 수행하지 않습니다.');
  }
}

export class ApprovalRequiredError extends GuardError {
  constructor() {
    super(
      'APPROVAL_REQUIRED',
      '서버에서 검증된 승인이 없어 게시할 수 없습니다. 승인 기능은 M3에서 구현됩니다.',
    );
  }
}

export class CollectorDisabledError extends GuardError {
  constructor() {
    super('COLLECTOR_DISABLED', '수집이 비활성화되어 있습니다(COLLECTOR_MODE=disabled). 외부 자료를 가져오지 않습니다.');
  }
}

export class LiveLlmNotAllowedError extends GuardError {
  constructor(reason: string) {
    super('LIVE_LLM_NOT_ALLOWED', `실제 AI 호출이 허용되지 않습니다: ${reason}`);
  }
}

export class LiveProviderNotConfiguredError extends GuardError {
  /** T07: 빠진 전제 조건 이름(값 없음). */
  readonly missing: string[];
  constructor(missing: string[] = []) {
    super(
      'LIVE_PROVIDER_NOT_CONFIGURED',
      `실제 AI 공급자가 구현·승인되어 있지 않습니다. LLM_MODE=mock 으로 실행하세요.${missing.length ? ` (준비 안 됨: ${missing.join(', ')})` : ''}`,
    );
    this.missing = missing;
  }
}

/**
 * 요청 처리 오류(T02). web 의 apiHandler 가 kind → HTTP 상태로 변환한다.
 * message 는 사용자에게 보여도 되는 한국어 문장만 넣는다(입력값·환경변수 값·경로 금지).
 */
export type AppErrorKind =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'csrf'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'not_implemented'
  | 'service_unavailable'
  /** T06: AI(모의 포함) 호출 실패 → 502 */
  | 'llm_failed'
  /** T07: AI 예산 상한 초과 → 429 */
  | 'budget_exceeded';

export class AppError extends Error {
  readonly kind: AppErrorKind;
  readonly code: string;
  /**
   * 응답 본문에 함께 내보낼 추가 필드(T03: 409 충돌의 current/yours).
   * 사용자 본인의 데이터만 넣는다. 다른 owner 의 데이터·비밀·경로는 넣지 않는다.
   */
  readonly extra: Record<string, unknown> | undefined;
  constructor(kind: AppErrorKind, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.kind = kind;
    this.code = code;
    this.extra = extra;
  }
}

export class BadRequestError extends AppError {
  constructor(message = '요청 형식이 올바르지 않습니다') {
    super('bad_request', 'bad_request', message);
  }
}

export class UnauthorizedError extends AppError {
  constructor() {
    super('unauthorized', 'unauthorized', '로그인이 필요합니다');
  }
}

/** 로그인 거부. 어떤 식별자가 허용되는지 드러내지 않는 일반 문구만 쓴다. */
export class LoginDeniedError extends AppError {
  constructor() {
    super('unauthorized', 'login_denied', '로그인할 수 없습니다. 입력한 정보를 확인하세요.');
  }
}

export class CsrfError extends AppError {
  constructor() {
    super('csrf', 'csrf', '요청 출처를 확인할 수 없어 거부했습니다');
  }
}

export class DevLoginNotAllowedError extends AppError {
  constructor() {
    super(
      'forbidden',
      'dev_login_not_allowed',
      '개발용 로그인(AUTH_MODE=dev)은 APP_BASE_URL 이 localhost 또는 127.0.0.1 일 때만 허용됩니다',
    );
  }
}

export class OidcNotConfiguredError extends AppError {
  constructor() {
    super('service_unavailable', 'oidc_not_configured', '운영 인증 공급자는 아직 설정되지 않았습니다(T13)');
  }
}

export class NotFoundError extends AppError {
  constructor(message = '찾을 수 없습니다') {
    super('not_found', 'not_found', message);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = '파일이 너무 큽니다. 최대 10MB 까지 올릴 수 있습니다.') {
    super('payload_too_large', 'payload_too_large', message);
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(
    message = '지원하지 않는 파일 형식입니다. PNG·JPEG·WebP 이미지, PDF, 텍스트(UTF-8) 파일만 올릴 수 있습니다.',
  ) {
    super('unsupported_media_type', 'unsupported_media_type', message);
  }
}

export class InvalidStorageKeyError extends AppError {
  constructor() {
    super('bad_request', 'invalid_storage_key', '허용되지 않는 파일 저장 키입니다');
  }
}

export class ObjectStorageNotImplementedError extends AppError {
  constructor() {
    super(
      'not_implemented',
      'object_storage_not_implemented',
      'STORAGE_DRIVER=object 는 아직 구현되지 않았습니다. 현재는 local 만 지원합니다.',
    );
  }
}

// ---- T03: 수집(captures) ----

/** http(s) 가 아니거나 해석할 수 없는 URL. */
export class InvalidUrlError extends AppError {
  constructor(message = 'http:// 또는 https:// 로 시작하는 올바른 URL 을 입력하세요') {
    super('bad_request', 'invalid_url', message);
  }
}

/** 내부망·로컬·메타데이터 주소(A05). 추출(fetch) 전에 거부한다. 저장된 capture 는 그대로 둔다. */
export class UrlNotAllowedError extends AppError {
  constructor() {
    super('bad_request', 'url_not_allowed', '내부망·로컬 주소는 추출할 수 없습니다');
  }
}

/** 원문(raw_text)은 저장 후 바꿀 수 없다. 메모·제목·위험 표시만 수정한다. */
export class RawTextImmutableError extends AppError {
  constructor() {
    super('bad_request', 'raw_text_immutable', '원문은 수정할 수 없습니다. 메모·제목·위험 표시만 수정할 수 있습니다.');
  }
}

/** 오래된 revision 으로 수정(A02). current(서버 값)와 yours(제출 값)를 함께 돌려줘 입력을 잃지 않게 한다. */
export class ConflictError extends AppError {
  constructor(extra: { current: Record<string, unknown>; yours?: Record<string, unknown> }) {
    super('conflict', 'conflict', '다른 곳에서 먼저 수정되었습니다. 현재 내용과 비교한 뒤 다시 저장하세요.', extra);
  }
}

/** COLLECTOR_MODE=disabled 에서의 추출 요청. 외부 fetch 를 하지 않는다. */
export class CollectorNotEnabledError extends AppError {
  constructor() {
    super('forbidden', 'collector_disabled', '수집 기능이 비활성 상태입니다(M5에서 활성화)');
  }
}

/** COLLECTOR_MODE=enabled 여도 실제 수집기는 아직 없다(T19). 외부 fetch 를 하지 않는다. */
export class CollectorNotImplementedError extends AppError {
  constructor() {
    super('not_implemented', 'collector_not_implemented', '실제 수집기는 아직 구현되지 않았습니다(T19). 외부 자료를 가져오지 않았습니다.');
  }
}
