/**
 * AirbnbParser.gs — 에어비앤비 정산 메일 파싱.
 *
 * 설계 원칙 (기존 파서가 4번 깨진 이유를 제거하기 위함):
 *
 *  1) 게스트 이름에 대한 문자 allowlist를 쓰지 않는다.
 *     이름은 "금액 셀과 짝을 이루는 좌측 셀"이라는 HTML 구조로만 식별한다.
 *     따라서 한글/한자/라틴/가나/키릴/악센트 무엇이 와도 파싱이 깨지지 않는다.
 *
 *  2) 정산 항목인지 여부도 이름이 아니라 구조로 판정한다.
 *     항목 행 뒤에는 반드시 "기간 + 예약ID" 상세 블록이 따라온다.
 *     '지급 총액:' 행에는 그 블록이 없으므로 이름을 볼 필요 없이 자동 배제된다.
 *
 *  3) 안정적인 경계값만 신뢰한다: `₩...KRW` 금액 형식, `(예약ID)` 괄호,
 *     `YYYY. M. D. - YYYY. M. D.` 기간.
 *
 * 실측 근거: 실제 정산 메일 48건(2026-06 ~ 2026-09) 전수 검증에서
 * 정산 메일 46건 모두 항목 추출 성공, 비대상 2건은 구조적으로 분리됨.
 */

var BLOCK_TAGS_RE_ = /<\/?(p|div|tr|td|table|li|ul|ol|h1|h2|h3|h4|h5|h6|section|header|footer|span)\b[^>]*>/gi;
var AMOUNT_RE_ = /^(-?)\s*₩\s*([\d,]+)\s*KRW$/;
var DATE_RANGE_RE_ = /(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.\s*[-–—~]\s*(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\./;
var RES_ID_RE_ = /\((\d{10,})\)/;
var GUEST_CODE_RE_ = /^[A-Z0-9]{8,}$/;

function unescapeHtml_(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&bull;/g, '•')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&amp;/g, '&');
}

/** 태그 제거. 블록 요소 경계는 개행으로 살려 라인 구조를 보존한다. */
function stripTags_(html) {
  var h = String(html || '');
  h = h.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  h = h.replace(/<br\s*\/?>/gi, '\n');
  h = h.replace(BLOCK_TAGS_RE_, '\n');
  h = h.replace(/<[^>]+>/g, ' ');
  return unescapeHtml_(h);
}

/** 공백류(NBSP/제로폭 포함)를 한 칸으로 정규화 */
function normWs_(s) {
  return String(s == null ? '' : s)
    .replace(/[\s ​‌﻿]+/g, ' ')
    .trim();
}

function textLines_(html) {
  var out = [];
  var raw = stripTags_(html).split('\n');
  for (var i = 0; i < raw.length; i++) {
    var l = normWs_(raw[i]);
    if (l) out.push(l);
  }
  return out;
}

/**
 * '-₩64,618 KRW' → -64618. 금액 형식이 아니면 null.
 * 모든 금액은 정수 KRW로 정규화하며 음수 부호를 그대로 유지한다.
 */
function parseAmount_(txt) {
  var t = normWs_(txt).replace(/−/g, '-');
  var m = AMOUNT_RE_.exec(t);
  if (!m) return null;
  var v = parseInt(m[2].replace(/,/g, ''), 10);
  if (isNaN(v)) return null;
  return m[1] === '-' ? -v : v;
}

function pad2_(n) { n = parseInt(n, 10); return (n < 10 ? '0' : '') + n; }
function ymd_(y, m, d) { return y + '-' + pad2_(m) + '-' + pad2_(d); }

/** <tr>에서 [좌측텍스트, 금액] 추출. 금액 셀이 없으면 null. */
function rowPair_(trHtml) {
  var tds = [];
  var re = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi, m;
  while ((m = re.exec(trHtml)) !== null) tds.push([m[1], m[2]]);
  if (tds.length < 2) return null;

  var left = null, right = null;
  for (var i = 0; i < tds.length; i++) {
    var attrs = String(tds[i][0]).toLowerCase();
    var txt = normWs_(stripTags_(tds[i][1]));
    if (attrs.indexOf('align="right"') >= 0 || attrs.indexOf("align='right'") >= 0) {
      right = txt;
    } else if ((attrs.indexOf('align="left"') >= 0 || attrs.indexOf("align='left'") >= 0) && left === null) {
      left = txt;
    }
  }
  if (!left || right === null) return null;
  var amt = parseAmount_(right);
  if (amt === null) return null;
  return { name: left, amount: amt };
}

