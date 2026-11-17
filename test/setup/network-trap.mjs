// テストの罠：通信に使う関数を、呼ばれたら例外を投げる関数に差し替える（ノート「オフライン前提の確認方法」4）。
// テストの開始時（register.mjs）に読み込む。テスト中に拡張のコードが通信しようとすると、そのテストが失敗する。
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';

export class NetworkTrapError extends Error {
  constructor(name) {
    super(`通信しようとしました：${name}（この拡張は通信しない方針です）`);
    this.name = 'NetworkTrapError';
  }
}

function trap(name) {
  return function networkTrap() {
    throw new NetworkTrapError(name);
  };
}

/** オブジェクトの関数を罠に差し替える */
function replace(target, label, names) {
  for (const name of names) {
    if (typeof target[name] === 'function') {
      target[name] = trap(`${label}.${name}`);
    }
  }
}

replace(http, 'http', ['request', 'get']);
replace(https, 'https', ['request', 'get']);
replace(http2, 'http2', ['connect']);
replace(net, 'net', ['connect', 'createConnection']);
replace(net.Socket.prototype, 'net.Socket', ['connect']);
replace(tls, 'tls', ['connect']);
replace(dgram, 'dgram', ['createSocket']);
replace(dns, 'dns', ['lookup', 'resolve', 'resolve4', 'resolve6']);
replace(dns.promises, 'dns.promises', ['lookup', 'resolve', 'resolve4', 'resolve6']);
// import { request } from 'node:http' のような名前付きの import にも反映する
syncBuiltinESMExports();

// グローバルの通信 API
for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']) {
  Object.defineProperty(globalThis, name, { value: trap(name), writable: false, configurable: false });
}
