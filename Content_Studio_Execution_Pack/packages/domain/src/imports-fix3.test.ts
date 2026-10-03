/**
 * FIX-T18 round 3(Codex review-FIX2-T18): htmlToText 를 WHATWG 토크나이저 상태 기계로 다시 짬.
 * 차등 표: 까다로운 입력마다 사양(https://html.spec.whatwg.org/multipage/parsing.html#tokenization, scripting 꺼짐)에 따라 손으로 적은
 * "보이는 글자"(이 모듈의 정규화 — 블록 닫는 태그·br → 줄바꿈, 줄마다 공백 접기·앞뒤 자르기)와 비교한다.
 * `deviation` 이 있는 줄은 글 손실을 막으려고 일부러 사양과 다르게 한 것이다(사양 결과를 함께 적음).
 */
import { describe, expect, it } from 'vitest';
import { htmlToText } from './imports';

interface Row {
  html: string;
  text: string;
  title?: string | null;
  why: string;
  deviation?: string;
}

const rows: Row[] = [
  // ---- Codex review-FIX2-T18 재현 입력
  { html: `<script>let x='</script="';</script><p>본문</p>`, text: '본문', why: '[P1 :453] `</script=` 는 appropriate end tag 가 아님(이름 뒤 `=`) — 실제 `</script>` 에서 끝남' },
  { html: `<p data-x=a=">본문</p>`, text: '본문', why: '[P2 :338] 따옴표 없는 값 `a="` — `=`·따옴표는 값의 글자, `>` 에서 태그 끝' },
  // ---- raw text(script data·RAWTEXT) 안의 따옴표·가짜 닫는 태그
  { html: `<script>var s = "</scriptx>"; var t = '"';</script>본문`, text: '본문', why: '`</scriptx>` 는 이름이 다름, 안의 따옴표는 의미 없음' },
  { html: `<script>if (a<b) x = "'";</script >본문`, text: '본문', why: '`</script ` + 공백 → 닫는 태그(속성 상태로 이어서 `>`)' },
  { html: `<SCRIPT>x</ScRiPt>본문`, text: '본문', why: '대소문자 무시' },
  { html: `<script>a</script\n>본문`, text: '본문', why: '이름 뒤 줄바꿈도 공백' },
  { html: `<script>a</script/>본문`, text: '본문', why: '이름 뒤 `/` → self-closing start tag 상태 → `>`' },
  { html: `<script>a</script1>b</script>본문`, text: '본문', why: '`</script1` 은 닫는 태그 아님(숫자는 end tag name 의 anything else)' },
  { html: `<script>a</scrip>b</script>본문`, text: '본문', why: '짧은 이름은 닫는 태그 아님' },
  { html: `<script>document.write("<script>x<\\/script>")</script>본문`, text: '본문', why: 'script data 안 `<script>` 는 글자, `<\\/` 는 `</` 아님' },
  { html: `<script>x</script data-a=">">본문`, text: '본문', why: '닫는 태그의 따옴표 속성 값 안 `>`' },
  { html: `<script\n type="text/javascript">x</script>본문`, text: '본문', why: '시작 태그 이름 뒤 줄바꿈·속성' },
  { html: `<script><!--<script>x</script>숨김--></script>본문`, text: '본문', why: 'script data double escaped: 안쪽 `</script>` 는 escaped 로 돌아갈 뿐, `-->` 뒤 `</script>` 에서 끝' },
  { html: `<script><!--</script>본문`, text: '본문', why: 'script data escaped 에서도 `</script>` 는 끝' },
  { html: `<script><!-- x --></script>본문`, text: '본문', why: 'escaped → `-->` → script data → 끝' },
  { html: `<p>앞</p><script>닫히지 않음 "</script`, text: '앞', why: 'EOF 직전 `</script` 는 닫는 태그 아님 → script 가 끝까지(브라우저와 같음)' },
  { html: `<style>p::after{content:"</style"}</style>본문`, text: '본문', why: '`</style"` 는 닫는 태그 아님 — 다음 `</style>` 에서 끝' },
  { html: `<style>a{}</style x=">">본문`, text: '본문', why: 'RAWTEXT 닫는 태그의 속성' },
  { html: `<style>닫히지 않음 <p>뒤</p>`, text: '', why: '닫히지 않은 style 은 끝까지 RAWTEXT(브라우저와 같음)' },
  { html: `<iframe>대체 글</iframe>본문`, text: '본문', why: 'iframe 은 RAWTEXT — 안의 글자는 그려지지 않음' },
  {
    html: `<iframe>닫히지 않음 <b>글</b>`,
    text: '닫히지 않음 글',
    why: '닫히지 않은 iframe',
    deviation: '사양은 끝까지 RAWTEXT(보이는 글자 없음) — 글 손실을 막으려고 일반 HTML 로 다시 읽음',
  },
  { html: `<scriptx>보임</scriptx>`, text: '보임', why: '`scriptx` 는 모르는 일반 요소' },
  // ---- RCDATA·기타 요소 분류
  { html: `<title>a &amp; b</title>`, text: '', title: 'a & b', why: 'title 은 RCDATA(문자 참조 풂) — 본문 아님' },
  { html: `<title><b>굵게</b></title>본문`, text: '본문', title: '<b>굵게</b>', why: 'RCDATA 안 태그는 글자' },
  {
    html: `<title>제목<p>본문`,
    text: '제목본문',
    title: null,
    why: '닫히지 않은 title',
    deviation: '사양은 끝까지 title 글자(본문 없음) — 글 손실을 막으려고 일반 HTML 로 다시 읽음',
  },
  { html: `<p>a&amp;b</p><textarea>&lt;x&gt; <b>굵게</b></textarea>`, text: 'a&b\n<x> <b>굵게</b>', why: 'textarea 는 RCDATA — 안의 태그는 글자, 문자 참조는 풂' },
  { html: `<xmp><b>&amp;</b></xmp>`, text: '<b>&amp;</b>', why: 'xmp 는 RAWTEXT — 글자 그대로(문자 참조도 그대로)' },
  { html: `<plaintext><p>모두 글자</p>`, text: '<p>모두 글자</p>', why: 'PLAINTEXT — 나머지 전부 글자' },
  { html: `<noscript>n</noscript>본문`, text: 'n본문', why: 'noscript 는 scripting 꺼짐 기준 일반 요소' },
  { html: `<template><p>t</p></template>본문`, text: 't\n본문', why: 'template 은 일반 요소로 봄(안의 글자를 남김)' },
  // ---- 속성 상태
  { html: `<p title='a"b>c'>본문</p>`, text: '본문', why: '작은따옴표 값 안 큰따옴표·`>`' },
  { html: `<p title="a'b>c">본문</p>`, text: '본문', why: '큰따옴표 값 안 작은따옴표·`>`' },
  { html: `<a href=x?a=b&c=d>링크</a>`, text: '링크', why: '따옴표 없는 값 안 `=`·`&`' },
  { html: `<a href=a=b=c>링크</a>뒤`, text: '링크뒤', why: '따옴표 없는 값 안 `=` 여러 개' },
  { html: `<p a="1"b="2">본문</p>`, text: '본문', why: 'missing-whitespace-between-attributes' },
  { html: `<p a = 1 >본문</p>`, text: '본문', why: '`=` 앞뒤 공백' },
  { html: `<p =x>본문</p>`, text: '본문', why: '`=` 로 시작하는 속성 이름' },
  { html: `<p/x>본문</p>`, text: '본문', why: 'unexpected-solidus-in-tag' },
  { html: `<p a=>본문</p>`, text: '본문', why: 'missing-attribute-value' },
  { html: `<p a"b='c'>본문</p>`, text: '본문', why: '속성 이름 안 따옴표는 글자' },
  { html: `<img alt="a > b" src=x>뒤`, text: '뒤', why: '따옴표 값 안 `>`' },
  { html: `<div data-json='{"a":"</div>"}'>본문</div>`, text: '본문', why: '따옴표 값 안 닫는 태그 흉내' },
  { html: `<a title=">">x</a><script>"</script>y`, text: 'xy', why: '속성 `>` 와 script 안 따옴표' },
  { html: `<p a=b"c d='e>본문</p>`, text: '', why: '`d=\'` 가 닫히지 않음 → eof-in-tag(사양: 태그를 버림)' },
  // ---- 주석·bogus 주석·markup declaration
  { html: `앞<!-- a -- b -->뒤`, text: '앞뒤', why: '주석 안 `--` 는 끝 아님' },
  { html: `앞<!-->뒤`, text: '앞뒤', why: 'abrupt-closing-of-empty-comment `<!-->`' },
  { html: `앞<!--->뒤`, text: '앞뒤', why: '`<!--->`' },
  { html: `앞<!---->뒤`, text: '앞뒤', why: '빈 주석' },
  { html: `앞<!-- x --!>뒤`, text: '앞뒤', why: 'comment end bang `--!>`' },
  { html: `앞<!-- x --->뒤`, text: '앞뒤', why: '`--->`(대시 여럿)' },
  { html: `앞<!-- x --!-->뒤`, text: '앞뒤', why: 'end bang 뒤 다시 `-->`' },
  { html: `앞<!-- > -->뒤`, text: '앞뒤', why: '주석 안 `>` 는 끝 아님' },
  { html: `앞<!x>뒤`, text: '앞뒤', why: 'bogus comment `<!x>`' },
  { html: `앞<![CDATA[x>y]]>뒤`, text: '앞y]]>뒤', why: 'HTML 문서의 CDATA 는 bogus comment — 첫 `>` 에서 끝' },
  { html: `<!DOCTYPE html><p>본문</p>`, text: '본문', why: 'DOCTYPE' },
  { html: `앞<?xml version="1.0"?>뒤`, text: '앞뒤', why: '`<?` bogus comment' },
  { html: `a </ b> c`, text: 'a c', why: '`</` + 글자 아님 → bogus comment' },
  { html: `a</>b`, text: 'ab', why: '`</>` 는 아무것도 아님' },
  // ---- 글자로 남는 `<`·EOF
  { html: `a <3 b`, text: 'a <3 b', why: '`<` + 글자 아님 → 글자' },
  { html: `a<`, text: 'a<', why: 'EOF 의 `<` 는 글자' },
  { html: `a</`, text: 'a</', why: 'EOF 의 `</` 는 글자' },
  { html: `<p>본문<b`, text: '본문', why: 'eof-in-tag(태그 이름)' },
  { html: `<p>본문<b title="x`, text: '본문', why: 'eof-in-tag(따옴표 값)' },
  { html: `<p>앞</p><!-- 닫히지 않음 <p>뒤</p>`, text: '앞', why: 'eof-in-comment: 나머지는 주석' },
  // ---- 문자 참조·줄바꿈
  { html: `&lt;p&gt; &amp;amp; &#x41;&#66;`, text: '<p> &amp; AB', why: '문자 참조는 한 번만 풂' },
  { html: `<h1>A &amp;lt; B</h1>`, text: 'A &lt; B', title: 'A &lt; B', why: 'h1 제목도 한 번만 풂' },
  { html: `a&am<b></b>p;b`, text: 'a&amp;b', why: '태그를 건너 문자 참조를 잇지 않음' },
  { html: `a</br>b`, text: 'a\nb', why: '`</br>` 은 `<br>` 로 다룸' },
  { html: `<p>a</p\n>b`, text: 'a\nb', why: '닫는 태그 이름 뒤 줄바꿈' },
];

