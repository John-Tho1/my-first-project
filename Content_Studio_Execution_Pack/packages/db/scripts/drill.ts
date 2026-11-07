/**
 * `pnpm drill:mock` — T12(D19) M3 게이트 훈련. 버리는 메모리 DB 에서 모의 채널 어댑터 시나리오 행렬·PARTIAL 계획·더블 실행·
 * worker 2개·lease 만료·재시작·A10 을 끝까지 돌리고 표를 찍는다. 불변식을 하나라도 어기면 exit 1.
 * 외부 호출·실제 채널·비밀 없음(fetch 를 막아 두고 호출 수를 센다). 결과는 모두 MOCK — 실제 발행 실적이 아니다.
 */
import { formatDrillTable, runDrill } from './drill-matrix';
import { formatThreadsDrillTable, runThreadsDrill } from './drill-threads';
import { formatInstagramDrillTable, runInstagramDrill } from './drill-instagram';
import { formatYouTubeDrillTable, runYouTubeDrill } from './drill-youtube';

const started = Date.now();
const r = await runDrill();
console.log('M3 모의 배포 훈련(MOCK — 실제 발행 실적 아님, 외부 호출 없음)\n');
console.log(formatDrillTable(r));
console.log('');
for (const p of r.plans) console.log(`계획: ${p.name} — ${p.statuses.join(' → ')}`);
console.log(`모의 submit 합계 ${r.submits} · fetch 호출 ${r.fetch_calls} · ${((Date.now() - started) / 1000).toFixed(1)}초`);
// T14(D26): Threads 모의(모의 OAuth 연결 계정 — 컨테이너 → 게시 2단계) 표. M3 표(일반 모의 계정)는 위와 같이 그대로.
const t = await runThreadsDrill();
console.log('\nT14 Threads 모의 훈련(MOCK — 모의 OAuth·모의 Threads, 실제 발행 실적 아님, 외부 호출 없음)\n');
console.log(formatThreadsDrillTable(t));
console.log(`Threads fetch 호출 ${t.fetch_calls}`);
// T15(D27): YouTube 모의(Google 형 모의 OAuth 연결 계정 — 재개 업로드·처리·조건부 예약) 표.
const y = await runYouTubeDrill();
console.log('\nT15 YouTube 모의 훈련(MOCK — 모의 Google OAuth·모의 YouTube, 합성 영상, 실제 발행 실적 아님, 외부 호출 없음)\n');
console.log(formatYouTubeDrillTable(y));
console.log(`YouTube fetch 호출 ${y.fetch_calls}`);
// T16(D29 제안): Instagram 모의(Meta 형 모의 OAuth 연결 계정 — 이미지·캐러셀 컨테이너 → 게시, 모의 공개 미디어 URL) 표.
const g = await runInstagramDrill();
console.log('\nT16 Instagram 모의 훈련(MOCK — 모의 Meta OAuth·모의 Instagram·모의 공개 URL, 합성 이미지, 실제 발행 실적 아님, 외부 호출 없음)\n');
console.log(formatInstagramDrillTable(g));
console.log(`Instagram fetch 호출 ${g.fetch_calls}`);
const violations = [...r.violations, ...t.violations, ...y.violations, ...g.violations];
if (violations.length) {
  console.error(`\n불변식 위반 ${violations.length}건:`);
  for (const v of violations) console.error(`- ${v}`);
  process.exit(1);
}
console.log('불변식 위반 0건 — M3 게이트 통과(MOCK), T14 Threads 모의 불변식 통과(MOCK), T15 YouTube 모의 불변식 통과(MOCK), T16 Instagram 모의 불변식 통과(MOCK)');
