#!/usr/bin/env node
/**
 * API 키 인벤토리 — **어느 서비스가 어느 벤더 키를 쓰는지**를 한 장으로 모은다.
 *
 *   node scripts/scan_key_inventory.mjs
 *   → responses/key-inventory.json  (기계용)
 *   → responses/key-inventory.md    (사람용)
 *
 * ⚠️ **값은 절대 읽지 않는다.** Vercel 은 복호화를 요청해야만 값을 주는데
 *    이 스크립트는 요청하지 않는다. 로컬 `.env` 는 `=` 왼쪽만 잘라 쓴다.
 *    출력물에도 변수 **이름**과 프로젝트 이름만 들어간다.
 *
 * ⚠️ 그래도 조직 내부 식별자(프로젝트 이름·구성)라서 출력은 `responses/` 에 쓴다 —
 *    `.gitignore` 에 걸려 있는 디렉터리다. 커밋하지 말 것.
 *
 * 앱 경로가 아니다 (`lib/` 를 쓰지 않는다). 대시보드는 이 파일을 읽지 않는다.
 *
 * 필요한 것:
 *   VERCEL_API_TOKEN, VERCEL_TEAM_ID   (.env)
 *   ~/.supabase/access-token           (supabase login 으로 생긴 파일)
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------- 설정

/**
 * 여기 걸리는 변수만 "AI 벤더 키" 로 센다. 새 벤더를 쓰기 시작하면 여기 추가할 것.
 * 순서가 곧 표의 순서다.
 */
const VENDOR_PATTERNS = [
  { vendor: "Anthropic", re: /^ANTHROPIC_.*(KEY)$/ },
  { vendor: "OpenAI", re: /^OPENAI_.*(KEY)$/ },
  { vendor: "Google Gemini", re: /^GEMINI_.*(KEY)$/ },
  { vendor: "Google Vision", re: /^GOOGLE_VISION_/ },
  { vendor: "Upstash", re: /^UPSTASH_.*(TOKEN)$/ },
  { vendor: "Resend", re: /^RESEND_API_KEY$/ },
  { vendor: "Solapi", re: /^SOLAPI_API_/ },
];

/** 위 목록에 없지만 이름에 API 가 들어가는 것들 — "그 외" 로 따로 센다. */
const GENERIC_API_RE = /API/;

function classify(name) {
  for (const { vendor, re } of VENDOR_PATTERNS) if (re.test(name)) return vendor;
  return GENERIC_API_RE.test(name) ? "(그 외 API)" : null;
}

// ---------------------------------------------------------------- .env 읽기

function loadEnv(file) {
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

const env = { ...loadEnv(".env"), ...process.env };

// ---------------------------------------------------------------- Vercel

async function scanVercel() {
  const token = env.VERCEL_API_TOKEN;
  const team = env.VERCEL_TEAM_ID;
  if (!token) return { error: "VERCEL_API_TOKEN 이 .env 에 없습니다.", projects: [] };

  const q = team ? `teamId=${team}` : "";
  const get = async (p) => {
    const r = await fetch(`https://api.vercel.com${p}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };

  let list;
  try {
    list = await get(`/v9/projects?limit=100&${q}`);
  } catch (e) {
    return { error: String(e.message), projects: [] };
  }

  const projects = [];
  for (const p of list.projects ?? []) {
    let envs = [];
    try {
      // ⚠️ decrypt 를 요청하지 않는다. 값 없이 이름·target 만 온다.
      const body = await get(`/v10/projects/${p.id}/env?${q}`);
      envs = body.envs ?? [];
    } catch (e) {
      projects.push({ name: p.name, id: p.id, error: String(e.message), vars: [] });
      continue;
    }
    projects.push({
      name: p.name,
      id: p.id,
      vars: envs.map((v) => ({ name: v.key, targets: v.target ?? [] })),
    });
  }
  return { projects };
}

// ---------------------------------------------------------------- Supabase

async function scanSupabase() {
  let token = env.SUPABASE_ACCESS_TOKEN;
  if (!token || /^sbp_x+/.test(token)) {
    // `supabase login` 이 남긴 토큰을 대신 쓴다.
    try {
      token = readFileSync(path.join(homedir(), ".supabase", "access-token"), "utf8").trim();
    } catch {
      return { error: "SUPABASE_ACCESS_TOKEN 도 ~/.supabase/access-token 도 없습니다.", projects: [] };
    }
  }

  const get = async (p) => {
    const r = await fetch(`https://api.supabase.com${p}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };

  let list;
  try {
    list = await get("/v1/projects");
  } catch (e) {
    return { error: String(e.message), projects: [] };
  }

  const projects = [];
  for (const p of list) {
    try {
      const secrets = await get(`/v1/projects/${p.id}/secrets`);
      projects.push({
        name: p.name,
        id: p.id,
        vars: (secrets ?? []).map((s) => ({ name: s.name, targets: [] })),
      });
    } catch (e) {
      projects.push({ name: p.name, id: p.id, error: String(e.message), vars: [] });
    }
  }
  return { projects };
}

// ---------------------------------------------------------------- 로컬 dev env

/** 홈 아래 .env* 파일을 찾는다. node_modules·.git 은 건너뛴다. */
function findEnvFiles(root, depth = 5) {
  const found = [];
  const walk = (dir, left) => {
    if (left < 0) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === ".next") continue;
        if (e.name.startsWith(".") && e.name !== ".claude") continue;
        walk(full, left - 1);
      } else if (e.name === ".env" || e.name.startsWith(".env.")) {
        try {
          if (statSync(full).size < 200_000) found.push(full);
        } catch {
          /* 읽을 수 없는 파일은 건너뛴다 */
        }
      }
    }
  };
  walk(root, depth);
  return found.sort();
}

