// 拡張機能のエントリーポイント
import * as vscode from 'vscode';
import { createMarkdownItPlugin } from './preview/markdownItPlugin.ts';
import type { RenderDiffProvider } from './preview/markdownItPlugin.ts';
import { SnapshotStore } from './tracker/snapshotStore.ts';
import { Tracker } from './tracker/tracker.ts';
import { COMMAND_MARK_AS_READ, COMMAND_SHOW_UNREAD, StatusBarController } from './ui/statusBar.ts';
import { openUnreadFile } from './ui/openFile.ts';

const COMMAND_MARK_ALL_AS_READ = 'markdownUnreadChanges.markAllAsRead';

let tracker: Tracker | undefined;

/** ワークスペースを開いていない場合など、追跡できないときのプレビュー用 */
const noDiff: RenderDiffProvider = { getDiffForRender: () => undefined };

export function activate(context: vscode.ExtensionContext) {
  const storageUri = context.storageUri;
  if (storageUri) {
    const store = new SnapshotStore(storageUri);
    tracker = new Tracker(store);
    const t = tracker;
    const statusBar = new StatusBarController(t);
    context.subscriptions.push(t, statusBar);

    // スナップショットが変わったら（既読にした・読み込みが終わった）プレビューを描き直す
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    context.subscriptions.push(
      t.onDidChange((e) => {
        if (!e.snapshotChanged) {
          return;
        }
        if (refreshTimer) {
          clearTimeout(refreshTimer);
        }
        refreshTimer = setTimeout(() => void vscode.commands.executeCommand('markdown.preview.refresh'), 100);
      }),
    );

    context.subscriptions.push(
      vscode.commands.registerCommand(COMMAND_MARK_AS_READ, async (uri?: vscode.Uri) => {
        const target = uri instanceof vscode.Uri ? uri : statusBar.activeMarkdownUri();
        if (!target) {
          void vscode.window.showInformationMessage(
            '既読にする Markdown ファイルを特定できませんでした。ファイルをエディタで表示してから実行してください。',
          );
          return;
        }
        if (!t.isTracked(target.toString())) {
          void vscode.window.showInformationMessage('このファイルは追跡の対象外です（設定の include / exclude を確認してください）。');
          return;
        }
        await t.markRead(target);
      }),
      vscode.commands.registerCommand(COMMAND_MARK_ALL_AS_READ, async () => {
        const count = t.unreadFiles().length;
        if (count === 0) {
          void vscode.window.showInformationMessage('未読のファイルはありません。');
          return;
        }
        const ok = await vscode.window.showWarningMessage(
          `未読の ${count} ファイルをすべて既読にしますか？変更箇所の色はすべて消えます。`,
          { modal: true },
          'すべて既読にする',
        );
        if (ok) {
          await t.markAllRead();
        }
      }),
      vscode.commands.registerCommand(COMMAND_SHOW_UNREAD, async () => {
        const items = t.unreadFiles().map((f) => {
          const uri = vscode.Uri.parse(f.uri);
          return {
            label: vscode.workspace.asRelativePath(uri, true),
            description: `変更 ${f.count}件`,
            uri,
          };
        });
        items.sort((a, b) => a.label.localeCompare(b.label));
        if (items.length === 0) {
          void vscode.window.showInformationMessage('未読のファイルはありません。');
          return;
        }
        const picked = await vscode.window.showQuickPick(items, { placeHolder: '開く未読のファイルを選択' });
        if (picked) {
          // 初期値はプレビュー（色が見えるように）。設定でエディタも選べる
          statusBar.rememberOpened(picked.uri);
          await openUnreadFile(picked.uri);
        }
      }),
    );

    void store.load().then(() => t.start());
  } else {
    // フォルダを開いていない場合は保存場所がないため追跡しない
    const notAvailable = () =>
      void vscode.window.showInformationMessage('Markdown Unread Changes: フォルダを開くと変更の追跡が有効になります。');
    for (const id of [COMMAND_MARK_AS_READ, COMMAND_MARK_ALL_AS_READ, COMMAND_SHOW_UNREAD]) {
      context.subscriptions.push(vscode.commands.registerCommand(id, notAvailable));
    }
  }

  const labels = {
    tableColumnsChanged: '列が変更されました',
    tableAlignmentChanged: '配置が変更されました',
  };
  return {
    // 標準の Markdown プレビューから呼ばれる
    extendMarkdownIt: createMarkdownItPlugin(
      { getDiffForRender: (uri) => (tracker ?? noDiff).getDiffForRender(uri) },
      labels,
    ),
  };
}

/** 終了時に、未保存の記録（index.json）の保存を待つ */
export function deactivate(): Thenable<void> | undefined {
  return tracker?.flush().catch((err: unknown) => console.error('[markdown-unread-changes] flush failed', err));
}
