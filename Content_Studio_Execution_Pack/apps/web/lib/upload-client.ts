/**
 * /record 브라우저 코드가 쓰는 순수 함수(T08 FIX round 1). DOM·네트워크 없음 — 단위 테스트 대상.
 * - Sha256: 조각씩 넣는 증분 SHA-256(WebCrypto 는 스트림 해시가 없어 큰 파일 전체를 메모리에 올려야 하므로 직접 구현).
 * - resumeDecision: 저장해 둔 세션을 이어 올려도 되는지(같은 파일인지) 판단 — 전체 sha256·크기·받은 조각별 sha256 비교.
 * - pollDelay: 전사 목록 폴링 간격(성공·진행 중 1.5초, 성공·대기 없음 10초, 실패 2초→4초→8초→10초).
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** 증분 SHA-256(FIPS 180-4). update 를 여러 번 부른 뒤 hex() 한 번. */
export class Sha256 {
  private h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private readonly block = new Uint8Array(64);
  private blockLen = 0;
  private total = 0;
  private readonly w = new Uint32Array(64);
  private done = false;

  update(data: Uint8Array): this {
    if (this.done) throw new Error('이미 끝난 해시입니다');
    this.total += data.byteLength;
    this.absorb(data);
    return this;
  }

  hex(): string {
    if (this.done) throw new Error('이미 끝난 해시입니다');
    this.done = true;
    const bitLen = this.total * 8;
    const pad = new Uint8Array(((this.blockLen + 9 + 63) >> 6) * 64 - this.blockLen);
    pad[0] = 0x80;
    const view = new DataView(pad.buffer);
    view.setUint32(pad.length - 8, Math.floor(bitLen / 0x100000000));
    view.setUint32(pad.length - 4, bitLen >>> 0);
    this.absorb(pad);
    return Array.from(this.h, (x) => x.toString(16).padStart(8, '0')).join('');
  }

  private absorb(data: Uint8Array): void {
    let i = 0;
    if (this.blockLen > 0) {
      const take = Math.min(64 - this.blockLen, data.byteLength);
      this.block.set(data.subarray(0, take), this.blockLen);
      this.blockLen += take;
      i = take;
      if (this.blockLen === 64) {
        this.compress(this.block, 0);
        this.blockLen = 0;
      }
    }
    for (; i + 64 <= data.byteLength; i += 64) this.compress(data, i);
    if (i < data.byteLength) {
      this.block.set(data.subarray(i), 0);
      this.blockLen = data.byteLength - i;
    }
  }

