#!/usr/bin/env node
/**
 * speciai.kr 서브도메인을 Vercel 프로젝트에 붙인다.
 *
 *   node scripts/attach_subdomain.mjs <서브도메인> <프로젝트> [--apex speciai.kr]
 *   node scripts/attach_subdomain.mjs api api-usage
 *   node scripts/attach_subdomain.mjs api api-usage --check    # 상태만 보기
 *   node scripts/attach_subdomain.mjs api api-usage --protect  # 접근 보호 켜기
 *
 * 하는 일은 **Vercel 쪽 절반**이다. 나머지 절반인 DNS 레코드 등록은 hosting.kr 에서
 * 사람이 해야 한다 — hosting.kr 은 공개 API 가 없고 구글 계정 로그인이라 자동화가
 * 안 된다. 그래서 이 스크립트는 **hosting.kr 에 넣을 값을 정확히 찍어 준다.**
 *
 * 절차와 정책은 `docs/subdomain-runbook.md`.
 *
 * 필요한 것: `.env` 의 VERCEL_API_TOKEN, VERCEL_TEAM_ID
 *   ⚠️ 토큰의 팀과 **대상 프로젝트의 팀이 같아야 한다.** Vercel 도메인은 팀에 묶여
 *      있어서 다른 팀 프로젝트에는 붙일 수 없다.
 */

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------- 입력

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));
const apexIdx = args.indexOf("--apex");
const APEX = apexIdx >= 0 ? args[apexIdx + 1] : "speciai.kr";
const CHECK_ONLY = flags.has("--check");
const DO_PROTECT = flags.has("--protect");

const [sub, projectName] = positional.filter((a) => a !== APEX);

if (!sub || !projectName) {
  console.error(
    "사용법: node scripts/attach_subdomain.mjs <서브도메인> <프로젝트> [--apex speciai.kr] [--check]\n" +
      "  예: node scripts/attach_subdomain.mjs api api-usage\n" +
      "  --check   상태만 보고 아무것도 바꾸지 않음\n" +
      "  --protect 커스텀 도메인까지 덮는 접근 보호를 켬",
  );
  process.exit(1);
}

// 서브도메인 규칙 — 소문자·숫자·하이픈만. 대문자나 점을 넣으면 Vercel 이 받긴 해도
// hosting.kr 쪽에서 헷갈린다.
if (!/^[a-z0-9][a-z0-9-]*$/.test(sub)) {
  console.error(`서브도메인 "${sub}" 은 소문자·숫자·하이픈만 됩니다 (점 없이 한 단계).`);
  process.exit(1);
}

const FQDN = `${sub}.${APEX}`;

// ---------------------------------------------------------------- 설정

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
const TOKEN = env.VERCEL_API_TOKEN;
const TEAM = env.VERCEL_TEAM_ID;

if (!TOKEN) {
  console.error("VERCEL_API_TOKEN 이 .env 에 없습니다.");
  process.exit(1);
}

const q = TEAM ? `teamId=${TEAM}` : "";
const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

async function api(path, init = {}) {
  const res = await fetch(`https://api.vercel.com${path}`, { ...init, headers: H });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
}

// ---------------------------------------------------------------- 사전 점검

console.log(`대상: ${FQDN}  →  프로젝트 ${projectName}\n`);

// 1) 도메인이 이 팀에 있는가. 없으면 아래 단계가 전부 무의미하다.
const domain = await api(`/v5/domains/${APEX}?${q}`);
if (!domain.ok) {
  console.error(
    `❌ ${APEX} 를 이 팀에서 찾을 수 없습니다 (HTTP ${domain.status}).\n` +
      `   Vercel 도메인은 팀에 묶여 있습니다. VERCEL_TEAM_ID 가 도메인을 가진 팀인지 확인하세요.`,
  );
  process.exit(1);
}
console.log(`✅ ${APEX} 확인 — 네임서버 ${(domain.body.nameservers ?? []).join(", ") || "(외부)"}`);

// 2) 프로젝트가 같은 팀에 있는가.
const project = await api(`/v9/projects/${encodeURIComponent(projectName)}?${q}`);
if (!project.ok) {
  console.error(
    `❌ 프로젝트 "${projectName}" 을 이 팀에서 찾을 수 없습니다 (HTTP ${project.status}).\n` +
      `   ⚠️ 도메인과 프로젝트가 **같은 팀**에 있어야 합니다. 다른 팀이면 붙일 수 없습니다 —\n` +
      `      프로젝트를 도메인이 있는 팀으로 옮기거나, 도메인을 옮겨야 합니다.`,
  );
  process.exit(1);
}
console.log(`✅ 프로젝트 ${project.body.name} (${project.body.id})`);

// 3) 이미 붙어 있나 / 다른 프로젝트가 쓰고 있나.
const existing = await api(`/v9/projects/${project.body.id}/domains/${FQDN}?${q}`);
if (existing.ok) {
  console.log(`\nℹ️  ${FQDN} 는 이미 이 프로젝트에 붙어 있습니다.`);
  if (DO_PROTECT) await enableProtection(project.body.id);
  await report(project.body.id);
  process.exit(0);
}

if (CHECK_ONLY) {
  console.log(`\n${FQDN} 는 아직 안 붙어 있습니다. (--check 라 여기서 멈춥니다)`);
  await reportProtection(project.body.id);
  process.exit(0);
}

// ---------------------------------------------------------------- 붙이기

const added = await api(`/v10/projects/${project.body.id}/domains?${q}`, {
  method: "POST",
  body: JSON.stringify({ name: FQDN }),
});

