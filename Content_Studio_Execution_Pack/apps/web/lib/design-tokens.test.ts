/**
 * DESIGN-A(시스템 다크): app/globals.css 의 색 토큰을 읽어
 * (1) 사용자가 고른 견본 값(다크 기본 · Apple 라이트 변형)과 같은지,
 * (2) 본문 글자·태그 글자가 두 모드 모두 WCAG AA(4.5:1) 이상인지(틴트 배경은 실제로 놓이는 바탕 위에 합성해서 계산),
 * (3) 실제 게시(주황) · MOCK(회색 점선) · 경고 안내(주황 틴트)가 서로 다른 색 규칙인지 확인한다.
 * 화면 렌더가 아니라 CSS 소스 시험이다.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');

type Tokens = Record<string, string>;

function declarations(block: string): Tokens {
  const out: Tokens = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

const darkBlock = /^:root\s*\{([\s\S]*?)^\}/m.exec(css)?.[1];
const lightBlock = /@media \(prefers-color-scheme: light\)\s*\{\s*:root\s*\{([\s\S]*?)\}\s*\}/.exec(css)?.[1];
const DARK = declarations(darkBlock ?? '');
// 라이트는 다크 위에 덮어쓴다(같은 :root — 빠진 토큰은 다크 값을 이어받음)
const LIGHT: Tokens = { ...DARK, ...declarations(lightBlock ?? '') };

type RGBA = [number, number, number, number];

function resolve(t: Tokens, name: string, depth = 0): string {
  const v = t[name];
  if (v === undefined) throw new Error(`토큰 없음: ${name}`);
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(v);
  if (ref) {
    if (depth > 5) throw new Error(`순환 참조: ${name}`);
    return resolve(t, ref[1]!, depth + 1);
  }
  return v;
}

function color(t: Tokens, name: string): RGBA {
  const v = resolve(t, name).toLowerCase();
  const hex = /^#([0-9a-f]{6})$/.exec(v);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)).concat(1) as RGBA;
  const rgba = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(v);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4])];
  throw new Error(`색 아님: ${name} = ${v}`);
}

/** 반투명 색(fg)을 불투명 바탕(bg) 위에 합성 */
function over(fg: RGBA, bg: RGBA): RGBA {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
}

function luminance([r, g, b]: RGBA): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: RGBA, b: RGBA): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const hexOf = (c: RGBA) => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

describe('DESIGN-A 색 토큰 — 견본 값', () => {
  it('globals.css 에서 다크(:root)와 라이트(prefers-color-scheme: light) 블록을 찾았다', () => {
    expect(darkBlock).toBeTruthy();
    expect(lightBlock).toBeTruthy();
  });

  it('다크(기본): 검정 바탕 · #1c1c1e 패널 · #38383a 구분선 · 시스템 색', () => {
    const want: Record<string, string> = {
      '--bg': '#000000',
      '--card': '#1c1c1e',
      '--surface-2': '#2c2c2e',
      '--border': '#38383a',
      '--text': '#f5f5f7',
      '--muted': '#98989d',
      '--accent': '#0a84ff',
      '--success': '#30d158',
      '--warning': '#ff9f0a',
      '--danger': '#ff453a',
      '--purple': '#bf5af2',
      '--seg-track': '#1c1c1e',
      '--seg-active': '#3a3a3c',
    };
    for (const [k, v] of Object.entries(want)) expect({ k, v: hexOf(color(DARK, k)) }).toEqual({ k, v });
  });

  it('라이트: Apple 라이트 값', () => {
    const want: Record<string, string> = {
      '--bg': '#f2f2f7',
      '--card': '#ffffff',
      '--border': '#c6c6c8',
      '--accent': '#007aff',
      '--success': '#34c759',
      '--warning': '#ff9500',
      '--danger': '#ff3b30',
      '--purple': '#af52de',
    };
    for (const [k, v] of Object.entries(want)) expect({ k, v: hexOf(color(LIGHT, k)) }).toEqual({ k, v });
  });

  it('태그 틴트는 같은 색의 15% 알파', () => {
    for (const t of [DARK, LIGHT]) {
      for (const hue of ['success', 'warning', 'danger', 'purple']) {
        const base = color(t, `--${hue}`);
        const bg = color(t, `--${hue}-bg`);
        expect({ hue, rgb: bg.slice(0, 3), a: bg[3] }).toEqual({ hue, rgb: base.slice(0, 3), a: 0.15 });
      }
    }
  });
});

