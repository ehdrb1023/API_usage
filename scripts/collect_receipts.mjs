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
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { parseMail } = await imp("lib/billing/parse-receipt.ts");
const { loadBillingConfig, activeMailboxes, gmailQuery } = await imp("lib/billing/sources.ts");
const { mergeReceipts, mergeUnparsed, loadReceipts, loadCards, monthlySummary, byCard } =
  await imp("lib/billing/store.ts");

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

console.log(`\n카드별\n`);
for (const c of byCard(receipts, cards)) {
  console.log(`  ${c.label.padEnd(20)} $${c.total.toFixed(2).padStart(9)}  (${c.count}건)`);
}
