// プレビューのタブが、どのファイルを表示しているかを推定する（vscode に依存しない部分）。
// VS Code の API ではプレビューのタブから表示中のファイルが分からないため、
// タブの題名（「Preview foo.md」「[Preview] foo.md」、日本語版では「プレビュー foo.md」など。末尾がファイル名）で照らし合わせる。

/** タブの情報のうち、判定に使うもの（vscode.Tab と同じ形。テストではただのオブジェクトを渡せる） */
export interface TabLike {
  label: string;
  input: unknown;
}

/** Markdown プレビューのタブか（右クリックやコマンドで開くプレビューと、最初からプレビューで開く形の両方） */
export function isMarkdownPreviewTab(tab: TabLike | undefined): boolean {
  const viewType = (tab?.input as { viewType?: unknown } | undefined)?.viewType;
  return typeof viewType === 'string' && viewType.includes('markdown.preview');
}

/**
 * プレビューのタブが表示しているファイルの URI 文字列。
 * - 最初からプレビューで開く形（カスタムエディタ。viewType は vscode.markdown.preview.editor）：
 *   タブが URI を持っているので、それを使う
 * - コマンドで開くプレビュー（Webview）：URI が分からないので、題名から推定する
 * プレビューのタブでない、または特定できなければ undefined
 */
export function resolvePreviewTab(
  tab: TabLike | undefined,
  candidates: readonly string[],
  preferred: readonly string[] = [],
): string | undefined {
  if (!tab || !isMarkdownPreviewTab(tab)) {
    return undefined;
  }
  const uri = (tab.input as { uri?: unknown }).uri;
  if (uri && typeof uri === 'object') {
    return String(uri);
  }
  return resolvePreviewTarget(tab.label, candidates, preferred);
}

/** URI 文字列やパスの末尾のファイル名（URL エンコードを戻す） */
export function baseName(uriOrPath: string): string {
  const last = uriOrPath.split(/[\\/]/).pop() ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** タブの題名が、このファイルのプレビューのものに見えるか */
export function previewLabelMatches(label: string, uriOrPath: string): boolean {
  const name = baseName(uriOrPath);
  return name !== '' && (label === name || label.endsWith(` ${name}`));
}

/**
 * プレビューのタブの題名から、表示中のファイルを推定する。
 * candidates：追跡しているファイルなど、候補の URI 文字列。
 * preferred：同じファイル名の候補が複数あるときに優先する URI 文字列（最近開いたものから順に）。
 * 特定できなければ undefined
 */
export function resolvePreviewTarget(
  label: string,
  candidates: readonly string[],
  preferred: readonly string[] = [],
): string | undefined {
  const matches = [...new Set(candidates.filter((c) => previewLabelMatches(label, c)))];
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    return preferred.find((p) => matches.includes(p));
  }
  return undefined;
}
