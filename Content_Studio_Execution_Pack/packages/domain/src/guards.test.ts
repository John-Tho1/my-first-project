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
import { LivePublishNotReadyError } from './live-publish';

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

describe('assertExecutionAllowed — LIVE-P1(D38 1단계) 실제 Threads 게이트(하나라도 없으면 거부)', () => {
  const FULL = { PUBLISH_MODE: 'enabled', PUBLISH_LIVE_APPROVAL_REF: 'D38-2', PUBLISH_LIVE_MAX_POSTS: '1' };
  const live = { accountKind: 'live' as const, payloadHash: H, approval, platform: 'threads' };
  it('모두 있으면 LIVE', () => {
    expect(assertExecutionAllowed(loadConfig(FULL), live)).toEqual({ mode: 'LIVE' });
  });
  it('PUBLISH_MODE disabled → PublishDisabledError(나머지가 다 있어도)', () => {
    expect(() => assertExecutionAllowed(loadConfig({ ...FULL, PUBLISH_MODE: 'disabled' }), live)).toThrow(PublishDisabledError);
  });
  it('승인 없음·철회·hash 불일치 → ApprovalRequiredError', () => {
    const c = loadConfig(FULL);
    expect(() => assertExecutionAllowed(c, { ...live, approval: null })).toThrow(ApprovalRequiredError);
    expect(() => assertExecutionAllowed(c, { ...live, approval: { ...approval, revokedAt: new Date() } })).toThrow(ApprovalRequiredError);
    expect(() => assertExecutionAllowed(c, { ...live, approval: { ...approval, payloadHash: 'c'.repeat(64) } })).toThrow(ApprovalRequiredError);
  });
  it('승인 기록·게시 수 상한이 빠지면 LivePublishNotReadyError(빠진 이름만)', () => {
    for (const [k, name] of [
      ['PUBLISH_LIVE_APPROVAL_REF', 'PUBLISH_LIVE_APPROVAL_REF'],
      ['PUBLISH_LIVE_MAX_POSTS', 'PUBLISH_LIVE_MAX_POSTS'],
    ] as const) {
      const c = loadConfig({ ...FULL, [k]: '' });
      expect(() => assertExecutionAllowed(c, live)).toThrow(LivePublishNotReadyError);
      try {
        assertExecutionAllowed(c, live);
      } catch (e) {
        expect((e as LivePublishNotReadyError).missing).toEqual([name]);
        expect((e as Error).message).not.toContain('D38-2');
      }
    }
  });
  it('Threads 밖 플랫폼(YouTube·Instagram·블로그)·플랫폼 없음 → LiveChannelNotConfiguredError(조건이 다 있어도)', () => {
    const c = loadConfig(FULL);
    for (const platform of ['youtube', 'instagram', 'blog', undefined]) {
      expect(() => assertExecutionAllowed(c, { ...live, platform })).toThrow(LiveChannelNotConfiguredError);
    }
  });
  it('모의 계정은 실제 게시 설정과 관계없이 MOCK', () => {
    expect(assertExecutionAllowed(loadConfig(FULL), { ...live, accountKind: 'mock' })).toEqual({ mode: 'MOCK' });
  });
  it('외부 게시 경로(assertPublishAllowed)는 조건이 다 있어도 서버 승인 객체가 없어 거부', () => {
    expect(() => assertPublishAllowed(loadConfig(FULL), { platform: 'threads', approvalId: 'fake', payloadHash: H })).toThrow(ApprovalRequiredError);
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
