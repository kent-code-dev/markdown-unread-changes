// 既読にした時点の本文（スナップショット）を context.storageUri に保存する。
// 1 ファイルにつき 1 つのファイルとして保存し、必要になったときだけ読み込む。
import * as vscode from 'vscode';
import { createHash } from 'node:crypto';

export interface IndexEntry {
  /** スナップショットのファイル名に使う ID */
  id: string;
  /** 最後に確認したときのディスク上の更新日時とサイズ（起動時の変更検知に使う） */
  mtime: number;
  size: number;
  unread: boolean;
  /** 変更箇所の数（未読ファイルの一覧に表示する） */
  count: number;
}

interface IndexFile {
  version: 1;
  /** 初回の取り込みが終わっているか */
  initialized: boolean;
  files: Record<string, IndexEntry>;
}

const INDEX_FILE = 'index.json';
const SNAPSHOT_DIR = 'snapshots';
/**
 * 削除されたファイルの記録を、スナップショットのファイルごと残しておく時間。
 * VS Code の外での名前変更は「削除＋作成」として届くため、この間に作られたファイルが
 * 消えたファイルと同じものなら、記録を引き継ぐ
 */
export const REMOVED_RECORD_TTL_MS = 30_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** スナップショットのファイル名に使う ID（キーから決まる） */
function idOf(key: string): string {
  return createHash('sha1').update(key).digest('hex');
}

export class SnapshotStore {
  private readonly root: vscode.Uri;
  private index: IndexFile = { version: 1, initialized: false, files: {} };
  /** 読み込んだスナップショットのキャッシュ（キーは URI 文字列） */
  private readonly cache = new Map<string, string>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** 削除されたファイルの記録（キーは元の URI 文字列）。期限が来たらスナップショットのファイルを消す */
  private readonly removed = new Map<string, { entry: IndexEntry; timer: ReturnType<typeof setTimeout> }>();

  constructor(root: vscode.Uri) {
    this.root = root;
  }

