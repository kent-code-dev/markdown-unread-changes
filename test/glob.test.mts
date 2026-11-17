import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GlobMatcher, combineGlobs } from '../src/util/glob.ts';

test('glob の照合', () => {
  const m = new GlobMatcher(['**/*.md']);
  assert.ok(m.matches('a.md'));
  assert.ok(m.matches('docs/notes/a.md'));
  assert.ok(!m.matches('a.txt'));

  const ex = new GlobMatcher(['**/node_modules/**', 'docs/{tmp,old}/*.md']);
  assert.ok(ex.matches('node_modules/x/readme.md'));
  assert.ok(ex.matches('pkg/node_modules/readme.md'));
  assert.ok(ex.matches('docs/tmp/a.md'));
  assert.ok(!ex.matches('docs/notes/a.md'));
});

test('複数の glob をまとめる', () => {
  assert.equal(combineGlobs([]), undefined);
  assert.equal(combineGlobs(['a']), 'a');
  assert.equal(combineGlobs(['a', 'b']), '{a,b}');
});
