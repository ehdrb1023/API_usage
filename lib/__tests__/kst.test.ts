/**
 * lib/kst.ts 유닛 테스트.
 *
 * 여기서 확인하려는 것은 하나다 — **서버 로컬 타임존에 흔들리지 않는가**.
 * 개발 머신은 KST, 배포처(Vercel)는 UTC 라, 로컬 타임존을 한 번이라도 타면
 * "내 노트북에선 맞는데 배포하면 하루가 어긋나는" 버그가 된다.
 *
 * 실행:
 *   node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/**\/__tests__/*.test.ts"
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatKstDate, kstDay, kstDayStart, kstTime, kstTodayWindow } from "@/lib/kst";

describe("kstDay", () => {
  it("UTC 15:00 을 경계로 날짜가 넘어간다 (= KST 자정)", () => {
    assert.equal(kstDay(new Date("2026-08-24T14:59:59Z")), "2026-08-24");
    assert.equal(kstDay(new Date("2026-08-24T15:00:00Z")), "2026-08-25");
  });

  it("UTC 자정 직후는 이미 KST 로 같은 날 오전 9시다", () => {
    assert.equal(kstDay(new Date("2026-08-25T00:00:00Z")), "2026-08-25");
    assert.equal(kstTime(new Date("2026-08-25T00:00:00Z")), "09:00");
  });
});

describe("kstDayStart", () => {
  it("KST 날짜의 00:00 은 전날 UTC 15:00 이다", () => {
    assert.equal(
      kstDayStart("2026-08-25").toISOString(),
      "2026-08-24T15:00:00.000Z",
    );
  });

  it("kstDay 와 왕복해도 같은 날짜다", () => {
    for (const iso of [
      "2026-01-01T00:00:00Z",
      "2026-08-24T15:00:00Z",
      "2026-12-31T23:59:59Z",
    ]) {
      const date = kstDay(new Date(iso));
      assert.equal(kstDay(kstDayStart(date)), date);
    }
  });
});

describe("kstTodayWindow", () => {
  it("KST 자정부터 '다음 정시' 까지를 연다", () => {
    // KST 2026-08-25 14:30 = UTC 05:30
    const w = kstTodayWindow(new Date("2026-08-25T05:30:00Z"));
    assert.equal(w.date, "2026-08-25");
    assert.equal(w.from, "2026-08-24T15:00:00.000Z");
    // 내림하면 진행 중인 05:00~06:00 버킷이 통째로 빠진다 → 올림이어야 한다.
    assert.equal(w.to, "2026-08-25T06:00:00.000Z");
    assert.equal(w.hours, 15);
  });

  it("KST 자정 직후에도 버킷이 최소 하나는 열린다", () => {
    const w = kstTodayWindow(new Date("2026-08-24T15:00:01Z"));
    assert.equal(w.date, "2026-08-25");
    assert.equal(w.hours, 1);
  });

  it("KST 하루가 다 차도 24버킷을 넘지 않는다", () => {
    const w = kstTodayWindow(new Date("2026-08-25T14:59:59Z"));
    assert.equal(w.date, "2026-08-25");
    assert.equal(w.hours, 24);
  });
});

describe("formatKstDate", () => {
  it("요일까지 붙인다", () => {
    assert.equal(formatKstDate("2026-08-25"), "8월 25일 (화)");
  });
});
