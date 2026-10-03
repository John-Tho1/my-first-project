/**
 * T16(제안 결정 D29) Instagram 모의 채널 — 프로세스 안 시뮬레이터 + ChannelAdapter. **네트워크·실제 Instagram/Meta 호출 없음.**
 *
 * InstagramMockApi(시뮬레이터): 공개 자료 수준의 Instagram 콘텐츠 게시 흐름(미디어 컨테이너 → 상태 확인 → media_publish)을 흉내 낸다.
 * 세부 경로·필드 이름·한도는 **공식 재확인 전**(docs/03 "[공식자료·부분 확인]") — 모의 모양일 뿐 실제 API 계약이 아니다.
 * - createImageContainer(image_url, caption | is_carousel_item) → `mockig_ct_<uuid>` · createCarouselContainer(children, caption) → 부모 컨테이너
 *   · getContainer(IN_PROGRESS → FINISHED|ERROR, 만료 EXPIRED, 게시 뒤 PUBLISHED) · publish(creation_id) → `mockig_m_<uuid>`
 *   · getMedia → permalink `mock://instagram/p/<id>`·visibility(모의 계정 공개 범위) · findPublishedByContainer
 *   · findCarouselByChildren(자식 목록 → 그 자식으로 만든 부모 컨테이너 — FIX-T16 P1, **모의 가정**: 실제 API 에 같은 조회가 있는지 live 전 확인).
 * - FIX-T16(P0): applied 장애(원격은 동작을 끝낸 뒤 응답 실패)는 오류의 부작용을 항상 unknown 으로 싣는다. applied + sideEffect 'none' 은 모순 → 주입 거부.
 * - image_url 은 공개 미디어 URL 창구(MockPublicMediaUrlProvider)가 발급한 `mock://public-media/…` 만 "가져올" 수 있다 — 같은 프로세스에서 저장소 창구로
 *   파일을 읽어 원격 규격(잠정 — JPEG·크기·비율·가로)을 다시 검사하고 400 invalid_image_spec 으로 거부할 수 있다. 받은 이미지는 sha256 만 남긴다.
 * - 사용자별 게시 예산(429 + retry-after), 오류 종류 401 auth_invalid_token · 403 permission_denied · 400 invalid_parameter · 404 not_found ·
 *   429 rate_limited · 5xx server_error(side_effect none|unknown) · timeout.
 * - 토큰은 Meta 형 모의 OAuth 가 발급한 Instagram 토큰(`mockig_at_`, 해제·만료 아님, 같은 사용자)만. 토큰·공개 URL 은 오류·호출 기록에 남기지 않는다.
 * - 같은 컨테이너의 두 번째 게시는 거절(container_already_published) — 게시물이 두 개 생기지 않는다는 **모의 가정**(실제 동작은 live 전 확인).
 *
 * InstagramMockChannelAdapter(adapter id 'mock_instagram'): 선택 규칙은 @cs/domain adapterIdFor(모의 + instagram + credential_state ≠ none).
 * - 보내기 전(원격 호출 0): 승인 스냅샷의 첨부를 MediaPort 로 열어 잠정 규격(@cs/domain instagramSpecProblems)을 다시 검사 — 어긋나면 FAILED(재시도 없음).
 *   FIX-T16(P0): 이미지마다 **실제로 읽은 바이트 전체의 sha256 = 승인 checksum** 인지 확인(하나라도 다르면 asset_checksum_mismatch:<order> FAILED,
 *   원격 호출·URL 발급 0). 공개 URL 창구에는 그 확인한 바이트(메모리 사본)만 넘긴다 — 확인 뒤 저장소가 바뀌어도 원격이 받는 바이트는 승인한 것.
 * - FIX-T16(P0): 쓰기(컨테이너·부모·게시)의 5xx·시간 초과는 모두 결과 불명(ambiguous → 조회). 다시 보내기는 조회가 "안 됨"을 확인한 뒤에만(A08).
 * - FIX-T16(P1): 캐러셀 부모를 만들기 **전에** ig_parent_request 단계(요청 표식)를 남긴다. 부모 ID 를 잃으면(응답 유실·기록 실패) 조회·재시도가
 *   기록한 자식으로 부모를 찾아 기록하고, 찾지 못한 게 확실할 때만 다시 만든다. 찾기 실패(원격 기록 없음 등) → unknown. 쓰인 자식으로 두 번째 부모를 만들지 않는다.
 * - 단일 이미지: [공개 URL 발급 → 컨테이너(post_index 0) → URL 철회 → 단계 기록 → FINISHED 까지 조회 → 게시 → 게시 단계 기록].
 *   캐러셀(이미지 2~10): 자식 컨테이너(post_index 1..n, is_carousel_item)마다 같은 순서 → 자식이 모두 FINISHED → 부모 컨테이너(post_index 0) → 게시.
 *   **원격 참조는 다음 원격 호출 전에 기록**(ctx.steps). 재개·재확인은 기록을 먼저 읽고, 있는 컨테이너는 다시 만들지 않으며 게시된 것은 다시 게시하지 않는다(A08).
 * - 조회 예산 안에 FINISHED 가 안 되면 processing(REMOTE_PROCESSING) — 다음 조회·재개가 같은 컨테이너로 이어 간다.
 * - 결과는 모의(MOCK): publication external_id = 'mock:instagram:<미디어 ID>', permalink = 'mock://instagram/p/<미디어 ID>', 결과 PUBLISHED/public
 *   (Instagram 은 비공개·예약 결과를 다루지 않는다 — 계정 공개 범위를 따름, 모의 가정).
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  imageDimensions,
  INSTAGRAM_PROVISIONAL_MEDIA_SPEC,
  instagramCaptionProblems,
  instagramMediaFacts,
  instagramMediaProblems,
  instagramSpecProblems,
  isInstagramMockScenario,
  LeaseLostError,
  PUBLIC_MEDIA_URL_TTL_MS,
  type AdapterAccount,
  type AdapterCapabilities,
  type AdapterContext,
  type AdapterResult,
  type CancelResult,
  type ChannelAdapter,
  type ChannelRateLimit,
  type InstagramMediaSpec,
  type MediaFile,
  type MockScenarioValue,
  type PreparedSubmission,
  type PublishSnapshot,
  type ReconcileResult,
  type RemoteReference,
  type RemoteStep,
} from '@cs/domain';
import { mockOAuthStore, type MockOAuthStore } from './oauth';
import { mockPublicMediaUrlProvider, type MockPublicMediaUrlProvider } from './public-media';

// ---- 시뮬레이터 ----

export const INSTAGRAM_MOCK_CONTAINER_PREFIX = 'mockig_ct_';
export const INSTAGRAM_MOCK_MEDIA_PREFIX = 'mockig_m_';

export const INSTAGRAM_ERROR_KINDS = ['auth_invalid_token', 'permission_denied', 'invalid_parameter', 'not_found', 'rate_limited', 'server_error', 'timeout'] as const;
export type InstagramErrorKind = (typeof INSTAGRAM_ERROR_KINDS)[number];
export const INSTAGRAM_ERROR_HTTP: Record<InstagramErrorKind, number | null> = {
  auth_invalid_token: 401,
  permission_denied: 403,
  invalid_parameter: 400,
  not_found: 404,
  rate_limited: 429,
  server_error: 503,
  timeout: null,
};

export type InstagramContainerStatus = 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED' | 'PUBLISHED';
export type InstagramOp = 'createImageContainer' | 'createCarouselContainer' | 'getContainer' | 'publish' | 'getMedia' | 'findPublishedByContainer' | 'findCarouselByChildren';
const WRITE_OPS: readonly InstagramOp[] = ['createImageContainer', 'createCarouselContainer', 'publish'];

/** 시뮬레이터 오류 — 메시지는 종류·코드만(토큰·URL·본문 없음). */
export class InstagramMockApiError extends Error {
  readonly httpStatus: number | null;
  constructor(
    readonly kind: InstagramErrorKind,
    readonly opts: { code?: string; sideEffect?: 'none' | 'unknown'; retryAfterSec?: number } = {},
  ) {
    super(`mock instagram api error: ${kind}${opts.code ? ` (${opts.code})` : ''}`);
    this.name = 'InstagramMockApiError';
    this.httpStatus = INSTAGRAM_ERROR_HTTP[kind];
  }
  get code(): string {
    return this.opts.code ?? this.kind;
  }
  get sideEffect(): 'none' | 'unknown' {
    if (this.kind === 'timeout') return 'unknown';
    return this.opts.sideEffect ?? 'none';
  }
}

