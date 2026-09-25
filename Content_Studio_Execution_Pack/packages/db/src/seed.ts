/**
 * 멱등 시드: owner 1명, brand profile v1, 가상 capture 10건, T10 모의 배포 계정(플랫폼마다 1개 — 없을 때만).
 * 재실행해도 중복되지 않는다(users.allowed_identity, brand_profiles(owner_id,version),
 * captures(owner_id,command_key) unique + ON CONFLICT DO NOTHING).
 * 외부 호출·게시 호출 없음. capture 본문은 자료로만 저장한다.
 */
import { readFileSync } from 'node:fs';
import { and, count, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { contentHash, fixtureCaptureSchema, normalizeUrl, type FixtureCapture } from '@cs/domain';
import { backfillContentHashes, upsertUrlSource } from './captures';
import type { Db } from './client';
import { ensureMockAccounts } from './distribution';
import { brandProfiles, captures, users } from './schema';
import { resolveFromRoot } from './paths';

export const BRAND_PROFILE_V1 = {
  version: 1,
  penName: '가칭: 해외영업 노트',
  audience: '해외 사업·영업 실무자 및 관리자, 해외 근무에 관심 있는 사람',
  pillars: ['해외 사업·영업 운영', '전문성의 AI 적용', '해외·러시아·주재원·조직 차이 경험'],
  styleRules: ['한국어 우선', '경험담은 사용자 확인 후에만 사용', '고용주·고객·직원 비공개 정보 제외'],
} as const;

export function defaultFixturePath(): string {
  return resolveFromRoot('tests/fixtures/captures.json');
}

export function loadFixtureCaptures(file = defaultFixturePath()): FixtureCapture[] {
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  return z.array(fixtureCaptureSchema).length(10).parse(raw);
}

export interface SeedResult {
  ownerId: string;
  capturesInserted: number;
  capturesTotal: number;
  /** T10: 이번 실행에서 만든 모의 배포 계정 수(재실행이면 0) */
  mockAccountsInserted: number;
}

export async function seed(db: Db, opts: { allowedIdentity: string; fixtures?: FixtureCapture[] }): Promise<SeedResult> {
  const fixtures = opts.fixtures ?? loadFixtureCaptures();
  return db.transaction(async (tx) => {
    await tx.insert(users).values({ allowedIdentity: opts.allowedIdentity }).onConflictDoNothing();
    const owner = (await tx.select().from(users).where(eq(users.allowedIdentity, opts.allowedIdentity)).limit(1))[0];
    if (!owner) throw new Error('owner 생성에 실패했습니다');

    await tx
      .insert(brandProfiles)
      .values({
        ownerId: owner.id,
        version: BRAND_PROFILE_V1.version,
        penName: BRAND_PROFILE_V1.penName,
        audience: BRAND_PROFILE_V1.audience,
        pillars: [...BRAND_PROFILE_V1.pillars],
        styleRules: [...BRAND_PROFILE_V1.styleRules],
      })
      .onConflictDoNothing();

    const inserted = await tx
      .insert(captures)
      .values(
        fixtures.map((f) => {
          // URL 수집은 URL 을 원문으로 보존하고, 설명은 user_note/raw_text 로 둔다(createCapture 와 같은 형식).
          const rawText = f.input_type === 'url' && f.url ? `${f.url}\n${f.raw_text}` : f.raw_text;
          return {
            ownerId: owner.id,
            rawText,
            inputType: f.input_type,
            receivedAt: new Date(f.received_at),
            updatedAt: new Date(f.received_at),
            risk: f.risk,
            userNote: f.user_note ?? null,
            commandKey: f.command_key,
            contentHash: contentHash(rawText),
          };
        }),
      )
      .onConflictDoNothing({ target: [captures.ownerId, captures.commandKey] })
      .returning({ id: captures.id });

    // T03: URL 픽스처는 sources(kind 'url') 행과 연결한다. 0002 이전에 seed 된 행도 여기서 연결된다(멱등).
    for (const f of fixtures) {
      if (f.input_type !== 'url' || !f.url) continue;
      const source = await upsertUrlSource(tx, owner.id, normalizeUrl(f.url));
      await tx
        .update(captures)
        .set({ sourceId: source.id })
        .where(and(eq(captures.ownerId, owner.id), eq(captures.commandKey, f.command_key), isNull(captures.sourceId)));
    }
    // 0002 이전에 seed 된 행의 content_hash 를 채운다(원문은 바꾸지 않음).
    await backfillContentHashes(tx, owner.id);

    // T10(D17): 플랫폼마다 모의 배포 계정(MOCK — 외부 호출 없음)을 하나씩, 없을 때만.
    const mockAccountsInserted = await ensureMockAccounts(tx, owner.id);

    const total = await tx.select({ n: count() }).from(captures).where(eq(captures.ownerId, owner.id));
    return { ownerId: owner.id, capturesInserted: inserted.length, capturesTotal: total[0]?.n ?? 0, mockAccountsInserted };
  });
}

