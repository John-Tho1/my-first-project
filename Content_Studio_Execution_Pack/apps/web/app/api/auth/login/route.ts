import { countRecentLoginFailures, createSession, ensureOwner, recordAudit, withLoginAttemptLock } from '@cs/db';
import {
  AppError,
  assertLoginAvailable,
  assertLoginNotRateLimited,
  assertSameOrigin,
  BadRequestError,
  buildSessionCookie,
  CsrfError,
  devAuthRefusedByRuntime,
  DevLoginNotAllowedError,
  DevLoginRefusedInProductionError,
  generateSessionToken,
  hashSessionToken,
  hashUserAgent,
  identityMatches,
  IdentityLoginDisabledError,
  LOGIN_FAILURE_REASONS,
  LOGIN_FAILURE_WINDOW_MS,
  LoginDeniedError,
  loginInputSchema,
  LoginRateLimitedError,
  LoginSequenceExhaustedError,
  sessionTtlMs,
} from '@cs/domain';
import { errorResponse, json, readBodyCapped, seeOther, wantsHtml } from '../../../../lib/api';
import { getAppDb, getConfig } from '../../../../lib/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_LOGIN_BODY = 8 * 1024;

async function parseIdentity(request: Request): Promise<string> {
  const bytes = await readBodyCapped(request, MAX_LOGIN_BODY);
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  let raw: unknown;
  try {
    if (type.startsWith('application/json')) {
      raw = JSON.parse(new TextDecoder().decode(bytes));
    } else if (type.startsWith('application/x-www-form-urlencoded') || type.startsWith('multipart/form-data')) {
      const form = await new Response(bytes, { headers: { 'content-type': type } }).formData();
      raw = { identity: form.get('identity') };
    } else {
      throw new BadRequestError();
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new BadRequestError();
  }
  const parsed = loginInputSchema.safeParse(raw);
  if (!parsed.success) throw new BadRequestError();
  return parsed.data.identity.trim();
}

/** 폼 제출 실패 시 /login?error=<코드>. 페이지는 코드별 고정 문구만 보여 준다(입력값을 되돌려 보여 주지 않음). */
function loginErrorCode(e: unknown): string {
  if (e instanceof LoginDeniedError) return 'denied';
  if (e instanceof IdentityLoginDisabledError) return 'identity_login_disabled';
  if (e instanceof DevLoginNotAllowedError) return 'not_allowed';
  if (e instanceof DevLoginRefusedInProductionError) return 'production_dev';
  if (e instanceof LoginRateLimitedError) return 'rate_limited';
  if (e instanceof LoginSequenceExhaustedError) return 'server';
  if (e instanceof CsrfError) return 'csrf';
  if (e instanceof AppError) return 'invalid';
  return 'server';
}

/**
 * POST /api/auth/login — AUTH_MODE=dev(D3): 허용 식별자 1개와 일치하면 세션을 만든다. 비밀번호 없음, localhost 전용.
 * T21-P1a: 운영 빌드에서는 dev 로그인 503(dev_login_refused_in_production), 최근 15분 실패 10회 이상이면 429(login_rate_limited).
 * T21-P1b: AUTH_MODE=oidc 이면 403 identity_login_disabled(OIDC 로그인은 GET /api/auth/oidc/start → callback). 실패 횟수는 OIDC callback 실패와 함께 센다.
 * 응답: JSON 클라이언트는 200 {ok, expires_at} / 401 / 403 / 429 / 503, 브라우저 폼은 303(/ 또는 /login?error=…).
 * GET 등 다른 메서드는 정의하지 않는다(Next 가 405).
 */
export async function POST(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  try {
    // T21-P1a(G1a): 운영 빌드에서 dev 로그인이면 설정·DB 를 읽기 전에 거부한다. `process.env.NODE_ENV` 는 Next 빌드가
    // 상수로 고정하므로(운영 빌드 = 'production') 실행할 때 NODE_ENV 를 바꿔도 풀리지 않는다.
    if (devAuthRefusedByRuntime({ AUTH_MODE: process.env.AUTH_MODE, NODE_ENV: process.env.NODE_ENV })) {
      throw new DevLoginRefusedInProductionError();
    }
    const config = getConfig();
    assertSameOrigin(request, config);
    const { db } = await getAppDb(config);

    try {
      assertLoginAvailable(config, process.env.NODE_ENV);
    } catch (e) {
      if (e instanceof AppError) await recordAudit(db, denied(e.code, new Date()));
      throw e;
    }

    const limit = { windowMs: LOGIN_FAILURE_WINDOW_MS, reasons: LOGIN_FAILURE_REASONS };
    // T21-P1a: 전역 시도 횟수 제한 — 식별자를 보기 전에 판정하므로 맞는 식별자든 틀린 식별자든 같은 429(식별자 존재 여부 비노출).
    // 429 자체는 감사 기록을 남기지 않는다(막힌 동안 요청마다 행이 쌓이지 않게).
    // 이 조기 검사는 막힌 동안 본문을 읽지 않으려는 값싼 거름이고, 보장은 아래 잠금 안 재검사다(FIX-T21P1A P1).
    assertLoginNotRateLimited(await countRecentLoginFailures(db, { now: new Date(), ...limit }));

    // 본문은 잠금 밖에서 읽는다(느린 본문이 전역 잠금을 붙잡지 않게). 실패는 잠금 안에서 기록한다.
    let identity: string | null = null;
    let parseError: unknown = null;
    try {
      identity = await parseIdentity(request);
    } catch (e) {
      parseError = e;
    }

    // FIX-T21P1A(P1·P2): 재검사(잠금을 얻은 뒤의 시각으로) → 판정 → 성공·실패 기록을 전역 잠금 한 트랜잭션에서 직렬화한다.
    // 기록에는 로그인 순번(versionOrHash)을 붙여 같은 ms 의 성공·실패도 기록 순서로 가린다.
    const outcome = await withLoginAttemptLock(db, limit, async (tx, { now, failures, seq }) => {
      assertLoginNotRateLimited(failures); // 던지면 트랜잭션은 아무것도 쓰지 않은 채 되돌려진다
      if (parseError !== null || identity === null) {
        await recordAudit(tx, denied('invalid_request', now, seq));
        return { kind: 'invalid' as const };
      }
      if (!identityMatches(identity, config.AUTH_ALLOWED_IDENTITY)) {
        // 어떤 식별자가 허용되는지·입력값이 무엇이었는지는 기록·응답하지 않는다.
        await recordAudit(tx, denied('identity_mismatch', now, seq));
        return { kind: 'denied' as const };
      }
      const owner = await ensureOwner(tx, config.AUTH_ALLOWED_IDENTITY);
      const token = generateSessionToken();
      const session = await createSession(tx, {
        ownerId: owner.id,
        tokenHash: hashSessionToken(token),
        expiresAt: new Date(now.getTime() + sessionTtlMs(config)),
        userAgentHash: hashUserAgent(request.headers.get('user-agent')),
        now,
      });
      await recordAudit(tx, {
        ownerId: owner.id,
        action: 'auth.login',
        entity: 'session',
        entityId: session.id,
        versionOrHash: seq,
        details: { mode: config.AUTH_MODE },
        at: now,
      });
      return { kind: 'ok' as const, token, session };
    });
    if (outcome.kind === 'invalid') throw parseError instanceof AppError ? parseError : new BadRequestError();
    if (outcome.kind === 'denied') throw new LoginDeniedError();
    const { token, session } = outcome;

    const headers = { 'set-cookie': buildSessionCookie(token, config) };
    if (html) return seeOther('/', headers);
    return json({ ok: true, expires_at: session.expiresAt.toISOString() }, { headers });
  } catch (e) {
    if (html) return seeOther(`/login?error=${loginErrorCode(e)}`);
    return errorResponse(e, request);
  }
}

/** 시각은 횟수 제한이 쓰는 시계(now)와 같게 명시한다. seq = 로그인 순번(잠금 안 판정 기록만, FIX-T21P1A P2). */
function denied(reason: string, at: Date, seq?: string) {
  return {
    ownerId: null,
    action: 'auth.login_denied' as const,
    entity: 'session',
    details: { reason },
    at,
    ...(seq === undefined ? {} : { versionOrHash: seq }),
  };
}
