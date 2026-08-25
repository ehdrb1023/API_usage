/**
 * lib/clients/supabase.ts 유닛 테스트 — 전부 목(mock) 응답입니다.
 * 네트워크를 타지 않고, 실제 토큰도 필요 없습니다.
 *
 * 초점은 **계정이 여러 개일 때의 동작**입니다. Supabase 토큰은 계정 단위라
 * 이 클라이언트만 "토큰 목록"을 받고, 하나가 죽어도 나머지는 살아야 합니다.
 *
 * 실행:
 *   node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/clients/__tests__/*.test.ts"
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  fetchAllSupabaseAccounts,
  fetchSupabaseAccountSnapshot,
  fetchSupabaseProjectUsage,
  parseSupabaseAccounts,
  resolveSupabaseAccounts,
  type SupabaseAccount,
} from "../supabase";
import { ApiClientError, MissingCredentialError } from "../types";

// ---------------------------------------------------------------- 목 헬퍼

/**
 * 경로별 응답표. 같은 경로를 여러 번 부르면 큐에서 순서대로 꺼내 씁니다.
 *
 * 매칭은 **가장 긴 패턴 우선**입니다. 사용량 경로가
 * `/v1/projects/{ref}/analytics/endpoints/usage.api-counts` 라서 `/v1/projects` 에도
 * 걸리기 때문에, 등록 순서에 기대면 목록 응답을 사용량 호출이 훔쳐 갑니다.
 */
