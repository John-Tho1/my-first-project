/** T18(D32 제안) 가져오기 커넥터: 기본 꺼짐, mock 은 프로세스 안 합성 자료만(네트워크 0). live 값은 설정에서 거부된다. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@cs/domain';
import { createImportConnector } from './import-connector';

afterEach(() => vi.restoreAllMocks());

describe('T18 ImportConnector', () => {
  it('기본(IMPORT_CONNECTOR_MODE 없음) → disabled → 커넥터 없음', () => {
    const config = loadConfig({});
    expect(config.IMPORT_CONNECTOR_MODE).toBe('disabled');
    expect(createImportConnector(config)).toBeNull();
  });

  it('live 값은 설정 오류(실제 커넥터 없음)', () => {
    expect(() => loadConfig({ IMPORT_CONNECTOR_MODE: 'live' })).toThrow(/IMPORT_CONNECTOR_MODE/);
  });

  it('mock → 범위 목록·항목 조회, 외부 fetch 0', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const c = createImportConnector(loadConfig({ IMPORT_CONNECTOR_MODE: 'mock' }))!;
    expect(c.isMock).toBe(true);
    const scope = await c.listScope();
    expect(scope.length).toBeGreaterThanOrEqual(3);
    const item = await c.fetchItem(scope[0]!.id);
    expect(new TextDecoder().decode(item.bytes)).toContain('합성 예시');
    await expect(c.fetchItem('mock:none')).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
