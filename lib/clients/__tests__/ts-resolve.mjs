/**
 * `node --test` 용 확장자 해석 훅.
 *
 * 소스는 저장소 관례대로 확장자 없는 상대 경로(`./types`)를 씁니다. Next.js 번들러와
 * tsc 는 이를 해석하지만, Node 의 ESM 로더는 확장자를 요구합니다.
 * (Node 22 의 TypeScript 타입 스트리핑은 실행은 해 주지만 확장자 추론은 하지 않음)
 *
 * 그래서 상대 경로 해석이 실패하면 `.ts` / `/index.ts` 를 붙여 한 번 더 시도합니다.
 * 테스트 실행 전용이며 런타임 코드에는 아무 영향이 없습니다.
 *
 *   node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/clients/__tests__/*.test.ts"
 */

import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith(".")) {
      return nextResolve(specifier, context);
    }

    try {
      return nextResolve(specifier, context);
    } catch (error) {
      for (const suffix of [".ts", ".tsx", "/index.ts"]) {
        try {
          return nextResolve(specifier + suffix, context);
        } catch {
          // 다음 후보로.
        }
      }
      throw error;
    }
  },
});
