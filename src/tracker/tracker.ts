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
/** 名前変更の予定（onWillRenameFiles）を、完了の通知が来ないときに捨てるまでの時間 */
const RENAME_TIMEOUT_MS = 30_000;
const decoder = new TextDecoder();

/** 追跡するファイルの scheme（仮想ワークスペースのファイルなどは扱わない） */
function isSupportedScheme(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' || uri.scheme === 'vscode-remote';
}

/** key そのもの、または key のフォルダの下にあるか（URI 文字列で比べる） */
function isSameOrUnder(key: string, folderKey: string): boolean {
  return key === folderKey || key.startsWith(folderKey.endsWith('/') ? folderKey : folderKey + '/');
}

function isNotFound(err: unknown): boolean {
  return err instanceof vscode.FileSystemError && err.code === 'FileNotFound';
}

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
  /**
   * VS Code の中で行う名前変更の予定（新しい URI 文字列 → 古い URI 文字列）。
   * 名前変更は「削除＋作成」の通知としても届くため、完了（onDidRenameFiles）までは両方の通知を無視し、
   * 完了したら記録を新しい名前に付け替える
   */
  private readonly pendingRenames = new Map<string, string>();
  /** 前回警告した、使えない glob（同じ警告を繰り返さないため） */
  private warnedInvalidGlobs = '';

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
        // 閉じたファイルの全文はメモリに持たない（未読でも、次に表示するときに読み込み直す）
        const key = doc.uri.toString();
        this.diffCache.delete(key);
        this.store.evict(key);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('markdownUnreadChanges') || e.affectsConfiguration('files.exclude')) {
          void this.rescan(true);
        }
      }),
      // 制限モードを解除したら、フォルダ側の設定を反映して取り込み直す
      vscode.workspace.onDidGrantWorkspaceTrust(() => void this.rescan(true)),
      vscode.workspace.onWillRenameFiles((e) => this.onWillRename(e.files)),
      vscode.workspace.onDidRenameFiles((e) => void this.onDidRename(e.files)),
    );
    await this.rescan(false);
  }

  dispose(): void {
    this.watcher?.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.editTimers.forEach((t) => clearTimeout(t));
    this.onDidChangeEmitter.dispose();
    this.store.dispose();
    void this.store.flush();
  }

  /** 未保存の記録（index.json）をすぐに保存する。終了時に呼ぶ */
  flush(): Promise<void> {
    return this.store.flush();
  }

  // ---- 取り込みと監視 ----

  /**
   * ワークスペース全体を取り込み直す。
   * newFilesAsRead：新しく見つかったファイルを「既読」として取り込むか。
   * 設定の変更や信頼で対象が広がったときは true（前からあったファイルを全部未読にしないため）。
   * 起動時は false（閉じている間に作られたファイルは、全体を追加として扱う）
   */
  private async rescan(newFilesAsRead: boolean): Promise<void> {
    try {
      await this.rescanUnsafe(newFilesAsRead);
    } catch (err) {
      console.error('[markdown-unread-changes] rescan failed', err);
      if (this.mode === 'starting' || this.mode === 'scanning') {
        this.mode = 'ready';
        this.fire(undefined, false);
      }
    }
  }

  private async rescanUnsafe(newFilesAsRead: boolean): Promise<void> {
    const generation = ++this.scanGeneration;
    this.config = readConfig();
    this.include = new GlobMatcher(this.config.include);
    this.exclude = new GlobMatcher(this.config.exclude);
    this.warnInvalidGlobs();
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

    const asRead = newFilesAsRead || !this.store.initialized;
    for (let i = 0; i < files.length; i += SCAN_CHUNK) {
      if (generation !== this.scanGeneration) {
        return;
      }
      await Promise.all(files.slice(i, i + SCAN_CHUNK).map((uri) => this.scanFile(uri, asRead)));
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
    this.watcher.onDidDelete((uri) => this.onDiskDeleted(uri));
  }

  /** 使えない glob が設定されていたら警告する（同じ内容では繰り返さない） */
  private warnInvalidGlobs(): void {
    const invalid = this.config.invalidGlobs.join(', ');
    if (invalid === this.warnedInvalidGlobs) {
      return;
    }
    this.warnedInvalidGlobs = invalid;
    if (invalid) {
      void vscode.window.showWarningMessage(
        `Markdown Unread Changes: 次の glob パターンは書き方に誤りがあるため無視しました：${invalid}`,
      );
    }
  }

  /**
   * 削除の通知。フォルダを消したときは、フォルダの URI 1 件だけで届くことがあるため、
   * その下にあるファイルの記録もまとめて消す
   */
  private onDiskDeleted(uri: vscode.Uri): void {
    const folderKey = uri.toString();
    const keys = new Set([folderKey, ...this.store.keys().filter((k) => isSameOrUnder(k, folderKey))]);
    for (const key of keys) {
      this.deferred.delete(key);
      // VS Code の中での名前変更なら、完了の通知で付け替えるので消さない
      if ([...this.pendingRenames.values()].includes(key)) {
        continue;
      }
      void this.withLock(key, async () => {
        if (this.store.get(key)) {
          await this.forget(key);
        }
      });
    }
  }

  /**
   * ファイルの記録を外す（ファイルが消えた、対象外になったなど）。
   * VS Code の外での名前変更に備えて、記録はしばらく「削除された記録」として残る
   */
  private async forget(key: string): Promise<void> {
    this.diffCache.delete(key);
    this.store.detach(key);
    this.fire(key, false);
  }

  /**
   * 新しく見つかったファイルが、消えたファイルを VS Code の外で名前変更・移動したものなら、記録を引き継ぐ。
   * VS Code の外での名前変更（Windows のエクスプローラー、Git、別のウィンドウなど）は onWillRenameFiles が届かず、
   * ファイル監視の「作成」と「削除」だけが届く。順番も決まっておらず、実機では「作成」が先に届く。
   * 名前変更では更新日時とサイズが変わらないので、次のどちらかを同じファイルとみなす。
   * - 同じ場所の、削除されてから期限内の記録（削除して作り直す保存のしかた）
   * - 更新日時とサイズが一致し、元のファイルがもう無い記録（今の記録、または削除されてから期限内の記録）。候補が 1 つのときだけ
   */
  private async adoptMovedRecord(key: string, uri: vscode.Uri, stat: vscode.FileStat): Promise<boolean> {
    let from: string | undefined;
    if (this.store.removedRecords().some((r) => r.key === key)) {
      from = key;
    } else {
      const same = (e: { mtime: number; size: number }) => e.mtime === stat.mtime && e.size === stat.size;
      const candidates = this.store
        .removedRecords()
        .filter((r) => same(r.entry))
        .map((r) => r.key);
      for (const k of this.store.keys()) {
        const e = this.store.get(k);
        if (k !== key && e && same(e) && (await this.isMissing(vscode.Uri.parse(k)))) {
          candidates.push(k);
        }
      }
      if (candidates.length !== 1) {
        return false;
      }
      from = candidates[0];
    }
    const entry = this.store.get(from) ?? this.store.removedRecords().find((r) => r.key === from)?.entry;
    // スナップショットが読めないとき：既読で、更新日時とサイズが同じなら、今の内容が既読時点の内容
    const fallback = async () =>
      entry && !entry.unread && entry.mtime === stat.mtime && entry.size === stat.size ? this.readCurrentText(uri) : undefined;
    if (!(await this.store.moveRecord(from, key, fallback))) {
      return false;
    }
    this.diffCache.delete(from);
    if (from !== key) {
      this.fire(from, false);
    }
    this.fire(key, true);
    return true;
  }

  private async isMissing(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return false;
    } catch (err) {
      return isNotFound(err);
    }
  }

  /** VS Code の中での名前変更の予定を覚える（フォルダの名前変更なら、その下のファイルもすべて） */
  private onWillRename(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): void {
    const planned: string[] = [];
    for (const { oldUri, newUri } of files) {
      const oldFolder = oldUri.toString();
      const newFolder = newUri.toString();
      for (const key of this.store.keys()) {
        if (isSameOrUnder(key, oldFolder)) {
          const newKey = newFolder + key.slice(oldFolder.length);
          this.pendingRenames.set(newKey, key);
          planned.push(newKey);
        }
      }
    }
    if (planned.length > 0) {
      // 名前変更が失敗すると完了の通知が来ないので、しばらくしたら予定を捨てる
      setTimeout(() => {
        for (const newKey of planned) {
          this.pendingRenames.delete(newKey);
        }
      }, RENAME_TIMEOUT_MS).unref?.();
    }
  }

  /** 名前変更の完了。既読の状態とスナップショットを新しい名前に付け替える */
  private async onDidRename(files: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): Promise<void> {
    for (const { newUri } of files) {
      const newFolder = newUri.toString();
      const moves = [...this.pendingRenames].filter(([newKey]) => isSameOrUnder(newKey, newFolder));
      for (const [newKey, oldKey] of moves) {
        this.pendingRenames.delete(newKey);
        const target = vscode.Uri.parse(newKey);
        await this.withLock(oldKey, () =>
          this.withLock(newKey, async () => {
            try {
              if (!this.isTarget(target)) {
                // 対象外の名前（拡張子の変更や除外したフォルダへの移動）になった
                if (this.store.get(oldKey)) {
                  await this.forget(oldKey);
                }
                return;
              }
              this.diffCache.delete(oldKey);
              this.diffCache.delete(newKey);
              // スナップショットが読めないとき：既読で、更新日時とサイズが変わっていなければ、今の内容が既読時点の内容
              const entry = this.store.get(oldKey);
              const fallback = async () => {
                const stat = await vscode.workspace.fs.stat(target);
                return entry && !entry.unread && stat.mtime === entry.mtime && stat.size === entry.size
                  ? this.readCurrentText(target)
                  : undefined;
              };
              await this.store.moveRecord(oldKey, newKey, fallback);
              this.fire(oldKey, false);
              this.fire(newKey, true);
            } catch (err) {
              console.error('[markdown-unread-changes] rename failed', oldKey, newKey, err);
            }
          }),
        );
        // 名前変更と同時に内容が変わっていないか確かめる
        await this.onDiskChanged(target);
      }
    }
  }

  /**
   * 起動時の確認。更新日時とサイズが変わったものだけ中身を比べる。
   * 未読と記録されているファイルは、記録が実際の内容と食い違っていないか毎回確かめ直す。
   * newFileAsRead：記録のないファイルを「既読」として取り込むか（false なら全体を追加として扱う）
   */
  private scanFile(uri: vscode.Uri, newFileAsRead: boolean): Promise<void> {
    const key = uri.toString();
    return this.withLock(key, async () => {
      if (!isSupportedScheme(uri)) {
        return;
      }
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > this.config.maxFileSizeBytes) {
          await this.store.remove(key);
          return;
        }
        let entry = this.store.get(key);
        // 閉じている間に VS Code の外で名前を変えた・移動したファイルなら、記録を引き継ぐ
        if (!entry && !newFileAsRead && (await this.adoptMovedRecord(key, uri, stat))) {
          entry = this.store.get(key);
        }
        if (entry && !entry.unread && entry.mtime === stat.mtime && entry.size === stat.size) {
          this.evictIfClosed(key);
          return;
        }
        const text = await this.readCurrentText(uri);
        if (!entry) {
          // 初回や対象が広がったときは「既読」として取り込む。起動時に見つかった新しいファイルは、全体を追加として扱う
          const baseline = newFileAsRead ? text : '';
          await this.store.writeSnapshot(key, baseline, { mtime: stat.mtime, size: stat.size, unread: false, count: 0 });
          if (!newFileAsRead) {
            this.updateUnread(key, baseline, text);
          }
          this.evictIfClosed(key);
          return;
        }
        const snapshot = await this.store.readSnapshot(key);
        this.store.update(key, { mtime: stat.mtime, size: stat.size });
        this.updateUnread(key, snapshot ?? '', text);
        this.evictIfClosed(key);
      } catch (err) {
        if (isNotFound(err)) {
          // 検索の結果に入っていたが、取り込むまでに消えた。削除の通知の処理と順番が前後しても記録を残さない
          if (this.store.get(key)) {
            await this.forget(key);
          }
          return;
        }
        console.error('[markdown-unread-changes] scan failed', key, err);
      }
    });
  }

  private isTarget(uri: vscode.Uri): boolean {
    if (!isSupportedScheme(uri)) {
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
    // VS Code の中での名前変更の途中なら、完了の通知で付け替えてから確かめる
    if (!this.isTarget(uri) || this.pendingRenames.has(key)) {
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
        // VS Code の外で名前を変えた・移動したファイルなら、記録を引き継ぐ
        if (!this.store.get(key)) {
          await this.adoptMovedRecord(key, uri, stat);
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
        this.evictIfClosed(key);
      } catch (err) {
        if (isNotFound(err)) {
          // 通知のあとに消えた
          if (this.store.get(key)) {
            await this.forget(key);
          }
          return;
        }
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

  /**
   * 差分を計算する。結果をキャッシュするのは、エディタで開いているファイルだけ
   * （プレビューやステータスバーで繰り返し使う。開いていないファイルの全文をメモリに持ち続けないため）
   */
  private diff(key: string, oldText: string, newText: string): LineDiffResult {
    const hit = this.diffCache.get(key);
    if (hit && hit.oldText === oldText && hit.newText === newText) {
      return hit.result;
    }
    const result = computeLineDiff(oldText, newText);
    if (this.isOpen(key)) {
      this.diffCache.set(key, { oldText, newText, result });
    } else {
      this.diffCache.delete(key);
    }
    return result;
  }

  private isOpen(key: string): boolean {
    return vscode.workspace.textDocuments.some((d) => d.uri.toString() === key);
  }

  /** 開いていないファイルのスナップショットをメモリから外す */
  private evictIfClosed(key: string): void {
    if (!this.isOpen(key)) {
      this.store.evict(key);
    }
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
      let text: string;
      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(uri);
        text = await this.readCurrentText(uri);
      } catch (err) {
        if (isNotFound(err)) {
          // ファイルがもう無い：記録を消して未読一覧から外す
          await this.forget(key);
          return;
        }
        throw err;
      }
      await this.store.writeSnapshot(key, text, { mtime: stat.mtime, size: stat.size, unread: false, count: 0 });
      this.diffCache.delete(key);
      this.evictIfClosed(key);
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
