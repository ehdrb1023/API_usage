/**
 * lib/key-levels.ts 유닛 테스트 — 순수 함수, 네트워크 없음.
 *
 * 지키려는 것: 예산 80/95/100%, 러너웨이 14/7/3일, 잔액 50%/10% 경계.
 *
 * 실행:
 *   node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/**\/__tests__/*.test.ts"
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  balanceLevel,
  budgetLevel,
  daysOfRunway,
  maxLevel,
  runwayLevel,
} from "@/lib/key-levels";

describe("budgetLevel — 80/95/100%", () => {
  it("예산 0·음수면 0", () => {
    assert.equal(budgetLevel(100, 0), 0);
    assert.equal(budgetLevel(100, -1), 0);
  });
  it("경계값", () => {
    assert.equal(budgetLevel(79, 100), 0);
    assert.equal(budgetLevel(80, 100), 1);
    assert.equal(budgetLevel(95, 100), 2);
    assert.equal(budgetLevel(100, 100), 3);
    assert.equal(budgetLevel(120, 100), 3);
  });
});

describe("runwayLevel — 14/7/3일", () => {
  it("쓰지 않았으면(null) 0", () => {
    assert.equal(runwayLevel(null), 0);
  });
  it("경계값", () => {
    assert.equal(runwayLevel(15), 0);
    assert.equal(runwayLevel(14), 1);
    assert.equal(runwayLevel(7), 2);
    assert.equal(runwayLevel(3), 3);
    assert.equal(runwayLevel(0), 3);
  });
});

describe("balanceLevel — warn·절반·10%", () => {
  it("warn 0 이면 0", () => {
    assert.equal(balanceLevel(5, 0), 0);
  });
  it("경계값 (warn=100)", () => {
    assert.equal(balanceLevel(100, 100), 0);
    assert.equal(balanceLevel(99, 100), 1);
    assert.equal(balanceLevel(49, 100), 2);
    assert.equal(balanceLevel(10, 100), 3);
  });
});

describe("daysOfRunway", () => {
  it("소진 0·음수면 null", () => {
    assert.equal(daysOfRunway(100, 0), null);
    assert.equal(daysOfRunway(100, -1), null);
  });
  it("남은 ÷ 하루", () => {
    assert.equal(daysOfRunway(100, 10), 10);
    assert.equal(daysOfRunway(95, 10), 9);
    assert.equal(daysOfRunway(-5, 10), 0);
  });
});

describe("maxLevel", () => {
  it("가장 나쁜 단계", () => {
    assert.equal(maxLevel(0, 1, 3, 2), 3);
    assert.equal(maxLevel(), 0);
  });
});
