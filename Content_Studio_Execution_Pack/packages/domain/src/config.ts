import { z } from 'zod';

/**
 * 환경변수 계약(docs/04 "환경변수 계약").
 * 기본값은 항상 안전 측: LLM 모의, 게시 비활성, 수집 비활성, worker inline.
 * 실제 키·토큰은 이 스키마에 없다. 비밀은 서버 환경변수로만 주입한다.
 */

const LABELS: Record<string, string> = {
  APP_BASE_URL: 'APP_BASE_URL(앱 기본 URL)',
  APP_TIMEZONE: 'APP_TIMEZONE(표시 시간대)',
  DB_DRIVER: 'DB_DRIVER(DB 드라이버)',
  DATABASE_URL: 'DATABASE_URL(DB 위치)',
  LLM_MODE: 'LLM_MODE(AI 모드)',
  LLM_PROVIDER: 'LLM_PROVIDER(AI 공급자)',
  LLM_MODEL: 'LLM_MODEL(AI 모델)',
  PUBLISH_MODE: 'PUBLISH_MODE(게시 모드)',
  COLLECTOR_MODE: 'COLLECTOR_MODE(수집 모드)',
  WORKER_MODE: 'WORKER_MODE(작업 처리기 모드)',
  AUTH_ALLOWED_IDENTITY: 'AUTH_ALLOWED_IDENTITY(허용 사용자)',
  STORAGE_DRIVER: 'STORAGE_DRIVER(파일 저장소)',
  STORAGE_LOCAL_DIR: 'STORAGE_LOCAL_DIR(로컬 파일 경로)',
};

/** 빈 문자열은 "설정하지 않음"으로 취급해 기본값을 적용한다. */
const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const opt = <T extends z.ZodType>(schema: T) => z.preprocess(emptyToUndefined, schema);

export const configSchema = z.object({
  APP_BASE_URL: opt(z.url().default('http://localhost:3000')),
  APP_TIMEZONE: opt(z.literal('Europe/Moscow').default('Europe/Moscow')),
  DB_DRIVER: opt(z.enum(['pglite', 'postgres']).default('pglite')),
  DATABASE_URL: opt(z.string().min(1).default('./data/pglite')),
  LLM_MODE: opt(z.enum(['mock', 'live']).default('mock')),
  LLM_PROVIDER: opt(z.string().min(1).optional()),
  LLM_MODEL: opt(z.string().min(1).optional()),
  PUBLISH_MODE: opt(z.enum(['disabled', 'enabled']).default('disabled')),
  COLLECTOR_MODE: opt(z.enum(['disabled', 'enabled']).default('disabled')),
  WORKER_MODE: opt(z.enum(['inline', 'separate']).default('inline')),
  AUTH_ALLOWED_IDENTITY: opt(z.string().min(3).default('owner@example.local')),
  STORAGE_DRIVER: opt(z.enum(['local', 'object']).default('local')),
  STORAGE_LOCAL_DIR: opt(z.string().min(1).default('./data/assets')),
});

export type AppConfig = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * 환경변수를 검증해 설정 객체를 만든다. 잘못된 값이면 한국어 메시지로 즉시 실패한다.
 * 오류 메시지에는 변수 이름만 넣고 입력값 자체는 넣지 않는다(비밀 노출 방지).
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const input: Record<string, string | undefined> = {};
  for (const key of Object.keys(configSchema.shape)) input[key] = env[key];
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => {
      const key = String(issue.path[0] ?? '');
      return `- ${LABELS[key] ?? key}: 허용되지 않는 값입니다`;
    });
    throw new ConfigError(`환경변수 설정이 올바르지 않습니다.\n${lines.join('\n')}`);
  }
  return parsed.data;
}

export interface Modes {
  llm: AppConfig['LLM_MODE'];
  publish: AppConfig['PUBLISH_MODE'];
  collectors: AppConfig['COLLECTOR_MODE'];
}

export function getModes(config: AppConfig): Modes {
  return { llm: config.LLM_MODE, publish: config.PUBLISH_MODE, collectors: config.COLLECTOR_MODE };
}

export interface ModeBadge {
  key: keyof Modes;
  label: string;
  /** 외부 효과가 가능한 상태면 true (UI 강조용) */
  live: boolean;
}

/** UI 배지용 한국어 라벨. 실제 상태를 그대로 보여 준다. */
export function describeModes(config: AppConfig): ModeBadge[] {
  return [
    { key: 'llm', label: `LLM: ${config.LLM_MODE === 'mock' ? '모의' : '실제'}`, live: config.LLM_MODE === 'live' },
    {
      key: 'publish',
      label: `게시: ${config.PUBLISH_MODE === 'enabled' ? '활성' : '비활성'}`,
      live: config.PUBLISH_MODE === 'enabled',
    },
    {
      key: 'collectors',
      label: `수집: ${config.COLLECTOR_MODE === 'enabled' ? '활성' : '비활성'}`,
      live: config.COLLECTOR_MODE === 'enabled',
    },
  ];
}
