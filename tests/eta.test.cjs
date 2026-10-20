'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the actual production normalization code without the page's DOM/network
// startup. The exported contract is deliberately before its stateful UI code.
const html = fs.readFileSync(path.join(__dirname, '..', 'dist', 'bus.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'bus.html contains its inline script');
const stateBoundary = script.indexOf('    const state =');
assert.ok(stateBoundary > 0, 'the pure export precedes UI state');
const sandbox = { window: {}, localStorage: { getItem: () => null } };
vm.runInNewContext(script.slice(0, stateBoundary) + '\n})();', sandbox, {
  filename: 'bus.html:normalization',
});
const { normalizeETA, POLL_MS, STALE_MS, ARRIVAL_GRACE_MS } = sandbox.window.BusBoard;
const NOW = Date.parse('2026-10-20T12:00:00Z');
const iso = offset => new Date(NOW + offset).toISOString();
const row = overrides => ({
  co: 'CTB', route: 'B3A', dir: 'O', seq: 14, stop: '003261',
  eta_seq: 1, eta: iso(180000), data_timestamp: iso(-15000),
  rmk_tc: '', rmk_en: '', ...overrides,
});
const payload = (data, overrides) => ({
  generated_timestamp: iso(-5000), data, ...overrides,
});
const plain = value => JSON.parse(JSON.stringify(value));

test('selects only outbound B3A buses at stop 003261', () => {
  const result = normalizeETA(payload([
    row({ dir: 'I' }),
    row({ stop: '003260' }),
    row({ route: 'B3' }),
    null,
    row({ eta_seq: 2 }),
  ]), NOW);
  assert.equal(result.arrivals.length, 1);
  assert.equal(result.arrivals[0].order, 2);
  assert.equal(result.arrivals[0].minutes, 3);
});

test('orders by eta_seq, ignores stop seq, deduplicates, and keeps at most three buses', () => {
  const result = normalizeETA(payload([
    row({ eta_seq: 4, seq: 1, eta: iso(240000) }),
    row({ eta_seq: 2, seq: 99, eta: iso(120000) }),
    row({ eta_seq: 1, seq: 14, eta: iso(60000) }),
    row({ eta_seq: 2, seq: 14, eta: iso(150000) }),
    row({ eta_seq: 3, seq: 2, eta: iso(180000) }),
  ]), NOW);
  assert.deepEqual(Array.from(result.arrivals, arrival => arrival.order), [1, 2, 3]);
  assert.deepEqual(Array.from(result.arrivals, arrival => arrival.minutes), [1, 2, 3]);
});

test('rounds future minutes upward and marks only the final 30 seconds as arriving', () => {
  for (const [offset, minutes, due] of [
    [60001, 2, false],
    [60000, 1, false],
    [30001, 1, false],
    [30000, 1, true],
    [1, 1, true],
    [0, 0, true],
  ]) {
    const arrival = normalizeETA(payload([row({ eta: iso(offset) })]), NOW).arrivals[0];
    assert.equal(arrival.minutes, minutes, `minutes at ${offset}ms`);
    assert.equal(arrival.due, due, `due at ${offset}ms`);
  }
});

test('keeps an arrival for the exact grace window and removes it once expired', () => {
  assert.equal(ARRIVAL_GRACE_MS, 30000);
  const result = normalizeETA(payload([
    row({ eta_seq: 1, eta: iso(-30001) }),
    row({ eta_seq: 2, eta: iso(-30000) }),
    row({ eta_seq: 3, eta: iso(60000) }),
  ]), NOW);
  assert.deepEqual(Array.from(result.arrivals, arrival => arrival.order), [2, 3]);
  assert.equal(result.arrivals[0].minutes, 0);
  assert.equal(result.arrivals[0].due, true);
  assert.equal(normalizeETA(payload([row({ eta: iso(-30001) })]), NOW).arrivals.length, 0);
});

test('retains null, empty, and invalid ETA records and their bilingual remarks', () => {
  const result = normalizeETA(payload([
    row({ eta_seq: 1, eta: null, rmk_tc: '  尚未提供  ', rmk_en: '  Not available  ' }),
    row({ eta_seq: 2, eta: '', rmk_tc: null }),
    row({ eta_seq: 3, eta: 'invalid time', rmk_en: 123 }),
  ]), NOW);
  assert.equal(result.arrivals.length, 3);
  assert.equal(result.arrivals.some(arrival => arrival.eta !== null), false);
  for (const arrival of result.arrivals) {
    assert.equal(arrival.eta, null);
    assert.equal(arrival.minutes, null);
    assert.equal(arrival.due, false);
  }
  assert.deepEqual(plain(result.arrivals[0]), {
    order: 1, eta: null, minutes: null, due: false,
    remarkZh: '尚未提供', remarkEn: 'Not available',
  });
  assert.equal(result.arrivals[1].remarkZh, '');
  assert.equal(result.arrivals[2].remarkEn, '');
});

test('uses source timestamps, applies the 120-second stale threshold, and supports fallback', () => {
  assert.equal(POLL_MS, 30000);
  assert.equal(STALE_MS, 120000);
  const boundary = normalizeETA(payload([row({ data_timestamp: iso(-120000) })]), NOW);
  assert.equal(boundary.stale, false);
  const stale = normalizeETA(payload([row({ data_timestamp: iso(-120001) })]), NOW);
  assert.equal(stale.stale, true);
  // The oldest matching record determines freshness, not a newer envelope time.
  const mixed = normalizeETA(payload([
    row({ eta_seq: 1, data_timestamp: iso(-120001) }),
    row({ eta_seq: 2, data_timestamp: iso(-1000) }),
  ]), NOW);
  assert.equal(mixed.sourceTime, NOW - 120001);
  assert.equal(mixed.stale, true);
  const fallback = normalizeETA(payload([row({ data_timestamp: null })]), NOW);
  assert.equal(fallback.sourceTime, NOW - 5000);
  assert.equal(fallback.stale, false);
  const unknown = normalizeETA(payload(
    [row({ data_timestamp: 'bad timestamp' })],
    { generated_timestamp: null },
  ), NOW);
  assert.equal(unknown.sourceTime, null);
  assert.equal(unknown.stale, true);
});

test('accepts an empty data array and rejects malformed API payloads', () => {
  const empty = normalizeETA(payload([]), NOW);
  assert.deepEqual(plain(empty.arrivals), []);
  assert.equal(empty.sourceTime, NOW - 5000);
  for (const invalid of [null, undefined, {}, { data: null }, { data: {} }, { data: 'bad' }]) {
    assert.throws(() => normalizeETA(invalid, NOW), /Invalid Citybus response/);
  }
});
