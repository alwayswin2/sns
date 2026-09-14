/**
 * run_integration_tests.js — 처리 루프 통합 테스트.
 *
 * 가짜 Gmail/Notion 을 붙여 실제 데이터를 건드리지 않고
 * idempotency / retry / partial failure / reconciliation / SMS webhook 을 검증한다.
 */
const { createHarness, makeFakeNotion, makeGmailMessages } = require('./gas_harness');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
function eq(name, a, b) { t(name, a === b, `기대=${JSON.stringify(b)} 실제=${JSON.stringify(a)}`); }

/* ── fixture ─────────────────────────────────────────────── */

function itemBlock(name, amountText, category, ci, co, resId, code) {
  return '<tr style="margin:0">' +
    `<td align="left" width="100%"><div><p>${name}</p></div></td>` +
    `<td align="right"><div><p><span>${amountText}</span></p></div></td></tr>` +
    `<div><p>${category} • ${ci} - ${co}</p>` +
    `<p>오픈특가할인 | 빌라 드 망미 | 광안리 (${resId})</p><p>${code}</p></div>`;
}

function payoutEmail(items, totalText, paid) {
  return '<div><p>₩100,000 KRW의 금액이 오늘 지급되었습니다</p></div>' +
    `<div><p>대금이 ${paid || '7월 2일'}에 지급되었으며, 2026년 7월 9일까지 입금될 예정입니다.</p></div>` +
    '<div><p>세부 정보</p></div>' + items.join('') +
    '<tr style="margin:0"><td align="left"><div><p>지급 총액:</p></div></td>' +
    `<td align="right"><div><p><span>${totalText}</span></p></div></td></tr>`;
}

const ONE_ITEM = payoutEmail(
  [itemBlock('윤주 김', '₩72,498 KRW', '숙소', '2026. 7. 1.', '2026. 7. 2.', '1700811717804874362', 'HM2ANY8Y2X')],
  '₩72,498 KRW');

const THREE_ITEMS = payoutEmail([
  itemBlock('게스트 하나', '₩10,000 KRW', '숙소', '2026. 7. 1.', '2026. 7. 2.', '1700811717804874362', 'HMAAA00001'),
  itemBlock('게스트 둘', '₩20,000 KRW', '숙소', '2026. 7. 3.', '2026. 7. 4.', '1700811717804874362', 'HMBBB00002'),
  itemBlock('게스트 셋', '₩30,000 KRW', '숙소', '2026. 7. 5.', '2026. 7. 6.', '1700811717804874362', 'HMCCC00003')
], '₩60,000 KRW');

function setup(msgs, notionOpts, extraProps) {
  const notion = makeFakeNotion(notionOpts);
  const h = createHarness({
    properties: Object.assign(
      { NOTION_TOKEN: 'secret_test', NOTION_DATABASE_ID: 'db_test', ALERT_EMAIL: 'me@example.com', SMS_WEBHOOK_SECRET: 's3cret' },
      extraProps || {}),
    fetchHandler: notion.handler,
    gmailSearch: () => makeGmailMessages(msgs)
  });
  return { h, notion };
}

/* ── 1. Idempotency ──────────────────────────────────────── */
console.log('[Idempotency — 같은 메일 3회 실행]');
{
  const { h, notion } = setup([{ id: 'MSG_A', subject: '지급', date: '2026-07-02', html: ONE_ITEM }]);
  const r1 = h.ctx.processNewPayoutEmails();
  eq('1회차 기록 행수', r1.stats.inserted_rows, 1);
  eq('1회차 상태', r1.stats.errors, 0);

  const r2 = h.ctx.processNewPayoutEmails();
  eq('2회차 추가 행수', r2.stats.inserted_rows, 0);
  const r3 = h.ctx.processNewPayoutEmails();
  eq('3회차 추가 행수', r3.stats.inserted_rows, 0);
  eq('Notion 총 행수는 1', notion.pages.length, 1);

  // 캐시가 날아가도 Notion 조회로 중복이 막혀야 한다
  h.ctx.clearProcessedCache();
  const r4 = h.ctx.processNewPayoutEmails();
  eq('캐시 초기화 후에도 추가 없음', r4.stats.inserted_rows, 0);
  eq('캐시 초기화 후 Notion 행수 유지', notion.pages.length, 1);
}

