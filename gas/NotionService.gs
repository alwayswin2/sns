/**
 * NotionService.gs — Notion API 연동 (UrlFetchApp).
 *
 * 기존 DB 스키마를 그대로 쓴다. 새 속성 추가는 선택 사항이며,
 * 없어도 동작하도록 항목 고유키를 '비고'에 함께 남긴다.
 *
 * 중복 방지 2중 구조:
 *   1) Script Properties 캐시 (빠름, 휘발 가능)
 *   2) Notion 의 이메일ID / 항목 고유키 조회 (느리지만 영구적 — 최종 방어선)
 */

/** 고유키를 비고에 남길 때 쓰는 표식 */
var KEY_TAG = '#k:';

function notionHeaders_() {
  return {
    'Authorization': 'Bearer ' + requireCfg_(PROP.NOTION_TOKEN),
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json'
  };
}

/**
 * Notion API 호출. 429/5xx 는 지수 백오프로 재시도한다.
 * 토큰은 어떤 경우에도 로그/예외 메시지에 담지 않는다.
 */
function notionFetch_(url, method, payload) {
  var lastErr = '';
  for (var attempt = 1; attempt <= NOTION_MAX_ATTEMPTS; attempt++) {
    var opts = {
      method: method,
      headers: notionHeaders_(),
      muteHttpExceptions: true
    };
    if (payload) opts.payload = JSON.stringify(payload);

    var res, code, body;
    try {
      res = UrlFetchApp.fetch(url, opts);
      code = res.getResponseCode();
      body = res.getContentText();
    } catch (e) {
      lastErr = '네트워크 오류: ' + e.message;
      if (attempt < NOTION_MAX_ATTEMPTS) { Utilities.sleep(NOTION_BACKOFF_MS * attempt); continue; }
      throw new Error('Notion 호출 실패(' + NOTION_MAX_ATTEMPTS + '회 시도): ' + lastErr);
    }

    if (code >= 200 && code < 300) {
      return JSON.parse(body);
    }

    // 재시도 가치가 있는 코드만 다시 시도한다.
    if (code === 429 || code === 409 || code >= 500) {
      lastErr = 'HTTP ' + code + ' ' + String(body).slice(0, 200);
      if (attempt < NOTION_MAX_ATTEMPTS) { Utilities.sleep(NOTION_BACKOFF_MS * attempt); continue; }
    } else {
      // 400/401/404 등은 재시도해도 같으므로 즉시 실패
      throw new Error('Notion 오류 HTTP ' + code + ': ' + String(body).slice(0, 300));
    }
  }
  throw new Error('Notion 호출 실패(' + NOTION_MAX_ATTEMPTS + '회 시도): ' + lastErr);
}

function notionDbId_() { return requireCfg_(PROP.NOTION_DATABASE_ID); }

/** DB 에 실제로 존재하는 속성 이름 집합 (스키마 변경 여부에 안전하게 대응) */
var _schemaCache = null;
function notionSchema_() {
  if (_schemaCache) return _schemaCache;
  var db = notionFetch_('https://api.notion.com/v1/databases/' + notionDbId_(), 'get', null);
  _schemaCache = db.properties || {};
  return _schemaCache;
}

function hasProp_(name) {
  var s = notionSchema_();
  return Object.prototype.hasOwnProperty.call(s, name);
}

function queryDb_(filter, pageSize) {
  var payload = { page_size: pageSize || 100 };
  if (filter) payload.filter = filter;
  return notionFetch_('https://api.notion.com/v1/databases/' + notionDbId_() + '/query', 'post', payload);
}

/** 해당 Gmail Message ID 로 기록된 행이 하나라도 있는지 (영구 중복 방지) */
function notionHasEmail(messageId) {
  var r = queryDb_({ property: P.EMAIL_ID, rich_text: { contains: messageId } }, 5);
  return (r.results || []).length > 0;
}

/**
 * 해당 메일로 이미 기록된 항목 고유키 집합.
 * partial failure 후 재실행 시 "이미 들어간 항목"을 건너뛰는 데 쓴다.
 */
