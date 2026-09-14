/**
 * GmailService.gs — Gmail 접근.
 *
 * GmailApp 은 이 스크립트를 소유한 계정 권한으로 직접 동작한다.
 * 따라서 OAuth refresh token 을 따로 발급/보관/갱신할 필요가 없다.
 * (기존 시스템의 2026-07-19 장애 원인이 이 토큰 만료였다.)
 */

/**
 * 정산 메일 조회. 개수 상한 대신 "기간"으로 창을 잡아,
 * 오래 밀려도 조회창 밖으로 사라지지 않게 한다.
 * (2026-09-08 장애: 상한 10건에 걸려 밀린 메일 6건이 회수 불가였다.)
 *
 * @param {number=} days 조회 기간(일). 생략하면 전체 기간.
 */
function fetchPayoutMessages(days) {
  var q = GMAIL_QUERY;
  if (days && days > 0) q += ' newer_than:' + Math.ceil(days) + 'd';

  var threads = GmailApp.search(q, 0, MAX_THREADS_PER_RUN);
  var out = [];
  for (var i = 0; i < threads.length; i++) {
    var msgs = threads[i].getMessages();
    for (var j = 0; j < msgs.length; j++) {
      var m = msgs[j];
      out.push({
        id: m.getId(),
        subject: m.getSubject(),
        date: m.getDate(),
        message: m
      });
    }
  }
  // 오래된 것부터 처리하면 중간에 중단돼도 진행 상황이 앞에서부터 쌓인다.
  out.sort(function (a, b) { return a.date - b.date; });
  return out;
}

/** 본문 HTML. HTML 이 비어 있으면 plain text 로 대체한다. */
function getMessageHtml(message) {
  var html = '';
  try { html = message.getBody() || ''; } catch (e) { html = ''; }
  if (normWs_(stripTags_(html))) return html;
  var plain = '';
  try { plain = message.getPlainBody() || ''; } catch (e2) { plain = ''; }
  return plain;
}

function sendAlertEmail_(subject, body) {
  var to = cfg_(PROP.ALERT_EMAIL, '');
  if (!to) {
    // 수신자 설정이 없으면 스크립트 소유자에게 보낸다.
    to = Session.getEffectiveUser().getEmail();
  }
  if (!to) return false;
  MailApp.sendEmail({ to: to, subject: subject, body: body });
  return true;
}
