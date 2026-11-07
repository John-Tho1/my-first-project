/**
 * LIVE-L1(D34 1단계 — 실제 Claude 호출 0): setupFiles 네트워크 가드(tests/setup/no-meta-network.ts)가 api.anthropic.com 을
 * 연결·DNS 조회 **전에** 막는지 확인한다. 가짜 fetch 를 주입하지 않은 실제 ClaudeLlmProvider 도 가드에서 멈춘다(실제로 나가는 바이트 0).
 * 의도한 시도이므로 마지막에 기록을 비운다(비우지 않으면 setupFiles 의 afterAll 이 이 파일을 실패시킨다).
 */
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { ClaudeLlmProvider, MockLlmProvider } from './index';

interface Guard {
  attempts: string[];
  via: string[];
}
const guard = () => (globalThis as typeof globalThis & { __csMetaNetworkGuard?: Guard }).__csMetaNetworkGuard!;
const BLOCKED = /BLOCKED_EXTERNAL_NETWORK/;
const syncMessage = (fn: () => unknown): string => {
  try {
    fn();
    return 'no throw';
  } catch (e) {
    return (e as Error).message;
  }
};

describe('Anthropic 호스트 차단(LIVE-L1)', () => {
  it('설치됨, 기록 초기화', () => {
    expect(guard()).toBeDefined();
    guard().attempts.length = 0;
    guard().via.length = 0;
  });

  it('fetch 주입 없는 실제 ClaudeLlmProvider → 가드의 fetch 에서 막힘(연결 실패로 매핑, 키·원문 없음)', async () => {
    const p = new ClaudeLlmProvider({ apiKey: 'sk-ant-FAKE-guard-test', model: 'claude-opus-5-5' });
    const e = await p
      .generate({ task: 'draft', inputVersion: 'v', text: 't', prompt: '가드 시험', maxOutputTokens: 1024 })
      .then(() => null, (x: unknown) => x as { code?: string; message?: string });
    expect(e?.code).toBe('llm_connection_failed');
    expect(e?.message).not.toContain('sk-ant');
    expect(guard().attempts).toEqual(['api.anthropic.com']);
    expect(guard().via).toEqual(['fetch']);
  });

  it('fetch 문자열·대문자·끝의 점, https.request, net.connect, dns.lookup 도 막힘', async () => {
    const before = guard().attempts.length;
    await expect(fetch('https://API.Anthropic.com./v1/messages', { method: 'POST' })).rejects.toThrow(BLOCKED);
    expect(syncMessage(() => https.request('https://api.anthropic.com/v1/messages'))).toMatch(BLOCKED);
    expect(syncMessage(() => net.connect(443, 'api.anthropic.com'))).toMatch(BLOCKED);
    expect(syncMessage(() => dns.lookup('api.anthropic.com', () => undefined))).toMatch(BLOCKED);
    await expect(dns.promises.resolve4('console.anthropic.com')).rejects.toThrow(BLOCKED);
    expect(guard().attempts.slice(before)).toEqual(['api.anthropic.com', 'api.anthropic.com', 'api.anthropic.com', 'api.anthropic.com', 'console.anthropic.com']);
  });

  it('비슷하지만 다른 호스트(notanthropic.com.example)는 막지 않는다 — 판정만', () => {
    const before = guard().attempts.length;
    const sock = net.connect({ host: '127.0.0.1', port: 9, servername: 'notanthropic.com.example' } as net.NetConnectOpts);
    sock.on('error', () => undefined);
    sock.destroy();
    expect(guard().attempts.length).toBe(before);
  });

  it('모의 provider 는 네트워크를 쓰지 않는다(가드 기록 변화 없음)', async () => {
    const before = guard().attempts.length;
    const out = await new MockLlmProvider().generate({ task: 'draft', inputVersion: 'v', text: '시장이 커지고 있다.', prompt: 'p', maxOutputTokens: 256 });
    expect(out.result_type).toBe('draft');
    expect(guard().attempts.length).toBe(before);
  });

  it('기록을 비운다(의도한 시도)', () => {
    expect(guard().attempts.length).toBe(6);
    guard().attempts.length = 0;
    guard().via.length = 0;
  });
});
