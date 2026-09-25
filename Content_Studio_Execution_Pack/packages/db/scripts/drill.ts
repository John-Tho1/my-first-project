/**
 * `pnpm drill:mock` — T12(D19) M3 게이트 훈련. 버리는 메모리 DB 에서 모의 채널 어댑터 시나리오 행렬·PARTIAL 계획·더블 실행·
 * worker 2개·lease 만료·재시작·A10 을 끝까지 돌리고 표를 찍는다. 불변식을 하나라도 어기면 exit 1.
 * 외부 호출·실제 채널·비밀 없음(fetch 를 막아 두고 호출 수를 센다). 결과는 모두 MOCK — 실제 발행 실적이 아니다.
 */
import { formatDrillTable, runDrill } from './drill-matrix';

const started = Date.now();
const r = await runDrill();
console.log('M3 모의 배포 훈련(MOCK — 실제 발행 실적 아님, 외부 호출 없음)\n');
console.log(formatDrillTable(r));
console.log('');
for (const p of r.plans) console.log(`계획: ${p.name} — ${p.statuses.join(' → ')}`);
console.log(`모의 submit 합계 ${r.submits} · fetch 호출 ${r.fetch_calls} · ${((Date.now() - started) / 1000).toFixed(1)}초`);
if (r.violations.length) {
  console.error(`\n불변식 위반 ${r.violations.length}건:`);
  for (const v of r.violations) console.error(`- ${v}`);
  process.exit(1);
}
console.log('불변식 위반 0건 — M3 게이트 통과(MOCK)');
