/**
 * gas_harness.js — GAS 소스를 Node 에서 그대로 실행하기 위한 최소 런타임.
 *
 * Apps Script 전역(PropertiesService, Logger, Utilities 등)을 흉내 내어
 * gas/*.gs 를 수정 없이 로드한다. 배포 전에 로컬/CI 에서 검증하기 위한 도구다.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GAS_DIR = path.join(__dirname, '..', 'gas');

// 로드 순서: 전역 상수가 먼저 정의되어야 한다.
const LOAD_ORDER = [
  'Config.gs',
  'AirbnbParser.gs',
  'ProcessingState.gs',
  'NotionService.gs',
  'GmailService.gs',
  'Monitoring.gs',
  'Main.gs',
  'SmsWebhook.gs',
  'Tests.gs'
];

function createHarness(options) {
  options = options || {};
  const props = Object.assign({}, options.properties || {});
  const logs = [];
  const sentMail = [];
  const fetchLog = [];

  const ctx = {
    console,
    JSON,
    Math,
    Date,
    String,
    Number,
    Object,
    Array,
    RegExp,
    isNaN,
    parseInt,
    parseFloat,
    Error,

    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: k => { delete props[k]; },
        getProperties: () => Object.assign({}, props)
      })
    },

    Logger: { log: m => logs.push(String(m)) },

    Utilities: {
      sleep: () => {},
      formatDate: (d, tz, fmt) => {
        const p = n => String(n).padStart(2, '0');
        return fmt
          .replace('yyyy', d.getFullYear())
          .replace('MM', p(d.getMonth() + 1))
          .replace('dd', p(d.getDate()));
      }
    },

    Session: {
      getEffectiveUser: () => ({ getEmail: () => options.ownerEmail || 'owner@example.com' }),
      getScriptTimeZone: () => 'Asia/Seoul'
    },

    MailApp: {
      sendEmail: opt => { sentMail.push(opt); }
    },

    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
    },

    ScriptApp: {
      getProjectTriggers: () => options.triggers || [],
      deleteTrigger: () => {},
      newTrigger: () => ({
        timeBased: () => ({
          everyHours: () => ({ create: () => {} }),
          everyDays: () => ({ atHour: () => ({ create: () => {} }) })
        })
      })
    },

    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: t => ({
        _text: t,
        setMimeType() { return this; },
        getContent() { return this._text; }
      })
    },

    UrlFetchApp: {
      fetch: (url, opts) => {
        fetchLog.push({ url, method: (opts && opts.method) || 'get', payload: opts && opts.payload });
        const handler = options.fetchHandler;
        if (!handler) throw new Error('fetchHandler 가 필요합니다: ' + url);
        return handler(url, opts);
      }
    },

    GmailApp: {
      search: (q, start, max) => (options.gmailSearch ? options.gmailSearch(q, start, max) : [])
    }
  };

  vm.createContext(ctx);
  for (const f of LOAD_ORDER) {
    const src = fs.readFileSync(path.join(GAS_DIR, f), 'utf8');
    vm.runInContext(src, ctx, { filename: f });
  }

  return { ctx, props, logs, sentMail, fetchLog };
}

/** Notion API 를 흉내 내는 가짜 서버. 실패 주입으로 재시도/부분실패를 테스트한다. */
function makeFakeNotion(opts) {
  opts = opts || {};
  const pages = [];
  // failCreateAt: n번째 "성공 예정" 생성 요청을 실패시킨다(재시도해도 계속 실패).
  //   → 재시도 로직을 뚫고 실제 partial failure 를 재현하기 위함.
  const state = {
    createCalls: 0,          // 실제 /v1/pages 요청 수(재시도 포함)
    createAttempts: 0,       // 논리적 행 생성 시도 순번(재시도는 같은 번호 유지)
    failCreateAt: opts.failCreateAt || [],
    failQuery: !!opts.failQuery,
    _lastFailedIndex: null
  };

  const schema = opts.schema || {
    '입금액': { type: 'number' }, '이메일ID': { type: 'rich_text' }, '정산일': { type: 'date' },
    '숙소명': { type: 'select' }, '예약ID': { type: 'rich_text' }, '체크인': { type: 'date' },
    '채널': { type: 'select' }, '비고': { type: 'rich_text' }, '체크아웃': { type: 'date' },
    '게스트명': { type: 'title' }
  };

  function resp(code, body) {
    return {
      getResponseCode: () => code,
      getContentText: () => JSON.stringify(body)
    };
  }

  const handler = (url, options) => {
    const method = (options.method || 'get').toLowerCase();

    if (url.indexOf('/v1/databases/') >= 0 && url.indexOf('/query') < 0 && method === 'get') {
      return resp(200, { properties: schema });
    }

    if (url.indexOf('/query') >= 0) {
      if (state.failQuery) return resp(500, { message: 'injected query failure' });
      const payload = JSON.parse(options.payload || '{}');
      let results = pages.slice();
      const f = payload.filter;
      if (f && f.property === '이메일ID' && f.rich_text && f.rich_text.contains) {
        const needle = f.rich_text.contains;
        results = results.filter(p => {
          const rt = (p.properties['이메일ID'] || {}).rich_text || [];
          return rt.map(x => x.plain_text).join('').indexOf(needle) >= 0;
        });
      }
      if (f && f.property === '정산일' && f.date && f.date.on_or_after) {
        const since = f.date.on_or_after;
        results = results.filter(p => {
          const d = (p.properties['정산일'] || {}).date;
          return d && d.start >= since;
        });
      }
      return resp(200, { results, has_more: false, next_cursor: null });
    }

    if (url.indexOf('/v1/pages') >= 0 && method === 'post') {
      state.createCalls++;
      const body0 = JSON.parse(options.payload);
      const key0 = (((body0.properties['비고'] || {}).rich_text || [{}])[0].text || {}).content || '';

      // 이미 실패로 지정된 행이면 재시도해도 계속 실패시킨다(진짜 partial failure 재현).
      if (state.failedKeys && state.failedKeys[key0]) {
        return resp(500, { message: 'injected create failure (persistent)' });
      }
      // 새로운 행이면 논리적 순번을 하나 올리고, 지정된 순번이면 영구 실패로 등록한다.
      state.createAttempts++;
      if (state.failCreateAt.indexOf(state.createAttempts) >= 0) {
        state.failedKeys = state.failedKeys || {};
        state.failedKeys[key0] = true;
        return resp(500, { message: 'injected create failure #' + state.createAttempts });
      }
      const body = body0;
      // rich_text/title 을 plain_text 로 정규화해 조회에서 읽을 수 있게 한다
      const props = {};
      for (const [k, v] of Object.entries(body.properties)) {
        const c = JSON.parse(JSON.stringify(v));
        if (c.rich_text) c.rich_text = c.rich_text.map(x => ({ plain_text: x.text.content }));
        if (c.title) c.title = c.title.map(x => ({ plain_text: x.text.content }));
        props[k] = c;
      }
      const page = { id: 'page_' + (pages.length + 1), properties: props };
      pages.push(page);
      return resp(200, page);
    }

    return resp(404, { message: 'unhandled ' + url });
  };

  return { handler, pages, state };
}

/** GmailApp.search 결과를 흉내 내는 메시지 객체 */
function makeGmailMessages(list) {
  return list.map(m => ({
    getMessages: () => [{
      getId: () => m.id,
      getSubject: () => m.subject || '',
      getDate: () => new Date(m.date || Date.now()),
      getBody: () => m.html || '',
      getPlainBody: () => m.text || ''
    }]
  }));
}

module.exports = { createHarness, makeFakeNotion, makeGmailMessages, GAS_DIR, LOAD_ORDER };