/** 한 번 일어나는 장애. applied = 원격은 동작을 끝낸 뒤 응답이 실패(응답 유실·쓰기 뒤 5xx). */
export interface InstagramFault {
  op: InstagramOp;
  kind: InstagramErrorKind;
  applied?: boolean;
  sideEffect?: 'none' | 'unknown';
  retryAfterSec?: number;
  code?: string;
  userId?: string;
}

interface Container {
  id: string;
  userId: string;
  type: 'IMAGE' | 'CAROUSEL_ITEM' | 'CAROUSEL';
  caption: string | null;
  children: string[];
  /** 가져온 이미지의 sha256(이미지 컨테이너만) */
  imageSha256: string | null;
  status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED';
  pollsLeft: number;
  /** 처리 결과(조회가 끝났을 때): FINISHED | ERROR */
  outcome: 'FINISHED' | 'ERROR';
  usedAsChild: boolean;
  publishedMediaId: string | null;
  createdAt: string;
}

export interface InstagramMockMedia {
  id: string;
  userId: string;
  containerId: string;
  mediaType: 'IMAGE' | 'CAROUSEL_ALBUM';
  caption: string | null;
  imageSha256: string[];
  permalink: string;
  /** 게시 때 계정 공개 범위(모의 — 기본 public) */
  visibility: 'public' | 'private';
  timestamp: string;
}

const sha = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');

export type InstagramTokenCheck = (accessToken: string, userId: string, now: Date) => boolean;

/** T16 모의 OAuth(Meta 형)가 발급한 Instagram 토큰인지(해제·만료 아님, 같은 사용자). */
export function mockInstagramTokenCheck(store: MockOAuthStore = mockOAuthStore()): InstagramTokenCheck {
  return (accessToken, userId, now) => {
    if (typeof accessToken !== 'string' || !accessToken.startsWith('mockig_at_')) return false;
    const t = store.tokens.get(sha(accessToken));
    return !!t && t.provider === 'mock_instagram' && !t.revoked && t.expiresAt > now.getTime() && t.user === userId;
  };
}

export class InstagramMockApi {
  private readonly containers = new Map<string, Container>();
  private readonly media = new Map<string, InstagramMockMedia>();
  private readonly budgets = new Map<string, { remaining: number; retryAfterSec: number }>();
  /** 모의 계정 공개 범위(없으면 public — 모의 계정은 공개 계정으로 정의) */
  private readonly accountVisibility = new Map<string, 'public' | 'private'>();
  private faults: InstagramFault[] = [];
  private tokenCheck: InstagramTokenCheck;
  readonly publicMedia: MockPublicMediaUrlProvider;
  /** 원격이 다시 검사하는 규격(시험이 바꿀 수 있다 — 앱 규격과 다른 원격을 흉내) */
  remoteSpec: InstagramMediaSpec;
  readonly calls: Record<InstagramOp, number> = {
    createImageContainer: 0,
    createCarouselContainer: 0,
    getContainer: 0,
    publish: 0,
    getMedia: 0,
    findPublishedByContainer: 0,
    findCarouselByChildren: 0,
  };
  /** 컨테이너별 게시 수(설계상 항상 ≤ 1) */
  readonly publishCount = new Map<string, number>();

  constructor(opts: { tokenCheck?: InstagramTokenCheck; publicMedia?: MockPublicMediaUrlProvider; remoteSpec?: InstagramMediaSpec } = {}) {
    this.tokenCheck = opts.tokenCheck ?? mockInstagramTokenCheck();
    this.publicMedia = opts.publicMedia ?? mockPublicMediaUrlProvider();
    this.remoteSpec = opts.remoteSpec ?? { ...INSTAGRAM_PROVISIONAL_MEDIA_SPEC };
  }

  setTokenCheck(check: InstagramTokenCheck): void {
    this.tokenCheck = check;
  }

  setRateBudget(userId: string, remaining: number, retryAfterSec = 60): void {
    this.budgets.set(userId, { remaining, retryAfterSec });
  }

  clearRateBudget(userId: string): void {
    this.budgets.delete(userId);
  }

  /** 시험: 모의 계정의 공개 범위(게시 결과에 실린다). */
  setAccountVisibility(userId: string, visibility: 'public' | 'private'): void {
    this.accountVisibility.set(userId, visibility);
  }

  /** applied(원격이 끝냄) + sideEffect 'none' 은 모순이라 거부한다(FIX-T16 P0 — 적용된 쓰기를 "부작용 없음"으로 꾸미지 않는다). */
  injectFault(f: InstagramFault): void {
    if (f.applied && f.sideEffect === 'none') throw new Error('injectFault: applied 장애는 sideEffect none 일 수 없습니다');
    this.faults.push({ ...f });
  }

  /** 게시되지 않은 컨테이너를 만료시킨다(시험). */
  expireContainer(id: string): void {
    const c = this.containers.get(id);
    if (c && !c.publishedMediaId) c.status = 'EXPIRED';
  }

  /** 전부 비운다("재시작" 흉내). 토큰 검사·공개 URL 창구는 유지. */
  reset(): void {
    this.containers.clear();
    this.media.clear();
    this.budgets.clear();
    this.accountVisibility.clear();
    this.faults = [];
    this.publishCount.clear();
    this.remoteSpec = { ...INSTAGRAM_PROVISIONAL_MEDIA_SPEC };
    for (const k of Object.keys(this.calls) as InstagramOp[]) this.calls[k] = 0;
  }

  containerIds(userId?: string): string[] {
    return [...this.containers.values()].filter((c) => !userId || c.userId === userId).map((c) => c.id);
  }

  containerOf(id: string): { type: Container['type']; children: string[]; imageSha256: string | null; usedAsChild: boolean } | null {
    const c = this.containers.get(id);
    return c ? { type: c.type, children: [...c.children], imageSha256: c.imageSha256, usedAsChild: c.usedAsChild } : null;
  }

  mediaOf(userId?: string): InstagramMockMedia[] {
    return [...this.media.values()].filter((m) => !userId || m.userId === userId).map((m) => ({ ...m, imageSha256: [...m.imageSha256] }));
  }

  private auth(accessToken: string, userId: string, now: Date): void {
    if (!this.tokenCheck(accessToken, userId, now)) throw new InstagramMockApiError('auth_invalid_token');
  }

  private takeFault(op: InstagramOp, userId: string, given?: InstagramFault | null): InstagramFault | null {
    if (given && given.op === op) {
      if (given.applied && given.sideEffect === 'none') throw new Error('fault: applied 장애는 sideEffect none 일 수 없습니다');
      return given;
    }
    const i = this.faults.findIndex((f) => f.op === op && (!f.userId || f.userId === userId));
    if (i < 0) return null;
    return this.faults.splice(i, 1)[0]!;
  }

  /** applied 장애는 원격이 동작을 끝냈으므로 부작용 unknown 을 싣는다(생략·none 이 "부작용 없음"으로 읽히지 않게). */
  private fail(f: InstagramFault): never {
    throw new InstagramMockApiError(f.kind, { code: f.code, sideEffect: f.applied ? 'unknown' : f.sideEffect, retryAfterSec: f.retryAfterSec });
  }

  private run<T>(f: InstagramFault | null, action: () => T): T {
    if (f && !f.applied) this.fail(f);
    const out = action();
    if (f) this.fail(f);
    return out;
  }

