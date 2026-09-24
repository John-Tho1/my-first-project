import { redirect } from 'next/navigation';
import { isLocalhostBaseUrl } from '@cs/domain';
import { getSession } from '../../lib/auth';
import { getConfig } from '../../lib/server';

export const dynamic = 'force-dynamic';

/** ?error= 코드별 고정 문구. 입력값이나 허용 식별자를 되돌려 보여 주지 않는다. */
const ERROR_TEXT: Record<string, string> = {
  denied: '로그인할 수 없습니다. 입력한 정보를 확인하세요.',
  invalid: '요청 형식이 올바르지 않습니다. 다시 시도하세요.',
  csrf: '요청 출처를 확인할 수 없어 거부했습니다. 이 화면에서 다시 시도하세요.',
  unavailable: '운영 인증은 아직 설정되지 않았습니다(T13)',
  not_allowed: '개발용 로그인은 localhost 에서만 허용됩니다.',
  server: '서버 오류가 발생했습니다. 잠시 후 다시 시도하세요.',
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (await getSession()) redirect('/');
  const config = getConfig();
  const params = await searchParams;
  const code = typeof params.error === 'string' ? params.error : null;
  const errorText = code ? (ERROR_TEXT[code] ?? ERROR_TEXT.denied) : null;
  const devAllowed = config.AUTH_MODE === 'dev' && isLocalhostBaseUrl(config.APP_BASE_URL);

  return (
    <main className="container narrow">
      <header className="header">
        <h1>Content Studio</h1>
      </header>
      <section className="card">
        <h2 className="screen-title">로그인</h2>
        {config.AUTH_MODE === 'oidc' ? (
          <p className="notice">운영 인증은 아직 설정되지 않았습니다(T13)</p>
        ) : !devAllowed ? (
          <p className="notice">개발용 로그인(AUTH_MODE=dev)은 APP_BASE_URL 이 localhost 또는 127.0.0.1 일 때만 허용됩니다.</p>
        ) : (
          <>
            <p className="muted-text">
              개발용 로그인(AUTH_MODE=dev): 허용된 식별자 1개만 접속할 수 있습니다. 비밀번호 없음, localhost 전용.
            </p>
            {errorText ? (
              <p className="notice" role="alert">
                {errorText}
              </p>
            ) : null}
            <form className="form" method="post" action="/api/auth/login">
              <label htmlFor="identity">식별자</label>
              <input id="identity" name="identity" type="text" autoComplete="username" required maxLength={320} />
              <button type="submit">로그인</button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
