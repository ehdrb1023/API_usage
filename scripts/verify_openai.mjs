#!/usr/bin/env node
/**
 * OpenAI Admin API 실응답 검증 — `docs/openai-integration.md` 체크리스트를 자동으로 돈다.
 *
 *   node scripts/verify_openai.mjs
 *
 * ⚠️ **이 스크립트를 통과하기 전에는 GPT 탭의 숫자를 믿지 말 것.** 코드의 경로·파라미터·
 *    필드명이 전부 공개 문서 기준이라, 틀려도 에러가 안 나고 그럴듯한 숫자가 뜬다.
 *    (`lib/adapters/openai.ts` 파일 머리말에 틀리기 쉬운 지점이 정리돼 있다)
 *
 * 앱 경로가 아니다 — `lib/` 를 import 하지 않고 순수 fetch 로만 확인한다. 앱과 같은
 * 코드를 쓰면 앱이 틀렸을 때 검증도 같이 틀리기 때문이다.
 *
 * 필요한 것: `.env` 의 OPENAI_ADMIN_KEY (sk-admin-…). 프로젝트 키(sk-proj-…)로는 401 이다.
 * 조직이 여럿이면 OPENAI_ORG_ID 도 채울 것.
 */

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------- .env 읽기

function loadEnv(file = ".env") {
  try {
    const out = {};
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

const env = { ...loadEnv(), ...process.env };
const KEY = (env.OPENAI_ADMIN_KEY ?? "").trim();
const BASE = env.OPENAI_API_BASE ?? "https://api.openai.com";
const ORG = (env.OPENAI_ORG_ID ?? "").trim();

if (!KEY || /x{8,}/i.test(KEY)) {
  console.error(
    "OPENAI_ADMIN_KEY 가 비어 있거나 자리표시자입니다.\n" +
      "  platform.openai.com → Settings → Organization → Admin keys 에서\n" +
      "  조직 Owner 권한으로 Admin 키(sk-admin-…)를 발급해 .env 에 넣으세요.\n" +
      "  ⚠️ 프로젝트 키(sk-proj-…)로는 조직 사용량 API 를 호출할 수 없습니다.",
  );
  process.exit(1);
}
if (!KEY.startsWith("sk-admin")) {
  console.warn(
    `⚠️  키가 "sk-admin" 으로 시작하지 않습니다 (${KEY.slice(0, 8)}…). ` +
      "프로젝트 키라면 401/403 이 납니다.\n",
  );
}

// ---------------------------------------------------------------- 결과 기록

const results = [];
const record = (ok, what, detail) => {
  results.push({ ok, what, detail });
  console.log(`${ok ? "  ✅" : "  ❌"} ${what}${detail ? ` — ${detail}` : ""}`);
};

async function get(path, params = {}) {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    // ⚠️ 배열은 **반복** 형태다 (Anthropic 의 group_by[] 대괄호와 다르다).
    //    여기가 틀리면 400 이 난다 — 체크리스트 2번.
    for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(item));
  }
  const headers = { authorization: `Bearer ${KEY}`, accept: "application/json" };
  if (ORG) headers["openai-organization"] = ORG;

  const res = await fetch(url, { headers });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* 아래에서 raw 로 보고한다 */
  }
  return { status: res.status, ok: res.ok, body, raw: text, url: url.toString() };
}

/** 앱이 조회하는 구간과 같게 — 최근 2일. 짧게 잡아야 429 를 피한다. */
const now = Math.floor(Date.now() / 1000);
const twoDaysAgo = now - 2 * 24 * 3600;

// ---------------------------------------------------------------- 1. usage

console.log("\n[1] GET /v1/organization/usage/completions  (bucket_width=1h)");
const usage = await get("/v1/organization/usage/completions", {
  start_time: twoDaysAgo,
  end_time: now,
  bucket_width: "1h",
  limit: 24,
  group_by: ["model", "project_id", "api_key_id"],
});

