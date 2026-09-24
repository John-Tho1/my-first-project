import { assertCollectorAllowed, type AppConfig } from '@cs/domain';

export interface CollectRequest {
  url: string;
}

export interface CollectResult {
  url: string;
  excerpt: string;
  rawHash: string;
}

export interface Collector {
  readonly name: string;
  collect(request: CollectRequest): Promise<CollectResult>;
}

/** M0 유일한 collector. 외부 fetch 를 하지 않고 항상 CollectorDisabledError 로 끝난다. */
export class DisabledCollector implements Collector {
  readonly name = 'disabled';
  constructor(private readonly config: AppConfig) {}

  async collect(request: CollectRequest): Promise<CollectResult> {
    void request;
    assertCollectorAllowed(this.config);
    // COLLECTOR_MODE=enabled 여도 M0 에는 실제 수집기가 없다. 기본 거부.
    throw new Error('M0에는 실제 수집기가 구현되어 있지 않습니다.');
  }
}
