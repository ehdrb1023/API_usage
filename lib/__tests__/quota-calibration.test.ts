/**
 * 구독 한도 보정 — 구간 추출·리셋 판정·중앙값.
 *
 * ★ 표시한 케이스는 **실제로 났던 고장**이다. 지우지 말 것.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  calibrate,
  sameWindow,
  segments,
  totalWithCacheRead,
  totalWithoutCacheRead,
  type CalibWindow,
  type Snapshot,
} from "@/lib/quota-calibration";

const ACCOUNT = {
  uuid: "test-uuid",
  email: "test@example.com",
  organization: null,
  tier: "default_claude_max_20x",
};

function tokens(over: Partial<{ input: number; cacheRead: number; cacheWrite: number; output: number; calls: number }> = {}) {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 1, ...over };
}

function snapshot(
  at: string,
  windows: CalibWindow[],
  over: Partial<Snapshot> = {},
): Snapshot {
  return {
    at,
    account: ACCOUNT,
    windows,
    since: null,
    tokens: null,
    byModel: null,
    ...over,
  };
}

function weekly(usedPercent: number, resetsAt: string | null): CalibWindow {
  return { key: "weekly_all", label: "이번 주", usedPercent, resetsAt };
}

describe("quota-calibration/sameWindow", () => {
  it("★ resets_at 의 마이크로초 흔들림은 리셋이 아니다", () => {
    // 벤더가 호출마다 다시 계산해서 내려준다. 실측된 두 값이다.
    const before = weekly(2, "2026-09-07T10:09:59.802554+00:00");
    const after = weekly(4, "2026-09-07T10:09:59.840651+00:00");
    assert.equal(sameWindow(before, after), true);
  });

  it("창 길이만큼 점프하면 리셋이다", () => {
    const before = weekly(90, "2026-09-07T10:09:59.000Z");
    const after = weekly(3, "2026-09-07T15:09:59.000Z"); // +5시간
    assert.equal(sameWindow(before, after), false);
  });

  it("resets_at 이 없는 창은 시각으로 못 가른다 — 같은 창으로 본다", () => {
    // weekly_scoped 는 실측에서 resets_at 이 null 로 온다.
    // 퍼센트 감소 검사가 뒤에서 받는다.
    assert.equal(sameWindow(weekly(5, null), weekly(9, null)), true);
  });
});

describe("quota-calibration/segments", () => {
  it("★ 마이크로초가 흔들려도 구간이 살아남는다", () => {
    // 이걸 문자열로 비교하면 유효 구간이 영원히 0 이 되는데 화면은 정상으로 보인다.
    const segs = segments([
      snapshot("2026-09-07T00:00:00.000Z", [weekly(10, "2026-09-13T09:59:59.802554+00:00")]),
      snapshot("2026-09-07T06:00:00.000Z", [weekly(14, "2026-09-13T09:59:59.840651+00:00")], {
        since: "2026-09-07T00:00:00.000Z",
        tokens: tokens({ output: 400, cacheRead: 3600 }),
      }),
    ]);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].reject, null);
    assert.equal(segs[0].deltaPercent, 4);
  });

  it("1% 당 토큰을 캐시읽기 포함/제외 두 가지로 낸다", () => {
    const segs = segments([
      snapshot("2026-09-07T00:00:00.000Z", [weekly(10, "2026-09-13T09:59:59.000Z")]),
      snapshot("2026-09-07T06:00:00.000Z", [weekly(20, "2026-09-13T09:59:59.000Z")], {
        since: "2026-09-07T00:00:00.000Z",
        tokens: tokens({ input: 100, cacheWrite: 400, output: 500, cacheRead: 9000 }),
      }),
    ]);
    const [seg] = segs;
    assert.equal(seg.deltaPercent, 10);
    // 포함 10,000 / 10%p = 1,000 · 제외 1,000 / 10%p = 100
    assert.equal(seg.perPercentWithCacheRead, 1000);
    assert.equal(seg.perPercentWithoutCacheRead, 100);
  });

  it("리셋된 구간은 버리고 사유를 남긴다 — 조용히 사라지지 않는다", () => {
    const segs = segments([
      snapshot("2026-09-07T00:00:00.000Z", [weekly(90, "2026-09-07T10:00:00.000Z")]),
      snapshot("2026-09-07T11:00:00.000Z", [weekly(3, "2026-09-07T15:00:00.000Z")], {
        since: "2026-09-07T00:00:00.000Z",
        tokens: tokens({ output: 1000 }),
      }),
    ]);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].reject, "창이 리셋됐다");
    // 버린 구간은 환산값을 내지 않는다 — 음수가 새어 나가면 안 된다.
    assert.equal(segs[0].perPercentWithCacheRead, 0);
  });

  it("Δ가 1%p 면 반올림 오차가 커서 쓰지 않는다", () => {
    const segs = segments([
      snapshot("2026-09-07T00:00:00.000Z", [weekly(10, "2026-09-13T09:59:59.000Z")]),
      snapshot("2026-09-07T01:00:00.000Z", [weekly(11, "2026-09-13T09:59:59.000Z")], {
        since: "2026-09-07T00:00:00.000Z",
        tokens: tokens({ output: 1000 }),
      }),
    ]);
    assert.equal(segs[0].reject, "Δ가 1%p — 반올림 오차가 커서 쓰지 않는다");
  });

  it("퍼센트가 그대로면 나눗셈을 하지 않는다", () => {
    const segs = segments([
      snapshot("2026-09-07T00:00:00.000Z", [weekly(10, "2026-09-13T09:59:59.000Z")]),
      snapshot("2026-09-07T00:00:10.000Z", [weekly(10, "2026-09-13T09:59:59.000Z")], {
        since: "2026-09-07T00:00:00.000Z",
        tokens: tokens({ output: 5 }),
      }),
    ]);
    assert.equal(segs[0].reject, "퍼센트가 안 움직였다 (구간이 짧다)");
    assert.ok(Number.isFinite(segs[0].perPercentWithCacheRead));
  });

  it("토큰이 없는 스냅샷(첫 장)은 구간을 만들지 않는다", () => {
    const segs = segments([
      snapshot("2026-09-07T00:00:00.000Z", [weekly(10, "2026-09-13T09:59:59.000Z")]),
    ]);
    assert.equal(segs.length, 0);
  });
});

describe("quota-calibration/calibrate", () => {
  const base = "2026-09-13T09:59:59.000Z";

  function run(pairs: Array<[number, number, number]>) {
    // [이전%, 이후%, 캐시읽기 토큰]
    const snaps: Snapshot[] = [
      snapshot("2026-09-07T00:00:00.000Z", [weekly(pairs[0][0], base)]),
    ];
    let t = 0;
    for (const [, after, cacheRead] of pairs) {
      t += 1;
      snaps.push(
        snapshot(`2026-09-07T${String(t).padStart(2, "0")}:00:00.000Z`, [weekly(after, base)], {
          since: snaps[snaps.length - 1].at,
          tokens: tokens({ cacheRead }),
        }),
      );
    }
    return calibrate(segments(snaps));
  }

  it("중앙값을 쓴다 — 이상치 한 구간이 전체를 끌지 않는다", () => {
    // 10%p 당 1,000 / 1,100 / 100,000(이상치). 평균이면 34,033 이 된다.
    const [c] = run([
      [0, 10, 10_000],
      [10, 20, 11_000],
      [20, 30, 1_000_000],
    ]);
    assert.equal(c.used, 3);
    assert.equal(c.perPercentWithCacheRead, 1100);
  });

  it("흔들림 폭을 감추지 않는다", () => {
    const [c] = run([
      [0, 10, 10_000],
      [10, 20, 11_000],
      [20, 30, 1_000_000],
    ]);
    assert.deepEqual(c.spreadWithCacheRead, [1000, 100_000]);
  });

  it("유효 구간이 없으면 null 이다 — 0 으로 접지 않는다", () => {
    // 0 을 돌려주면 "남은 0 토큰" 이라는 거짓 확신이 생긴다.
    const [c] = run([[0, 0, 5_000]]);
    assert.equal(c.used, 0);
    assert.equal(c.perPercentWithCacheRead, null);
    assert.equal(c.perPercentWithoutCacheRead, null);
    assert.deepEqual(c.rejected, { "퍼센트가 안 움직였다 (구간이 짧다)": 1 });
  });
});

describe("quota-calibration/합계", () => {
  it("캐시읽기 포함과 제외가 실제로 다르다", () => {
    const t = tokens({ input: 10, cacheWrite: 20, output: 30, cacheRead: 9940 });
    assert.equal(totalWithCacheRead(t), 10_000);
    assert.equal(totalWithoutCacheRead(t), 60);
  });
});
