/**
 * lib/vendor-fallback.ts 유닛 테스트.
 *
 * 여기서 지키려는 규칙은 두 개다.
 *   1. 벤더가 막혀도 **직전 값은 계속 나온다** (화면이 통째로 비지 않는다)
 *   2. 쉬는 동안에는 **호출을 아예 안 한다** — 이게 깨지면 429 를 더 쌓아
 *      리밋이 영영 안 풀린다. `unstable_cache` 가 실패를 캐싱하지 않으므로
 *      제동은 여기밖에 없다.
 *
 * 실행:
 *   node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/**\/__tests__/*.test.ts"
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ApiClientError } from "@/lib/clients/types";
import { createStaleFallback } from "@/lib/vendor-fallback";

/** 시계를 손으로 돌린다. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function rateLimit(retryAfterSeconds?: number) {
  return new ApiClientError({
    vendor: "anthropic",
    status: 429,
    body: '{"type":"error"}',
    url: "https://api.anthropic.com/v1/organizations/usage_report/messages",
    retryAfterSeconds,
  });
}

describe("createStaleFallback", () => {
  it("성공하면 그대로 내보낸다", async () => {
    const run = createStaleFallback<number>();
    const got = await run(async () => 42);
    assert.equal(got.value, 42);
    assert.equal(got.stale, false);
  });

  it("실패하면 직전 성공값을 사유와 함께 내보낸다", async () => {
    const c = clock();
    const run = createStaleFallback<number>(c.now);

    await run(async () => 7);
    c.advance(60_000);
    const got = await run(async () => {
      throw rateLimit(600);
    });

    assert.equal(got.value, 7);
    assert.equal(got.stale, true);
    assert.match(got.reason ?? "", /429/);
    // 값을 받아온 시각은 성공했을 때 그대로여야 한다 (지금이 아니라).
    assert.equal(got.at, 1_000_000);
  });

  it("쉬는 동안에는 호출 자체를 하지 않는다", async () => {
    const c = clock();
    const run = createStaleFallback<number>(c.now);
    let calls = 0;

    await run(async () => {
      calls++;
      return 1;
    });
    await run(async () => {
      calls++;
      throw rateLimit(600); // 10분 쉰다
    });
    assert.equal(calls, 2);

    c.advance(5 * 60_000);
    const got = await run(async () => {
      calls++;
      return 2;
    });
    assert.equal(calls, 2, "백오프 중에는 fetcher 를 부르면 안 된다");
    assert.equal(got.value, 1);
    assert.equal(got.stale, true);
  });

  it("retry-after 가 지나면 다시 호출한다", async () => {
    const c = clock();
    const run = createStaleFallback<number>(c.now);

    await run(async () => 1);
    await run(async () => {
      throw rateLimit(600);
    });

    c.advance(600_000 + 1);
    const got = await run(async () => 2);
    assert.equal(got.value, 2);
    assert.equal(got.stale, false);
  });

  it("들고 있는 값이 없으면 던진다 — 그리고 쉬는 동안 재호출하지 않는다", async () => {
    const c = clock();
    const run = createStaleFallback<number>(c.now);
    let calls = 0;

    await assert.rejects(
      run(async () => {
        calls++;
        throw rateLimit(600);
      }),
      /429/,
    );

    await assert.rejects(
      run(async () => {
        calls++;
        return 1;
      }),
      /429/,
    );
    assert.equal(calls, 1, "값이 없어도 백오프 중이면 두드리지 않는다");
  });

  it("429 가 아닌 실패는 짧게만 쉰다", async () => {
    const c = clock();
    const run = createStaleFallback<number>(c.now);

    await run(async () => 1);
    await run(async () => {
      throw new Error("네트워크 오류");
    });

    // 30초 기본 백오프. 그 직후에는 다시 시도해야 한다.
    c.advance(30_000 + 1);
    const got = await run(async () => 2);
    assert.equal(got.value, 2);
    assert.equal(got.stale, false);
  });

  it("retry-after 가 없으면 60초, 터무니없이 길면 15분에서 끊는다", async () => {
    const c = clock();
    const run = createStaleFallback<number>(c.now);
    await run(async () => 1);
    await run(async () => {
      throw rateLimit(); // retry-after 없음 → 60초
    });
    c.advance(60_000 + 1);
    assert.equal((await run(async () => 2)).value, 2);

    await run(async () => {
      throw rateLimit(86_400); // 하루? → 15분에서 끊는다
    });
    c.advance(15 * 60_000 + 1);
    assert.equal((await run(async () => 3)).value, 3);
  });
});
