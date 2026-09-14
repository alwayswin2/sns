/**
 * Tests.gs — 파서/검증/상태 로직 테스트.
 *
 * 실제 Gmail·Notion 을 건드리지 않는다. 전부 fixture 기반이라 반복 실행해도 안전하다.
 * Apps Script 편집기에서 runAllTests 를 실행하면 결과가 로그에 나온다.
 * (같은 파일이 Node 로도 실행되어 CI/로컬 검증에 쓰인다 — tools/run_gas_tests.js)
 */

/* ── fixture 생성기 ───────────────────────────────────────────── */

/** 실제 에어비앤비 메일과 같은 형태의 항목 블록 */
function fx_item_(name, amountText, category, checkin, checkout, resId, code) {
  return '' +
    '<tr style="margin:0">' +
      '<td align="left" width="100%"><div><p style="font-weight:700">' + name + '</p></div></td>' +
      '<td align="right"><div><p><span style="white-space:nowrap">' + amountText + '</span></p></div></td>' +
    '</tr>' +
    '<div style="padding-left:48px">' +
      '<p>' + category + ' • ' + checkin + ' - ' + checkout + '</p>' +
      '<p>오픈특가할인 | 빌라 드 망미 | 광안리 | 센텀시티 (' + resId + ')</p>' +
      '<p>' + code + '</p>' +
    '</div>';
}

function fx_email_(opts) {
  var itemsHtml = (opts.items || []).join('');
  var totalRow = opts.totalText === null ? '' :
    '<tr style="margin:0">' +
      '<td align="left" width="100%"><div><p>지급 총액:</p></div></td>' +
      '<td align="right"><div><p><span style="white-space:nowrap">' + opts.totalText + '</span></p></div></td>' +
    '</tr>';
  return '' +
    '<div><p>' + (opts.headline || '₩68,873 KRW의 금액이 오늘 지급되었습니다') + '</p></div>' +
    '<div><p>대금이 ' + (opts.paidText || '7월 2일') + '에 지급되었으며, ' + (opts.year || '2026') + '년 7월 9일까지 입금될 예정입니다.</p></div>' +
    (opts.noDetail ? '' : '<div><p>세부 정보</p></div>') +
    itemsHtml + totalRow;
}

/* ── 테스트 유틸 ─────────────────────────────────────────────── */

var _T = { pass: 0, fail: 0, log: [] };

function t_(name, cond, extra) {
  if (cond) {
    _T.pass++;
    _T.log.push('  PASS  ' + name);
  } else {
    _T.fail++;
    _T.log.push('  FAIL  ' + name + (extra ? ' — ' + extra : ''));
  }
}

function eq_(name, actual, expected) {
  t_(name, actual === expected, '기대=' + JSON.stringify(expected) + ' 실제=' + JSON.stringify(actual));
}

/* ── 1. 이름 회귀 테스트 (allowlist 금지 확인) ──────────────── */

function test_guestNames() {
  // 과거 4차례 장애를 일으킨 이름 + allowlist 였다면 깨졌을 이름들
  var names = [
    'Suah Kim,',        // 2026-07-19 쉼표
    'Ayuner 彭',        // 2026-07-19 한자
    'Tzu-Hao Yeh',      // 2026-08-08 하이픈
    "O'Brien Kim",      // 아포스트로피
    'José Álvarez',     // 악센트 라틴
    '山田 太郎',         // 일본어 한자
    'さくら 田中',       // 히라가나
    'Владимир Петров',  // 키릴
    'Δημήτριος Παπάς',  // 그리스
    'สมชาย ใจดี',       // 태국어
    '김 정휘',           // 한글
    'Anne-Marie Dupré'  // 하이픈+악센트
  ];

  for (var i = 0; i < names.length; i++) {
    var html = fx_email_({
      items: [fx_item_(names[i], '₩100,000 KRW', '숙소', '2026. 7. 1.', '2026. 7. 2.', '1700811717804874362', 'HM2ANY8Y2X')],
      totalText: '₩100,000 KRW'
    });
    var p = parsePayoutEmail(html);
    var v = validateParsed(p);
    var expectName = names[i].replace(/[,\s]+$/, '');
    t_('이름 파싱: ' + names[i],
       p.items.length === 1 && p.items[0].guestName === expectName && v.status === STATUS.SUCCESS,
       '실제=' + JSON.stringify(p.items.map(function (x) { return x.guestName; })) + ' 상태=' + v.status);
  }

  // 소스에 이름 문자 allowlist 가 없어야 한다 (원칙 2)
  t_('파서에 이름 문자 allowlist 없음', typeof AMOUNT_RE_ !== 'undefined' && !/가-힣[^\]]*a-zA-Z/.test(String(parsePayoutEmail)));
}

