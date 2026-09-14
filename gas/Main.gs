/**
 * Main.gs — 진입점과 처리 루프.
 *
 * 처리 순서(원칙 4를 코드 순서로 강제한다):
 *   메일 발견 → 신규 여부 확인 → 파싱 → 검증 → Notion 기록 → 결과 확인 → processed 저장
 * 중간에 실패하면 processed 에 넣지 않는다. 다음 실행에서 다시 시도된다.
 */

/** 정기 트리거가 호출하는 함수. */
function processNewPayoutEmails() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    Logger.log('다른 실행이 진행 중이라 이번 실행은 건너뜁니다.');
    return null;
  }
  try {
    return runProcessing_({ days: 0, allowNotionLookup: true });
  } finally {
    lock.releaseLock();
  }
}

/**
 * 실제 처리 루프.
 * @param {{days:number, allowNotionLookup:boolean, onlyMessageIds:(Object|null)}} opts
 */
function runProcessing_(opts) {
  opts = opts || {};
  var startedAt = new Date();
  var stats = {
    scanned: 0, candidate: 0, duplicate: 0, parsed: 0,
    inserted_rows: 0, manual_review: 0, skipped_expected: 0, errors: 0
  };
  var details = [];

  var messages;
  try {
    messages = fetchPayoutMessages(opts.days);
  } catch (e) {
    setLastError_('Gmail 조회 실패: ' + e.message);
    alertProblem({ status: STATUS.SYSTEM_ERROR, reason: 'Gmail 조회 실패: ' + e.message, retryable: true });
    throw e;
  }

  stats.scanned = messages.length;

  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    var messageId = msg.id;

    if (opts.onlyMessageIds && !opts.onlyMessageIds[messageId]) continue;

    // 1) 신규 여부 — 캐시 우선(빠름), 캐시에 없을 때만 Notion 조회(정확)
    // 대사(reconciliation)로 지목된 메일은 캐시를 건너뛴다.
    // 캐시가 "처리됨"이라고 말하지만 Notion 에는 없는 상태가 바로 복구 대상이기 때문이다.
    if (!opts.ignoreCache && isProcessedCached(messageId)) {
      stats.duplicate++;
      continue;
    }

    stats.candidate++;

    var result = processSingleMessage_(msg, opts.allowNotionLookup !== false);
    details.push(result);

    switch (result.status) {
      case STATUS.SUCCESS:
        stats.parsed++;
        stats.inserted_rows += result.insertedRows;
        markProcessed(messageId);
        break;
      case STATUS.SKIPPED_DUPLICATE:
        stats.duplicate++;
        markProcessed(messageId);
        break;
      case STATUS.SKIPPED_EXPECTED:
        stats.skipped_expected++;
        // 장부 대상이 아님이 구조적으로 확정된 메일이므로 다시 보지 않는다.
        markProcessed(messageId);
        break;
      case STATUS.MANUAL_REVIEW:
        stats.manual_review++;
        stats.inserted_rows += result.insertedRows;
        // 사람이 확인해야 하므로 processed 로 넘기지 않는다.
        alertProblem({
          status: STATUS.MANUAL_REVIEW, reason: result.reason, messageId: messageId,
          subject: msg.subject, total: result.total, itemCount: result.itemCount,
          itemsSum: result.itemsSum, insertedRows: result.insertedRows, retryable: false
        });
        break;
      default:
        stats.errors++;
        // 부분 성공한 행도 실제로 기록됐으므로 집계에 반영한다.
        // (로그의 inserted_rows 는 언제나 "Notion 에 실제로 만들어진 행 수"를 뜻한다.)
        stats.inserted_rows += result.insertedRows;
        setLastError_(result.status + ' ' + messageId + ': ' + result.reason);
        alertProblem({
          status: result.status, reason: result.reason, messageId: messageId,
          subject: msg.subject, total: result.total, itemCount: result.itemCount,
          itemsSum: result.itemsSum, insertedRows: result.insertedRows,
          retryable: (result.status !== STATUS.PARSE_ERROR)
        });
        break;
    }
  }

  // 오류가 하나도 없을 때만 "성공한 실행"으로 기록한다.
  if (stats.errors === 0) setLastSuccessRun_(new Date().toISOString());

  var line = 'scanned=' + stats.scanned +
    ' candidate=' + stats.candidate +
    ' duplicate=' + stats.duplicate +
    ' parsed=' + stats.parsed +
    ' inserted_rows=' + stats.inserted_rows +
    ' manual_review=' + stats.manual_review +
    ' skipped_expected=' + stats.skipped_expected +
    ' errors=' + stats.errors +
    ' elapsed=' + Math.round((Date.now() - startedAt.getTime()) / 1000) + 's';
  Logger.log(line);

  return { stats: stats, details: details, summary: line };
}

