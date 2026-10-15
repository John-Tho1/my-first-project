import { redirect } from 'next/navigation';
import { isLocalhostBaseUrl, OIDC_START_PATH, oidcLoginReadiness } from '@cs/domain';
import { getSession } from '../../lib/auth';
import { warnOidcNotConfigured } from '../../lib/oidc';
import { getConfig } from '../../lib/server';

export const dynamic = 'force-dynamic';

/** ?error= 코드별 고정 문구. 입력값이나 허용 식별자를 되돌려 보여 주지 않는다. */
const ERROR_TEXT: Record<string, string> = {
  denied: '로그인할 수 없습니다. 입력한 정보를 확인하세요.',
  invalid: '요청 형식이 올바르지 않습니다. 다시 시도하세요.',
  csrf: '요청 출처를 확인할 수 없어 거부했습니다. 이 화면에서 다시 시도하세요.',
  identity_login_disabled: '이 서버는 OIDC 로그인만 허용합니다. 아래 "OIDC로 로그인"을 쓰세요.',
  // T21-P1b: OIDC 로그인 오류(코드별 고정 문구 — IdP 응답·이메일 값을 보여 주지 않는다)
  oidc_not_configured: 'OIDC 로그인 설정이 준비되지 않았습니다. 서버 설정을 확인하세요.',
  oidc_state_invalid: '로그인 요청을 확인할 수 없습니다(만료·이미 사용·다른 브라우저). 다시 시작하세요.',
  oidc_login_invalid: 'OIDC 로그인 응답을 확인하지 못했습니다. 다시 시작하세요.',
  oidc_identity_denied: '이 계정으로는 로그인할 수 없습니다.',
  oidc_provider_unavailable: '인증 공급자(IdP)와 통신하지 못했습니다. 잠시 후 다시 시도하세요.',
  oidc_cancelled: '인증 공급자에서 로그인이 취소되었습니다.',
  not_allowed: '개발용 로그인은 localhost 에서만 허용됩니다.',
  production_dev: '운영 빌드에서는 개발용 로그인을 쓸 수 없습니다.',
  rate_limited: '로그인 시도가 너무 많습니다. 잠시 뒤(최대 15분) 다시 시도하세요.',
  server: '서버 오류가 발생했습니다. 잠시 후 다시 시도하세요.',
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (await getSession()) redirect('/');
  const config = getConfig();
  const params = await searchParams;
  const code = typeof params.error === 'string' ? params.error : null;
  const errorText = code ? (ERROR_TEXT[code] ?? ERROR_TEXT.denied) : null;
  const devAllowed = config.AUTH_MODE === 'dev' && isLocalhostBaseUrl(config.APP_BASE_URL);
  // T21-P1b: 준비 여부만 본다(빠진 설정 이름은 로그인 전 화면에 보여 주지 않는다 — 서버 로그·로그인 후 설정 화면).
  const oidcReadiness = config.AUTH_MODE === 'oidc' ? oidcLoginReadiness(config, process.env) : null;
  const oidcReady = oidcReadiness?.ready === true;
  // FIX-T21P1B(P2): 화면이 안내하는 서버 로그를 실제로 남긴다(이름만, 프로세스당 1분에 한 번)
  if (oidcReadiness && !oidcReadiness.ready) warnOidcNotConfigured(oidcReadiness.missing);
  const errorBlock = errorText ? (
    <p className="notice" role="alert">
      {errorText}
    </p>
  ) : null;

  return (
    <main className="container narrow">
      <header className="header">
        <h1>Content Studio</h1>
      </header>
      <section className="card">
        <h2 className="screen-title">로그인</h2>
        {config.AUTH_MODE === 'oidc' ? (
          oidcReady ? (
            <>
              <p className="muted-text">OpenID Connect 로그인: 허용된 계정 1개만 접속할 수 있습니다. 인증 공급자(IdP) 화면으로 이동합니다.</p>
              {errorBlock}
              <form className="form" method="get" action={OIDC_START_PATH}>
                <button type="submit" className="primary">OIDC로 로그인</button>
              </form>
            </>
          ) : (
            <>
              {errorBlock}
              <p className="notice">OIDC 로그인 설정이 준비되지 않았습니다. 서버 설정을 확인하세요(빠진 설정 이름은 서버 로그에 남습니다).</p>
            </>
          )
        ) : !devAllowed ? (
          <p className="notice">개발용 로그인(AUTH_MODE=dev)은 APP_BASE_URL 이 localhost 또는 127.0.0.1 일 때만 허용됩니다.</p>
        ) : (
          <>
            <p className="muted-text">
              개발용 로그인(AUTH_MODE=dev): 허용된 식별자 1개만 접속할 수 있습니다. 비밀번호 없음, localhost 전용(운영 빌드에서는 거부).
            </p>
            {errorBlock}
            <form className="form" method="post" action="/api/auth/login">
              <label htmlFor="identity">식별자</label>
              <input id="identity" name="identity" type="text" autoComplete="username" required maxLength={320} />
              <button type="submit" className="primary">로그인</button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
