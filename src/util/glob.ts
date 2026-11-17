// 設定の glob を、ワークスペースからの相対パスと照合するための最小限の変換（依存ゼロのため自作）
// 対応する記法：** / * / ? / {a,b} / [abc]

export function globToRegExp(glob: string): RegExp {
  let re = '';
  let inGroup = 0;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // 「**/」は 0 個以上のフォルダ、末尾の「**」は残りすべて
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '{') {
      inGroup++;
      re += '(?:';
    } else if (ch === '}' && inGroup > 0) {
      inGroup--;
      re += ')';
    } else if (ch === ',' && inGroup > 0) {
      re += '|';
    } else if (ch === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close > i) {
        re += '[' + glob.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
        i = close;
      } else {
        re += '\\[';
      }
    } else {
      re += ch.replace(/[.+^$()|\\\]]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$', process.platform === 'win32' ? 'i' : '');
}

export class GlobMatcher {
  private readonly patterns: RegExp[];

  constructor(globs: readonly string[]) {
    this.patterns = globs.map(globToRegExp);
  }

  /** relativePath は「/」区切りのワークスペース相対パス */
  matches(relativePath: string): boolean {
    return this.patterns.some((p) => p.test(relativePath));
  }
}

/** findFiles に渡すため、複数の glob を 1 つにまとめる */
export function combineGlobs(globs: readonly string[]): string | undefined {
  if (globs.length === 0) {
    return undefined;
  }
  return globs.length === 1 ? globs[0] : `{${globs.join(',')}}`;
}