/**
 * 메일 1건 처리.
 * Notion 기록이 하나라도 실패하면 그 메일은 성공으로 치지 않는다.
 */
function processSingleMessage_(msg, allowNotionLookup) {
  var messageId = msg.id;
  var base = { messageId: messageId, subject: msg.subject, insertedRows: 0, itemCount: 0, total: null, itemsSum: 0 };

  var parsed, verdict;
  try {
    var html = getMessageHtml(msg.message);
    parsed = parsePayoutEmail(html);
    verdict = validateParsed(parsed);
  } catch (e) {
    base.status = STATUS.SYSTEM_ERROR;
    base.reason = '파싱 중 예외: ' + e.message;
    return base;
  }

  base.total = parsed.total;
  base.itemCount = parsed.items.length;
  base.itemsSum = parsed.itemsSum;

  if (verdict.status === STATUS.SKIPPED_EXPECTED || verdict.status === STATUS.PARSE_ERROR) {
    base.status = verdict.status;
    base.reason = verdict.reason;
    return base;
  }

  // MANUAL_REVIEW 는 "사람이 판단해야 하는 건"이다.
  // 자동으로 행을 만들어 두면 사람이 고치기 전에 잘못된 값이 장부에 남으므로,
  // 기록하지 않고 알림만 보낸다. (기록할지 말지는 사람이 보고 결정한다)
  if (verdict.status === STATUS.MANUAL_REVIEW) {
    base.status = verdict.status;
    base.reason = verdict.reason;
    return base;
  }

  // 기록 대상 항목: 양수만 장부에 넣는다(기존 정책 유지).
  var toWrite = [];
  var keys = buildItemKeys(messageId, parsed.items);
  for (var i = 0; i < parsed.items.length; i++) {
    if (parsed.items[i].amount > 0) toWrite.push({ item: parsed.items[i], key: keys[i] });
  }

  // 영구 중복 방지: 이 메일로 이미 들어간 항목 키를 조회한다.
  var existing = {};
  if (allowNotionLookup) {
    try {
      existing = notionExistingKeys(messageId);
    } catch (e) {
      base.status = STATUS.NOTION_ERROR;
      base.reason = 'Notion 중복 확인 실패: ' + e.message;
      return base;
    }
    // 키 표식이 없던 과거 행과 겹치지 않도록: 키가 하나도 없는데 행이 존재하면 이미 처리된 메일로 본다.
    if (Object.keys(existing).length === 0) {
      try {
        if (notionHasEmail(messageId)) {
          base.status = STATUS.SKIPPED_DUPLICATE;
          base.reason = '이미 Notion 에 기록된 메일입니다(기존 시스템 기록 포함).';
          return base;
        }
      } catch (e2) {
        base.status = STATUS.NOTION_ERROR;
        base.reason = 'Notion 조회 실패: ' + e2.message;
        return base;
      }
    }
  }

  var failed = null;
  for (var w = 0; w < toWrite.length; w++) {
    var it = toWrite[w].item, key = toWrite[w].key;
    if (existing[key]) continue;  // partial failure 재시도 시 중복 생성 방지
    try {
      createPayoutRow({
        messageId: messageId,
        itemKey: key,
        guestName: it.guestName,
        amount: it.amount,
        payoutDate: parsed.payoutDate,
        checkin: it.checkin,
        checkout: it.checkout,
        propertyName: it.propertyName,
        reservationId: it.reservationId,
        payoutTotal: parsed.total,
        status: verdict.status,
        note: it.category ? it.category : ''
      });
      base.insertedRows++;
    } catch (e) {
      failed = e;
      break;  // 남은 항목은 다음 실행에서 이어서 처리된다.
    }
  }

  if (failed) {
    base.status = STATUS.NOTION_ERROR;
    base.reason = 'Notion 기록 실패(' + base.insertedRows + '/' + toWrite.length + '행 기록됨): ' + failed.message;
    return base;
  }

  base.status = verdict.status;   // SUCCESS 또는 MANUAL_REVIEW
  base.reason = verdict.reason;
  return base;
}

