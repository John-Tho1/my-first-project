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
