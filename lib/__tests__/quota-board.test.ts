/**
 * 보드 집계 — 접기·라벨·구간 경계.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildBoard,
  pickSession,
  projectLabel,
  rangeStart,
  total,
  totalWithoutCache,
} from "@/lib/quota-board";
import type { LocalRow, ToolEvent } from "@/lib/local/scan";

function row(over: Partial<LocalRow> = {}): LocalRow {
  return {
    ts: "2026-09-07T01:00:00.000Z",
    model: "claude-opus-5",
    sessionId: "s1",
    cwd: "/home/me/API_usage",
    projectDir: "-home-me-API-usage",
    branch: null,
    sidechain: false,
    speed: "standard",
    tier: "standard",
    input: 10,
    cacheRead: 900,
    cacheWrite5m: 60,
    cacheWrite1h: 0,
    output: 30,
    ...over,
  };
}

function tool(over: Partial<ToolEvent> = {}): ToolEvent {
  return {
    ts: "2026-09-07T01:00:00.000Z",
    name: "Bash",
    command: "git",
    sessionId: "s1",
    projectDir: "-home-me-API-usage",
    ...over,
  };
}

describe("quota-board/buildBoard", () => {
  it("모든 축의 토큰 합이 전체와 같다", () => {
    const rows = [
      row({ sessionId: "s1", cwd: "/home/me/alpha" }),
      row({ sessionId: "s2", cwd: "/home/me/beta", model: "claude-sonnet-5" }),
      row({ sessionId: "s2", cwd: "/home/me/beta", ts: "2026-09-08T01:00:00.000Z" }),
    ];
    const board = buildBoard(rows, []);
    const whole = total(board.totals);

    for (const axis of [board.daily, board.byProject, board.byModel]) {
      assert.equal(axis.reduce((n, b) => n + total(b), 0), whole);
    }
    assert.equal(board.totals.calls, 3);
    assert.equal(board.sessions, 2);
  });

  it("캐시히트율은 캐시읽기 / (읽기+생성+입력) 이다 — 출력은 분모가 아니다", () => {
    // 출력은 캐시 대상이 아니다. 분모에 넣으면 비율이 사용량에 따라 흔들린다.
    const board = buildBoard(
      [row({ input: 10, cacheRead: 900, cacheWrite5m: 90, cacheWrite1h: 0, output: 99999 })],
      [],
    );
    assert.equal(board.cacheHitRate, 0.9);
  });

  it("로그가 비면 0 으로 나누지 않는다", () => {
    const board = buildBoard([], []);
    assert.equal(board.cacheHitRate, 0);
    assert.equal(board.sessions, 0);
    assert.deepEqual(board.daily, []);
  });

  it("도구와 셸 명령을 따로 센다", () => {
    const board = buildBoard(
      [row()],
      [
        tool({ name: "Bash", command: "git" }),
        tool({ name: "Bash", command: "git" }),
        tool({ name: "Bash", command: "npm" }),
        tool({ name: "Read", command: null }),
      ],
    );
    assert.deepEqual(board.tools, [
      { key: "Bash", calls: 3 },
      { key: "Read", calls: 1 },
    ]);
    // command 가 null 인 도구는 셸 목록에 안 들어간다.
    assert.deepEqual(board.shell, [
      { key: "git", calls: 2 },
      { key: "npm", calls: 1 },
    ]);
  });

  it("날짜는 최신 우선, 나머지 축은 쓴 양 순이다", () => {
    const board = buildBoard(
      [
        row({ ts: "2026-09-05T01:00:00.000Z", cwd: "/home/me/small", output: 1 }),
        row({ ts: "2026-09-07T01:00:00.000Z", cwd: "/home/me/big", output: 9999 }),
      ],
      [],
    );
    assert.deepEqual(board.daily.map((b) => b.key), ["2026-09-07", "2026-09-05"]);
    assert.deepEqual(board.byProject.map((b) => b.key), ["big", "small"]);
  });

  it("KST 자정으로 날짜를 접는다 — UTC 자정이 아니다", () => {
    // 2026-09-07T00:30Z = KST 09-07 09:30. UTC 로 자르면 같은 날이지만
    // 2026-09-06T16:00Z = KST 09-07 01:00 이라 KST 로는 같은 날이어야 한다.
    const board = buildBoard(
      [row({ ts: "2026-09-06T16:00:00.000Z" }), row({ ts: "2026-09-07T00:30:00.000Z" })],
      [],
    );
    assert.deepEqual(board.daily.map((b) => b.key), ["2026-09-07"]);
  });
});

describe("quota-board/projectLabel", () => {
  it("cwd 의 마지막 자리를 쓴다", () => {
    assert.equal(projectLabel(row({ cwd: "/home/me/API_usage" })), "API_usage");
  });

  it("cwd 가 없으면 projectDir 에서 뽑는다", () => {
    assert.equal(
      projectLabel(row({ cwd: "", projectDir: "-home-martin1023-API-usage" })),
      "usage",
    );
  });

  it("둘 다 없으면 버리지 않고 표시한다 — 합계가 어긋나면 안 된다", () => {
    assert.equal(projectLabel(row({ cwd: "", projectDir: "" })), "(알 수 없음)");
  });
});

describe("quota-board/rangeStart", () => {
  const now = new Date("2026-09-07T05:00:00.000Z"); // KST 09-07 14:00

  it("today 는 KST 자정이다", () => {
    // KST 09-07 00:00 = UTC 09-06 15:00
    assert.equal(rangeStart("today", now), "2026-09-06T15:00:00.000Z");
  });

  it("7d 는 오늘 포함 7일이다", () => {
    assert.equal(rangeStart("7d", now), "2026-08-31T15:00:00.000Z");
  });

  it("모르는 구간은 조용히 넘기지 않고 던진다", () => {
    assert.throws(() => rangeStart("1y", now), /알 수 없는 구간/);
  });
});

describe("quota-board/합계", () => {
  it("캐시읽기 포함과 제외를 구분한다", () => {
    const board = buildBoard([row({ input: 10, cacheRead: 900, cacheWrite5m: 60, output: 30 })], []);
    assert.equal(total(board.totals), 1000);
    assert.equal(totalWithoutCache(board.totals), 100);
  });
});

describe("quota-board/bySession", () => {
  it("최근 활동 순이다 — 쓴 양 순이 아니다", () => {
    // "지금 이 세션 얼마 썼나" 가 이 축을 보는 이유다. 맨 위가 최근이어야 한다.
    const board = buildBoard(
      [
        row({ sessionId: "big", ts: "2026-09-07T01:00:00.000Z", output: 99999 }),
        row({ sessionId: "recent", ts: "2026-09-07T05:00:00.000Z", output: 1 }),
      ],
      [],
    );
    assert.deepEqual(board.bySession.map((b) => b.key), ["recent", "big"]);
  });

  it("세션 제목이 있으면 라벨로 쓴다", () => {
    const board = buildBoard([row({ sessionId: "abcdef123456" })], [], new Map([["abcdef123456", "토큰 추적"]]));
    assert.equal(board.bySession[0].label, "토큰 추적");
  });

  it("제목이 없으면 sessionId 앞자리로 대신한다 — 빈 라벨을 만들지 않는다", () => {
    const board = buildBoard([row({ sessionId: "abcdef123456" })], []);
    assert.equal(board.bySession[0].label, "abcdef12");
  });

  it("세션 id 를 넘기면 그 세션이 현재다", () => {
    const board = buildBoard(
      [
        row({ sessionId: "mine", ts: "2026-09-07T01:00:00.000Z" }),
        row({ sessionId: "other", ts: "2026-09-07T09:00:00.000Z" }),
      ],
      [],
      new Map(),
      "mine",
    );
    // 더 최근인 other 가 아니라 지정한 mine 이 현재여야 한다.
    assert.deepEqual(
      board.bySession.filter((b) => b.isCurrent).map((b) => b.key),
      ["mine"],
    );
  });

  it("세션 id 가 없으면 가장 최근 세션으로 대신한다", () => {
    const board = buildBoard(
      [
        row({ sessionId: "old", ts: "2026-09-07T01:00:00.000Z" }),
        row({ sessionId: "new", ts: "2026-09-07T09:00:00.000Z" }),
      ],
      [],
    );
    assert.deepEqual(
      board.bySession.filter((b) => b.isCurrent).map((b) => b.key),
      ["new"],
    );
  });

  it("현재 세션은 최대 하나다", () => {
    const board = buildBoard(
      [row({ sessionId: "a" }), row({ sessionId: "b", ts: "2026-09-07T02:00:00.000Z" })],
      [],
    );
    assert.equal(board.bySession.filter((b) => b.isCurrent).length, 1);
  });
});

describe("quota-board/pickSession", () => {
  const sessions = [
    { key: "f6fee229-aaa", label: "토큰 사용량 추적", lastTs: "", isCurrent: true, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 },
    { key: "665b4a43-bbb", label: "El-transaction 테스트", lastTs: "", isCurrent: false, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 },
    { key: "666359cd-ccc", label: "훅 우회해서 push", lastTs: "", isCurrent: false, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 },
  ];

  it("세션 id 앞자리로 고른다", () => {
    assert.equal(pickSession(sessions, "665b4a43").match?.key, "665b4a43-bbb");
  });

  it("제목 일부로 고른다", () => {
    assert.equal(pickSession(sessions, "훅 우회").match?.key, "666359cd-ccc");
  });

  it("대소문자를 안 가린다", () => {
    assert.equal(pickSession(sessions, "EL-TRANSACTION").match?.key, "665b4a43-bbb");
  });

  it("★ 여러 개 걸리면 고르지 않고 후보를 준다", () => {
    // 임의로 하나를 집으면 무엇을 보고 있는지 모른 채 숫자를 읽게 된다.
    const r = pickSession(sessions, "66");
    assert.equal(r.match, null);
    assert.deepEqual(r.candidates.map((s) => s.key), ["665b4a43-bbb", "666359cd-ccc"]);
  });

  it("하나도 없으면 빈 후보를 준다", () => {
    const r = pickSession(sessions, "zzzz");
    assert.equal(r.match, null);
    assert.deepEqual(r.candidates, []);
  });

  it("id 앞자리가 제목 우연 일치를 이긴다", () => {
    const mixed = [
      { ...sessions[0], key: "abc12345", label: "무관" },
      { ...sessions[1], key: "zzz99999", label: "abc12345 를 언급한 세션" },
    ];
    assert.equal(pickSession(mixed, "abc12345").match?.key, "abc12345");
  });

  it("빈 검색어는 아무것도 고르지 않는다", () => {
    assert.equal(pickSession(sessions, "   ").match, null);
  });
});
