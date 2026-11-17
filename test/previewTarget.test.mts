import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseName, previewLabelMatches, resolvePreviewTarget } from '../src/ui/previewTarget.ts';

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
