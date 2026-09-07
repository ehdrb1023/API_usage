/**
 * `node --test` 용 확장자 해석 훅.
 *
 * 소스는 저장소 관례대로 확장자 없는 상대 경로(`./types`)를 씁니다. Next.js 번들러와
 * tsc 는 이를 해석하지만, Node 의 ESM 로더는 확장자를 요구합니다.
 * (Node 22 의 TypeScript 타입 스트리핑은 실행은 해 주지만 확장자 추론은 하지 않음)
 *
 * 그래서 상대 경로 해석이 실패하면 `.ts` / `/index.ts` 를 붙여 한 번 더 시도합니다.
 * `@/lib/...` 별칭(tsconfig `paths`)도 저장소 루트로 풀어 줍니다.
 * 테스트 실행 전용이며 런타임 코드에는 아무 영향이 없습니다.
 *
 *   node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/**\/__tests__/*.test.ts"
 */

import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * tsconfig 의 `paths: { "@/*": ["./*"] }` 를 테스트에서도 똑같이 풀어 준다.
 *
 * ⚠️ `process.cwd()` 를 그대로 쓰면 **저장소 밖에서 실행할 때 깨진다** — 전역 CLI
 * (`bin/quota.mjs`) 는 아무 디렉토리에서나 불리고, 그때 `@/lib/kst` 가
 * `/tmp/lib/kst` 로 풀린다. 그래서 CLI 가 `QUOTA_REPO_ROOT` 로 진짜 루트를 알려주고,
 * 없을 때만(테스트·npm script) cwd 로 떨어진다.
 */
const ROOT_PATH = process.env.QUOTA_REPO_ROOT || process.cwd();
const REPO_ROOT = pathToFileURL(`${ROOT_PATH}/`).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const spec = specifier.startsWith("@/")
      ? REPO_ROOT + specifier.slice(2)
      : specifier;

    if (!spec.startsWith(".") && !spec.startsWith(REPO_ROOT)) {
      return nextResolve(spec, context);
    }

    try {
      return nextResolve(spec, context);
    } catch (error) {
      for (const suffix of [".ts", ".tsx", "/index.ts"]) {
        try {
          return nextResolve(spec + suffix, context);
        } catch {
          // 다음 후보로.
        }
      }
      throw error;
    }
  },
});
