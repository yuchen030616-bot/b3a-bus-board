'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'dist', 'bus.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'the production page contains its runtime');
const EPOCH = Date.parse('2026-10-20T12:00:00Z');
const flush = () => new Promise(resolve => setImmediate(resolve));

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(callback);
    },
    dispatch(name) {
      for (const callback of listeners.get(name) || []) callback({ type: name });
    },
  };
}

function element() {
  let content = '';
  const item = Object.assign(eventTarget(), {
    dataset: {}, style: {}, children: [], attributes: {},
    classList: { toggle() {} }, textWrites: 0, replacements: 0,
    append(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; this.replacements++; },
    setAttribute(key, value) { this.attributes[key] = value; },
  });
  Object.defineProperty(item, 'textContent', {
    get() { return content; },
    set(value) { content = String(value); item.textWrites++; },
  });
  return item;
}

function harness({ mobile = false, online = true } = {}) {
  let now = EPOCH;
  let timerId = 0;
  const timers = new Map();
  const nodes = new Map();
  const metrics = { normalizations: 0, formatters: 0, maxRequests: 0 };
  const requests = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  const document = Object.assign(eventTarget(), {
    documentElement: {}, visibilityState: 'visible',
    getElementById: node,
    createElement: element,
    querySelectorAll: () => [],
  });
  const media = Object.assign(eventTarget(), { matches: !mobile });
  const window = Object.assign(eventTarget(), { matchMedia: () => media });
  const navigator = { onLine: online };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const schedule = (callback, delay, interval = 0) => {
    const id = ++timerId;
    timers.set(id, { callback, at: now + Number(delay), interval });
    return id;
  };
  const sandbox = {
    document, window, navigator, Date: FakeDate, AbortController,
    localStorage: { getItem: () => null, setItem() {} },
    Intl: {
      DateTimeFormat: function (...args) {
        metrics.formatters++;
        return new Intl.DateTimeFormat(...args);
      },
    },
    setTimeout: (callback, delay) => schedule(callback, delay),
    clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => schedule(callback, delay, delay),
    clearInterval: id => timers.delete(id),
    fetch(url, options) {
      return new Promise((resolve, reject) => {
        const request = { url, started: now, settled: false };
        requests.push(request);
        metrics.maxRequests = Math.max(
          metrics.maxRequests,
          requests.filter(item => !item.settled).length,
        );
        request.resolve = payload => {
          request.settled = true;
          resolve({ ok: true, json: async () => payload });
        };
        request.reject = error => { request.settled = true; reject(error); };
        options.signal.addEventListener('abort', () => {
          request.reject(Object.assign(new Error('Timeout'), { name: 'AbortError' }));
        });
      });
    },
  };
  vm.runInNewContext(script, sandbox, { filename: 'bus.html:runtime' });
  async function advance(ms) {
    const target = now + ms;
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      now = timer.at;
      if (timer.interval) timer.at += timer.interval;
      else timers.delete(id);
      timer.callback();
      await flush();
    }
    now = target;
    await flush();
  }
  function payload({ eta = now + 185000, source = now - 10000 } = {}) {
    const data = [{
      route: 'B3A', stop: '003261', dir: 'O', eta_seq: 1, seq: 14,
      eta: new Date(eta).toISOString(),
      data_timestamp: source === null ? null : new Date(source).toISOString(),
      rmk_tc: '', rmk_en: '',
    }];
    // Count the actual production normalization's filter pass, without
    // replacing any runtime functions or exposing private production state.
    data.filter = function (...args) {
      metrics.normalizations++;
      return Array.prototype.filter.apply(this, args);
    };
    return { data, generated_timestamp: source === null ? null : new Date(source).toISOString() };
  }
  async function resolve(index, value = payload()) {
    requests[index].resolve(value);
    await flush();
  }
  function visibility(visible) {
    document.visibilityState = visible ? 'visible' : 'hidden';
    document.dispatch('visibilitychange');
  }
  function connection(online) {
    navigator.onLine = online;
    window.dispatch(online ? 'online' : 'offline');
  }
  return {
    node, metrics, requests, advance, payload, resolve, visibility, connection,
    media, now: () => now,
  };
}

test('polls every 30 seconds from request start and never overlaps requests', async () => {
  const h = harness();
  assert.equal(h.requests.length, 1);
  await h.advance(2000);
  await h.resolve(0);
  await h.advance(27999);
  assert.equal(h.requests.length, 1);
  await h.advance(1);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].started - h.requests[0].started, 30000);
  h.node('refresh-button').dispatch('click');
  assert.equal(h.requests.length, 2);
  assert.equal(h.metrics.maxRequests, 1);
  await h.resolve(1);
});

