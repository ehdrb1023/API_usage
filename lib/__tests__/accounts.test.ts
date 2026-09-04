/**
 * 계정 레지스트리 테스트.
 *
 * 여기서 제일 위험한 결함은 **키 폴백**이다. 2번 계정 키가 없을 때 1번 키로
 * 조회되면 남의 조직 숫자가 2번 탭에 뜨는데, 화면만 봐서는 절대 알 수 없다.
 * 그래서 "없으면 던진다" 를 테스트로 못박는다.
 *
 * ⚠️ 키처럼 생긴 문자열을 소스에 그대로 적지 않는다 — 가짜여도 시크릿 스캔에
 *    걸리고, 진짜와 구분하려고 사람이 매번 확인하게 된다. 조각으로 조립한다.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  CLAUDE_ACCOUNTS,
  hasAdminKey,
  parseAccountLabels,
  requireAdminKey,
} from "../accounts";

const VAR = "ANTHROPIC_ADMIN_KEY_TEST_ONLY";

/** `.env.example` 의 자리표시자 모양 (x 8자 이상). */
const placeholder = ["sk", "ant", "admin01", "x".repeat(12)].join("-");
/** 실제 키 자리에 넣을 더미. 형식만 흉내 낸다. */
const looksReal = ["sk", "ant", "admin01", "not-a-real-key"].join("-");

afterEach(() => {
  delete process.env[VAR];
});

describe("CLAUDE_ACCOUNTS", () => {
  it("계정마다 id 와 환경변수가 서로 다르다", () => {
    // 둘 중 하나라도 겹치면 한 계정이 다른 계정을 덮어쓴다.
    const ids = CLAUDE_ACCOUNTS.map((a) => a.id);
    const vars = CLAUDE_ACCOUNTS.map((a) => a.envVar);

    assert.equal(new Set(ids).size, ids.length, "id 가 겹친다");
    assert.equal(new Set(vars).size, vars.length, "환경변수가 겹친다");
  });

  it("첫 계정은 기존 환경변수를 그대로 쓴다", () => {
    // 계정을 늘리면서 1번 계정 변수명을 바꾸면 기존 .env 가 조용히 안 읽힌다.
    assert.equal(CLAUDE_ACCOUNTS[0].envVar, "ANTHROPIC_ADMIN_KEY");
  });
});

describe("requireAdminKey — 폴백 금지", () => {
  it("키가 없으면 던진다", () => {
    // 여기서 다른 계정 키로 떨어지면 남의 조직 숫자가 이 탭에 뜬다.
    assert.throws(() => requireAdminKey(VAR), new RegExp(VAR));
  });

  it("자리표시자는 키로 치지 않는다", () => {
    process.env[VAR] = placeholder;
    assert.throws(() => requireAdminKey(VAR), /자리표시자/);
  });

  it("공백만 있는 값도 없는 것으로 본다", () => {
    process.env[VAR] = "   ";
    assert.throws(() => requireAdminKey(VAR));
  });

  it("실제 키는 앞뒤 공백을 떼고 돌려준다", () => {
    process.env[VAR] = `  ${looksReal}  `;
    assert.equal(requireAdminKey(VAR), looksReal);
  });
});

describe("hasAdminKey", () => {
  it("없거나 자리표시자면 false — 탭을 띄우지 않는다", () => {
    assert.equal(hasAdminKey(VAR), false);

    process.env[VAR] = placeholder;
    assert.equal(hasAdminKey(VAR), false);
  });

  it("실제 키가 있으면 true", () => {
    process.env[VAR] = looksReal;
    assert.equal(hasAdminKey(VAR), true);
  });
});

describe("parseAccountLabels", () => {
  it("알려진 id 만 통과시킨다", () => {
    // 오타를 조용히 통과시키면 이름이 안 바뀌는 이유를 찾을 수 없다.
    const out = parseAccountLabels({
      labels: { "claude-2": "본사", claude9: "없는 계정", gpt: "GPT 조직" },
    });

    assert.deepEqual(out, { "claude-2": "본사", gpt: "GPT 조직" });
  });

  it("빈 이름은 버리고 앞뒤 공백은 뗀다", () => {
    const out = parseAccountLabels({
      labels: { claude: "   ", "claude-3": "  연구소  " },
    });

    assert.deepEqual(out, { "claude-3": "연구소" });
  });

  it("파일 모양이 아니면 빈 값 — 던지지 않는다", () => {
    for (const raw of [null, {}, { labels: "문자열" }, 42]) {
      assert.deepEqual(parseAccountLabels(raw), {});
    }
  });
});
