/**
 * lib/quota.ts 유닛 테스트 — **응답 해석**만 본다.
 *
 * 네트워크를 타는 `getQuota` 는 여기서 안 부른다. 대신 실제 응답을 그대로 떠 온
 * 표본(`SAMPLE`)을 `parseQuota` 에 통과시킨다. 이유는 두 가지다.
 *   1. 공개 문서에 없는 내부 엔드포인트라 **언젠가 모양이 바뀐다.** 그때 깨져야
 *      할 곳은 여기고, 깨지는 방식은 "테스트 실패" 여야지 "화면에 0% 표시" 면 안 된다.
 *   2. 한도는 계정 상태에 따라 매번 달라져서, 실호출로는 단언을 쓸 수가 없다.
 *
 * 실행:
 *   node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/**\/__tests__/*.test.ts"
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseQuota } from "@/lib/quota";

/** 2026-09-02 실제 응답에서 필요한 부분만 그대로 옮긴 것. */
const SAMPLE = {
  five_hour: { utilization: 51.0, limit_dollars: null, used_dollars: null },
  limits: [
    {
      kind: "session",
      group: "session",
      percent: 51,
      severity: "normal",
      resets_at: "2026-09-02T08:59:59.893806+00:00",
      scope: null,
      is_active: true,
    },
    {
      kind: "weekly_all",
      group: "weekly",
      percent: 19,
      severity: "normal",
      resets_at: "2026-09-06T23:59:59.893845+00:00",
      scope: null,
      is_active: false,
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 2,
      severity: "normal",
      resets_at: "2026-09-06T23:59:59.894641+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
      is_active: false,
    },
  ],
  extra_usage: { is_enabled: false, user_disabled: true },
};

describe("parseQuota", () => {
  it("세 칸을 라벨과 함께 읽는다", () => {
    const q = parseQuota(SAMPLE);
    assert.equal(q.error, undefined);
    assert.deepEqual(
      q.windows.map((w) => w.label),
      ["5시간", "이번 주", "이번 주 · Fable"],
    );
  });

  it("남은 양은 100 에서 뺀 값이다", () => {
    const [session, weekly] = parseQuota(SAMPLE).windows;
    assert.equal(session.usedPercent, 51);
    assert.equal(session.remainingPercent, 49);
    assert.equal(weekly.remainingPercent, 81);
  });

  /**
   * 모델별 한도가 붙으면 "이번 주" 가 둘이 된다. 라벨이 같으면 화면에서 어느
   * 줄이 무엇인지 구분이 안 되므로 모델명이 반드시 붙어야 한다.
   */
  it("모델별 한도는 모델명으로 구분된다", () => {
    const labels = parseQuota(SAMPLE).windows.map((w) => w.label);
    assert.equal(new Set(labels).size, labels.length);
  });

  it("초과 시 과금 여부를 그대로 전달한다", () => {
    assert.equal(parseQuota(SAMPLE).extraUsageEnabled, false);
    assert.equal(
      parseQuota({ ...SAMPLE, extra_usage: { is_enabled: true } }).extraUsageEnabled,
      true,
    );
  });

  /**
   * 여기부터가 이 파일의 본론이다 — 엔드포인트가 바뀌었을 때
   * **조용히 0% 를 그리지 않고 error 를 남기는가.**
   */
  it("limits 가 없으면 에러로 돌려준다", () => {
    for (const bad of [{}, null, { limits: "nope" }, "문자열"]) {
      const q = parseQuota(bad);
      assert.ok(q.error, `${JSON.stringify(bad)} 에서 error 가 없다`);
      assert.equal(q.windows.length, 0);
    }
  });

  it("limits 가 비어 있으면 에러로 돌려준다", () => {
    const q = parseQuota({ limits: [] });
    assert.ok(q.error);
  });

  /**
   * 이 단언이 이 파일에서 제일 중요하다. `Number(null)` 은 0 이라, 방심하면
   * **한도를 모르는 상태가 "0% 사용 = 100% 남음" 으로 뒤집힌다.** 다 쓴 계정에
   * 여유가 있다고 표시되는 것이라 조용한 0 중에서도 최악이다.
   */
  it("percent 가 없거나 숫자가 아니면 그 칸을 버린다", () => {
    for (const bad of [null, undefined, {}, [], true]) {
      const q = parseQuota({
        limits: [{ kind: "session", percent: bad }, ...SAMPLE.limits.slice(1)],
      });
      assert.equal(
        q.windows.length,
        2,
        `percent=${JSON.stringify(bad)} 가 0% 로 둔갑했다`,
      );
      assert.ok(!q.windows.some((w) => w.key === "session"));
    }
  });

  it("숫자꼴 문자열은 살린다", () => {
    const q = parseQuota({
      limits: [{ kind: "session", percent: "51" }, ...SAMPLE.limits.slice(1)],
    });
    assert.equal(q.windows.length, 3);
    assert.equal(q.windows[0].usedPercent, 51);
  });

  /** 100 을 넘겨 오더라도 "남음 -5%" 가 화면에 뜨면 안 된다. */
  it("퍼센트는 0~100 으로 잘린다", () => {
    const q = parseQuota({
      limits: [
        { kind: "session", percent: 132 },
        { kind: "weekly_all", percent: -4 },
      ],
    });
    assert.deepEqual(
      q.windows.map((w) => [w.usedPercent, w.remainingPercent]),
      [
        [100, 0],
        [0, 100],
      ],
    );
  });

  it("모르는 kind 도 버리지 않고 그대로 보여준다", () => {
    const q = parseQuota({ limits: [{ kind: "monthly_new_thing", percent: 7 }] });
    assert.equal(q.windows[0].label, "monthly_new_thing");
    assert.equal(q.windows[0].remainingPercent, 93);
  });

  it("resets_at 이 없으면 null 이다", () => {
    const q = parseQuota({ limits: [{ kind: "session", percent: 10 }] });
    assert.equal(q.windows[0].resetsAt, null);
  });
});
