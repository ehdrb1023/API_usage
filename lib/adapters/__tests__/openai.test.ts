/**
 * lib/adapters/openai.ts 유닛 테스트 — 순수 함수라 네트워크를 타지 않습니다.
 *
 * 여기서 지키려는 것은 **Anthropic 과 뜻을 맞추는 부분**입니다. 벤더 응답이
 * 문서와 달라도 이 테스트는 통과할 수 있습니다 (실응답 검증은 별개 —
 * docs/openai-integration.md). 대신 아래 네 가지가 깨지면 두 탭의 숫자가
 * 조용히 다른 뜻이 됩니다:
 *
 *   1. input_tokens 는 캐시를 **포함**하므로 빼야 한다
 *   2. 금액은 이미 USD 다 (100 으로 나누면 100배 적어진다)
 *   3. 시각은 unix 초다
 *   4. "총 토큰" 에 요청 수가 섞이면 안 된다
 *
 * 실행:
 *   node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/**\/__tests__/*.test.ts"
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OPENAI_TOKEN_KINDS,
  adaptOpenAi,
  toCostRows,
  toUsageRows,
  type OpenAiRaw,
} from "../openai";

const MTOK = 1_000_000;
/** 2026-08-24T00:00:00Z */
const DAY_UNIX = 1787529600;

describe("입력 토큰 정규화 (Anthropic 과 뜻 맞추기)", () => {
  it("input_tokens 에서 캐시 읽기를 뺀다", () => {
    const [row] = toUsageRows([
      {
        model: "gpt-5",
        project_id: "proj_a",
        input_tokens: 10 * MTOK, // 캐시 포함 총 입력
        input_cached_tokens: 4 * MTOK,
        output_tokens: 1 * MTOK,
        num_model_requests: 300,
      },
    ]);

    // 안 빼면 총 토큰이 캐시만큼 부풀려진다.
    assert.equal(row.metrics.inputTokens, 6 * MTOK);
    assert.equal(row.metrics.cacheReadTokens, 4 * MTOK);
    assert.equal(row.tokens[OPENAI_TOKEN_KINDS.input], 6 * MTOK);
    assert.equal(row.tokens[OPENAI_TOKEN_KINDS.cached], 4 * MTOK);
  });

  it("문서와 달리 캐시가 이미 빠져 있어도 음수가 되지 않는다", () => {
    const [row] = toUsageRows([
      {
        model: "gpt-5",
        input_tokens: 2 * MTOK,
        input_cached_tokens: 5 * MTOK, // 총 입력보다 큰 캐시 = 전제가 틀린 경우
        output_tokens: 0,
      },
    ]);

    assert.equal(row.metrics.inputTokens, 0);
  });

  it("보조 축은 프로젝트다 — project_id 가 없으면 콘솔 직접 사용으로 본다", () => {
    const [withProject] = toUsageRows([
      { model: "gpt-5", project_id: "proj_a", input_tokens: 1, output_tokens: 0 },
    ]);
    const [without] = toUsageRows([
      { model: "gpt-5", input_tokens: 1, output_tokens: 0 },
    ]);

    assert.equal(withProject.keyId, "proj_a");
    assert.equal(without.keyId, null);
  });
});

describe("금액 단위", () => {
  it("amount.value 는 이미 USD 다 (100 으로 나누지 않는다)", () => {
    const rows = toCostRows([
      { amount: { value: 12.5, currency: "usd" }, line_item: "gpt-5, output" },
    ]);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].usd, 12.5);
    assert.equal(rows[0].model, "gpt-5");
    assert.equal(rows[0].tokenKind, OPENAI_TOKEN_KINDS.output);
  });

  it("line_item 을 못 알아보면 토큰 비례가 아닌 비용으로 남긴다", () => {
    const rows = toCostRows([
      { amount: { value: 3, currency: "usd" }, line_item: "Web search tool" },
    ]);

    // model 은 잡히지만 tokenKind 가 null 이라 단가 역산에서 빠지고 비중만 기록된다.
    assert.equal(rows[0].tokenKind, null);
  });

  it("line_item 이 아예 없으면 둘 다 null 이다", () => {
    const rows = toCostRows([{ amount: { value: 1, currency: "usd" } }]);
    assert.equal(rows[0].model, null);
    assert.equal(rows[0].tokenKind, null);
  });
});

describe("집계", () => {
  const raw: OpenAiRaw = {
    usage: {
      data: [
        {
          start_time: DAY_UNIX,
          end_time: DAY_UNIX + 86400,
          results: [
            {
              model: "gpt-5",
              project_id: "proj_a",
              input_tokens: 3 * MTOK,
              input_cached_tokens: 1 * MTOK,
              output_tokens: 1 * MTOK,
              num_model_requests: 500,
            },
          ],
        },
      ],
    },
    costs: {
      data: [
        {
          start_time: DAY_UNIX,
          end_time: DAY_UNIX + 86400,
          results: [
            { amount: { value: 2.5, currency: "usd" }, line_item: "gpt-5, input" },
            { amount: { value: 10, currency: "usd" }, line_item: "gpt-5, output" },
          ],
        },
      ],
    },
    projects: [{ id: "proj_a", name: "prod-assistant", status: "active" }],
  };

  it("unix 초를 KST 이전의 UTC 날짜로 읽는다", () => {
    const points = adaptOpenAi(raw);
    assert.equal(points[0].date, "2026-08-24");
  });

  it("총 토큰에 요청 수가 섞이지 않는다", () => {
    const point = adaptOpenAi(raw)[0];
    // 입력 2M + 캐시 1M + 출력 1M = 4M. 요청 500 이 더해지면 안 된다.
    assert.equal(point.metrics.totalTokens, 4 * MTOK);
    assert.equal(point.metrics.requests, 500);
  });

  it("프로젝트 이름을 붙이고 두 축의 합계가 같다", () => {
    const point = adaptOpenAi(raw)[0];

    assert.equal(point.altItems?.[0].label, "prod-assistant");
    const byModel = point.items.reduce((s, i) => s + i.costUsd, 0);
    const byProject = (point.altItems ?? []).reduce((s, i) => s + i.costUsd, 0);
    assert.ok(Math.abs(byModel - byProject) < 1e-9);
    assert.ok(Math.abs(byModel - 12.5) < 1e-9);
  });

  it("config/client-keys.json 매핑은 프로젝트에도 적용된다", () => {
    const point = adaptOpenAi(raw, {
      clientKeyNames: { proj_a: "○○상사 GPT" },
    })[0];

    assert.equal(point.altItems?.[0].label, "○○상사 GPT");
  });
});
