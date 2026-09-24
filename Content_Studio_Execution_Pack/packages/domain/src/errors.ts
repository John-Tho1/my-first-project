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
  constructor() {
    super('LIVE_PROVIDER_NOT_CONFIGURED', 'M0에는 실제 AI 공급자가 구현되어 있지 않습니다. LLM_MODE=mock 으로 실행하세요.');
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
  | 'service_unavailable';

export class AppError extends Error {
  readonly kind: AppErrorKind;
  readonly code: string;
  constructor(kind: AppErrorKind, code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.kind = kind;
    this.code = code;
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