function scanLocal(root) {
  return {
    projects: findEnvFiles(root).map((file) => ({
      name: path.relative(root, file),
      id: file,
      // `=` 왼쪽만. 값은 배열에 들어가지 않는다.
      vars: Object.keys(loadEnv(file)).map((name) => ({ name, targets: [] })),
    })),
  };
}

// ---------------------------------------------------------------- 조립

const sources = {
  vercel: await scanVercel(),
  supabase: await scanSupabase(),
  local: scanLocal(homedir()),
};

/** vendor → 변수명 → [출처] */
const byVendor = new Map();
for (const [source, result] of Object.entries(sources)) {
  for (const p of result.projects) {
    for (const v of p.vars) {
      const vendor = classify(v.name);
      if (!vendor) continue;
      if (!byVendor.has(vendor)) byVendor.set(vendor, new Map());
      const vars = byVendor.get(vendor);
      if (!vars.has(v.name)) vars.set(v.name, []);
      vars.get(v.name).push({
        source,
        project: p.name,
        targets: v.targets,
      });
    }
  }
}

const generatedAt = new Date().toISOString();
const json = {
  generatedAt,
  note: "값은 수집하지 않습니다. 변수 이름과 프로젝트 이름만 들어 있습니다.",
  errors: Object.fromEntries(
    Object.entries(sources)
      .filter(([, r]) => r.error)
      .map(([k, r]) => [k, r.error]),
  ),
  counts: Object.fromEntries(
    Object.entries(sources).map(([k, r]) => [k, r.projects.length]),
  ),
  vendors: Object.fromEntries(
    [...byVendor].map(([vendor, vars]) => [
      vendor,
      Object.fromEntries([...vars].map(([name, uses]) => [name, uses])),
    ]),
  ),
};

// ---------------------------------------------------------------- 출력

const lines = [
  "# API 키 인벤토리",
  "",
  `생성: ${generatedAt} · \`node scripts/scan_key_inventory.mjs\``,
  "",
  "> **값은 수집하지 않습니다.** 변수 이름과 그 변수가 걸린 프로젝트 이름만 있습니다.",
  "> 그래도 조직 내부 구성이라 `responses/` (gitignore) 밖으로 내보내지 마세요.",
  "",
  `조사 대상: Vercel 프로젝트 ${sources.vercel.projects.length}개 · ` +
    `Supabase 프로젝트 ${sources.supabase.projects.length}개 · ` +
    `로컬 .env 파일 ${sources.local.projects.length}개`,
  "",
];

for (const [source, r] of Object.entries(sources)) {
  if (r.error) lines.push(`⚠️ ${source}: ${r.error}`, "");
}

for (const [vendor, vars] of byVendor) {
  lines.push(`## ${vendor}`, "");
  for (const [name, uses] of vars) {
    lines.push(`### \`${name}\` — ${uses.length}곳`, "");
    for (const u of uses) {
      const t = u.targets.length ? ` [${u.targets.join(", ")}]` : "";
      lines.push(`- ${u.source} · ${u.project}${t}`);
    }
    lines.push("");
  }
}

writeFileSync("responses/key-inventory.json", JSON.stringify(json, null, 2));
writeFileSync("responses/key-inventory.md", lines.join("\n"));

console.log(
  `responses/key-inventory.{json,md} 를 썼습니다. ` +
    `벤더 ${byVendor.size}종 · 변수 ${[...byVendor.values()].reduce((n, m) => n + m.size, 0)}종.`,
);
for (const [source, r] of Object.entries(sources)) {
  if (r.error) console.warn(`⚠️  ${source}: ${r.error}`);
}
