import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import {
  ApprovalRequiredError,
  CollectorDisabledError,
  LiveChannelNotConfiguredError,
  LiveLlmNotAllowedError,
  PublishDisabledError,
} from './errors';
import { assertCollectorAllowed, assertExecutionAllowed, assertLiveLlmAllowed, assertPublishAllowed } from './guards';

const H = 'b'.repeat(64);
const approval = { id: 'server-approval', payloadHash: H, revokedAt: null };

describe('assertExecutionAllowed (T10, fail closed)', () => {
  it('mock 계정: PUBLISH_MODE 와 무관하게 MOCK', () => {
    expect(assertExecutionAllowed(loadConfig({}), { accountKind: 'mock', payloadHash: H, approval })).toEqual({ mode: 'MOCK' });
    expect(assertExecutionAllowed(loadConfig({ PUBLISH_MODE: 'enabled' }), { accountKind: 'mock', payloadHash: H, approval })).toEqual({ mode: 'MOCK' });
  });
  it('live + disabled → PublishDisabledError(승인 객체가 있어도)', () => {
    expect(() => assertExecutionAllowed(loadConfig({}), { accountKind: 'live', payloadHash: H, approval })).toThrow(PublishDisabledError);
  });
  it('live + enabled + 승인 없음·철회·hash 불일치 → ApprovalRequiredError', () => {
    const c = loadConfig({ PUBLISH_MODE: 'enabled' });
    expect(() => assertExecutionAllowed(c, { accountKind: 'live', payloadHash: H, approval: null })).toThrow(ApprovalRequiredError);
    expect(() => assertExecutionAllowed(c, { accountKind: 'live', payloadHash: H, approval: { ...approval, revokedAt: new Date() } })).toThrow(ApprovalRequiredError);
    expect(() => assertExecutionAllowed(c, { accountKind: 'live', payloadHash: H, approval: { ...approval, payloadHash: 'c'.repeat(64) } })).toThrow(ApprovalRequiredError);
  });
  it('live + enabled + 유효한 서버 승인이어도 M3 에는 어댑터가 없어 LiveChannelNotConfiguredError', () => {
    const c = loadConfig({ PUBLISH_MODE: 'enabled' });
    expect(() => assertExecutionAllowed(c, { accountKind: 'live', payloadHash: H, approval })).toThrow(LiveChannelNotConfiguredError);
  });
});

describe('assertPublishAllowed (fail closed)', () => {
  it('기본 설정에서는 PublishDisabledError', () => {
    expect(() => assertPublishAllowed(loadConfig({}), { platform: 'threads' })).toThrow(PublishDisabledError);
  });
  it('PUBLISH_MODE=enabled 여도 서버 승인이 없으므로 ApprovalRequiredError', () => {
    const c = loadConfig({ PUBLISH_MODE: 'enabled' });
    expect(() => assertPublishAllowed(c, { platform: 'threads' })).toThrow(ApprovalRequiredError);
  });
  it('클라이언트가 보낸 approvalId 는 승인으로 인정하지 않는다', () => {
    const c = loadConfig({ PUBLISH_MODE: 'enabled' });
    expect(() =>
      assertPublishAllowed(c, { platform: 'threads', approvalId: 'fake', payloadHash: 'abc' }),
    ).toThrow(ApprovalRequiredError);
  });
});

describe('assertCollectorAllowed', () => {
  it('기본 설정에서는 CollectorDisabledError', () => {
    expect(() => assertCollectorAllowed(loadConfig({}))).toThrow(CollectorDisabledError);
  });
  it('명시적으로 enabled 일 때만 통과', () => {
    expect(() => assertCollectorAllowed(loadConfig({ COLLECTOR_MODE: 'enabled' }))).not.toThrow();
  });
});

describe('assertLiveLlmAllowed', () => {
  it('mock 이면 거부', () => {
    expect(() => assertLiveLlmAllowed(loadConfig({}))).toThrow(LiveLlmNotAllowedError);
  });
  it('live 여도 provider/model 이 없으면 거부', () => {
    expect(() => assertLiveLlmAllowed(loadConfig({ LLM_MODE: 'live' }))).toThrow(LiveLlmNotAllowedError);
    expect(() => assertLiveLlmAllowed(loadConfig({ LLM_MODE: 'live', LLM_PROVIDER: 'x' }))).toThrow(
      LiveLlmNotAllowedError,
    );
  });
  it('live + provider + model 이면 통과', () => {
    expect(() =>
      assertLiveLlmAllowed(loadConfig({ LLM_MODE: 'live', LLM_PROVIDER: 'placeholder', LLM_MODEL: 'placeholder' })),
    ).not.toThrow();
  });
});
