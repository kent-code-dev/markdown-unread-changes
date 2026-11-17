// ステータスバーに変更箇所の数・未読ファイルの数を表示する（ノート「ステータスバーの件数」）
import * as vscode from 'vscode';
import type { Tracker } from '../tracker/tracker.ts';

export const COMMAND_MARK_AS_READ = 'markdownUnreadChanges.markAsRead';
export const COMMAND_SHOW_UNREAD = 'markdownUnreadChanges.showUnreadFiles';

export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly tracker: Tracker;
  private readonly disposables: vscode.Disposable[] = [];
  /** プレビューにフォーカスがあるとき用に、最後に表示していた Markdown ファイルを覚えておく */
  private lastMarkdownUri: vscode.Uri | undefined;

  constructor(tracker: Tracker) {
    this.tracker = tracker;
    this.item = vscode.window.createStatusBarItem('markdownUnreadChanges.status', vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'Markdown Unread Changes';
    this.disposables.push(
      this.item,
      tracker.onDidChange(() => this.update()),
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.update()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.update()),
    );
    this.update();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  /** 表示中の Markdown ファイル。プレビューにフォーカスがあるときは、直前に表示していたファイル */
  activeMarkdownUri(): vscode.Uri | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'markdown') {
      this.lastMarkdownUri = editor.document.uri;
      return editor.document.uri;
    }
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputWebview && input.viewType.includes('markdown.preview')) {
      return this.lastMarkdownUri;
    }
    return undefined;
  }

  update(): void {
    const t = this.tracker;
    const degraded = t.mode === 'degraded';
    const degradedNote = degraded
      ? '\n\nファイル数が上限を超えたため、開いたファイルだけを追跡しています。'
      : '';

    if (t.mode === 'starting') {
      this.item.hide();
      return;
    }
    if (t.mode === 'scanning' && t.progress.total > 0) {
      this.item.text = `$(sync~spin) 取り込み中 ${t.progress.done}/${t.progress.total}`;
      this.item.tooltip = 'Markdown ファイルを取り込んでいます';
      this.item.command = undefined;
      this.item.show();
      return;
    }

    const warn = degraded ? '$(warning) ' : '';
    const active = this.activeMarkdownUri();
    const unread = t.unreadFiles();
    const summary = active ? t.getSummary(active.toString()) : undefined;

    if (active && summary) {
      const others = unread.filter((f) => f.uri !== active.toString()).length;
      this.item.text = `${warn}$(diff) 変更 ${summary.total}件`;
      this.item.tooltip =
        `変更 ${summary.modified}・追加 ${summary.added}・削除 ${summary.deleted}\n` +
        'クリックでこのファイルを既読にする' +
        (others > 0 ? `\nほかに未読 ${others} ファイル` : '') +
        degradedNote;
      this.item.command = { command: COMMAND_MARK_AS_READ, title: '既読にする', arguments: [active] };
    } else if (unread.length > 0) {
      this.item.text = `${warn}$(files) 未読 ${unread.length}ファイル`;
      this.item.tooltip = 'クリックで未読のファイルの一覧を開く' + degradedNote;
      this.item.command = COMMAND_SHOW_UNREAD;
    } else {
      this.item.text = `${warn}$(check) 未読なし`;
      this.item.tooltip = 'Markdown Unread Changes' + degradedNote;
      this.item.command = undefined;
    }
    this.item.show();
  }
}
