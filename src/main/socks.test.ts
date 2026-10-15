import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGreeting, parseRequest, socksReply } from './socks';

test('greeting: needs more bytes, accepts no-auth, rejects others', () => {
  assert.equal(parseGreeting(Buffer.from([5])).state, 'need-more');
  assert.equal(parseGreeting(Buffer.from([5, 2, 0])).state, 'need-more');
  assert.deepEqual(parseGreeting(Buffer.from([5, 2, 2, 0])), { state: 'ok', value: null, consumed: 4 });
  assert.equal(parseGreeting(Buffer.from([5, 1, 2])).state, 'error');
  assert.equal(parseGreeting(Buffer.from([4, 1, 0])).state, 'error');
});

test('request: IPv4, domain and IPv6 targets, and a byte-by-byte arrival', () => {
  const v4 = Buffer.from([5, 1, 0, 1, 10, 0, 0, 7, 0x1f, 0x90]);
  assert.deepEqual(parseRequest(v4), { state: 'ok', value: { host: '10.0.0.7', port: 8080 }, consumed: 10 });
  const dom = Buffer.concat([Buffer.from([5, 1, 0, 3, 11]), Buffer.from('example.com'), Buffer.from([0x01, 0xbb])]);
  assert.deepEqual(parseRequest(dom), { state: 'ok', value: { host: 'example.com', port: 443 }, consumed: dom.length });
  const v6 = Buffer.concat([Buffer.from([5, 1, 0, 4]), Buffer.alloc(15), Buffer.from([1, 0, 80])]);
  const r6 = parseRequest(v6);
  assert.equal(r6.state === 'ok' && r6.value.host, '0:0:0:0:0:0:0:1');
  for (let i = 0; i < dom.length; i++) assert.equal(parseRequest(dom.subarray(0, i)).state, 'need-more');
});

test('request: rejects BIND/UDP and unknown address types with the right reply', () => {
  const bind = parseRequest(Buffer.from([5, 2, 0, 1, 1, 2, 3, 4, 0, 80]));
  assert.equal(bind.state === 'error' && bind.reply, 7);
  const odd = parseRequest(Buffer.from([5, 1, 0, 9, 1, 2, 3, 4, 0, 80]));
  assert.equal(odd.state === 'error' && odd.reply, 8);
  assert.equal(socksReply(5).length, 10);
});
