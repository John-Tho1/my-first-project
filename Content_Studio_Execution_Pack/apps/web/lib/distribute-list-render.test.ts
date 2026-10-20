/**
 * FIX-UICLEAN(Codex review-UI-CLEAN P1): 배포함(/distribute) 안내는 지금 계정 상태 셋(모의만 · 실제 계정은 있으나 실제 게시 대상 미지정 · 실제 게시 대상 있음)
 * (+ 계정 없음)을 구분하고, 계획 한 줄의 실제/MOCK 표시는 그 계획 항목의 기록(항목 계정 kind)에서 고른다 — 페이지 수준 계정 상태로 결과를 MOCK 이라고 단정하지 않는다.
 * 실제 화면 컴포넌트를 react-dom/server 로 렌더(DB·세션은 가짜).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Acc = { account_id: string; display_name: string; platform: string; mock: boolean; live_publish_target: boolean; status: string; credential_required: boolean; usable_for_execution: boolean; pending_reconcile: string | null };
type Entry = { plan: { id: string; targetSummary: string; status: string; createdAt: Date }; itemCount: number; channels: string[]; mock: boolean };

const state = vi.hoisted(() => ({ accounts: [] as unknown[], plans: [] as unknown[], paused: false }));

vi.mock('./auth', () => ({ getSession: async () => ({ ownerId: '00000000-0000-4000-8000-000000000001', identity: 'owner@example.local', expiresAt: new Date() }) }));
vi.mock('./server', () => ({ getConfig: () => ({}), getAppDb: async () => ({ db: {} }) }));
vi.mock('next/navigation', () => ({ redirect: () => { throw new Error('redirect'); } }));
vi.mock('@cs/db', async (orig) => ({
  ...(await orig<typeof import('@cs/db')>()),
  listPlans: async () => ({ items: state.plans, next: null }),
  listAccountHealth: async () => state.accounts,
  // FIX-LIVEP2: 즉시 중지 스위치(표시용 읽기)
  getLivePublishPaused: async () => ({ paused: state.paused, changedAt: null }),
}));

const { default: DistributePage } = await import('../app/distribute/page');

const acc = (o: Partial<Acc>): Acc => ({
  account_id: `acc-${Math.random()}`,
  display_name: '계정',
  platform: 'threads',
  mock: true,
  live_publish_target: false,
  status: 'connected',
  credential_required: false,
  usable_for_execution: true,
  pending_reconcile: null,
  ...o,
});
const entry = (o: Partial<Entry> & { name: string }): Entry => ({
  plan: { id: `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`, targetSummary: o.name, status: 'completed', createdAt: new Date('2026-10-01T09:00:00Z') },
  itemCount: 1,
  channels: ['threads'],
  mock: true,
  ...o,
});

async function render(): Promise<string> {
  return renderToStaticMarkup(await DistributePage({ searchParams: Promise.resolve({}) }));
}
/** 상단 안내 한 줄(첫 notice) */
const notice = (html: string) => /<p class="notice" role="note">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';
/** 계획 이름이 든 목록 한 줄 */
const row = (html: string, name: string) => {
  const i = html.indexOf(`>${name}</a>`);
  expect(i).toBeGreaterThan(-1);
  return html.slice(i, html.indexOf('</li>', i));
};

beforeEach(() => {
  state.accounts = [];
  state.plans = [];
  state.paused = false;
});