  private async runAsync<T>(f: InstagramFault | null, action: () => Promise<T>): Promise<T> {
    if (f && !f.applied) this.fail(f);
    const out = await action();
    if (f) this.fail(f);
    return out;
  }

  private checkCaption(caption: string | null): void {
    if (caption !== null && instagramCaptionProblems(caption, this.remoteSpec).length > 0) throw new InstagramMockApiError('invalid_parameter', { code: 'caption_invalid' });
  }

  /** 공개 URL 에서 이미지를 "가져와" 원격 규격으로 검사(같은 프로세스 — 저장소 창구로만 읽는다). 받은 바이트의 sha256 을 돌려준다. */
  private async fetchImage(imageUrl: string, now: Date): Promise<string> {
    const got = this.publicMedia.resolve(imageUrl, now);
    if (!got) throw new InstagramMockApiError('invalid_parameter', { code: 'image_fetch_failed' });
    const f = got.file;
    const spec = this.remoteSpec;
    if (f.bytes <= 0 || f.bytes > spec.max_image_bytes) throw new InstagramMockApiError('invalid_parameter', { code: 'invalid_image_spec' });
    const bytes = await f.read(0, f.bytes);
    const dims = imageDimensions(bytes.subarray(0, Math.min(bytes.byteLength, spec.header_read_bytes)));
    const problems = instagramMediaProblems([{ order: 1, role: 'image', mime: dims ? `image/${dims.format}` : got.mime, bytes: f.bytes, width: dims?.width ?? null, height: dims?.height ?? null }], spec);
    if (problems.length) throw new InstagramMockApiError('invalid_parameter', { code: 'invalid_image_spec' });
    return createHash('sha256').update(bytes).digest('hex');
  }

  private newContainer(c: Omit<Container, 'id' | 'createdAt' | 'usedAsChild' | 'publishedMediaId'>, now: Date): Container {
    const full: Container = { ...c, id: `${INSTAGRAM_MOCK_CONTAINER_PREFIX}${randomUUID()}`, usedAsChild: false, publishedMediaId: null, createdAt: now.toISOString() };
    this.containers.set(full.id, full);
    return full;
  }

  /** 이미지 컨테이너(단일 이미지 게시물 또는 캐러셀 자식). 캐러셀 자식에는 캡션을 두지 않는다. */
  async createImageContainer(
    req: { userId: string; accessToken: string; imageUrl: string; caption?: string | null; isCarouselItem?: boolean; now?: Date },
    opts: { fault?: InstagramFault | null; finishAfterPolls?: number; outcome?: 'FINISHED' | 'ERROR' } = {},
  ): Promise<{ id: string; status: InstagramContainerStatus }> {
    this.calls.createImageContainer++;
    const now = req.now ?? new Date();
    this.auth(req.accessToken, req.userId, now);
    const f = this.takeFault('createImageContainer', req.userId, opts.fault);
    return this.runAsync(f, async () => {
      const item = req.isCarouselItem === true;
      if (item && req.caption) throw new InstagramMockApiError('invalid_parameter', { code: 'caption_on_carousel_item' });
      this.checkCaption(item ? null : (req.caption ?? ''));
      const imageSha256 = await this.fetchImage(req.imageUrl, now);
      const polls = Math.max(0, Math.floor(opts.finishAfterPolls ?? 0));
      const outcome = opts.outcome ?? 'FINISHED';
      const c = this.newContainer(
        {
          userId: req.userId,
          type: item ? 'CAROUSEL_ITEM' : 'IMAGE',
          caption: item ? null : (req.caption ?? ''),
          children: [],
          imageSha256,
          status: polls > 0 || outcome === 'ERROR' ? 'IN_PROGRESS' : 'FINISHED',
          pollsLeft: polls,
          outcome,
        },
        now,
      );
      return { id: c.id, status: c.status };
    });
  }

  /** 캐러셀 부모 컨테이너 — 자식은 같은 사용자의 FINISHED 캐러셀 항목이고 아직 다른 부모에 쓰이지 않아야 한다(2~10개, 잠정). */
  createCarouselContainer(
    req: { userId: string; accessToken: string; children: string[]; caption: string; now?: Date },
    opts: { fault?: InstagramFault | null; finishAfterPolls?: number; outcome?: 'FINISHED' | 'ERROR' } = {},
  ): { id: string; status: InstagramContainerStatus } {
    this.calls.createCarouselContainer++;
    const now = req.now ?? new Date();
    this.auth(req.accessToken, req.userId, now);
    const f = this.takeFault('createCarouselContainer', req.userId, opts.fault);
    return this.run(f, () => {
      this.checkCaption(req.caption);
      const spec = this.remoteSpec;
      if (req.children.length < spec.carousel_min_items || req.children.length > spec.carousel_max_items || new Set(req.children).size !== req.children.length) {
        throw new InstagramMockApiError('invalid_parameter', { code: 'invalid_children' });
      }
      const kids = req.children.map((id) => this.containers.get(id));
      if (kids.some((k) => !k || k.userId !== req.userId || k.type !== 'CAROUSEL_ITEM' || k.usedAsChild)) throw new InstagramMockApiError('invalid_parameter', { code: 'invalid_children' });
      if (kids.some((k) => k!.status !== 'FINISHED')) throw new InstagramMockApiError('invalid_parameter', { code: 'children_not_ready' });
      for (const k of kids) k!.usedAsChild = true;
      const polls = Math.max(0, Math.floor(opts.finishAfterPolls ?? 0));
      const outcome = opts.outcome ?? 'FINISHED';
      const c = this.newContainer(
        { userId: req.userId, type: 'CAROUSEL', caption: req.caption, children: [...req.children], imageSha256: null, status: polls > 0 || outcome === 'ERROR' ? 'IN_PROGRESS' : 'FINISHED', pollsLeft: polls, outcome },
        now,
      );
      return { id: c.id, status: c.status };
    });
  }

  private own(id: string, userId: string): Container {
    const c = this.containers.get(id);
    if (!c || c.userId !== userId) throw new InstagramMockApiError('not_found', { code: 'container_not_found' });
    return c;
  }

  /** 상태 조회. IN_PROGRESS 는 남은 조회 수만큼 계속되고 그다음 처리 결과(FINISHED|ERROR). 게시된 컨테이너는 PUBLISHED. */
  getContainer(req: { id: string; userId: string; accessToken: string; now?: Date }, opts: { fault?: InstagramFault | null } = {}): { id: string; status: InstagramContainerStatus } {
    this.calls.getContainer++;
    this.auth(req.accessToken, req.userId, req.now ?? new Date());
    const f = this.takeFault('getContainer', req.userId, opts.fault);
    return this.run(f, () => {
      const c = this.own(req.id, req.userId);
      if (c.publishedMediaId) return { id: c.id, status: 'PUBLISHED' as const };
      if (c.status === 'IN_PROGRESS') {
        if (c.pollsLeft > 0) {
          c.pollsLeft--;
          return { id: c.id, status: 'IN_PROGRESS' as const };
        }
        c.status = c.outcome;
      }
      return { id: c.id, status: c.status };
    });
  }

