/**
 * 화면용 조립 — 계기판(CLI)과 웹이 같은 규칙을 쓰는지.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { windowView } from "@/lib/quota-view";
import type { Calibration } from "@/lib/quota-calibration";

const NOW = new Date("2026-09-07T06:00:00.000Z");

function calibration(over: Partial<Calibration> = {}): Calibration {
  return {
    windowKey: "session",
    windowLabel: "5시간",
    used: 3,
    rejected: {},
    perPercentWithCacheRead: 5_000_000,
    perPercentWithoutCacheRead: 80_000,
    spreadWithCacheRead: null,
    ...over,
  };
}

const WINDOW = {
  key: "session",
  label: "5시간",
  usedPercent: 20,
  resetsAt: "2026-09-07T09:00:00.000Z",
};

describe("quota-view/windowView", () => {
  it("남은 퍼센트를 보정값에 곱해 두 값을 낸다", () => {
    const v = windowView(WINDOW, [calibration()], NOW);
    assert.equal(v.remainingPercent, 80);
    assert.equal(v.estimate?.withCacheRead, 80 * 5_000_000);
    assert.equal(v.estimate?.withoutCacheRead, 80 * 80_000);
  });

  it("보정이 없으면 추정을 만들지 않는다", () => {
    const v = windowView(WINDOW, [], NOW);
    assert.equal(v.estimate, null);
  });

  it("★ 한쪽 보정만 있으면 추정을 안 낸다 — 점 하나는 확정값처럼 읽힌다", () => {
    const half = calibration({ perPercentWithoutCacheRead: null });
    assert.equal(windowView(WINDOW, [half], NOW).estimate, null);
  });

  it("다른 창의 보정값을 가져다 쓰지 않는다", () => {
    const weekly = calibration({ windowKey: "weekly_all" });
    assert.equal(windowView(WINDOW, [weekly], NOW).estimate, null);
  });

  it("속도를 같이 실어 준다", () => {
    // 5시간 창, 리셋까지 3시간 → 2시간 경과. 20% → 10%/h.
    const v = windowView(WINDOW, [], NOW);
    assert.equal(v.burn?.percentPerHour, 10);
  });

  it("속도를 못 구하면 null 이다 — 0 으로 채우지 않는다", () => {
    const v = windowView({ ...WINDOW, resetsAt: null }, [], NOW);
    assert.equal(v.burn, null);
  });
});
