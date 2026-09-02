/**
 * lib/local/pricing.ts 유닛 테스트 — 순수 함수라 파일도 네트워크도 타지 않습니다.
 *
 * 지키려는 것:
 *   1. 캐시 생성 5분/1시간의 **배수가 다르다** (1.25 vs 2.0). 합쳐 계산하면 틀린다
 *   2. 캐시 읽기는 입력의 1/10
 *   3. 패스트 모드는 단가표가 따로다
 *   4. 모르는 모델은 **0 을 돌려주되 priceOf 로 미리 알 수 있어야** 한다
 *      (조용히 0 으로 섞이면 과소 계상이 화면에서 안 보인다)
 *
 * 실행:
 *   node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/**\/__tests__/*.test.ts"
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { costOf, normalizeModel, priceOf, type TokenCounts } from "@/lib/local/pricing";

const MTOK = 1_000_000;

const zero: TokenCounts = {
  input: 0,
  cacheRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  output: 0,
};

describe("local/pricing", () => {
  it("입력·출력을 표 단가 그대로 곱한다", () => {
    // opus-5 = $5 / $25 per MTok
    const usd = costOf({ ...zero, input: MTOK, output: MTOK }, "claude-opus-5");
    assert.equal(usd, 30);
  });

  it("캐시 읽기는 입력의 1/10", () => {
    const usd = costOf({ ...zero, cacheRead: MTOK }, "claude-opus-5");
    assert.equal(usd, 0.5);
  });

  it("캐시 생성 5분(1.25배)과 1시간(2배)은 배수가 다르다", () => {
    const w5 = costOf({ ...zero, cacheWrite5m: MTOK }, "claude-opus-5");
    const w1h = costOf({ ...zero, cacheWrite1h: MTOK }, "claude-opus-5");

    assert.equal(w5, 6.25);
    assert.equal(w1h, 10);

    // ★ 둘을 합쳐 한 배수로 계산하면 안 되는 이유. 같은 100만 토큰인데 값이 다르다.
    assert.notEqual(w5, w1h);
  });

  it("패스트 모드는 단가표가 따로다", () => {
    const std = costOf({ ...zero, output: MTOK }, "claude-opus-5", "standard");
    const fast = costOf({ ...zero, output: MTOK }, "claude-opus-5", "fast");

    assert.equal(std, 25);
    assert.equal(fast, 50);
  });

  it("배치 티어는 절반", () => {
    const usd = costOf({ ...zero, output: MTOK }, "claude-opus-5", "standard", "batch");
    assert.equal(usd, 12.5);
  });

  it("날짜가 붙은 모델 id 도 표에서 찾는다", () => {
    assert.equal(normalizeModel("claude-sonnet-5-20260101"), "claude-sonnet-5");
    assert.notEqual(priceOf("claude-sonnet-5-20260101"), null);
  });

  it("모르는 모델은 0 이지만 priceOf 로 미리 알 수 있다", () => {
    assert.equal(priceOf("claude-opus-9"), null);
    assert.equal(costOf({ ...zero, output: MTOK }, "claude-opus-9"), 0);
  });
});