  async load(): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.root, SNAPSHOT_DIR));
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.root, INDEX_FILE));
      const parsed = JSON.parse(decoder.decode(bytes)) as IndexFile;
      if (parsed.version === 1 && parsed.files) {
        this.index = parsed;
      }
    } catch {
      // 初回起動、または壊れている場合は空から始める
    }
    await this.removeOrphans();
  }

  /** どの記録からも使われていないスナップショットのファイルを消す（削除された記録を残したまま終了した場合など） */
  private async removeOrphans(): Promise<void> {
    try {
      const used = new Set(Object.values(this.index.files).map((e) => `${e.id}.md`));
      const dir = vscode.Uri.joinPath(this.root, SNAPSHOT_DIR);
      for (const [name] of await vscode.workspace.fs.readDirectory(dir)) {
        if (name.endsWith('.md') && !used.has(name)) {
          await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, name));
        }
      }
    } catch {
      // 掃除できなくても動作には影響しない
    }
  }

  dispose(): void {
    this.removed.forEach((r) => clearTimeout(r.timer));
    this.removed.clear();
  }

  get initialized(): boolean {
    return this.index.initialized;
  }

  set initialized(value: boolean) {
    this.index.initialized = value;
    this.scheduleSave();
  }

  keys(): string[] {
    return Object.keys(this.index.files);
  }

  get(key: string): IndexEntry | undefined {
    return this.index.files[key];
  }

  update(key: string, patch: Partial<Omit<IndexEntry, 'id'>>): void {
    const entry = this.index.files[key];
    if (entry) {
      Object.assign(entry, patch);
      this.scheduleSave();
    }
  }

  /** メモリにあるスナップショット（なければ undefined。読み込みは readSnapshot で行う） */
  cached(key: string): string | undefined {
    return this.cache.get(key);
  }

  async readSnapshot(key: string): Promise<string | undefined> {
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const entry = this.index.files[key];
    if (!entry) {
      return undefined;
    }
    try {
      const text = decoder.decode(await vscode.workspace.fs.readFile(this.snapshotUri(entry.id)));
      this.cache.set(key, text);
      return text;
    } catch {
      return undefined;
    }
  }

  async writeSnapshot(key: string, text: string, state: Omit<IndexEntry, 'id'>): Promise<void> {
    // 同じキーの削除された記録が残っていれば捨てる（スナップショットは同じファイル名に上書きされる）
    this.dropRemoved(key);
    const id = this.index.files[key]?.id ?? idOf(key);
    await vscode.workspace.fs.writeFile(this.snapshotUri(id), encoder.encode(text));
    this.cache.set(key, text);
    this.index.files[key] = { id, ...state };
    this.scheduleSave();
  }

  async remove(key: string): Promise<void> {
    const entry = this.index.files[key];
    if (!entry) {
      return;
    }
    delete this.index.files[key];
    this.cache.delete(key);
    this.scheduleSave();
    await this.deleteSnapshotFile(entry.id);
  }

  /**
   * ファイルが削除されたときに記録を外す。スナップショットのファイルはしばらく残し、
   * その間に同じファイルが別の名前で見つかれば moveRecord で引き継げるようにする
   */
  detach(key: string): void {
    const entry = this.index.files[key];
    if (!entry) {
      return;
    }
    delete this.index.files[key];
    this.cache.delete(key);
    this.scheduleSave();
    this.dropRemoved(key);
    const timer = setTimeout(() => {
      if (this.removed.get(key)?.entry === entry) {
        this.removed.delete(key);
        void this.deleteSnapshotFile(entry.id);
      }
    }, REMOVED_RECORD_TTL_MS);
    (timer as { unref?: () => void }).unref?.();
    this.removed.set(key, { entry, timer });
  }

  /** 削除されてから期限内の記録 */
  removedRecords(): { key: string; entry: IndexEntry }[] {
    return [...this.removed].map(([key, r]) => ({ key, entry: r.entry }));
  }

  /**
   * 記録を別のキーに付け替える（ファイルの名前変更）。既読の状態とスナップショットを引き継ぐ。
   * fromKey は、今の記録か、削除されてから期限内の記録のキー。
   * fallback：スナップショットのファイルが読めないときに、代わりに使う本文を返す（undefined なら付け替えない）。
   * スナップショットのファイル名はキーから決まるので、新しいキーの名前で保存し直す
   * （古いキーで後から別のファイルが作られたときに、ファイル名がぶつからないように）
   */
  async moveRecord(
    fromKey: string,
    toKey: string,
    fallback?: () => Promise<string | undefined>,
  ): Promise<boolean> {
    const live = this.index.files[fromKey];
    const entry = live ?? this.removed.get(fromKey)?.entry;
    if (!entry) {
      return false;
    }
    if (fromKey === toKey) {
      // 同じ場所に作り直された：削除された記録を戻す
      if (!live) {
        this.dropRemoved(fromKey);
        this.index.files[toKey] = entry;
        this.scheduleSave();
      }
      return true;
    }
    // ほかの処理から古いキーの記録が見えないよう、先に外す
    const cached = this.cache.get(fromKey);
    delete this.index.files[fromKey];
    this.cache.delete(fromKey);
    this.dropRemoved(fromKey);
    this.scheduleSave();

    let text = cached;
    if (text === undefined) {
      try {
        text = decoder.decode(await vscode.workspace.fs.readFile(this.snapshotUri(entry.id)));
      } catch {
        text = await fallback?.().catch(() => undefined);
      }
    }
    if (text === undefined) {
      await this.deleteSnapshotFile(entry.id);
      return false;
    }
    const { mtime, size, unread, count } = entry;
    await this.remove(toKey);
    await this.writeSnapshot(toKey, text, { mtime, size, unread, count });
    if (this.index.files[toKey]?.id !== entry.id) {
      await this.deleteSnapshotFile(entry.id);
    }
    return true;
  }

  private dropRemoved(key: string): void {
    const r = this.removed.get(key);
    if (r) {
      clearTimeout(r.timer);
      this.removed.delete(key);
    }
  }

  /** スナップショットのファイルを消す（ほかの記録が同じファイルを使っていれば消さない） */
  private async deleteSnapshotFile(id: string): Promise<void> {
    const used =
      Object.values(this.index.files).some((e) => e.id === id) || [...this.removed.values()].some((r) => r.entry.id === id);
    if (used) {
      return;
    }
    try {
      await vscode.workspace.fs.delete(this.snapshotUri(id));
    } catch {
      // すでに無い場合は無視する
    }
  }

  /** 開いていないファイルのスナップショットをメモリから外す */
  evict(key: string): void {
    this.cache.delete(key);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(this.root, INDEX_FILE),
      encoder.encode(JSON.stringify(this.index)),
    );
  }

  private scheduleSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flush();
    }, 500);
  }

  private snapshotUri(id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.root, SNAPSHOT_DIR, `${id}.md`);
  }
}