/**
 * Gmail ↔ Notion 대사.
 * Gmail 에는 있는데 Notion 에 없는 정산 건을 찾는다.
 *
 * @param {number=} days 확인 기간(기본 RECONCILE_DAYS)
 * @param {boolean=} autoFix 안전하게 복구 가능한 건을 자동 처리할지
 */
function reconcileRecentPayouts(days, autoFix) {
  days = days || RECONCILE_DAYS;
  if (autoFix === undefined) autoFix = true;

  var since = new Date(Date.now() - days * 24 * 36e5);
  var sinceIso = since.toISOString().slice(0, 10);

  var messages = fetchPayoutMessages(days);
  var notionIds = notionEmailIdsSince(sinceIso);

  var missing = [], checked = 0, notPayout = 0;
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    checked++;
    if (notionIds[m.id]) continue;

    // Notion 날짜 필터 밖일 수 있으므로 메일ID 로 한 번 더 확인한다.
    var exists = false;
    try { exists = notionHasEmail(m.id); } catch (e) { exists = false; }
    if (exists) continue;

    var parsed = parsePayoutEmail(getMessageHtml(m.message));
    var verdict = validateParsed(parsed);
    if (verdict.status === STATUS.SKIPPED_EXPECTED) { notPayout++; continue; }

    missing.push(m.id);
  }

  var recovered = 0, needsHuman = [];
  if (autoFix && missing.length) {
    var only = {};
    for (var k = 0; k < missing.length; k++) only[missing[k]] = true;
    // 확신할 수 있는 건만 자동 기록된다. MANUAL_REVIEW/오류는 그대로 알림으로 남는다.
    var res = runProcessing_({ days: days, allowNotionLookup: true, onlyMessageIds: only, ignoreCache: true });
    recovered = res.stats.inserted_rows;
    for (var d = 0; d < res.details.length; d++) {
      if (TERMINAL_OK.indexOf(res.details[d].status) < 0) needsHuman.push(res.details[d].messageId + '(' + res.details[d].status + ')');
    }
  } else {
    needsHuman = missing.slice();
  }

  setLastReconcile_(new Date().toISOString());

  var summary = '대사 완료: 확인 ' + checked + '건, 비대상 ' + notPayout +
    '건, 누락 ' + missing.length + '건, 복구된 행 ' + recovered +
    ', 사람 확인 필요 ' + needsHuman.length + '건';
  Logger.log(summary);

  if (needsHuman.length && shouldSendAlert_('reconcile:' + needsHuman.join(','))) {
    sendAlertEmail_(
      '[정산 자동화] 대사에서 확인이 필요한 건이 있습니다',
      [summary, '', '확인이 필요한 메일:', needsHuman.join('\n'), '',
       '대사 시각: ' + new Date().toISOString(), '— Apps Script 자동 알림'].join('\n')
    );
  }

  return { checked: checked, missing: missing, recovered: recovered, needsHuman: needsHuman, summary: summary };
}

/** 트리거 생성. 같은 함수의 기존 트리거는 지우고 다시 만든다(중복 방지). */
function setupTriggers() {
  var wanted = ['processNewPayoutEmails', 'dailyHealthCheck', 'reconcileNightly'];
  var existing = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < existing.length; i++) {
    if (wanted.indexOf(existing[i].getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(existing[i]);
      removed++;
    }
  }

  ScriptApp.newTrigger('processNewPayoutEmails').timeBased().everyHours(TRIGGER_INTERVAL_HOURS).create();
  ScriptApp.newTrigger('dailyHealthCheck').timeBased().everyDays(1).atHour(9).create();
  ScriptApp.newTrigger('reconcileNightly').timeBased().everyDays(1).atHour(4).create();

  var msg = '트리거 설정 완료 (기존 ' + removed + '개 정리). ' +
    '처리 ' + TRIGGER_INTERVAL_HOURS + '시간마다 / 상태점검 매일 09시 / 대사 매일 04시';
  Logger.log(msg);
  return msg;
}

function reconcileNightly() {
  return reconcileRecentPayouts(RECONCILE_DAYS, true);
}