/** 상세 블록에서 기간/숙소/예약ID/게스트코드 추출 */
function detailFrom_(lines) {
  var d = { checkin: '', checkout: '', propertyName: '', reservationId: '', guestCode: '', category: '' };
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];

    if (!d.checkin) {
      var dm = DATE_RANGE_RE_.exec(l);
      if (dm) {
        d.checkin = ymd_(dm[1], dm[2], dm[3]);
        d.checkout = ymd_(dm[4], dm[5], dm[6]);
        var bullet = l.indexOf('•');
        if (bullet > 0) d.category = normWs_(l.substring(0, bullet));
      }
    }

    if (!d.reservationId) {
      var rm = RES_ID_RE_.exec(l);
      if (rm) {
        d.reservationId = rm[1];
        var head = normWs_(l.substring(0, rm.index));
        var parts = [];
        var raw = head.split('|');
        for (var k = 0; k < raw.length; k++) {
          var p = normWs_(raw[k]);
          if (p) parts.push(p);
        }
        // 제목 형식은 시기에 따라 바뀌므로 여기서 얻은 값은 후보일 뿐이다.
        // 최종 숙소명은 예약ID 매핑(PROPERTY_MAP)이 있으면 그쪽을 우선한다.
        d.propertyName = parts.length > 1 ? parts[1] : (parts.length ? parts[0] : '');
      }
    }

    if (!d.guestCode) {
      var toks = l.split(' ');
      for (var t = 0; t < toks.length; t++) {
        if (GUEST_CODE_RE_.test(toks[t])) { d.guestCode = toks[t]; break; }
      }
    }
  }
  return d;
}

/** 게스트 이름 정리 — 문자를 걸러내지 않고, 양끝 구두점/공백만 다듬는다. */
function cleanGuestName_(name) {
  return normWs_(name).replace(/^[,\s]+/, '').replace(/[,\s]+$/, '');
}

/** 예약ID → 숙소명 고정 매핑 (선택). 메일 제목 변경에 장부가 흔들리지 않게 한다. */
function propertyFor_(reservationId, parsedName) {
  var raw = cfg_(PROP.PROPERTY_MAP, '');
  if (raw) {
    try {
      var map = JSON.parse(raw);
      if (map && map[reservationId]) return String(map[reservationId]);
    } catch (e) { /* 매핑이 깨져 있어도 파싱 자체는 계속한다 */ }
  }
  return parsedName;
}

/**
 * 정산 메일 파싱.
 * @return {{total:(number|null), payoutDate:string, items:Array, isPayoutEmail:boolean,
 *           itemsSum:number, totalMatches:boolean}}
 */
function parsePayoutEmail(html) {
  var lines = textLines_(html);
  var flat = normWs_(lines.join(' '));

  // 총액 — '지급 총액' 라벨을 경계로 잡는다(같은 줄 또는 다음 줄).
  var total = null;
  for (var i = 0; i < lines.length; i++) {
    var m = /^지급\s*총액\s*[:：]?\s*(.*)$/.exec(lines[i]);
    if (m) {
      if (m[1]) total = parseAmount_(m[1]);
      if (total === null) {
        for (var j = i + 1; j < Math.min(i + 3, lines.length); j++) {
          total = parseAmount_(lines[j]);
          if (total !== null) break;
        }
      }
      break;
    }
  }
  if (total === null) {
    var hm = /(-?)\s*₩\s*([\d,]+)\s*KRW의\s*금액/.exec(flat);
    if (hm) {
      var hv = parseInt(hm[2].replace(/,/g, ''), 10);
      total = hm[1] === '-' ? -hv : hv;
    }
  }

  // 지급일 — "대금이 M월 D일에 지급" + 본문 연도
  var payoutDate = '';
  var pm = /대금이\s*(\d{1,2})월\s*(\d{1,2})일에\s*지급/.exec(flat);
  if (pm) {
    var ym = /(\d{4})년/.exec(flat);
    if (ym) payoutDate = ymd_(ym[1], pm[1], pm[2]);
  }

  // 항목 — <tr>(이름+금액) 다음에 오는 상세 블록과 짝지어 확정
  var items = [];
  var parts = String(html || '').split(/(<tr\b[\s\S]*?<\/tr>)/i);
  var pending = null;
  for (var p = 0; p < parts.length; p++) {
    var seg = parts[p];
    if (/^<tr\b/i.test(seg)) {
      pending = rowPair_(seg);
    } else if (pending) {
      var det = detailFrom_(textLines_(seg));
      // 상세 블록(기간+예약ID)이 있어야만 정산 항목으로 인정한다.
      if (det.checkin && det.reservationId) {
        items.push({
          guestName: cleanGuestName_(pending.name),
          amount: pending.amount,
          checkin: det.checkin,
          checkout: det.checkout,
          propertyName: propertyFor_(det.reservationId, det.propertyName),
          reservationId: det.reservationId,
          guestCode: det.guestCode,
          category: det.category
        });
      }
      pending = null;
    }
  }

  var sum = 0;
  for (var s = 0; s < items.length; s++) sum += items[s].amount;

  return {
    total: total,
    payoutDate: payoutDate,
    items: items,
    itemsSum: sum,
    totalMatches: (total !== null && sum === total),
    // 정산 메일인지 판정: '세부 정보' 섹션과 총액이 둘 다 있어야 한다.
    isPayoutEmail: (flat.indexOf('세부 정보') >= 0 && total !== null)
  };
}

