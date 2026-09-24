import { assertPublishAllowed, type AppConfig } from '@cs/domain';

export interface PublisherCapabilities {
  text: boolean;
  image: boolean;
  video: boolean;
  schedule: boolean;
}

export interface PublishRequest {
  payloadHash: string;
  body: string;
  approvalId?: string;
}

/**
 * 게시 결과. MOCK/DISABLED 결과는 실제 발행 실적이 아니며 저장 대상이 될 수 없다.
 * (M3 publications 테이블은 VerifiedPublicationResult 만 받도록 설계한다.)
 */
export type PublishResult =
  | { kind: 'DISABLED'; platform: string; reason: string }
  | { kind: 'MOCK'; platform: string; mockId: string }
  | { kind: 'PUBLISHED'; platform: string; externalId: string; permalink?: string; verified: boolean }
  | { kind: 'UNKNOWN'; platform: string; reason: string };

export type VerifiedPublicationResult = Extract<PublishResult, { kind: 'PUBLISHED' }> & { verified: true };

/** 실제 발행 실적으로 저장 가능한 결과인지 판별하는 유일한 관문. */
export function isStorablePublication(r: PublishResult): r is VerifiedPublicationResult {
  return r.kind === 'PUBLISHED' && r.verified === true;
}

/** 저장 직전 호출. MOCK/DISABLED/UNKNOWN/미검증 결과는 예외로 거부한다. */
export function toStorablePublication(r: PublishResult): VerifiedPublicationResult {
  if (!isStorablePublication(r)) {
    throw new Error(`실제 발행 실적으로 저장할 수 없는 결과입니다(kind=${r.kind})`);
  }
  return r;
}

export interface Publisher {
  readonly platform: string;
  readonly capabilities: PublisherCapabilities;
  publish(request: PublishRequest): Promise<PublishResult>;
}

/** M0 유일한 publisher. 서버 가드를 거치므로 항상 예외(PublishDisabled/ApprovalRequired)로 끝난다. */
export class DisabledPublisher implements Publisher {
  readonly capabilities: PublisherCapabilities = { text: false, image: false, video: false, schedule: false };
  constructor(
    private readonly config: AppConfig,
    readonly platform: string = 'none',
  ) {}

  async publish(request: PublishRequest): Promise<PublishResult> {
    assertPublishAllowed(this.config, {
      platform: this.platform,
      payloadHash: request.payloadHash,
      approvalId: request.approvalId,
    });
  }
}
