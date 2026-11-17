// ステータスバーに変更箇所の数・未読ファイルの数を表示する（ノート「ステータスバーの件数」）
import * as vscode from 'vscode';
import type { Tracker } from '../tracker/tracker.ts';
import { resolvePreviewTarget } from './previewTarget.ts';

export const COMMAND_MARK_AS_READ = 'markdownUnreadChanges.markAsRead';
export const COMMAND_SHOW_UNREAD = 'markdownUnreadChanges.showUnreadFiles';
const RECENT_LIMIT = 20;

export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly tracker: Tracker;
  private readonly disposables: vscode.Disposable[] = [];
  /** 最近表示した・開いた Markdown ファイル（URI 文字列。新しい順） */
  private recent: string[] = [];

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

  /** 最近表示した・開いた Markdown ファイルを覚える（同じファイル名の候補が複数あるときに優先する） */
  rememberOpened(uri: vscode.Uri): void {
    const key = uri.toString();
    this.recent = [key, ...this.recent.filter((r) => r !== key)].slice(0, RECENT_LIMIT);
  }

  /**
   * 表示中の Markdown ファイル。プレビューにフォーカスがあるときは、タブの題名から表示中のファイルを推定する。
   * 特定できなければ undefined（別のファイルを誤って既読にしないため）
   */
  activeMarkdownUri(): vscode.Uri | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'markdown') {
      this.rememberOpened(editor.document.uri);
      return editor.document.uri;
    }
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (tab && tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('markdown.preview')) {
      const candidates = [
        ...this.tracker.trackedFiles(),
        ...vscode.workspace.textDocuments.filter((d) => d.languageId === 'markdown').map((d) => d.uri.toString()),
      ];
      const target = resolvePreviewTarget(tab.label, candidates, this.recent);
      return target ? vscode.Uri.parse(target) : undefined;
    }
    return undefined;
  }

  /** プレビューにフォーカスがあるが、表示中のファイルを特定できないか */
  private isUnresolvedPreview(): boolean {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    return (
      !vscode.window.activeTextEditor &&
      !!tab &&
      tab.input instanceof vscode.TabInputWebview &&
      tab.input.viewType.includes('markdown.preview') &&
      this.activeMarkdownUri() === undefined
    );
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
      this.item.tooltip =
        'クリックで未読のファイルの一覧を開く' +
        (this.isUnresolvedPreview()
          ? '\n\nこのプレビューのファイルを特定できませんでした（同じ名前のファイルが複数あるなど）。エディタで表示すると既読にできます。'
          : '') +
        degradedNote;
      this.item.command = COMMAND_SHOW_UNREAD;
    } else {
      this.item.text = `${warn}$(check) 未読なし`;
      this.item.tooltip = 'Markdown Unread Changes' + degradedNote;
      this.item.command = undefined;
    }
    this.item.show();
  }
}