test('hidden tabs pause visual updates and polling; returning refreshes immediately', async () => {
  const h = harness();
  await h.resolve(0);
  const clockBefore = h.node('clock-time').textContent;
  h.visibility(false);
  await h.advance(90000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.node('clock-time').textContent, clockBefore);
  h.visibility(true);
  assert.equal(h.requests.length, 2);
  assert.notEqual(h.node('clock-time').textContent, clockBefore);
  await h.resolve(1);
});

test('a resume during an in-flight request queues one refresh without overlap', async () => {
  const h = harness();
  h.visibility(false);
  await h.advance(1000);
  h.visibility(true);
  assert.equal(h.requests.length, 1);
  await h.resolve(0);
  assert.equal(h.requests.length, 2);
  assert.equal(h.metrics.maxRequests, 1);
  await h.resolve(1);
  assert.equal(h.node('live-text').textContent, '即時預報');
});

test('manual success feedback expires and source age uses the API timestamp', async () => {
  const h = harness();
  await h.resolve(0);
  h.node('refresh-button').dispatch('click');
  assert.equal(h.node('refresh-button').disabled, true);
  await h.resolve(1, h.payload({ source: h.now() - 45000 }));
  assert.equal(h.node('refresh-feedback').textContent, '已更新');
  assert.equal(h.node('refresh-age').textContent, '資料更新於 45 秒前');
  h.node('language-en').dispatch('click');
  assert.equal(h.node('refresh-feedback').textContent, 'Updated');
  assert.equal(h.node('refresh-age').textContent, 'Data updated 45s ago');
  await h.advance(3000);
  assert.equal(h.node('refresh-feedback').textContent, '');
});

test('clock ticks reuse formatters and normalize only at an ETA boundary', async () => {
  const h = harness();
  await h.resolve(0);
  const initialReplacements = h.node('next-number-row').replacements;
  assert.equal(h.metrics.normalizations, 1);
  assert.equal(h.metrics.formatters, 4);
  await h.advance(4000);
  assert.equal(h.metrics.normalizations, 1);
  assert.equal(h.node('next-number-row').replacements, initialReplacements);
  await h.advance(1000);
  assert.equal(h.metrics.normalizations, 2);
  assert.equal(h.node('next-number-row').replacements, initialReplacements + 1);
  assert.equal(h.metrics.formatters, 4);
});

test('announces offline, restored, and stale transitions without per-second chatter', async () => {
  const h = harness();
  await h.resolve(0);
  const announcement = h.node('announcement');
  const writes = announcement.textWrites;
  await h.advance(2000);
  assert.equal(announcement.textWrites, writes);
  h.connection(false);
  assert.match(announcement.textContent, /沒有網絡連線/);
  h.node('language-en').dispatch('click');
  assert.match(announcement.textContent, /You are offline/);
  h.connection(true);
  await h.resolve(1);
  assert.match(announcement.textContent, /restored/);
  h.node('refresh-button').dispatch('click');
  await h.resolve(2, h.payload({ source: h.now() - 119000 }));
  await h.advance(2000);
  assert.equal(h.node('live-text').textContent, 'DELAYED');
  assert.match(announcement.textContent, /over 2 minutes old/);
  const staleWrites = announcement.textWrites;
  await h.advance(2000);
  assert.equal(announcement.textWrites, staleWrites);
});

test('route details follow viewport breakpoints but preserve user toggles within one', async () => {
  const h = harness({ mobile: true });
  const details = h.node('journey-details');
  assert.equal(details.open, false);
  details.open = true;
  await h.resolve(0);
  await h.advance(1000);
  assert.equal(details.open, true);
  h.media.matches = true;
  h.media.dispatch('change');
  assert.equal(details.open, true);
  h.media.matches = false;
  h.media.dispatch('change');
  assert.equal(details.open, false);
});

test('initial offline load replaces skeletons and starts fetching after reconnection', async () => {
  const h = harness({ online: false });
  assert.equal(h.requests.length, 0);
  assert.equal(h.node('live-text').textContent, '已離線');
  assert.equal(h.node('next-number-row').children[0].children[0].textContent, '暫無預報');
  h.connection(true);
  assert.equal(h.requests.length, 1);
  await h.resolve(0);
  assert.equal(h.node('live-text').textContent, '即時預報');
});

test('cached arrivals cross minute, due, and expiry boundaries while later fetches time out', async () => {
  const h = harness();
  const number = () => h.node('next-number-row').children[0].children[0].textContent;
  await h.resolve(0, h.payload({ eta: h.now() + 65000 }));
  assert.equal(number(), '2');
  await h.advance(5000);
  assert.equal(number(), '1');
  await h.advance(30000);
  assert.equal(number(), '即將到站');
  await h.advance(60000);
  assert.equal(number(), '即將到站', 'exact grace boundary is still present');
  await h.advance(1000);
  assert.equal(number(), '暫無預報', 'expired predictions are removed without a new response');
  assert.equal(h.metrics.normalizations, 4);
});
