/**
 * T21-P1b: OIDC 로그인 서버 헬퍼 — 클라이언트(discovery 캐시) 보관, 준비 상태 표시, 감사 사유.
 * 클라이언트는 설정 지문(비밀 포함 해시)이 같으면 재사용한다(discovery·JWKS 캐시). 네트워크는 호출 시점의 globalThis.fetch
 * (시험은 vi.stubGlobal 로 프로세스 안 가짜 IdP 를 넣는다).
 */
import { oidcClientSettings, oidcLoginReadiness, type AppConfig, type OidcLoginReadiness } from '@cs/domain';
import { OidcLoginClient } from '@cs/providers';

let current: { fingerprint: string; client: OidcLoginClient } | null = null;

/** FIX-T21P1B(P2 login/page.tsx:61): 준비 안 됨 로그의 프로세스당 간격(같은 이름 목록은 1분에 한 번). */
export const OIDC_NOT_CONFIGURED_LOG_INTERVAL_MS = 60_000;
let lastNotConfiguredLog: { key: string; at: number } | null = null;

/**
 * 빠진 설정 **이름**만 서버 로그에 남긴다(값 없음). 로그인 화면·시작 경로가 함께 쓴다. 같은 목록이면 1분에 한 번 — 인증 없는 경로의
 * 반복 요청이 로그를 채우지 못하게. 목록이 바뀌면 바로 다시 남긴다.
 */
export function warnOidcNotConfigured(missing: readonly string[], now: number = Date.now()): void {
  const key = missing.join(', ');
  if (lastNotConfiguredLog && lastNotConfiguredLog.key === key && now - lastNotConfiguredLog.at < OIDC_NOT_CONFIGURED_LOG_INTERVAL_MS) return;
  lastNotConfiguredLog = { key, at: now };
  console.warn(`[auth] oidc_not_configured: ${key}`);
}

/** 준비된 설정의 클라이언트(준비 안 됐으면 OidcNotConfiguredError). */
export function getOidcLoginClient(config: AppConfig, env: Record<string, string | undefined> = process.env): OidcLoginClient {
  const settings = oidcClientSettings(config, env);
  const fingerprint = OidcLoginClient.fingerprint(settings);
  if (!current || current.fingerprint !== fingerprint) current = { fingerprint, client: new OidcLoginClient(settings) };
  return current.client;
}

/** 시험용: 보관한 클라이언트(discovery 캐시)를 버린다. */
export function resetOidcLoginClientForTests(): void {
  current = null;
  lastNotConfiguredLog = null;
}

/** 화면(설정)·health details 용 — 모드와 빠진 설정 이름만(값 없음). */
export function oidcReadinessView(config: AppConfig, env: Record<string, string | undefined> = process.env): { mode: AppConfig['AUTH_MODE'] } & OidcLoginReadiness {
  const r = oidcLoginReadiness(config, env);
  return { mode: config.AUTH_MODE, ready: r.ready, missing: r.missing };
}
