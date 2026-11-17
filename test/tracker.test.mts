// Tracker の未読の判定（vscode は test/fakes/vscode.mts の偽物に差し替えて動かす）
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fake, Uri } from './fakes/vscode.mts';
import { SnapshotStore } from '../src/tracker/snapshotStore.ts';
import { Tracker } from '../src/tracker/tracker.ts';

const STORAGE = '/storage';
const NOTE = '/ws/ai/claude-md.md';
const CONTENT = '# CLAUDE.md の書き方\n\n- 毎回読み込まれる指示は CLAUDE.md に書く\n';

beforeEach(() => fake.reset());

async function startTracker(): Promise<Tracker> {
  const store = new SnapshotStore(Uri.file(STORAGE) as never);
  await store.load();
  const tracker = new Tracker(store);
  await tracker.start();
  await tracker.idle();
  return tracker;
}

/** 保存されている未読の記録（index.json） */
async function storedIndex(tracker: Tracker): Promise<Record<string, { unread: boolean; count: number }>> {
  tracker.dispose();
  await new Promise((r) => setTimeout(r, 0));
  const file = fake.files.get(`${STORAGE}/index.json`);
  return JSON.parse(new TextDecoder().decode(file!.data)).files;
}

test('初回の取り込み中に、内容の変わらない変更通知が届いても未読にしない', async () => {
  fake.writeFile(NOTE, CONTENT);
  // 取り込みでファイルを読む途中で止め、その間に変更通知（OneDrive の同期などで起きる）を送る
  let release!: () => void;
  fake.readGates.set(NOTE, new Promise<void>((r) => (release = r)));

  const store = new SnapshotStore(Uri.file(STORAGE) as never);
  await store.load();
  const tracker = new Tracker(store);
  const started = tracker.start();
  await new Promise((r) => setTimeout(r, 0));
  fake.fireChange(NOTE);
  await new Promise((r) => setTimeout(r, 0));
  release();
  fake.readGates.delete(NOTE);
  await started;
  await tracker.idle();

  assert.deepEqual(tracker.unreadFiles(), []);
  const index = await storedIndex(tracker);
  assert.equal(index[Uri.file(NOTE).toString()].unread, false);
});

test('保存された未読の記録が実際の内容と食い違っていたら、起動時に直す', async () => {
  fake.writeFile(NOTE, CONTENT);
  const first = await startTracker();
  assert.deepEqual(first.unreadFiles(), []);
  first.dispose();
  await new Promise((r) => setTimeout(r, 0));

  // 以前の版の不具合で「未読」が残ってしまった状態を作る（スナップショットは本文と同じ）
  const indexFile = fake.files.get(`${STORAGE}/index.json`)!;
  const index = JSON.parse(new TextDecoder().decode(indexFile.data));
  index.files[Uri.file(NOTE).toString()].unread = true;
  index.files[Uri.file(NOTE).toString()].count = 1;
  indexFile.data = new TextEncoder().encode(JSON.stringify(index));

  const second = await startTracker();
  assert.deepEqual(second.unreadFiles(), []);
});

test('内容が変わったファイルは未読になり、件数は色付けと同じ比較で数える', async () => {
  fake.writeFile(NOTE, CONTENT);
  const tracker = await startTracker();
  fake.writeFile(NOTE, CONTENT.replace('毎回', '起動のたびに'));
  fake.fireChange(NOTE);
  await tracker.idle();
  assert.deepEqual(tracker.unreadFiles(), [{ uri: Uri.file(NOTE).toString(), count: 1 }]);
  tracker.dispose();
});

test('改行コードだけが変わったファイルは未読にしない', async () => {
  fake.writeFile(NOTE, CONTENT);
  const tracker = await startTracker();
  fake.writeFile(NOTE, '﻿' + CONTENT.replace(/\n/g, '\r\n'));
  fake.fireChange(NOTE);
  await tracker.idle();
  assert.deepEqual(tracker.unreadFiles(), []);
  tracker.dispose();
});
