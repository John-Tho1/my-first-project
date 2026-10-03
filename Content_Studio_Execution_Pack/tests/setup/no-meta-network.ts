/**
 * LIVE-T1(D31 1단계 — 실제 호출 0): 모든 시험(unit·integration)의 setupFiles.
 * globalThis.fetch 를 감싸 Threads·Meta 호스트(*.threads.com · *.threads.net · *.facebook.com · *.instagram.com)로 가는 요청을 **보내기 전에** 거부하고
 * 시도 횟수를 센다. 파일이 끝날 때(afterAll) 거부된 시도가 하나라도 있으면 그 시험 파일을 실패시킨다 — 시험은 주입한 fixture fetch
 * (또는 vi.stubGlobal('fetch', fixture))로만 공급자를 부른다. 다른 호스트는 원래 fetch 그대로(이 저장소 시험은 외부 호출을 하지 않는다).
 * 오류 메시지·기록에는 호스트 이름만 남긴다(질의 문자열의 시크릿·토큰 없음).
 */
import { afterAll } from 'vitest';

const BLOCKED = /(^|\.)(threads\.com|threads\.net|facebook\.com|instagram\.com|fbcdn\.net)$/i;

interface GuardState {
  attempts: string[];
  original: typeof fetch;
}

const g = globalThis as typeof globalThis & { __csMetaNetworkGuard?: GuardState };

export function blockedMetaHost(input: unknown): string | null {
  let raw: string;
  if (typeof input === 'string') raw = input;
  else if (input instanceof URL) raw = input.href;
  else if (input && typeof input === 'object' && 'url' in input && typeof (input as { url: unknown }).url === 'string') raw = (input as { url: string }).url;
  else return null;
  try {
    const host = new URL(raw).hostname;
    return BLOCKED.test(host) ? host : null;
  } catch {
    return null;
  }
}

if (!g.__csMetaNetworkGuard) {
  const original = globalThis.fetch;
  const state: GuardState = { attempts: [], original };
  g.__csMetaNetworkGuard = state;
  const guarded = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const host = blockedMetaHost(input);
    if (host) {
      state.attempts.push(host);
      return Promise.reject(new Error(`BLOCKED_EXTERNAL_NETWORK: 시험에서 실제 ${host} 요청 금지(LIVE-T1/D31 — fixture fetch 를 주입하세요)`));
    }
    return original(input, init);
  }) as typeof fetch;
  globalThis.fetch = guarded;
}

afterAll(() => {
  const state = g.__csMetaNetworkGuard!;
  const attempts = state.attempts.splice(0);
  if (attempts.length) {
    throw new Error(`BLOCKED_EXTERNAL_NETWORK: 이 시험 파일이 실제 Threads·Meta 호스트로 ${attempts.length}번 요청하려 했습니다(${[...new Set(attempts)].join(', ')})`);
  }
});