describe('FIX-T18 round 3 — WHATWG 상태 기계 차등 표', () => {
  it(`표 크기(${rows.length}) ≥ 40`, () => {
    expect(rows.length).toBeGreaterThanOrEqual(40);
  });
  it.each(rows.map((r) => [r.why, r] as const))('%s', (_why, r) => {
    const st = { steps: 0 };
    const h = htmlToText(r.html, st);
    expect(h.text, JSON.stringify(r.html)).toBe(r.text);
    if (r.title !== undefined) expect(h.title).toBe(r.title);
    expect(st.steps).toBeLessThanOrEqual(6 * r.html.length + 32);
  });
});

describe('FIX-T18 round 3 — 글 손실 방지', () => {
  it('정상 문서 뒤쪽 본문은 앞의 가짜 닫는 태그·따옴표 조합으로 사라지지 않는다', () => {
    const tail = '<h2>소제목</h2><p>뒤쪽 본문 1</p><p>뒤쪽 본문 2</p>';
    for (const head of [
      `<script>let x='</script="';</script>`,
      `<script>"</scriptx>'</script>`,
      `<style>a[title="</style "]{}</style>`,
      `<p data-x=a=">x</p>`,
      `<a href=y'z>x</a>`,
      `<script><!--<script></script>--></script>`,
    ]) {
      expect(htmlToText(`<p>앞</p>${head}${tail}`).text, head).toContain('뒤쪽 본문 2');
    }
  });

  it('닫히지 않은 title·iframe 이 여러 번 나와도 다시 읽기는 이름마다 한 번(선형)', () => {
    const input = '<title>'.repeat(20000) + '<iframe>'.repeat(20000) + '본문';
    const st = { steps: 0 };
    expect(htmlToText(input, st).text).toBe('본문');
    expect(st.steps).toBeLessThanOrEqual(6 * input.length);
  });
});

