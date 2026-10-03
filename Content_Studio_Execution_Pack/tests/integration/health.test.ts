import { afterAll, describe, expect, it, vi } from 'vitest';
import { getDb, seed } from '@cs/db';
import { loadConfig } from '@cs/domain';
import { GET } from '../../apps/web/app/api/health/route';

/** D30-3: 공개 health 는 생존·준비 상태만 — 운영 숫자 키는 ok·degraded 어느 쪽에도 없다. */
const HEALTH_KEYS = ['app', 'db', 'llm', 'modes', 'status', 'stt', 'time_msk', 'time_utc', 'timezone', 'version', 'worker'];
const FORBIDDEN = ['jobs', 'uploads', 'captures', 'attention_plans', 'ops', 'queued', 'sessions', 'bytes'];

function expectLivenessOnly(body: Record<string, unknown>) {
  expect(Object.keys(body).sort()).toEqual(HEALTH_KEYS);
  expect(Object.keys(body.db as object).sort()).toEqual(['driver', 'migrated', 'ok']);
  expect(Object.keys(body.worker as object).sort()).toEqual(['last_tick_utc', 'mode']);
  const text = JSON.stringify(body);
  for (const k of FORBIDDEN) expect(text).not.toContain(`"${k}"`);
}

describe('GET /api/health', () => {
  afterAll(async () => {
    const h = await getDb(loadConfig());
    await h.close();
  });

  it('기본 모드(mock/disabled/disabled)와 DB 상태를 반환한다', async () => {
    const config = loadConfig();
    expect(config.DATABASE_URL).toBe('memory://');
    const h = await getDb(config);
    await seed(h.db, { allowedIdentity: config.AUTH_ALLOWED_IDENTITY });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: 'ok',
      app: 'content-studio',
      timezone: 'Europe/Moscow',
      modes: { llm: 'mock', publish: 'disabled', collectors: 'disabled' },
      db: { driver: 'pglite', ok: true, migrated: true },
      worker: { mode: 'inline' },
    });
    expect(body.time_msk).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(MSK\)$/);
    expect(typeof body.worker.last_tick_utc).toBe('string');
  });

  it('D30-3: ok 응답에 jobs·uploads·db.captures 등 운영 숫자 키가 없다(생존·준비 키만)', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expectLivenessOnly(await res.json());
  });

  it('환경변수 값(DB 경로·허용 식별자)을 노출하지 않는다', async () => {
    const text = await (await GET()).text();
    expect(text).not.toContain('memory://');
    expect(text).not.toContain('owner@example.local');
    expect(text).not.toContain('DATABASE_URL');
  });

  it('D30-3: degraded(DB 열기 실패 → 503) 응답에도 운영 숫자 키가 없다', async () => {
    vi.resetModules();
    vi.doMock('@cs/db', async (orig) => ({ ...(await orig<typeof import('@cs/db')>()), getDb: () => Promise.reject(new Error('db down')) }));
    try {
      const { GET: degradedGET } = await import('../../apps/web/app/api/health/route');
      const res = await degradedGET();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toMatchObject({ status: 'degraded', db: { driver: 'pglite', ok: false, migrated: false } });
      expectLivenessOnly(body);
      expect(JSON.stringify(body)).not.toContain('db down');
    } finally {
      vi.doUnmock('@cs/db');
      vi.resetModules();
    }
  });
});
