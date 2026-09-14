/**
 * SmsWebhook.gs — MacroDroid 입금 문자 수신 (Web App).
 *
 * 기존 FastAPI /webhook/sms 의 역할:
 *   1) x-secret 헤더로 인증
 *   2) 문자에서 입금액/날짜 파싱
 *   3) 정산 메일 처리를 함께 트리거
 *
 * Apps Script Web App 은 임의 헤더를 읽을 수 없으므로 인증은 본문(JSON)에 담는다.
 * 잘못된 문자가 장부를 오염시키지 않도록 검증을 기존보다 강화했다.
 */

/** 입금 문자 파싱 — 금액과 날짜. 예: '68,873원 입금 토스뱅크 26/7/2' */
function parseSms(text) {
  var t = normWs_(text);
  if (!t) return null;

  var am = /([\d][\d,]*)\s*원/.exec(t);
  if (!am) return null;
  var amount = parseInt(am[1].replace(/,/g, ''), 10);
  if (isNaN(amount) || amount <= 0) return null;

  var date = '';
  var dm = /(\d{2})\/(\d{1,2})\/(\d{1,2})/.exec(t);          // 26/7/2
  if (dm) {
    date = ymd_(String(2000 + parseInt(dm[1], 10)), dm[2], dm[3]);
  } else {
    var dm2 = /(\d{4})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/.exec(t);  // 2026-07-02
    if (dm2) date = ymd_(dm2[1], dm2[2], dm2[3]);
  }
  if (!date) date = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');

  var isDeposit = t.indexOf('입금') >= 0;
  return { amount: amount, date: date, isDeposit: isDeposit, raw: t.slice(0, 300) };
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * MacroDroid → POST.
 * 본문 예: {"secret":"...","text":"68,873원 입금 토스뱅크 26/7/2"}
 *
 * 응답은 항상 JSON. 인증 실패 시 처리 자체를 하지 않는다.
 * secret 값은 어떤 경로로도 로그에 남기지 않는다.
 */
function doPost(e) {
  var body = {};
  try {
    var raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '';
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch (parseErr) {
        // JSON 이 아니면 폼 파라미터로 시도
        body = (e && e.parameter) ? e.parameter : {};
        if (!body.text && raw) body.text = raw;
      }
    } else if (e && e.parameter) {
      body = e.parameter;
    }
  } catch (err) {
    return jsonOut_({ status: 'error', message: '요청 본문을 읽을 수 없습니다.' });
  }

  var expected = cfg_(PROP.SMS_WEBHOOK_SECRET, '');
  var given = body.secret || (e && e.parameter ? e.parameter.secret : '');
  if (!expected) {
    return jsonOut_({ status: 'error', message: '서버에 SMS_WEBHOOK_SECRET 이 설정되어 있지 않습니다.' });
  }
  if (!given || String(given) !== String(expected)) {
    Logger.log('SMS webhook 인증 실패 (secret 불일치)');
    return jsonOut_({ status: 'unauthorized' });
  }

  var text = body.text || body.message || '';
  if (!normWs_(text)) {
    return jsonOut_({ status: 'error', message: '문자 내용(text)이 비어 있습니다.' });
  }

  var parsed = parseSms(text);
  if (!parsed) {
    // 금액을 못 읽은 문자는 장부에 아무것도 쓰지 않는다.
    Logger.log('SMS 파싱 실패 — 금액을 찾지 못했습니다. 장부 변경 없음.');
    return jsonOut_({ status: 'ignored', reason: '금액을 인식하지 못했습니다.' });
  }
  if (!parsed.isDeposit) {
    Logger.log('SMS 무시 — 입금 문자가 아닙니다. 장부 변경 없음.');
    return jsonOut_({ status: 'ignored', reason: '입금 문자가 아닙니다.' });
  }

  Logger.log('SMS 입금 인식: ' + parsed.amount + '원 / ' + parsed.date);

  // 입금 문자는 "지금 메일을 확인하라"는 신호로만 쓴다.
  // 문자만으로 장부 행을 만들지 않는다(정산 메일이 유일한 기록 근거).
  var result = null, error = null;
  try {
    result = processNewPayoutEmails();
  } catch (err2) {
    error = err2.message;
    setLastError_('SMS 트리거 처리 실패: ' + err2.message);
  }

  return jsonOut_({
    status: error ? 'partial' : 'ok',
    sms: { amount: parsed.amount, date: parsed.date },
    emails: result ? result.stats : null,
    error: error
  });
}

/** 브라우저로 열었을 때의 응답(상태 확인용). 비밀값은 노출하지 않는다. */
function doGet(e) {
  return jsonOut_({
    status: 'ok',
    service: 'airbnb-payout-automation (Apps Script)',
    lastSuccessfulRun: cfg_(PROP.LAST_SUCCESS_RUN, '(없음)'),
    lastReconcile: cfg_(PROP.LAST_RECONCILE, '(없음)')
  });
}
