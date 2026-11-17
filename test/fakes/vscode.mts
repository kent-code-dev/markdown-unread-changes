// テスト用の最小限の vscode モジュール。Tracker と SnapshotStore が使う API だけを、メモリ上で模倣する。
// test/setup/register.mjs で、'vscode' の import をこのファイルに差し替える。

type Listener<T> = (e: T) => unknown;

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];
  event = (listener: Listener<T>) => {
    this.listeners.push(listener);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
  };
  fire(e: T): void {
    this.listeners.forEach((l) => l(e));
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class Uri {
  readonly scheme: string;
  readonly path: string;
  private constructor(scheme: string, path: string) {
    this.scheme = scheme;
    this.path = path;
  }
  static file(path: string): Uri {
    return new Uri('file', path);
  }
  static parse(value: string): Uri {
    const m = /^([a-z-]+):\/\/(.*)$/.exec(value);
    return m ? new Uri(m[1], m[2]) : new Uri('file', value);
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri(base.scheme, [base.path.replace(/\/$/, ''), ...parts].join('/'));
  }
  get fsPath(): string {
    return this.path;
  }
  toString(): string {
    return `${this.scheme}://${this.path}`;
  }
}

export class FileSystemError extends Error {
  readonly code = 'FileNotFound';
}

export const StatusBarAlignment = { Left: 1, Right: 2 };
export class TabInputWebview {
  viewType = '';
}

// ---- テストから操作するための状態 ----

interface FakeFile {
  data: Uint8Array;
  mtime: number;
}

const enc = new TextEncoder();
let clock = 1_000;

export const fake = {
  files: new Map<string, FakeFile>(),
  /** パスごとに readFile を待たせるための関門（テストで競合を再現する） */
  readGates: new Map<string, Promise<void>>(),
  workspaceRoot: '/ws',
  watchers: [] as FakeWatcher[],
  textDocuments: [] as { uri: Uri; languageId: string; getText(): string }[],
  /** フォルダ側（ワークスペース）の設定。キーは「セクション.名前」 */
  config: {} as Record<string, unknown>,
  /** ユーザー設定。キーは「セクション.名前」 */
  userConfig: {} as Record<string, unknown>,
  /** ワークスペースを信頼しているか（false なら制限モード） */
  trusted: true,

  reset(): void {
    this.files.clear();
    this.readGates.clear();
    this.watchers = [];
    this.textDocuments = [];
    this.config = {};
    this.userConfig = {};
    this.trusted = true;
    this.willRename = new EventEmitter();
    this.didRename = new EventEmitter();
  },
  writeFile(path: string, text: string): void {
    this.files.set(path, { data: enc.encode(text), mtime: ++clock });
  },
  /** ファイル監視の変更通知を送る（内容が変わっていなくても届くことがある） */
  fireChange(path: string): void {
    this.watchers.forEach((w) => w.change.fire(Uri.file(path)));
  },
  fireCreate(path: string): void {
    this.watchers.forEach((w) => w.create.fire(Uri.file(path)));
  },
  fireDelete(path: string): void {
    this.watchers.forEach((w) => w.del.fire(Uri.file(path)));
  },
  /** ファイルやフォルダの名前を変える（実際の名前変更と同じく、更新日時は変えない）。通知は送らない */
  moveFile(oldPath: string, newPath: string): void {
    for (const [path, file] of [...this.files]) {
      if (path === oldPath || path.startsWith(oldPath + '/')) {
        this.files.delete(path);
        this.files.set(newPath + path.slice(oldPath.length), file);
      }
    }
  },
  /** VS Code の中での名前変更の通知（onWillRenameFiles / onDidRenameFiles） */
  willRename: new EventEmitter<{ files: { oldUri: Uri; newUri: Uri }[] }>(),
  didRename: new EventEmitter<{ files: { oldUri: Uri; newUri: Uri }[] }>(),
};

class FakeWatcher {
  readonly create = new EventEmitter<Uri>();
  readonly change = new EventEmitter<Uri>();
  readonly del = new EventEmitter<Uri>();
  onDidCreate = this.create.event;
  onDidChange = this.change.event;
  onDidDelete = this.del.event;
  dispose(): void {
    fake.watchers = fake.watchers.filter((w) => w !== this);
  }
}

function notFound(path: string): never {
  throw new FileSystemError(`not found: ${path}`);
}

const noopEvent = () => ({ dispose() {} });

export const workspace = {
  fs: {
    async stat(uri: Uri) {
      const f = fake.files.get(uri.path) ?? notFound(uri.path);
      return { type: 1, ctime: f.mtime, mtime: f.mtime, size: f.data.length };
    },
    async readFile(uri: Uri) {
      const gate = fake.readGates.get(uri.path);
      if (gate) {
        await gate;
      }
      const f = fake.files.get(uri.path) ?? notFound(uri.path);
      return f.data;
    },
    async writeFile(uri: Uri, data: Uint8Array) {
      fake.files.set(uri.path, { data, mtime: ++clock });
    },
    async createDirectory() {},
    async readDirectory(uri: Uri) {
      const prefix = uri.path.replace(/\/$/, '') + '/';
      return [...fake.files.keys()]
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map((p) => [p.slice(prefix.length), 1] as [string, number]);
    },
    async delete(uri: Uri) {
      fake.files.delete(uri.path);
    },
  },
  get textDocuments() {
    return fake.textDocuments;
  },
  async findFiles() {
    return [...fake.files.keys()]
      .filter((p) => p.startsWith(fake.workspaceRoot + '/') && p.endsWith('.md'))
      .sort()
      .map((p) => Uri.file(p));
  },
  createFileSystemWatcher() {
    const w = new FakeWatcher();
    fake.watchers.push(w);
    return w;
  },
  get isTrusted() {
    return fake.trusted;
  },
  // 実際の VS Code と同じく、get はフォルダ側の値を優先する（制限モードでの無視は拡張側で行う）
  getConfiguration(section: string) {
    const full = (key: string) => `${section}.${key}`;
    return {
      get<T>(key: string, defaultValue?: T): T {
        const k = full(key);
        return (k in fake.config ? fake.config[k] : k in fake.userConfig ? fake.userConfig[k] : defaultValue) as T;
      },
      inspect<T>(key: string) {
        const k = full(key);
        return {
          key: k,
          globalValue: fake.userConfig[k] as T | undefined,
          workspaceValue: fake.config[k] as T | undefined,
        };
      },
    };
  },
  getWorkspaceFolder(uri: Uri) {
    return uri.path.startsWith(fake.workspaceRoot + '/') ? { uri: Uri.file(fake.workspaceRoot) } : undefined;
  },
  asRelativePath(uri: Uri | string) {
    const path = typeof uri === 'string' ? uri : uri.path;
    return path.startsWith(fake.workspaceRoot + '/') ? path.slice(fake.workspaceRoot.length + 1) : path;
  },
  onDidChangeTextDocument: noopEvent,
  onDidOpenTextDocument: noopEvent,
  onDidCloseTextDocument: noopEvent,
  onDidChangeConfiguration: noopEvent,
  onDidGrantWorkspaceTrust: noopEvent,
  onWillRenameFiles(listener: (e: { files: { oldUri: Uri; newUri: Uri }[] }) => unknown) {
    return fake.willRename.event(listener);
  },
  onDidRenameFiles(listener: (e: { files: { oldUri: Uri; newUri: Uri }[] }) => unknown) {
    return fake.didRename.event(listener);
  },
};

export const window = {
  async showWarningMessage() {
    return undefined;
  },
};

export const commands = {
  async executeCommand() {
    return undefined;
  },
};