/**
 * 파싱 결과 검증. 상태와 사유를 돌려준다.
 * "총액은 찾았는데 항목이 0건"은 절대 성공으로 넘기지 않는다(원칙 1).
 */
function validateParsed(parsed) {
  if (!parsed.isPayoutEmail) {
    return { status: STATUS.SKIPPED_EXPECTED, reason: '정산 장부 대상이 아닌 메일(세부 정보/총액 없음)' };
  }
  if (parsed.total === null) {
    return { status: STATUS.PARSE_ERROR, reason: '지급 총액을 찾지 못했습니다.' };
  }
  if (!parsed.payoutDate) {
    return { status: STATUS.PARSE_ERROR, reason: '지급일을 찾지 못했습니다.' };
  }
  if (!parsed.items.length) {
    // 기존 시스템이 '[OK] 0건 기록 완료'로 조용히 넘기던 바로 그 지점.
    return { status: STATUS.PARSE_ERROR, reason: '총액은 찾았으나 정산 항목이 0건입니다(파서 손상 의심).' };
  }

  for (var i = 0; i < parsed.items.length; i++) {
    var it = parsed.items[i];
    if (!it.guestName) return { status: STATUS.PARSE_ERROR, reason: (i + 1) + '번 항목의 게스트명이 비어 있습니다.' };
    if (typeof it.amount !== 'number' || isNaN(it.amount)) {
      return { status: STATUS.PARSE_ERROR, reason: (i + 1) + '번 항목의 금액이 숫자가 아닙니다.' };
    }
    if (!it.reservationId) return { status: STATUS.PARSE_ERROR, reason: (i + 1) + '번 항목의 예약ID가 없습니다.' };
    if (!it.checkin || !it.checkout) {
      return { status: STATUS.PARSE_ERROR, reason: (i + 1) + '번 항목의 체크인/아웃 날짜가 없습니다.' };
    }
  }

  var positives = 0;
  for (var k = 0; k < parsed.items.length; k++) if (parsed.items[k].amount > 0) positives++;

  if (positives === 0) {
    // 전 항목 음수: 파싱 오류가 아니다. 다만 실입금이 있을 수 있어 사람이 봐야 한다.
    return { status: STATUS.MANUAL_REVIEW, reason: '모든 항목이 음수입니다. 실입금과 장부 대사가 필요할 수 있습니다.' };
  }
  if (!parsed.totalMatches) {
    // 외화(USD) 크레딧 등이 섞이면 발생. 조용히 넘기지 않고 사람이 확인하게 한다.
    return {
      status: STATUS.MANUAL_REVIEW,
      reason: '항목 합계(' + parsed.itemsSum + ')와 지급 총액(' + parsed.total + ')이 다릅니다. ' +
              '외화 항목이 섞였거나 표시되지 않은 항목이 있을 수 있습니다.'
    };
  }

  // '입금액'에 총액을 넣는 정책(기본)에서, 한 메일에 기록 대상 행이 2개 이상이면
  // 같은 총액이 행마다 중복 기록되어 장부 합계가 부풀려진다.
  // 실제로 2026-06-26 건이 이 경우였다(정필 서·정수 김 두 행 모두 64,618).
  // 조용히 넘기지 않고 사람이 배분을 확인하도록 한다.
  if (positives > 1 && cfg_(PROP.AMOUNT_FIELD_MODE, 'total') !== 'item') {
    return {
      status: STATUS.MANUAL_REVIEW,
      reason: '한 메일에 정산 대상 게스트가 ' + positives + '명입니다. ' +
              '입금액 칸에 총액(' + parsed.total + ')을 넣으면 행마다 중복되어 합계가 부풀려집니다. ' +
              '게스트별 배분을 확인해 주세요.'
    };
  }

  return { status: STATUS.SUCCESS, reason: '' };
}