  publish(req: { userId: string; creationId: string; accessToken: string; now?: Date }, opts: { fault?: InstagramFault | null } = {}): { id: string } {
    this.calls.publish++;
    const now = req.now ?? new Date();
    this.auth(req.accessToken, req.userId, now);
    const f = this.takeFault('publish', req.userId, opts.fault);
    return this.run(f, () => {
      const c = this.own(req.creationId, req.userId);
      if (c.type === 'CAROUSEL_ITEM') throw new InstagramMockApiError('invalid_parameter', { code: 'carousel_item_not_publishable' });
      if (c.publishedMediaId) throw new InstagramMockApiError('invalid_parameter', { code: 'container_already_published' });
      if (c.status === 'IN_PROGRESS') throw new InstagramMockApiError('invalid_parameter', { code: 'container_not_ready' });
      if (c.status === 'ERROR' || c.status === 'EXPIRED') throw new InstagramMockApiError('invalid_parameter', { code: `container_${c.status.toLowerCase()}` });
      const budget = this.budgets.get(req.userId);
      if (budget && budget.remaining <= 0) throw new InstagramMockApiError('rate_limited', { retryAfterSec: budget.retryAfterSec });
      if (budget) budget.remaining--;
      const id = `${INSTAGRAM_MOCK_MEDIA_PREFIX}${randomUUID()}`;
      const shas = c.type === 'CAROUSEL' ? c.children.map((k) => this.containers.get(k)?.imageSha256 ?? '') : [c.imageSha256 ?? ''];
      this.media.set(id, {
        id,
        userId: req.userId,
        containerId: c.id,
        mediaType: c.type === 'CAROUSEL' ? 'CAROUSEL_ALBUM' : 'IMAGE',
        caption: c.caption,
        imageSha256: shas,
        permalink: `mock://instagram/p/${id}`,
        visibility: this.accountVisibility.get(req.userId) ?? 'public',
        timestamp: now.toISOString(),
      });
      c.publishedMediaId = id;
      this.publishCount.set(c.id, (this.publishCount.get(c.id) ?? 0) + 1);
      return { id };
    });
  }

  getMedia(
    req: { id: string; userId: string; accessToken: string; now?: Date },
    opts: { fault?: InstagramFault | null } = {},
  ): { id: string; permalink: string; mediaType: string; visibility: 'public' | 'private' } {
    this.calls.getMedia++;
    this.auth(req.accessToken, req.userId, req.now ?? new Date());
    const f = this.takeFault('getMedia', req.userId, opts.fault);
    return this.run(f, () => {
      const m = this.media.get(req.id);
      if (!m || m.userId !== req.userId) throw new InstagramMockApiError('not_found', { code: 'media_not_found' });
      return { id: m.id, permalink: m.permalink, mediaType: m.mediaType, visibility: m.visibility };
    });
  }

  /**
   * FIX-T16(P1) 조회: 이 자식들(순서 그대로)로 만든 부모 컨테이너. 없으면 null(자식은 모두 알고 아직 부모에 쓰이지 않음 — 부모 미생성 확실).
   * 자식을 하나라도 모르면 not_found 오류(재시작 등 — "없음"이라고 단정하지 않는다). **모의 가정** — 실제 API 의 같은 조회는 live 전 확인.
   */
  findCarouselByChildren(
    req: { userId: string; accessToken: string; children: string[]; now?: Date },
    opts: { fault?: InstagramFault | null } = {},
  ): { id: string; status: InstagramContainerStatus } | null {
    this.calls.findCarouselByChildren++;
    this.auth(req.accessToken, req.userId, req.now ?? new Date());
    const f = this.takeFault('findCarouselByChildren', req.userId, opts.fault);
    return this.run(f, () => {
      for (const id of req.children) this.own(id, req.userId);
      const key = req.children.join(',');
      const parent = [...this.containers.values()].find((c) => c.userId === req.userId && c.type === 'CAROUSEL' && c.children.join(',') === key);
      if (parent) return { id: parent.id, status: parent.publishedMediaId ? ('PUBLISHED' as const) : parent.status };
      // 자식이 쓰였는데 같은 목록의 부모가 없다(다른 부모에 쓰임) — 확인 불가
      if (req.children.some((id) => this.containers.get(id)!.usedAsChild)) throw new InstagramMockApiError('not_found', { code: 'carousel_parent_unresolvable' });
      return null;
    });
  }

  /** 조회: 이 컨테이너로 게시된 미디어. 컨테이너를 모르면 not_found 오류(재시작 등 — "없음"이라고 단정하지 않는다). */
  findPublishedByContainer(req: { creationId: string; userId: string; accessToken: string; now?: Date }, opts: { fault?: InstagramFault | null } = {}): { id: string; permalink: string } | null {
    this.calls.findPublishedByContainer++;
    this.auth(req.accessToken, req.userId, req.now ?? new Date());
    const f = this.takeFault('findPublishedByContainer', req.userId, opts.fault);
    return this.run(f, () => {
      const c = this.own(req.creationId, req.userId);
      if (!c.publishedMediaId) return null;
      const m = this.media.get(c.publishedMediaId)!;
      return { id: m.id, permalink: m.permalink };
    });
  }
}

const globalForInstagram = globalThis as typeof globalThis & { __contentStudioInstagramMockApi?: InstagramMockApi };

/** 프로세스당 하나(web 과 inline worker 가 같은 모의 Instagram 을 본다). */
export function instagramMockApi(): InstagramMockApi {
  if (!globalForInstagram.__contentStudioInstagramMockApi) globalForInstagram.__contentStudioInstagramMockApi = new InstagramMockApi();
  return globalForInstagram.__contentStudioInstagramMockApi;
}

/** 시험용: 프로세스 싱글턴을 버린다(재시작 흉내). */
export function resetInstagramMockApi(): void {
  globalForInstagram.__contentStudioInstagramMockApi = undefined;
}

// ---- 어댑터 ----

export const INSTAGRAM_ADAPTER_ID = 'mock_instagram' as const;

/**
 * 잠정 요청 제한: 계정당 24시간 게시 25개(게시 단계 = 1 단위 — 캐러셀도 게시물 1개). 확인일·API 버전 없음. 공식 한도를 사실로 고정하지 않는다
 * (D19-d, D29 제안 — live 전 사용자 확인·공식 재확인).
 */
export const INSTAGRAM_PROVISIONAL_RATE_LIMIT: ChannelRateLimit = {
  max_units: 25,
  window_sec: 24 * 3600,
  checked_at: null,
  api_version: null,
  source: 'provisional — 24시간 게시 25개, 공식 자료 재확인 필요(D19-d, D29 제안)',
};

/** 한 번의 submit 안에서 컨테이너 상태를 묻는 횟수. 넘으면 processing(REMOTE_PROCESSING). */
export const INSTAGRAM_POLL_BUDGET = 3;

export interface InstagramAdapterOptions {
  api?: InstagramMockApi;
  publicMedia?: MockPublicMediaUrlProvider;
  pollBudget?: number;
  pollIntervalMs?: number;
  rateLimit?: ChannelRateLimit;
  spec?: InstagramMediaSpec;
}

