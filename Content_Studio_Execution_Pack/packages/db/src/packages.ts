/**
 * T09 배포 파일 묶음(결정 D14). **승인도 게시도 아니다** — 사람이 직접 올리기 위한 파일(수동 게시용).
 * store-only ZIP(@cs/domain writeZip) 한 개: `<EXPORT_LOCAL_DIR>/packages/<owner_id>/<package_id>.zip`.
 * 표를 따로 두지 않는다 — owner 폴더 경로가 곧 owner 범위이며, 다른 owner 의 id 로는 파일을 찾지 못해 404 가 된다.
 *
 * 내용(채널 파생본의 현재 버전만):
 * - `<channel>/body.txt`(blog 는 body.md), `<channel>/metadata.json`, `<channel>/assets.json`(순서·역할·sha256·포함 여부)
 * - `<channel>/assets/<순서>-<역할>.<ext>` — 저장소 파일을 읽어 assets.checksum 과 sha256 이 같을 때만 넣는다(다르면·없으면 missing + 경고)
 * - `manifest.json` — 원고·원고 버전·파생본별 버전/stale/미디어 완성/lifecycle, publish_mode 'disabled', mock 표시, 모든 파일 sha256
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError, extensionForMime, isUuid, NotFoundError, sha256Hex, stableStringify, writeZip, type ZipEntry } from '@cs/domain';
import type { Db } from './client';
import { getContentDetail } from './contents';
import type { BlobStore } from './export';
import { recordAudit } from './queries';
import { listVariantStates } from './variants';

export const PACKAGE_NOTICE = '배포 파일(수동 게시용). 자동 게시 아님 — 이 파일은 승인이나 게시 기록이 아닙니다.';

export function packagesDir(exportsDir: string, ownerId: string): string {
  if (!isUuid(ownerId)) throw new Error('잘못된 owner');
  return path.join(exportsDir, 'packages', ownerId);
}

export function packageZipPath(exportsDir: string, ownerId: string, packageId: string): string {
  if (!isUuid(packageId)) throw new NotFoundError('배포 파일을 찾을 수 없습니다');
  return path.join(packagesDir(exportsDir, ownerId), `${packageId}.zip`);
}

export interface PackageResult {
  packageId: string;
  zipPath: string;
  zipBytes: number;
  manifest: Record<string, unknown>;
  manifestSha256: string;
  warnings: string[];
}

const utf8 = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));

export async function buildVariantPackage(
  db: Db,
  storage: BlobStore,
  ownerId: string,
  contentId: string,
  opts: { exportsDir: string; llmMode: 'mock' | 'live'; publishMode: string; now?: Date },
): Promise<PackageResult> {
  const now = opts.now ?? new Date();
  const d = await getContentDetail(db, ownerId, contentId.toLowerCase());
  if (!d) throw new NotFoundError('원고를 찾을 수 없습니다');
  const states = (await listVariantStates(db, ownerId, d.content.id, d.current.id)).filter((s) => s.current !== null);
  if (states.length === 0) throw new AppError('conflict', 'no_variants', '배포 파일을 만들 채널 초안이 없습니다. 먼저 채널 초안을 만드세요.');

  const files: ZipEntry[] = [];
  const warnings: string[] = [];
  const variantsManifest: Record<string, unknown>[] = [];
  for (const s of states) {
    const v = s.current!;
    const ch = s.variant.channel;
    files.push({ path: `${ch}/${ch === 'blog' ? 'body.md' : 'body.txt'}`, bytes: utf8(v.body) });
    files.push({ path: `${ch}/metadata.json`, bytes: utf8(stableStringify(v.metadataJson)) });
    const assetList: Record<string, unknown>[] = [];
    for (const a of s.assets) {
      const p = `${ch}/assets/${String(a.position).padStart(2, '0')}-${a.role}.${extensionForMime(a.mime)}`;
      const bytes = await storage.get(a.key);
      const ok = bytes !== null && sha256Hex(bytes) === a.checksum;
      if (ok) files.push({ path: p, bytes: bytes! });
      else warnings.push(`${ch}: 첨부 ${a.position}번 파일이 저장소에 없거나 checksum 이 달라 넣지 않았습니다`);
      assetList.push({ position: a.position, role: a.role, asset_id: a.assetId, mime: a.mime, bytes: a.bytes, sha256: a.checksum, path: ok ? p : null, missing: !ok });
    }
    files.push({ path: `${ch}/assets.json`, bytes: utf8(stableStringify(assetList)) });
    variantsManifest.push({
      channel: ch,
      variant_id: s.variant.id,
      version_id: v.id,
      version: v.version,
      content_version_id: v.contentVersionId,
      lifecycle: s.variant.lifecycle,
      stale: s.stale,
      media: s.media,
      created_by: v.createdBy,
      ai_derived: v.aiRunId !== null,
      assets_included: assetList.filter((a) => !a.missing).length,
      assets_missing: assetList.filter((a) => a.missing).length,
    });
  }

  const packageId = randomUUID();
  const manifest = {
    format: 'content-studio-package',
    format_version: 1,
    package_id: packageId,
    notice: PACKAGE_NOTICE,
    is_approval: false,
    is_publication: false,
    publish_mode: opts.publishMode,
    mock: opts.llmMode === 'mock',
    generated_at: now.toISOString(),
    content: { id: d.content.id, title: d.content.title, lifecycle: d.content.lifecycle },
    core_version: { id: d.current.id, version: d.current.version },
    variants: variantsManifest,
    warnings,
    files: files.map((f) => ({ path: f.path, bytes: f.bytes.byteLength, sha256: sha256Hex(f.bytes) })),
  };
  const manifestBytes = utf8(stableStringify(manifest));
  const zip = writeZip([{ path: 'manifest.json', bytes: manifestBytes }, ...files], now);
  const dir = packagesDir(opts.exportsDir, ownerId);
  await mkdir(dir, { recursive: true });
  const zipPath = packageZipPath(opts.exportsDir, ownerId, packageId);
  await writeFile(zipPath, zip, { flag: 'wx' });
  const manifestSha256 = sha256Hex(manifestBytes);
  await recordAudit(db, {
    ownerId,
    action: 'package.create',
    entity: 'content',
    entityId: d.content.id,
    versionOrHash: manifestSha256,
    details: { package_id: packageId, variants: states.length, zip_bytes: zip.byteLength, warnings: warnings.length },
    at: now,
  });
  return { packageId, zipPath, zipBytes: zip.byteLength, manifest, manifestSha256, warnings };
}

/** owner 의 배포 파일 목록(최근 순, 최대 limit). 폴더가 없으면 빈 목록. */
export async function listPackages(exportsDir: string, ownerId: string, limit = 10): Promise<Array<{ id: string; bytes: number; createdAt: Date }>> {
  let names: string[];
  try {
    names = await readdir(packagesDir(exportsDir, ownerId));
  } catch {
    return [];
  }
  const out: Array<{ id: string; bytes: number; createdAt: Date }> = [];
  for (const n of names) {
    const id = n.replace(/\.zip$/u, '');
    if (!n.endsWith('.zip') || !isUuid(id)) continue;
    const s = await stat(path.join(packagesDir(exportsDir, ownerId), n));
    out.push({ id, bytes: s.size, createdAt: s.mtime });
  }
  return out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit);
}
