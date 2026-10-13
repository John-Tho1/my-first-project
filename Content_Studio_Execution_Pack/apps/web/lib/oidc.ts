/**
 * T21-P1b: OIDC 로그인 서버 헬퍼 — 클라이언트(discovery 캐시) 보관, 준비 상태 표시, 감사 사유.
 * 클라이언트는 설정 지문(비밀 포함 해시)이 같으면 재사용한다(discovery·JWKS 캐시). 네트워크는 호출 시점의 globalThis.fetch
 * (시험은 vi.stubGlobal 로 프로세스 안 가짜 IdP 를 넣는다).
 */
import { oidcClientSettings, oidcLoginReadiness, type AppConfig, type OidcLoginReadiness } from '@cs/domain';
import { OidcLoginClient } from '@cs/providers';

let current: { fingerprint: string; client: OidcLoginClient } | null = null;

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
}

/** 화면(설정)·health details 용 — 모드와 빠진 설정 이름만(값 없음). */
export function oidcReadinessView(config: AppConfig, env: Record<string, string | undefined> = process.env): { mode: AppConfig['AUTH_MODE'] } & OidcLoginReadiness {
  const r = oidcLoginReadiness(config, env);
  return { mode: config.AUTH_MODE, ready: r.ready, missing: r.missing };
}