describe('DESIGN-A 대비 — WCAG AA(본문·태그 4.5:1)', () => {
  const AA = 4.5;
  for (const [mode, t] of [
    ['다크', DARK],
    ['라이트', LIGHT],
  ] as const) {
    const bases = ['--bg', '--card'] as const;
    const check = (label: string, fg: RGBA, bg: RGBA, min = AA) => {
      const r = contrast(fg, bg);
      expect({ label, ok: r >= min, r: Math.round(r * 100) / 100 }).toMatchObject({ label, ok: true });
    };

    it(`${mode}: 본문·보조 글자·링크`, () => {
      for (const b of [...bases, '--surface-2']) check(`text/${b}`, color(t, '--text'), color(t, b));
      for (const b of bases) {
        check(`muted/${b}`, color(t, '--muted'), color(t, b));
        check(`link/${b}`, color(t, '--link'), color(t, b));
        check(`neutral-text(보조 버튼·입력 글자)/${b}`, color(t, '--text'), color(t, '--field-bg'));
      }
    });

    it(`${mode}: 상태 태그 글자 — 같은 색 틴트 위(바탕·패널 위 합성)`, () => {
      const pairs: Array<[string, string]> = [
        ['--warning-text', '--warning-bg'], // 실제 게시(tag live)·경고(tag warn)
        ['--neutral-text', '--neutral-bg'], // MOCK(tag mock)·일반 태그
        ['--success-text', '--success-bg'], // VERIFIED
        ['--purple-text', '--purple-bg'], // 사용자 확인
        ['--danger-text', '--danger-bg'],
        ['--info-text', '--info-bg'],
      ];
      for (const b of bases) for (const [fg, bg] of pairs) check(`${fg} on ${bg}/${b}`, color(t, fg), over(color(t, bg), color(t, b)));
    });

    it(`${mode}: 경고 안내(.notice)·저장됨(.saved) 글자, 안내 안의 태그`, () => {
      for (const b of bases) {
        const notice = over(color(t, '--warning-bg'), color(t, b));
        check(`notice/${b}`, color(t, '--notice-text'), notice);
        check(`saved/${b}`, color(t, '--text'), over(color(t, '--success-bg'), color(t, b)));
        // 안내 안의 실제 게시·미확인(주황)·MOCK(회색) 태그
        check(`warning tag in notice/${b}`, color(t, '--warning-text'), over(color(t, '--warning-bg'), notice));
        check(`mock tag in notice/${b}`, color(t, '--neutral-text'), over(color(t, '--neutral-bg'), notice));
      }
    });

    it(`${mode}: 주 버튼 — 흰 글자 on --primary-fill(#0071e3) AA 4.5:1`, () => {
      expect(hexOf(color(t, '--primary-fill'))).toBe('#0071e3');
      check('on-accent/primary-fill', color(t, '--on-accent'), color(t, '--primary-fill'));
    });

    it(`${mode}: 포커스 링(강조색)·입력 테두리 — 비텍스트 3:1(WCAG 1.4.11)`, () => {
      for (const b of bases) check(`focus(accent)/${b}`, color(t, '--accent'), color(t, b), 3);
      check('field-border/field-bg', color(t, '--field-border'), color(t, '--field-bg'), 3);
    });
  }
});

