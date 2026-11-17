// プレビューのタブが、どのファイルを表示しているかを推定する（vscode に依存しない部分）。
// VS Code の API ではプレビューのタブから表示中のファイルが分からないため、
// タブの題名（「Preview foo.md」「[Preview] foo.md」、日本語版では「プレビュー foo.md」など。末尾がファイル名）で照らし合わせる。

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
