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
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class SnapshotStore {
  private readonly root: vscode.Uri;
  private index: IndexFile = { version: 1, initialized: false, files: {} };
  /** 読み込んだスナップショットのキャッシュ（キーは URI 文字列） */
  private readonly cache = new Map<string, string>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

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
    const id = this.index.files[key]?.id ?? createHash('sha1').update(key).digest('hex');
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
    try {
      await vscode.workspace.fs.delete(this.snapshotUri(entry.id));
    } catch {
      // すでに無い場合は無視する
    }
  }

  /**
   * 記録を新しいキーに付け替える（ファイルの名前変更）。既読の状態とスナップショットを引き継ぐ。
   * スナップショットのファイル名はキーから決まるので、新しいキーの名前で保存し直す
   * （古いキーで後から別のファイルが作られたときに、ファイル名がぶつからないように）
   */
  async rename(oldKey: string, newKey: string): Promise<boolean> {
    const entry = this.index.files[oldKey];
    if (!entry || oldKey === newKey) {
      return false;
    }
    const text = await this.readSnapshot(oldKey);
    if (text === undefined) {
      await this.remove(oldKey);
      return false;
    }
    const { mtime, size, unread, count } = entry;
    await this.remove(newKey);
    await this.writeSnapshot(newKey, text, { mtime, size, unread, count });
    await this.remove(oldKey);
    return true;
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
