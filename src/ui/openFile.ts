// 未読ファイルの一覧で選んだファイルを開く（設定に応じてプレビューかエディタで）
import * as vscode from 'vscode';
import { CONFIG_SECTION } from '../config.ts';
import { previewLabelMatches } from './previewTarget.ts';

export type OpenTarget = 'preview' | 'editor';

export function readOpenTarget(): OpenTarget {
  const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('openUnreadFileIn', 'preview');
  return value === 'editor' ? 'editor' : 'preview';
}

export async function openUnreadFile(uri: vscode.Uri, target: OpenTarget = readOpenTarget()): Promise<void> {
  if (target === 'editor') {
    await vscode.window.showTextDocument(uri);
    return;
  }
  if (await revealExistingPreview(uri)) {
    return;
  }
  await vscode.commands.executeCommand('markdown.showPreview', uri);
}

const FOCUS_GROUP_COMMANDS = [
  'workbench.action.focusFirstEditorGroup',
  'workbench.action.focusSecondEditorGroup',
  'workbench.action.focusThirdEditorGroup',
  'workbench.action.focusFourthEditorGroup',
  'workbench.action.focusFifthEditorGroup',
  'workbench.action.focusSixthEditorGroup',
  'workbench.action.focusSeventhEditorGroup',
  'workbench.action.focusEighthEditorGroup',
];

/**
 * そのファイルのプレビューがすでに開いていれば前面に出す。
 * VS Code の API ではプレビューのタブがどのファイルを表示しているか分からないため、
 * タブの題名（「Preview foo.md」「[Preview] foo.md」など。末尾がファイル名）で探す。
 * 同じファイル名の Markdown を複数開いているなど、特定できない場合は false を返す
 */
async function revealExistingPreview(uri: vscode.Uri): Promise<boolean> {
  const name = uri.path.split('/').pop() ?? '';
  if (!name) {
    return false;
  }
  // 同じファイル名の別のファイルを開いていると、題名だけでは区別できない
  const sameName = vscode.workspace.textDocuments.filter(
    (d) => d.languageId === 'markdown' && d.uri.path.split('/').pop() === name && d.uri.toString() !== uri.toString(),
  );
  if (sameName.length > 0) {
    return false;
  }

  const matches: { group: vscode.TabGroup; tab: vscode.Tab; index: number }[] = [];
  for (const group of vscode.window.tabGroups.all) {
    group.tabs.forEach((tab, index) => {
      if (
        tab.input instanceof vscode.TabInputWebview &&
        tab.input.viewType.includes('markdown.preview') &&
        previewLabelMatches(tab.label, name)
      ) {
        matches.push({ group, tab, index });
      }
    });
  }
  if (matches.length === 0) {
    return false;
  }
  // 前面に出ているもの、アクティブなグループのものを優先する
  matches.sort((a, b) => Number(b.tab.isActive) - Number(a.tab.isActive) || Number(b.group.isActive) - Number(a.group.isActive));
  const { group, tab, index } = matches[0];

  const focusGroup = FOCUS_GROUP_COMMANDS[group.viewColumn - 1];
  if (!focusGroup) {
    return false;
  }
  await vscode.commands.executeCommand(focusGroup);
  if (index < 9) {
    await vscode.commands.executeCommand(`workbench.action.openEditorAtIndex${index + 1}`);
  } else {
    await vscode.commands.executeCommand('workbench.action.openEditorAtIndex1');
    for (let k = 0; k < index; k++) {
      await vscode.commands.executeCommand('workbench.action.nextEditorInGroup');
    }
  }
  // 狙ったタブが前面に出たか確かめる
  const active = vscode.window.tabGroups.activeTabGroup;
  return active.viewColumn === group.viewColumn && active.activeTab?.label === tab.label;
}