function abortError(): Error {
  const e = new Error('mock instagram submit aborted');
  e.name = 'AbortError';
  return e;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface SnapshotAssetRef {
  id: string;
  checksum: string;
  role: string;
  order: number;
  mime: string;
}

function assetsOf(snapshot: Pick<PublishSnapshot, 'payload'>): SnapshotAssetRef[] {
  const a = (snapshot.payload as { assets?: unknown }).assets;
  return Array.isArray(a) ? (a as SnapshotAssetRef[]) : [];
}

/** 승인 스냅샷의 캡션(payload.text.caption). */
export function instagramCaptionOf(snapshot: Pick<PublishSnapshot, 'payload'>): string {
  const t = (snapshot.payload as { text?: { caption?: unknown } }).text;
  return typeof t?.caption === 'string' ? t.caption : '';
}

/** 승인 스냅샷의 이미지 첨부(순서대로) — 캐러셀 자식 순서(post_index 1..n). */
export function instagramImagesOf(snapshot: Pick<PublishSnapshot, 'payload'>): SnapshotAssetRef[] {
  return assetsOf(snapshot)
    .filter((a) => a.role === 'image')
    .sort((a, b) => a.order - b.order);
}

const publicationId = (mediaId: string) => `mock:instagram:${mediaId}`;

/** FIX-T16(P1): 캐러셀 부모 생성 요청 표식(remote_steps ig_parent_request 의 remote_id — 원격 ID 아님, 이 앱이 만든 모의 상관 값). */
export const INSTAGRAM_PARENT_REQUEST_PREFIX = 'mockig_req_';

/**
 * FIX-T16(P0): 승인 checksum 확인. 이미지마다 파일 전체를 읽어 sha256 을 계산하고 승인 스냅샷 checksum 과 비교한다(저장소 창구의 메타데이터가
 * 아니라 **실제 바이트**). 같으면 확인한 바이트의 메모리 사본을 파일 창구로 돌려준다 — 공개 URL 창구(원격이 가져가는 곳)에는 이것만 넘긴다.
 * 오류 코드: asset_unavailable:<order> · asset_read_failed:<order> · asset_checksum_mismatch:<order>.
 */
export async function verifiedImageFiles(
  images: readonly SnapshotAssetRef[],
  files: ReadonlyMap<number, MediaFile>,
): Promise<{ ok: true; files: Map<number, MediaFile> } | { ok: false; error_code: string }> {
  const out = new Map<number, MediaFile>();
  for (const a of images) {
    const f = files.get(a.order);
    if (!f || !(f.bytes > 0)) return { ok: false, error_code: `asset_unavailable:${a.order}` };
    let bytes: Uint8Array;
    try {
      bytes = await f.read(0, f.bytes);
    } catch {
      return { ok: false, error_code: `asset_read_failed:${a.order}` };
    }
    if (bytes.byteLength !== f.bytes) return { ok: false, error_code: `asset_read_failed:${a.order}` };
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== a.checksum) return { ok: false, error_code: `asset_checksum_mismatch:${a.order}` };
    const copy = Uint8Array.from(bytes);
    out.set(a.order, {
      bytes: copy.byteLength,
      mime: f.mime,
      checksum: digest,
      read: async (start: number, end: number) => {
        if (!(start >= 0 && end > start && end <= copy.byteLength)) throw new RangeError('media read out of range');
        return copy.slice(start, end);
      },
    });
  }
  return { ok: true, files: out };
}

/** 시뮬레이터 오류 → 어댑터 결과(docs/03 분류). 토큰·URL 은 넣지 않는다. */
export function classifyInstagramError(e: unknown, op: InstagramOp): AdapterResult {
  if (!(e instanceof InstagramMockApiError)) return { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'adapter_error' };
  switch (e.kind) {
    case 'auth_invalid_token':
      return { status: 'rejected', retry_class: 'auth', error_code: 'auth_invalid_token' };
    case 'permission_denied':
      return { status: 'rejected', retry_class: 'permanent', error_code: 'permission_denied' };
    case 'invalid_parameter':
      // 이미 게시된 컨테이너·만료 컨테이너 — 원격 사실을 단정하지 않고 조회로(다시 보내지 않음, Threads FIX-T14 와 같은 종료 정책).
      if (e.code === 'container_already_published' || e.code === 'container_expired') return { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: e.code };
      if (e.code === 'invalid_image_spec') return { status: 'rejected', retry_class: 'permanent', error_code: 'invalid_image_spec' };
      return { status: 'rejected', retry_class: 'permanent', error_code: e.code === 'invalid_parameter' ? 'invalid_parameter' : `invalid_parameter:${e.code}` };
    case 'not_found':
      return { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: e.code };
    case 'rate_limited':
      return { status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'rate_limited', retry_after_sec: e.opts.retryAfterSec ?? 60 };
    case 'server_error':
      // "모든 5xx 무조건 재시도 금지"(docs/03). FIX-T16(P0): 쓰기(컨테이너·부모·게시)의 5xx 는 원격이 적용했는지 응답만으로 증명할 수 없다 —
      // 부작용 표시(생략·none)와 무관하게 결과 불명 → 조회(A08). 조회가 "적용 안 됨"을 확인한 뒤에만 다시 보낸다. 읽기 5xx 는 부작용 없음 → 재시도.
      return WRITE_OPS.includes(op)
        ? { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'server_error_side_effect_unknown' }
        : { status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'server_error' };
    case 'timeout':
    default:
      return { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'timeout' };
  }
}

export class InstagramMockChannelAdapter implements ChannelAdapter {
  readonly kind = 'mock' as const;
  readonly id = INSTAGRAM_ADAPTER_ID;
  /** 조회 판정이 remote_steps 에 기댄다 — 복원한 작업의 not_found 는 믿지 않는다(작업 처리기가 unknown 으로). */
  readonly usesRemoteSteps = true;
  /** 요청 제한 단위 = 게시 단계(캐러셀도 게시물 1개) */
  readonly rateStepKinds = ['ig_publish'] as const;
  readonly api: InstagramMockApi;
  readonly publicMedia: MockPublicMediaUrlProvider;
  pollBudget: number;
  pollIntervalMs: number;
  rateLimit: ChannelRateLimit;
  spec: InstagramMediaSpec;
  readonly calls = { prepare: 0, submit: 0, reconcile: 0, cancel: 0 };
  private readonly tokens = new WeakMap<PreparedSubmission, string>();

  constructor(opts: InstagramAdapterOptions = {}) {
    this.api = opts.api ?? instagramMockApi();
    this.publicMedia = opts.publicMedia ?? this.api.publicMedia;
    this.pollBudget = opts.pollBudget ?? INSTAGRAM_POLL_BUDGET;
    this.pollIntervalMs = opts.pollIntervalMs ?? 0;
    this.rateLimit = opts.rateLimit ?? { ...INSTAGRAM_PROVISIONAL_RATE_LIMIT };
    this.spec = opts.spec ?? { ...INSTAGRAM_PROVISIONAL_MEDIA_SPEC };
  }

  capabilities(_account: AdapterAccount): AdapterCapabilities {
    return {
      read: true,
      // 게시된 미디어의 삭제는 별도 명령·승인(범위 밖) — 원격 취소 없음.
      cancel: false,
      definitive_not_found: true,
      mock: true,
      adapter: INSTAGRAM_ADAPTER_ID,
      media: true,
      text: {
        max_post_chars: this.spec.caption_max,
        max_posts: 1,
        unit: 'code_point',
        checked_at: null,
        api_version: null,
        source: this.spec.source,
      },
      rate_limit: { ...this.rateLimit },
    };
  }

  /** 게시 1회 = 1 단위. */
  rateUnits(_snapshot: PublishSnapshot): number {
    return 1;
  }

  /** 이미 게시 단계가 있으면 0(재개·재확인은 새 게시가 아니다), 없으면 1. */
  rateUnitsRemaining(_snapshot: PublishSnapshot, steps: readonly RemoteStep[]): number {
    return steps.some((s) => s.kind === 'ig_publish') ? 0 : 1;
  }

  /**
   * 승인 스냅샷만으로 검사(파일·원격 호출 없음). 모의 계정·채널·mock_publish·공개 범위 public(Instagram 은 비공개·예약 결과 없음)·
   * 첨부 역할(이미지만, 2~10개 캐러셀)·형식(JPEG, 잠정)·캡션(길이·해시태그·언급, 잠정). 파일 크기·비율은 submit 이 파일을 읽어 다시 검사한다.
   */
  validate(snapshot: PublishSnapshot): { ok: true } | { ok: false; error_code: string } {
    if (snapshot.account.kind !== 'mock' || !snapshot.account.external_account_id.startsWith('mock:')) return { ok: false, error_code: 'not_mock_account' };
    if (snapshot.channel !== 'instagram' || snapshot.account.platform !== 'instagram') return { ok: false, error_code: 'channel_not_supported' };
    if (snapshot.requested_result !== 'mock_publish') return { ok: false, error_code: 'mock_only' };
    if (snapshot.visibility !== 'public') return { ok: false, error_code: 'instagram_visibility_public_only' };
    const facts = assetsOf(snapshot).map((a) => ({ order: a.order, role: a.role, mime: a.mime, bytes: null, width: 1, height: 1 }));
    const problems = instagramSpecProblems({ caption: instagramCaptionOf(snapshot), media: facts }, { ...this.spec, min_width: 0, min_aspect: 0, max_aspect: Number.POSITIVE_INFINITY });
    if (problems.length) return { ok: false, error_code: `invalid_media_spec:${problems[0]!.replace(/^media_spec:/, '')}` };
    return { ok: true };
  }

