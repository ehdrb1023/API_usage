/**
 * lib/adapters/supabase.ts 유닛 테스트 — 순수 함수라 네트워크·파일을 타지 않습니다.
 *
 * 초점은 **비용이 추정치라는 사실이 숫자에 정확히 반영되는가** 입니다.
 * Supabase 는 금액 API 가 없어서 (조직 플랜 정액 + 애드온 정액) ÷ 그 달의 일수로
 * 하루치를 만들어 냅니다. 여기가 틀리면 화면 전체가 조용히 틀립니다.
 *
 * 실행:
 *   node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/**\/__tests__/*.test.ts"
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SUPABASE_PLAN_MONTHLY_USD, adaptSupabase, type SupabaseRaw } from "../supabase";

// ---------------------------------------------------------------- 목 헬퍼

/** 2026년 8월 = 31일. 월정액을 31로 나눈 값이 하루치가 되어야 한다. */
const AUG_DAYS = 31;

function usageRow(date: string, rest = 100) {
  return {
    timestamp: `${date}T00:00:00Z`,
    total_auth_requests: 10,
    total_realtime_requests: 1,
    total_rest_requests: rest,
    total_storage_requests: 4,
  };
}

function fixedAddon(id: string, amount: number, interval: "monthly" | "hourly" = "monthly") {
  return {
    type: "compute_instance",
    variant: { id, name: id, price: { type: "fixed" as const, interval, amount } },
  };
}