/** 최초 1회 점검용 — 설정이 제대로 됐는지 확인한다(기록은 하지 않는다). */
function testConnection() {
  var out = { gmail: '', notion: '', properties: {} };
  out.properties = {
    NOTION_TOKEN: cfg_(PROP.NOTION_TOKEN, '') ? '설정됨' : '누락',
    NOTION_DATABASE_ID: cfg_(PROP.NOTION_DATABASE_ID, '') ? '설정됨' : '누락',
    ALERT_EMAIL: cfg_(PROP.ALERT_EMAIL, '') || '(미설정 — 스크립트 소유자에게 발송)',
    SMS_WEBHOOK_SECRET: cfg_(PROP.SMS_WEBHOOK_SECRET, '') ? '설정됨' : '누락(SMS 미사용이면 무방)'
  };
  try {
    var msgs = fetchPayoutMessages(30);
    out.gmail = '정상 — 최근 30일 정산 메일 ' + msgs.length + '건';
  } catch (e) {
    out.gmail = '실패: ' + e.message;
  }
  try {
    var props = notionSchema_();
    out.notion = '정상 — 속성 ' + Object.keys(props).length + '개: ' + Object.keys(props).join(', ');
  } catch (e2) {
    out.notion = '실패: ' + e2.message;
  }
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/**
 * dryRunRecent 의 요약판 — 로그가 잘리지 않도록 한 줄씩 압축해서 보여준다.
 * 도입 전 "PARSE_ERROR 가 있는가"만 빠르게 확인할 때 쓴다.
 */
function dryRunSummary(days) {
  var msgs = fetchPayoutMessages(days || 30);
  var counts = {};
  var lines = [];
  var problems = [];

  for (var i = 0; i < msgs.length; i++) {
    var p = parsePayoutEmail(getMessageHtml(msgs[i].message));
    var v = validateParsed(p);
    counts[v.status] = (counts[v.status] || 0) + 1;

    var pos = 0;
    for (var k = 0; k < p.items.length; k++) if (p.items[k].amount > 0) pos++;

    lines.push(
      (p.payoutDate || '(날짜없음)') + ' ' +
      v.status + ' 총액=' + (p.total === null ? '?' : p.total) +
      ' 항목=' + p.items.length + '(양수' + pos + ')' +
      ' ' + msgs[i].id
    );
    if (v.status !== STATUS.SUCCESS) {
      problems.push('  ' + msgs[i].id + ' [' + v.status + '] ' + v.reason);
    }
  }

  var out = [];
  out.push('=== 최근 ' + (days || 30) + '일 정산 메일 ' + msgs.length + '건 (기록하지 않음) ===');
  out.push('');
  out.push('[상태 요약]');
  for (var s in counts) {
    if (Object.prototype.hasOwnProperty.call(counts, s)) out.push('  ' + s + ': ' + counts[s] + '건');
  }
  out.push('');
  out.push('[PARSE_ERROR] ' + (counts[STATUS.PARSE_ERROR] || 0) + '건' +
           ((counts[STATUS.PARSE_ERROR] || 0) === 0 ? '  → 정상입니다' : '  → 확인이 필요합니다'));
  if (problems.length) {
    out.push('');
    out.push('[SUCCESS 가 아닌 건]');
    out = out.concat(problems);
  }
  out.push('');
  out.push('[메일별 상세]');
  out = out.concat(lines.map(function (l) { return '  ' + l; }));

  var text = out.join('\n');
  Logger.log(text);
  return text;
}

/** 실제 기록 없이 최근 메일을 파싱만 해본다(도입 전 검증용). */
function dryRunRecent(days) {
  var msgs = fetchPayoutMessages(days || 30);
  var rows = [];
  for (var i = 0; i < msgs.length; i++) {
    var p = parsePayoutEmail(getMessageHtml(msgs[i].message));
    var v = validateParsed(p);
    rows.push({
      id: msgs[i].id, subject: msgs[i].subject, status: v.status, reason: v.reason,
      total: p.total, payoutDate: p.payoutDate, items: p.items.length, itemsSum: p.itemsSum,
      guests: p.items.map(function (x) { return x.guestName + ':' + x.amount; }).join(', ')
    });
  }
  Logger.log(JSON.stringify(rows, null, 2));
  return rows;
}