describe('배포함 안내 — 지금 계정 상태 셋을 구분', () => {
  it('(a) 모의 계정만 → MOCK 안내(지금 실행하는 것은 실제로 보내지 않음)', async () => {
    state.accounts = [acc({ mock: true }), acc({ mock: true, platform: 'youtube' })];
    const n = notice(await render());
    expect(n).toContain('MOCK');
    expect(n).toContain('모의 계정만');
    expect(n).not.toContain('실제 게시 대상 미지정');
    expect(n).not.toContain('<strong>실제로 게시</strong>');
  });

  it('(b) 실제 계정은 있으나 실제 게시 대상 없음 → "실제 게시 대상 미지정"(MOCK 이라고 단정하지 않음)', async () => {
    state.accounts = [acc({ mock: true }), acc({ mock: false, live_publish_target: false, display_name: '@real' })];
    const n = notice(await render());
    expect(n).toContain('실제 게시 대상 미지정');
    expect(n).not.toMatch(/^\s*MOCK/);
    expect(n).not.toContain('결과와 원격 ID 는');
    expect(n).not.toContain('<strong>실제로 게시</strong>됩니다');
  });

  it('(c) 실제 게시 대상 있음 → 실제 게시 안내', async () => {
    state.accounts = [acc({ mock: true }), acc({ mock: false, live_publish_target: true })];
    const n = notice(await render());
    expect(n).toContain('실제 게시 계정 있음');
    expect(n).toContain('<strong>실제로 게시</strong>');
    expect(n).toContain('되돌리기 없음');
    expect(n).not.toContain('실제 게시 대상 미지정');
    expect(n).not.toContain('일시 중지');
  });

  it('FIX-LIVEP2(계획 3(b)): 실제 게시 대상이 있는데 즉시 중지 중 → 안내에 "일시 중지됨 — 재개 전에는 게시하지 않습니다"를 함께', async () => {
    state.accounts = [acc({ mock: true }), acc({ mock: false, live_publish_target: true })];
    state.paused = true;
    const n = notice(await render());
    expect(n).toContain('<strong>실제로 게시</strong>');
    expect(n).toContain('<span class="tag warn">일시 중지됨</span> <strong>지금은 실제 게시 일시 중지됨 — 재개 전에는 게시하지 않습니다.</strong>');
    // 모의 계정만이면 중지 문구 없음(실제 게시 안내 자체가 없다)
    state.accounts = [acc({ mock: true })];
    expect(notice(await render())).not.toContain('일시 중지');
  });

  it('계정 0개 → "배포 계정 없음"(MOCK 결과라고 말하지 않음)', async () => {
    const html = await render();
    expect(notice(html)).toContain('배포 계정이 없습니다');
    expect(notice(html)).not.toContain('MOCK(');
  });

  it('안내는 어느 상태에서도 기존 결과를 "모두 MOCK" 이라고 말하지 않는다(결과 표시는 각 기록에서)', async () => {
    for (const accounts of [[acc({ mock: true })], [acc({ mock: false })], [acc({ mock: false, live_publish_target: true })], []]) {
      state.accounts = accounts;
      const n = notice(await render());
      expect(n).not.toContain('모두 MOCK');
      expect(n).not.toContain('결과와 원격 ID 는');
      expect(n).toContain('각 계획');
    }
  });
});

describe('계획 한 줄 — 그 계획 항목의 기록으로 실제/MOCK', () => {
  it('지난 실제 게시 계획 + 지금은 모의 계정만: 지난 계획은 "실제 게시 포함", 모의 계획은 MOCK', async () => {
    state.accounts = [acc({ mock: true })];
    state.plans = [entry({ name: '지난 실제 계획', mock: false }), entry({ name: '모의 계획', mock: true })];
    const html = await render();
    const live = row(html, '지난 실제 계획');
    expect(live).toContain('<span class="tag live">실제 게시 포함</span>');
    // 상태 문구의 "(MOCK — 실제 발행 아님)"도 그 계획 기록(실제 계정)에 맞춰 붙이지 않는다
    expect(live).not.toContain('MOCK');
    expect(live).toContain('처리 끝');
    const mock = row(html, '모의 계획');
    expect(mock).toContain('<span class="tag mock">MOCK</span>');
    expect(mock).not.toContain('실제 게시 포함');
    expect(mock).toContain('처리 끝(MOCK — 실제 발행 아님)');
    // 페이지 안내는 지금 상태(모의만)지만 지난 실제 계획을 MOCK 이라고 하지 않는다
    expect(notice(html)).not.toContain('모두 MOCK');
  });

  it('실제 게시 대상이 있어도 모의 계정 계획은 MOCK 그대로', async () => {
    state.accounts = [acc({ mock: false, live_publish_target: true })];
    state.plans = [entry({ name: '모의 계획', mock: true })];
    expect(row(await render(), '모의 계획')).toContain('<span class="tag mock">MOCK</span>');
  });

  it('항목 없는 계획은 태그 없음', async () => {
    state.accounts = [acc({ mock: true })];
    state.plans = [entry({ name: '빈 계획', mock: true, itemCount: 0, channels: [] })];
    const r = row(await render(), '빈 계획');
    expect(r).not.toContain('MOCK');
    expect(r).not.toContain('실제 게시 포함');
  });
});