  async prepare(snapshot: PublishSnapshot, ctx: AdapterContext): Promise<PreparedSubmission> {
    this.calls.prepare++;
    const data: Record<string, unknown> = { mock: true, platform: 'instagram', adapter: INSTAGRAM_ADAPTER_ID, images: instagramImagesOf(snapshot).length };
    const prepared: PreparedSubmission = { snapshot, data };
    let r: Awaited<ReturnType<NonNullable<AdapterContext['credential']>['accessToken']>>;
    try {
      r = ctx.credential ? await ctx.credential.accessToken() : { ok: false, code: 'credential_unavailable' };
    } catch {
      r = { ok: false, code: 'credential_unavailable' };
    }
    if (r.ok) this.tokens.set(prepared, r.token);
    else data.blocked = r.code;
    return prepared;
  }

  private scenario(ctx: Pick<AdapterContext, 'mockScenario'>): MockScenarioValue {
    const s = ctx.mockScenario?.scenario;
    return s && isInstagramMockScenario(s) ? s : 'instagram_success';
  }

  /**
   * 시나리오 → 이번 호출의 장애·컨테이너 옵션(첫 시도에서만 — 재개·재시도는 정상; 원격 규격 거부는 매번). first = 이 submit 의 첫 이미지 컨테이너,
   * target = 게시할 컨테이너(단일 이미지 또는 캐러셀 부모).
   */
  private faultFor(
    scenario: MockScenarioValue,
    op: InstagramOp,
    where: { first: boolean; target: boolean },
    attempt: number,
  ): { fault?: InstagramFault; finishAfterPolls?: number; outcome?: 'FINISHED' | 'ERROR' } {
    if (scenario === 'instagram_invalid_spec_remote') {
      return op === 'createImageContainer' && where.first ? { fault: { op, kind: 'invalid_parameter', code: 'invalid_image_spec' } } : {};
    }
    if (attempt !== 1) return {};
    switch (scenario) {
      case 'instagram_container_slow':
        return (op === 'createImageContainer' || op === 'createCarouselContainer') && where.target ? { finishAfterPolls: this.pollBudget } : {};
      case 'instagram_container_error':
        return (op === 'createImageContainer' || op === 'createCarouselContainer') && where.target ? { outcome: 'ERROR' } : {};
      case 'instagram_publish_timeout_sent':
        return op === 'publish' ? { fault: { op, kind: 'timeout', applied: true } } : {};
      case 'instagram_publish_timeout_not_sent':
        return op === 'publish' ? { fault: { op, kind: 'timeout', applied: false } } : {};
      case 'instagram_rate_limited':
        return op === 'publish' ? { fault: { op, kind: 'rate_limited', retryAfterSec: 5 } } : {};
      case 'instagram_token_invalid':
        return op === 'createImageContainer' && where.first ? { fault: { op, kind: 'auth_invalid_token' } } : {};
      case 'instagram_permission_denied':
        return op === 'createImageContainer' && where.first ? { fault: { op, kind: 'permission_denied' } } : {};
      default:
        return {};
    }
  }

  /** 부작용(원격 쓰기) 직전: lease·중단 확인(FIX-T11 P0 와 같은 규칙). */
  private async beforeWrite(ctx: AdapterContext): Promise<void> {
    await ctx.heartbeat();
    if (ctx.signal.aborted) throw abortError();
  }

  /**
   * 이미지 컨테이너 하나: 공개 URL 발급 → (쓰기 직전 확인) → 원격이 가져가며 컨테이너 생성 → URL 철회(성공·실패 모두). URL 은 반환·기록하지 않는다.
   */
  private async imageContainer(
    ctx: AdapterContext,
    file: MediaFile,
    asset: SnapshotAssetRef,
    req: { userId: string; token: string; caption: string | null; isCarouselItem: boolean },
    opts: { fault?: InstagramFault; finishAfterPolls?: number; outcome?: 'FINISHED' | 'ERROR' },
  ): Promise<{ id: string; status: InstagramContainerStatus }> {
    const issued = await this.publicMedia.issue({ file, asset: { id: asset.id, checksum: asset.checksum, mime: asset.mime }, now: ctx.now, ttlMs: PUBLIC_MEDIA_URL_TTL_MS });
    try {
      await this.beforeWrite(ctx);
      return await this.api.createImageContainer(
        { userId: req.userId, accessToken: req.token, imageUrl: issued.url, caption: req.caption, isCarouselItem: req.isCarouselItem, now: ctx.now },
        opts,
      );
    } finally {
      await this.publicMedia.revoke(issued.url);
    }
  }

  /**
   * 컨테이너가 FINISHED 가 될 때까지 조회(예산 안). 결과: 'finished' | AdapterResult(처리 중·결과 불명·영구 실패). 오류(ERROR)는 단계에 기록한다.
   */
  private async waitFinished(ctx: AdapterContext, token: string, userId: string, ct: RemoteStep, requestId: string): Promise<'finished' | AdapterResult> {
    if (ct.status === 'finished') return 'finished';
    const steps = ctx.steps!;
    let polls = 0;
    let status: InstagramContainerStatus = 'IN_PROGRESS';
    while (polls < this.pollBudget) {
      if (polls > 0 && this.pollIntervalMs > 0) await sleep(this.pollIntervalMs, ctx.signal);
      await ctx.heartbeat();
      polls++;
      try {
        status = this.api.getContainer({ id: ct.remote_id, userId, accessToken: token, now: ctx.now }).status;
      } catch (e) {
        if (e instanceof LeaseLostError) throw e;
        const r = classifyInstagramError(e, 'getContainer');
        return r.retry_class === 'auth'
          ? { ...r, provider_request_id: requestId }
          : { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: `poll_${r.error_code}`, provider_request_id: requestId };
      }
      if (status !== 'IN_PROGRESS') break;
    }
    if (status === 'IN_PROGRESS') return { status: 'processing', error_code: 'container_in_progress', provider_request_id: requestId, remote_visibility: 'public', result_kind: 'PUBLISHED' };
    if (status === 'PUBLISHED') return { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'container_already_published', provider_request_id: requestId };
    if (status === 'EXPIRED') return { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'container_expired', provider_request_id: requestId };
    if (status === 'ERROR') {
      await steps.record({ kind: 'ig_container', post_index: ct.post_index, remote_id: ct.remote_id, status: 'error' });
      return { status: 'rejected', retry_class: 'permanent', error_code: 'container_error', provider_request_id: requestId };
    }
    await steps.record({ kind: 'ig_container', post_index: ct.post_index, remote_id: ct.remote_id, status: 'finished' });
    return 'finished';
  }

