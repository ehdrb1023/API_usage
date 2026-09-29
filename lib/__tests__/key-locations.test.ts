import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  hintMatches,
  isWeakHint,
  locateKeys,
  maskKey,
  type HostProject,
  type KeyFamily,
} from "@/lib/key-locations";

const FAMILY: KeyFamily = {
  valuePrefix: "sk-ant-api",
  varName: /ANTHROPIC/,
};

const KEY_A = "sk-ant-api03-R2DaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaigAA";
const KEY_B = "sk-ant-api03-Q9ZbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbXyZ1";

function project(name: string, vars: HostProject["vars"] = []): HostProject {
  return { name, domains: [`${name}.example.com`], vars };
}

describe("maskKey", () => {
  it("키 모양이면 앞16자...뒤4자", () => {
    assert.equal(maskKey(KEY_A), "sk-ant-api03-R2D...igAA");
  });
  it("키가 아닌 값은 버린다", () => {
    assert.equal(maskKey("https://api.example.com"), null);
    assert.equal(maskKey(""), null);
    assert.equal(maskKey(null), null);
  });
});

describe("hintMatches", () => {
  it("벤더 힌트와 가린 값이 같은 키면 true", () => {
    assert.equal(hintMatches("sk-ant-api03-R2D...igAA", maskKey(KEY_A)!), true);
    assert.equal(hintMatches("sk-ant-api03-R2D...igAA", maskKey(KEY_B)!), false);
  });
  it("별표로 가린 힌트는 뒤 4자와 접두사로 비교", () => {
    const openai = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789WXYZ";
    assert.equal(hintMatches("sk-proj-" + "*".repeat(30) + "WXYZ", maskKey(openai)!), true);
    assert.equal(hintMatches("sk-proj-" + "*".repeat(30) + "WXYQ", maskKey(openai)!), false);
  });
  it("공개 접두사뿐인 힌트는 약한 대조로 분류", () => {
    assert.equal(isWeakHint("sk-proj-*****WXYZ"), true);
    assert.equal(isWeakHint("sk-ant-api03-R2D...igAA"), false);
  });
});

describe("locateKeys — 1차 이름 대조", () => {
  const projects = [
    project("speciai-team"),
    project("speciai-crm"),
    project("team-ai-kr"),
    project("yulam-web"),
    project("sebut-a"),
    project("sebut-b"),
    project("sebut-c"),
    project("sebut-d"),
  ];

  it("구분자만 다른 이름은 일치", () => {
    const r = locateKeys([{ id: "k", name: "speciai.team" }], projects, FAMILY);
    assert.deepEqual(r.k.locations.map((l) => [l.project, l.by]), [["speciai-team", "name"]]);
  });
  it("숫자 꼬리·잡음 단어를 떼고 일치", () => {
    const r = locateKeys([{ id: "k", name: "speciai.team2" }], projects, FAMILY);
    assert.equal(r.k.locations[0]?.project, "speciai-team");
  });
  it("조각이 포함되면 유사", () => {
    const r = locateKeys(
      [
        { id: "crm", name: "crm" },
        { id: "yulam", name: "yulam-test" },
        { id: "teamai", name: "teamai" },
      ],
      projects,
      FAMILY,
    );
    assert.deepEqual(r.crm.locations.map((l) => [l.project, l.by]), [["speciai-crm", "similar"]]);
    assert.equal(r.yulam.locations[0]?.project, "yulam-web");
    assert.equal(r.teamai.locations[0]?.project, "team-ai-kr");
  });
  it("후보가 너무 많으면 추측하지 않는다", () => {
    const r = locateKeys([{ id: "k", name: "sebut-test" }], projects, FAMILY);
    assert.equal(r.k.locations.length, 0);
    assert.match(r.k.note ?? "", /4개/);
  });
  it("수동 지정이 이름 대조보다 앞선다", () => {
    const r = locateKeys([{ id: "k", name: "긁" }], [project("geuk")], FAMILY, { 긁: ["geuk"] });
    assert.deepEqual(r.k.locations.map((l) => [l.project, l.by]), [["geuk", "manual"]]);
  });
});

describe("locateKeys — 2차 값 대조", () => {
  const hint = "sk-ant-api03-R2D...igAA";

  it("이름이 맞고 값도 맞으면 match", () => {
    const p = project("crm", [
      { key: "ANTHROPIC_API_KEY", type: "encrypted", targets: ["production"], masked: maskKey(KEY_A) },
    ]);
    const r = locateKeys([{ id: "k", name: "crm", hint }], [p], FAMILY);
    assert.equal(r.k.locations[0].value, "match");
    assert.deepEqual(r.k.locations[0].vars, ["ANTHROPIC_API_KEY [production]"]);
  });
  it("이름은 맞는데 다른 키가 들어 있으면 mismatch", () => {
    const p = project("crm", [
      { key: "ANTHROPIC_API_KEY", type: "encrypted", targets: [], masked: maskKey(KEY_B) },
    ]);
    const r = locateKeys([{ id: "k", name: "crm", hint }], [p], FAMILY);
    assert.equal(r.k.locations[0].value, "mismatch");
  });
  it("값을 못 읽으면 sensitive", () => {
    const p = project("crm", [{ key: "ANTHROPIC_API_KEY", type: "sensitive", targets: [], masked: null }]);
    const r = locateKeys([{ id: "k", name: "crm", hint }], [p], FAMILY);
    assert.equal(r.k.locations[0].value, "sensitive");
  });
  it("이름이 전혀 달라도 값이 맞으면 사용처로 잡는다", () => {
    const p = project("other-site", [
      { key: "AI_KEY", type: "encrypted", targets: [], masked: maskKey(KEY_A) },
    ]);
    const r = locateKeys([{ id: "k", name: "marketing", hint }], [p], FAMILY);
    assert.deepEqual(r.k.locations.map((l) => [l.project, l.by, l.value]), [
      ["other-site", "value", "match"],
    ]);
  });
});