if (!usage.ok) {
  record(false, `HTTP ${usage.status}`, usage.raw.slice(0, 300));
  if (usage.status === 404) {
    console.log("     → 경로가 /v1/organization (단수) 인지 확인하세요.");
  }
} else {
  record(true, `HTTP 200`);
  const buckets = usage.body?.data ?? [];
  record(Array.isArray(buckets), "응답이 { data: [...] } 형태", `버킷 ${buckets.length}개`);
  record(
    "has_more" in (usage.body ?? {}) && "next_page" in (usage.body ?? {}),
    "페이지네이션이 has_more + next_page 커서",
    `has_more=${usage.body?.has_more}`,
  );

  const b0 = buckets[0];
  if (b0) {
    record(
      typeof b0.start_time === "number",
      "start_time 이 unix 초 (ISO 문자열이 아님)",
      String(b0.start_time),
    );
    record(
      b0.end_time - b0.start_time === 3600,
      "1h 버킷이 실제로 3600초",
      `${b0.end_time - b0.start_time}초`,
    );
  }

  const rows = buckets.flatMap((b) => b.results ?? []);
  const nonEmpty = rows.filter((r) => (r.input_tokens ?? 0) + (r.output_tokens ?? 0) > 0);
  console.log(`     결과 행 ${rows.length}개 (사용량 있는 행 ${nonEmpty.length}개)`);

  if (nonEmpty.length === 0) {
    record(false, "사용량 있는 행이 없어 필드 검증 불가", "최근 2일 GPT API 호출이 없습니다");
  } else {
    const r = nonEmpty[0];
    console.log(`     샘플: ${JSON.stringify(r)}`);
    record("input_tokens" in r, "input_tokens 필드 존재");
    record("output_tokens" in r, "output_tokens 필드 존재");
    record(
      "num_model_requests" in r,
      "요청 수 필드명이 num_model_requests",
      "n_requests 등 다른 이름이면 '요청' 지표가 0 으로 뜹니다",
    );
    record(
      "api_key_id" in r,
      "group_by=api_key_id 가 실제로 먹었다",
      "안 먹으면 GPT 탭 'API 키별' 표가 통째로 프로젝트 단위로 떨어집니다",
    );
    record("model" in r, "group_by=model 이 실제로 먹었다");

    // ⚠️ 체크리스트 최상위 항목. 여기가 반대면 두 탭의 "입력" 뜻이 달라진다.
    const cached = r.input_cached_tokens ?? 0;
    if (cached > 0) {
      record(
        r.input_tokens >= cached,
        "input_tokens 가 input_cached_tokens 를 포함한다",
        `input=${r.input_tokens}, cached=${cached} → ` +
          (r.input_tokens >= cached
            ? "어댑터가 빼는 게 맞습니다"
            : "⚠️ 이미 제외된 값입니다. lib/adapters/openai.ts 의 빼기를 없애야 합니다"),
      );
    } else {
      console.log("     ⏭  input_cached_tokens 가 0 이라 포함 관계는 확인 못 했습니다");
    }
  }
}

// ---------------------------------------------------------------- 2. costs

console.log("\n[2] GET /v1/organization/costs  (bucket_width=1d)");
const costs = await get("/v1/organization/costs", {
  start_time: twoDaysAgo,
  end_time: now,
  bucket_width: "1d",
  limit: 7,
  group_by: ["line_item", "project_id"],
});

if (!costs.ok) {
  record(false, `HTTP ${costs.status}`, costs.raw.slice(0, 300));
} else {
  record(true, "HTTP 200");
  const rows = (costs.body?.data ?? []).flatMap((b) => b.results ?? []);
  console.log(`     결과 행 ${rows.length}개`);
  const r = rows.find((x) => (x.amount?.value ?? 0) > 0) ?? rows[0];
  if (!r) {
    record(false, "비용 행이 없어 검증 불가", "최근 2일 과금이 없습니다");
  } else {
    console.log(`     샘플: ${JSON.stringify(r)}`);
    record(
      typeof r.amount?.value === "number",
      "amount.value 가 숫자",
      `${r.amount?.value} ${r.amount?.currency}`,
    );
    record(
      r.amount?.currency === "usd" || r.amount?.currency === "USD",
      "통화가 USD",
      "다른 통화면 lib/adapters/openai.ts 에 환산이 필요합니다",
    );
    // ⚠️ 형식을 못 맞히면 조용히 블렌디드 단가로 떨어진다 — 틀려도 티가 안 난다.
    const li = r.line_item;
    record(
      typeof li === "string" && li.includes(","),
      'line_item 이 "모델, 토큰종류" 형식',
      li === null || li === undefined
        ? "null 입니다 — 모델별 비용이 블렌디드 단가로 뭉개집니다"
        : `실제 값: ${JSON.stringify(li)} → lib/adapters/openai.ts 의 parseLineItem 을 이 형식에 맞추세요`,
    );
  }
}

