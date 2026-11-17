import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseName, isMarkdownPreviewTab, previewLabelMatches, resolvePreviewTab, resolvePreviewTarget } from '../src/ui/previewTarget.ts';

const A = 'file:///c%3A/ws/ai/claude-md.md';
const B = 'file:///c%3A/ws/ai/mcp-basics.md';
const B2 = 'file:///c%3A/ws/old/mcp-basics.md';
const JP = 'file:///c%3A/ws/%E3%83%A1%E3%83%A2.md';

test('ファイル名を取り出す（URL エンコードを戻す）', () => {
  assert.equal(baseName(A), 'claude-md.md');
  assert.equal(baseName(JP), 'メモ.md');
});

test('プレビューのタブの題名と照らし合わせる', () => {
  assert.ok(previewLabelMatches('Preview claude-md.md', A));
  assert.ok(previewLabelMatches('[Preview] claude-md.md', A));
  assert.ok(previewLabelMatches('プレビュー メモ.md', JP));
  // ファイル名の一部だけが一致するものは別のファイル
  assert.ok(!previewLabelMatches('Preview my-claude-md.md', A));
});

test('未読一覧からプレビューで開いたファイルを特定する（エディタで一度も表示していなくてよい）', () => {
  assert.equal(resolvePreviewTarget('Preview mcp-basics.md', [A, B]), B);
});

test('同じファイル名が複数あれば、最近開いたものを選ぶ。手がかりがなければ特定しない', () => {
  assert.equal(resolvePreviewTarget('Preview mcp-basics.md', [A, B, B2], [B2, A]), B2);
  assert.equal(resolvePreviewTarget('Preview mcp-basics.md', [A, B, B2], [A]), undefined);
});

test('候補にないファイルのプレビューは特定しない', () => {
  assert.equal(resolvePreviewTarget('Preview other.md', [A, B]), undefined);
});

// ---- タブの種類ごとの判定 ----

/** vscode.Uri の代わり（toString で URI 文字列を返す） */
const uriOf = (s: string) => ({ toString: () => s });

/** 最初からプレビューで開く形（workbench.editorAssociations で *.md をプレビューに関連づけた場合）のタブ */
const customPreviewTab = (uri: string, label: string) => ({
  label,
  input: { uri: uriOf(uri), viewType: 'vscode.markdown.preview.editor' },
});
/** コマンドや右クリックで開くプレビューのタブ */
const webviewPreviewTab = (label: string) => ({
  label,
  input: { viewType: 'mainThreadWebview-markdown.preview' },
});

test('最初からプレビューで開く形のタブは、題名がファイル名だけでもタブの URI で判定する', () => {
  const tab = customPreviewTab(B, 'mcp-basics.md');
  assert.ok(isMarkdownPreviewTab(tab));
  assert.equal(resolvePreviewTab(tab, [A, B]), B);
});

test('最初からプレビューで開く形では、同じファイル名が複数あっても URI で正しく判定する', () => {
  assert.equal(resolvePreviewTab(customPreviewTab(B2, 'mcp-basics.md'), [A, B, B2], [B]), B2);
});

test('コマンドで開くプレビューのタブは、これまでどおり題名から判定する', () => {
  const tab = webviewPreviewTab('Preview mcp-basics.md');
  assert.ok(isMarkdownPreviewTab(tab));
  assert.equal(resolvePreviewTab(tab, [A, B]), B);
});

test('プレビュー以外のタブは対象にしない', () => {
  const textTab = { label: 'mcp-basics.md', input: { uri: uriOf(B) } };
  const otherCustom = { label: 'mcp-basics.md', input: { uri: uriOf(B), viewType: 'vscode.markdown.editor' } };
  assert.ok(!isMarkdownPreviewTab(textTab));
  assert.equal(resolvePreviewTab(textTab, [A, B]), undefined);
  assert.equal(resolvePreviewTab(otherCustom, [A, B]), undefined);
  assert.equal(resolvePreviewTab(undefined, [A, B]), undefined);
});
