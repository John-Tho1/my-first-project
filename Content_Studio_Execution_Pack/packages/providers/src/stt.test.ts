import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, LiveSttNotConfiguredError, MOCK_TRANSCRIPT_WARNING } from '@cs/domain';
import { LocalStorageAdapter } from './storage';
import { LiveTranscriber, MockTranscriber, MockTranscriberFailure } from './stt';

const INPUT = { assetId: '00000000-0000-4000-8000-000000000001', checksum: 'a'.repeat(64), mime: 'audio/mpeg', audioSeconds: 90 };

afterEach(() => vi.restoreAllMocks());

describe('MockTranscriber(T08)', () => {
  it('결정적: 같은 checksum·길이 → 같은 결과, 다른 checksum → 다른 결과', async () => {
    const t = new MockTranscriber();
    const a = await t.transcribe(INPUT);
    const b = await new MockTranscriber().transcribe(INPUT);
    expect(a).toEqual(b);
    const c = await t.transcribe({ ...INPUT, checksum: 'b'.repeat(64) });
    expect(c.text).not.toBe(a.text);
  });

  it('구간은 0 부터 길이까지 이어지고, 모든 문장에 모의 표시와 경고가 있다', async () => {
    const r = await new MockTranscriber().transcribe(INPUT);
    expect(r.segments.length).toBeGreaterThanOrEqual(2);
    expect(r.segments[0]!.start_ms).toBe(0);
    expect(r.segments.at(-1)!.end_ms).toBe(90_000);
    for (let i = 1; i < r.segments.length; i++) expect(r.segments[i]!.start_ms).toBe(r.segments[i - 1]!.end_ms);
    for (const s of r.segments) expect(s.text).toMatch(/^\[모의 전사 \d\] /);
    expect(r.text).toBe(r.segments.map((s) => s.text).join('\n'));
    expect(r.warnings).toEqual([MOCK_TRANSCRIPT_WARNING]);
    expect(r.audioSeconds).toBe(90);
  });

  it('실패 주입', async () => {
    await expect(new MockTranscriber({ fail: true }).transcribe(INPUT)).rejects.toThrow(MockTranscriberFailure);
  });

  it('네트워크를 쓰지 않는다', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await new MockTranscriber().transcribe(INPUT);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('LiveTranscriber(T08 경계)', () => {
  it('승인 기록·공급자·모델·가격이 모두 있어도 거부하고 HTTP 호출이 없다', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const config = loadConfig({
      STT_MODE: 'live',
      STT_PROVIDER: 'p',
      STT_MODEL: 'm',
      STT_PRICE_PER_MINUTE: '0.01',
      LLM_BUDGET_MONTHLY_LIMIT: '1',
      STT_LIVE_APPROVAL_REF: 'D99',
    });
    const t = new LiveTranscriber(config);
    expect(() => t.assertReady()).toThrow(LiveSttNotConfiguredError);
    await expect(t.transcribe(INPUT)).rejects.toThrow(LiveSttNotConfiguredError);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('LocalStorageAdapter.putFile·openStream(T08)', () => {
  it('검증된 파일을 key 로 옮기고(원본 사라짐) 스트림으로 읽는다', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cs-stt-store-'));
    try {
      const s = new LocalStorageAdapter(path.join(dir, 'root'));
      const src = path.join(dir, 'root', 'src.part');
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);
      await s.put(`assets/${INPUT.assetId}/${INPUT.assetId}`, new Uint8Array([0])); // 루트 만들기
      writeFileSync(src, bytes);
      const key = `assets/${INPUT.assetId}/00000000-0000-4000-8000-000000000002`;
      await s.putFile(key, src);
      expect(await s.exists(key)).toBe(true);
      const opened = await s.openStream(key);
      expect(opened!.bytes).toBe(5);
      const got = new Uint8Array(await new Response(opened!.stream).arrayBuffer());
      expect([...got]).toEqual([1, 2, 3, 4, 5]);
      expect(await s.openStream(`assets/${INPUT.assetId}/00000000-0000-4000-8000-000000000003`)).toBeNull();
      await expect(s.putFile('../escape', src)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