/* ── 2. Retry — Notion 실패 후 재시도 ────────────────────── */
console.log('\n[Retry — Notion 기록 실패 시 processed 처리 금지]');
{
  const { h, notion } = setup(
    [{ id: 'MSG_B', subject: '지급', date: '2026-07-02', html: ONE_ITEM }],
    { failCreateAt: [1] }   // 첫 생성 시도만 실패
  );
  const r1 = h.ctx.processNewPayoutEmails();
  eq('실패 시 기록 행수 0', r1.stats.inserted_rows, 0);
  eq('실패는 errors 로 집계', r1.stats.errors, 1);
  t('실패 메일은 processed 에 없음', !h.ctx.isProcessedCached('MSG_B'));
  t('실패 시 알림 발송', h.sentMail.length >= 1, JSON.stringify(h.sentMail.map(m => m.subject)));

  // 장애 해소 후 재실행
  notion.state.failedKeys = {};
  notion.state.failCreateAt = [];
  const r2 = h.ctx.processNewPayoutEmails();
  eq('재실행에서 정상 기록', r2.stats.inserted_rows, 1);
  eq('재실행 후 Notion 행수', notion.pages.length, 1);
  t('성공 후 processed 등록', h.ctx.isProcessedCached('MSG_B'));
}

/* ── 3. Partial failure — 3건 중 3번째 실패 ──────────────── */
// 다건 기록이 허용되는 조건(AMOUNT_FIELD_MODE='item')에서 검증한다.
// 기본 정책('total')에서는 다건 메일이 MANUAL_REVIEW 로 잡혀 기록 자체를 하지 않는다(테스트 11).
console.log('\n[Partial failure — 3항목 중 3번째 기록 실패]');
{
  const { h, notion } = setup(
    [{ id: 'MSG_C', subject: '지급', date: '2026-07-02', html: THREE_ITEMS }],
    { failCreateAt: [3] },  // 3번째 생성만 실패
    { AMOUNT_FIELD_MODE: 'item' }
  );
  const r1 = h.ctx.processNewPayoutEmails();
  eq('1회차 기록 행수(2건 성공)', r1.stats.inserted_rows, 2);
  eq('1회차 오류 집계', r1.stats.errors, 1);
  t('부분 실패 메일은 processed 아님', !h.ctx.isProcessedCached('MSG_C'));

  // 장애가 해소된 상황을 만든다(Notion 복구).
  notion.state.failedKeys = {};
  notion.state.failCreateAt = [];
  const r2 = h.ctx.processNewPayoutEmails();
  eq('재실행에서 남은 1건만 기록', r2.stats.inserted_rows, 1);
  eq('총 행수는 3 (1·2번 중복 없음)', notion.pages.length, 3);

  const names = notion.pages.map(p => p.properties['게스트명'].title[0].plain_text).sort();
  eq('기록된 게스트', names.join(','), '게스트 둘,게스트 셋,게스트 하나');

  const r3 = h.ctx.processNewPayoutEmails();
  eq('추가 실행해도 행 증가 없음', r3.stats.inserted_rows, 0);
  eq('최종 행수 3 유지', notion.pages.length, 3);
}

/* ── 4. Silent failure — items 0건 ───────────────────────── */
console.log('\n[Silent failure — 총액은 있고 항목 0건]');
{
  const broken = '<div><p>₩50,000 KRW의 금액이 오늘 지급되었습니다</p></div>' +
    '<div><p>대금이 7월 2일에 지급되었으며, 2026년 7월 9일까지 입금될 예정입니다.</p></div>' +
    '<div><p>세부 정보</p></div>' +
    '<tr><td align="left"><div><p>지급 총액:</p></div></td><td align="right"><div><p><span>₩50,000 KRW</span></p></div></td></tr>';
  const { h, notion } = setup([{ id: 'MSG_D', subject: '지급', date: '2026-07-02', html: broken }]);
  const r = h.ctx.processNewPayoutEmails();
  eq('오류로 집계', r.stats.errors, 1);
  eq('Notion 기록 없음', notion.pages.length, 0);
  t('processed 처리 안 됨', !h.ctx.isProcessedCached('MSG_D'));
  t('알림 발송됨', h.sentMail.length >= 1);
  t('알림에 PARSE_ERROR 표시', h.sentMail.some(m => m.subject.indexOf('PARSE_ERROR') >= 0),
    JSON.stringify(h.sentMail.map(m => m.subject)));
}