describe('FIX-T18 round 3 — 새 상태들의 선형성(걸음 수) · 계수기 밖 후처리 시간', () => {
  const TWO_MB = 2 * 1024 * 1024;
  const fill = (unit: string, bytes: number) => unit.repeat(Math.floor(bytes / unit.length));
  const adversarial: Array<[string, (bytes: number) => string]> = [
    ['script 안 <!--<script> 반복(escaped·double escaped 오가기)', (b) => `<script>${fill('<!--<script>--></script x', b - 8)}`],
    ['script 안 </scriptx 반복', (b) => `<script>${fill('</scriptx', b - 8)}`],
    ['따옴표 없는 값 a=b=" 반복', (b) => fill('<p a=b=" ', b)],
    ['주석 안 --! 반복', (b) => `<!--${fill('--!', b - 4)}`],
    ['주석 안 - 반복', (b) => `<!--${fill('-x', b - 4)}`],
    ['닫히지 않은 <title><iframe><noembed><noframes> 반복', (b) => fill('<title><iframe><noembed><noframes>', b)],
    ['<textarea> 뒤 </textare 반복', (b) => `<textarea>${fill('</textare', b - 10)}`],
    ['bogus comment <! 반복', (b) => fill('<!', b)],
    ['</ 공백 반복', (b) => fill('</ ', b)],
    ['self-closing / 반복', (b) => `<p${fill('/', b - 2)}`],
    ['속성 이름만 반복', (b) => `<p${fill(' a', b - 2)}`],
    ['공백·줄바꿈만', (b) => fill(' \n\t', b)],
    ['엔티티만', (b) => fill('&amp;', b)],
    ['& 만', (b) => fill('&', b)],
  ];
  const STEP_BOUND = 6;
  it.each(adversarial)('%s', (_label, make) => {
    const sizes = [16 * 1024, 128 * 1024, TWO_MB / 4, TWO_MB];
    const counts: number[] = [];
    let big = '';
    for (const b of sizes) {
      const input = make(b);
      const s = { steps: 0 };
      htmlToText(input, s);
      expect(s.steps, `글자당 걸음(${input.length}자)`).toBeLessThanOrEqual(STEP_BOUND * input.length + 16);
      if (counts.length) expect(s.steps / counts[counts.length - 1]!, '크기 비율 대비 걸음 비율').toBeLessThanOrEqual((b / sizes[counts.length - 1]!) * 1.125);
      counts.push(s.steps);
      big = input;
    }
    let min = Infinity;
    for (let k = 0; k < 3; k++) {
      const c = process.cpuUsage();
      htmlToText(big);
      const d = process.cpuUsage(c);
      min = Math.min(min, (d.user + d.system) / 1000);
    }
    expect(min).toBeLessThan(1000);
  });
});