function routedFetch(routes: Record<string, Response[] | (() => Response)>) {
  const calls: URL[] = [];

  const fetchImpl = async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url);

    const match = Object.keys(routes)
      .filter((pattern) => url.pathname.includes(pattern))
      .sort((a, b) => b.length - a.length)[0];

    if (!match) throw new Error(`목에 등록되지 않은 경로: ${url.pathname}`);

    const value = routes[match];
    if (typeof value === "function") return value();
    const next = value.shift();
    if (!next) throw new Error(`목 응답 소진: ${match}`);
    return next;
  };

  return { fetchImpl, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const ACCOUNT: SupabaseAccount = { label: "테스트", token: "sbp_test" };

const savedEnv = {
  SUPABASE_ACCESS_TOKEN: process.env.SUPABASE_ACCESS_TOKEN,
  SUPABASE_ACCESS_TOKENS: process.env.SUPABASE_ACCESS_TOKENS,
  SUPABASE_ACCOUNT_LABEL: process.env.SUPABASE_ACCOUNT_LABEL,
};

beforeEach(() => {
  delete process.env.SUPABASE_ACCESS_TOKEN;
  delete process.env.SUPABASE_ACCESS_TOKENS;
  delete process.env.SUPABASE_ACCOUNT_LABEL;
  Object.assign(process.env, Object.fromEntries(
    Object.entries(savedEnv).filter(([, v]) => v !== undefined),
  ));
  delete process.env.SUPABASE_ACCESS_TOKEN;
  delete process.env.SUPABASE_ACCESS_TOKENS;
  delete process.env.SUPABASE_ACCOUNT_LABEL;
});

// ---------------------------------------------------------------- 계정 파싱

describe("parseSupabaseAccounts", () => {
  it("`라벨=토큰` 목록을 순서대로 읽는다", () => {
    const accounts = parseSupabaseAccounts("회사=sbp_aaa, 개인=sbp_bbb");
    assert.deepEqual(accounts, [
      { label: "회사", token: "sbp_aaa" },
      { label: "개인", token: "sbp_bbb" },
    ]);
  });

  it("구분자로 콜론도 받고, 줄바꿈으로도 나눈다", () => {
    const accounts = parseSupabaseAccounts("회사:sbp_aaa\n개인=sbp_bbb\n");
    assert.deepEqual(accounts.map((a) => a.label), ["회사", "개인"]);
    assert.deepEqual(accounts.map((a) => a.token), ["sbp_aaa", "sbp_bbb"]);
  });

  it("라벨이 없으면 번호를 붙인다", () => {
    assert.deepEqual(parseSupabaseAccounts("sbp_aaa,sbp_bbb").map((a) => a.label), [
      "계정 1",
      "계정 2",
    ]);
  });

  it("라벨이 겹치면 뒤에 번호를 붙여 떼어 놓는다 (표에서 합쳐지면 안 됨)", () => {
    const accounts = parseSupabaseAccounts("회사=sbp_aaa,회사=sbp_bbb,회사=sbp_ccc");
    assert.deepEqual(accounts.map((a) => a.label), ["회사", "회사 (2)", "회사 (3)"]);
  });
});

describe("resolveSupabaseAccounts", () => {
  it("복수 토큰이 있으면 그쪽을 쓴다", () => {
    process.env.SUPABASE_ACCESS_TOKENS = "회사=sbp_aaa,개인=sbp_bbb";
    process.env.SUPABASE_ACCESS_TOKEN = "sbp_single";
    assert.deepEqual(resolveSupabaseAccounts().map((a) => a.token), ["sbp_aaa", "sbp_bbb"]);
  });

  it("단수 토큰만 있으면 계정 하나로 취급한다", () => {
    process.env.SUPABASE_ACCESS_TOKEN = "sbp_single";
    assert.deepEqual(resolveSupabaseAccounts(), [{ label: "기본 계정", token: "sbp_single" }]);
  });

  it("SUPABASE_ACCOUNT_LABEL 로 단수 계정 이름을 정할 수 있다", () => {
    process.env.SUPABASE_ACCESS_TOKEN = "sbp_single";
    process.env.SUPABASE_ACCOUNT_LABEL = "회사";
    assert.equal(resolveSupabaseAccounts()[0].label, "회사");
  });

  it(".env.example 자리표시자(sbp_xxxx... / sbp_yyyy...)는 토큰으로 치지 않는다", () => {
    process.env.SUPABASE_ACCESS_TOKEN = "sbp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    assert.throws(() => resolveSupabaseAccounts(), MissingCredentialError);

    delete process.env.SUPABASE_ACCESS_TOKEN;
    process.env.SUPABASE_ACCESS_TOKENS =
      "회사=sbp_xxxxxxxxxxxxxxxxxxxx,개인=sbp_yyyyyyyyyyyyyyyyyyyy";
    assert.throws(() => resolveSupabaseAccounts(), MissingCredentialError);
  });

  it("자리표시자와 진짜 토큰이 섞여 있으면 진짜만 남긴다", () => {
    process.env.SUPABASE_ACCESS_TOKENS =
      "회사=sbp_xxxxxxxxxxxxxxxxxxxx,개인=sbp_real_token_value";
    assert.deepEqual(resolveSupabaseAccounts(), [
      { label: "개인", token: "sbp_real_token_value" },
    ]);
  });

  it("토큰이 아예 없으면 발급 방법을 알려주며 던진다", () => {
    assert.throws(() => resolveSupabaseAccounts(), (error: unknown) => {
      assert.ok(error instanceof MissingCredentialError);
      assert.match(error.message, /SUPABASE_ACCESS_TOKENS/);
      return true;
    });
  });
});

// ---------------------------------------------------------------- HTTP

describe("fetchSupabaseProjectUsage", () => {
  it("Bearer 토큰과 interval 을 붙여 부른다", async () => {
    const { fetchImpl, calls } = routedFetch({
      "usage.api-counts": [json({ result: [{ timestamp: "2026-08-24T00:00:00Z" }] })],
    });

    const rows = await fetchSupabaseProjectUsage(ACCOUNT, "ref123", "1day", { fetch: fetchImpl });

    assert.equal(rows.length, 1);
    assert.equal(calls[0].searchParams.get("interval"), "1day");
    assert.match(calls[0].pathname, /\/v1\/projects\/ref123\/analytics/);
  });

  it("401 은 어느 계정인지까지 알려주는 ApiClientError 로 바꾼다", async () => {
    const { fetchImpl } = routedFetch({
      "usage.api-counts": [json({ message: "Unauthorized" }, 401)],
    });

    await assert.rejects(
      () => fetchSupabaseProjectUsage(ACCOUNT, "ref123", "1day", { fetch: fetchImpl }),
      (error: unknown) => {
        assert.ok(error instanceof ApiClientError);
        assert.equal(error.vendor, "supabase");
        assert.equal(error.status, 401);
        assert.match(error.message, /테스트/);
        return true;
      },
    );
  });

  it("429 는 한 번 재시도한다 (프로젝트가 많으면 분당 한도에 걸리는 게 정상)", async () => {
    const { fetchImpl, calls } = routedFetch({
      "usage.api-counts": [
        json({ message: "rate limited" }, 429, { "retry-after": "0" }),
        json({ result: [] }),
      ],
    });

    const rows = await fetchSupabaseProjectUsage(ACCOUNT, "ref123", "1day", { fetch: fetchImpl });

    assert.deepEqual(rows, []);
    assert.equal(calls.length, 2);
  });
});

// ---------------------------------------------------------------- 스냅샷

const ORGS = [{ id: "o1", slug: "org-a", name: "Speciai" }];

function projectList(overrides: Array<Record<string, unknown>>) {
  return overrides.map((o) => ({
    ref: "r".repeat(20),
    name: "proj",
    organization_slug: "org-a",
    region: "ap-northeast-2",
    status: "ACTIVE_HEALTHY",
    created_at: "2026-01-01T00:00:00Z",
    ...o,
  }));
}

describe("fetchSupabaseAccountSnapshot", () => {
  it("일시정지(INACTIVE) 프로젝트는 사용량을 부르지 않고 사유만 남긴다", async () => {
    const { fetchImpl, calls } = routedFetch({
      "/v1/organizations/org-a": [json({ ...ORGS[0], plan: "pro" })],
      "/v1/organizations": [json(ORGS)],
      "/v1/projects": [json(projectList([{ ref: "a".repeat(20), status: "INACTIVE" }]))],
    });

    const snap = await fetchSupabaseAccountSnapshot(ACCOUNT, { fetch: fetchImpl });

    assert.equal(snap.projects.length, 1);
    assert.match(snap.projects[0].error ?? "", /INACTIVE/);
    assert.ok(!calls.some((c) => c.pathname.includes("usage.api-counts")));
  });

  it("프로젝트 하나가 실패해도 나머지는 그대로 돌려준다", async () => {
    const { fetchImpl } = routedFetch({
      "/v1/organizations/org-a": [json({ ...ORGS[0], plan: "pro" })],
      "/v1/organizations": [json(ORGS)],
      "/v1/projects": [
        json(
          projectList([
            { ref: "a".repeat(20), name: "good" },
            { ref: "b".repeat(20), name: "bad" },
          ]),
        ),
      ],
      "usage.api-counts": [
        json({ result: [{ timestamp: "2026-08-24T00:00:00Z" }] }),
        json({ message: "Forbidden" }, 403),
      ],
      "billing/addons": [json({ selected_addons: [] }), json({ selected_addons: [] })],
    });

    const snap = await fetchSupabaseAccountSnapshot(ACCOUNT, { fetch: fetchImpl });

    const good = snap.projects.find((p) => p.name === "good");
    const bad = snap.projects.find((p) => p.name === "bad");
    assert.equal(good?.usage.length, 1);
    assert.equal(good?.error, undefined);
    assert.match(bad?.error ?? "", /403/);
  });

  it("조직 plan 조회가 실패해도 조직 이름은 살린다", async () => {
    const { fetchImpl } = routedFetch({
      "/v1/organizations/org-a": [json({ message: "boom" }, 500)],
      "/v1/organizations": [json(ORGS)],
      "/v1/projects": [json([])],
    });

    const snap = await fetchSupabaseAccountSnapshot(ACCOUNT, { fetch: fetchImpl });

    assert.equal(snap.organizations[0].name, "Speciai");
    assert.equal(snap.organizations[0].plan, undefined);
  });
});

describe("fetchAllSupabaseAccounts", () => {
  it("계정 하나가 죽어도 나머지 계정은 살린다", async () => {
    let call = 0;
    const fetchImpl = async (input: string | URL) => {
      const url = new URL(String(input));
      // 첫 계정은 토큰 만료(401), 둘째 계정은 정상.
      if (call++ < 2) return json({ message: "Unauthorized" }, 401);
      if (url.pathname === "/v1/organizations") return json([]);
      if (url.pathname === "/v1/projects") return json([]);
      return json({});
    };

    const raw = await fetchAllSupabaseAccounts({
      accounts: [
        { label: "회사", token: "sbp_dead" },
        { label: "개인", token: "sbp_ok" },
      ],
      fetch: fetchImpl,
    });

    assert.equal(raw.accounts.length, 2);
    assert.match(raw.accounts[0].error ?? "", /401/);
    assert.equal(raw.accounts[1].error, undefined);
  });

  it("모든 계정이 실패하면 계정별 사유를 모아 던진다", async () => {
    const fetchImpl = async () => json({ message: "Unauthorized" }, 401);

    await assert.rejects(
      () =>
        fetchAllSupabaseAccounts({
          accounts: [
            { label: "회사", token: "sbp_a" },
            { label: "개인", token: "sbp_b" },
          ],
          fetch: fetchImpl,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /회사/);
        assert.match(error.message, /개인/);
        return true;
      },
    );
  });
});
