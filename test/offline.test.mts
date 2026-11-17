// テストの罠（test/setup/network-trap.mjs）が効いているか。
// 罠が入った状態でほかのテストがすべて通ることが、「テストした範囲では通信しない」ことの確認になる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http, { request as namedHttpRequest } from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';

const TRAPPED = { name: 'NetworkTrapError' };

test('http / https / http2 の接続は例外を投げる', () => {
  assert.throws(() => http.request('http://localhost/'), TRAPPED);
  assert.throws(() => http.get('http://localhost/'), TRAPPED);
  assert.throws(() => namedHttpRequest('http://localhost/'), TRAPPED);
  assert.throws(() => https.request('https://localhost/'), TRAPPED);
  assert.throws(() => https.get('https://localhost/'), TRAPPED);
  assert.throws(() => http2.connect('https://localhost/'), TRAPPED);
});

test('net / tls / dgram / dns は例外を投げる', () => {
  assert.throws(() => net.connect(80, 'localhost'), TRAPPED);
  assert.throws(() => net.createConnection(80, 'localhost'), TRAPPED);
  assert.throws(() => new net.Socket().connect(80, 'localhost'), TRAPPED);
  assert.throws(() => tls.connect(443, 'localhost'), TRAPPED);
  assert.throws(() => dgram.createSocket('udp4'), TRAPPED);
  assert.throws(() => dns.lookup('localhost', () => {}), TRAPPED);
  assert.throws(() => dns.promises.lookup('localhost'), TRAPPED);
});

test('fetch / XMLHttpRequest / WebSocket / EventSource は例外を投げる', () => {
  const g = globalThis as unknown as Record<string, new (...args: unknown[]) => unknown>;
  assert.throws(() => fetch('http://localhost/'), TRAPPED);
  assert.throws(() => new g.XMLHttpRequest(), TRAPPED);
  assert.throws(() => new g.WebSocket('ws://localhost/'), TRAPPED);
  assert.throws(() => new g.EventSource('http://localhost/'), TRAPPED);
});

test('罠は外せない（fetch を元に戻せない）', () => {
  assert.throws(() => {
    (globalThis as { fetch: unknown }).fetch = () => undefined;
  }, TypeError);
});
