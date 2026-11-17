// 既読時点のテキストと現在のテキストを比べ、現在の各行の状態と削除された行をまとめる
import { diffLines } from './myers.ts';
import { normalizeLineForCompare } from './normalize.ts';

export type LineStatus = 'unchanged' | 'added' | 'modified';

/** 削除された行のまとまり */
export interface Deletion {
  /** 削除された行が、現在の何行目の直前にあったか（0 始まり。末尾なら行数と同じ） */
  anchor: number;
  /** 旧テキストでの開始行 */
  oldStart: number;
  oldLines: string[];
}

/** これ以上似ている行どうしだけを「変更」として対応づける（0〜1） */
export const SIMILARITY_THRESHOLD = 0.5;
/** 対応づけの計算量の上限（削除行数 × 追加行数）。超えたら先頭から順に対応づける */
const MAX_PAIRING_CELLS = 40000;

/**
 * 行数の違う削除行と追加行を、順序を保ったまま、似ている行どうしで対応づける。
 * 戻り値は [削除行の位置, 追加行の位置] の組（削除行の位置の昇順）
 */
export function pairBySimilarity(deleted: readonly string[], inserted: readonly string[]): (readonly [number, number])[] {
  const d = deleted.length;
  const a = inserted.length;
  if (d === 0 || a === 0) {
    return [];
  }
  if (d * a > MAX_PAIRING_CELLS) {
    return Array.from({ length: Math.min(d, a) }, (_, p) => [p, p] as const);
  }

  // dp[i][j] = 削除行 i 個・追加行 j 個までで得られる類似度の合計の最大値
  const score: number[][] = deleted.map((x) => inserted.map((y) => similarity(x, y)));
  const dp: number[][] = Array.from({ length: d + 1 }, () => new Array<number>(a + 1).fill(0));
  for (let i = 1; i <= d; i++) {
    for (let j = 1; j <= a; j++) {
      const s = score[i - 1][j - 1];
      const diag = s >= SIMILARITY_THRESHOLD ? dp[i - 1][j - 1] + s : -Infinity;
      dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1], diag);
    }
  }

  const pairs: (readonly [number, number])[] = [];
  let i = d;
  let j = a;
  while (i > 0 && j > 0) {
    const s = score[i - 1][j - 1];
    if (s >= SIMILARITY_THRESHOLD && dp[i][j] === dp[i - 1][j - 1] + s) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i][j] === dp[i - 1][j]) {
      i--;
    } else {
      j--;
    }
  }
  return pairs.reverse();
}