/* ── 5. Negative only → MANUAL_REVIEW ────────────────────── */
console.log('\n[전 항목 음수 — MANUAL_REVIEW]');
{
  const negOnly = payoutEmail(
    [itemBlock('미영 황', '-₩14,914 KRW', '공동 호스트 수입 분배', '2026. 8. 13.', '2026. 8. 15.', '1700811717804874362', 'HMYFK83ADT')],
    '₩283,374 KRW', '8월 14일');
  const { h, notion } = setup([{ id: 'MSG_E', subject: '지급', date: '2026-08-14', html: negOnly }]);
  const r = h.ctx.processNewPayoutEmails();
  eq('manual_review 집계', r.stats.manual_review, 1);
  eq('오류는 아님', r.stats.errors, 0);
  eq('행 기록 없음(양수 없음)', notion.pages.length, 0);
  t('processed 처리 안 함(사람 확인 필요)', !h.ctx.isProcessedCached('MSG_E'));
  t('MANUAL_REVIEW 알림', h.sentMail.some(m => m.subject.indexOf('MANUAL_REVIEW') >= 0));
}

/* ── 6. SKIPPED_EXPECTED ─────────────────────────────────── */
console.log('\n[장부 대상 아닌 메일]');
{
  const { h, notion } = setup([
    { id: 'MSG_F', subject: '세미님에게 금액을 지급하셨습니다.', date: '2026-07-16', html: '<div><p>세미님에게 금액을 지급하셨습니다.</p></div>' },
    { id: 'MSG_G', subject: '초안 저장 완료', date: '2026-07-08', html: '<div><p>초안 저장 완료: 민서 님에게 보내는 보상금 지급 요청</p></div>' }
  ]);
  const r = h.ctx.processNewPayoutEmails();
  eq('skipped_expected 2건', r.stats.skipped_expected, 2);
  eq('오류 없음', r.stats.errors, 0);
  eq('행 기록 없음', notion.pages.length, 0);
  t('알림 없음', h.sentMail.length === 0, JSON.stringify(h.sentMail.map(m => m.subject)));
  t('processed 처리됨(다시 안 봄)', h.ctx.isProcessedCached('MSG_F') && h.ctx.isProcessedCached('MSG_G'));
}

/* ── 7. Reconciliation ───────────────────────────────────── */
console.log('\n[Reconciliation — Notion 행이 없는 정산 메일 탐지]');
{
  const recent = new Date(Date.now() - 3 * 864e5);
  const mm = recent.getMonth() + 1, dd = recent.getDate();
  const iso = `${recent.getFullYear()}. ${mm}. ${dd}.`;
  const html = payoutEmail(
    [itemBlock('복구 대상', '₩55,000 KRW', '숙소', iso, iso, '1700811717804874362', 'HMREC00001')],
    '₩55,000 KRW', `${mm}월 ${dd}일`);

  const { h, notion } = setup([{ id: 'MSG_H', subject: '지급', date: recent.toISOString(), html }]);
  // 캐시에 넣어 평상시 루프가 건너뛰게 만든 뒤(=누락 상황 재현) 대사로 잡히는지 본다
  h.ctx.markProcessed('MSG_H');
  const before = h.ctx.processNewPayoutEmails();
  eq('평상시 루프는 건너뜀', before.stats.inserted_rows, 0);
  eq('Notion 은 여전히 비어 있음', notion.pages.length, 0);

  const rec = h.ctx.reconcileRecentPayouts(30, true);
  eq('누락 1건 발견', rec.missing.length, 1);
  eq('자동 복구된 행', rec.recovered, 1);
  eq('복구 후 Notion 행수', notion.pages.length, 1);

  const rec2 = h.ctx.reconcileRecentPayouts(30, true);
  eq('재대사 시 누락 0', rec2.missing.length, 0);
  eq('중복 생성 없음', notion.pages.length, 1);
}

