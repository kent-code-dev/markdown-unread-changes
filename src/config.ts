// 拡張の設定（markdownUnreadChanges.*）を読み込む。
// 制限モード（信頼していないフォルダ）の間は、フォルダ側（ワークスペース・フォルダ）の値を無視し、
// ユーザー設定と初期値だけを使う（フォルダに置かれた設定で、追跡範囲などを勝手に変えられないようにする）
import * as vscode from 'vscode';

export const CONFIG_SECTION = 'markdownUnreadChanges';

export interface TrackerConfig {
  include: string[];
  /** 設定の exclude と files.exclude を合わせたもの */
  exclude: string[];
  maxFiles: number;
  maxFileSizeBytes: number;
}

/** WorkspaceConfiguration.inspect() の結果のうち、判定に使うもの */
export interface InspectedValue<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
}

/**
 * 設定値を決める（vscode に依存しない部分）。
 * 信頼済み：フォルダ > ワークスペース > ユーザー > 初期値 の順（VS Code の get と同じ）。
 * 制限モード：ユーザー > 初期値 だけを使う。
 */
export function pickSetting<T>(inspected: InspectedValue<T> | undefined, trusted: boolean, fallback: T): T {
  if (!inspected) {
    return fallback;
  }
  const layers = trusted
    ? [inspected.workspaceFolderValue, inspected.workspaceValue, inspected.globalValue, inspected.defaultValue]
    : [inspected.globalValue, inspected.defaultValue];
  for (const v of layers) {
    if (v !== undefined) {
      return v;
    }
  }
  return fallback;
}

/** 設定を1つ読む。制限モードではフォルダ側の値を無視する */
export function readSetting<T>(section: string, key: string, fallback: T): T {
  const c = vscode.workspace.getConfiguration(section);
  if (vscode.workspace.isTrusted) {
    return c.get<T>(key, fallback);
  }
  return pickSetting(c.inspect<T>(key), false, fallback);
}

export function readConfig(): TrackerConfig {
  const include = readSetting<string[]>(CONFIG_SECTION, 'include', ['**/*.md']).filter((g) => g.trim() !== '');
  const exclude = readSetting<string[]>(CONFIG_SECTION, 'exclude', []).filter((g) => g.trim() !== '');

  // files.exclude のうち、常に有効（true）のものだけを加える
  const filesExclude = readSetting<Record<string, unknown>>('files', 'exclude', {});
  for (const [glob, enabled] of Object.entries(filesExclude)) {
    if (enabled === true) {
      exclude.push(glob);
    }
  }

  return {
    include: include.length > 0 ? include : ['**/*.md'],
    exclude,
    maxFiles: Math.max(1, readSetting<number>(CONFIG_SECTION, 'maxFiles', 2000)),
    maxFileSizeBytes: Math.max(1, readSetting<number>(CONFIG_SECTION, 'maxFileSize', 1024)) * 1024,
  };
}
