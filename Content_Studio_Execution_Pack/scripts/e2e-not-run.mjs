// M0: Playwright 브라우저 바이너리 다운로드가 승인되지 않아 E2E를 실행하지 않는다.
// 통과로 오인되지 않도록 0이 아닌 종료 코드(2)를 사용한다.
console.log('NOT_RUN: Playwright E2E는 M0에서 실행하지 않는다 (브라우저 다운로드 미승인)');
process.exit(2);
