import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines } from '../src/diff/myers.ts';
import { computeLineDiff, pairBySimilarity, similarity, summarize } from '../src/diff/lineDiff.ts';
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

// ---- 行数の違う削除と追加の対応づけ ----

test('類似度：同じ行は 1、まったく違う行は 0 に近い', () => {
  assert.equal(similarity('大阪は曇り', '大阪は曇り'), 1);
  assert.ok(similarity('- 項目2: みかん', '- 項目2: みかんとバナナ') >= 0.5);
  assert.ok(similarity('東京は晴れ', '大阪は雨') < 0.5);
  assert.equal(similarity('', 'abc'), 0);
});

test('削除 2 行・追加 1 行：似ている 2 行目と対応づけ、1 行目は削除（赤）にする', () => {
  const oldText = ['- 項目1: りんご', '- 項目2: みかん'].join('\n');
  const newText = ['- 項目2: みかんとバナナ'].join('\n');
  const r = computeLineDiff(oldText, newText);
  assert.equal(r.status[0], 'modified');
  assert.equal(r.oldLines[r.oldIndexOf[0]!], '- 項目2: みかん');
  assert.equal(r.deletions.length, 1);
  assert.deepEqual(r.deletions[0].oldLines, ['- 項目1: りんご']);
  // 削除された行は、対応づけた行の直前にあった
  assert.equal(r.deletions[0].anchor, 0);
});

test('削除 2 行・追加 1 行：似ている 1 行目と対応づけ、2 行目は後ろに削除として残す', () => {
  const oldText = ['前', '- 項目1: りんご', '- 項目2: みかん', '後'].join('\n');
  const newText = ['前', '- 項目1: りんごとぶどう', '後'].join('\n');
  const r = computeLineDiff(oldText, newText);
  assert.equal(r.status[1], 'modified');
  assert.equal(r.oldLines[r.oldIndexOf[1]!], '- 項目1: りんご');
  assert.deepEqual(r.deletions.map((d) => [d.anchor, d.oldLines]), [[2, ['- 項目2: みかん']]]);
});

test('削除 1 行・追加 2 行：似ている行と対応づけ、余った行は追加にする', () => {
  const oldText = ['今日は晴れです。'].join('\n');
  const newText = ['はじめに', '今日は晴れでした。'].join('\n');
  const r = computeLineDiff(oldText, newText);
  assert.deepEqual(r.status, ['added', 'modified']);
  assert.equal(r.deletions.length, 0);
});

test('似ている行がなければ、追加と削除に分ける', () => {
  const oldText = ['東京は晴れ', '名古屋は雪'].join('\n');
  const newText = ['大阪は雨'].join('\n');
  const r = computeLineDiff(oldText, newText);
  assert.deepEqual(r.status, ['added']);
  assert.deepEqual(r.deletions.map((d) => d.oldLines), [['東京は晴れ', '名古屋は雪']]);
});

test('行数が同じなら、似ていなくても先頭から順に対応づける（従来どおり）', () => {
  const r = computeLineDiff('東京は晴れ', '大阪は雨');
  assert.deepEqual(r.status, ['modified']);
  assert.equal(r.deletions.length, 0);
});

test('対応づけは順序を保つ', () => {
  const pairs = pairBySimilarity(['aaaa', 'bbbb', 'cccc'], ['cccx', 'aaax']);
  // 順序を保つため、両方は対応づけられない。類似度の合計が大きい方を選ぶ
  assert.equal(pairs.length, 1);
  assert.ok(pairs.every(([d, i], k) => k === 0 || (d > pairs[k - 1][0] && i > pairs[k - 1][1])));
});

test('改行コード（CRLF / LF / CR）と先頭の BOM の違いは変更として扱わない', () => {
  const lf = '# 見出し\n\n本文\n';
  for (const other of [lf.replace(/\n/g, '\r\n'), lf.replace(/\n/g, '\r'), '﻿' + lf]) {
    const r = computeLineDiff(lf, other);
    assert.equal(r.isEmpty, true);
    assert.equal(summarize(r).total, 0);
  }
});
