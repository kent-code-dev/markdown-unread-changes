// オフライン前提を仕組みで守るための ESLint 設定（ノート「オフライン前提の確認方法」1）
import tseslint from 'typescript-eslint';

// 通信に使える Node のモジュール
const networkModules = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'child_process'];
const restrictedModulePaths = networkModules.flatMap((name) => [
  { name, message: 'この拡張は通信しない方針です。' },
  { name: `node:${name}`, message: 'この拡張は通信しない方針です。' },
]);

// 通信やデータの外部送信につながる API
const restrictedMembers = [
  ['sendBeacon', 'navigator.sendBeacon は使わない（通信しない方針）'],
  ['createTelemetryLogger', 'テレメトリは使わない（通信しない方針）'],
  ['openExternal', '外部 URL は開かない（通信しない方針）'],
  ['setKeysForSync', 'Settings Sync に状態を載せない（ローカルだけに保存する方針）'],
];

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '*.vsix'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.js', '**/*.mjs'],
    rules: {
      'no-restricted-imports': ['error', { paths: restrictedModulePaths }],
      'no-restricted-globals': [
        'error',
        ...['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'].map((name) => ({
          name,
          message: 'この拡張は通信しない方針です。',
        })),
      ],
      'no-restricted-syntax': [
        'error',
        ...restrictedMembers.map(([name, message]) => ({
          selector: `MemberExpression[property.name='${name}']`,
          message,
        })),
        {
          selector: "CallExpression[callee.name='require'][arguments.0.value=/^(node:)?(http|https|http2|net|tls|dgram|dns|child_process)$/]",
          message: 'この拡張は通信しない方針です。',
        },
      ],
    },
  },
  {
    // プレビュー用スクリプトはブラウザ環境で動く
    files: ['media/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { document: 'readonly', window: 'readonly' } },
  },
);
