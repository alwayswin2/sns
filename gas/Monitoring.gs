/**
 * Monitoring.gs — 알림, 헬스체크, 상태 조회.
 *
 * 이 시스템의 과거 장애는 대부분 "HTTP 200 을 돌려주면서 아무 일도 안 하는" 형태였고,
 * 5번 중 4번을 사람이 눈으로 발견했다. 그래서 감지 장치를 코드 안에 둔다.
 */

/** 같은 사유의 알림이 짧은 시간에 반복되지 않게 한다. */
function shouldSendAlert_(dedupeKey) {
  if (!dedupeKey) return true;
  var raw = cfg_(PROP.ALERT_DEDUPE, '');
  var map = {};
  if (raw) { try { map = JSON.parse(raw) || {}; } catch (e) { map = {}; } }

  var now = Date.now();
  var windowMs = ALERT_DEDUPE_MINUTES * 60 * 1000;

  // 오래된 항목 정리
  var cleaned = {};
  for (var k in map) {
    if (Object.prototype.hasOwnProperty.call(map, k) && (now - map[k]) < windowMs) cleaned[k] = map[k];
  }
  if (cleaned[dedupeKey]) {
    PropertiesService.getScriptProperties().setProperty(PROP.ALERT_DEDUPE, JSON.stringify(cleaned));
    return false;
  }
  cleaned[dedupeKey] = now;
  PropertiesService.getScriptProperties().setProperty(PROP.ALERT_DEDUPE, JSON.stringify(cleaned));
  return true;
}

/**
 * 문제 알림.
 * 비밀값(토큰/시크릿)은 어떤 경우에도 본문에 넣지 않는다.
 */
function alertProblem(info) {
  var status = info.status || STATUS.SYSTEM_ERROR;
  var dedupeKey = status + ':' + (info.messageId || info.reason || '');
  if (!shouldSendAlert_(dedupeKey)) return false;

  var lines = [
    '에어비앤비 정산 자동화에서 확인이 필요한 상황이 발생했습니다.',
    '',
    '발생 시각   : ' + new Date().toISOString(),
    '상태        : ' + status,
    '사유        : ' + (info.reason || '(없음)')
  ];
  if (info.messageId) lines.push('Gmail 메일ID: ' + info.messageId);
  if (info.subject) lines.push('메일 제목    : ' + info.subject);
  if (info.total !== undefined && info.total !== null) lines.push('지급 총액    : ' + info.total);
  if (info.itemCount !== undefined) lines.push('파싱 항목 수 : ' + info.itemCount);
  if (info.itemsSum !== undefined) lines.push('항목 합계    : ' + info.itemsSum);
  if (info.insertedRows !== undefined) lines.push('기록된 행 수 : ' + info.insertedRows);
  lines.push('재시도 가능  : ' + (info.retryable ? '예 (다음 실행에서 자동으로 다시 시도합니다)' : '아니오 (사람 확인 필요)'));

  if (info.messageId) {
    lines.push('');
    lines.push('메일 열기: https://mail.google.com/mail/u/0/#all/' + info.messageId);
  }
  lines.push('');
  lines.push('— Apps Script 자동 알림');

  sendAlertEmail_('[정산 자동화] ' + status + (info.subject ? ' — ' + info.subject : ''), lines.join('\n'));
  return true;
}

/** 현재 상태 요약. Apps Script 편집기에서 실행하면 로그로 볼 수 있다. */
function getSystemStatus() {
  var lastRun = cfg_(PROP.LAST_SUCCESS_RUN, '');
  var lastRec = cfg_(PROP.LAST_RECONCILE, '');
  var err = getLastError_();
  var triggers = ScriptApp.getProjectTriggers();
  var triggerNames = [];
  for (var i = 0; i < triggers.length; i++) triggerNames.push(triggers[i].getHandlerFunction());

  var status = {
    lastSuccessfulRun: lastRun || '(없음)',
    hoursSinceLastRun: lastRun ? Math.round((Date.now() - new Date(lastRun).getTime()) / 36e5 * 10) / 10 : null,
    lastReconcile: lastRec || '(없음)',
    processedCacheCount: readProcessedIds_().length,
    lastError: err || '(없음)',
    triggers: triggerNames,
    configured: {
      NOTION_TOKEN: !!cfg_(PROP.NOTION_TOKEN, ''),
      NOTION_DATABASE_ID: !!cfg_(PROP.NOTION_DATABASE_ID, ''),
      ALERT_EMAIL: !!cfg_(PROP.ALERT_EMAIL, ''),
      SMS_WEBHOOK_SECRET: !!cfg_(PROP.SMS_WEBHOOK_SECRET, '')
    }
  };
  Logger.log(JSON.stringify(status, null, 2));
  return status;
}

/**
 * 하루 1회 상태 점검.
 *
 * 핵심: "새 메일이 없는 것"과 "자동화가 안 도는 것"을 구분한다.
 * 판단 기준은 메일 유무가 아니라 '마지막 성공 실행 시각'이다.
 */
function dailyHealthCheck() {
  var problems = [];

  var lastRun = cfg_(PROP.LAST_SUCCESS_RUN, '');
  if (!lastRun) {
    problems.push('아직 성공적으로 완료된 실행이 없습니다. 트리거가 설정되었는지 확인하세요.');
  } else {
    var hrs = (Date.now() - new Date(lastRun).getTime()) / 36e5;
    if (hrs > HEALTH_STALE_HOURS) {
      problems.push('마지막 성공 실행이 ' + Math.round(hrs) + '시간 전입니다 (기준 ' + HEALTH_STALE_HOURS + '시간). 자동화가 멈춘 것으로 보입니다.');
    }
  }

  var triggers = ScriptApp.getProjectTriggers();
  var hasMain = false;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'processNewPayoutEmails') hasMain = true;
  }
  if (!hasMain) problems.push('정기 실행 트리거(processNewPayoutEmails)가 없습니다. setupTriggers() 를 실행하세요.');

  var err = getLastError_();
  if (err && (Date.now() - new Date(err.at).getTime()) < 24 * 36e5) {
    problems.push('최근 24시간 내 오류가 있었습니다: ' + err.message);
  }

  // reconciliation 으로 실제 누락 여부까지 확인한다.
  try {
    var rec = reconcileRecentPayouts(RECONCILE_DAYS, false);
    if (rec.missing.length) {
      problems.push('Gmail 에는 있으나 Notion 에 없는 정산 메일 ' + rec.missing.length + '건: ' + rec.missing.join(', '));
    }
  } catch (e) {
    problems.push('대사(reconciliation) 실행 중 오류: ' + e.message);
  }

  if (problems.length) {
    if (shouldSendAlert_('health:' + problems.join('|').slice(0, 120))) {
      sendAlertEmail_(
        '[정산 자동화] 상태 점검에서 문제가 발견되었습니다',
        ['다음 항목을 확인해 주세요.', ''].concat(problems.map(function (p, i) { return (i + 1) + '. ' + p; }))
          .concat(['', '점검 시각: ' + new Date().toISOString(), '— Apps Script 자동 알림']).join('\n')
      );
    }
    Logger.log('헬스체크 문제: ' + problems.join(' / '));
  } else {
    Logger.log('헬스체크 정상 — 마지막 성공 실행 ' + lastRun);
  }
  return problems;
}
