import { test } from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { computeLineDiff } from '../src/diff/lineDiff.ts';
import { createMarkdownItPlugin } from '../src/preview/markdownItPlugin.ts';

const labels = { tableColumnsChanged: '列が変更されました', tableAlignmentChanged: '配置が変更されました' };
const URI = 'file:///test.md';

/** VS Code と同じく、描画時に env.currentDocument を渡して HTML を得る */
function render(oldText: string, newText: string): string {
  const md = new MarkdownIt();
  createMarkdownItPlugin({ getDiffForRender: () => computeLineDiff(oldText, newText) }, labels)(md);
  const tokens = md.parse(newText, {});
  return md.renderer.render(tokens, md.options, { currentDocument: { toString: () => URI } });
}

test('変更した段落は黄色で、変更前のテキストを持つ', () => {
  const html = render('段落1\n\n段落2', '段落1\n\n段落2を変更');
  assert.match(html, /<div class="muc-block muc-modified" data-muc-old="段落2"><p>段落2を変更<\/p>\s*<\/div>/);
  assert.doesNotMatch(html, /muc-[a-z]+"[^>]*><p>段落1/);
});

test('追加した段落は緑', () => {
  const html = render('段落1', '段落1\n\n新しい段落');
  assert.match(html, /<div class="muc-block muc-added"><p>新しい段落<\/p>/);
});

test('削除した段落は赤で、消えた内容を表示する', () => {
  const html = render('段落1\n\n消える段落\n\n段落3', '段落1\n\n段落3');
  assert.match(html, /<div class="muc-block muc-deleted">消える段落/);
  assert.ok(html.indexOf('muc-deleted') < html.indexOf('段落3'));
});

test('HTML として解釈される文字はエスケープする', () => {
  const html = render('<script>x</script>', '新しい');
  assert.doesNotMatch(html, /<script>/);
});

test('表は変わった行だけに色を付ける', () => {
  const oldText = ['| a | b |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |'].join('\n');
  const newText = ['| a | b |', '|---|---|', '| 1 | 2 |', '| 3 | 5 |'].join('\n');
  const html = render(oldText, newText);
  assert.equal((html.match(/muc-row muc-modified/g) ?? []).length, 1);
  assert.match(html, /<tr class="muc-row muc-modified" data-muc-old="\| 3 \| 4 \|">/);
});

test('表の列が増えたら、表全体に枠とラベルを付ける', () => {
  const oldText = ['| a | b |', '|---|---|', '| 1 | 2 |'].join('\n');
  const newText = ['| a | b | c |', '|---|---|---|', '| 1 | 2 | 3 |'].join('\n');
  const html = render(oldText, newText);
  assert.match(html, /muc-table-changed/);
  assert.match(html, /列が変更されました/);
  assert.doesNotMatch(html, /muc-row/);
});

test('表の配置だけの変更も、表全体の枠で示す', () => {
  const oldText = ['| a | b |', '|---|---|', '| 1 | 2 |'].join('\n');
  const newText = ['| a | b |', '|:---:|---|', '| 1 | 2 |'].join('\n');
  assert.match(render(oldText, newText), /配置が変更されました/);
});

test('表の行の削除は、表の中に行として表示する', () => {
  const oldText = ['| a | b |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |', '| 5 | 6 |'].join('\n');
  const newText = ['| a | b |', '|---|---|', '| 1 | 2 |', '| 5 | 6 |'].join('\n');
  assert.match(render(oldText, newText), /<tr class="muc-row muc-deleted"><td>3<\/td><td>4<\/td><\/tr>/);
});

test('コードブロック内の変更はブロック全体を黄色にする', () => {
  const html = render('```\na\nb\n```', '```\na\nc\n```');
  assert.match(html, /<div class="muc-block muc-modified" data-muc-old="```\na\nb\n```"><pre>/);
});

test('元のトークンを書き換えない（VS Code のキャッシュを汚さない）', () => {
  const md = new MarkdownIt();
  const newText = '| a |\n|---|\n| 2 |';
  createMarkdownItPlugin({ getDiffForRender: () => computeLineDiff('| a |\n|---|\n| 1 |', newText) }, labels)(md);
  const tokens = md.parse(newText, {});
  const before = JSON.stringify(tokens);
  md.renderer.render(tokens, md.options, { currentDocument: { toString: () => URI } });
  assert.equal(JSON.stringify(tokens), before);
});

test('対象のファイルが分からないときは色を付けない', () => {
  const md = new MarkdownIt();
  createMarkdownItPlugin({ getDiffForRender: () => computeLineDiff('a', 'b') }, labels)(md);
  assert.doesNotMatch(md.render('b'), /muc-/);
});

// ---- 行数の違う変更での削除の表示 ----

test('削除 2 行・追加 1 行：黄色の段落の前に、消えた行を赤で表示する', () => {
  const oldText = ['見出し前の段落', '', '東京は晴れ', '大阪は曇り'].join('\n');
  const newText = ['見出し前の段落', '', '大阪は曇りのち雨'].join('\n');
  const html = render(oldText, newText);
  assert.match(html, /<div class="muc-block muc-deleted">東京は晴れ<\/div>/);
  assert.match(html, /<div class="muc-block muc-modified" data-muc-old="大阪は曇り"><p>大阪は曇りのち雨<\/p>/);
  assert.ok(html.indexOf('muc-deleted') < html.indexOf('muc-modified'));
});

test('リスト項目の削除と変更：消えた項目を赤で表示する', () => {
  const oldText = ['- 項目1: りんご', '- 項目2: みかん', '- 項目3: もも'].join('\n');
  const newText = ['- 項目2: みかんとバナナ', '- 項目3: もも'].join('\n');
  const html = render(oldText, newText);
  assert.match(html, /muc-deleted">- 項目1: りんご</);
  assert.match(html, /muc-modified" data-muc-old="- 項目2: みかん"/);
});

test('段落の途中の行が消えたら、黄色に吸収せず赤で表示する', () => {
  const oldText = ['1行目はそのまま', '2行目は消える', '3行目もそのまま'].join('\n');
  const newText = ['1行目はそのまま', '3行目もそのまま'].join('\n');
  const html = render(oldText, newText);
  assert.match(html, /<div class="muc-block muc-deleted">2行目は消える<\/div>/);
  assert.doesNotMatch(html, /muc-modified/);
});

test('変更した段落の途中で消えた行は、変更前のテキストにも含める', () => {
  const oldText = ['1行目はそのまま', '2行目は消える', '3行目を書き換える'].join('\n');
  const newText = ['1行目はそのまま', '3行目を書き換えた'].join('\n');
  const html = render(oldText, newText);
  assert.match(html, /data-muc-old="1行目はそのまま\n2行目は消える\n3行目を書き換える"/);
  assert.match(html, /muc-deleted">2行目は消える</);
});
