// 拡張の設定（markdownUnreadChanges.*）を読み込む
import * as vscode from 'vscode';

export const CONFIG_SECTION = 'markdownUnreadChanges';

export interface TrackerConfig {
  include: string[];
  /** 設定の exclude と files.exclude を合わせたもの */
  exclude: string[];
  maxFiles: number;
  maxFileSizeBytes: number;
}

export function readConfig(): TrackerConfig {
  const c = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const include = c.get<string[]>('include', ['**/*.md']).filter((g) => g.trim() !== '');
  const exclude = c.get<string[]>('exclude', []).filter((g) => g.trim() !== '');

  // files.exclude のうち、常に有効（true）のものだけを加える
  const filesExclude = vscode.workspace.getConfiguration('files').get<Record<string, unknown>>('exclude', {});
  for (const [glob, enabled] of Object.entries(filesExclude)) {
    if (enabled === true) {
      exclude.push(glob);
    }
  }

  return {
    include: include.length > 0 ? include : ['**/*.md'],
    exclude,
    maxFiles: Math.max(1, c.get<number>('maxFiles', 2000)),
    maxFileSizeBytes: Math.max(1, c.get<number>('maxFileSize', 1024)) * 1024,
  };
}
