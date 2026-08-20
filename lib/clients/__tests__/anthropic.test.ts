/**
 * lib/clients/anthropic.ts 유닛 테스트 — 전부 목(mock) 응답입니다.
 * 네트워크를 타지 않고, 실제 키도 필요 없습니다.
 *
 * 실행:
 *   node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/clients/__tests__/*.test.ts"
 */

import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";

import {
  ANTHROPIC_API_KEYS_PATH,
  ANTHROPIC_COST_REPORT_PATH,
  ANTHROPIC_USAGE_REPORT_PATH,
  centsStringToUsd,
  fetchAllAnthropicApiKeys,
  fetchAllAnthropicCostBuckets,
  fetchAllAnthropicUsageBuckets,
  fetchAnthropicApiKeys,
  fetchAnthropicCostReport,
  fetchAnthropicUsageReport,
  resolveAnthropicConfig,
  sumUsageTokens,
} from "../anthropic";
import { ApiClientError, MissingCredentialError } from "../types";
import type {
  AnthropicApiKey,
  AnthropicApiKeysResponse,
  AnthropicCostReportResponse,
  AnthropicUsageReportResponse,
} from "../types";

// ---------------------------------------------------------------- 목 헬퍼

interface RecordedCall {
  url: URL;
  headers: Record<string, string>;
}

/** 순서대로 소비되는 응답 큐 + 호출 기록. */
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const KEY = { adminKey: "sk-ant-admin01-test-key" };

/** 공식 문서 예시 응답을 그대로 옮긴 것. */
const USAGE_PAGE: AnthropicUsageReportResponse = {
  data: [
    {
      starting_at: "2026-08-01T00:00:00Z",
      ending_at: "2026-08-02T00:00:00Z",
      results: [
        {
          uncached_input_tokens: 1500,
          cache_creation: {
            ephemeral_5m_input_tokens: 500,
            ephemeral_1h_input_tokens: 1000,
          },
          cache_read_input_tokens: 200,
          output_tokens: 500,
          server_tool_use: { web_search_requests: 10 },
          model: "claude-opus-4-6",
          api_key_id: "apikey_01Rj2N8SVvo6BePZj99NhmiT",
          workspace_id: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ",
          account_id: null,
          service_account_id: null,
          service_tier: "standard",
          context_window: "0-200k",
          inference_geo: "global",
        },
      ],
    },
  ],
  has_more: false,
  next_page: null,
};

const COST_PAGE: AnthropicCostReportResponse = {
  data: [
    {
      starting_at: "2026-08-01T00:00:00Z",
      ending_at: "2026-08-02T00:00:00Z",
      results: [
        {
          amount: "123.78912",
          currency: "USD",
          cost_type: "tokens",
          description: "Claude Sonnet 4 Usage - Input Tokens",
          token_type: "uncached_input_tokens",
          model: "claude-opus-4-6",
          service_tier: "standard",
          context_window: "0-200k",
          inference_geo: "global",
          workspace_id: null,
        },
      ],
    },
  ],
  has_more: false,
  next_page: null,
};

// 실제 .env 가 로드된 환경에서도 결과가 흔들리지 않도록 매 테스트마다 초기화한다.
const savedEnv = {
  ANTHROPIC_ADMIN_KEY: process.env.ANTHROPIC_ADMIN_KEY,
  ANTHROPIC_API_VERSION: process.env.ANTHROPIC_API_VERSION,
  ANTHROPIC_API_BASE: process.env.ANTHROPIC_API_BASE,
};

beforeEach(() => {
  delete process.env.ANTHROPIC_ADMIN_KEY;
  delete process.env.ANTHROPIC_API_VERSION;
  delete process.env.ANTHROPIC_API_BASE;
});

after(() => {
  Object.assign(process.env, savedEnv);
});

// ---------------------------------------------------------------- 키 검사