/* ── 8. SMS webhook ──────────────────────────────────────── */
console.log('\n[SMS Webhook]');
{
  const { h, notion } = setup([{ id: 'MSG_I', subject: '지급', date: '2026-07-02', html: ONE_ITEM }]);
  const post = body => JSON.parse(h.ctx.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());

  const bad = post({ secret: 'wrong', text: '68,873원 입금 토스뱅크 26/7/2' });
  eq('잘못된 secret 거부', bad.status, 'unauthorized');
  eq('거부 시 Notion 변경 없음', notion.pages.length, 0);

  const noText = post({ secret: 's3cret' });
  eq('필수값 누락 거부', noText.status, 'error');
  eq('누락 시 Notion 변경 없음', notion.pages.length, 0);

  const badAmount = post({ secret: 's3cret', text: '광고 문자입니다' });
  eq('금액 형식 이상은 무시', badAmount.status, 'ignored');
  eq('무시 시 Notion 변경 없음', notion.pages.length, 0);

  const withdrawal = post({ secret: 's3cret', text: '출금 5,000원 스타벅스' });
  eq('출금 문자는 무시', withdrawal.status, 'ignored');

  const ok = post({ secret: 's3cret', text: '68,873원 입금 토스뱅크 26/7/2' });
  eq('정상 secret 처리', ok.status, 'ok');
  eq('SMS 금액 인식', ok.sms.amount, 68873);
  eq('메일 처리 함께 실행', notion.pages.length, 1);

  const dup = post({ secret: 's3cret', text: '68,873원 입금 토스뱅크 26/7/2' });
  eq('중복 SMS 는 행을 늘리지 않음', notion.pages.length, 1);
  eq('중복 SMS 도 정상 응답', dup.status, 'ok');

  const logged = h.logs.join('\n') + JSON.stringify(h.sentMail);
  t('secret 이 로그에 남지 않음', logged.indexOf('s3cret') < 0);
}

/* ── 9. Notion 조회 실패 시 안전 동작 ────────────────────── */
console.log('\n[Notion 조회 실패]');
{
  const { h, notion } = setup(
    [{ id: 'MSG_J', subject: '지급', date: '2026-07-02', html: ONE_ITEM }],
    { failQuery: true });
  const r = h.ctx.processNewPayoutEmails();
  eq('오류로 집계', r.stats.errors, 1);
  eq('행 생성 없음', notion.pages.length, 0);
  t('processed 처리 안 됨', !h.ctx.isProcessedCached('MSG_J'));
  t('재시도 가능 안내 포함', h.sentMail.some(m => m.body.indexOf('재시도 가능  : 예') >= 0));
}

/* ── 10. 헬스체크 ────────────────────────────────────────── */
console.log('\n[헬스체크 — "메일 없음"과 "자동화 멈춤" 구분]');
{
  const notion = makeFakeNotion({});
  const h = createHarness({
    properties: {
      NOTION_TOKEN: 'secret_test', NOTION_DATABASE_ID: 'db_test', ALERT_EMAIL: 'me@example.com',
      LAST_SUCCESS_RUN: new Date().toISOString()
    },
    fetchHandler: notion.handler,
    gmailSearch: () => [],   // 메일이 하나도 없는 상태
    triggers: [{ getHandlerFunction: () => 'processNewPayoutEmails' }]
  });
  const problems = h.ctx.dailyHealthCheck();
  t('메일이 없어도 장애로 보지 않음', problems.length === 0, JSON.stringify(problems));

  const stale = createHarness({
    properties: {
      NOTION_TOKEN: 'secret_test', NOTION_DATABASE_ID: 'db_test', ALERT_EMAIL: 'me@example.com',
      LAST_SUCCESS_RUN: new Date(Date.now() - 72 * 36e5).toISOString()
    },
    fetchHandler: notion.handler,
    gmailSearch: () => [],
    triggers: [{ getHandlerFunction: () => 'processNewPayoutEmails' }]
  });
  const p2 = stale.ctx.dailyHealthCheck();
  t('오래 멈추면 장애로 감지', p2.length >= 1 && p2[0].indexOf('시간 전') >= 0, JSON.stringify(p2));
  t('멈춤 알림 발송', stale.sentMail.length >= 1);

  const noTrigger = createHarness({
    properties: { NOTION_TOKEN: 'secret_test', NOTION_DATABASE_ID: 'db_test', LAST_SUCCESS_RUN: new Date().toISOString() },
    fetchHandler: notion.handler,
    gmailSearch: () => [],
    triggers: []
  });
  const p3 = noTrigger.ctx.dailyHealthCheck();
  t('트리거 없으면 경고', p3.some(x => x.indexOf('트리거') >= 0), JSON.stringify(p3));
}

