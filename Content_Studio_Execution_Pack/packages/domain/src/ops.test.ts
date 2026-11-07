import { describe, expect, it } from 'vitest';
import { EXCLUDED_TABLES, EXPORTED_TABLES } from './bundle';
import { loadConfig } from './config';
import {
  ageHours,
  backupState,
  cutoffDays,
  exportsToPrune,
  formatAgeHours,
  formatByteSize,
  packageExpired,
  RETENTION_DELETABLE_TABLES,
  RETENTION_PROTECTED_TABLES,
  RETENTION_TARGETS,
} from './ops';

const NOW = new Date('2026-10-01T12:00:00Z');

describe('T20 — 백업 나이·기준', () => {
  it('ageHours: 기록 없음 null, 미래(시계 차) 0, 소수 1자리', () => {
    expect(ageHours(null, NOW)).toBeNull();
    expect(ageHours(undefined, NOW)).toBeNull();
    expect(ageHours(new Date('2026-10-01T13:00:00Z'), NOW)).toBe(0);
    expect(ageHours(new Date('2026-10-01T10:30:00Z'), NOW)).toBe(1.5);
    expect(ageHours(new Date('2026-09-30T12:00:00Z'), NOW)).toBe(24);
  });
  it('backupState: none / 기준과 같으면 recent / 넘으면 stale', () => {
    expect(backupState(null, 24)).toBe('none');
    expect(backupState(24, 24)).toBe('recent');
    expect(backupState(24.1, 24)).toBe('stale');
    expect(backupState(0, 1)).toBe('recent');
  });
  it('설정 기본값: BACKUP_MAX_AGE_HOURS 24·보존 30일/10개/180일·manual, 범위 밖·소수는 거부', () => {
    const c = loadConfig({});
    expect(c.BACKUP_MAX_AGE_HOURS).toBe(24);
    expect(c.RETENTION_PACKAGES_DAYS).toBe(30);
    expect(c.RETENTION_EXPORT_RUNS_KEEP).toBe(10);
    expect(c.RETENTION_JOB_EVENTS_DAYS).toBe(180);
    expect(c.RETENTION_SWEEP_MODE).toBe('manual');
    expect(loadConfig({ BACKUP_MAX_AGE_HOURS: '48', RETENTION_SWEEP_MODE: 'auto' })).toMatchObject({ BACKUP_MAX_AGE_HOURS: 48, RETENTION_SWEEP_MODE: 'auto' });
    expect(() => loadConfig({ BACKUP_MAX_AGE_HOURS: '0' })).toThrow();
    expect(() => loadConfig({ RETENTION_EXPORT_RUNS_KEEP: '1.5' })).toThrow();
    expect(() => loadConfig({ RETENTION_JOB_EVENTS_DAYS: '99999' })).toThrow();
    expect(() => loadConfig({ RETENTION_SWEEP_MODE: 'always' })).toThrow();
  });
});

describe('T20 — 보존 대상 선택', () => {
  it('지울 수 있는 DB 표는 job_events 하나뿐이고 보호 표와 겹치지 않는다(원문·버전·관계는 보호)', () => {
    expect([...RETENTION_DELETABLE_TABLES]).toEqual(['job_events']);
    expect(RETENTION_TARGETS).toEqual(['job_events', 'package_files', 'export_zips']);
    for (const t of RETENTION_DELETABLE_TABLES) expect(RETENTION_PROTECTED_TABLES as readonly string[]).not.toContain(t);
    for (const t of ['captures', 'capture_revisions', 'sources', 'source_versions', 'contents', 'content_versions']) {
      expect(RETENTION_PROTECTED_TABLES as readonly string[]).toContain(t);
    }
    // 내보내기·제외 표 전체가 "지울 수 있음" 또는 "보호" 중 하나에 들어 있다(새 표가 생기면 여기서 걸린다)
    const all = [...EXPORTED_TABLES, ...Object.keys(EXCLUDED_TABLES)];
    const known = new Set<string>([...RETENTION_DELETABLE_TABLES, ...RETENTION_PROTECTED_TABLES, 'sessions', 'upload_sessions', 'upload_chunks']);
    for (const t of all) expect(known.has(t), t).toBe(true);
  });
  it('exportsToPrune: 최근 keep 개를 남기고 나머지(입력 순서와 무관)', () => {
    const runs = [3, 1, 5, 2, 4].map((d) => ({ id: `e${d}`, createdAt: new Date(`2026-09-0${d}T00:00:00Z`) }));
    expect(exportsToPrune(runs, 2).map((r) => r.id)).toEqual(['e3', 'e2', 'e1']);
    expect(exportsToPrune(runs, 10)).toEqual([]);
    expect(exportsToPrune(runs, 0)).toHaveLength(5);
  });
  it('packageExpired·cutoffDays: 경계는 남긴다', () => {
    expect(cutoffDays(NOW, 30).toISOString()).toBe('2026-09-01T12:00:00.000Z');
    expect(packageExpired(new Date('2026-09-01T12:00:00Z'), NOW, 30)).toBe(false);
    expect(packageExpired(new Date('2026-09-01T11:59:59Z'), NOW, 30)).toBe(true);
  });
});

describe('T20 — 표시', () => {
  it('formatByteSize: 단위·측정 없음', () => {
    expect(formatByteSize(0)).toBe('0 B');
    expect(formatByteSize(1023)).toBe('1023 B');
    expect(formatByteSize(1536)).toBe('1.5 KB');
    expect(formatByteSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatByteSize(3 * 1024 ** 4)).toBe('3.0 TB');
    expect(formatByteSize(null)).toBe('측정 없음');
    expect(formatByteSize(-1)).toBe('측정 없음');
    expect(formatByteSize(Number.NaN)).toBe('측정 없음');
  });
  it('formatAgeHours', () => {
    expect(formatAgeHours(null)).toBe('측정 없음');
    expect(formatAgeHours(0.5)).toBe('30분 전');
    expect(formatAgeHours(5)).toBe('5.0시간 전');
    expect(formatAgeHours(72)).toBe('3.0일 전');
  });
});