if (!added.ok) {
  const code = added.body?.error?.code;
  if (code === "domain_already_in_use") {
    console.error(
      `❌ ${FQDN} 는 이미 **다른 프로젝트**가 쓰고 있습니다.\n` +
        `   Vercel 대시보드에서 그 프로젝트에서 먼저 떼어내세요.`,
    );
  } else {
    console.error(`❌ 붙이기 실패 (HTTP ${added.status}):`, JSON.stringify(added.body).slice(0, 400));
  }
  process.exit(1);
}

console.log(`\n✅ Vercel 에 ${FQDN} 등록 완료.`);
if (DO_PROTECT) await enableProtection(project.body.id);
await report(project.body.id);

// ---------------------------------------------------------------- 결과 안내

async function report(projectId) {
  const cfg = await api(`/v6/domains/${FQDN}/config?${q}`);
  const dom = await api(`/v9/projects/${projectId}/domains/${FQDN}?${q}`);

  const misconfigured = cfg.body?.misconfigured;
  const verified = dom.body?.verified;

  console.log(`\n상태: DNS ${misconfigured ? "❌ 미설정" : "✅ 정상"} · 검증 ${verified ? "✅" : "⏳ 대기"}`);

  // Vercel 이 따로 요구하는 검증 레코드가 있으면 그것부터 보여 준다.
  const challenges = dom.body?.verification ?? [];
  if (challenges.length) {
    console.log(`\n먼저 아래 검증 레코드를 넣어야 합니다:`);
    for (const c of challenges) {
      console.log(`  타입 ${c.type} · 이름 ${c.domain} · 값 ${c.value}`);
    }
  }

  if (misconfigured) {
    console.log(`
────────────────────────────────────────────────────────────────────
hosting.kr 에서 아래 레코드를 추가하세요 (여기까지가 사람 몫입니다)

  로그인 : https://hosting.kr  →  구글 계정 speciai250331@gmail.com
  경로   : 마이페이지 → 도메인 → ${APEX} → DNS 설정 (네임서버 ns1~4.hosting.co.kr)

  타입   : CNAME
  호스트 : ${sub}                 ← ${FQDN} 전체가 아니라 앞부분만
  값     : cname.vercel-dns.com.  ← 끝 점 포함
  TTL    : 3600

⚠️ 호스트 칸에 "${FQDN}" 를 통째로 넣으면 ${sub}.${APEX}.${APEX} 가 됩니다.
   hosting.kr 은 apex 를 자동으로 붙입니다.

넣은 뒤 전파를 기다렸다가(보통 5~30분) 확인:
  nslookup -type=CNAME ${FQDN}
  node scripts/attach_subdomain.mjs ${sub} ${projectName} --check
────────────────────────────────────────────────────────────────────`);
  } else {
    console.log(`\n🎉 DNS 까지 정상입니다. https://${FQDN} 로 접속됩니다.`);
  }

  await reportProtection(projectId);
}

/**
 * 접근 보호 상태.
 *
 * ⚠️ **Vercel 기본값이 함정이다.** `ssoProtection.deploymentType` 의 기본값은
 *    `all_except_custom_domains` 로, 프리뷰만 막고 **커스텀 도메인은 그대로
 *    열어 둔다.** 서브도메인을 붙이는 순간 보호 밖으로 나가는 셈이다.
 *    실측으로 확인했다 (2026-08-27, speciai-dash 프로젝트).
 *
 *    이 대시보드는 조직 전체 지출과 **거래처별 API 키 이름**(lawsync·devcowork·
 *    legalmask·yulam 등 고객사 이름)을 그대로 띄운다. 열어 두면 안 된다.
 */
async function reportProtection(projectId) {
  const p = await api(`/v9/projects/${projectId}?${q}`);
  const sso = p.body?.ssoProtection;
  const pw = p.body?.passwordProtection;

  const customDomainCovered =
    sso?.deploymentType === "all" || pw?.deploymentType === "all";

  console.log(`\n접근 보호: SSO=${JSON.stringify(sso ?? null)} 비밀번호=${JSON.stringify(pw ?? null)}`);

  if (customDomainCovered) {
    console.log(`✅ 커스텀 도메인도 보호됩니다.`);
    return;
  }

  console.log(`
⚠️  ${FQDN} 는 **아무나 볼 수 있습니다.**
    ${sso ? `현재 설정 "${sso.deploymentType}" 은 프리뷰만 막고 커스텀 도메인은 엽니다.` : "보호가 꺼져 있습니다."}
    이 화면에는 조직 전체 AI 지출과 거래처별 API 키 이름이 그대로 뜹니다.

    켜기:  node scripts/attach_subdomain.mjs ${sub} ${projectName} --protect
    (또는 Vercel → Settings → Deployment Protection → Vercel Authentication
     → **All Deployments** 선택. "Standard Protection" 은 커스텀 도메인을 뺍니다)`);
}

/** ssoProtection 을 커스텀 도메인까지 덮도록 올린다. */
async function enableProtection(projectId) {
  const res = await api(`/v9/projects/${projectId}?${q}`, {
    method: "PATCH",
    body: JSON.stringify({ ssoProtection: { deploymentType: "all" } }),
  });
  if (!res.ok) {
    console.error(`❌ 보호 설정 실패 (HTTP ${res.status}):`, JSON.stringify(res.body).slice(0, 300));
    process.exit(1);
  }
  console.log(`✅ Vercel Authentication 을 **모든 배포**(커스텀 도메인 포함)로 올렸습니다.`);
  console.log(`   이제 팀 멤버로 로그인해야 ${FQDN} 가 보입니다.`);
}
