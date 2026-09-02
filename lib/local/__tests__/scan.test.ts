/**
 * lib/local/scan.ts + lib/local/live.ts 통합 테스트.
 *
 * 임시 폴더에 진짜 `.jsonl` 을 써서 돌립니다 — 이 코드가 다루는 위험이 전부
 * **파일을 읽는 방식**에 있기 때문입니다. 순수 함수만 검사하면 정작 틀릴 곳을 못 본다.
 *
 * 지키려는 것:
 *   1. ★ 한 응답이 content 블록 수만큼 줄로 쪼개져 있어도 **한 번만** 센다
 *      (실측 중복률 49% — 이게 깨지면 비용이 두 배로 뜬다)
 *   2. 조회 구간(KST 오늘) 밖의 줄은 빠진다
 *   3. 이어 쓴 줄은 **증분으로** 더해진다 (파일을 다시 통째로 읽지 않는다)
 *   4. 모든 축의 합계가 전체와 같다 — 같은 하루를 다르게 쪼갠 것뿐이므로
 *   5. `<synthetic>` 처럼 API 를 부르지 않은 줄은 세지 않는다
 *   6. `session:active` 는 **가장 최근에 응답이 있었던** 세션을 가리킨다
 *
 * 실행:
 *   node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/**\/__tests__/*.test.ts"
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { COST_METRIC_KEY } from "@/lib/live-types";
import { buildLocalLiveService } from "@/lib/local/live";
import { resetScanCache, scanLocalUsage } from "@/lib/local/scan";

/** KST 2026-08-31 한낮. 이 시각을 "지금" 으로 고정해 하루 경계를 흔들지 않는다. */
const NOW = new Date("2026-08-31T05:00:00.000Z"); // = KST 14:00
const TODAY = "2026-08-31T03:00:00.000Z"; // KST 12:00 — 오늘 안
const YESTERDAY = "2026-08-30T03:00:00.000Z"; // KST 어제 — 구간 밖

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cc-logs-"));
  roots.push(root);
  process.env.CLAUDE_PROJECTS_DIR = root;
  resetScanCache();
  return root;
}

after(async () => {
  for (const r of roots) await fs.rm(r, { recursive: true, force: true });
  delete process.env.CLAUDE_PROJECTS_DIR;
});

type LineOpts = {
  ts?: string;
  session?: string;
  cwd?: string;
  branch?: string;
  model?: string;
  msgId?: string;
  reqId?: string;
  output?: number;
  input?: number;
  cacheRead?: number;
  write5m?: number;
};

/** 실제 로그 한 줄과 같은 모양. 필드 이름을 바꾸면 이 테스트가 먼저 깨진다. */
function line(o: LineOpts = {}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: o.ts ?? TODAY,
    sessionId: o.session ?? "s1",
    requestId: o.reqId ?? "req_1",
    cwd: o.cwd ?? "/home/me/proj",
    gitBranch: o.branch ?? "main",
    isSidechain: false,
    message: {
      id: o.msgId ?? "msg_1",
      model: o.model ?? "claude-opus-5",
      usage: {
        input_tokens: o.input ?? 0,
        cache_read_input_tokens: o.cacheRead ?? 0,
        cache_creation: {
          ephemeral_5m_input_tokens: o.write5m ?? 0,
          ephemeral_1h_input_tokens: 0,
        },
        output_tokens: o.output ?? 0,
        speed: "standard",
        service_tier: "standard",
      },
    },
  });
}

