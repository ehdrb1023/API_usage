/**
 * 미터기 — 소진 속도·남은 시간·신호등.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { burnRate, humanDuration, severity } from "@/lib/quota-meter";

const NOW = new Date("2026-09-07T06:00:00.000Z");

describe("quota-meter/burnRate", () => {
  it("경과 시간으로 시간당 소진율을 낸다", () => {
    // 5시간 창, 리셋까지 3시간 → 2시간 경과. 그 사이 10% → 5%/h.
    const burn = burnRate("session", 10, "2026-09-07T09:00:00.000Z", NOW);
    assert.equal(burn?.percentPerHour, 5);
    assert.equal(burn?.elapsedMs, 2 * 3_600_000);
    assert.equal(burn?.remainingMs, 3 * 3_600_000);
  });

  it("리셋 전에 바닥나면 그 시각을 준다", () => {
    // 2시간에 50% → 25%/h. 남은 50%면 2시간 뒤 = 08:00. 리셋(09:00) 전이다.
    const burn = burnRate("session", 50, "2026-09-07T09:00:00.000Z", NOW);
    assert.equal(burn?.exhaustAt?.toISOString(), "2026-09-07T08:00:00.000Z");
  });

  it("리셋 뒤에 닿을 속도면 null 이다 — 그전에 0 으로 돌아간다", () => {
    // 2시간에 10% → 5%/h. 남은 90%는 18시간 걸리는데 리셋이 3시간 뒤다.
    const burn = burnRate("session", 10, "2026-09-07T09:00:00.000Z", NOW);
    assert.equal(burn?.exhaustAt, null);
  });

  it("★ 모르는 종류의 창은 속도를 지어내지 않는다", () => {
    // 창 길이를 모르면 경과 시간을 못 구한다. 0 을 주면 계기판이 거짓말을 한다.
    assert.equal(burnRate("무슨창", 50, "2026-09-07T09:00:00.000Z", NOW), null);
  });

  it("리셋 시각이 없으면 null 이다", () => {
    // weekly_scoped 는 실측에서 resets_at 이 null 로 온다.
    assert.equal(burnRate("weekly_scoped", 50, null, NOW), null);
  });

  it("방금 리셋된 창은 속도를 내지 않는다 — 0 으로 나누게 된다", () => {
    // 리셋까지 정확히 5시간 = 경과 0.
    assert.equal(burnRate("session", 0, "2026-09-07T11:00:00.000Z", NOW), null);
  });

  it("주간 창은 168시간으로 센다", () => {
    // 리셋까지 84시간 → 절반인 84시간 경과. 42% 면 0.5%/h.
    const burn = burnRate("weekly_all", 42, "2026-09-10T18:00:00.000Z", NOW);
    assert.equal(burn?.percentPerHour, 0.5);
  });
});

describe("quota-meter/severity", () => {
  it("리셋 전에 안 바닥나면 퍼센트가 높아도 ok 다", () => {
    // 90% 를 썼어도 리셋 전에 안 닿으면 문제가 아니다.
    const burn = burnRate("session", 90, "2026-09-07T06:10:00.000Z", NOW);
    assert.equal(severity(burn, NOW), "ok");
  });

  it("남은 창의 절반도 못 버티면 danger 다", () => {
    // 2시간에 50% → 25%/h. 2시간 뒤 소진, 리셋은 3시간 뒤 → 비율 0.67... 
    const fast = burnRate("session", 80, "2026-09-07T09:00:00.000Z", NOW);
    assert.equal(severity(fast, NOW), "danger");
  });

  it("속도를 모르면 ok 로 둔다 — 빨간불을 지어내지 않는다", () => {
    assert.equal(severity(null, NOW), "ok");
  });
});

describe("quota-meter/humanDuration", () => {
  it("자리에 맞춰 두 단위까지만 쓴다", () => {
    assert.equal(humanDuration(45 * 60_000), "45m");
    assert.equal(humanDuration(3 * 3_600_000 + 9 * 60_000), "3h 9m");
    assert.equal(humanDuration(6 * 86_400_000 + 2 * 3_600_000), "6d 2h");
  });

  it("음수·NaN 을 0m 으로 접는다", () => {
    assert.equal(humanDuration(-1), "0m");
    assert.equal(humanDuration(NaN), "0m");
  });
});
