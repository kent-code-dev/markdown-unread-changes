// .vsix に入るファイル（ビルド後の dist/extension.cjs と media/）に、通信につながるものが入っていないか調べる。
// Lint はソースしか見ないため、ビルド結果と CSS もここで確かめる（ノート「オフライン前提の確認方法」3）
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const targets = ['dist/extension.cjs', ...readdirSync('media').map((f) => join('media', f))].filter(
  (f) => statSync(f).isFile() && /\.(c?js|css)$/.test(f),
);

// 見つかったら失敗にするもの
const rules = [
  [/\b(?:https?|wss?|ftp):\/\//i, 'URL'],
  [/\burl\s*\(/i, 'CSS の url()'],
  [/@import\b/i, 'CSS の @import'],
  [/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/, '通信に使う API'],
  [/\brequire\(\s*["'](?:node:)?(?:http|https|http2|net|tls|dgram|dns|child_process)["']\s*\)/, '通信用のモジュール'],
  [/\b(?:openExternal|createTelemetryLogger)\b/, '外部を開く・テレメトリの API'],
];

let failed = false;
for (const file of targets) {
  const text = readFileSync(file, 'utf8');
  for (const [pattern, label] of rules) {
    const m = pattern.exec(text);
    if (m) {
      failed = true;
      const line = text.slice(0, m.index).split('\n').length;
      console.error(`${file}:${line}: ${label}が含まれています（${m[0]}）`);
    }
  }
}

if (failed) {
  console.error('オフラインの確認に失敗しました。');
  process.exit(1);
}
console.log(`オフラインの確認：問題なし（${targets.length} ファイル）`);
