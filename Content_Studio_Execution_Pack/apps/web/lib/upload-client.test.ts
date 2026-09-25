import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSequencer, pollDelay, resumeDecision, Sha256, startPolling } from './upload-client';

const nodeSha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const bytes = (n: number, seed = 1) => {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
};

describe('증분 Sha256(브라우저 파일 해시)', () => {
  it('node crypto 와 같다 — 경계 길이·여러 조각으로 나눠 넣어도', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 70_001]) {
      const b = bytes(n, n + 1);
      expect(new Sha256().update(b).hex(), String(n)).toBe(nodeSha(b));
      const h = new Sha256();
      for (let off = 0; off < n; off += 37) h.update(b.subarray(off, off + 37));
      expect(h.hex(), `${n} split`).toBe(nodeSha(b));
    }
    expect(new Sha256().update(new TextEncoder().encode('abc')).hex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('끝난 해시에는 더 넣을 수 없다', () => {
    const h = new Sha256();
    h.hex();
    expect(() => h.update(new Uint8Array(1))).toThrow();
    expect(() => h.hex()).toThrow();
  });
});

describe('resumeDecision(같은 파일일 때만 이어 올리기)', () => {
  const file = bytes(10_000, 7);
  const size = 4096;
  const chunkSha = async (i: number, cs: number) => nodeSha(file.subarray(i * cs, (i + 1) * cs));
  const server = (over: Partial<Parameters<typeof resumeDecision>[0]> = {}) => ({
    state: 'open',
    bytes: file.byteLength,
    chunk_size: size,
    checksum_expected: nodeSha(file),
    chunks: [
      { index: 0, sha256: nodeSha(file.subarray(0, size)) },
      { index: 1, sha256: nodeSha(file.subarray(size, 2 * size)) },
    ],
    ...over,
  });
  const local = { size: file.byteLength, sha256: nodeSha(file) };

  it('전체 sha256·크기·받은 조각이 모두 같으면 이어 올린다', async () => {
    expect(await resumeDecision(server(), local, chunkSha)).toEqual({ resume: true });
  });

  it('이름·크기가 같아도 내용이 다르면 새 세션', async () => {
    const other = bytes(10_000, 8);
    expect(await resumeDecision(server(), { size: other.byteLength, sha256: nodeSha(other) }, async (i, cs) => nodeSha(other.subarray(i * cs, (i + 1) * cs)))).toEqual({
      resume: false,
      reason: 'checksum_differs',
    });
  });

  it('신고 checksum 없음·open 아님·크기 다름·받은 조각이 다름 → 새 세션', async () => {
    expect(await resumeDecision(server({ checksum_expected: null }), local, chunkSha)).toEqual({ resume: false, reason: 'no_checksum' });
    expect(await resumeDecision(server({ state: 'expired' }), local, chunkSha)).toEqual({ resume: false, reason: 'not_open' });
    expect(await resumeDecision(server({ bytes: 9999 }), local, chunkSha)).toEqual({ resume: false, reason: 'size_differs' });
    const bad = server({ chunks: [{ index: 0, sha256: 'f'.repeat(64) }] });
    expect(await resumeDecision(bad, local, chunkSha)).toEqual({ resume: false, reason: 'chunk_differs' });
  });
});

describe('폴링 간격·루프(실패해도 계속)', () => {
  it('pollDelay: 진행 중 1.5초, 없음 10초, 실패 2→4→8→10초', () => {
    expect(pollDelay({ ok: true, active: true, failures: 0 })).toBe(1500);
    expect(pollDelay({ ok: true, active: false, failures: 0 })).toBe(10_000);
    expect([1, 2, 3, 4, 9].map((f) => pollDelay({ ok: false, active: false, failures: f }))).toEqual([2000, 4000, 8000, 10_000, 10_000]);
  });

  /** 수동 타이머 */
  function fakeTimers() {
    const q: Array<{ id: number; fn: () => void; ms: number }> = [];
    let next = 1;
    return {
      q,
      timers: {
        set: (fn: () => void, ms: number) => {
          const id = next++;
          q.push({ id, fn, ms });
          return id;
        },
        clear: (h: unknown) => {
          const i = q.findIndex((t) => t.id === h);
          if (i >= 0) q.splice(i, 1);
        },
      },
      async fire() {
        const t = q.shift();
        if (!t) throw new Error('예약 없음');
        t.fn();
        await new Promise((r) => setTimeout(r, 0));
        return t.ms;
      },
    };
  }

  it('실패 뒤에도 다음 조회를 예약하고(backoff), 성공하면 간격이 돌아오며, stop 뒤에는 예약하지 않는다', async () => {
    const t = fakeTimers();
    const results: Array<'fail' | 'active' | 'idle'> = ['fail', 'fail', 'active', 'idle'];
    let calls = 0;
    const p = startPolling(
      async () => {
        const r = results[calls++] ?? 'idle';
        if (r === 'fail') throw new Error('network');
        return { active: r === 'active' };
      },
      (r) => r,
      t.timers,
    );
    expect(await t.fire()).toBe(0); // 첫 조회(실패)
    expect(t.q.map((x) => x.ms)).toEqual([2000]);
    await t.fire(); // 두 번째 실패
    expect(t.q.map((x) => x.ms)).toEqual([4000]);
    await t.fire(); // 성공·진행 중
    expect(t.q.map((x) => x.ms)).toEqual([1500]);
    await t.fire(); // 성공·없음
    expect(t.q.map((x) => x.ms)).toEqual([10_000]);
    p.poke();
    expect(t.q.map((x) => x.ms)).toEqual([0]);
    p.stop();
    expect(t.q).toEqual([]);
    expect(calls).toBe(4);
  });

  it('FIX round 2: 순번 — 오래된 응답은 반영하지 않는다(늦게 도착한 이전 요청)', () => {
    const s = createSequencer();
    const a = s.next();
    const b = s.next();
    expect(s.accept(b)).toBe(true); // 새 요청이 먼저 도착
    expect(s.accept(a)).toBe(false); // 이전 요청은 버림
    expect(s.accept(b)).toBe(false); // 같은 응답 두 번도 버림
    expect(s.accept(s.next())).toBe(true);
  });

  it('FIX round 2: 조회 중 poke 는 두 번째 조회를 겹쳐 시작하지 않고, 끝난 직후 한 번으로 합친다', async () => {
    const t = fakeTimers();
    const pending: Array<(v: { active: boolean }) => void> = [];
    let started = 0;
    const applied: number[] = [];
    const p = startPolling(
      () =>
        new Promise<{ active: boolean }>((resolve) => {
          started++;
          pending.push(resolve);
        }),
      (r) => {
        applied.push(started);
        return r;
      },
      t.timers,
    );
    const first = t.q.shift()!; // 첫 조회 시작(응답 대기)
    first.fn();
    expect(started).toBe(1);
    p.poke();
    p.poke();
    expect(t.q).toEqual([]); // 조회 중에는 새 조회를 예약하지 않음
    expect(started).toBe(1);
    pending.shift()!({ active: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(applied).toEqual([1]);
    expect(t.q.map((x) => x.ms)).toEqual([0]); // 끝난 직후 한 번(합쳐짐), 10초 대기가 아님
    await t.fire();
    expect(started).toBe(2);
    pending.shift()!({ active: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.q.map((x) => x.ms)).toEqual([1500]);
    p.stop();
  });
});
