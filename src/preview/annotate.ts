// markdown-it のトークン列に、差分に応じた色付け用の要素を差し込む。
// VS Code はトークンをキャッシュして使い回すため、元のトークンは書き換えずに新しい配列を返す。
import type { Token } from 'markdown-it';
import type { Deletion, LineDiffResult } from '../diff/lineDiff.ts';
import { isTableSeparator, looksLikeTableRow, splitTableCells, tableAlignments } from '../diff/normalize.ts';

/** 色付け用の生 HTML を出すトークンの種類（markdownItPlugin で描画ルールを登録する） */
export const RAW_TOKEN_TYPE = 'muc_raw';

export interface AnnotateLabels {
  tableColumnsChanged: string;
  tableAlignmentChanged: string;
}

type TokenClass = new (type: string, tag: string, nesting: Token['nesting']) => Token;

interface LeafBlock {
  /** トークン列での開始・終了位置（両端を含む） */
  first: number;
  last: number;
  lineStart: number;
  lineEnd: number;
  isRow: boolean;
}

interface Coloring {
  kind: 'modified' | 'added';
  oldText?: string;
}

interface ChangedTable {
  first: number;
  last: number;
  lineStart: number;
  lineEnd: number;
  label: string;
  oldText: string;
}

/** 単独で 1 ブロックになるトークン（開始・終了の対を持たないもの） */
const SINGLE_BLOCK_TYPES = new Set(['fence', 'code_block', 'hr', 'html_block', 'math_block', 'front_matter']);
/** 開始・終了の対を持ち、中身を 1 ブロックとして色付けするトークン */
const PAIRED_BLOCK_TYPES = new Set(['paragraph_open', 'heading_open', 'tr_open']);
/** 削除ブロックを直前に差し込んではいけないトークン（表の内部構造） */
const NO_INSERT_BEFORE = new Set(['thead_open', 'tbody_open']);

export function annotateTokens(
  tokens: readonly Token[],
  TokenCtor: TokenClass,
  diff: LineDiffResult,
  labels: AnnotateLabels,
): Token[] {
  if (diff.isEmpty) {
    return tokens.slice();
  }

  const leaves = findLeafBlocks(tokens);
  const tables = findChangedTables(tokens, diff, labels);
  // 色付けを別の形で示すため、赤のブロックとしては出さない削除
  const consumed = new Set<Deletion>();

  // 各ブロックの色と変更前のテキストを決める
  const leafAt = new Map<number, { leaf: LeafBlock; coloring: Coloring }>();
  const closeAfter = new Set<number>();
  for (const leaf of leaves) {
    if (tables.some((t) => leaf.first > t.first && leaf.last < t.last)) {
      continue; // 構造が変わった表の中は、表全体の枠で示す
    }
    const coloring = colorLeaf(leaf, diff);
    if (coloring) {
      leafAt.set(leaf.first, { leaf, coloring });
      if (!leaf.isRow) {
        closeAfter.add(leaf.last);
      }
    }
  }
  // 構造が変わった表の中の削除は、表の枠の中で示すので個別には出さない
  for (const d of diff.deletions) {
    if (tables.some((t) => d.anchor > t.lineStart && d.anchor < t.lineEnd)) {
      consumed.add(d);
    }
  }

  const pending = diff.deletions.filter((d) => !consumed.has(d)).sort((a, b) => a.anchor - b.anchor);
  let next = 0;
  const out: Token[] = [];
  const raw = (html: string): Token => {
    const t = new TokenCtor(RAW_TOKEN_TYPE, '', 0);
    t.content = html;
    t.block = true;
    return t;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.map && token.nesting !== -1 && !NO_INSERT_BEFORE.has(token.type)) {
      while (next < pending.length && pending[next].anchor <= token.map[0]) {
        out.push(raw(token.type === 'tr_open' ? deletedRowHtml(pending[next]) : deletedBlockHtml(pending[next])));
        next++;
      }
    }

    const table = tables.find((t) => t.first === i);
    if (table) {
      out.push(
        raw(
          `<div class="muc-table-changed" data-muc-old="${escapeHtml(table.oldText)}">` +
            `<div class="muc-label">${escapeHtml(table.label)}</div>`,
        ),
      );
    }

    const entry = leafAt.get(i);
    if (entry && entry.leaf.isRow) {
      out.push(withRowColoring(token, TokenCtor, entry.coloring));
    } else {
      if (entry) {
        const old = entry.coloring.oldText !== undefined ? ` data-muc-old="${escapeHtml(entry.coloring.oldText)}"` : '';
        out.push(raw(`<div class="muc-block muc-${entry.coloring.kind}"${old}>`));
      }
      out.push(token);
    }

    if (closeAfter.has(i)) {
      out.push(raw('</div>'));
    }
    if (tables.some((t) => t.last === i)) {
      out.push(raw('</div>'));
    }
  }
  while (next < pending.length) {
    out.push(raw(deletedBlockHtml(pending[next])));
    next++;
  }
  return out;
}

