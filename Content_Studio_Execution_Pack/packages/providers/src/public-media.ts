/**
 * T16(제안 결정 D29) 공개 미디어 URL — **모의 구현만**. 실제 Instagram API 는 공개적으로 접근 가능한 URL 에서 이미지를 가져간다.
 * 이 앱은 아직 파일을 어디에도 공개하지 않는다: `MockPublicMediaUrlProvider` 는 `mock://public-media/<불투명 값>`(실제 호스팅 없음)을 발급하고,
 * 같은 프로세스의 모의 원격(시뮬레이터)만 `resolve` 로 그 값을 저장소 창구(MediaFile — VERIFIED·같은 checksum 파일)로 바꿔 읽는다.
 *
 * - URL 에는 파일 내용·asset ID·owner·checksum 이 없다(난수 18바이트). 발급 기록은 프로세스 메모리에만 있고 수명(기본 10분)이 지나거나
 *   revoke 하면 더는 읽을 수 없다. 어댑터는 컨테이너를 만든 직후 revoke 한다.
 * - URL 은 원격 단계 기록·작업 이력·감사·로그·내보내기에 넣지 않는다(가져갈 권한이 담긴 값으로 다룬다).
 * - 실제 설계(이 앱의 짧은 서명 URL / 제3자 호스팅 / 수동)는 live 전에 사용자 결정(개인정보 영향 — 누가 언제까지 파일을 볼 수 있는가).
 */
import { randomBytes } from 'node:crypto';
import { MOCK_PUBLIC_MEDIA_PREFIX, type MediaFile, type PublicMediaUrl, type PublicMediaUrlProvider } from '@cs/domain';

interface Entry {
  file: MediaFile;
  checksum: string;
  mime: string;
  expiresAt: number;
}

export class MockPublicMediaUrlProvider implements PublicMediaUrlProvider {
  readonly id = 'mock_public_media' as const;
  readonly mock = true;
  private readonly entries = new Map<string, Entry>();
  /** 관찰(시험): 발급·철회·원격 읽기·거절 수 */
  readonly stats = { issued: 0, revoked: 0, fetched: 0, refused: 0 };

  async issue(input: { file: MediaFile; asset: { id: string; checksum: string; mime: string }; now: Date; ttlMs: number }): Promise<PublicMediaUrl> {
    const opaque = randomBytes(18).toString('base64url');
    const expiresAt = input.now.getTime() + Math.max(1000, input.ttlMs);
    this.entries.set(opaque, { file: input.file, checksum: input.asset.checksum, mime: input.asset.mime, expiresAt });
    this.stats.issued++;
    return { url: `${MOCK_PUBLIC_MEDIA_PREFIX}${opaque}`, expiresAt: new Date(expiresAt) };
  }

  async revoke(url: string): Promise<void> {
    const key = this.keyOf(url);
    if (key && this.entries.delete(key)) this.stats.revoked++;
  }

  private keyOf(url: string): string | null {
    if (typeof url !== 'string' || !url.startsWith(MOCK_PUBLIC_MEDIA_PREFIX)) return null;
    const k = url.slice(MOCK_PUBLIC_MEDIA_PREFIX.length);
    return /^[A-Za-z0-9_-]{24}$/.test(k) ? k : null;
  }

  /** 모의 원격(시뮬레이터) 전용: URL → 파일 창구. 모르는·철회된·만료된 URL 은 null. */
  resolve(url: string, now: Date): { file: MediaFile; checksum: string; mime: string } | null {
    const key = this.keyOf(url);
    const e = key ? this.entries.get(key) : undefined;
    if (!e || e.expiresAt <= now.getTime()) {
      this.stats.refused++;
      if (key && e) this.entries.delete(key);
      return null;
    }
    this.stats.fetched++;
    return { file: e.file, checksum: e.checksum, mime: e.mime };
  }

  /** 아직 쓸 수 있는(철회·만료 전) URL 수(시험: 보낸 뒤 0 이어야 한다). */
  activeCount(now: Date = new Date()): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.expiresAt > now.getTime()) n++;
    return n;
  }

  reset(): void {
    this.entries.clear();
    this.stats.issued = 0;
    this.stats.revoked = 0;
    this.stats.fetched = 0;
    this.stats.refused = 0;
  }
}

const globalForPublicMedia = globalThis as typeof globalThis & { __contentStudioMockPublicMedia?: MockPublicMediaUrlProvider };

/** 프로세스당 하나(web·inline worker·모의 Instagram 이 같은 발급 기록을 본다). */
export function mockPublicMediaUrlProvider(): MockPublicMediaUrlProvider {
  if (!globalForPublicMedia.__contentStudioMockPublicMedia) globalForPublicMedia.__contentStudioMockPublicMedia = new MockPublicMediaUrlProvider();
  return globalForPublicMedia.__contentStudioMockPublicMedia;
}
