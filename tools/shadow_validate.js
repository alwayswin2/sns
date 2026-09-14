/**
 * shadow_validate.js — 실제 Gmail 정산 메일 전체를 신규 파서로 돌려
 * 현재 Notion 장부와 비교한다. (읽기 전용 — 아무것도 기록하지 않는다)
 *
 * 입력 파일(로컬에서 미리 뽑아둔 것):
 *   gmail_msgs.json  : [{id, subject, internalDate, text, html}]
 *   notion_rows.json : [{정산일, 게스트명, 예약ID, 체크인, 체크아웃, 입금액, 이메일ID, ...}]
 *
 * 사용법: node tools/shadow_validate.js <디렉터리>
 */
const fs = require('fs');
const path = require('path');
const { createHarness } = require('./gas_harness');

const dir = process.argv[2];
if (!dir) {
  console.error('사용법: node tools/shadow_validate.js <gmail_msgs.json 이 있는 디렉터리>');
  process.exit(2);
}

const msgs = JSON.parse(fs.readFileSync(path.join(dir, 'gmail_msgs.json'), 'utf8'));
const rows = JSON.parse(fs.readFileSync(path.join(dir, 'notion_rows.json'), 'utf8'));

const h = createHarness({});
const { parsePayoutEmail, validateParsed } = h.ctx;

const notionByEmail = new Map();
for (const r of rows) {
  const k = r['이메일ID'] || '';
  if (!notionByEmail.has(k)) notionByEmail.set(k, []);
  notionByEmail.get(k).push(r);
}

const statusCount = {};
const report = { missing: [], parseErrors: [], manualReview: [], skipped: [], amountFixes: [], fieldDiffs: [] };

for (const m of msgs) {
  const p = parsePayoutEmail(m.html);
  const v = validateParsed(p);
  statusCount[v.status] = (statusCount[v.status] || 0) + 1;

  if (v.status === 'PARSE_ERROR') report.parseErrors.push({ id: m.id, subject: m.subject, reason: v.reason });
  if (v.status === 'MANUAL_REVIEW') report.manualReview.push({ id: m.id, subject: m.subject, reason: v.reason });
  if (v.status === 'SKIPPED_EXPECTED') report.skipped.push({ id: m.id, subject: m.subject });
  if (v.status !== 'SUCCESS' && v.status !== 'MANUAL_REVIEW') continue;

  const existing = notionByEmail.get(m.id) || [];
  if (existing.length === 0) {
    report.missing.push({ id: m.id, subject: m.subject, date: p.payoutDate });
    continue;
  }

  // 기존 행과 항목별 비교
  for (const it of p.items.filter(x => x.amount > 0)) {
    const match = existing.find(e => e['게스트명'] === it.guestName);
    if (!match) {
      report.fieldDiffs.push({ id: m.id, field: '게스트명', parsed: it.guestName,
                               notion: existing.map(e => e['게스트명']).join('|') });
      continue;
    }
    if (match['입금액'] !== it.amount) {
      report.amountFixes.push({ id: m.id, guest: it.guestName,
                                notion: match['입금액'], correct: it.amount, payoutTotal: p.total });
    }
    for (const [field, parsedVal, notionVal] of [
      ['체크인', it.checkin, match['체크인']],
      ['체크아웃', it.checkout, match['체크아웃']],
      ['예약ID', it.reservationId, match['예약ID']],
      ['정산일', p.payoutDate, match['정산일']]
    ]) {
      if (parsedVal && notionVal && parsedVal !== notionVal) {
        report.fieldDiffs.push({ id: m.id, guest: it.guestName, field, parsed: parsedVal, notion: notionVal });
      }
    }
  }
}

console.log('=== Shadow Validation (읽기 전용) ===');
console.log('Gmail 정산 메일 총 ' + msgs.length + '건\n');
console.log('상태 분포:');
for (const k of Object.keys(statusCount).sort()) console.log('  ' + k.padEnd(18) + statusCount[k]);

console.log('\n[1] 파싱 실패(PARSE_ERROR): ' + report.parseErrors.length + '건');
report.parseErrors.forEach(e => console.log('   ' + e.id + ' — ' + e.reason));

console.log('\n[2] Notion 에 없는 정산 메일(누락): ' + report.missing.length + '건');
report.missing.forEach(e => console.log('   ' + e.id + ' ' + e.date + ' ' + e.subject.slice(0, 40)));

console.log('\n[3] 사람 확인 필요(MANUAL_REVIEW): ' + report.manualReview.length + '건');
report.manualReview.forEach(e => console.log('   ' + e.id + ' — ' + e.reason));

console.log('\n[4] 장부 대상 아님(SKIPPED_EXPECTED): ' + report.skipped.length + '건');
report.skipped.forEach(e => console.log('   ' + e.id + ' ' + e.subject.slice(0, 45)));

console.log('\n[5] 날짜/예약ID/게스트명 불일치: ' + report.fieldDiffs.length + '건');
report.fieldDiffs.forEach(e => console.log('   ' + e.id + ' ' + e.field + ' 파서=' + e.parsed + ' 기존=' + e.notion));

console.log('\n[6] 금액 차이(기존 장부 오류로 추정): ' + report.amountFixes.length + '건');
let sumOld = 0, sumNew = 0;
report.amountFixes.forEach(e => {
  sumOld += e.notion; sumNew += e.correct;
  console.log('   ' + e.id + ' ' + String(e.guest).padEnd(14) +
              ' 기존=' + String(e.notion).padStart(9) +
              ' 실제항목=' + String(e.correct).padStart(9) +
              ' (메일총액=' + e.payoutTotal + ')');
});
if (report.amountFixes.length) {
  console.log('   합계: 기존 ' + sumOld.toLocaleString() + ' → 항목기준 ' + sumNew.toLocaleString() +
              ' (차이 ' + (sumNew - sumOld).toLocaleString() + ')');
}

fs.writeFileSync(path.join(dir, 'shadow_report.json'), JSON.stringify(report, null, 1));
console.log('\n상세 리포트 저장: ' + path.join(dir, 'shadow_report.json'));

const blocking = report.parseErrors.length + report.missing.length + report.fieldDiffs.length;
console.log('\n=> 차단 요인(파싱실패+누락+필드불일치): ' + blocking + '건');
process.exit(blocking === 0 ? 0 : 1);
