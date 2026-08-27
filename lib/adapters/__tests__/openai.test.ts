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
    assert.equal(row.tokens[OPENAI_TOKEN_KINDS.input("text")], 6 * MTOK);
    assert.equal(row.tokens[OPENAI_TOKEN_KINDS.cached("text")], 4 * MTOK);
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

  it("보조 축은 API 키다 — api_key_id 가 project_id 를 이긴다", () => {
    const [row] = toUsageRows([
      {
        model: "gpt-5",
        project_id: "proj_a",
        api_key_id: "key_abc",
        input_tokens: 1,
        output_tokens: 0,
      },
    ]);

    assert.equal(row.keyId, "key_abc");
  });

  it("api_key_id 가 없으면 프로젝트로, 그것도 없으면 콘솔로 떨어진다", () => {
    const [projectOnly] = toUsageRows([
      { model: "gpt-5", project_id: "proj_a", input_tokens: 1, output_tokens: 0 },
    ]);
    const [neither] = toUsageRows([
      { model: "gpt-5", input_tokens: 1, output_tokens: 0 },
    ]);

    // 전부 "콘솔" 한 덩어리로 뭉개지 않는다 — 어느 프로젝트 몫인지는 남긴다.
    assert.equal(projectOnly.keyId, "proj_a");
    assert.equal(neither.keyId, null);
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
    assert.equal(rows[0].tokenKind, OPENAI_TOKEN_KINDS.output("text"));
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

// ─────────────────────────────────────────────────────────────────────────
// 아래는 **2026-08-27 에 실제 조직 계정에서 뽑은 line_item 34종**이다.
// 손으로 지어낸 값이 아니라 실측이라, 이게 깨지면 벤더가 형식을 바꾼 것이다.
// ─────────────────────────────────────────────────────────────────────────

import { normalizeModel } from "../openai";

/** [line_item, 기대 model, 기대 tokenKind] */
const REAL_LINE_ITEMS: [string, string, string | null][] = [
  ["gpt-image-1 image, output", "gpt-image-1", "image.output"],
  ["gpt-image-1 image, input", "gpt-image-1", "image.input"],
  ["gpt-image-1 image, cached input", "gpt-image-1", "image.cached_input"],
  ["gpt-image-1 text, input", "gpt-image-1", "text.input"],
  ["gpt-image-1 text, cached input", "gpt-image-1", "text.cached_input"],
  ["gpt-image-2-2026-04-21 image, output", "gpt-image-2", "image.output"],
  ["gpt-image-2-2026-04-21 image, input", "gpt-image-2", "image.input"],
  ["gpt-image-2-2026-04-21 text, input", "gpt-image-2", "text.input"],
  ["gpt-image-2-2026-04-21 text, output", "gpt-image-2", "text.output"],
  ["gpt-5.6-terra, output", "gpt-5.6-terra", "text.output"],
  ["gpt-5.6-terra, input", "gpt-5.6-terra", "text.input"],
  ["gpt-5.6-terra, cached input", "gpt-5.6-terra", "text.cached_input"],
  ["gpt-5.6-terra, cache writes", "gpt-5.6-terra", "cache_writes"],
  ["gpt-5.4-2026-03-05, output", "gpt-5.4", "text.output"],
  ["gpt-5.4-2026-03-05, cached input", "gpt-5.4", "text.cached_input"],
  ["gpt-4o-2024-08-06, output", "gpt-4o", "text.output"],
  ["gpt-5-mini-2025-08-07, input", "gpt-5-mini", "text.input"],
  ["gpt-5.4-nano-2026-03-17, output", "gpt-5.4-nano", "text.output"],
  ["whisper", "whisper", null],
];

describe("line_item 파싱 — 실측 34종", () => {
  for (const [raw, model, kind] of REAL_LINE_ITEMS) {
    it(JSON.stringify(raw), () => {
      const [row] = toCostRows([{ amount: { value: 1, currency: "usd" }, line_item: raw }]);
      assert.equal(row.model, model);
      assert.equal(row.tokenKind, kind);
    });
  }

  it("**캐시 쓰기와 캐시 읽기를 섞지 않는다** — 단가가 다르다", () => {
    const [write] = toCostRows([
      { amount: { value: 1, currency: "usd" }, line_item: "gpt-5.6-terra, cache writes" },
    ]);
    const [read] = toCostRows([
      { amount: { value: 1, currency: "usd" }, line_item: "gpt-5.6-terra, cached input" },
    ]);
    assert.notEqual(write.tokenKind, read.tokenKind);
  });

  it("모달리티가 모델명에 섞여 들어가지 않는다", () => {
    const [row] = toCostRows([
      { amount: { value: 1, currency: "usd" }, line_item: "gpt-image-1 image, output" },
    ]);
    // "gpt-image-1 image" 라는 모델은 존재하지 않는다.
    assert.equal(row.model, "gpt-image-1");
  });
});

describe("모델 이름 정규화 — usage 와 costs 를 잇는다", () => {
  it("**양쪽이 서로 다른 이름을 주는 실제 사례가 같은 이름으로 모인다**", () => {
    // usage 에만 날짜가 붙는 경우
    assert.equal(normalizeModel("gpt-image-1-2025-04-23"), normalizeModel("gpt-image-1"));
    // costs 에만 날짜가 붙는 경우 (방향이 반대다)
    assert.equal(normalizeModel("gpt-image-2"), normalizeModel("gpt-image-2-2026-04-21"));
    // 양쪽 같은 경우
    assert.equal(normalizeModel("gpt-4o-2024-08-06"), "gpt-4o");
  });

  it("날짜가 아닌 접미사는 건드리지 않는다", () => {
    assert.equal(normalizeModel("gpt-5.6-terra"), "gpt-5.6-terra");
    assert.equal(normalizeModel("gpt-5.4-nano-2026-03-17"), "gpt-5.4-nano");
    assert.equal(normalizeModel(null), null);
  });

  it("usage 행의 모델도 정규화된다 (안 하면 표가 두 줄로 갈린다)", () => {
    const [row] = toUsageRows([
      { model: "gpt-image-1-2025-04-23", input_tokens: 10, output_tokens: 5 },
    ]);
    assert.equal(row.model, "gpt-image-1");
  });
});

describe("모달리티별 토큰 — costs 와 같은 축으로 쪼갠다", () => {
  it("실측 응답 모양 그대로 쪼갠다", () => {
    // 2026-08-27 gpt-image-2 실제 행
    const [row] = toUsageRows([
      {
        model: "gpt-image-2",
        input_tokens: 31,
        input_cached_tokens: 0,
        input_uncached_tokens: 31,
        output_tokens: 1756,
        input_text_tokens: 31,
        input_image_tokens: 0,
        output_text_tokens: 0,
        output_image_tokens: 1756,
      },
    ]);
    assert.equal(row.tokens["text.input"], 31);
    assert.equal(row.tokens["image.output"], 1756);
    // 0 인 축은 아예 넣지 않는다.
    assert.equal(row.tokens["image.input"], undefined);
  });

  it("**모달리티 필드가 없어도 토큰이 증발하지 않는다** (text 로 몰아넣는다)", () => {
    const [row] = toUsageRows([
      { model: "gpt-5", input_tokens: 100, input_cached_tokens: 40, output_tokens: 20 },
    ]);
    assert.equal(row.tokens["text.input"], 60);
    assert.equal(row.tokens["text.cached_input"], 40);
    assert.equal(row.tokens["text.output"], 20);
  });

  it("input_uncached_tokens 를 벤더가 주면 그걸 쓴다", () => {
    // 실측: input 27444 / cached 8448 / uncached 18996
    const [row] = toUsageRows([
      {
        model: "gpt-5.6-terra",
        input_tokens: 27444,
        input_cached_tokens: 8448,
        input_uncached_tokens: 18996,
        output_tokens: 5123,
      },
    ]);
    assert.equal(row.metrics.inputTokens, 18996);
    assert.equal(row.tokens["text.input"], 18996);
  });

  it("캐시 생성 토큰을 따로 센다", () => {
    const [row] = toUsageRows([
      {
        model: "gpt-5.6-terra",
        input_tokens: 100,
        input_cached_tokens: 0,
        output_tokens: 0,
        input_cache_write_tokens: 77,
      },
    ]);
    assert.equal(row.tokens["cache_writes"], 77);
  });
});
