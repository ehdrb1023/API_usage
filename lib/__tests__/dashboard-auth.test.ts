/**
 * lib/dashboard-auth.ts — 대시보드 접근 판정 테스트.
 *
 * `authorize()` 만 부른다 — 순수 함수라 서버도 `next/server` 도 필요 없다.
 * 여기가 뚫리면 조직 전체 지출과 거래처 이름이 그대로 공개되므로,
 * **경계 조건을 빠짐없이 고정해 둔다.**
 *
 * 실행:
 *   node --import ./lib/clients/__tests__/ts-resolve.mjs --test "lib/**\/__tests__/*.test.ts"
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { authorize } from "../dashboard-auth";

const PW = "test-pw-1234";
const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

const ask = (authorization: string | null, password = PW, production = true) =>
  authorize({ authorization, password, production });

describe("비밀번호가 설정된 경우", () => {
  it("맞으면 통과한다", () => {
    assert.equal(ask(basic("아무개", PW)).allow, true);
  });

  it("사용자명은 보지 않는다 — 비밀번호만 맞으면 된다", () => {
    assert.equal(ask(basic("", PW)).allow, true);
    assert.equal(ask(basic("전혀-다른-이름", PW)).allow, true);
  });

  it("틀리면 401", () => {
    const v = ask(basic("x", "wrong"));
    assert.equal(v.allow, false);
    assert.equal(v.allow === false && v.status, 401);
  });

  it("헤더가 아예 없으면 401", () => {
    assert.equal(ask(null).allow, false);
  });

  it("Basic 이 아닌 방식은 401 (Bearer 로 우회 불가)", () => {
    assert.equal(ask(`Bearer ${PW}`).allow, false);
  });

  it("base64 가 깨져 있어도 던지지 않고 401", () => {
    assert.equal(ask("Basic !!!not-base64!!!").allow, false);
  });

  it("Basic 스킴 대소문자는 가린다 (basic/BASIC 도 받는다)", () => {
    const encoded = basic("x", PW).slice(6);
    assert.equal(ask(`basic ${encoded}`).allow, true);
    assert.equal(ask(`BASIC ${encoded}`).allow, true);
  });

  it("**비밀번호에 콜론이 있어도 통째로 비교한다**", () => {
    // 첫 콜론에서만 잘라야 한다. 안 그러면 "a:b" 비밀번호가 "a" 로 잘려
    // 훨씬 짧은 비밀번호로 통과된다.
    const withColon = "pa:ss:word";
    assert.equal(
      authorize({
        authorization: basic("u", withColon),
        password: withColon,
        production: true,
      }).allow,
      true,
    );
    assert.equal(
      authorize({ authorization: basic("u", "pa"), password: withColon, production: true })
        .allow,
      false,
    );
  });

  it("콜론이 없는 자격증명은 401 (빈 비밀번호로 취급)", () => {
    const noColon = `Basic ${Buffer.from("사용자만").toString("base64")}`;
    assert.equal(ask(noColon).allow, false);
  });

  it("앞뒤 공백은 설정값 쪽에서만 없앤다", () => {
    // .env 에 `DASHBOARD_PASSWORD= secret ` 처럼 들어가도 동작해야 한다.
    assert.equal(
      authorize({ authorization: basic("u", "secret"), password: "  secret  ", production: true })
        .allow,
      true,
    );
  });

  it("접두사만 맞는 비밀번호는 통과 못 한다", () => {
    assert.equal(ask(basic("u", PW.slice(0, -1))).allow, false);
    assert.equal(ask(basic("u", PW + "x")).allow, false);
  });
});

describe("비밀번호가 없는 경우 — 환경에 따라 반대로 움직인다", () => {
  it("개발이면 통과시킨다 (로컬에서 매번 치게 하면 아무도 안 쓴다)", () => {
    assert.equal(authorize({ authorization: null, password: "", production: false }).allow, true);
    assert.equal(
      authorize({ authorization: null, password: undefined, production: false }).allow,
      true,
    );
  });

  it("**운영이면 막는다 (503)** — 여기서 열면 조용히 전면 공개된다", () => {
    const v = authorize({ authorization: null, password: "", production: true });
    assert.equal(v.allow, false);
    assert.equal(v.allow === false && v.status, 503);
    // 무엇을 해야 하는지 화면에 적혀 있어야 한다.
    assert.match(v.allow === false ? v.message : "", /DASHBOARD_PASSWORD/);
  });

  it("공백만 든 비밀번호는 없는 것으로 본다", () => {
    assert.equal(authorize({ authorization: null, password: "   ", production: true }).allow, false);
  });
});