  private compress(buf: Uint8Array, off: number): void {
    const w = this.w;
    for (let t = 0; t < 16; t++) {
      const j = off + t * 4;
      w[t] = ((buf[j]! << 24) | (buf[j + 1]! << 16) | (buf[j + 2]! << 8) | buf[j + 3]!) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15]!;
      const b = w[t - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.h as unknown as number[];
    for (let t = 0; t < 64; t++) {
      const S1 = ((e! >>> 6) | (e! << 26)) ^ ((e! >>> 11) | (e! << 21)) ^ ((e! >>> 25) | (e! << 7));
      const ch = (e! & f!) ^ (~e! & g!);
      const t1 = (h! + S1 + ch + K[t]! + w[t]!) >>> 0;
      const S0 = ((a! >>> 2) | (a! << 30)) ^ ((a! >>> 13) | (a! << 19)) ^ ((a! >>> 22) | (a! << 10));
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const H = this.h;
    H[0] = (H[0]! + a!) >>> 0;
    H[1] = (H[1]! + b!) >>> 0;
    H[2] = (H[2]! + c!) >>> 0;
    H[3] = (H[3]! + d!) >>> 0;
    H[4] = (H[4]! + e!) >>> 0;
    H[5] = (H[5]! + f!) >>> 0;
    H[6] = (H[6]! + g!) >>> 0;
    H[7] = (H[7]! + h!) >>> 0;
  }
}

export interface ServerSessionLike {
  state: string;
  bytes: number;
  chunk_size: number;
  checksum_expected: string | null;
  resumable?: boolean;
  chunks: ReadonlyArray<{ index: number; sha256: string }>;
}

export type ResumeDecision = { resume: true } | { resume: false; reason: 'not_open' | 'no_checksum' | 'checksum_differs' | 'size_differs' | 'chunk_differs' };

/**
 * 저장해 둔 세션을 이어 올릴지. 같은 파일이어야 한다: 세션이 open 이고, 서버가 신고받은 전체 sha256 이 있고 이 파일의 sha256 과 같으며,
 * 크기가 같고, 이미 받은 조각마다 이 파일의 같은 범위를 다시 해시한 값이 서버의 조각 sha256 과 같아야 한다. 하나라도 다르면 새 세션.
 * localChunkSha(index, chunkSize) 는 이 파일의 해당 범위 sha256(hex)을 돌려준다(브라우저: WebCrypto digest).
 */
export async function resumeDecision(
  server: ServerSessionLike,
  local: { size: number; sha256: string },
  localChunkSha: (index: number, chunkSize: number) => Promise<string>,
): Promise<ResumeDecision> {
  if (server.state !== 'open') return { resume: false, reason: 'not_open' };
  if (!server.checksum_expected) return { resume: false, reason: 'no_checksum' };
  if (server.checksum_expected.toLowerCase() !== local.sha256.toLowerCase()) return { resume: false, reason: 'checksum_differs' };
  if (server.bytes !== local.size) return { resume: false, reason: 'size_differs' };
  for (const c of server.chunks) {
    if ((await localChunkSha(c.index, server.chunk_size)).toLowerCase() !== c.sha256.toLowerCase()) return { resume: false, reason: 'chunk_differs' };
  }
  return { resume: true };
}

export const POLL_ACTIVE_MS = 1500;
export const POLL_IDLE_MS = 10_000;
export const POLL_ERROR_MIN_MS = 2000;
export const POLL_ERROR_MAX_MS = 10_000;

/** 다음 조회까지 기다릴 시간. 실패해도 항상 다음 조회를 예약한다(연속 실패 수에 따라 2초→4초→8초→10초). */
export function pollDelay(last: { ok: boolean; active: boolean; failures: number }): number {
  if (!last.ok) return Math.min(POLL_ERROR_MAX_MS, POLL_ERROR_MIN_MS * 2 ** Math.max(0, last.failures - 1));
  return last.active ? POLL_ACTIVE_MS : POLL_IDLE_MS;
}

/**
 * 폴링 루프: tick 결과와 관계없이 다음 조회를 예약하고, stop() 이면 멈춘다. setTimer/clearTimer 를 넣어 테스트한다.
 * tick 은 { active } 를 돌려주거나 throw(실패).
 */
export function startPolling(
  tick: () => Promise<{ active: boolean }>,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
): { stop: () => void; poke: () => void } {
  let stopped = false;
  let handle: unknown = null;
  let failures = 0;
  const run = async () => {
    handle = null;
    if (stopped) return;
    let delay: number;
    try {
      const r = await tick();
      failures = 0;
      delay = pollDelay({ ok: true, active: r.active, failures: 0 });
    } catch {
      failures++;
      delay = pollDelay({ ok: false, active: false, failures });
    }
    if (!stopped && handle === null) handle = timers.set(() => void run(), delay);
  };
  handle = timers.set(() => void run(), 0);
  return {
    stop: () => {
      stopped = true;
      if (handle !== null) timers.clear(handle);
      handle = null;
    },
    /** 지금 바로 한 번 조회(업로드·취소 뒤). 예약된 조회는 이것으로 대체된다. */
    poke: () => {
      if (stopped) return;
      if (handle !== null) timers.clear(handle);
      handle = timers.set(() => void run(), 0);
    },
  };
}
