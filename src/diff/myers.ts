// 行単位の Myers 差分（O(ND)）。外部ライブラリは使わない。

/** 編集操作。equal は両方に、delete は旧のみ、insert は新のみに存在する行 */
export type EditOp =
  | { kind: 'equal'; oldIndex: number; newIndex: number }
  | { kind: 'delete'; oldIndex: number }
  | { kind: 'insert'; newIndex: number };

/** 編集距離がこれを超えたら、中央部分を「まとめて置き換え」とみなして計算を打ち切る */
const MAX_EDIT_DISTANCE = 4000;

export function diffLines(oldLines: readonly string[], newLines: readonly string[]): EditOp[] {
  // 共通の先頭・末尾を先に取り除き、計算量を減らす
  let prefix = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const ops: EditOp[] = [];
  for (let i = 0; i < prefix; i++) {
    ops.push({ kind: 'equal', oldIndex: i, newIndex: i });
  }

  const middle = myersMiddle(
    oldLines.slice(prefix, oldLines.length - suffix),
    newLines.slice(prefix, newLines.length - suffix),
  );
  for (const op of middle) {
    if (op.kind === 'equal') {
      ops.push({ kind: 'equal', oldIndex: op.oldIndex + prefix, newIndex: op.newIndex + prefix });
    } else if (op.kind === 'delete') {
      ops.push({ kind: 'delete', oldIndex: op.oldIndex + prefix });
    } else {
      ops.push({ kind: 'insert', newIndex: op.newIndex + prefix });
    }
  }

  for (let i = suffix; i > 0; i--) {
    ops.push({ kind: 'equal', oldIndex: oldLines.length - i, newIndex: newLines.length - i });
  }
  return ops;
}

function myersMiddle(a: readonly string[], b: readonly string[]): EditOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) {
    return [];
  }
  if (n === 0 || m === 0) {
    return replaceAll(n, m);
  }

  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max;
  // v[k + offset] = 対角線 k 上で到達できる最も遠い x
  const v = new Int32Array(2 * max + 2);
  // 各ステップ d の v の写し（-d..d の範囲だけ保存する）
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    const snapshot = new Int32Array(2 * d + 1);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset]; // 下へ移動（挿入）
      } else {
        x = v[k - 1 + offset] + 1; // 右へ移動（削除）
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        for (let j = -d; j <= d; j += 2) {
          snapshot[j + d] = v[j + offset];
        }
        trace.push(snapshot);
        return backtrack(trace, n, m);
      }
    }
    for (let j = -d; j <= d; j += 2) {
      snapshot[j + d] = v[j + offset];
    }
    trace.push(snapshot);
  }
  // 編集距離が上限を超えた：全体を置き換えとして扱う
  return replaceAll(n, m);
}

function backtrack(trace: Int32Array[], n: number, m: number): EditOp[] {
  const ops: EditOp[] = [];
  let x = n;
  let y = m;
  const at = (d: number, k: number): number => trace[d][k + d];

  for (let d = trace.length - 1; d > 0; d--) {
    const k = x - y;
    const prevK =
      k === -d || (k !== d && at(d - 1, k - 1) < at(d - 1, k + 1)) ? k + 1 : k - 1;
    const prevX = at(d - 1, prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: 'equal', oldIndex: x, newIndex: y });
    }
    if (x === prevX) {
      y--;
      ops.push({ kind: 'insert', newIndex: y });
    } else {
      x--;
      ops.push({ kind: 'delete', oldIndex: x });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ kind: 'equal', oldIndex: x, newIndex: y });
  }
  return ops.reverse();
}

function replaceAll(n: number, m: number): EditOp[] {
  const ops: EditOp[] = [];
  for (let i = 0; i < n; i++) {
    ops.push({ kind: 'delete', oldIndex: i });
  }
  for (let j = 0; j < m; j++) {
    ops.push({ kind: 'insert', newIndex: j });
  }
  return ops;
}
