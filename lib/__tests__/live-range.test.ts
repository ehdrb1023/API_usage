/**
 * lib/live-range.ts 유닛 테스트.
 *
 * 여기서 지키려는 규칙은 하나가 압도적으로 중요하다:
 *   **오늘이 두 번 더해지면 안 된다.**
 * 구간 합계는 [하루 캐시의 지난 날들] + [방금 받은 오늘] 인데, 하루 캐시가
 * 오늘치를 이미 담고 있을 수 있다. 이게 새면 화면의 오늘 사용량이 조용히
 * 두 배가 되고, 합계라서 아무도 눈치채지 못한다.
 *
 * 실행:
 *   node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/**\/__tests__/*.test.ts"
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isLiveRange,
  liveRangeBounds,
  rangeNote,
  sumRange,
} from "@/lib/live-range";
import type { DailyPoint } from "@/lib/types";

const TODAY = "2026-09-02";

function point(date: string, cost: number, tokens: number, items: [string, number][] = []): DailyPoint {
  return {
    date,
    costUsd: cost,
    metrics: { totalTokens: tokens },
    items: items.map(([key, c]) => ({
      key,
      label: key.toUpperCase(),
      costUsd: c,
      metrics: { totalTokens: c * 1000 },
    })),
  };
}

describe("liveRangeBounds", () => {
  it("오늘은 하루짜리 구간", () => {
    assert.deepEqual(liveRangeBounds(TODAY, "today"), [TODAY, TODAY]);
  });

  it("7일은 오늘을 포함한 7일", () => {
    assert.deepEqual(liveRangeBounds(TODAY, "7d"), ["2026-08-27", TODAY]);
  });

  it("이번 달은 1일부터", () => {
    assert.deepEqual(liveRangeBounds(TODAY, "mtd"), ["2026-09-01", TODAY]);
  });

  /** 달 경계에서 어긋나기 쉬운 자리라 따로 본다. */
  it("월초·월말에도 어긋나지 않는다", () => {
    assert.deepEqual(liveRangeBounds("2026-09-01", "mtd"), ["2026-09-01", "2026-09-01"]);
    assert.deepEqual(liveRangeBounds("2026-09-01", "7d"), ["2026-08-26", "2026-09-01"]);
    assert.deepEqual(liveRangeBounds("2026-03-01", "7d"), ["2026-02-23", "2026-03-01"]);
  });
});

describe("sumRange", () => {
  const history = [
    point("2026-08-25", 100, 1000), // 7일 구간 밖
    point("2026-08-28", 2, 20, [["a", 2]]),
    point("2026-09-01", 3, 30, [["a", 1], ["b", 2]]),
  ];
  const today = point(TODAY, 5, 50, [["a", 4], ["c", 1]]);

  it("오늘 구간은 오늘 값 그대로다", () => {
    const r = sumRange(history, today, TODAY, "today");
    assert.equal(r.costUsd, 5);
    assert.equal(r.metrics.totalTokens, 50);
  });

  it("7일은 구간 안의 지난 날 + 오늘", () => {
    const r = sumRange(history, today, TODAY, "7d");
    // 8-25 는 구간 밖이라 빠진다: 2 + 3 + 5
    assert.equal(r.costUsd, 10);
    assert.equal(r.metrics.totalTokens, 100);
  });

  it("이번 달은 9월치만 더한다", () => {
    const r = sumRange(history, today, TODAY, "mtd");
    assert.equal(r.costUsd, 8); // 9-01 의 3 + 오늘 5
  });

  /**
   * 이 파일에서 제일 중요한 단언. 하루 캐시에 오늘치가 이미 들어 있어도
   * 오늘은 **한 번만** 세어야 한다.
   */
  it("캐시에 오늘치가 섞여 있어도 두 번 더하지 않는다", () => {
    const dirty = [...history, point(TODAY, 5, 50, [["a", 4], ["c", 1]])];
    const clean = sumRange(history, today, TODAY, "7d");
    const withDup = sumRange(dirty, today, TODAY, "7d");
    assert.equal(withDup.costUsd, clean.costUsd, "오늘이 두 번 더해졌다");
    assert.equal(withDup.metrics.totalTokens, clean.metrics.totalTokens);
  });

  it("항목은 key 로 합쳐지고 비용 내림차순이다", () => {
    const r = sumRange(history, today, TODAY, "7d");
    assert.deepEqual(
      r.items.map((i) => [i.key, i.costUsd]),
      [
        ["a", 7], // 2 + 1 + 4
        ["b", 2],
        ["c", 1],
      ],
    );
  });

  it("항목 합계는 전체 합계와 같다", () => {
    for (const range of ["today", "7d", "mtd"] as const) {
      const r = sumRange(history, today, TODAY, range);
      const sum = r.items.reduce((s, i) => s + i.costUsd, 0);
      assert.ok(Math.abs(sum - r.costUsd) < 1e-9, `${range} 축 합계가 전체와 다르다`);
    }
  });

  /** 오늘 조회가 실패해도 지난 날들은 보여야 한다 — 화면이 통째로 비면 안 된다. */
  it("오늘 값이 없으면 지난 날들만으로 만든다", () => {
    const r = sumRange(history, undefined, TODAY, "7d");
    assert.equal(r.costUsd, 5); // 2 + 3
    assert.equal(r.items.length, 2);
  });

  it("빈 입력은 0 이다", () => {
    const r = sumRange([], undefined, TODAY, "mtd");
    assert.equal(r.costUsd, 0);
    assert.deepEqual(r.items, []);
    assert.equal(r.date, TODAY);
  });

  /** NaN 하나가 합계 전체를 NaN 으로 만들면 화면이 "—" 로 죽는다. */
  it("망가진 숫자는 건너뛴다", () => {
    const bad: DailyPoint = {
      date: "2026-09-01",
      costUsd: 1,
      metrics: { totalTokens: NaN, cost: 5 },
      items: [],
    };
    const r = sumRange([bad], today, TODAY, "mtd");
    assert.equal(r.metrics.totalTokens, 50); // 오늘치만
    assert.equal(r.metrics.cost, 5);
  });
});

describe("isLiveRange / rangeNote", () => {
  it("아는 값만 통과시킨다", () => {
    assert.ok(isLiveRange("today") && isLiveRange("7d") && isLiveRange("mtd"));
    for (const bad of ["30d", "", null, undefined, 7]) {
      assert.equal(isLiveRange(bad), false);
    }
  });

  it("구간마다 다른 설명을 준다", () => {
    const notes = (["today", "7d", "mtd"] as const).map((r) => rangeNote(TODAY, r));
    assert.equal(new Set(notes).size, 3);
    assert.match(notes[2], /2026-09-01/);
  });
});
