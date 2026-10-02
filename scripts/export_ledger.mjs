#!/usr/bin/env node
/**
 * 로컬 결제 장부 → 비공개 Blob (배포본 /receipts 가 읽는 곳).
 *
 *   node scripts/export_ledger.mjs
 *
 * `data/billing/receipts.json` + `manual-payments.json` 을 한 파일로 묶어
 * `data/billing/ledger-source.json` 에 쓰고, Vercel CLI 로 Blob 에 덮어쓴다.
 * 수집(collect_receipts.mjs)을 돌린 뒤에 이걸 돌리면 배포 화면이 갱신된다.
 *
 * ⚠️ git 에는 절대 올리지 않는다 — 저장소가 공개다. 이유는 lib/billing/ledger-source.ts.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIR = path.join(ROOT, "data", "billing");
const BLOB_PATH = "billing/ledger-source.json"; // lib/billing/ledger-source.ts 의 BLOB_PATH 와 같아야 한다

const read = (name) => {
  try {
    return JSON.parse(readFileSync(path.join(DIR, name), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
};

const receipts = read("receipts.json");
const manual = read("manual-payments.json");
if (receipts.length + manual.length === 0) {
  // 빈 장부를 올리면 배포 화면이 조용히 "결제 없음" 이 된다. 올리지 않는다.
  console.error("올릴 결제 기록이 없습니다. 먼저 collect_receipts.mjs 를 돌리세요.");
  process.exit(1);
}

const out = path.join(DIR, "ledger-source.json");
writeFileSync(
  out,
  JSON.stringify({ receipts, manual, exportedAt: new Date().toISOString() }) + "\n",
  "utf8",
);
console.log(`묶음: 파서 ${receipts.length}건 + 수동 ${manual.length}건 → ${path.relative(ROOT, out)}`);

/**
 * 업로드 자격증명. `vercel blob create-store` 가 `.env.local` 에 BLOB_READ_WRITE_TOKEN 을
 * 받아 두었다. 같은 파일의 VERCEL_OIDC_TOKEN 이 같이 보이면 CLI 가 "OIDC 쓸 거면
 * BLOB_STORE_ID 도 달라" 며 멈추므로, 자식 프로세스에는 읽기쓰기 토큰만 넘긴다.
 * (명령줄 인자로 넘기면 ps 에 토큰이 보인다 — 환경변수로 넘긴다.)
 */
const rwToken = (() => {
  for (const f of [".env.local", ".env"]) {
    try {
      const m = /^BLOB_READ_WRITE_TOKEN=["']?([^"'\n]+)/m.exec(readFileSync(path.join(ROOT, f), "utf8"));
      if (m) return m[1].trim();
    } catch {}
  }
  return process.env.BLOB_READ_WRITE_TOKEN;
})();
if (!rwToken) {
  console.error("BLOB_READ_WRITE_TOKEN 이 없습니다. `vercel env pull .env.local` 로 받아 오세요.");
  process.exit(1);
}
const childEnv = { ...process.env, BLOB_READ_WRITE_TOKEN: rwToken };
delete childEnv.VERCEL_OIDC_TOKEN;
delete childEnv.BLOB_STORE_ID;

execFileSync(
  "vercel",
  [
    "blob", "put", out,
    "--access", "private",
    "--pathname", BLOB_PATH,
    "--allow-overwrite", "true",
    "--content-type", "application/json",
    "--non-interactive",
  ],
  { stdio: "inherit", env: childEnv, cwd: path.join(ROOT, "data") },
);
console.log("업로드 완료 — 배포본 /receipts 를 새로고침하면 반영됩니다.");
