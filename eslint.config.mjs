// オフライン前提を仕組みで守るための ESLint 設定（ノート「オフライン前提の確認方法」1）
import tseslint from 'typescript-eslint';

const OFFLINE = 'この拡張は通信しない方針です。';

// 通信に使える Node のモジュール
const networkModules = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'child_process'];
const restrictedModulePaths = networkModules.flatMap((name) => [
  { name, message: OFFLINE },
  { name: `node:${name}`, message: OFFLINE },
]);

// 通信に使えるブラウザの API（素の識別子と、globalThis.fetch などのプロパティの両方を禁止する）
const networkGlobals = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'];

// 通信やデータの外部送信につながる API
const restrictedMembers = [
  ['sendBeacon', 'navigator.sendBeacon は使わない（通信しない方針）'],
  ['createTelemetryLogger', 'テレメトリは使わない（通信しない方針）'],
  ['openExternal', '外部 URL は開かない（通信しない方針）'],
  ['setKeysForSync', 'Settings Sync に状態を載せない（ローカルだけに保存する方針）'],
  ['createRequire', 'require を作ると通信用のモジュールを読み込めるため使わない（通信しない方針）'],
  // プレビューの中で HTML や URL を入れると、画像などの読み込みで通信できてしまう
  ['innerHTML', 'HTML を文字列で入れない（textContent を使う）'],
  ['outerHTML', 'HTML を文字列で入れない（textContent を使う）'],
  ['insertAdjacentHTML', 'HTML を文字列で入れない（textContent を使う）'],
  ['src', 'URL を読み込む属性は使わない（通信しない方針）'],
  ['srcset', 'URL を読み込む属性は使わない（通信しない方針）'],
  ['href', 'URL を読み込む属性は使わない（通信しない方針）'],
];

// esquery の正規表現には「/」を書けないため \x2F で表す
const URL_PATTERN = '(https?|wss?|ftp):\\x2F\\x2F';

const commonSyntax = [
  ...restrictedMembers.map(([name, message]) => ({
    selector: `MemberExpression[property.name='${name}']`,
    message,
  })),
  { selector: 'ImportExpression', message: '動的な import は使わない（通信用のモジュールを読み込めるため）' },
  { selector: `Literal[value=/${URL_PATTERN}/i]`, message: 'URL を書かない（通信しない方針）' },
  { selector: `TemplateElement[value.raw=/${URL_PATTERN}/i]`, message: 'URL を書かない（通信しない方針）' },
];

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '*.vsix'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'media/**/*.js'],
    rules: {
      'no-restricted-imports': ['error', { paths: restrictedModulePaths }],
      'no-restricted-globals': ['error', ...networkGlobals.map((name) => ({ name, message: OFFLINE }))],
      'no-restricted-properties': ['error', ...networkGlobals.map((property) => ({ property, message: OFFLINE }))],
      'no-restricted-syntax': [
        'error',
        ...commonSyntax,
        {
          selector:
            "CallExpression[callee.name='require'][arguments.0.value=/^(node:)?(http|https|http2|net|tls|dgram|dns|child_process)$/]",
          message: OFFLINE,
        },
        {
          selector: "Literal[value=/^vscode\\.(open|openWith)$/]",
          message: 'vscode.open は外部 URL も開けるため使わない（通信しない方針）',
        },
      ],
    },
  },
  {
    // プレビュー用スクリプトはブラウザ環境で動く。作る要素は、色付けの表示に使うものだけに絞る
    // （img・link・iframe などを作ると、URL の読み込みで通信できてしまう）
    files: ['media/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { document: 'readonly', window: 'readonly' } },
    rules: {
      'no-restricted-syntax': [
        'error',
        ...commonSyntax,
        {
          selector: "CallExpression[callee.property.name=/^createElement(NS)?$/]:not([arguments.0.value=/^(div|tr|td)$/])",
          message: '作る要素は div・tr・td だけにする（通信しない方針）',
        },
      ],
    },
  },
);
