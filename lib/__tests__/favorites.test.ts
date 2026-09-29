import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseFavorites, toggleFavorite } from "@/lib/favorites";

describe("parseFavorites", () => {
  it("서비스별 문자열 배열만 남긴다", () => {
    assert.deepEqual(parseFavorites('{"claude":["a","a",1,"b"],"gpt":"x"}'), { claude: ["a", "b"] });
  });
  it("깨진 값은 빈 즐겨찾기", () => {
    assert.deepEqual(parseFavorites("{oops"), {});
    assert.deepEqual(parseFavorites(null), {});
  });
});

describe("toggleFavorite", () => {
  it("추가했다가 다시 누르면 해제", () => {
    const on = toggleFavorite({}, "claude", "k1");
    assert.deepEqual(on, { claude: ["k1"] });
    assert.deepEqual(toggleFavorite(on, "claude", "k1"), { claude: [] });
  });
  it("다른 서비스는 건드리지 않는다", () => {
    assert.deepEqual(toggleFavorite({ gpt: ["p"] }, "claude", "k"), { gpt: ["p"], claude: ["k"] });
  });
});