// ---------------------------------------------------------------- 3. projects

console.log("\n[3] GET /v1/organization/projects");
const projects = await get("/v1/organization/projects", {
  limit: 100,
  include_archived: true,
});

let projectIds = [];
if (!projects.ok) {
  record(false, `HTTP ${projects.status}`, projects.raw.slice(0, 300));
} else {
  const data = projects.body?.data ?? [];
  projectIds = data.map((p) => p.id);
  record(true, "HTTP 200", `프로젝트 ${data.length}개`);
  record(
    "last_id" in (projects.body ?? {}),
    "페이지네이션이 after + last_id (리포트의 next_page 커서와 다름)",
  );
  if (data[0]) {
    record("name" in data[0] && "status" in data[0], "name·status 필드 존재");
    console.log(`     ${data.map((p) => `${p.name}(${p.status})`).join(", ")}`);
  }
}

// ---------------------------------------------------- 4. 프로젝트별 API 키 이름

console.log("\n[4] GET /v1/organization/projects/{id}/api_keys");
if (projectIds.length === 0) {
  record(false, "프로젝트가 없어 확인 불가");
} else {
  let total = 0;
  let failed = 0;
  for (const id of projectIds) {
    const keys = await get(`/v1/organization/projects/${encodeURIComponent(id)}/api_keys`, {
      limit: 100,
    });
    if (!keys.ok) {
      failed++;
      console.log(`     ${id}: HTTP ${keys.status} ${keys.raw.slice(0, 120)}`);
      continue;
    }
    const data = keys.body?.data ?? [];
    total += data.length;
    for (const k of data) {
      console.log(`     ${id}  ${k.id}  name=${JSON.stringify(k.name)}  ${k.redacted_value ?? ""}`);
    }
  }
  record(failed === 0, "모든 프로젝트에서 키 목록 조회 성공", `실패 ${failed}개`);
  record(
    total > 0,
    "API 키 이름을 하나 이상 모았다",
    `${total}개 — 0 이면 GPT 탭 'API 키별' 표에 id 만 뜹니다`,
  );
}

// ---------------------------------------------------------------- 5. 레이트리밋

console.log("\n[5] 레이트리밋 헤더 (Anthropic 은 시간당 90회 — OpenAI 는 미실측)");
const probe = await fetch(new URL("/v1/organization/projects?limit=1", BASE), {
  headers: { authorization: `Bearer ${KEY}`, ...(ORG ? { "openai-organization": ORG } : {}) },
});
const limitHeaders = [...probe.headers].filter(([k]) => k.includes("ratelimit"));
if (limitHeaders.length) {
  limitHeaders.forEach(([k, v]) => console.log(`     ${k}: ${v}`));
  console.log("     → 이 값을 .env.example 의 LIVE_REFRESH_SECONDS 설명에 적어 두세요.");
} else {
  console.log("     ratelimit 헤더 없음 — 실측으로 알아내야 합니다.");
}

// ---------------------------------------------------------------- 요약

const failed = results.filter((r) => !r.ok);
console.log(`\n${"─".repeat(70)}`);
console.log(`통과 ${results.length - failed.length} / ${results.length}`);
if (failed.length) {
  console.log("\n실패 항목:");
  failed.forEach((f) => console.log(`  ❌ ${f.what}${f.detail ? ` — ${f.detail}` : ""}`));
  console.log(
    "\n→ docs/openai-integration.md 의 해당 체크리스트 항목을 고친 뒤 다시 돌리세요.",
  );
  process.exit(1);
}
console.log("\n전부 통과했습니다. docs/openai-integration.md 의 체크리스트를 지우고");
console.log("lib/adapters/openai.ts · lib/clients/openai.ts 의 ⚠️ 미검증 경고를 걷어내세요.");
