/** gas/Tests.gs 의 runAllTests 를 Node 에서 실행한다. */
const { createHarness } = require('./gas_harness');
const h = createHarness({});
const r = h.ctx.runAllTests();
console.log(r.report);
process.exit(r.fail === 0 ? 0 : 1);
