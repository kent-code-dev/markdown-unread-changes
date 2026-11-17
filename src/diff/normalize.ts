// 比較の前に行を正規化する（表の空白や区切り行の「-」の数だけの変更を無視するため）

/** 表の区切り行（|---|:---:|）か */
export function isTableSeparator(line: string): boolean {
  const cells = splitTableCells(line);
  return cells !== undefined && cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

/** 表の行らしい行か（先頭か末尾が | ） */
export function looksLikeTableRow(line: string): boolean {
  const t = line.trim();
  return t.length > 1 && (t.startsWith('|') || t.endsWith('|'));
}

/**
 * 表の行をセルに分ける。表の行に見えなければ undefined。
 * エスケープされた \| とコード内の | は区切りとみなさない
 */
export function splitTableCells(line: string): string[] | undefined {
  let t = line.trim();
  if (!t.includes('|')) {
    return undefined;
  }
  if (t.startsWith('|')) {
    t = t.slice(1);
  }
  if (t.endsWith('|') && !t.endsWith('\\|')) {
    t = t.slice(0, -1);
  }
  const cells: string[] = [];
  let current = '';
  let inCode = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '\\' && i + 1 < t.length) {
      current += ch + t[i + 1];
      i++;
    } else if (ch === '`') {
      inCode = !inCode;
      current += ch;
    } else if (ch === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** 区切り行の各列の配置（left / center / right / none） */
export function tableAlignments(line: string): string[] {
  return (splitTableCells(line) ?? []).map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    return left && right ? 'center' : left ? 'left' : right ? 'right' : 'none';
  });
}

export function normalizeLineForCompare(line: string): string {
  if (isTableSeparator(line)) {
    // 「-」の数と空白をそろえ、配置だけを残す
    return '|' + tableAlignments(line).join('|') + '|';
  }
  if (looksLikeTableRow(line)) {
    const cells = splitTableCells(line);
    if (cells) {
      return '|' + cells.join('|') + '|';
    }
  }
  return line;
}
