/**
 * lib/adapters/anthropic.ts 유닛 테스트 — 순수 함수라 네트워크·파일을 타지 않습니다.
 *
 * 초점은 "서비스별 사용량" 표의 **표시 이름 우선순위**입니다:
 *   1순위 config/client-keys.json 매핑 → 2순위 Console 키 이름 → 3순위 키 앞자리
 *
 * 실행:
 *   node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/**\/__tests__/*.test.ts"
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BreakdownItem } from "@/lib/types";

import { adaptAnthropic, type AnthropicApiKeyMeta, type AnthropicRaw } from "../anthropic";

// ---------------------------------------------------------------- 목 헬퍼

const DATE = "2026-08-01T00:00:00Z";

function usageRow(apiKeyId: string | null, tokens = 1000) {
  return {
    model: "claude-opus-4-8",
    api_key_id: apiKeyId,
    uncached_input_tokens: tokens,
    cache_read_input_tokens: 0,
    cache_creation: {
      ephemeral_5m_input_tokens: 0,
      ephemeral_1h_input_tokens: 0,
    },
    output_tokens: 0,
  };
}

function costRow(amount: string) {
  return {
    amount,
    currency: "USD",
    model: "claude-opus-4-8",
    description: "claude-opus-4-8 Usage - Input Tokens",
    token_type: "uncached_input_tokens",
  };
}

function meta(
  id: string,
  name: string,
  over: Partial<AnthropicApiKeyMeta> = {},
): AnthropicApiKeyMeta {
  return { id, name, status: "active", partial_key_hint: null, ...over };
}

function raw(
  usage: ReturnType<typeof usageRow>[],
  apiKeys?: AnthropicApiKeyMeta[],
): AnthropicRaw {
  return {
    usage_report: {
      data: [{ starting_at: DATE, ending_at: DATE, results: usage }],
    },
    cost_report: {
      data: [{ starting_at: DATE, ending_at: DATE, results: [costRow("100")] }],
    },
    api_keys: apiKeys,
  };
}

/** 첫날의 키별 행을 key 로 찾는다. */
function altItem(points: ReturnType<typeof adaptAnthropic>, key: string): BreakdownItem {
  const found = points[0].altItems?.find((i) => i.key === key);
  assert.ok(found, `키 ${key} 행이 없습니다`);
  return found;
}

// ---------------------------------------------------------------- 우선순위

describe("서비스별 표시 이름 우선순위", () => {
  const KEY = "apikey_01CUM5RWcLMP5RdrL6LSt8gV";

  it("1순위 — 매핑이 있으면 Console 이름을 덮어쓴다", () => {
    const points = adaptAnthropic(raw([usageRow(KEY)], [meta(KEY, "console-name")]), {
      clientKeyNames: { [KEY]: "○○법무법인 챗봇" },
    });

    assert.equal(altItem(points, KEY).label, "○○법무법인 챗봇");
  });

  it("2순위 — 매핑이 비어 있으면 기존과 동일하게 Console 이름", () => {
    const points = adaptAnthropic(
      raw([usageRow(KEY)], [meta(KEY, "console-name")]),
      { clientKeyNames: {} },
    );

    assert.equal(altItem(points, KEY).label, "console-name");
  });

  it("2순위 — options 를 아예 안 넘겨도 Console 이름 (하위 호환)", () => {
    const points = adaptAnthropic(raw([usageRow(KEY)], [meta(KEY, "console-name")]));

    assert.equal(altItem(points, KEY).label, "console-name");
  });

  it("3순위 — 매핑에도 Console 목록에도 없으면 키 앞자리 + 미등록 배지", () => {
    const points = adaptAnthropic(raw([usageRow(KEY)], []));
    const item = altItem(points, KEY);

    assert.equal(item.label, "apikey_01CUM5RWc…"); // "apikey_" 7 + 9글자
    assert.equal(item.badge, "미등록");
    // 매핑 파일에 옮겨 적으려면 잘리지 않은 id 가 필요하다.
    assert.equal(item.title, KEY);
  });

  it("1순위는 Console 목록에 없는 키에도 적용된다 (삭제된 키에 이름 붙이기)", () => {
    const points = adaptAnthropic(raw([usageRow(KEY)], []), {
      clientKeyNames: { [KEY]: "옛 거래처" },
    });
    const item = altItem(points, KEY);

    assert.equal(item.label, "옛 거래처");
    assert.equal(item.badge, undefined);
  });

  it("매핑은 이름만 바꾼다 — 비용·토큰은 그대로", () => {
    const plain = adaptAnthropic(raw([usageRow(KEY)], [meta(KEY, "console-name")]));
    const mapped = adaptAnthropic(raw([usageRow(KEY)], [meta(KEY, "console-name")]), {
      clientKeyNames: { [KEY]: "새 이름" },
    });

    assert.equal(altItem(mapped, KEY).costUsd, altItem(plain, KEY).costUsd);
    assert.deepEqual(altItem(mapped, KEY).metrics, altItem(plain, KEY).metrics);
  });

  it("비활성 배지는 매핑으로 이름을 바꿔도 유지된다", () => {
    const points = adaptAnthropic(
      raw([usageRow(KEY)], [meta(KEY, "old", { status: "archived" })]),
      { clientKeyNames: { [KEY]: "옛 거래처" } },
    );

    assert.equal(altItem(points, KEY).label, "옛 거래처");
    assert.equal(altItem(points, KEY).badge, "비활성");
  });

  it("합성 행(콘솔 직접 사용)은 매핑 대상이 아니다", () => {
    const points = adaptAnthropic(raw([usageRow(null)], []), {
      clientKeyNames: { __console__: "덮어쓰기 시도" },
    });

    assert.equal(altItem(points, "__console__").label, "(콘솔 직접 사용)");
  });
});

