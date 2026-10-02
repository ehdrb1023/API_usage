#!/usr/bin/env node
/**
 * 결제 메일 → `data/billing/`.
 *
 *   node scripts/collect_receipts.mjs <메일덤프.json>
 *   node scripts/collect_receipts.mjs --summary        # 저장된 것만 집계
 *   node scripts/collect_receipts.mjs --query          # Gmail 검색어만 출력
 *
 * ── Gmail 은 왜 이 스크립트가 직접 안 읽나 ────────────────────────────────
 * Gmail 접근은 Claude 쪽 연동(MCP)이라 Node 스크립트에서 부를 수 없다. 앱에
 * Gmail API 를 직접 붙이려면 Google Cloud 프로젝트 + OAuth 동의화면 + 리프레시
 * 토큰 관리가 따라오는데, 월 5~10건 읽자고 치르기엔 비싸다.
 *
 * 그래서 **역할을 나눈다.**
 *   Claude 루틴 : Gmail 검색 → 메일을 아래 형식의 JSON 으로 덤프
 *   이 스크립트 : 파싱 → 중복 제거 → 저장 → 보고
 *
 * 덤프 형식 (배열):
 *   [{ messageId, mailbox, sender, subject, date, plaintextBody, attachments? }]
 *
 * 절차 전체는 `docs/billing-receipts.md`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// TS 모듈을 그대로 쓰기 위해 프로젝트의 테스트용 로더를 재사용한다.
// (`node --import ./lib/clients/__tests__/ts-resolve.mjs` 로 실행된다)
const ROOT = process.cwd();

/** `.env` 를 읽는다. 벤더 API 조회에 키가 필요하다. */
const env = (() => {
  try {
    const out = {};
    for (const line of readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
      const m = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return { ...out, ...process.env };
  } catch {
    return process.env;
  }
})();
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { parseMail } = await imp("lib/billing/parse-receipt.ts");
const { loadBillingConfig, activeMailboxes, gmailQuery } = await imp("lib/billing/sources.ts");
const { mergeReceipts, mergeUnparsed, loadReceipts, loadCards, monthlySummary, byCard } =
  await imp("lib/billing/store.ts");
const { topupWindows, prepaidBalance, daysRemaining } = await imp("lib/billing/balance.ts");

const arg = process.argv[2];
const config = await loadBillingConfig();

// ---------------------------------------------------------------- 검색어만

if (arg === "--query") {
  console.log(gmailQuery(config, 120));
  console.log("\n활성 메일함:", activeMailboxes(config).map((m) => m.address).join(", "));
  process.exit(0);
}

// ---------------------------------------------------------------- 수집

if (arg && arg !== "--summary") {
  const mails = JSON.parse(readFileSync(arg, "utf8"));
  if (!Array.isArray(mails)) {
    console.error(`${arg}: 배열이어야 합니다.`);
    process.exit(1);
  }

  const receipts = [];
  const unparsed = [];

  for (const m of mails) {
    const res = parseMail(
      {
        messageId: m.messageId,
        sender: m.sender,
        subject: m.subject ?? "",
        date: m.date,
        plaintextBody: m.plaintextBody ?? "",
        attachments: m.attachments ?? [],
        // 어느 메일함에서 왔는지. 안 적혀 있으면 설정의 첫 활성 메일함으로 본다.
        mailbox: m.mailbox ?? activeMailboxes(config)[0]?.address ?? "(미상)",
      },
      config,
    );

    if (res.ok) receipts.push(res.receipt);
    else {
      unparsed.push({
        messageId: m.messageId,
        mailbox: m.mailbox ?? "(미상)",
        sender: m.sender,
        subject: m.subject ?? "",
        date: m.date,
        reason: res.reason,
      });
    }
  }

  const merged = await mergeReceipts(receipts);
  const unparsedAdded = await mergeUnparsed(unparsed);

  console.log(`메일 ${mails.length}건 처리`);
  console.log(`  영수증으로 읽힘 : ${receipts.length}건 (새로 저장 ${merged.added}, 중복 ${merged.skipped})`);
  console.log(`  못 읽음         : ${unparsed.length}건 (새로 기록 ${unparsedAdded})`);
  console.log(`  저장된 총계     : ${merged.total}건`);

  // ⚠️ 사람이 봐야 하는 것 두 가지는 조용히 넘기지 않는다.
  if (merged.newCards.length) {
    console.log(`\n⚠️  처음 보는 카드: ${merged.newCards.join(", ")}`);
    console.log(`    data/billing/cards.json 에 이름을 붙여 주세요. 자동으로 만들지 않습니다.`);
    console.log(`    예: [{ "last4": "${merged.newCards[0]}", "label": "법인 신한" }]`);
  }
  if (merged.unknownKinds.length) {
    console.log(`\n⚠️  종류를 못 가른 영수증 ${merged.unknownKinds.length}건 — 합계에서 빠집니다:`);
    for (const r of merged.unknownKinds.slice(0, 10)) {
      console.log(`    ${r.paidOn}  ${r.vendor}  $${r.amount}  품목=${JSON.stringify(r.lineItem)}`);
    }
    console.log(`    → lib/billing/parse-receipt.ts 의 classifyKind() 에 규칙을 추가하세요.`);
  }
  if (unparsed.length) {
    console.log(`\n못 읽은 메일 (data/billing/unparsed.json):`);
    for (const u of unparsed.slice(0, 8)) console.log(`    ${u.sender} — ${u.reason}`);
  }
}

// ---------------------------------------------------------------- 집계 보고

const receipts = await loadReceipts();
const cards = await loadCards();

if (receipts.length === 0) {
  console.log("\n저장된 영수증이 없습니다.");
  process.exit(0);
}

console.log(`\n${"─".repeat(72)}`);
console.log("월별 — 요금제 vs API\n");
const rows = monthlySummary(receipts);
const f = (n) => (n === 0 ? "     ·  " : n.toFixed(2).padStart(8));
console.log("  월       벤더            요금제      API후불    선불충전      환불       합계");
console.log("  " + "─".repeat(70));
for (const r of rows) {
  console.log(
    `  ${r.month}  ${r.vendor.slice(0, 14).padEnd(14)} ${f(r.subscription)} ${f(r.apiUsage)} ` +
      `${f(r.prepaidTopup)} ${f(r.creditNote)} ${f(r.total)}` +
      (r.unknownCount ? `  ⚠️미분류${r.unknownCount}` : "") +
      (r.failedCount ? `  실패${r.failedCount}` : ""),
  );
}

console.log(`\n⚠️ 선불 충전은 API 후불과 더하지 마세요 — 나간 시점과 쓰는 시점이 다릅니다.`);

// ---------------------------------------------------------------- 선불 잔액

/**
 * 벤더 API 로 "충전 시작일 이후 실제 API 지출" 을 조회한다.
 *
 * ⚠️ 조회할 수 없는 벤더는 **키를 넣지 않는다.** 0 을 넣으면 "안 썼다" 가 되어
 *    잔액이 실제보다 많아 보인다.
 */
async function spentSince(vendor, since) {
  const now = new Date().toISOString();
  try {
    if (vendor === "Anthropic") {
      if (!env.ANTHROPIC_ADMIN_KEY) return null;
      let total = 0, page;
      for (let i = 0; i < 20; i++) {
        const u = new URL("/v1/organizations/cost_report", "https://api.anthropic.com");
        u.searchParams.set("starting_at", `${since}T00:00:00Z`);
        u.searchParams.set("ending_at", now);
        u.searchParams.set("bucket_width", "1d");
        u.searchParams.set("limit", "31");
        if (page) u.searchParams.set("page", page);
        const r = await fetch(u, {
          headers: {
            "x-api-key": env.ANTHROPIC_ADMIN_KEY,
            "anthropic-version": env.ANTHROPIC_API_VERSION ?? "2023-06-01",
          },
        });
        if (!r.ok) return null;
        const b = await r.json();
        for (const bucket of b.data ?? [])
          for (const item of bucket.results ?? [])
            // ⚠️ Anthropic 은 **센트 문자열**이다. 100 으로 안 나누면 100배가 된다.
            total += Number(item.amount ?? 0) / 100;
        if (!b.has_more) break;
        page = b.last_page ?? b.next_page;
      }
      return total;
    }

    if (vendor === "OpenAI") {
      if (!env.OPENAI_ADMIN_KEY) return null;
      const u = new URL("/v1/organization/costs", "https://api.openai.com");
      u.searchParams.set("start_time", String(Math.floor(Date.parse(`${since}T00:00:00Z`) / 1000)));
      u.searchParams.set("end_time", String(Math.floor(Date.now() / 1000)));
      u.searchParams.set("bucket_width", "1d");
      u.searchParams.set("limit", "180");
      const r = await fetch(u, {
        headers: {
          authorization: `Bearer ${env.OPENAI_ADMIN_KEY}`,
          ...(env.OPENAI_ORG_ID ? { "openai-organization": env.OPENAI_ORG_ID } : {}),
        },
      });
      if (!r.ok) return null;
      const b = await r.json();
      // OpenAI 는 이미 USD 실수다. 나누지 않는다.
      return (b.data ?? []).flatMap((x) => x.results ?? []).reduce((s, x) => s + (x.amount?.value ?? 0), 0);
    }
  } catch {
    return null; // 조회 실패는 "0" 이 아니라 "모름" 이다.
  }
  return null; // 조회 경로가 없는 벤더 (Deep Infra 등)
}

const windows = topupWindows(receipts);
if (windows.length) {
  const spent = {};
  for (const w of windows) {
    if (w.pocket !== "api") continue; // 구독 주머니는 애초에 조회 불가
    const v = await spentSince(w.vendor, w.since);
    if (v !== null) spent[w.vendor] = v;
  }

  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n선불 잔액 (추정)\n`);
  console.log("  벤더             주머니   넣은돈      쓴돈      남은돈   소진예상");
  console.log("  " + "─".repeat(66));
  for (const row of prepaidBalance(windows, spent)) {
    const days = daysRemaining(row, today);
    const pocket = row.pocket === "api" ? "API" : row.pocket === "plan" ? "구독" : "미상";
    const num = (n) => (n === null ? "    ?   " : n.toFixed(2).padStart(8));
    console.log(
      `  ${row.vendor.slice(0, 15).padEnd(15)} ${pocket.padEnd(6)} ${num(row.toppedUp)} ` +
        `${num(row.spent)} ${num(row.balance)}   ` +
        (days === null ? "—" : `약 ${days}일`),
    );
  }
  console.log(`
  ⚠️ **시작 잔액을 모릅니다.** 메일에서 보이는 첫 충전 이전에 남아 있던 돈은
     알 수 없으므로, 실제 잔액은 위 값 **이상**입니다.
  ⚠️ "구독" 주머니(Claude Code·claude.ai 초과 사용분)는 Admin API 에 안 잡혀
     소진을 볼 방법이 없습니다. \`?\` 는 0 이 아니라 **모른다**는 뜻입니다.`);
}

console.log(`\n카드별\n`);
for (const c of byCard(receipts, cards)) {
  console.log(`  ${c.label.padEnd(20)} $${c.total.toFixed(2).padStart(9)}  (${c.count}건)`);
}