function raw(overrides: Partial<SupabaseRaw> = {}): SupabaseRaw {
  return {
    accounts: [
      {
        label: "회사",
        organizations: [{ slug: "org-a", name: "Speciai", plan: "pro" }],
        projects: [
          {
            ref: "a".repeat(20),
            name: "prod",
            organization_slug: "org-a",
            status: "ACTIVE_HEALTHY",
            usage: [usageRow("2026-08-01"), usageRow("2026-08-02", 200)],
            addons: [fixedAddon("ci_small", 15)],
          },
        ],
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------- 날짜 축

describe("adaptSupabase — 날짜 축", () => {
  it("usage 의 timestamp 합집합으로 날짜를 만들고 오름차순 정렬한다", () => {
    const points = adaptSupabase(raw());
    assert.deepEqual(points.map((p) => p.date), ["2026-08-01", "2026-08-02"]);
  });

  it("사용량이 하나도 없으면 그릴 날짜가 없어 빈 배열이다 (고정비만으로는 축을 못 만든다)", () => {
    const input = raw();
    input.accounts[0].projects[0].usage = [];
    assert.deepEqual(adaptSupabase(input), []);
  });
});

// ---------------------------------------------------------------- 지표

describe("adaptSupabase — 지표", () => {
  it("총 요청은 네 종류의 합이다", () => {
    const [day1] = adaptSupabase(raw());
    const project = day1.items.find((i) => i.label === "prod");

    assert.equal(project?.metrics.restRequests, 100);
    assert.equal(project?.metrics.authRequests, 10);
    assert.equal(project?.metrics.storageRequests, 4);
    assert.equal(project?.metrics.realtimeRequests, 1);
    assert.equal(project?.metrics.requests, 115);
  });

  it("날짜별로 그 날 행만 집어 온다", () => {
    const points = adaptSupabase(raw());
    assert.equal(points[0].metrics.restRequests, 100);
    assert.equal(points[1].metrics.restRequests, 200);
  });
});

// ---------------------------------------------------------------- 비용

describe("adaptSupabase — 비용 추정", () => {
  it("조직 플랜 월정액을 그 달의 일수로 나눠 하루치로 편다", () => {
    const [day1] = adaptSupabase(raw());
    const plan = day1.items.find((i) => i.key.startsWith("plan:"));

    assert.ok(plan);
    assert.equal(plan.costUsd, SUPABASE_PLAN_MONTHLY_USD.pro / AUG_DAYS);
    assert.equal(plan.badge, "PRO");
  });

  it("Free 플랜은 줄을 만들지 않는다 (0원짜리 행은 표만 어지럽힌다)", () => {
    const input = raw();
    input.accounts[0].organizations[0].plan = "free";
    const [day1] = adaptSupabase(input);

    assert.equal(day1.items.filter((i) => i.key.startsWith("plan:")).length, 0);
  });

  it("Enterprise 는 공시가가 없으므로 0원 + '요금 미반영' 배지로 남긴다", () => {
    const input = raw();
    input.accounts[0].organizations[0].plan = "enterprise";
    const [day1] = adaptSupabase(input);
    const plan = day1.items.find((i) => i.key.startsWith("plan:"));

    assert.equal(plan?.costUsd, 0);
    assert.equal(plan?.badge, "요금 미반영");
  });

  it("애드온 월정액도 일할 계산한다", () => {
    const [day1] = adaptSupabase(raw());
    const project = day1.items.find((i) => i.label === "prod");

    assert.equal(project?.costUsd, 15 / AUG_DAYS);
  });

  it("시간당 단가 애드온은 24를 곱한다", () => {
    const input = raw();
    input.accounts[0].projects[0].addons = [fixedAddon("ci_micro", 0.01344, "hourly")];
    const [day1] = adaptSupabase(input);
    const project = day1.items.find((i) => i.label === "prod");

    assert.equal(project?.costUsd, 0.01344 * 24);
  });

  it("종량(usage) 단가 애드온은 금액을 알 수 없으므로 더하지 않는다", () => {
    const input = raw();
    input.accounts[0].projects[0].addons = [
      {
        type: "log_drain",
        variant: {
          id: "log_drain_default",
          name: "Log Drain",
          price: { type: "usage", interval: "monthly", amount: 0.0000002 },
        },
      },
    ];
    const [day1] = adaptSupabase(input);

    assert.equal(day1.items.find((i) => i.label === "prod")?.costUsd, 0);
  });

  it("하루 총액은 항목 합계와 같다", () => {
    const [day1] = adaptSupabase(raw());
    const sum = day1.items.reduce((acc, i) => acc + i.costUsd, 0);

    assert.equal(day1.costUsd, sum);
    assert.equal(day1.costUsd, 25 / AUG_DAYS + 15 / AUG_DAYS);
  });
});

// ---------------------------------------------------------------- 계정 축

describe("adaptSupabase — 계정 축(altItems)", () => {
  const multi: SupabaseRaw = {
    accounts: [
      {
        label: "회사",
        organizations: [{ slug: "org-a", name: "Speciai", plan: "pro" }],
        projects: [
          {
            ref: "a".repeat(20),
            name: "prod",
            status: "ACTIVE_HEALTHY",
            usage: [usageRow("2026-08-01")],
            addons: [fixedAddon("ci_small", 15)],
          },
        ],
      },
      {
        label: "개인",
        organizations: [{ slug: "org-b", name: "martin", plan: "free" }],
        projects: [
          {
            ref: "b".repeat(20),
            name: "landing",
            status: "ACTIVE_HEALTHY",
            usage: [usageRow("2026-08-01", 50)],
            addons: [],
          },
        ],
      },
    ],
  };

  it("계정별로 한 줄씩 만든다", () => {
    const [day1] = adaptSupabase(multi);
    assert.deepEqual(day1.altItems?.map((i) => i.label).sort(), ["개인", "회사"]);
  });

  it("계정 축 합계는 프로젝트 축 합계와 같다 (같은 하루를 다르게 쪼갠 것뿐)", () => {
    const [day1] = adaptSupabase(multi);

    const alt = day1.altItems ?? [];
    assert.equal(
      alt.reduce((a, i) => a + i.costUsd, 0),
      day1.items.reduce((a, i) => a + i.costUsd, 0),
    );
    assert.equal(
      alt.reduce((a, i) => a + i.metrics.requests, 0),
      day1.metrics.requests,
    );
  });

  it("이름이 같은 프로젝트가 계정마다 있어도 키가 겹치지 않는다", () => {
    const same: SupabaseRaw = JSON.parse(JSON.stringify(multi));
    same.accounts[1].projects[0].name = "prod";
    const [day1] = adaptSupabase(same);

    const keys = day1.items.map((i) => i.key);
    assert.equal(new Set(keys).size, keys.length);
  });
});

// ---------------------------------------------------------------- 실패 표시

describe("adaptSupabase — 실패를 숨기지 않는다", () => {
  it("계정 전체가 실패하면 '조회 실패' 행으로 남긴다", () => {
    const input = raw();
    input.accounts.push({
      label: "죽은계정",
      organizations: [],
      projects: [],
      error: "supabase API 호출 실패 (HTTP 401)",
    });
    const [day1] = adaptSupabase(input);
    const dead = day1.items.find((i) => i.label === "죽은계정");

    assert.equal(dead?.badge, "조회 실패");
    assert.match(dead?.title ?? "", /401/);
  });

  it("일시정지 프로젝트는 배지를 달아 표에 남긴다", () => {
    const input = raw();
    input.accounts[0].projects.push({
      ref: "c".repeat(20),
      name: "legacy",
      status: "INACTIVE",
      usage: [],
      addons: [],
      error: "프로젝트 상태가 INACTIVE 라 사용량 조회를 건너뛰었습니다.",
    });
    const [day1] = adaptSupabase(input);

    assert.equal(day1.items.find((i) => i.label === "legacy")?.badge, "조회 실패");
  });
});