/* ── 11. 입금액 정책 (A안: 총액 = 실입금) ───────────────── */
console.log('\n[입금액 정책 — 기본은 총액(실입금), 다건 메일은 MANUAL_REVIEW]');
{
  // 게스트 1명: 총액이 곧 실입금이므로 그대로 기록된다.
  const { h, notion } = setup([{ id: 'MSG_K', subject: '지급', date: '2026-07-02', html: ONE_ITEM }]);
  const r = h.ctx.processNewPayoutEmails();
  eq('단일 게스트는 정상 기록', r.stats.inserted_rows, 1);
  eq('입금액에 총액이 들어감', notion.pages[0].properties['입금액'].number, 72498);

  // 게스트 2명 이상: 총액을 행마다 넣으면 합계가 부풀려지므로 기록하지 않고 사람 확인.
  const { h: h2, notion: n2 } = setup([{ id: 'MSG_L', subject: '지급', date: '2026-07-02', html: THREE_ITEMS }]);
  const r2 = h2.ctx.processNewPayoutEmails();
  eq('다건 메일은 MANUAL_REVIEW', r2.stats.manual_review, 1);
  eq('다건 메일은 기록하지 않음', n2.pages.length, 0);
  t('다건 메일은 processed 처리 안 함', !h2.ctx.isProcessedCached('MSG_L'));
  t('다건 알림 발송', h2.sentMail.some(m => m.subject.indexOf('MANUAL_REVIEW') >= 0));
  t('알림에 게스트 수 안내', h2.sentMail.some(m => m.body.indexOf('3명') >= 0),
    JSON.stringify(h2.sentMail.map(m => m.body.slice(0, 200))));

  // item 모드로 바꾸면 게스트별 금액으로 다건도 기록된다.
  const { h: h3, notion: n3 } = setup(
    [{ id: 'MSG_M', subject: '지급', date: '2026-07-02', html: THREE_ITEMS }], null,
    { AMOUNT_FIELD_MODE: 'item' });
  const r3 = h3.ctx.processNewPayoutEmails();
  eq('item 모드에서는 다건 기록', r3.stats.inserted_rows, 3);
  const amounts = n3.pages.map(p => p.properties['입금액'].number).sort((a, b) => a - b);
  eq('항목별 금액이 들어감', amounts.join(','), '10000,20000,30000');
}

/* ── 12. MANUAL_REVIEW 는 행을 만들지 않는다 ─────────────── */
console.log('\n[MANUAL_REVIEW — 잘못된 값을 미리 써두지 않음]');
{
  const negOnly = payoutEmail(
    [itemBlock('미영 황', '-₩14,914 KRW', '공동 호스트 수입 분배', '2026. 8. 13.', '2026. 8. 15.', '1700811717804874362', 'HMYFK83ADT')],
    '₩283,374 KRW', '8월 14일');
  const { h, notion } = setup([{ id: 'MSG_N', subject: '지급', date: '2026-08-14', html: negOnly }]);
  h.ctx.processNewPayoutEmails();
  eq('전 항목 음수는 행 생성 안 함', notion.pages.length, 0);

  // 항목합 ≠ 총액 (외화 섞임)
  const mixed = payoutEmail(
    [itemBlock('Amy Min', '₩179,782 KRW', '숙소', '2026. 6. 27.', '2026. 6. 28.', '1700811717804874362', 'HM2PJBP582')],
    '₩255,287 KRW', '6월 28일');
  const { h: h2, notion: n2 } = setup([{ id: 'MSG_O', subject: '지급', date: '2026-06-28', html: mixed }]);
  const r2 = h2.ctx.processNewPayoutEmails();
  eq('항목합≠총액은 MANUAL_REVIEW', r2.stats.manual_review, 1);
  eq('항목합≠총액은 행 생성 안 함', n2.pages.length, 0);
  t('사람이 확인하도록 알림', h2.sentMail.some(m => m.body.indexOf('255287') >= 0));
}

/* ── 결과 ────────────────────────────────────────────────── */
console.log(`\n통합 테스트 결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail === 0 ? 0 : 1);
