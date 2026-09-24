import { afterAll, describe, expect, it } from 'vitest';
import { getDb, seed } from '@cs/db';
import { loadConfig } from '@cs/domain';
import { GET } from '../../apps/web/app/api/health/route';

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
      db: { driver: 'pglite', ok: true, migrated: true, captures: 10 },
      worker: { mode: 'inline' },
    });
    expect(body.time_msk).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(MSK\)$/);
    expect(typeof body.worker.last_tick_utc).toBe('string');
  });

  it('환경변수 값(DB 경로·허용 식별자)을 노출하지 않는다', async () => {
    const text = await (await GET()).text();
    expect(text).not.toContain('memory://');
    expect(text).not.toContain('owner@example.local');
    expect(text).not.toContain('DATABASE_URL');
  });
});
