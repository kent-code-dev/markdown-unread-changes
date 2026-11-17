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
  /**
   * 変更（削除と追加が隣り合う）の一部として削除された行の場合、対応づける現在の行。
   * 純粋な削除なら undefined
   */
  attachTo?: number;
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

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function computeLineDiff(oldText: string, newText: string): LineDiffResult {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const ops = diffLines(oldLines.map(normalizeLineForCompare), newLines.map(normalizeLineForCompare));

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
    const paired = Math.min(deleted.length, inserted.length);

    // 隣り合う削除と追加は、先頭から順に「変更」として対応づける
    for (let p = 0; p < paired; p++) {
      status[inserted[p]] = 'modified';
      oldIndexOf[inserted[p]] = deleted[p];
    }
    for (let p = paired; p < inserted.length; p++) {
      status[inserted[p]] = 'added';
    }
    if (deleted.length > paired) {
      const rest = deleted.slice(paired);
      const lastNew = inserted.length > 0 ? inserted[inserted.length - 1] : undefined;
      deletions.push({
        anchor: lastNew !== undefined ? lastNew + 1 : anchor,
        oldStart: rest[0],
        oldLines: rest.map((idx) => oldLines[idx]),
        attachTo: lastNew,
      });
    }

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
