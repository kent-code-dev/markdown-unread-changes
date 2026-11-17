// ワークスペース内の Markdown ファイルを追跡し、既読時点からの差分と未読の状態を管理する
import * as vscode from 'vscode';
import { computeLineDiff, summarize, type LineDiffResult } from '../diff/lineDiff.ts';
import type { RenderDiffProvider } from '../preview/markdownItPlugin.ts';
import { combineGlobs, GlobMatcher } from '../util/glob.ts';
import { readConfig, type TrackerConfig } from '../config.ts';
import type { SnapshotStore } from './snapshotStore.ts';

export type TrackerMode = 'starting' | 'scanning' | 'ready' | 'degraded';

export interface ChangeSummary {
  total: number;
  modified: number;
  added: number;
  deleted: number;
}

/** 初回の取り込みで一度に処理するファイル数 */
const SCAN_CHUNK = 40;
const decoder = new TextDecoder();

export class Tracker implements RenderDiffProvider, vscode.Disposable {
  private readonly store: SnapshotStore;
  private config: TrackerConfig = readConfig();
  private include = new GlobMatcher(this.config.include);
  private exclude = new GlobMatcher(this.config.exclude);
  private readonly disposables: vscode.Disposable[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;
  private readonly diffCache = new Map<string, { oldText: string; newText: string; result: LineDiffResult }>();
  private readonly loading = new Set<string>();
  private readonly editTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly onDidChangeEmitter = new vscode.EventEmitter<{ uri?: string; snapshotChanged: boolean }>();
  private scanGeneration = 0;
  /**
   * ファイルごとの処理の待ち行列。取り込み・変更通知・編集・既読が同じファイルを同時に扱うと、
   * 古いスナップショットとの比較結果で未読の記録を上書きしてしまうため、1 つずつ順に処理する
   */
  private readonly locks = new Map<string, Promise<void>>();
  /** 実行中の処理（テストで完了を待つため） */
  private readonly running = new Set<Promise<unknown>>();
  /** 取り込み中に届いた変更通知。取り込みが終わってから処理する */
  private readonly deferred = new Map<string, vscode.Uri>();

  /** 状態が変わったときに発火する。snapshotChanged はプレビューの再描画が必要なとき true */
  readonly onDidChange = this.onDidChangeEmitter.event;
  mode: TrackerMode = 'starting';
  progress = { done: 0, total: 0 };

  constructor(store: SnapshotStore) {
    this.store = store;
  }

  async start(): Promise<void> {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentEdited(e.document)),
      vscode.workspace.onDidOpenTextDocument((doc) => void this.onDocumentOpened(doc)),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        const key = doc.uri.toString();
        this.diffCache.delete(key);
        if (!this.store.get(key)?.unread) {
          this.store.evict(key);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('markdownUnreadChanges') || e.affectsConfiguration('files.exclude')) {
          void this.rescan();
        }
      }),
    );
    await this.rescan();
  }

  dispose(): void {
    this.watcher?.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.editTimers.forEach((t) => clearTimeout(t));
    this.onDidChangeEmitter.dispose();
    void this.store.flush();
  }

  // ---- 取り込みと監視 ----

  private async rescan(): Promise<void> {
    const generation = ++this.scanGeneration;
    this.config = readConfig();
    this.include = new GlobMatcher(this.config.include);
    this.exclude = new GlobMatcher(this.config.exclude);
    this.setupWatcher();

    const files = await vscode.workspace.findFiles(
      combineGlobs(this.config.include) ?? '**/*.md',
      combineGlobs(this.config.exclude) ?? null,
      this.config.maxFiles + 1,
    );
    if (generation !== this.scanGeneration) {
      return;
    }

    if (files.length > this.config.maxFiles) {
      // 上限を超えた：全件の取り込みはせず、開いたファイルだけを追跡する
      this.mode = 'degraded';
      this.fire(undefined, false);
      void vscode.window
        .showWarningMessage(
          `Markdown Unread Changes: Markdown ファイルが ${this.config.maxFiles} 件を超えたため、開いたファイルだけを追跡します。` +
            '設定の markdownUnreadChanges.include で追跡するフォルダを絞り込めます。',
          '設定を開く',
        )
        .then((choice) => {
          if (choice) {
            void vscode.commands.executeCommand('workbench.action.openSettings', 'markdownUnreadChanges');
          }
        });
      for (const doc of vscode.workspace.textDocuments) {
        await this.onDocumentOpened(doc);
      }
      return;
    }

    this.mode = 'scanning';
    this.progress = { done: 0, total: files.length };
    this.fire(undefined, false);

    const firstRun = !this.store.initialized;
    for (let i = 0; i < files.length; i += SCAN_CHUNK) {
      if (generation !== this.scanGeneration) {
        return;
      }
      await Promise.all(files.slice(i, i + SCAN_CHUNK).map((uri) => this.scanFile(uri, firstRun)));
      this.progress = { done: Math.min(i + SCAN_CHUNK, files.length), total: files.length };
      this.fire(undefined, false);
      // 他の処理を止めないよう、少しずつ進める
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // 対象から外れたファイルの記録を消す
    const present = new Set(files.map((u) => u.toString()));
    for (const key of this.store.keys()) {
      if (!present.has(key)) {
        await this.store.remove(key);
      }
    }
    this.store.initialized = true;
    this.mode = 'ready';
    this.fire(undefined, true);

    // 取り込み中に届いた変更通知を、取り込みの結果を前提に処理する
    const deferred = [...this.deferred.values()];
    this.deferred.clear();
    for (const uri of deferred) {
      void this.onDiskChanged(uri);
    }
  }

  /** 同じファイルの処理を 1 つずつ順に実行する */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const result = previous.then(fn);
    const done = result.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(key, done);
    this.running.add(done);
    void done.then(() => {
      this.running.delete(done);
      if (this.locks.get(key) === done) {
        this.locks.delete(key);
      }
    });
    return result;
  }

  /** 実行中の処理がすべて終わるまで待つ（テスト用） */
  async idle(): Promise<void> {
    while (this.running.size > 0 || this.editTimers.size > 0) {
      await Promise.all([...this.running]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  private setupWatcher(): void {
    this.watcher?.dispose();
    this.watcher = vscode.workspace.createFileSystemWatcher(combineGlobs(this.config.include) ?? '**/*.md');
    this.watcher.onDidCreate((uri) => void this.onDiskChanged(uri));
    this.watcher.onDidChange((uri) => void this.onDiskChanged(uri));
    this.watcher.onDidDelete((uri) => {
      const key = uri.toString();
      this.deferred.delete(key);
      void this.withLock(key, async () => {
        if (this.store.get(key)) {
          this.diffCache.delete(key);
          await this.store.remove(key);
          this.fire(key, false);
        }
      });
    });
  }

  /**
   * 起動時の確認。更新日時とサイズが変わったものだけ中身を比べる。
   * 未読と記録されているファイルは、記録が実際の内容と食い違っていないか毎回確かめ直す
   */
  private scanFile(uri: vscode.Uri, firstRun: boolean): Promise<void> {
    const key = uri.toString();
    return this.withLock(key, async () => {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > this.config.maxFileSizeBytes) {
          await this.store.remove(key);
          return;
        }
        const entry = this.store.get(key);
        if (entry && !entry.unread && entry.mtime === stat.mtime && entry.size === stat.size) {
          return;
        }
        const text = await this.readCurrentText(uri);
        if (!entry) {
          // 初回は「既読」として取り込む。2 回目以降に見つかった新しいファイルは、全体を追加として扱う
          const baseline = firstRun ? text : '';
          await this.store.writeSnapshot(key, baseline, { mtime: stat.mtime, size: stat.size, unread: false, count: 0 });
          if (!firstRun) {
            this.updateUnread(key, baseline, text);
          }
          return;
        }
        const snapshot = await this.store.readSnapshot(key);
        this.store.update(key, { mtime: stat.mtime, size: stat.size });
        this.updateUnread(key, snapshot ?? '', text);
        if (!this.store.get(key)?.unread) {
          this.store.evict(key);
        }
      } catch (err) {
        console.error('[markdown-unread-changes] scan failed', key, err);
      }
    });
  }

  private isTarget(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote') {
      return false;
    }
    if (!vscode.workspace.getWorkspaceFolder(uri)) {
      return false;
    }
    const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
    return this.include.matches(rel) && !this.exclude.matches(rel);
  }

  private onDiskChanged(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    if (!this.isTarget(uri)) {
      return Promise.resolve();
    }
    // 取り込み中は、まだ取り込んでいないファイルを「新しいファイル」と誤認しないよう、終わるまで待たせる
    if (this.mode === 'starting' || this.mode === 'scanning') {
      this.deferred.set(key, uri);
      return Promise.resolve();
    }
    return this.withLock(key, async () => {
      // 縮退中は、すでに追跡しているファイル（開いたことのあるファイル）だけを見る
      if (this.mode === 'degraded' && !this.store.get(key)) {
        return;
      }
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > this.config.maxFileSizeBytes) {
          await this.store.remove(key);
          this.fire(key, false);
          return;
        }
        const text = await this.readCurrentText(uri);
        if (!this.store.get(key)) {
          // 新しく作られたファイル：全体を追加として扱う
          await this.store.writeSnapshot(key, '', { mtime: stat.mtime, size: stat.size, unread: false, count: 0 });
        } else {
          this.store.update(key, { mtime: stat.mtime, size: stat.size });
        }
        const snapshot = (await this.store.readSnapshot(key)) ?? '';
        this.updateUnread(key, snapshot, text);
      } catch (err) {
        console.error('[markdown-unread-changes] check failed', key, err);
      }
    });
  }

  private async onDocumentOpened(doc: vscode.TextDocument): Promise<void> {
    if (doc.languageId !== 'markdown' || !this.isTarget(doc.uri)) {
      return;
    }
    const key = doc.uri.toString();
    if (this.store.get(key)) {
      await this.ensureSnapshotLoaded(key);
      return;
    }
    // 縮退中：初めて開いたファイルを「既読」として取り込む
    if (this.mode === 'degraded' && doc.getText().length <= this.config.maxFileSizeBytes) {
      await this.withLock(key, async () => {
        if (this.store.get(key)) {
          return;
        }
        try {
          const stat = await vscode.workspace.fs.stat(doc.uri);
          await this.store.writeSnapshot(key, doc.getText(), { mtime: stat.mtime, size: stat.size, unread: false, count: 0 });
          this.fire(key, false);
        } catch {
          // 保存されていないファイルなどは追跡しない
        }
      });
    }
  }

  /** エディタでの編集（未保存を含む）を反映する */
  private onDocumentEdited(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    if (!this.store.get(key)) {
      return;
    }
    const timer = this.editTimers.get(key);
    if (timer) {
      clearTimeout(timer);
    }
    this.editTimers.set(
      key,
      setTimeout(() => {
        this.editTimers.delete(key);
        void this.withLock(key, async () => {
          const snapshot = await this.store.readSnapshot(key);
          if (snapshot !== undefined && this.store.get(key)) {
            this.updateUnread(key, snapshot, doc.getText());
          }
        });
      }, 300),
    );
  }

  // ---- 差分と未読の状態 ----

  private updateUnread(key: string, snapshot: string, current: string): void {
    const summary = summarize(this.diff(key, snapshot, current));
    const before = this.store.get(key);
    const unread = summary.total > 0;
    if (before && (before.unread !== unread || before.count !== summary.total)) {
      this.store.update(key, { unread, count: summary.total });
      this.fire(key, false);
    }
  }

  private diff(key: string, oldText: string, newText: string): LineDiffResult {
    const hit = this.diffCache.get(key);
    if (hit && hit.oldText === oldText && hit.newText === newText) {
      return hit.result;
    }
    const result = computeLineDiff(oldText, newText);
    this.diffCache.set(key, { oldText, newText, result });
    return result;
  }

  /** プレビューの描画時に呼ばれる（同期）。スナップショットが未読み込みなら読み込んでから再描画する */
  getDiffForRender(uri: string): LineDiffResult | undefined {
    if (!this.store.get(uri)) {
      return undefined;
    }
    const snapshot = this.store.cached(uri);
    if (snapshot === undefined) {
      void this.ensureSnapshotLoaded(uri);
      return undefined;
    }
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
    if (!doc) {
      return undefined;
    }
    const result = this.diff(uri, snapshot, doc.getText());
    return result.groups.length > 0 ? result : undefined;
  }

  /** 表示中のファイルの変更箇所の数と内訳 */
  getSummary(uri: string): ChangeSummary | undefined {
    const entry = this.store.get(uri);
    if (!entry) {
      return undefined;
    }
    const snapshot = this.store.cached(uri);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
    if (snapshot === undefined || !doc) {
      if (snapshot === undefined) {
        void this.ensureSnapshotLoaded(uri);
      }
      return entry.unread ? { total: entry.count, modified: 0, added: 0, deleted: 0 } : undefined;
    }
    const summary = summarize(this.diff(uri, snapshot, doc.getText()));
    // 記録された未読の状態が、色付けと同じ比較の結果と食い違っていたら直す
    if (entry.unread !== summary.total > 0 || (entry.unread && entry.count !== summary.total)) {
      void this.withLock(uri, async () => {
        const current = this.store.cached(uri);
        if (current !== undefined && this.store.get(uri)) {
          this.updateUnread(uri, current, doc.getText());
        }
      });
    }
    return summary.total > 0 ? summary : undefined;
  }

  isTracked(uri: string): boolean {
    return this.store.get(uri) !== undefined;
  }

  /** 追跡しているファイルの URI 文字列 */
  trackedFiles(): string[] {
    return this.store.keys();
  }

  unreadFiles(): { uri: string; count: number }[] {
    return this.store
      .keys()
      .map((key) => ({ key, entry: this.store.get(key)! }))
      .filter(({ entry }) => entry.unread)
      .map(({ key, entry }) => ({ uri: key, count: entry.count }));
  }

  private async ensureSnapshotLoaded(key: string): Promise<void> {
    if (this.store.cached(key) !== undefined || this.loading.has(key)) {
      return;
    }
    this.loading.add(key);
    try {
      await this.store.readSnapshot(key);
    } finally {
      this.loading.delete(key);
    }
    this.fire(key, true);
  }

  // ---- 既読にする ----

  markRead(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    return this.withLock(key, async () => {
      if (!this.store.get(key)) {
        return;
      }
      const text = await this.readCurrentText(uri);
      const stat = await vscode.workspace.fs.stat(uri);
      await this.store.writeSnapshot(key, text, { mtime: stat.mtime, size: stat.size, unread: false, count: 0 });
      this.diffCache.delete(key);
      this.fire(key, true);
    });
  }

  async markAllRead(): Promise<void> {
    for (const { uri } of this.unreadFiles()) {
      try {
        await this.markRead(vscode.Uri.parse(uri));
      } catch (err) {
        console.error('[markdown-unread-changes] mark read failed', uri, err);
      }
    }
  }

  /** 開いていればエディタの内容（未保存を含む）、開いていなければディスクの内容 */
  private async readCurrentText(uri: vscode.Uri): Promise<string> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc) {
      return doc.getText();
    }
    return decoder.decode(await vscode.workspace.fs.readFile(uri));
  }

  private fire(uri: string | undefined, snapshotChanged: boolean): void {
    this.onDidChangeEmitter.fire({ uri, snapshotChanged });
  }
}
