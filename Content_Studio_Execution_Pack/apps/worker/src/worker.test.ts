import { describe, expect, it } from 'vitest';
import { loadConfig } from '@cs/domain';
import { assertWorkerModeSupported, WorkerModeError } from './index';

describe('worker mode', () => {
  it('inline + pglite 허용', () => {
    expect(() => assertWorkerModeSupported(loadConfig({}))).not.toThrow();
  });
  it('separate + pglite 는 단일 연결 제약으로 거부', () => {
    expect(() => assertWorkerModeSupported(loadConfig({ WORKER_MODE: 'separate' }))).toThrow(WorkerModeError);
    expect(() => assertWorkerModeSupported(loadConfig({ WORKER_MODE: 'separate' }))).toThrow(/PGlite/);
  });
});