  async submit(prepared: PreparedSubmission, ctx: AdapterContext): Promise<AdapterResult> {
    this.calls.submit++;
    const snap = prepared.snapshot;
    const blocked = prepared.data.blocked;
    if (typeof blocked === 'string') return { status: 'rejected', retry_class: 'auth', error_code: blocked };
    const token = this.tokens.get(prepared);
    if (!token) return { status: 'rejected', retry_class: 'auth', error_code: 'credential_unavailable' };
    if (!ctx.steps) return { status: 'rejected', retry_class: 'permanent', error_code: 'steps_unavailable' };
    if (!ctx.media) return { status: 'rejected', retry_class: 'permanent', error_code: 'media_reader_unavailable' };
    const steps = ctx.steps;
    const requestId = `mock-ig-req:${randomUUID()}`;
    const res = (r: AdapterResult): AdapterResult => ({ ...r, provider_request_id: requestId });
    const userId = snap.account.external_account_id;
    const scenario = this.scenario(ctx);
    const caption = instagramCaptionOf(snap);
    const images = instagramImagesOf(snap);

    let recorded = await steps.list();
    const find = (kind: RemoteStep['kind'], i: number) => recorded.find((s) => s.kind === kind && s.post_index === i) ?? null;
    const published = find('ig_publish', 0);
    if (published) {
      // 이미 게시됨 — 다시 게시하지 않고 링크만 확인한다(파일 검사보다 먼저: 게시 뒤 파일이 바뀌어도 원격 사실을 FAILED 로 덮지 않는다).
      return this.acceptedFor(published.remote_id, token, userId, ctx, requestId);
    }
    // 보내기 직전 규격 재검사(원격 호출 0): 승인한 파일(VERIFIED·같은 checksum 메타데이터)을 열어 형식·크기·비율·가로·캡션. 어긋나면 FAILED(재시도 없음).
    const inspected = await instagramMediaFacts(ctx.media, assetsOf(snap), this.spec);
    const problems = [...inspected.problems, ...instagramSpecProblems({ caption, media: inspected.facts }, this.spec)];
    if (problems.length) return res({ status: 'rejected', retry_class: 'permanent', error_code: `invalid_media_spec:${problems[0]!.replace(/^media_spec:/, '')}` });
    // FIX-T16(P0): 실제로 읽은 바이트의 sha256 = 승인 checksum(이미지마다, 컨테이너를 하나도 만들기 전에). 원격에는 이 확인한 바이트만 간다.
    const verified = await verifiedImageFiles(images, inspected.files);
    if (!verified.ok) return res({ status: 'rejected', retry_class: 'permanent', error_code: verified.error_code });
    const delay = ctx.mockScenario?.delay_ms ?? 0;
    if (delay > 0) await sleep(delay, ctx.signal);

    const carousel = images.length > 1;
    let firstCreate = true;
    let target = find('ig_container', 0);
    if (target && target.status === 'error') return res({ status: 'rejected', retry_class: 'permanent', error_code: 'container_error' });
    if (!target && carousel) {
      // 캐러셀 자식(post_index 1..n): 없는 것만 만든다(있는 자식은 다시 만들지 않는다).
      const childIds: string[] = [];
      for (let k = 1; k <= images.length; k++) {
        let child = find('ig_container', k);
        if (child && child.status === 'error') return res({ status: 'rejected', retry_class: 'permanent', error_code: 'container_error' });
        if (!child) {
          const asset = images[k - 1]!;
          let created: { id: string; status: InstagramContainerStatus };
          try {
            created = await this.imageContainer(ctx, verified.files.get(asset.order)!, asset, { userId, token, caption: null, isCarouselItem: true }, this.faultFor(scenario, 'createImageContainer', { first: firstCreate, target: false }, ctx.attempt));
          } catch (e) {
            if (e instanceof LeaseLostError || (e instanceof Error && e.name === 'AbortError')) throw e;
            return res(classifyInstagramError(e, 'createImageContainer'));
          } finally {
            firstCreate = false;
          }
          // 다음 원격 호출 전에 참조를 남긴다(짧은 트랜잭션).
          child = await steps.record({ kind: 'ig_container', post_index: k, remote_id: created.id, status: created.status === 'FINISHED' ? 'finished' : 'created' });
        }
        const w = await this.waitFinished(ctx, token, userId, child, requestId);
        if (w !== 'finished') return w;
        childIds.push(child.remote_id);
      }
      recorded = await steps.list();
      target = find('ig_container', 0);
      const marker = find('ig_parent_request', 0);
      if (!target && marker) {
        // FIX-T16(P1): 이전 시도가 부모를 요청했다 — 응답(또는 기록)을 잃었을 수 있다. 기록한 자식으로 부모를 찾아 기록하고, 없음이 확실할 때만 새로 만든다.
        // 찾기 실패(원격 기록 없음·자식이 다른 부모에 쓰임·읽기 오류)는 결과 불명 → 조회(쓰인 자식으로 두 번째 부모를 만들지 않는다).
        const looked = this.lookupParent(token, userId, childIds, ctx);
        if (!looked.ok) return res({ status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: looked.error_code });
        if (looked.parent) target = await steps.record({ kind: 'ig_container', post_index: 0, remote_id: looked.parent.id, status: looked.parent.status === 'FINISHED' ? 'finished' : 'created' });
      }
      if (!target) {
        // 부모 생성 요청 표식을 **원격 호출 전에** 남긴다(같은 작업의 재시도는 같은 표식 — 원격 ID 는 바뀌지 않는다).
        await steps.record({ kind: 'ig_parent_request', post_index: 0, remote_id: marker?.remote_id ?? `${INSTAGRAM_PARENT_REQUEST_PREFIX}${randomUUID()}`, status: 'created' });
        let created: { id: string; status: InstagramContainerStatus };
        try {
          await this.beforeWrite(ctx);
          created = this.api.createCarouselContainer(
            { userId, accessToken: token, children: childIds, caption, now: ctx.now },
            this.faultFor(scenario, 'createCarouselContainer', { first: false, target: true }, ctx.attempt),
          );
        } catch (e) {
          if (e instanceof LeaseLostError || (e instanceof Error && e.name === 'AbortError')) throw e;
          return res(classifyInstagramError(e, 'createCarouselContainer'));
        }
        target = await steps.record({ kind: 'ig_container', post_index: 0, remote_id: created.id, status: created.status === 'FINISHED' ? 'finished' : 'created' });
      }
    } else if (!target) {
      const asset = images[0]!;
      let created: { id: string; status: InstagramContainerStatus };
      try {
        created = await this.imageContainer(ctx, verified.files.get(asset.order)!, asset, { userId, token, caption, isCarouselItem: false }, this.faultFor(scenario, 'createImageContainer', { first: true, target: true }, ctx.attempt));
      } catch (e) {
        if (e instanceof LeaseLostError || (e instanceof Error && e.name === 'AbortError')) throw e;
        return res(classifyInstagramError(e, 'createImageContainer'));
      }
      target = await steps.record({ kind: 'ig_container', post_index: 0, remote_id: created.id, status: created.status === 'FINISHED' ? 'finished' : 'created' });
    }
    const w = await this.waitFinished(ctx, token, userId, target, requestId);
    if (w !== 'finished') return w;
    await this.beforeWrite(ctx);
    let media: { id: string };
    try {
      media = this.api.publish({ userId, creationId: target.remote_id, accessToken: token, now: ctx.now }, this.faultFor(scenario, 'publish', { first: false, target: true }, ctx.attempt));
    } catch (e) {
      if (e instanceof LeaseLostError) throw e;
      return res(classifyInstagramError(e, 'publish'));
    }
    await steps.record({ kind: 'ig_publish', post_index: 0, remote_id: media.id, status: 'published' });
    return this.acceptedFor(media.id, token, userId, ctx, requestId);
  }

  /** FIX-T16(P1): 기록한 자식(순서대로)으로 만든 부모 찾기(읽기 전용). parent null = 부모 없음 확실. */
  private lookupParent(
    token: string,
    userId: string,
    childIds: string[],
    ctx: Pick<AdapterContext, 'now'>,
  ): { ok: true; parent: { id: string; status: InstagramContainerStatus } | null } | { ok: false; error_code: string } {
    try {
      return { ok: true, parent: this.api.findCarouselByChildren({ userId, accessToken: token, children: childIds, now: ctx.now }) };
    } catch (e) {
      return { ok: false, error_code: `parent_lookup_${e instanceof InstagramMockApiError ? e.code : 'adapter_error'}` };
    }
  }

  private acceptedFor(mediaId: string, token: string, userId: string, ctx: AdapterContext, requestId: string): AdapterResult {
    let m: { permalink: string; visibility: 'public' | 'private' };
    try {
      m = this.api.getMedia({ id: mediaId, userId, accessToken: token, now: ctx.now });
    } catch {
      // 게시됐고 단계가 기록됐다 — 링크만 못 읽음. 조회가 링크와 함께 확인한다.
      return { status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'permalink_unavailable', provider_request_id: requestId };
    }
    // 공개 범위는 원격 응답 값 그대로(고정 public 이 아님 — Q6).
    return { status: 'accepted', external_id: publicationId(mediaId), permalink: m.permalink, provider_request_id: requestId, remote_visibility: m.visibility, result_kind: 'PUBLISHED' };
  }