function notionExistingKeys(messageId) {
  var keys = {};
  var payload = {
    filter: { property: P.EMAIL_ID, rich_text: { contains: messageId } },
    page_size: 100
  };
  var cursor = null;
  do {
    if (cursor) payload.start_cursor = cursor; else delete payload.start_cursor;
    var r = notionFetch_('https://api.notion.com/v1/databases/' + notionDbId_() + '/query', 'post', payload);
    var rows = r.results || [];
    for (var i = 0; i < rows.length; i++) {
      var k = extractItemKey_(rows[i]);
      if (k) keys[k] = true;
    }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return keys;
}

function plainOf_(prop) {
  if (!prop) return '';
  var arr = prop.rich_text || prop.title || [];
  var s = '';
  for (var i = 0; i < arr.length; i++) s += (arr[i].plain_text || '');
  return s;
}

/** 행에서 항목 고유키 추출 — 전용 속성이 있으면 그쪽, 없으면 비고의 #k: 표식 */
function extractItemKey_(page) {
  var props = page.properties || {};
  if (props['항목키']) {
    var v = plainOf_(props['항목키']);
    if (v) return v;
  }
  var note = plainOf_(props[P.NOTE]);
  var idx = note.indexOf(KEY_TAG);
  if (idx < 0) return '';
  var rest = note.substring(idx + KEY_TAG.length);
  var sp = rest.indexOf(' ');
  return (sp < 0 ? rest : rest.substring(0, sp)).trim();
}

function richText_(s) {
  return { rich_text: [{ text: { content: String(s || '').slice(0, 1900) } }] };
}

/**
 * 정산 행 1건 생성.
 *
 * 금액은 기본적으로 **메일 지급 총액**(= 그 건으로 실제 통장에 들어온 돈)을 넣는다.
 * 칸 이름이 '입금액' 이므로 이 값이 의미에 맞고, 기존 장부와도 일관된다(A안).
 * AMOUNT_FIELD_MODE='item' 으로 바꾸면 게스트별 항목 금액을 넣는다.
 *
 * 주의: 예전 주석에 "기존 시스템이 총액을 넣어 46행 전부 금액이 어긋나 있었다"고
 * 적혀 있었으나 이는 **오진이었고 2026-09-10 에 철회되었다.** 게스트 1명인 건은
 * 총액 = 그 건 입금액이라 정상이다. 실제 문제는 한 메일에 양수 항목이 2개 이상인
 * 경우뿐이며, 그런 메일은 MANUAL_REVIEW 로 걸러 기록하지 않는다.
 */
function createPayoutRow(row) {
  var props = {};
  props[P.GUEST] = { title: [{ text: { content: String(row.guestName || '(이름 없음)').slice(0, 1900) } }] };
  if (row.payoutDate) props[P.PAYOUT_DATE] = { date: { start: row.payoutDate } };
  if (row.checkin) props[P.CHECKIN] = { date: { start: row.checkin } };
  if (row.checkout) props[P.CHECKOUT] = { date: { start: row.checkout } };
  if (row.propertyName) props[P.PROPERTY] = { select: { name: String(row.propertyName).slice(0, 90) } };
  props[P.CHANNEL] = { select: { name: CHANNEL_VALUE } };
  // 기본은 총액(=실제 입금액). AMOUNT_FIELD_MODE='item' 이면 게스트별 항목 금액을 넣는다.
  props[P.AMOUNT] = {
    number: (cfg_(PROP.AMOUNT_FIELD_MODE, 'total') === 'item') ? row.amount : row.payoutTotal
  };
  props[P.RESERVATION] = richText_(row.reservationId);
  props[P.EMAIL_ID] = richText_(row.messageId);

  var note = [];
  if (row.note) note.push(row.note);
  note.push(KEY_TAG + row.itemKey);
  props[P.NOTE] = richText_(note.join(' '));

  // 선택 속성이 DB 에 실제로 있을 때만 채운다(스키마를 강요하지 않는다).
  if (hasProp_('항목키')) props['항목키'] = richText_(row.itemKey);
  if (hasProp_('처리상태')) props['처리상태'] = { select: { name: row.status || STATUS.SUCCESS } };
  if (hasProp_('처리시각')) props['처리시각'] = { date: { start: new Date().toISOString() } };
  if (hasProp_('지급총액')) props['지급총액'] = { number: row.payoutTotal };

  return notionFetch_('https://api.notion.com/v1/pages', 'post', {
    parent: { database_id: notionDbId_() },
    properties: props
  });
}

/** 최근 N일간 Notion 에 기록된 이메일ID 집합 (reconciliation 용) */
function notionEmailIdsSince(isoDate) {
  var ids = {};
  var payload = {
    filter: { property: P.PAYOUT_DATE, date: { on_or_after: isoDate } },
    page_size: 100
  };
  var cursor = null;
  do {
    if (cursor) payload.start_cursor = cursor; else delete payload.start_cursor;
    var r = notionFetch_('https://api.notion.com/v1/databases/' + notionDbId_() + '/query', 'post', payload);
    var rows = r.results || [];
    for (var i = 0; i < rows.length; i++) {
      var eid = plainOf_((rows[i].properties || {})[P.EMAIL_ID]);
      if (eid) ids[eid] = true;
    }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return ids;
}
