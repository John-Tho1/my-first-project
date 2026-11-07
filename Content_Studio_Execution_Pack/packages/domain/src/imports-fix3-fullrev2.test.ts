/**
 * FIX3-FULLREV2(G26): Markdown 첫 제목 추출의 3제곱 백트래킹(ReDoS) 제거.
 * - 이전 정규식과 같은 결과(짧은 입력 전수·무작위 대조 — 짧은 입력에서는 이전 식도 빠르다)
 * - 적대 입력(제목 뒤 공백·탭 수천 개)에서 걸음 수·시간이 입력에 비례
 */
import { describe, expect, it } from 'vitest';
import { MARKDOWN_HEADING_SCAN_CHARS, markdownFirstHeading, parseImportFile } from './imports';

/** 고치기 전 식(대조용 — 짧은 입력에만 쓴다). */
function oldHeading(text: string): string | null {
  const m = /^\s{0,3}#\s+(.+?)\s*#*\s*$/m.exec(text);
  if (m && text.slice(0, m.index).trim() === '') return m[1]!.trim();
  return null;
}

describe('FIX3-FULLREV2(G26) — Markdown 첫 제목 선형 처리', () => {
  it('대표 입력은 이전 식과 같은 결과', () => {
    const cases = [
      '# 제목\n\n본문',
      '\n\n  # 제목 ##  \n본문',
      '    # 네 칸 들여쓰기',
      '#붙은제목',
      '# C#\n',
      '# ###',
      '#   ',
      '#\n\n제목 다음 줄\n',
      '\r\n# CRLF 제목\r\n본문',
      '본문 먼저\n# 제목',
      '#\t탭 제목\t#\t',
      '　# 전각 공백',
      '# 제목 다음',
      '',
      '   ',
    ];
    for (const c of cases) expect(markdownFirstHeading(c), JSON.stringify(c)).toBe(oldHeading(c));
  });

  it('짧은 입력 전수·무작위 대조(이전 식과 같음)', () => {
    const alphabet = [' ', '\t', '\n', '\r', '#', 'a', '　', ' '];
    // 길이 5 이하 전수
    const all = (len: number, prefix: string, out: string[]) => {
      if (len === 0) return void out.push(prefix);
      for (const ch of alphabet) all(len - 1, prefix + ch, out);
    };
    const inputs: string[] = [];
    for (let len = 0; len <= 5; len++) all(len, '', inputs);
    // 길이 6~14 무작위(고정 씨앗)
    let seed = 0x6a26;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let k = 0; k < 20000; k++) {
      const len = 6 + Math.floor(rnd() * 9);
      let s = '';
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      inputs.push(s);
    }
    for (const s of inputs) expect(markdownFirstHeading(s), JSON.stringify(s)).toBe(oldHeading(s));
  });

  const adversarial: Array<[string, (n: number) => string]> = [
    ['제목 뒤 공백 반복 + x', (n) => `# 제목${' '.repeat(n)}x`],
    ['제목 뒤 탭 반복 + x', (n) => `# 제목${'\t'.repeat(n)}x`],
    ['공백·# 섞어 반복', (n) => `# t${' #'.repeat(n / 2)} x`],
    ['# 뒤 공백만', (n) => `#${' '.repeat(n)}`],
  ];
  it.each(adversarial)('%s: 2KB→4KB 걸음 비율이 크기 비율 안, 4KB parseImportFile 시간이 짧다', (_l, make) => {
    const steps = (s: string) => {
      const st = { steps: 0 };
      markdownFirstHeading(s, st);
      return st.steps;
    };
    const a = make(2000);
    const b = make(3990);
    expect(b.length).toBeLessThanOrEqual(MARKDOWN_HEADING_SCAN_CHARS);
    const sa = steps(a);
    const sb = steps(b);
    expect(sa).toBeLessThanOrEqual(4 * a.length + 16);
    expect(sb).toBeLessThanOrEqual(4 * b.length + 16);
    expect(sb / sa).toBeLessThanOrEqual((b.length / a.length) * 1.125);
    // 보조: 실제 진입점 시간(이전 식은 3,990자에서 약 45초). 병렬 부하를 견디도록 느슨하게 — CPU 시간 3회 중 최소 < 200ms.
    const bytes = new TextEncoder().encode(b);
    let min = Infinity;
    for (let k = 0; k < 3; k++) {
      const c = process.cpuUsage();
      parseImportFile('drive_export', 'a.md', 'a.md', bytes);
      const d = process.cpuUsage(c);
      min = Math.min(min, (d.user + d.system) / 1000);
    }
    expect(min).toBeLessThan(200);
  });

  it('parseImportFile 이 선형 처리 결과를 제목으로 쓴다', () => {
    const md = new TextEncoder().encode(`\n# 가져온 제목 ##${' '.repeat(3000)}\n\n본문`);
    expect(parseImportFile('drive_export', 'a.md', 'a.md', md).title).toBe('가져온 제목');
  });
});