/* ── 2. Silent failure 테스트 ───────────────────────────────── */

function test_silentFailure() {
  // 총액·날짜는 있는데 항목이 0건 → 반드시 PARSE_ERROR
  var html = fx_email_({ items: [], totalText: '₩68,873 KRW' });
  var p = parsePayoutEmail(html);
  var v = validateParsed(p);
  eq_('items=0 이면 PARSE_ERROR', v.status, STATUS.PARSE_ERROR);
  t_('items=0 은 총액이 파싱돼도 성공이 아님', p.total === 68873 && v.status !== STATUS.SUCCESS);

  // 구조가 깨진 경우(금액 셀 없음)도 조용히 성공하지 않아야 한다
  var broken = '<div><p>세부 정보</p></div>' +
    '<tr><td align="left">이름만 있음</td><td align="right">금액아님</td></tr>' +
    '<tr><td align="left">지급 총액:</td><td align="right">₩50,000 KRW</td></tr>';
  var p2 = parsePayoutEmail(broken);
  var v2 = validateParsed(p2);
  t_('금액 셀이 깨지면 PARSE_ERROR', v2.status === STATUS.PARSE_ERROR, '상태=' + v2.status);
}

/* ── 3. 전 항목 음수 → MANUAL_REVIEW ────────────────────────── */

function test_negativeOnly() {
  var html = fx_email_({
    items: [fx_item_('미영 황', '-₩14,914 KRW', '공동 호스트 수입 분배', '2026. 8. 13.', '2026. 8. 15.', '1700811717804874362', 'HMYFK83ADT')],
    totalText: '₩283,374 KRW'
  });
  var v = validateParsed(parsePayoutEmail(html));
  eq_('전 항목 음수는 MANUAL_REVIEW', v.status, STATUS.MANUAL_REVIEW);
  t_('전 항목 음수는 PARSE_ERROR 가 아님', v.status !== STATUS.PARSE_ERROR);
  t_('전 항목 음수는 SUCCESS 가 아님', v.status !== STATUS.SUCCESS);
}

/* ── 4. 장부 대상이 아닌 메일 → SKIPPED_EXPECTED ────────────── */

function test_skippedExpected() {
  // 호스트가 게스트에게 지급 / 초안 알림 — '세부 정보'와 총액이 없다
  var html = '<div><p>세미님에게 금액을 지급하셨습니다.</p></div><div><p>도움말 센터</p></div>';
  var v = validateParsed(parsePayoutEmail(html));
  eq_('세부정보 없는 메일은 SKIPPED_EXPECTED', v.status, STATUS.SKIPPED_EXPECTED);

  var draft = '<div><p>초안 저장 완료: 민서 님에게 보내는 보상금 지급 요청</p></div>';
  eq_('초안 알림은 SKIPPED_EXPECTED', validateParsed(parsePayoutEmail(draft)).status, STATUS.SKIPPED_EXPECTED);
}

/* ── 5. '지급 총액' 행이 게스트로 오인되지 않는지 ───────────── */

function test_totalRowNotGuest() {
  var html = fx_email_({
    items: [fx_item_('윤주 김', '₩72,498 KRW', '숙소', '2026. 7. 1.', '2026. 7. 2.', '1700811717804874362', 'HM2ANY8Y2X')],
    totalText: '₩72,498 KRW'
  });
  var p = parsePayoutEmail(html);
  eq_('항목은 1건만 (총액 행 제외)', p.items.length, 1);
  t_('총액 행이 게스트로 들어가지 않음',
     p.items[0].guestName === '윤주 김',
     JSON.stringify(p.items.map(function (x) { return x.guestName; })));
  eq_('총액 인식', p.total, 72498);
}

/* ── 6. 금액 정규화 / 음수 유지 ─────────────────────────────── */

