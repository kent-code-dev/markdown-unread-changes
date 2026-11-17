// テストで 'vscode' の import を、メモリ上の偽物（test/fakes/vscode.mts）に差し替える
import { registerHooks } from 'node:module';

const fakeUrl = new URL('../fakes/vscode.mts', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') {
      return { url: fakeUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

// 通信の関数を、呼ばれたら例外を投げる罠に差し替える
await import('./network-trap.mjs');