function findLeafBlocks(tokens: readonly Token[]): LeafBlock[] {
  const leaves: LeafBlock[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.map) {
      continue;
    }
    if (SINGLE_BLOCK_TYPES.has(t.type)) {
      leaves.push({ first: i, last: i, lineStart: t.map[0], lineEnd: t.map[1], isRow: false });
    } else if (PAIRED_BLOCK_TYPES.has(t.type)) {
      const closeType = t.type.replace(/_open$/, '_close');
      let j = i + 1;
      while (j < tokens.length && !(tokens[j].type === closeType && tokens[j].level === t.level)) {
        j++;
      }
      leaves.push({
        first: i,
        last: Math.min(j, tokens.length - 1),
        lineStart: t.map[0],
        lineEnd: t.map[1],
        isRow: t.type === 'tr_open',
      });
    }
  }
  return leaves;
}

/**
 * ブロックの色と変更前のテキストを決める。
 * ブロックの途中で削除された行は、変更前のテキストには含めるが、赤のブロックとしても別に表示する
 * （開かなくても行が消えたことが分かるように）
 */
function colorLeaf(leaf: LeafBlock, diff: LineDiffResult): Coloring | undefined {
  const { lineStart: s, lineEnd: e } = leaf;
  const inner = diff.deletions.filter((d) => d.anchor > s && d.anchor < e);
  let anyChanged = false;
  let allAdded = true;
  let anyNonBlank = false;
  for (let k = s; k < e && k < diff.status.length; k++) {
    const st = diff.status[k];
    if (st !== 'unchanged') {
      anyChanged = true;
    }
    if (diff.newLines[k].trim() !== '') {
      anyNonBlank = true;
      if (st !== 'added') {
        allAdded = false;
      }
    }
  }
  if (!anyChanged) {
    return undefined;
  }
  if (allAdded && anyNonBlank) {
    return { kind: 'added' };
  }

  // 変更前のブロックを組み立てる
  const old: string[] = [];
  for (let k = s; k < e && k < diff.status.length; k++) {
    for (const d of inner) {
      if (d.anchor === k) {
        old.push(...d.oldLines);
      }
    }
    const oi = diff.oldIndexOf[k];
    if (oi !== undefined) {
      old.push(diff.oldLines[oi]);
    }
  }
  return { kind: 'modified', oldText: old.join('\n') };
}

function findChangedTables(tokens: readonly Token[], diff: LineDiffResult, labels: AnnotateLabels): ChangedTable[] {
  const result: ChangedTable[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'table_open' || !t.map) {
      continue;
    }
    let j = i + 1;
    while (j < tokens.length && !(tokens[j].type === 'table_close' && tokens[j].level === t.level)) {
      j++;
    }
    const [s, e] = t.map;
    const change = tableStructureChange(diff, s, e, labels);
    if (change) {
      result.push({ first: i, last: Math.min(j, tokens.length - 1), lineStart: s, lineEnd: e, ...change });
    }
  }
  return result;
}

/** 表の列数か配置が変わっていれば、表示するラベルと変更前の表を返す */
function tableStructureChange(
  diff: LineDiffResult,
  s: number,
  e: number,
  labels: AnnotateLabels,
): { label: string; oldText: string } | undefined {
  // 表の中で、旧テキストに対応する行を 1 つ探す
  let anchorOld: number | undefined;
  for (let k = s; k < e; k++) {
    if (diff.oldIndexOf[k] !== undefined) {
      anchorOld = diff.oldIndexOf[k];
      break;
    }
  }
  if (anchorOld === undefined) {
    return undefined; // 表ごと追加された
  }
  let os = anchorOld;
  while (os > 0 && looksLikeTableRow(diff.oldLines[os - 1])) {
    os--;
  }
  let oe = anchorOld + 1;
  while (oe < diff.oldLines.length && looksLikeTableRow(diff.oldLines[oe])) {
    oe++;
  }
  if (oe - os < 2 || !isTableSeparator(diff.oldLines[os + 1])) {
    return undefined;
  }
  const oldText = diff.oldLines.slice(os, oe).join('\n');
  const newCols = splitTableCells(diff.newLines[s])?.length ?? 0;
  const oldCols = splitTableCells(diff.oldLines[os])?.length ?? 0;
  if (newCols !== oldCols) {
    return { label: labels.tableColumnsChanged, oldText };
  }
  if (tableAlignments(diff.newLines[s + 1]).join() !== tableAlignments(diff.oldLines[os + 1]).join()) {
    return { label: labels.tableAlignmentChanged, oldText };
  }
  return undefined;
}

function withRowColoring(token: Token, TokenCtor: TokenClass, coloring: Coloring): Token {
  const copy = new TokenCtor(token.type, token.tag, token.nesting);
  Object.assign(copy, token);
  copy.attrs = token.attrs ? token.attrs.map(([k, v]) => [k, v] as [string, string]) : null;
  copy.attrJoin('class', `muc-row muc-${coloring.kind}`);
  if (coloring.oldText !== undefined) {
    copy.attrSet('data-muc-old', coloring.oldText); // 属性値は markdown-it がエスケープする
  }
  return copy;
}

function deletedBlockHtml(d: Deletion): string {
  return `<div class="muc-block muc-deleted">${escapeHtml(d.oldLines.join('\n'))}</div>`;
}

function deletedRowHtml(d: Deletion): string {
  return d.oldLines
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const cells = splitTableCells(line) ?? [line];
      return `<tr class="muc-row muc-deleted">${cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`;
    })
    .join('');
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
