/**
 * `pnpm bundle:check <zip>` — 내보내기 묶음(ZIP)을 믿고 보관하기 전에 **읽기 전용**으로 확인한다(FIX2-LIVEL1H2, 인계 LIVEL1 수동 해결 절차 7).
 * 복원 미리보기와 같은 묶음 검증(checkBundleZip → parseBundleZip: 파일 sha256·행 스키마·참조 무결성 — 수동 해결 resolution 형식 포함)만 한다.
 * DB 를 열지 않고 아무 파일도 쓰지 않으며 .env.local 도 읽지 않는다 — dev 서버가 켜져 있어도 된다(restore:preview 는 앱을 멈추고 대상 DB 에 기록을 남긴다).
 * 출력: JSON 한 줄(통과는 stdout, 실패는 stderr — 오류 코드·고정 문구·문제 목록만, 값 없음).
 * 종료 코드: 0 통과 · 1 검증 실패 또는 파일을 읽지 못함 · 2 사용법 오류. 상대 경로는 워크스페이스 루트 기준(다른 DB 스크립트와 같음).
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkBundleZip, resolveFromRoot } from '../src/index';

const args = process.argv.slice(2);
if (args.length !== 1 || !args[0] || args[0].startsWith('-')) {
  console.error('사용법: pnpm bundle:check <zip>   (예: pnpm bundle:check data/exports/<id>.zip)');
  process.exit(2);
}
const zipPath = resolveFromRoot(args[0]);
let zip: Uint8Array;
try {
  zip = new Uint8Array(await readFile(zipPath));
} catch {
  console.error(JSON.stringify({ ok: false, action: 'bundle.check', error: 'unreadable_file', message: `파일을 읽을 수 없습니다: ${path.basename(zipPath)}` }));
  process.exit(1);
}
const r = await checkBundleZip(zip);
if (r.ok) {
  console.log(JSON.stringify({ action: 'bundle.check', ...r }));
} else {
  console.error(JSON.stringify({ action: 'bundle.check', ...r }));
  process.exitCode = 1;
}