describe('DESIGN-A 안전 표시 규칙 — 실제 게시(주황) · MOCK(회색 점선) · 경고 안내(주황 틴트)', () => {
  const rule = (selector: string) => {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
    if (!m) throw new Error(`규칙 없음: ${selector}`);
    return m[1]!;
  };

  it('.tag.live 는 주황 틴트 + 주황 글자 + 테두리, .tag.mock 은 회색 틴트 + 점선 테두리', () => {
    const live = rule('.tag.live');
    expect(live).toContain('var(--warning-bg)');
    expect(live).toContain('var(--warning-text)');
    expect(live).toContain('var(--warning-border)');
    const mock = rule('.tag.mock');
    expect(mock).toContain('var(--neutral-bg)');
    expect(mock).toContain('var(--neutral-text)');
    expect(mock).toContain('dashed');
    expect(mock).not.toContain('warning');
  });

  it('주황(실제)과 회색(MOCK) 색이 두 모드 모두 다르다', () => {
    for (const t of [DARK, LIGHT]) {
      expect(hexOf(color(t, '--warning-text'))).not.toBe(hexOf(color(t, '--neutral-text')));
      const w = color(t, '--warning-bg');
      const n = color(t, '--neutral-bg');
      // 회색 틴트는 채도 없음(r=g≈b), 주황 틴트는 r > g > b
      expect(Math.abs(n[0] - n[1])).toBeLessThan(8);
      expect(w[0] - w[2]).toBeGreaterThan(150);
    }
  });

  it('.notice 는 주황 틴트 배경 · 안내 글자색, .tag 는 알약(999px)', () => {
    const notice = rule('.notice');
    expect(notice).toContain('background: var(--warning-bg)');
    expect(notice).toContain('color: var(--notice-text)');
    expect(rule('.tag')).toContain('border-radius: 999px');
    expect(rule('.tag.verified')).toContain('var(--success-bg)');
    expect(rule('.tag.user-confirmed')).toContain('var(--purple-bg)');
  });

  it('그라디언트·외부 글꼴·외부 URL 없음, 글꼴 스택은 시스템 글꼴', () => {
    expect(css).not.toMatch(/gradient\(/);
    expect(css).not.toMatch(/@import|@font-face|url\(/);
    expect(resolve(DARK, '--font')).toBe("-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif");
  });
});

describe('DESIGN-A polish — 주 버튼·입력·홈 제목·묶음 행 구분선 규칙', () => {
  const rule = (selector: string) => {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
    if (!m) throw new Error(`규칙 없음: ${selector}`);
    return m[1]!;
  };

  it('주 버튼은 --primary-fill 로 채우고 hover 는 밝게 하지 않는다(대비 유지), 강조색은 포커스 링에 그대로', () => {
    expect(rule('button.primary')).toContain('background: var(--primary-fill)');
    expect(rule('button.primary:hover:not(:disabled)')).not.toMatch(/brightness\(1\.[0-9]/);
    expect(rule(':focus-visible')).toContain('var(--accent)');
  });

  it('입력·textarea·select 는 1px --field-border 가는 선', () => {
    expect(css).toMatch(/border: 1px solid var\(--field-border\);/);
  });

  it('홈 앱 이름(h1.app-name)은 화면 제목보다 작은 보조 글자', () => {
    const app = rule('.header h1.app-name');
    expect(app).toContain('color: var(--muted)');
    const size = Number(/font-size: ([\d.]+)rem/.exec(app)?.[1]);
    const title = Number(/font-size: ([\d.]+)rem/.exec(rule('.screen-title'))?.[1]);
    expect(size).toBeGreaterThan(0);
    expect(size * 15).toBeLessThanOrEqual(17);
    expect(size).toBeLessThan(title);
  });

  it('패널 안 묶음 행: 구분선은 들여 있는 행(.row)에만 — 목록 자체의 위·아래 선(패널 왼쪽 끝까지 가는 선) 없음', () => {
    const list = rule('.card .group-list');
    expect(list).not.toMatch(/border(-top|-bottom|-left)?\s*:/);
    const row = rule('.card .group-list .row');
    expect(row).toContain('margin-left: 16px');
    expect(row).toContain('border-top: 0.5px solid var(--border)');
    expect(rule('.group-list .row')).toMatch(/margin: 0 0 0 14px;[\s\S]*padding: 12px 14px 12px 0;/);
  });
});