// ---------------------------------------------------------------- 이름 겹침

describe("이름이 겹칠 때 키 앞자리 구분", () => {
  const A = "apikey_01AAAAAAAAAAAAAAAAAAAAAAA";
  const B = "apikey_01BBBBBBBBBBBBBBBBBBBBBBB";

  it("Console 이름이 같으면 partial_key_hint 를 붙인다", () => {
    const points = adaptAnthropic(
      raw(
        [usageRow(A), usageRow(B)],
        [
          meta(A, "speciai.team", { partial_key_hint: "sk-ant-api03-jef...KgAA" }),
          meta(B, "speciai.team", { partial_key_hint: "sk-ant-api03-Ewn...gAAA" }),
        ],
      ),
    );

    assert.equal(altItem(points, A).hint, "sk-ant-api03-jef...KgAA");
    assert.equal(altItem(points, B).hint, "sk-ant-api03-Ewn...gAAA");
  });

  it("매핑으로 서로 다른 키에 같은 이름을 달아도 구분자가 붙는다", () => {
    const points = adaptAnthropic(
      raw([usageRow(A), usageRow(B)], [meta(A, "가"), meta(B, "나")]),
      { clientKeyNames: { [A]: "마케팅", [B]: "마케팅" } },
    );

    assert.equal(altItem(points, A).label, "마케팅");
    assert.equal(altItem(points, B).label, "마케팅");
    assert.ok(altItem(points, A).hint, "겹치는데 구분자가 없습니다");
    assert.notEqual(altItem(points, A).hint, altItem(points, B).hint);
  });

  it("매핑으로 겹침을 풀면 구분자가 사라진다", () => {
    const points = adaptAnthropic(
      raw(
        [usageRow(A), usageRow(B)],
        [
          meta(A, "speciai.team", { partial_key_hint: "sk-ant-api03-jef...KgAA" }),
          meta(B, "speciai.team", { partial_key_hint: "sk-ant-api03-Ewn...gAAA" }),
        ],
      ),
      { clientKeyNames: { [A]: "A 거래처", [B]: "B 거래처" } },
    );

    assert.equal(altItem(points, A).hint, undefined);
    assert.equal(altItem(points, B).hint, undefined);
  });

  it("이름이 안 겹치면 구분자를 붙이지 않는다", () => {
    const points = adaptAnthropic(
      raw([usageRow(A), usageRow(B)], [meta(A, "가"), meta(B, "나")]),
    );

    assert.equal(altItem(points, A).hint, undefined);
    assert.equal(altItem(points, B).hint, undefined);
  });
});

// -------------------------------------------------------- 두 축의 합계 일치

describe("모델별 축과 키별 축", () => {
  it("이름을 바꿔도 두 축의 비용·토큰 합계는 같다", () => {
    const A = "apikey_01AAAAAAAAAAAAAAAAAAAAAAA";
    const B = "apikey_01BBBBBBBBBBBBBBBBBBBBBBB";
    const points = adaptAnthropic(
      raw([usageRow(A, 3000), usageRow(B, 1000)], [meta(A, "가"), meta(B, "나")]),
      { clientKeyNames: { [A]: "A 거래처" } },
    );

    const sum = (items: BreakdownItem[] = []) => ({
      cost: items.reduce((s, i) => s + i.costUsd, 0),
      tokens: items.reduce((s, i) => s + i.metrics.totalTokens, 0),
    });

    const byModel = sum(points[0].items);
    const byKey = sum(points[0].altItems);

    assert.ok(Math.abs(byModel.cost - byKey.cost) < 1e-9);
    assert.equal(byModel.tokens, byKey.tokens);
    // 안분 비율도 확인: 3:1 토큰이면 비용도 3:1
    assert.ok(Math.abs(altItem(points, A).costUsd - 0.75) < 1e-9);
    assert.ok(Math.abs(altItem(points, B).costUsd - 0.25) < 1e-9);
  });
});