  /**
   * 읽기 전용 조회(원격에 쓰지 않는다 — 찾은 미디어 ID·컨테이너 상태를 단계 기록에 남기는 것만). 판정:
   * - 단계 기록 없음 → not_found(게시는 기록된 컨테이너로만 하므로 게시되지 않았음이 확실; 기록 전 응답 유실로 생긴 컨테이너는 게시되지 않은 채 남는다).
   * - 게시 기록 있음 → 링크 확인 found.
   * - 게시할 컨테이너(post_index 0) 있음: PUBLISHED·FINISHED → 이 컨테이너로 게시된 미디어를 찾아 기록 → found / FINISHED·게시 없음 → resumable
   *   (같은 컨테이너로 게시) / IN_PROGRESS → processing / ERROR → failed(원격이 처리 거부 — 게시물 없음) / 만료·모름·읽기 실패 → unknown.
   * - 게시할 컨테이너 없음(캐러셀 자식만): 자식 상태 — 처리 중 → processing, 오류 → failed, 만료·모름 → unknown, 나머지 → resumable(부모부터).
   *   FIX-T16(P1): 부모 생성 요청 표식(ig_parent_request)이 있으면 먼저 자식으로 부모를 찾는다 — 찾으면 기록하고 위 판정, 찾기 실패 → unknown,
   *   없음 확실 → 자식 판정.
   */
  async reconcile(_reference: RemoteReference, ctx: AdapterContext): Promise<ReconcileResult> {
    this.calls.reconcile++;
    if (!ctx.steps) return { status: 'unknown', error_code: 'steps_unavailable' };
    const snap = ctx.snapshot;
    if (!snap) return { status: 'unknown', error_code: 'snapshot_unavailable' };
    const recorded = await ctx.steps.list();
    if (recorded.length === 0) return { status: 'not_found', error_code: 'no_remote_steps' };
    let tok: { ok: true; token: string } | { ok: false; code: string };
    try {
      tok = ctx.credential ? await ctx.credential.accessToken() : { ok: false, code: 'credential_unavailable' };
    } catch {
      tok = { ok: false, code: 'credential_unavailable' };
    }
    if (!tok.ok) return { status: 'unknown', error_code: tok.code };
    const token = tok.token;
    const userId = snap.account.external_account_id;
    const find = (kind: RemoteStep['kind'], i: number) => recorded.find((s) => s.kind === kind && s.post_index === i) ?? null;
    const found = (mediaId: string): ReconcileResult => {
      try {
        const m = this.api.getMedia({ id: mediaId, userId, accessToken: token, now: ctx.now });
        return { status: 'found', external_id: publicationId(mediaId), permalink: m.permalink, remote_visibility: m.visibility, result_kind: 'PUBLISHED', published_parts: 1 };
      } catch (e) {
        return { status: 'unknown', error_code: e instanceof InstagramMockApiError ? `media_${e.code}` : 'adapter_error' };
      }
    };
    const pub = find('ig_publish', 0);
    if (pub) return found(pub.remote_id);
    const status = (ct: RemoteStep): InstagramContainerStatus | ReconcileResult => {
      try {
        return this.api.getContainer({ id: ct.remote_id, userId, accessToken: token, now: ctx.now }).status;
      } catch (e) {
        return { status: 'unknown', error_code: e instanceof InstagramMockApiError ? `container_${e.code}` : 'adapter_error' };
      }
    };
    let target = find('ig_container', 0);
    const marker = find('ig_parent_request', 0);
    if (!target && marker) {
      // FIX-T16(P1): 부모 생성을 요청했는데 부모 ID 가 없다(응답 유실·기록 실패). 자식이 준비됐다는 것만으로 "부모 없음"을 확정하지 않는다 —
      // 기록한 자식(전부, 순서대로)으로 부모를 찾아 기록한다. 찾기 실패 → unknown. 없음이 확실(null) → 아래 자식 판정(resumable 가능).
      const kids = recorded.filter((s) => s.kind === 'ig_container' && s.post_index > 0).sort((a, b) => a.post_index - b.post_index);
      if (kids.length !== instagramImagesOf(snap).length) return { status: 'unknown', published_parts: 0, error_code: 'carousel_children_incomplete' };
      const looked = this.lookupParent(
        token,
        userId,
        kids.map((k) => k.remote_id),
        ctx,
      );
      if (!looked.ok) return { status: 'unknown', published_parts: 0, error_code: looked.error_code };
      if (looked.parent) {
        target = await ctx.steps.record({ kind: 'ig_container', post_index: 0, remote_id: looked.parent.id, status: looked.parent.status === 'FINISHED' ? 'finished' : 'created' });
      }
    }
    if (target) {
      const st = status(target);
      if (typeof st !== 'string') return st;
      if (st === 'IN_PROGRESS') return { status: 'processing', published_parts: 0, error_code: 'container_in_progress' };
      if (st === 'ERROR') {
        await ctx.steps.record({ kind: 'ig_container', post_index: 0, remote_id: target.remote_id, status: 'error' });
        return { status: 'failed', error_code: 'container_error' };
      }
      if (st === 'PUBLISHED' || st === 'FINISHED') {
        let m: { id: string } | null;
        try {
          m = this.api.findPublishedByContainer({ creationId: target.remote_id, userId, accessToken: token, now: ctx.now });
        } catch (e) {
          return { status: 'unknown', error_code: e instanceof InstagramMockApiError ? `find_${e.code}` : 'adapter_error' };
        }
        if (m) {
          await ctx.steps.record({ kind: 'ig_publish', post_index: 0, remote_id: m.id, status: 'published' });
          return found(m.id);
        }
        if (st === 'PUBLISHED') return { status: 'unknown', error_code: 'published_media_missing' };
        if (target.status === 'created') await ctx.steps.record({ kind: 'ig_container', post_index: 0, remote_id: target.remote_id, status: 'finished' });
        // 컨테이너는 끝났고 게시되지 않았다 — 같은 컨테이너로 이어 게시할 수 있다(새 컨테이너 없음).
        return { status: 'resumable', published_parts: 0, error_code: 'container_not_published' };
      }
      // 만료: 이 컨테이너로는 게시할 수 없고, 맹목적으로 새 컨테이너를 만들지 않는다(Threads 와 같은 종료 정책) → 확인 불가.
      return { status: 'unknown', published_parts: 0, error_code: `container_${st.toLowerCase()}` };
    }
    // 게시할 컨테이너 없음 — 캐러셀 자식만 있다(부모를 만들기 전에 멈춤).
    const children = recorded.filter((s) => s.kind === 'ig_container' && s.post_index > 0).sort((a, b) => a.post_index - b.post_index);
    for (const ch of children) {
      const st = status(ch);
      if (typeof st !== 'string') return st;
      if (st === 'IN_PROGRESS') return { status: 'processing', published_parts: 0, error_code: 'child_in_progress' };
      if (st === 'ERROR') {
        await ctx.steps.record({ kind: 'ig_container', post_index: ch.post_index, remote_id: ch.remote_id, status: 'error' });
        return { status: 'failed', error_code: 'container_error' };
      }
      if (st !== 'FINISHED') return { status: 'unknown', published_parts: 0, error_code: `child_${st.toLowerCase()}` };
      if (ch.status === 'created') await ctx.steps.record({ kind: 'ig_container', post_index: ch.post_index, remote_id: ch.remote_id, status: 'finished' });
    }
    return { status: 'resumable', published_parts: 0, error_code: 'carousel_parent_not_created' };
  }

  /** 게시된 미디어는 이 흐름으로 되돌릴 수 없다(삭제는 별도 명령·승인 — docs/03). 취소 성공을 꾸며내지 않는다. */
  async cancel(_reference: RemoteReference, _ctx: AdapterContext): Promise<CancelResult> {
    this.calls.cancel++;
    return { status: 'unsupported', error_code: 'instagram_delete_out_of_scope' };
  }
}
