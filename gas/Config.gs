/**
 * Config.gs — 설정값과 상태 코드 정의.
 *
 * 비밀값은 코드에 두지 않는다. 전부 Script Properties에서 읽는다.
 * (프로젝트 설정 → 스크립트 속성)
 */

/** Gmail 검색 쿼리 — 기존 시스템과 동일 */
var GMAIL_QUERY = 'from:automated@airbnb.com subject:지급';

/** 한 번 실행에서 볼 최대 스레드 수. 밀려도 창 밖으로 사라지지 않도록 넉넉히 잡는다. */
var MAX_THREADS_PER_RUN = 100;

/** 정기 실행 간격(시간). setupTriggers() 가 이 값을 쓴다. */
var TRIGGER_INTERVAL_HOURS = 4;

/** reconciliation 이 훑는 기간(일) */
var RECONCILE_DAYS = 30;

/** 마지막 성공 실행이 이 시간을 넘으면 dailyHealthCheck 가 경고한다. */
var HEALTH_STALE_HOURS = 26;

/** 같은 내용의 알림을 다시 보내지 않을 시간(분) */
var ALERT_DEDUPE_MINUTES = 360;

/** Notion API 재시도 횟수 / 초기 대기(ms) */
var NOTION_MAX_ATTEMPTS = 4;
var NOTION_BACKOFF_MS = 800;

var NOTION_VERSION = '2022-06-28';

/* ── 처리 상태 코드 ──────────────────────────────────────────────
 * SUCCESS          정상 기록
 * SKIPPED_DUPLICATE 이미 처리된 메일
 * SKIPPED_EXPECTED  장부 대상이 아닌 메일(호스트→게스트 지급, 초안 알림 등)
 * MANUAL_REVIEW    사람 확인 필요(전 항목 음수, 항목합≠총액 등) — 조용히 넘기지 않는다
 * PARSE_ERROR      파싱 실패 / 항목 0건
 * NOTION_ERROR     Notion 기록 실패
 * SYSTEM_ERROR     그 외 예외
 */
var STATUS = {
  SUCCESS: 'SUCCESS',
  SKIPPED_DUPLICATE: 'SKIPPED_DUPLICATE',
  SKIPPED_EXPECTED: 'SKIPPED_EXPECTED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  PARSE_ERROR: 'PARSE_ERROR',
  NOTION_ERROR: 'NOTION_ERROR',
  SYSTEM_ERROR: 'SYSTEM_ERROR'
};

/** 이 상태들만 "성공적으로 끝났다"로 보고 processed 에 넣는다. */
var TERMINAL_OK = [STATUS.SUCCESS, STATUS.SKIPPED_EXPECTED];

/** Notion 속성 이름 — 기존 DB 스키마와 동일하게 유지 */
var P = {
  GUEST: '게스트명',      // title
  PAYOUT_DATE: '정산일',  // date
  CHECKIN: '체크인',      // date
  CHECKOUT: '체크아웃',   // date
  PROPERTY: '숙소명',     // select
  CHANNEL: '채널',        // select
  AMOUNT: '입금액',       // number
  RESERVATION: '예약ID',  // rich_text
  EMAIL_ID: '이메일ID',   // rich_text
  NOTE: '비고'            // rich_text
};

var CHANNEL_VALUE = '에어비앤비';

/** Script Properties 키 */
var PROP = {
  NOTION_TOKEN: 'NOTION_TOKEN',
  NOTION_DATABASE_ID: 'NOTION_DATABASE_ID',
  ALERT_EMAIL: 'ALERT_EMAIL',
  SMS_WEBHOOK_SECRET: 'SMS_WEBHOOK_SECRET',
  PROCESSED_IDS: 'PROCESSED_IDS',
  LAST_SUCCESS_RUN: 'LAST_SUCCESS_RUN',
  LAST_RECONCILE: 'LAST_RECONCILE',
  LAST_ERROR: 'LAST_ERROR',
  ALERT_DEDUPE: 'ALERT_DEDUPE',
  // 선택: 숙소명을 예약ID로 고정 매핑 (JSON). 메일 제목이 바뀌어도 장부가 흔들리지 않는다.
  PROPERTY_MAP: 'PROPERTY_MAP',
  // 선택: 항목합≠총액일 때 기록을 막을지 여부 ('1' 이면 막고 MANUAL_REVIEW)
  STRICT_TOTAL_CHECK: 'STRICT_TOTAL_CHECK',
  // 선택: '입금액' 칸에 무엇을 넣을지
  //   'total' (기본) 메일 지급 총액 = 그 건으로 실제 통장에 들어온 돈.
  //           칸 이름('입금액')과 의미가 맞고 기존 장부 46행과도 일관된다.
  //           단, 한 메일에 양수 항목이 2개 이상이면 행마다 총액이 중복되므로
  //           그런 메일은 MANUAL_REVIEW 로 잡아 사람이 확인하게 한다.
  //   'item'  그 게스트 항목의 금액(공동 호스트 몫 차감 전). 게스트별 매출 분석용.
  AMOUNT_FIELD_MODE: 'AMOUNT_FIELD_MODE'
};

function cfg_(key, fallback) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return (v === null || v === '') ? (fallback === undefined ? '' : fallback) : v;
}

function requireCfg_(key) {
  var v = cfg_(key, '');
  if (!v) {
    throw new Error('Script Property 누락: ' + key + ' — 배포 문서(README_DEPLOY.md)를 확인하세요.');
  }
  return v;
}
