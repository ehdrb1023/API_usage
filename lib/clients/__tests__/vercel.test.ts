/**
 * lib/clients/vercel.ts 유닛 테스트 — 전부 목(mock) 응답입니다.
 * 네트워크를 타지 않고, 실제 토큰도 필요 없습니다.
 *
 * 실행:
 *   node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/clients/__tests__/*.test.ts"
 */

import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";

import {
  VERCEL_BILLING_CHARGES_PATH,
  fetchVercelBillingCharges,
  parseFocusChargesJsonl,
  resolveVercelConfig,
  sumChargesByDay,
  sumChargesByProject,
} from "../vercel";
import { ApiClientError, MissingCredentialError } from "../types";
import type { VercelFocusCharge } from "../types";

// ---------------------------------------------------------------- 목 헬퍼

interface RecordedCall {
  url: URL;
  headers: Record<string, string>;
}

function mockFetch(responses: Response[]) {
  const calls: RecordedCall[] = [];
  const queue = [...responses];

  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    calls.push({
      url: new URL(String(input)),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = queue.shift();
    if (!next) throw new Error("목 응답이 부족합니다 (예상보다 많이 호출됨).");
    return next;
  };

  return { fetchImpl, calls };
}

/** 실제 응답은 JSONL 이므로 배열이 아니라 줄바꿈으로 이어 붙인다. */
function jsonl(records: unknown[], status = 200): Response {
  const body = records.map((r) => JSON.stringify(r)).join("\n");
  return new Response(body, {
    status,
    headers: { "content-type": "application/jsonl" },
  });
}

const TOKEN = { apiToken: "vercel_test_token" };
const RANGE = { from: "2026-08-01T00:00:00Z", to: "2026-08-08T00:00:00Z" };

function charge(overrides: Partial<VercelFocusCharge> = {}): VercelFocusCharge {
  return {
    BilledCost: 0.358104,
    EffectiveCost: 0.358104,
    BillingCurrency: "USD",
    PricingCurrency: "USD",
    ChargeCategory: "Usage",
    ChargePeriodStart: "2026-08-01T00:00:00Z",
    ChargePeriodEnd: "2026-08-02T00:00:00Z",
    ConsumedQuantity: 44.763,
    ConsumedUnit: "build-minutes",
    PricingQuantity: 44.763,
    PricingUnit: "build-minute",
    PricingCategory: "Standard",
    ServiceName: "Build Execution",
    ServiceProviderName: "Vercel",
    ServiceCategory: "Compute",
    RegionId: "icn1",
    RegionName: "Seoul",
    Tags: { ProjectId: "prj_8Kq2mNvR4tXwL9pC", ProjectName: "api-usage-dashboard" },
    ...overrides,
  };
}

const savedEnv = {
  VERCEL_API_TOKEN: process.env.VERCEL_API_TOKEN,
  VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID,
  VERCEL_API_BASE: process.env.VERCEL_API_BASE,
};

beforeEach(() => {
  delete process.env.VERCEL_API_TOKEN;
  delete process.env.VERCEL_TEAM_ID;
  delete process.env.VERCEL_API_BASE;
});

after(() => {
  Object.assign(process.env, savedEnv);
});

// ---------------------------------------------------------------- 토큰 검사

describe("토큰이 없을 때", () => {
  it("VERCEL_API_TOKEN 이 없으면 발급 경로까지 알려주며 던진다", async () => {
    await assert.rejects(
      () => fetchVercelBillingCharges(RANGE),
      (error: unknown) => {
        assert.ok(error instanceof MissingCredentialError);
        assert.equal(error.envVar, "VERCEL_API_TOKEN");
        assert.match(error.message, /VERCEL_API_TOKEN이 \.env에 없습니다/);
        assert.match(error.message, /Account Settings → Tokens/);
        return true;
      },
    );
  });

  it("토큰이 없으면 네트워크 호출 자체를 하지 않는다", async () => {
    const { fetchImpl, calls } = mockFetch([jsonl([charge()])]);
    await assert.rejects(() => fetchVercelBillingCharges(RANGE, { fetch: fetchImpl }));
    assert.equal(calls.length, 0);
  });

  it("VERCEL_TEAM_ID 는 없어도 된다 (개인 스코프 조회)", () => {
    process.env.VERCEL_API_TOKEN = "vercel_env_token";
    const config = resolveVercelConfig();
    assert.equal(config.apiToken, "vercel_env_token");
    assert.equal(config.teamId, undefined);
  });
});

// ---------------------------------------------------------------- 요청 조립

describe("요청 조립", () => {
  it("경로·헤더·쿼리를 2026-02-19 changelog 스펙대로 만든다", async () => {
    const { fetchImpl, calls } = mockFetch([jsonl([charge()])]);

    await fetchVercelBillingCharges(
      { ...RANGE, teamId: "team_abc123" },
      { ...TOKEN, fetch: fetchImpl },
    );

    const { url, headers } = calls[0];
    assert.equal(url.origin, "https://api.vercel.com");
    assert.equal(url.pathname, VERCEL_BILLING_CHARGES_PATH);
    assert.equal(url.searchParams.get("from"), RANGE.from);
    assert.equal(url.searchParams.get("to"), RANGE.to);
    assert.equal(url.searchParams.get("teamId"), "team_abc123");

    // Anthropic 과 달리 Bearer 토큰.
    assert.equal(headers.Authorization, `Bearer ${TOKEN.apiToken}`);
    assert.equal(headers.accept, "application/jsonl");
    assert.ok(!url.toString().includes(TOKEN.apiToken));
  });

  it("teamId 가 없으면 VERCEL_TEAM_ID 를 쓰고, 그것도 없으면 쿼리에서 뺀다", async () => {
    process.env.VERCEL_TEAM_ID = "team_from_env";
    const { fetchImpl, calls } = mockFetch([jsonl([]), jsonl([])]);

    await fetchVercelBillingCharges(RANGE, { ...TOKEN, fetch: fetchImpl });
    assert.equal(calls[0].url.searchParams.get("teamId"), "team_from_env");

    delete process.env.VERCEL_TEAM_ID;
    await fetchVercelBillingCharges(RANGE, { ...TOKEN, fetch: fetchImpl });
    assert.equal(calls[1].url.searchParams.get("teamId"), null);
  });

  it("slug 를 주면 teamId 대신 slug 로도 지정할 수 있다", async () => {
    const { fetchImpl, calls } = mockFetch([jsonl([])]);

    await fetchVercelBillingCharges(
      { ...RANGE, slug: "my-team" },
      { ...TOKEN, fetch: fetchImpl },
    );

    assert.equal(calls[0].url.searchParams.get("slug"), "my-team");
    assert.equal(calls[0].url.searchParams.get("teamId"), null);
  });
});

// ---------------------------------------------------------------- 구간 검증

describe("조회 구간 검증 (요청 전에 걸러낸다)", () => {
  it("to 가 from 보다 앞이면 던진다", async () => {
    await assert.rejects(
      () =>
        fetchVercelBillingCharges(
          { from: "2026-08-08T00:00:00Z", to: "2026-08-01T00:00:00Z" },
          TOKEN,
        ),
      RangeError,
    );
  });

  it("from === to 도 던진다 (to 는 exclusive 라 빈 구간)", async () => {
    await assert.rejects(
      () => fetchVercelBillingCharges({ from: RANGE.from, to: RANGE.from }, TOKEN),
      RangeError,
    );
  });

  it("1년을 넘는 범위는 던진다", async () => {
    await assert.rejects(
      () =>
        fetchVercelBillingCharges(
          { from: "2025-01-01T00:00:00Z", to: "2026-08-01T00:00:00Z" },
          TOKEN,
        ),
      (error: unknown) => {
        assert.ok(error instanceof RangeError);
        assert.match(error.message, /최대 1년/);
        return true;
      },
    );
  });

  it("ISO 8601 이 아니면 던진다", async () => {
    await assert.rejects(
      () => fetchVercelBillingCharges({ from: "어제", to: RANGE.to }, TOKEN),
      TypeError,
    );
  });
});

// ---------------------------------------------------------------- JSONL 파싱

describe("JSONL 파싱", () => {
  it("한 줄에 charge 1건으로 파싱한다", async () => {
    const records = [charge(), charge({ ServiceName: "Function Invocations" })];
    const { fetchImpl } = mockFetch([jsonl(records)]);

    const charges = await fetchVercelBillingCharges(RANGE, {
      ...TOKEN,
      fetch: fetchImpl,
    });

    assert.equal(charges.length, 2);
    assert.equal(charges[0].ServiceName, "Build Execution");
    assert.equal(charges[1].ServiceName, "Function Invocations");
    assert.equal(charges[0].Tags.ProjectName, "api-usage-dashboard");
  });

  it("빈 줄과 끝 줄바꿈을 건너뛴다", () => {
    const text = `${JSON.stringify(charge())}\n\n${JSON.stringify(charge())}\n`;
    assert.equal(parseFocusChargesJsonl(text).length, 2);
  });

  it("본문이 비어 있으면 빈 배열 (Hobby 플랜 정상 케이스)", async () => {
    const { fetchImpl } = mockFetch([
      new Response("", { status: 200, headers: { "content-type": "application/jsonl" } }),
    ]);

    const charges = await fetchVercelBillingCharges(RANGE, {
      ...TOKEN,
      fetch: fetchImpl,
    });

    assert.deepEqual(charges, []);
  });

  it("깨진 줄은 조용히 버리지 않고 몇 번째 줄인지 알려주며 던진다", () => {
    const text = `${JSON.stringify(charge())}\n{ 깨진 줄 \n${JSON.stringify(charge())}`;
    assert.throws(
      () => parseFocusChargesJsonl(text),
      (error: unknown) => {
        assert.ok(error instanceof SyntaxError);
        assert.match(error.message, /2번째 줄/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------- 에러 처리

describe("HTTP 에러", () => {
  it("403 이면 역할·토큰 scope 힌트를 담은 ApiClientError 를 던진다", async () => {
    const { fetchImpl } = mockFetch([
      new Response(JSON.stringify({ error: { message: "not authorized" } }), {
        status: 403,
      }),
    ]);

    await assert.rejects(
      () => fetchVercelBillingCharges(RANGE, { ...TOKEN, fetch: fetchImpl }),
      (error: unknown) => {
        assert.ok(error instanceof ApiClientError);
        assert.equal(error.vendor, "vercel");
        assert.equal(error.status, 403);
        assert.match(error.message, /Billing/);
        assert.match(error.body, /not authorized/);
        return true;
      },
    );
  });

  it("401 이면 토큰 재발급 힌트를 담는다", async () => {
    const { fetchImpl } = mockFetch([new Response("unauthorized", { status: 401 })]);

    await assert.rejects(
      () => fetchVercelBillingCharges(RANGE, { ...TOKEN, fetch: fetchImpl }),
      (error: unknown) => {
        assert.ok(error instanceof ApiClientError);
        assert.equal(error.status, 401);
        assert.match(error.message, /재발급/);
        return true;
      },
    );
  });

  // 2026-08-14 실측: 청구 데이터가 아직 없는 구간을 조회하면 빈 배열이 아니라
  // 404 costs_not_found 가 온다. 진짜 에러가 아니므로 빈 배열로 바꿔 돌려준다.
  it("404 costs_not_found 는 던지지 않고 빈 배열을 돌려준다", async () => {
    const { fetchImpl } = mockFetch([
      new Response(
        JSON.stringify({ error: { code: "costs_not_found", message: "Costs not found" } }),
        { status: 404 },
      ),
    ]);

    const charges = await fetchVercelBillingCharges(RANGE, { ...TOKEN, fetch: fetchImpl });
    assert.deepEqual(charges, []);
  });

  it("costs_not_found 가 아닌 404 는 그대로 던진다", async () => {
    const { fetchImpl } = mockFetch([
      new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 }),
    ]);

    await assert.rejects(
      () => fetchVercelBillingCharges(RANGE, { ...TOKEN, fetch: fetchImpl }),
      (error: unknown) => {
        assert.ok(error instanceof ApiClientError);
        assert.equal(error.status, 404);
        return true;
      },
    );
  });

  it("본문이 JSON 이 아닌 404 도 그대로 던진다 (조용히 삼키지 않는다)", async () => {
    const { fetchImpl } = mockFetch([new Response("<html>Not Found</html>", { status: 404 })]);

    await assert.rejects(
      () => fetchVercelBillingCharges(RANGE, { ...TOKEN, fetch: fetchImpl }),
      (error: unknown) => {
        assert.ok(error instanceof ApiClientError);
        assert.equal(error.status, 404);
        return true;
      },
    );
  });

  it("403 은 계속 던진다 — 잘못된 teamId·토큰은 404 가 아니라 403 으로 온다", async () => {
    const { fetchImpl } = mockFetch([
      new Response(JSON.stringify({ error: { code: "forbidden", message: "Not authorized" } }), {
        status: 403,
      }),
    ]);

    await assert.rejects(
      () => fetchVercelBillingCharges(RANGE, { ...TOKEN, fetch: fetchImpl }),
      (error: unknown) => {
        assert.ok(error instanceof ApiClientError);
        assert.equal(error.status, 403);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------- 집계 유틸

describe("sumChargesByDay", () => {
  const charges = [
    charge({ BilledCost: 1, EffectiveCost: 1 }),
    charge({ BilledCost: 2, EffectiveCost: 0 }),
    charge({
      ChargePeriodStart: "2026-08-02T00:00:00Z",
      ChargePeriodEnd: "2026-08-03T00:00:00Z",
      BilledCost: 5,
      EffectiveCost: 5,
    }),
  ];

  it("ChargePeriodStart 날짜로 접어 오름차순 정렬한다", () => {
    assert.deepEqual(sumChargesByDay(charges), [
      { date: "2026-08-01", billedCost: 3, effectiveCost: 1 },
      { date: "2026-08-02", billedCost: 5, effectiveCost: 5 },
    ]);
  });

  it("onlyUsage 를 켜면 Credit / Tax / Adjustment 를 뺀다", () => {
    const withCredit = [
      ...charges,
      charge({ ChargeCategory: "Credit", BilledCost: -100, EffectiveCost: -100 }),
      charge({ ChargeCategory: "Tax", BilledCost: 7, EffectiveCost: 7 }),
    ];

    // 필터 없이 = 실제 청구 총액, 필터 있으면 = 사용량 비용. 두 숫자는 다르다.
    const all = sumChargesByDay(withCredit).find((d) => d.date === "2026-08-01");
    const usageOnly = sumChargesByDay(withCredit, { onlyUsage: true }).find(
      (d) => d.date === "2026-08-01",
    );

    assert.equal(all?.billedCost, -90);
    assert.equal(usageOnly?.billedCost, 3);
  });
});

describe("sumChargesByProject", () => {
  it("최상위가 아니라 Tags.ProjectName 으로 묶는다", () => {
    const charges = [
      charge({ BilledCost: 3, Tags: { ProjectName: "dashboard" } }),
      charge({ BilledCost: 1, Tags: { ProjectName: "dashboard" } }),
      charge({ BilledCost: 10, Tags: { ProjectName: "landing" } }),
    ];

    assert.deepEqual(sumChargesByProject(charges), [
      { project: "landing", billedCost: 10, effectiveCost: 0.358104 },
      { project: "dashboard", billedCost: 4, effectiveCost: 0.716208 },
    ]);
  });

  it("Tags 가 비어 있어도 행을 잃지 않는다", () => {
    const rows = sumChargesByProject([charge({ BilledCost: 2, Tags: {} })]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].project, "(프로젝트 미분류)");
    assert.equal(rows[0].billedCost, 2);
  });
});
