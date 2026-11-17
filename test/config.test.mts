// 設定の読み込み。制限モード（信頼していないフォルダ）では、フォルダ側の設定を無視する
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, Uri } from './fakes/vscode.mts';
import { pickSetting, readConfig } from '../src/config.ts';
import { readOpenTarget } from '../src/ui/openFile.ts';
import { SnapshotStore } from '../src/tracker/snapshotStore.ts';
import { Tracker } from '../src/tracker/tracker.ts';

beforeEach(() => fake.reset());

test('pickSetting：信頼済みならフォルダ > ワークスペース > ユーザー > 初期値の順', () => {
  const all = { defaultValue: 1, globalValue: 2, workspaceValue: 3, workspaceFolderValue: 4 };
  assert.equal(pickSetting(all, true, 0), 4);
  assert.equal(pickSetting({ defaultValue: 1, globalValue: 2, workspaceValue: 3 }, true, 0), 3);
  assert.equal(pickSetting({ defaultValue: 1, globalValue: 2 }, true, 0), 2);
  assert.equal(pickSetting({ defaultValue: 1 }, true, 0), 1);
  assert.equal(pickSetting(undefined, true, 0), 0);
});

test('pickSetting：制限モードではワークスペース・フォルダの値を使わない', () => {
  assert.equal(pickSetting({ defaultValue: 1, globalValue: 2, workspaceValue: 3, workspaceFolderValue: 4 }, false, 0), 2);
  assert.equal(pickSetting({ defaultValue: 1, workspaceValue: 3, workspaceFolderValue: 4 }, false, 0), 1);
  assert.equal(pickSetting({ workspaceValue: 3 }, false, 0), 0);
});

function setFolderSettings(): void {
  fake.config['markdownUnreadChanges.include'] = ['docs/**/*.md'];
  fake.config['markdownUnreadChanges.exclude'] = ['**/secret/**'];
  fake.config['markdownUnreadChanges.maxFiles'] = 5;
  fake.config['markdownUnreadChanges.maxFileSize'] = 10;
  fake.config['markdownUnreadChanges.openUnreadFileIn'] = 'editor';
  fake.config['files.exclude'] = { '**/hidden': true };
}

test('信頼済みのフォルダでは、フォルダ側の設定を使う', () => {
  setFolderSettings();
  const c = readConfig();
  assert.deepEqual(c.include, ['docs/**/*.md']);
  assert.deepEqual(c.exclude, ['**/secret/**', '**/hidden']);
  assert.equal(c.maxFiles, 5);
  assert.equal(c.maxFileSizeBytes, 10 * 1024);
  assert.equal(readOpenTarget(), 'editor');
});

test('制限モードでは、フォルダ側の設定（include / exclude / maxFiles / maxFileSize / openUnreadFileIn / files.exclude）を無視する', () => {
  setFolderSettings();
  fake.trusted = false;
  const c = readConfig();
  assert.deepEqual(c.include, ['**/*.md']);
  assert.deepEqual(c.exclude, []);
  assert.equal(c.maxFiles, 2000);
  assert.equal(c.maxFileSizeBytes, 1024 * 1024);
  assert.equal(readOpenTarget(), 'preview');
});

test('制限モードでも、ユーザー設定は使う', () => {
  setFolderSettings();
  fake.trusted = false;
  fake.userConfig['markdownUnreadChanges.maxFiles'] = 300;
  fake.userConfig['markdownUnreadChanges.exclude'] = ['**/archive/**'];
  fake.userConfig['files.exclude'] = { '**/tmp': true, '**/off': false };
  const c = readConfig();
  assert.equal(c.maxFiles, 300);
  assert.deepEqual(c.exclude, ['**/archive/**', '**/tmp']);
});

test('制限モードでは、フォルダ側の maxFiles で追跡が制限されない', async () => {
  fake.writeFile('/ws/a.md', '# A\n');
  fake.writeFile('/ws/b.md', '# B\n');
  fake.config['markdownUnreadChanges.maxFiles'] = 1;

  const run = async () => {
    const store = new SnapshotStore(Uri.file('/storage') as never);
    await store.load();
    const tracker = new Tracker(store);
    await tracker.start();
    await tracker.idle();
    const mode = tracker.mode;
    tracker.dispose();
    return mode;
  };

  assert.equal(await run(), 'degraded');
  fake.reset();
  fake.writeFile('/ws/a.md', '# A\n');
  fake.writeFile('/ws/b.md', '# B\n');
  fake.config['markdownUnreadChanges.maxFiles'] = 1;
  fake.trusted = false;
  assert.notEqual(await run(), 'degraded');
});
