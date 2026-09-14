/**
 * ProcessingState.gs — 처리 상태 저장.
 *
 * 중요: Script Properties 는 "성능용 캐시"일 뿐 진실의 원천이 아니다.
 * 영구적인 중복 방지는 Notion 에 저장된 Message ID / 항목 고유키로 한다.
 * (Script Properties 가 초기화되어도 Notion 쪽 검사로 중복 생성이 막힌다.)
 */

/** 캐시에 유지할 최대 Message ID 개수 (Script Property 값 크게 유지하지 않기 위함) */
var PROCESSED_CACHE_LIMIT = 400;

function readProcessedIds_() {
  var raw = cfg_(PROP.PROCESSED_IDS, '');
  if (!raw) return [];
  try {
    var a = JSON.parse(raw);
    return Array.isArray(a) ? a : [];
  } catch (e) {
    return [];
  }
}

function writeProcessedIds_(ids) {
  if (ids.length > PROCESSED_CACHE_LIMIT) {
    ids = ids.slice(ids.length - PROCESSED_CACHE_LIMIT);
  }
  PropertiesService.getScriptProperties().setProperty(PROP.PROCESSED_IDS, JSON.stringify(ids));
}

function isProcessedCached(messageId) {
  return readProcessedIds_().indexOf(messageId) >= 0;
}

/**
 * 처리 완료 표시.
 * 반드시 Notion 기록까지 모두 성공한 뒤에만 호출한다(원칙 4).
 */
function markProcessed(messageId) {
  var ids = readProcessedIds_();
  if (ids.indexOf(messageId) < 0) {
    ids.push(messageId);
    writeProcessedIds_(ids);
  }
}

function clearProcessedCache() {
  PropertiesService.getScriptProperties().deleteProperty(PROP.PROCESSED_IDS);
}

function setLastSuccessRun_(iso) {
  PropertiesService.getScriptProperties().setProperty(PROP.LAST_SUCCESS_RUN, iso || new Date().toISOString());
}

function setLastReconcile_(iso) {
  PropertiesService.getScriptProperties().setProperty(PROP.LAST_RECONCILE, iso || new Date().toISOString());
}

function setLastError_(text) {
  PropertiesService.getScriptProperties().setProperty(
    PROP.LAST_ERROR,
    JSON.stringify({ at: new Date().toISOString(), message: String(text).slice(0, 500) })
  );
}

function getLastError_() {
  var raw = cfg_(PROP.LAST_ERROR, '');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/**
 * 항목 단위 고유키 — partial failure 재시도 시 중복 생성을 막는 열쇠(원칙 5).
 * 예약ID/게스트코드/기간/부호가 모두 같은 항목은 같은 키를 갖는다.
 * 같은 메일 안에 완전히 동일한 항목이 두 번 나오면 index 로 구분한다.
 */
function itemKey(messageId, item, indexWithinDuplicates) {
  var sign = item.amount < 0 ? 'M' : 'P';
  var parts = [
    messageId,
    item.reservationId || 'NORES',
    item.guestCode || 'NOCODE',
    item.checkin || 'NOIN',
    sign + Math.abs(item.amount)
  ];
  if (indexWithinDuplicates) parts.push('#' + indexWithinDuplicates);
  return parts.join('|');
}

/** 한 메일 안에서 동일 키가 겹치지 않도록 항목별 키를 계산한다. */
function buildItemKeys(messageId, items) {
  var seen = {}, keys = [];
  for (var i = 0; i < items.length; i++) {
    var base = itemKey(messageId, items[i], 0);
    if (seen[base] === undefined) {
      seen[base] = 0;
      keys.push(base);
    } else {
      seen[base] += 1;
      keys.push(itemKey(messageId, items[i], seen[base]));
    }
  }
  return keys;
}
