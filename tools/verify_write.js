/**
 * 쓰기 경로 검증 — 실제 Gmail 61건을 "빈" 가짜 Notion 에 처리시켜
 * GAS 가 실제로 행을 생성하는지(미검증이던 유일한 경로) 확인한다.
 * 실데이터는 읽기만 하고, 쓰기는 전부 가짜 Notion 으로 간다.
 */
const fs = require('fs');
const path = require('path');
const H = require('./gas_harness');
const { createHarness, makeFakeNotion, makeGmailMessages } = H;

const dir = process.argv[2];
if (!dir) {
  console.error('사용법: node tools/verify_write.js <gmail_msgs.json 이 있는 디렉터리>');
  console.error('  덤프는 shadow_validate.js 와 같은 형식을 쓴다(Gmail/Notion 읽기 전용).');
  process.exit(2);
}
const msgs = JSON.parse(fs.readFileSync(path.join(dir, 'gmail_msgs.json'), 'utf8'));

const gmailList = msgs.map(m => ({
  id: m.id,
  subject: m.subject,
  date: new Date(Number(m.internalDate)).toISOString().slice(0, 10),
  html: m.html,
  text: m.text
}));

const notion = makeFakeNotion({});
const h = createHarness({
  properties: {
    NOTION_TOKEN: 'secret_test', NOTION_DATABASE_ID: 'db_test',
    ALERT_EMAIL: 'me@example.com', SMS_WEBHOOK_SECRET: 's3cret'
  },
  fetchHandler: notion.handler,
  gmailSearch: () => makeGmailMessages(gmailList)
});

console.log('=== 쓰기 경로 검증: 실제 Gmail ' + gmailList.length + '건 → 빈 가짜 Notion ===\n');
const R1 = h.ctx.processNewPayoutEmails();
const r = R1.stats;
console.log("summary:", R1.summary);

console.log('[1회차 결과]');
console.log('  scanned        =', r.scanned);
console.log('  candidate      =', r.candidate);
console.log('  parsed(SUCCESS)=', r.parsed);
console.log('  inserted_rows  =', r.inserted_rows, '  <-- 실제로 생성된 행 수');
console.log('  duplicate      =', r.duplicate);
console.log('  skipped_expected=', r.skipped_expected);
console.log('  manual_review  =', r.manual_review);
console.log('  errors         =', r.errors);
console.log('  가짜 Notion 페이지 수 =', notion.pages.length);

// 생성된 행의 필드가 온전한지 확인
const bad = [];
for (const p of notion.pages) {
  const pr = p.properties;
  const guest = (pr['게스트명'] && pr['게스트명'].title || []).map(x => x.plain_text).join('');
  const amt = pr['입금액'] && pr['입금액'].number;
  const eid = (pr['이메일ID'] && pr['이메일ID'].rich_text || []).map(x => x.plain_text).join('');
  const d = pr['정산일'] && pr['정산일'].date && pr['정산일'].date.start;
  const resv = (pr['예약ID'] && pr['예약ID'].rich_text || []).map(x => x.plain_text).join('');
  if (!guest || !amt || !eid || !d || !resv) bad.push({ guest, amt, eid, d, resv });
}
console.log('\n[2] 필수 필드 누락 행:', bad.length + '건');
bad.slice(0, 5).forEach(b => console.log('   ', JSON.stringify(b)));

console.log('\n[3] 생성된 행 샘플 (최근 6)');
notion.pages.slice(-6).forEach(p => {
  const pr = p.properties;
  const g = (pr['게스트명'].title || []).map(x => x.plain_text).join('');
  const e = (pr['이메일ID'].rich_text || []).map(x => x.plain_text).join('');
  console.log('   ', pr['정산일'].date.start, String(g).padEnd(14), String(pr['입금액'].number).padStart(9), e);
});

// 멱등성: 같은 상태로 한 번 더
const R2 = h.ctx.processNewPayoutEmails();
const r2 = R2.stats;
console.log("summary:", R2.summary);
console.log('\n[4] 재실행(멱등성) — 새로 생긴 행이 없어야 한다');
console.log('  inserted_rows =', r2.inserted_rows, '(0 이어야 정상)');
console.log('  duplicate     =', r2.duplicate);
console.log('  가짜 Notion 페이지 수 =', notion.pages.length, '(1회차와 같아야 정상)');

console.log('\n=== 판정 ===');
const ok = r.inserted_rows > 0 && bad.length === 0 && r2.inserted_rows === 0 && r.errors === 0;
console.log(ok ? 'PASS — 쓰기 경로 정상 동작, 재실행 시 중복 생성 없음' : 'FAIL — 위 수치 확인 필요');