/** 2 行の似ている度合い（文字の 2-gram の Dice 係数。空白は無視する） */
export function similarity(x: string, y: string): number {
  const a = x.replace(/\s+/g, '');
  const b = y.replace(/\s+/g, '');
  if (a === b) {
    return 1;
  }
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  if (a.length === 1 || b.length === 1) {
    return a.includes(b) || b.includes(a) ? 2 / (a.length + b.length) : 0;
  }
  const grams = new Map<string, number>();
  for (let k = 0; k < a.length - 1; k++) {
    const g = a.slice(k, k + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let common = 0;
  for (let k = 0; k < b.length - 1; k++) {
    const g = b.slice(k, k + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      common++;
      grams.set(g, n - 1);
    }
  }
  return (2 * common) / (a.length - 1 + (b.length - 1));
}

/** 連続した変更のまとまり（ステータスバーで 1 件と数える単位） */
export interface ChangeGroup {
  kind: 'modified' | 'added' | 'deleted';
  /** 現在のテキストでの範囲 [newStart, newEnd) */
  newStart: number;
  newEnd: number;
}

export interface LineDiffResult {
  oldLines: string[];
  newLines: string[];
  /** 現在の各行の状態 */
  status: LineStatus[];
  /** 現在の各行に対応する旧テキストの行（unchanged と modified のみ） */
  oldIndexOf: (number | undefined)[];
  deletions: Deletion[];
  groups: ChangeGroup[];
  /** 変更が 1 つもないか */
  isEmpty: boolean;
}

/** 行に分ける。改行コード（CRLF / LF / CR）の違いと先頭の BOM は変更として扱わない */
export function splitLines(text: string): string[] {
  return text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
}

export function computeLineDiff(oldText: string, newText: string): LineDiffResult {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const oldNorm = oldLines.map(normalizeLineForCompare);
  const newNorm = newLines.map(normalizeLineForCompare);
  const ops = diffLines(oldNorm, newNorm);

  const status: LineStatus[] = new Array(newLines.length).fill('unchanged');
  const oldIndexOf: (number | undefined)[] = new Array(newLines.length).fill(undefined);
  const deletions: Deletion[] = [];
  const rawGroups: ChangeGroup[] = [];

  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.kind === 'equal') {
      oldIndexOf[op.newIndex] = op.oldIndex;
      i++;
      continue;
    }
    // 連続する削除・追加を 1 つのまとまり（ハンク）として集める
    const deleted: number[] = [];
    const inserted: number[] = [];
    while (i < ops.length && ops[i].kind !== 'equal') {
      const o = ops[i];
      if (o.kind === 'delete') {
        deleted.push(o.oldIndex);
      } else if (o.kind === 'insert') {
        inserted.push(o.newIndex);
      }
      i++;
    }
    const anchor = inserted.length > 0 ? inserted[0] : nextNewIndex(ops, i, newLines.length);
    const hunkEnd = inserted.length > 0 ? inserted[inserted.length - 1] + 1 : anchor;

    // 隣り合う削除と追加を「変更」として対応づける。
    // 行数が同じなら先頭から順に、違うなら似ている行どうしを対応づける
    const pairs =
      deleted.length === inserted.length
        ? deleted.map((_, p) => [p, p] as const)
        : pairBySimilarity(
            deleted.map((idx) => oldNorm[idx]),
            inserted.map((idx) => newNorm[idx]),
          );
    for (const [dp, ip] of pairs) {
      status[inserted[ip]] = 'modified';
      oldIndexOf[inserted[ip]] = deleted[dp];
    }
    const pairedInserts = new Set(pairs.map(([, ip]) => ip));
    inserted.forEach((idx, ip) => {
      if (!pairedInserts.has(ip)) {
        status[idx] = 'added';
      }
    });

    // 対応づかなかった削除行は、連続するまとまりごとに「削除（赤）」として残す
    const pairedDeletes = new Set(pairs.map(([dp]) => dp));
    let run: number[] = [];
    const flushRun = (nextInsert: number) => {
      if (run.length > 0) {
        deletions.push({
          anchor: nextInsert < inserted.length ? inserted[nextInsert] : hunkEnd,
          oldStart: deleted[run[0]],
          oldLines: run.map((dp) => oldLines[deleted[dp]]),
        });
        run = [];
      }
    };
    // 削除行の直後に来る追加行の位置（対応づいた組の追加行より前に置く）
    let pairIndex = 0;
    let prevInsert = -1;
    for (let dp = 0; dp < deleted.length; dp++) {
      if (pairedDeletes.has(dp)) {
        flushRun(prevInsert + 1);
        prevInsert = pairs[pairIndex][1];
        pairIndex++;
      } else {
        run.push(dp);
      }
    }
    flushRun(prevInsert + 1);

    const newStart = inserted.length > 0 ? inserted[0] : anchor;
    const newEnd = inserted.length > 0 ? inserted[inserted.length - 1] + 1 : anchor;
    const kind = deleted.length === 0 ? 'added' : inserted.length === 0 ? 'deleted' : 'modified';
    const blankOnly =
      deleted.every((idx) => oldLines[idx].trim() === '') &&
      inserted.every((idx) => newLines[idx].trim() === '');
    if (!blankOnly) {
      rawGroups.push({ kind, newStart, newEnd });
    }
  }

  const groups = mergeGroups(rawGroups, newLines);
  return {
    oldLines,
    newLines,
    status,
    oldIndexOf,
    deletions,
    groups,
    isEmpty: deletions.length === 0 && status.every((s) => s === 'unchanged'),
  };
}

function nextNewIndex(ops: ReturnType<typeof diffLines>, from: number, newLength: number): number {
  for (let j = from; j < ops.length; j++) {
    const op = ops[j];
    if (op.kind === 'equal' || op.kind === 'insert') {
      return op.newIndex;
    }
  }
  return newLength;
}

/** 空行だけを挟んで隣り合うまとまりは 1 件にまとめる（段落を続けて書き換えた場合など） */
function mergeGroups(groups: ChangeGroup[], newLines: string[]): ChangeGroup[] {
  const merged: ChangeGroup[] = [];
  for (const g of groups) {
    const last = merged[merged.length - 1];
    if (last && onlyBlankBetween(last.newEnd, g.newStart, newLines)) {
      last.newEnd = Math.max(last.newEnd, g.newEnd);
      if (last.kind !== g.kind) {
        last.kind = 'modified';
      }
    } else {
      merged.push({ ...g });
    }
  }
  return merged;
}

function onlyBlankBetween(from: number, to: number, newLines: string[]): boolean {
  for (let k = from; k < to; k++) {
    // 空行以外の行（変わっていない内容）を挟んでいたら別のまとまり
    if (newLines[k].trim() !== '') {
      return false;
    }
  }
  return true;
}

/** ステータスバーのツールチップ用の内訳 */
export function summarize(result: LineDiffResult): { total: number; modified: number; added: number; deleted: number } {
  const counts = { total: result.groups.length, modified: 0, added: 0, deleted: 0 };
  for (const g of result.groups) {
    counts[g.kind]++;
  }
  return counts;
}