function test_amountNormalization() {
  eq_('₩123,456 KRW → 123456', parseAmount_('₩123,456 KRW'), 123456);
  eq_('-₩3,625 KRW → -3625', parseAmount_('-₩3,625 KRW'), -3625);
  eq_('공백 포함 처리', parseAmount_('  ₩ 68,873  KRW '), 68873);
  eq_('금액 아닌 값은 null', parseAmount_('지급 총액:'), null);
  eq_('USD 는 인식하지 않음', parseAmount_('$55.00 USD'), null);

  var html = fx_email_({
    items: [
      fx_item_('정필 서', '₩64,617 KRW', '숙소', '2026. 6. 24.', '2026. 6. 25.', '1700811717804874362', 'HMRFCW98XE'),
      fx_item_('정수 김', '-₩3,400 KRW', '공동 호스트 수입 분배', '2026. 6. 25.', '2026. 6. 26.', '1700811717804874362', 'HMZZS39CRF')
    ],
    totalText: '₩61,217 KRW'
  });
  var p = parsePayoutEmail(html);
  eq_('음수 항목 부호 유지', p.items[1].amount, -3400);
  eq_('항목 합계 계산', p.itemsSum, 61217);
  t_('합계=총액이면 totalMatches', p.totalMatches === true);
}

/* ── 7. 항목합 ≠ 총액 → MANUAL_REVIEW (외화 섞임 등) ────────── */

function test_totalMismatch() {
  var html = fx_email_({
    items: [fx_item_('Amy Min', '₩179,782 KRW', '숙소', '2026. 6. 27.', '2026. 6. 28.', '1700811717804874362', 'HM2PJBP582')],
    totalText: '₩255,287 KRW'
  });
  var v = validateParsed(parsePayoutEmail(html));
  eq_('항목합≠총액은 MANUAL_REVIEW', v.status, STATUS.MANUAL_REVIEW);
  t_('사유에 숫자가 포함됨', v.reason.indexOf('255287') >= 0);
}

/* ── 7-2. 다건 메일 (입금액=총액 정책에서 합계 왜곡 방지) ──── */

function test_multiGuestEmail() {
  // 실제 2026-06-26 건과 같은 구조: 한 메일에 정산 대상 게스트가 2명
  var html = fx_email_({
    items: [
      fx_item_('정필 서', '₩64,617 KRW', '숙소', '2026. 6. 24.', '2026. 6. 25.', '1700811717804874362', 'HMRFCW98XE'),
      fx_item_('정수 김', '₩68,019 KRW', '숙소', '2026. 6. 25.', '2026. 6. 26.', '1700811717804874362', 'HMZZS39CRF'),
      fx_item_('정수 김', '-₩3,400 KRW', '공동 호스트 수입 분배', '2026. 6. 25.', '2026. 6. 26.', '1700811717804874362', 'HMZZS39CRF'),
      fx_item_('Minhyuk Kwon', '-₩64,618 KRW', '수령 대금 조정', '2026. 6. 22.', '2026. 6. 24.', '1700811717804874362', 'HMZB3WFF59')
    ],
    totalText: '₩64,618 KRW'
  });
  var p = parsePayoutEmail(html);
  eq_('항목 4건 파싱', p.items.length, 4);

  var v = validateParsed(p);
  // 기본 정책(입금액=총액)에서는 행마다 총액이 중복되므로 사람이 확인해야 한다.
  eq_('다건 메일은 MANUAL_REVIEW', v.status, STATUS.MANUAL_REVIEW);
  t_('사유에 게스트 수 표시', v.reason.indexOf('2명') >= 0, v.reason);
  t_('PARSE_ERROR 는 아님', v.status !== STATUS.PARSE_ERROR);

  // 게스트가 1명이면 총액이 곧 실입금이므로 정상 처리된다.
  var single = fx_email_({
    items: [
      fx_item_('서연 박', '₩167,559 KRW', '숙소', '2026. 9. 5.', '2026. 9. 6.', '1700811717804874362', 'HMRYPEWYKM'),
      fx_item_('서연 박', '-₩8,377 KRW', '공동 호스트 수입 분배', '2026. 9. 5.', '2026. 9. 6.', '1700811717804874362', 'HMRYPEWYKM')
    ],
    totalText: '₩159,182 KRW'
  });
  eq_('단일 게스트는 SUCCESS', validateParsed(parsePayoutEmail(single)).status, STATUS.SUCCESS);
}

/* ── 8. 날짜/예약ID 추출 ────────────────────────────────────── */

function test_dateAndIds() {
  var html = fx_email_({
    items: [fx_item_('서연 박', '₩167,559 KRW', '숙소', '2026. 9. 5.', '2026. 9. 6.', '1700811717804874362', 'HMRYPEWYKM')],
    totalText: '₩167,559 KRW',
    paidText: '9월 6일',
    year: '2026'
  });
  var p = parsePayoutEmail(html);
  eq_('지급일', p.payoutDate, '2026-09-06');
  eq_('체크인', p.items[0].checkin, '2026-09-05');
  eq_('체크아웃', p.items[0].checkout, '2026-09-06');
  eq_('예약ID', p.items[0].reservationId, '1700811717804874362');
  eq_('게스트코드', p.items[0].guestCode, 'HMRYPEWYKM');
  eq_('카테고리', p.items[0].category, '숙소');
}

