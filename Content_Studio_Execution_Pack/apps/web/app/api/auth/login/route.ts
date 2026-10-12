import { countRecentLoginFailures, createSession, ensureOwner, recordAudit } from '@cs/db';
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
  LOGIN_FAILURE_REASONS,
  LOGIN_FAILURE_WINDOW_MS,
  LoginDeniedError,
  loginInputSchema,
  LoginRateLimitedError,
  OidcNotConfiguredError,
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
  if (e instanceof OidcNotConfiguredError) return 'unavailable';
  if (e instanceof DevLoginNotAllowedError) return 'not_allowed';
  if (e instanceof DevLoginRefusedInProductionError) return 'production_dev';
  if (e instanceof LoginRateLimitedError) return 'rate_limited';
  if (e instanceof CsrfError) return 'csrf';
  if (e instanceof AppError) return 'invalid';
  return 'server';
}

/**
 * POST /api/auth/login — AUTH_MODE=dev(D3): 허용 식별자 1개와 일치하면 세션을 만든다. 비밀번호 없음, localhost 전용.
 * T21-P1a: 운영 빌드에서는 dev 로그인 503(dev_login_refused_in_production), 최근 15분 실패 10회 이상이면 429(login_rate_limited).
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
    const now = new Date();

    try {
      assertLoginAvailable(config, process.env.NODE_ENV);
    } catch (e) {
      if (e instanceof AppError) await recordAudit(db, denied(e.code, now));
      throw e;
    }

    // T21-P1a: 전역 시도 횟수 제한 — 식별자를 보기 전에 판정하므로 맞는 식별자든 틀린 식별자든 같은 429(식별자 존재 여부 비노출).
    // 429 자체는 감사 기록을 남기지 않는다(막힌 동안 요청마다 행이 쌓이지 않게).
    assertLoginNotRateLimited(
      await countRecentLoginFailures(db, { now, windowMs: LOGIN_FAILURE_WINDOW_MS, reasons: LOGIN_FAILURE_REASONS }),
    );

    let identity: string;
    try {
      identity = await parseIdentity(request);
    } catch (e) {
      await recordAudit(db, denied('invalid_request', now));
      throw e;
    }
    if (!identityMatches(identity, config.AUTH_ALLOWED_IDENTITY)) {
      // 어떤 식별자가 허용되는지·입력값이 무엇이었는지는 기록·응답하지 않는다.
      await recordAudit(db, denied('identity_mismatch', now));
      throw new LoginDeniedError();
    }

    const owner = await ensureOwner(db, config.AUTH_ALLOWED_IDENTITY);
    const token = generateSessionToken();
    const session = await createSession(db, {
      ownerId: owner.id,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(now.getTime() + sessionTtlMs(config)),
      userAgentHash: hashUserAgent(request.headers.get('user-agent')),
      now,
    });
    await recordAudit(db, {
      ownerId: owner.id,
      action: 'auth.login',
      entity: 'session',
      entityId: session.id,
      details: { mode: config.AUTH_MODE },
      at: now,
    });

    const headers = { 'set-cookie': buildSessionCookie(token, config) };
    if (html) return seeOther('/', headers);
    return json({ ok: true, expires_at: session.expiresAt.toISOString() }, { headers });
  } catch (e) {
    if (html) return seeOther(`/login?error=${loginErrorCode(e)}`);
    return errorResponse(e, request);
  }
}

/** 시각은 횟수 제한이 쓰는 시계(now)와 같게 명시한다. */
function denied(reason: string, at: Date) {
  return { ownerId: null, action: 'auth.login_denied' as const, entity: 'session', details: { reason }, at };
}
