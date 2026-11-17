// ファイルの名前変更・移動で、既読の状態を引き継ぐか（vscode は test/fakes/vscode.mts の偽物に差し替えて動かす）。
// 通知の順番は、実機の VS Code 1.146 で観測したものに合わせている。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, Uri } from './fakes/vscode.mts';
import { SnapshotStore } from '../src/tracker/snapshotStore.ts';
import { Tracker } from '../src/tracker/tracker.ts';

const STORAGE = '/storage';
const DIR = '/ws/制限モード確認用';
const OLD = `${DIR}/sub-agent.md`;
const NEW = `${DIR}/sub-agent2.md`;
const CONTENT = '# サブエージェント\n\n- 調べものはサブエージェントに任せる\n- 結論だけを返してもらう\n';

beforeEach(() => fake.reset());

async function startTracker(): Promise<Tracker> {
  const store = new SnapshotStore(Uri.file(STORAGE) as never);
  await store.load();
  const tracker = new Tracker(store);
  await tracker.start();
  await tracker.idle();
  return tracker;
}

/** 終了して、記録（index.json）を保存する */
async function stop(tracker: Tracker): Promise<void> {
  tracker.dispose();
  await tracker.flush();
}

const key = (path: string) => Uri.file(path).toString();

function unreadPaths(tracker: Tracker): string[] {
  return tracker.unreadFiles().map((f) => f.uri);
}

test('VS Code の外での名前変更（実機と同じく「作成」が先に届く）で、既読の状態を引き継ぐ', async () => {
  fake.writeFile(OLD, CONTENT);
  fake.writeFile(`${DIR}/mcp-basics.md`, '# MCP\n');
  const tracker = await startTracker();

  // Windows のエクスプローラーなどで名前を変えたときに、実機で届いた通知の順番
  fake.moveFile(OLD, NEW);
  fake.fireCreate(NEW);
  fake.fireCreate(NEW);
  fake.fireDelete(OLD);
  fake.fireChange(NEW);
  fake.fireDelete(OLD);
  await tracker.idle();

  assert.deepEqual(unreadPaths(tracker), []);
  assert.ok(tracker.isTracked(key(NEW)));
  assert.ok(!tracker.isTracked(key(OLD)));
  tracker.dispose();
});

test('VS Code の外での名前変更で「削除」が先に届いても、既読の状態を引き継ぐ', async () => {
  fake.writeFile(OLD, CONTENT);
  const tracker = await startTracker();

  fake.moveFile(OLD, NEW);
  fake.fireDelete(OLD);
  await tracker.idle();
  fake.fireCreate(NEW);
  await tracker.idle();

  assert.deepEqual(unreadPaths(tracker), []);
  assert.deepEqual(tracker.trackedFiles(), [key(NEW)]);
  tracker.dispose();
});

test('未読のファイルの名前を VS Code の外で変えても、未読と既読時点の内容を引き継ぐ', async () => {
  fake.writeFile(OLD, CONTENT);
  const tracker = await startTracker();
  // 離れた 2 か所を変える（全体が追加になると 1 件と数えるので、区別できる）
  fake.writeFile(OLD, CONTENT.replace('# サブエージェント', '# サブエージェントの使い方') + '\n- 追加した行\n');
  fake.fireChange(OLD);
  await tracker.idle();
  assert.deepEqual(tracker.unreadFiles(), [{ uri: key(OLD), count: 2 }]);

  fake.moveFile(OLD, NEW);
  fake.fireCreate(NEW);
  fake.fireDelete(OLD);
  await tracker.idle();

  // 全体が追加（緑・1 件）ではなく、変えた 2 か所が変更として残る
  assert.deepEqual(tracker.unreadFiles(), [{ uri: key(NEW), count: 2 }]);
  tracker.dispose();
});

test('フォルダを VS Code の外で移動しても、中のファイルの既読の状態を引き継ぐ', async () => {
  fake.writeFile(`${DIR}/a.md`, '# A\n');
  fake.writeFile(`${DIR}/b.md`, '# B\n\n本文\n');
  const tracker = await startTracker();

  fake.moveFile(DIR, '/ws/moved');
  fake.fireCreate('/ws/moved/a.md');
  fake.fireCreate('/ws/moved/b.md');
  fake.fireDelete(DIR);
  await tracker.idle();

  assert.deepEqual(unreadPaths(tracker), []);
  assert.deepEqual(tracker.trackedFiles().sort(), [key('/ws/moved/a.md'), key('/ws/moved/b.md')]);
  tracker.dispose();
});

test('VS Code を閉じている間に名前を変えたファイルも、次の起動で既読の状態を引き継ぐ', async () => {
  fake.writeFile(OLD, CONTENT);
  await stop(await startTracker());

  fake.moveFile(OLD, NEW);
  const tracker = await startTracker();

  assert.deepEqual(unreadPaths(tracker), []);
  assert.deepEqual(tracker.trackedFiles(), [key(NEW)]);
  tracker.dispose();
});

test('VS Code の中での名前変更（実機で観測した通知の順番）で、既読の状態を引き継ぐ', async () => {
  fake.writeFile(OLD, CONTENT);
  const tracker = await startTracker();
  const files = [{ oldUri: Uri.file(OLD), newUri: Uri.file(NEW) }];

  fake.willRename.fire({ files });
  fake.moveFile(OLD, NEW);
  fake.didRename.fire({ files });
  fake.fireCreate(NEW);
  fake.fireDelete(OLD);
  fake.fireCreate(NEW);
  fake.fireChange(NEW);
  fake.fireDelete(OLD);
  await tracker.idle();

  assert.deepEqual(unreadPaths(tracker), []);
  assert.deepEqual(tracker.trackedFiles(), [key(NEW)]);
  tracker.dispose();
});

test('コピー（元のファイルが残っている）は名前変更とみなさず、新しいファイルとして扱う', async () => {
  fake.writeFile(OLD, CONTENT);
  const tracker = await startTracker();

  // コピーでは更新日時もサイズも同じになることがある
  fake.files.set(NEW, fake.files.get(OLD)!);
  fake.fireCreate(NEW);
  await tracker.idle();

  assert.deepEqual(unreadPaths(tracker), [key(NEW)]);
  assert.ok(tracker.isTracked(key(OLD)));
  tracker.dispose();
});

test('更新日時かサイズが違うファイルは、消えたファイルの名前変更とみなさない', async () => {
  fake.writeFile(OLD, CONTENT);
  const tracker = await startTracker();

  fake.files.delete(OLD);
  fake.writeFile(NEW, CONTENT);
  fake.fireCreate(NEW);
  fake.fireDelete(OLD);
  await tracker.idle();

  assert.deepEqual(unreadPaths(tracker), [key(NEW)]);
  tracker.dispose();
});
