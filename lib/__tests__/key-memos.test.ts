import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  KEY_MEMO_MAX_LENGTH,
  parseKeyMemos,
  setKeyMemo,
} from "@/lib/key-memos";

describe("parseKeyMemos", () => {
  it("서비스·키별 문자열 메모만 남긴다", () => {
    assert.deepEqual(
      parseKeyMemos('{"claude":{"k1":"  운영 서버  ","bad":3},"other":{"k2":"x"}}'),
      { claude: { k1: "운영 서버" } },
    );
  });

  it("깨진 값은 빈 메모다", () => {
    assert.deepEqual(parseKeyMemos("{oops"), {});
    assert.deepEqual(parseKeyMemos(null), {});
  });

  it("지나치게 긴 메모는 저장 한도에서 자른다", () => {
    const parsed = parseKeyMemos(JSON.stringify({ gpt: { k1: "가".repeat(800) } }));
    assert.equal(parsed.gpt?.k1.length, KEY_MEMO_MAX_LENGTH);
  });
});

describe("setKeyMemo", () => {
  it("다른 서비스와 키의 메모를 유지하며 저장한다", () => {
    assert.deepEqual(
      setKeyMemo({ claude: { a: "기존" } }, "gpt", "b", "신규"),
      { claude: { a: "기존" }, gpt: { b: "신규" } },
    );
  });

  it("빈 메모는 해당 키만 삭제한다", () => {
    assert.deepEqual(
      setKeyMemo({ claude: { a: "유지", b: "삭제" } }, "claude", "b", "   "),
      { claude: { a: "유지" } },
    );
  });
});