describe("키가 없을 때", () => {
  it("ANTHROPIC_ADMIN_KEY 가 없으면 무엇을 어디에 넣어야 하는지 알려주며 던진다", async () => {
    await assert.rejects(
      () => fetchAnthropicUsageReport({ starting_at: "2026-08-01T00:00:00Z" }),
      (error: unknown) => {
        assert.ok(error instanceof MissingCredentialError);
        assert.equal(error.envVar, "ANTHROPIC_ADMIN_KEY");
        assert.match(error.message, /ANTHROPIC_ADMIN_KEY가 \.env에 없습니다/);
        // 가장 흔한 실수(일반 API 키 사용)를 에러 메시지에서 바로 알려 준다.
        assert.match(error.message, /sk-ant-admin/);
        return true;
      },
    );
  });

  it("빈 문자열·공백만 있는 값도 '없음'으로 본다", () => {
    process.env.ANTHROPIC_ADMIN_KEY = "   ";
    assert.throws(() => resolveAnthropicConfig(), MissingCredentialError);
  });

  it(".env.example 의 자리표시자 그대로면 던진다", () => {
    process.env.ANTHROPIC_ADMIN_KEY = "sk-ant-admin01-xxxxxxxxxxxxxxxxxxxx";
    assert.throws(
      () => resolveAnthropicConfig(),
      (error: unknown) => {
        assert.ok(error instanceof MissingCredentialError);
        assert.match(error.message, /자리표시자/);
        return true;
      },
    );
  });

  it("키가 없으면 네트워크 호출 자체를 하지 않는다", async () => {
    const { fetchImpl, calls } = mockFetch([json(USAGE_PAGE)]);
    await assert.rejects(() =>
      fetchAnthropicUsageReport(
        { starting_at: "2026-08-01T00:00:00Z" },
        { fetch: fetchImpl },
      ),
    );
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------- 요청 조립

describe("요청 조립", () => {
  it("usage_report: 경로·헤더·쿼리를 문서대로 만든다", async () => {
    const { fetchImpl, calls } = mockFetch([json(USAGE_PAGE)]);

    await fetchAnthropicUsageReport(
      {
        starting_at: "2026-08-01T00:00:00Z",
        ending_at: "2026-08-08T00:00:00Z",
        bucket_width: "1d",
        limit: 31,
        group_by: ["model", "api_key_id", "workspace_id"],
      },
      { ...KEY, fetch: fetchImpl },
    );

    assert.equal(calls.length, 1);
    const { url, headers } = calls[0];

    assert.equal(url.origin, "https://api.anthropic.com");
    assert.equal(url.pathname, ANTHROPIC_USAGE_REPORT_PATH);
    assert.equal(url.searchParams.get("starting_at"), "2026-08-01T00:00:00Z");
    assert.equal(url.searchParams.get("ending_at"), "2026-08-08T00:00:00Z");
    assert.equal(url.searchParams.get("bucket_width"), "1d");
    assert.equal(url.searchParams.get("limit"), "31");

    // 배열 파라미터는 group_by[]=... 로 반복 전송.
    assert.deepEqual(url.searchParams.getAll("group_by[]"), [
      "model",
      "api_key_id",
      "workspace_id",
    ]);

    // 인증은 Authorization 이 아니라 x-api-key.
    assert.equal(headers["x-api-key"], KEY.adminKey);
    assert.equal(headers["anthropic-version"], "2023-06-01");
    assert.equal(headers.Authorization, undefined);

    // 키가 쿼리스트링에 새어 나가지 않는지.
    assert.ok(!url.toString().includes(KEY.adminKey));
  });

  it("지정하지 않은 선택 파라미터는 쿼리에 넣지 않는다", async () => {
    const { fetchImpl, calls } = mockFetch([json(USAGE_PAGE)]);

    await fetchAnthropicUsageReport(
      { starting_at: "2026-08-01T00:00:00Z" },
      { ...KEY, fetch: fetchImpl },
    );

    assert.deepEqual([...calls[0].url.searchParams.keys()], ["starting_at"]);
  });

  it("환경변수로 api version / base url 을 덮어쓸 수 있다", async () => {
    process.env.ANTHROPIC_ADMIN_KEY = "sk-ant-admin01-from-env";
    process.env.ANTHROPIC_API_VERSION = "2099-01-01";
    process.env.ANTHROPIC_API_BASE = "https://proxy.internal";

    const { fetchImpl, calls } = mockFetch([json(USAGE_PAGE)]);
    await fetchAnthropicUsageReport(
      { starting_at: "2026-08-01T00:00:00Z" },
      { fetch: fetchImpl },
    );

    assert.equal(calls[0].url.origin, "https://proxy.internal");
    assert.equal(calls[0].headers["anthropic-version"], "2099-01-01");
    assert.equal(calls[0].headers["x-api-key"], "sk-ant-admin01-from-env");
  });

  it("betas 를 주면 anthropic-beta 헤더가 붙는다 (group_by=speed 용)", async () => {
    const { fetchImpl, calls } = mockFetch([json(USAGE_PAGE)]);

    await fetchAnthropicUsageReport(
      { starting_at: "2026-08-01T00:00:00Z", group_by: ["speed"] },
      { ...KEY, fetch: fetchImpl, betas: ["fast-mode-2026-02-01"] },
    );

    assert.equal(calls[0].headers["anthropic-beta"], "fast-mode-2026-02-01");
  });

  it("cost_report: 경로와 group_by 를 문서대로 만든다", async () => {
    const { fetchImpl, calls } = mockFetch([json(COST_PAGE)]);

    await fetchAnthropicCostReport(
      {
        starting_at: "2026-08-01T00:00:00Z",
        bucket_width: "1d",
        group_by: ["description", "workspace_id"],
      },
      { ...KEY, fetch: fetchImpl },
    );

    assert.equal(calls[0].url.pathname, ANTHROPIC_COST_REPORT_PATH);
    assert.deepEqual(calls[0].url.searchParams.getAll("group_by[]"), [
      "description",
      "workspace_id",
    ]);
  });
});

// ---------------------------------------------------------------- 응답 파싱

describe("응답 파싱", () => {
  it("usage_report 응답을 그대로 돌려준다", async () => {
    const { fetchImpl } = mockFetch([json(USAGE_PAGE)]);

    const result = await fetchAnthropicUsageReport(
      { starting_at: "2026-08-01T00:00:00Z" },
      { ...KEY, fetch: fetchImpl },
    );

    assert.equal(result.has_more, false);
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].results[0].model, "claude-opus-4-6");
    assert.equal(
      result.data[0].results[0].cache_creation.ephemeral_1h_input_tokens,
      1000,
    );
  });

  it("cost_report 의 amount 는 문자열 그대로 유지한다 (반올림 손실 방지)", async () => {
    const { fetchImpl } = mockFetch([json(COST_PAGE)]);

    const result = await fetchAnthropicCostReport(
      { starting_at: "2026-08-01T00:00:00Z" },
      { ...KEY, fetch: fetchImpl },
    );

    assert.equal(typeof result.data[0].results[0].amount, "string");
    assert.equal(result.data[0].results[0].amount, "123.78912");
  });

  it("사용량이 없는 버킷도 results: [] 로 온다", async () => {
    const empty: AnthropicUsageReportResponse = {
      data: [
        {
          starting_at: "2026-08-03T00:00:00Z",
          ending_at: "2026-08-04T00:00:00Z",
          results: [],
        },
      ],
      has_more: false,
      next_page: null,
    };
    const { fetchImpl } = mockFetch([json(empty)]);

    const result = await fetchAnthropicUsageReport(
      { starting_at: "2026-08-03T00:00:00Z" },
      { ...KEY, fetch: fetchImpl },
    );

    assert.deepEqual(result.data[0].results, []);
  });
});

// ---------------------------------------------------------------- 에러 처리

describe("HTTP 에러", () => {
  it("401 이면 Admin 키 힌트를 담은 ApiClientError 를 던진다", async () => {
    const { fetchImpl } = mockFetch([
      json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401),
    ]);

    await assert.rejects(
      () =>
        fetchAnthropicUsageReport(
          { starting_at: "2026-08-01T00:00:00Z" },
          { ...KEY, fetch: fetchImpl },
        ),
      (error: unknown) => {
        assert.ok(error instanceof ApiClientError);
        assert.equal(error.vendor, "anthropic");
        assert.equal(error.status, 401);
        assert.match(error.message, /sk-ant-admin/);
        assert.match(error.body, /invalid x-api-key/);
        return true;
      },
    );
  });

  it("403 이면 조직 Owner 권한 힌트를 담는다", async () => {
    const { fetchImpl } = mockFetch([json({ error: { message: "forbidden" } }, 403)]);

    await assert.rejects(
      () =>
        fetchAnthropicCostReport(
          { starting_at: "2026-08-01T00:00:00Z" },
          { ...KEY, fetch: fetchImpl },
        ),
      (error: unknown) => {
        assert.ok(error instanceof ApiClientError);
        assert.equal(error.status, 403);
        assert.match(error.message, /Owner/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------- 페이지네이션

describe("커서 페이지네이션", () => {
  it("has_more=true 면 next_page 를 page 로 넘겨 이어 받고 data 를 합친다", async () => {
    const page1: AnthropicUsageReportResponse = {
      ...USAGE_PAGE,
      has_more: true,
      next_page: "page_TOKEN_2",
    };
    const page2: AnthropicUsageReportResponse = {
      data: [
        {
          starting_at: "2026-08-02T00:00:00Z",
          ending_at: "2026-08-03T00:00:00Z",
          results: [],
        },
      ],
      has_more: false,
      next_page: null,
    };

    const { fetchImpl, calls } = mockFetch([json(page1), json(page2)]);

    const buckets = await fetchAllAnthropicUsageBuckets(
      { starting_at: "2026-08-01T00:00:00Z", bucket_width: "1d", limit: 31 },
      { ...KEY, fetch: fetchImpl },
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url.searchParams.get("page"), null);
    assert.equal(calls[1].url.searchParams.get("page"), "page_TOKEN_2");
    // 2페이지에서도 원래 조회 조건이 유지되는지.
    assert.equal(calls[1].url.searchParams.get("bucket_width"), "1d");

    assert.equal(buckets.length, 2);
    assert.deepEqual(
      buckets.map((b) => b.starting_at),
      ["2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z"],
    );
  });

  it("has_more=true 인데 next_page 가 null 이면 무한루프 없이 멈춘다", async () => {
    const broken: AnthropicUsageReportResponse = {
      ...USAGE_PAGE,
      has_more: true,
      next_page: null,
    };
    const { fetchImpl, calls } = mockFetch([json(broken)]);

    const buckets = await fetchAllAnthropicUsageBuckets(
      { starting_at: "2026-08-01T00:00:00Z" },
      { ...KEY, fetch: fetchImpl },
    );

    assert.equal(calls.length, 1);
    assert.equal(buckets.length, 1);
  });

  it("cost_report 도 같은 방식으로 전 페이지를 모은다", async () => {
    const page1: AnthropicCostReportResponse = {
      ...COST_PAGE,
      has_more: true,
      next_page: "page_COST_2",
    };
    const { fetchImpl, calls } = mockFetch([json(page1), json(COST_PAGE)]);

    const buckets = await fetchAllAnthropicCostBuckets(
      { starting_at: "2026-08-01T00:00:00Z" },
      { ...KEY, fetch: fetchImpl },
    );

    assert.equal(calls[1].url.searchParams.get("page"), "page_COST_2");
    assert.equal(buckets.length, 2);
  });
});

// ---------------------------------------------------------- API 키 목록

/** 공식 문서 예시 + 2026-08-14 실제 응답에서 확인한 필드(`expires_at`)까지. */
function apiKey(id: string, over: Partial<AnthropicApiKey> = {}): AnthropicApiKey {
  return {
    id,
    type: "api_key",
    name: `key-${id}`,
    workspace_id: "wrkspc_017XPrKRNxvnSDdfD9mjjX5z",
    created_at: "2026-08-13T04:02:05.130513Z",
    created_by: { id: "user_01B7UqhcEuhRunqfPkPZtLZu", type: "user" },
    partial_key_hint: "sk-ant-api03-hqL...kQAA",
    status: "active",
    expires_at: null,
    ...over,
  };
}

function apiKeysPage(
  keys: AnthropicApiKey[],
  hasMore = false,
): AnthropicApiKeysResponse {
  return {
    data: keys,
    has_more: hasMore,
    first_id: keys[0]?.id ?? null,
    last_id: keys[keys.length - 1]?.id ?? null,
  };
}

describe("List API Keys", () => {
  it("경로와 인증 헤더가 리포트와 같다", async () => {
    const { fetchImpl, calls } = mockFetch([json(apiKeysPage([apiKey("apikey_1")]))]);

    const body = await fetchAnthropicApiKeys({}, { ...KEY, fetch: fetchImpl });

    assert.equal(calls[0].url.pathname, ANTHROPIC_API_KEYS_PATH);
    assert.equal(calls[0].headers["x-api-key"], KEY.adminKey);
    assert.equal(calls[0].headers["anthropic-version"], "2023-06-01");
    assert.equal(body.data[0].id, "apikey_1");
  });

  it("after_id 로 다음 페이지를 이어 받아 전체를 합친다 (page/next_page 아님)", async () => {
    const page1 = apiKeysPage([apiKey("apikey_1"), apiKey("apikey_2")], true);
    const page2 = apiKeysPage([apiKey("apikey_3")]);
    const { fetchImpl, calls } = mockFetch([json(page1), json(page2)]);

    const keys = await fetchAllAnthropicApiKeys({}, { ...KEY, fetch: fetchImpl });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url.searchParams.get("after_id"), null);
    assert.equal(calls[1].url.searchParams.get("after_id"), "apikey_2");
    // 기본 20건에 조용히 잘리지 않도록 limit 을 올려서 보내는지.
    assert.equal(calls[0].url.searchParams.get("limit"), "100");
    assert.deepEqual(
      keys.map((k) => k.id),
      ["apikey_1", "apikey_2", "apikey_3"],
    );
  });

  it("status 를 안 주면 필터를 보내지 않는다 (archived 키도 받아야 한다)", async () => {
    const { fetchImpl, calls } = mockFetch([json(apiKeysPage([apiKey("apikey_1")]))]);

    await fetchAllAnthropicApiKeys({}, { ...KEY, fetch: fetchImpl });

    assert.equal(calls[0].url.searchParams.get("status"), null);
  });

  it("last_id 가 비어도 마지막 항목 id 로 이어 받는다", async () => {
    const page1 = { ...apiKeysPage([apiKey("apikey_1")], true), last_id: null };
    const { fetchImpl, calls } = mockFetch([
      json(page1),
      json(apiKeysPage([apiKey("apikey_2")])),
    ]);

    const keys = await fetchAllAnthropicApiKeys({}, { ...KEY, fetch: fetchImpl });

    assert.equal(calls[1].url.searchParams.get("after_id"), "apikey_1");
    assert.equal(keys.length, 2);
  });

  it("has_more=true 인데 커서를 만들 수 없으면 무한루프 없이 멈춘다", async () => {
    const broken: AnthropicApiKeysResponse = {
      data: [],
      has_more: true,
      first_id: null,
      last_id: null,
    };
    const { fetchImpl, calls } = mockFetch([json(broken)]);

    const keys = await fetchAllAnthropicApiKeys({}, { ...KEY, fetch: fetchImpl });

    assert.equal(calls.length, 1);
    assert.equal(keys.length, 0);
  });

  it("키가 없으면 네트워크를 타지 않고 던진다", async () => {
    const { fetchImpl, calls } = mockFetch([]);

    await assert.rejects(
      () => fetchAllAnthropicApiKeys({}, { fetch: fetchImpl }),
      MissingCredentialError,
    );
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------- 유틸

describe("centsStringToUsd", () => {
  it("센트 문자열을 USD 로 바꾼다 (100배 함정)", () => {
    assert.equal(centsStringToUsd("123.45"), 1.2345);
    assert.equal(centsStringToUsd("0"), 0);
    assert.equal(centsStringToUsd("100"), 1);
  });

  it("숫자가 아니면 던진다", () => {
    assert.throws(() => centsStringToUsd("N/A"), TypeError);
    assert.throws(() => centsStringToUsd(""), TypeError);
  });
});

describe("sumUsageTokens", () => {
  it("토큰 5종을 합산한다 (단일 total_tokens 필드가 없으므로)", () => {
    const result = USAGE_PAGE.data[0].results[0];
    // 1500 + 200 + 500 + 1000 + 500
    assert.equal(sumUsageTokens(result), 3700);
  });

  it("web_search_requests 는 토큰이 아니므로 더하지 않는다", () => {
    const result = {
      ...USAGE_PAGE.data[0].results[0],
      server_tool_use: { web_search_requests: 999_999 },
    };
    assert.equal(sumUsageTokens(result), 3700);
  });
});