/* ── 9. 항목 고유키 (idempotency / partial failure) ─────────── */

function test_itemKeys() {
  var items = [
    { reservationId: 'R1', guestCode: 'C1', checkin: '2026-07-01', amount: 100 },
    { reservationId: 'R1', guestCode: 'C1', checkin: '2026-07-01', amount: -20 },
    { reservationId: 'R1', guestCode: 'C1', checkin: '2026-07-01', amount: 100 } // 완전 동일 항목
  ];
  var keys = buildItemKeys('MSG1', items);
  eq_('키 개수', keys.length, 3);
  t_('양수/음수 키가 다름', keys[0] !== keys[1]);
  t_('동일 항목도 서로 다른 키', keys[0] !== keys[2], keys[0] + ' vs ' + keys[2]);
  t_('키에 메일ID 포함', keys[0].indexOf('MSG1') === 0);

  var again = buildItemKeys('MSG1', items);
  t_('같은 입력 → 같은 키(결정적)', keys.join() === again.join());

  var other = buildItemKeys('MSG2', items);
  t_('메일이 다르면 키도 다름', keys[0] !== other[0]);
}

/* ── 10. SMS 파싱 / 검증 ────────────────────────────────────── */

function test_sms() {
  // SmsWebhook.gs 를 넣지 않은 설치(입금 문자 미사용)에서는 이 묶음을 건너뛴다.
  if (typeof parseSms !== 'function') {
    _T.log.push('  SKIP  SmsWebhook.gs 미설치 — SMS 테스트 건너뜀');
    return;
  }

  var a = parseSms('68,873원 입금 토스뱅크 26/7/2');
  t_('SMS 금액', a && a.amount === 68873, JSON.stringify(a));
  t_('SMS 날짜', a && a.date === '2026-07-02', JSON.stringify(a));
  t_('SMS 입금 여부', a && a.isDeposit === true);

  var b = parseSms('출금 5,000원 스타벅스');
  t_('출금 문자는 isDeposit=false', b && b.isDeposit === false);

  eq_('금액 없는 문자는 null', parseSms('광고입니다'), null);
  eq_('빈 문자는 null', parseSms(''), null);

  var c = parseSms('입금 1,234,567원 2026-08-15');
  t_('ISO 날짜 형식 인식', c && c.date === '2026-08-15' && c.amount === 1234567, JSON.stringify(c));
}

/* ── 11. HTML 유틸 ──────────────────────────────────────────── */

function test_htmlUtils() {
  eq_('엔티티 해제', unescapeHtml_('A&amp;B&nbsp;C'), 'A&B C');
  eq_('블록 경계 개행', normWs_(stripTags_('<p>가</p><p>나</p>')), '가 나');
  t_('script 제거', stripTags_('<script>bad()</script>안전').indexOf('bad') < 0);
  eq_('공백 정규화', normWs_('  a ​ b  '), 'a b');
}

/* ── 실행 ───────────────────────────────────────────────────── */

function runAllTests() {
  _T = { pass: 0, fail: 0, log: [] };
  var suites = [
    ['게스트 이름 (allowlist 금지)', test_guestNames],
    ['Silent failure 금지', test_silentFailure],
    ['전 항목 음수', test_negativeOnly],
    ['장부 대상 아닌 메일', test_skippedExpected],
    ['총액 행 오인 방지', test_totalRowNotGuest],
    ['금액 정규화', test_amountNormalization],
    ['항목합≠총액', test_totalMismatch],
    ['다건 메일(합계 왜곡 방지)', test_multiGuestEmail],
    ['날짜/예약ID', test_dateAndIds],
    ['항목 고유키', test_itemKeys],
    ['SMS 파싱', test_sms],
    ['HTML 유틸', test_htmlUtils]
  ];
  for (var i = 0; i < suites.length; i++) {
    _T.log.push('[' + suites[i][0] + ']');
    try {
      suites[i][1]();
    } catch (e) {
      _T.fail++;
      _T.log.push('  ERROR ' + e.message);
    }
  }
  var summary = '테스트 결과: ' + _T.pass + ' 통과 / ' + _T.fail + ' 실패';
  var out = _T.log.join('\n') + '\n\n' + summary;
  Logger.log(out);
  return { pass: _T.pass, fail: _T.fail, report: out };
}
