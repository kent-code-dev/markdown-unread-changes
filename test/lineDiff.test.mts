import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines } from '../src/diff/myers.ts';
import { computeLineDiff, summarize } from '../src/diff/lineDiff.ts';
import { normalizeLineForCompare } from '../src/diff/normalize.ts';

/** 編集操作を適用して新しい行を復元できるか（Myers 法の正しさの確認） */
function apply(oldLines: string[], newLines: string[]): string[] {
  const out: string[] = [];
  for (const op of diffLines(oldLines, newLines)) {
    if (op.kind === 'equal') {
      assert.equal(oldLines[op.oldIndex], newLines[op.newIndex]);
      out.push(oldLines[op.oldIndex]);
    } else if (op.kind === 'insert') {
      out.push(newLines[op.newIndex]);
    }
  }
  return out;
}

test('Myers: 編集操作で新しいテキストを復元できる', () => {
  const cases: [string, string][] = [
    ['', ''],
    ['a', ''],
    ['', 'a'],
    ['a b c', 'a b c'],
    ['a b c a b b a', 'c b a b a c'],
    ['x y z', 'a b c'],
    ['a b c d e', 'a c e f'],
  ];
  for (const [o, n] of cases) {
    const oldLines = o ? o.split(' ') : [];
    const newLines = n ? n.split(' ') : [];
    assert.deepEqual(apply(oldLines, newLines), newLines);
  }
});

test('Myers: 最短の編集になっている', () => {
  const ops = diffLines('a b c a b b a'.split(' '), 'c b a b a c'.split(' '));
  assert.equal(ops.filter((o) => o.kind !== 'equal').length, 5);
});

test('変更・追加・削除を判定する', () => {
  const oldText = ['# 見出し', '', '段落1', '', '段落2', '', '段落3'].join('\n');
  const newText = ['# 見出し', '', '段落1を変更', '', '段落3', '', '追加の段落'].join('\n');
  const r = computeLineDiff(oldText, newText);
  assert.equal(r.status[2], 'modified');
  assert.equal(r.oldLines[r.oldIndexOf[2]!], '段落1');
  assert.equal(r.status[6], 'added');
  assert.ok(r.deletions.some((d) => d.oldLines.includes('段落2')));
  // 段落1の変更と、隣の段落2の削除は続いているので 1 件。末尾の追加で計 2 件
  assert.equal(summarize(r).total, 2);
});

test('空行だけを挟んだ連続する変更は 1 件と数える', () => {
  const oldText = ['A', '', 'B', '', 'C', '', 'D', '', 'E'].join('\n');
  const newText = ['A2', '', 'B2', '', 'C2', '', 'D', '', 'E2'].join('\n');
  const r = computeLineDiff(oldText, newText);
  assert.equal(summarize(r).total, 2);
});

test('変更がなければ空', () => {
  const r = computeLineDiff('a\nb', 'a\r\nb');
  assert.equal(r.isEmpty, true);
  assert.equal(r.groups.length, 0);
});

test('表の空白と区切り行の「-」の数だけの変更は無視する', () => {
  const oldText = ['| a | b |', '|---|---|', '| 1 | 2 |'].join('\n');
  const newText = ['| a   | b   |', '|-----|-----|', '|  1  | 2 |'].join('\n');
  assert.equal(computeLineDiff(oldText, newText).isEmpty, true);
});

test('表の配置の変更は区別する', () => {
  assert.notEqual(normalizeLineForCompare('|---|---|'), normalizeLineForCompare('|:---:|---|'));
  assert.equal(normalizeLineForCompare('| --- | --- |'), normalizeLineForCompare('|-|-|'));
});