async function writeSession(
  root: string,
  bucket: string,
  session: string,
  lines: string[],
): Promise<string> {
  const dir = path.join(root, bucket);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${session}.jsonl`);
  await fs.writeFile(file, lines.join("\n") + "\n", "utf8");
  return file;
}

const costOfEntry = (e: { metrics: Record<string, number> }) => e.metrics[COST_METRIC_KEY];

describe("local/scan", () => {
  beforeEach(resetScanCache);

  it("★ 한 응답이 여러 줄로 쪼개져 있어도 한 번만 센다", async () => {
    const root = await makeRoot();
    // 실제 로그와 같은 상황: 같은 (message.id, requestId) 에 usage 가 통째로 복사된다.
    await writeSession(root, "-home-me-proj", "s1", [
      line({ output: 1000 }),
      line({ output: 1000 }),
      line({ output: 1000 }),
      line({ output: 1000 }),
    ]);

    const { rows } = await scanLocalUsage(YESTERDAY);
    assert.equal(rows.length, 1, "4줄이지만 응답은 하나다");
    assert.equal(rows[0].output, 1000);
  });

  it("requestId 가 다르면 서로 다른 응답이다", async () => {
    const root = await makeRoot();
    await writeSession(root, "-home-me-proj", "s1", [
      line({ msgId: "msg_1", reqId: "req_1", output: 10 }),
      line({ msgId: "msg_2", reqId: "req_2", output: 20 }),
    ]);

    const { rows } = await scanLocalUsage(YESTERDAY);
    assert.equal(rows.length, 2);
  });

  it("`<synthetic>` 은 API 호출이 아니라 세지 않는다", async () => {
    const root = await makeRoot();
    await writeSession(root, "-home-me-proj", "s1", [
      line({ msgId: "m1", reqId: "r1", model: "<synthetic>", output: 999 }),
      line({ msgId: "m2", reqId: "r2", output: 5 }),
    ]);

    const { rows } = await scanLocalUsage(YESTERDAY);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].output, 5);
  });

  it("이어 쓴 줄을 증분으로 읽는다", async () => {
    const root = await makeRoot();
    const file = await writeSession(root, "-home-me-proj", "s1", [
      line({ msgId: "m1", reqId: "r1", output: 10 }),
    ]);

    assert.equal((await scanLocalUsage(YESTERDAY)).rows.length, 1);

    await fs.appendFile(file, line({ msgId: "m2", reqId: "r2", output: 20 }) + "\n");

    const { rows } = await scanLocalUsage(YESTERDAY);
    assert.equal(rows.length, 2);
    assert.equal(
      rows.reduce((s, r) => s + r.output, 0),
      30,
    );
  });

  it("아직 다 쓰이지 않은 마지막 줄은 다음 스캔에서 온전히 읽는다", async () => {
    const root = await makeRoot();
    const file = await writeSession(root, "-home-me-proj", "s1", [
      line({ msgId: "m1", reqId: "r1", output: 10 }),
    ]);

    // 줄바꿈 없이 절반만 쓰인 상태 (파일에 append 되는 중).
    const half = line({ msgId: "m2", reqId: "r2", output: 20 });
    await fs.appendFile(file, half.slice(0, 40));
    assert.equal((await scanLocalUsage(YESTERDAY)).rows.length, 1, "깨진 줄은 세지 않는다");

    // 나머지가 마저 쓰이면 그때 잡힌다.
    await fs.appendFile(file, half.slice(40) + "\n");
    assert.equal((await scanLocalUsage(YESTERDAY)).rows.length, 2);
  });
});

describe("local/live", () => {
  beforeEach(resetScanCache);

  it("KST 오늘 밖의 줄은 집계에서 빠진다", async () => {
    const root = await makeRoot();
    await writeSession(root, "-home-me-proj", "s1", [
      line({ msgId: "m1", reqId: "r1", ts: TODAY, output: 100 }),
      line({ msgId: "m2", reqId: "r2", ts: YESTERDAY, output: 900 }),
    ]);

    const svc = await buildLocalLiveService(NOW);
    const total = svc.groups.find((g) => g.key === "total")!.entries[0];

    assert.equal(svc.date, "2026-08-31");
    assert.equal(total.metrics.outputTokens, 100, "어제 몫은 빠져야 한다");
  });

  it("모든 축의 합계가 전체와 같다", async () => {
    const root = await makeRoot();
    await writeSession(root, "-home-me-a", "s1", [
      line({ msgId: "m1", reqId: "r1", session: "s1", cwd: "/home/me/a", output: 100 }),
    ]);
    await writeSession(root, "-home-me-b", "s2", [
      line({
        msgId: "m2",
        reqId: "r2",
        session: "s2",
        cwd: "/home/me/b",
        branch: "dev",
        output: 250,
      }),
    ]);

    const svc = await buildLocalLiveService(NOW);
    const total = costOfEntry(svc.groups.find((g) => g.key === "total")!.entries[0]);
    assert.ok(total > 0);

    for (const group of svc.groups) {
      if (group.key === "total") continue;
      // 세션 축에는 "지금 세션" 이 한 줄 더 있다 — 같은 세션을 가리키는 사본이라 뺀다.
      const rows = group.entries.filter((e) => e.id !== "session:active");
      const sum = rows.reduce((s, e) => s + costOfEntry(e), 0);
      assert.ok(
        Math.abs(sum - total) < 1e-9,
        `${group.key} 축 합계(${sum})가 전체(${total})와 다르다`,
      );
    }
  });

  it("session:active 는 가장 최근에 응답이 있었던 세션을 가리킨다", async () => {
    const root = await makeRoot();
    await writeSession(root, "-home-me-a", "old", [
      line({
        msgId: "m1",
        reqId: "r1",
        session: "old",
        ts: "2026-08-31T01:00:00.000Z",
        output: 900,
      }),
    ]);
    await writeSession(root, "-home-me-b", "new", [
      line({
        msgId: "m2",
        reqId: "r2",
        session: "new",
        ts: "2026-08-31T04:00:00.000Z",
        output: 10,
      }),
    ]);

    const svc = await buildLocalLiveService(NOW);
    const active = svc.groups
      .find((g) => g.key === "session")!
      .entries.find((e) => e.id === "session:active")!;

    // 비용이 아니라 **시각**으로 고른다. 많이 쓴 세션이 아니라 지금 쓰는 세션이다.
    assert.equal(active.title, "new");
    assert.equal(active.metrics.outputTokens, 10);
  });

  it("로그 폴더가 비어 있어도 오늘 줄은 0 으로 남는다", async () => {
    await makeRoot();
    const svc = await buildLocalLiveService(NOW);
    const total = svc.groups.find((g) => g.key === "total")!.entries[0];

    assert.equal(total.metrics[COST_METRIC_KEY], 0);
    assert.equal(svc.error, undefined);
  });
});
