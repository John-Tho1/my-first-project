/**
 * 줄 단위 diff(T04 작성실 버전 비교·충돌 화면). 의존성 없음.
 * 공통 앞·뒤 줄을 먼저 떼어 내고, 남은 가운데 구간을 LCS(동적 계획법)로 비교한다.
 * 가운데 구간이 한쪽이라도 MAX_DIFF_LINES(5000)줄을 넘으면 LCS 를 하지 않고 "전부 삭제 + 전부 추가"로 보여 준다
 * (메모리 상한: 5000×5000 셀 × 2바이트 ≈ 50MB).
 */
export type DiffLine = { type: 'same' | 'add' | 'del'; text: string };

export const MAX_DIFF_LINES = 5000;

export function splitLines(s: string): string[] {
  if (s === '') return [];
  return s.replace(/\r\n?/gu, '\n').split('\n');
}

export function diffLines(a: string, b: string): DiffLine[] {
  const x = splitLines(a);
  const y = splitLines(b);
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;

  const out: DiffLine[] = [];
  for (let i = 0; i < pre; i++) out.push({ type: 'same', text: x[i]! });
  const xs = x.slice(pre, x.length - suf);
  const ys = y.slice(pre, y.length - suf);
  out.push(...diffMiddle(xs, ys));
  for (let i = x.length - suf; i < x.length; i++) out.push({ type: 'same', text: x[i]! });
  return out;
}

function diffMiddle(x: string[], y: string[]): DiffLine[] {
  const n = x.length;
  const m = y.length;
  if (n === 0) return y.map((text) => ({ type: 'add', text }));
  if (m === 0) return x.map((text) => ({ type: 'del', text }));
  if (n > MAX_DIFF_LINES || m > MAX_DIFF_LINES) {
    return [...x.map((text): DiffLine => ({ type: 'del', text })), ...y.map((text): DiffLine => ({ type: 'add', text }))];
  }
  // L[i][j] = x[i..], y[j..] 의 LCS 길이. 값은 ≤ 5000 이라 Uint16 로 충분하다.
  const w = m + 1;
  const L = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * w + j] = x[i] === y[j] ? L[(i + 1) * w + j + 1]! + 1 : Math.max(L[(i + 1) * w + j]!, L[i * w + j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ type: 'same', text: x[i]! });
      i++;
      j++;
    } else if (L[(i + 1) * w + j]! >= L[i * w + j + 1]!) {
      out.push({ type: 'del', text: x[i]! });
      i++;
    } else {
      out.push({ type: 'add', text: y[j]! });
      j++;
    }
  }
  while (i < n) out.push({ type: 'del', text: x[i++]! });
  while (j < m) out.push({ type: 'add', text: y[j++]! });
  return out;
}

export function diffStats(d: readonly DiffLine[]): { added: number; removed: number; same: number } {
  let added = 0;
  let removed = 0;
  let same = 0;
  for (const l of d) {
    if (l.type === 'add') added++;
    else if (l.type === 'del') removed++;
    else same++;
  }
  return { added, removed, same };
}
