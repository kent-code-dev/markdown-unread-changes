// 標準の Markdown プレビューに差分の色付けを組み込む markdown-it プラグイン。
// VS Code はトークン化の結果をキャッシュするため（その時点では対象のファイルが分からない）、
// 描画（render）の時点で env.currentDocument を見て色付けする。
import type MarkdownIt from 'markdown-it';
import type { Token } from 'markdown-it';
import type { LineDiffResult } from '../diff/lineDiff.ts';
import { annotateTokens, RAW_TOKEN_TYPE, type AnnotateLabels } from './annotate.ts';

export interface RenderDiffProvider {
  /** 描画するファイルの差分。追跡していない・差分がない場合は undefined */
  getDiffForRender(uri: string): LineDiffResult | undefined;
}

type TokenClass = new (type: string, tag: string, nesting: Token['nesting']) => Token;

export function createMarkdownItPlugin(provider: RenderDiffProvider, labels: AnnotateLabels) {
  return (md: MarkdownIt): MarkdownIt => {
    md.renderer.rules[RAW_TOKEN_TYPE] = (tokens, idx) => tokens[idx].content;

    const TokenCtor = (md.core.State.prototype as unknown as { Token: TokenClass }).Token;
    const originalRender = md.renderer.render.bind(md.renderer);
    md.renderer.render = (tokens, options, env) => {
      const uri: unknown = env?.currentDocument?.toString?.();
      if (typeof uri === 'string') {
        try {
          const diff = provider.getDiffForRender(uri);
          if (diff && !diff.isEmpty) {
            return originalRender(annotateTokens(tokens, TokenCtor, diff, labels), options, env);
          }
        } catch (err) {
          // 色付けに失敗しても、プレビュー自体は通常どおり表示する
          console.error('[markdown-unread-changes] annotate failed', err);
        }
      }
      return originalRender(tokens, options, env);
    };
    return md;
  };
}
