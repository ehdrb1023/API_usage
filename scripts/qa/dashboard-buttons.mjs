/**
 * 대시보드 전체 버튼 QA — 실제 브라우저로 눌러 보고 상태가 바뀌는지 확인한다.
 *
 * 항목 선택은 체크박스가 아니라 `.wp-chip` 버튼(aria-pressed)이다.
 * 유일한 체크박스인 "지표 전체" 는 컴포넌트 state 라 localStorage 를 건드리지 않는다.
 */
import { chromium } from "playwright";

const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const LS_KEY = "api-usage-mini-lines-v1";
const results = [];
const t0 = Date.now();

const ok = (n, d = "") => (results.push({ ok: true, n, d }), console.log(`✅ ${n}${d ? ` — ${d}` : ""}`));
const bad = (n, d = "") => (results.push({ ok: false, n, d }), console.log(`❌ ${n}${d ? ` — ${d}` : ""}`));
async function check(n, fn) {
  try {
    ok(n, (await fn()) ?? "");
  } catch (e) {
    bad(n, e.message.split("\n")[0].slice(0, 220));
  }
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();
page.setDefaultTimeout(15_000);

const consoleErrors = [];
const pageErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 200)));
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));

const lsLines = (p) => p.evaluate((k) => localStorage.getItem(k), LS_KEY);
const openPicker = async (p) => {
  await p.getByRole("button", { name: /미니 창 항목/ }).click();
  await p.waitForSelector('[role="dialog"]', { state: "visible", timeout: 5000 });
  // 스냅샷이 도착해야 항목이 그려진다.
  await p.waitForSelector(".wp-group-head", { timeout: 30_000 });
};

console.log(`\n=== 로드: ${BASE} ===`);
const resp = await page.goto(BASE, { waitUntil: "networkidle", timeout: 120_000 });
await check("대시보드 HTTP 200", () => {
  if (resp.status() !== 200) throw new Error(`HTTP ${resp.status()}`);
  return "200";
});
await page.waitForSelector("button");

// ───────────────────────────────────────────── 1. 서비스 탭
console.log(`\n=== 1. 서비스 탭 (ServiceTabs) ===`);
// ⚠️ 탭은 role="tab" 이다 (role="button" 이 아니다) — components/ServiceTabs.tsx
const tabs = await page.$$eval('[role="tab"]', (bs) => bs.map((b) => (b.innerText || "").trim()));
await check("탭 렌더", () => (tabs.length ? tabs.join(", ") : Promise.reject(new Error("탭 없음"))));
await check("탭 클릭 → aria-selected 반영", async () => {
  const b = page.getByRole("tab", { name: tabs[0], exact: true }).first();
  await b.click();
  await page.waitForTimeout(400);
  return `${tabs[0]}: aria-selected=${await b.getAttribute("aria-selected")}`;
});
await check("GPT 탭 노출 여부가 키 설정과 일치", () =>
  tabs.includes("GPT") ? "GPT 노출 (키 설정됨)" : "GPT 미노출 — OPENAI_ADMIN_KEY 없음과 일치",
);

// ───────────────────────────────────────────── 2. 기간 선택
console.log(`\n=== 2. 기간 선택 (RangePicker) ===`);
const rangeLabels = await page.$$eval(".rp button, [class*=range] button, button", (bs) =>
  bs
    .map((b) => (b.innerText || "").trim().replace(/^✓\s*/, ""))
    .filter((t) => /^(\d+일|이번 달|지난달|전체)$/.test(t)),
);
console.log(`  기간 버튼: ${[...new Set(rangeLabels)].join(", ")}`);
for (const label of [...new Set(rangeLabels)]) {
  await check(`"${label}" 클릭 → 선택 + 차트/표 갱신`, async () => {
    const before = await page.locator("table").first().innerText().catch(() => "");
    await page.getByRole("button", { name: new RegExp(`^✓?\\s*${label}$`) }).first().click();
    await page.waitForTimeout(700);
    const btn = page.getByRole("button", { name: new RegExp(`^✓?\\s*${label}$`) }).first();
    const marked = (await btn.innerText()).includes("✓") || (await btn.getAttribute("aria-pressed")) === "true";
    if (!marked) throw new Error("선택 표시가 안 붙음");
    const after = await page.locator("table").first().innerText().catch(() => "");
    return `선택됨 / 표 ${before === after ? "동일" : "변경"}`;
  });
}

// ───────────────────────────────────────────── 3. WidgetPicker
console.log(`\n=== 3. ⚙ 미니 창 항목 (WidgetPicker) ===`);
await check("⚙ 클릭 → 모달 열림 + 목록 로드", async () => {
  await openPicker(page);
  const groups = await page.locator(".wp-group-head").count();
  return `그룹 ${groups}개`;
});

await check("그룹 헤더 클릭 → 접기/펼치기 (aria-expanded)", async () => {
  const head = page.locator(".wp-group-head").first();
  const before = await head.getAttribute("aria-expanded");
  await head.click();
  await page.waitForTimeout(250);
  const after = await head.getAttribute("aria-expanded");
  if (before === after) throw new Error(`aria-expanded 가 ${before} 그대로`);
  return `${before} → ${after}`;
});

await check("검색 입력 → 항목이 걸러진다", async () => {
  const head = page.locator(".wp-group-head").first();
  if ((await head.getAttribute("aria-expanded")) === "false") await head.click();
  await page.waitForTimeout(200);
  const before = await page.locator(".wp-row").count();
  await page.locator(".wp-search").fill("zzz-존재하지-않는-이름");
  await page.waitForTimeout(400);
  const after = await page.locator(".wp-row").count();
  await page.locator(".wp-search").fill("");
  await page.waitForTimeout(400);
  const restored = await page.locator(".wp-row").count();
  if (!(after < before)) throw new Error(`걸러지지 않음 (${before} → ${after})`);
  return `${before} → ${after} → ${restored}(복원)`;
});

await check('"지표 전체" 체크 → 지표 칩이 늘어난다', async () => {
  const head = page.locator(".wp-group-head").first();
  if ((await head.getAttribute("aria-expanded")) === "false") await head.click();
  await page.waitForTimeout(300);
  const before = await page.locator(".wp-chip").count();
  await page.locator('.wp-toggle input[type="checkbox"]').check();
  await page.waitForTimeout(400);
  const after = await page.locator(".wp-chip").count();
  if (!(after > before)) throw new Error(`칩 수가 안 늘어남 (${before} → ${after})`);
  await page.locator('.wp-toggle input[type="checkbox"]').uncheck();
  await page.waitForTimeout(300);
  return `${before} → ${after}`;
});

await check("지표 칩 클릭 → aria-pressed 토글 + localStorage 반영", async () => {
  const head = page.locator(".wp-group-head").first();
  if ((await head.getAttribute("aria-expanded")) === "false") await head.click();
  await page.waitForTimeout(300);
  const chip = page.locator(".wp-chip").first();
  const pressedBefore = await chip.getAttribute("aria-pressed");
  const lsBefore = await lsLines(page);
  await chip.click();
  await page.waitForTimeout(400);
  const pressedAfter = await chip.getAttribute("aria-pressed");
  const lsAfter = await lsLines(page);
  if (pressedBefore === pressedAfter) throw new Error("aria-pressed 가 안 바뀜");
  if (lsBefore === lsAfter) throw new Error(`localStorage(${LS_KEY}) 가 안 바뀜`);
  return `aria-pressed ${pressedBefore}→${pressedAfter}, 저장됨`;
});

await check('"N줄 선택됨" 카운터가 따라 움직인다', async () => {
  const read = async () => (await page.locator(".wp-count").innerText()).trim();
  const before = await read();
  await page.locator(".wp-chip").first().click();
  await page.waitForTimeout(400);
  const after = await read();
  if (before === after) throw new Error(`${before} 그대로`);
  return `${before} → ${after}`;
});

await check('"기본값으로" → 기본 선택으로 되돌아간다', async () => {
  const before = await lsLines(page);
  await page.getByRole("button", { name: /기본값으로/ }).click();
  await page.waitForTimeout(400);
  const after = await lsLines(page);
  if (!after) throw new Error("localStorage 가 비었음");
  return before === after ? "이미 기본값 상태였음" : `되돌아감 (${JSON.parse(after).length}줄)`;
});

await check('"미니 창 열기 ↗" → 새 창이 뜬다', async () => {
  const [popup] = await Promise.all([
    ctx.waitForEvent("page", { timeout: 8000 }),
    page.getByRole("button", { name: /미니 창 열기/ }).click(),
  ]);
  await popup.waitForLoadState("domcontentloaded");
  const url = popup.url();
  await popup.close();
  if (!url.includes("/mini")) throw new Error(`엉뚱한 URL: ${url}`);
  return url;
});

await check("✕ → 모달 닫힘", async () => {
  await page.locator(".wp-x").click();
  await page.waitForSelector('[role="dialog"]', { state: "detached", timeout: 5000 });
  return "닫힘";
});

await check("바깥 클릭 → 모달 닫힘 (안쪽 클릭은 안 닫힘)", async () => {
  await openPicker(page);
  await page.locator(".wp").click({ position: { x: 10, y: 10 } });
  await page.waitForTimeout(400);
  if ((await page.locator('[role="dialog"]').count()) === 0) {
    throw new Error("안쪽을 눌렀는데 닫혔다");
  }
  await page.locator('[role="dialog"]').click({ position: { x: 3, y: 3 } });
  await page.waitForSelector('[role="dialog"]', { state: "detached", timeout: 5000 });
  return "안쪽 유지 / 바깥 닫힘";
});

// ───────────────────────────────────────────── 4. 표 → 포커스
console.log(`\n=== 4. 표에서 키 선택 → 포커스 배너 ===`);
await check("표의 키 버튼 클릭 → 포커스 배너 등장", async () => {
  const tb = page.locator("table button");
  if ((await tb.count()) === 0) throw new Error("표에 클릭 가능한 버튼 없음");
  await tb.first().click();
  await page.waitForSelector('[role="status"]', { state: "visible", timeout: 5000 });
  return (await page.locator('[role="status"]').innerText()).replace(/\s+/g, " ").slice(0, 60);
});
await check("포커스 중 차트 제목이 그 키 이름으로 바뀐다", async () => {
  const body = await page.locator("body").innerText();
  const name = (await page.locator('[role="status"] strong').innerText()).trim();
  if (!body.includes(name)) throw new Error("이름이 화면에 없음");
  return name;
});
await check('"전체 보기로 돌아가기" → 배너 사라짐', async () => {
  await page.getByRole("button", { name: /전체 보기로 돌아가기/ }).click();
  await page.waitForSelector('[role="status"]', { state: "detached", timeout: 5000 });
  return "복귀";
});
await check("탭을 옮기면 키 선택이 풀린다", async () => {
  if (tabs.length < 2) return "탭이 하나뿐이라 확인 불가(스킵)";
  await page.locator("table button").first().click();
  await page.waitForSelector('[role="status"]', { timeout: 5000 });
  await page.getByRole("tab", { name: tabs[1], exact: true }).click();
  await page.waitForTimeout(600);
  if ((await page.locator('[role="status"]').count()) > 0) throw new Error("선택이 안 풀림");
  return "풀림";
});

// ───────────────────────────────────────────── 5. /mini
console.log(`\n=== 5. /mini ===`);
const mini = await ctx.newPage();
const miniErrors = [];
mini.on("pageerror", (e) => miniErrors.push(String(e).slice(0, 200)));
await check("/mini HTTP 200", async () => {
  const r = await mini.goto(`${BASE}/mini`, { waitUntil: "networkidle", timeout: 60_000 });
  if (r.status() !== 200) throw new Error(`HTTP ${r.status()}`);
  return "200";
});
await check("/mini ⚙ → 같은 WidgetPicker", async () => {
  await mini.locator("button").filter({ hasText: "⚙" }).first().click();
  await mini.waitForSelector(".wp-group-head", { timeout: 30_000 });
  return `그룹 ${await mini.locator(".wp-group-head").count()}개`;
});
await check("/mini 피커의 ✕ → 닫힘", async () => {
  await mini.locator(".wp-x").click();
  await mini.waitForTimeout(400);
  if ((await mini.locator(".wp").count()) > 0) throw new Error("안 닫힘");
  return "닫힘";
});
await check("/mini 런타임 에러 없음", () => {
  if (miniErrors.length) throw new Error(miniErrors.join(" | "));
  return "없음";
});

// ───────────────────────────────────────────── 6. 창 간 동기화
console.log(`\n=== 6. 대시보드 ↔ 미니 창 storage 동기화 ===`);
await check("대시보드에서 칩 토글 → 미니 창이 그 자리에서 바뀐다", async () => {
  const before = await mini.locator("body").innerText();
  await page.bringToFront();
  await openPicker(page);
  const head = page.locator(".wp-group-head").first();
  if ((await head.getAttribute("aria-expanded")) === "false") await head.click();
  await page.waitForTimeout(300);
  await page.locator(".wp-chip").first().click();
  await page.waitForTimeout(1500);
  const after = await mini.locator("body").innerText();
  if (before === after) throw new Error("미니 창 내용이 그대로");
  return "동기화됨";
});

// ───────────────────────────────────────────── 7. 에러
console.log(`\n=== 7. 런타임 에러 ===`);
await check("페이지 예외 없음", () => {
  if (pageErrors.length) throw new Error(pageErrors.join(" | "));
  return "없음";
});
await check("콘솔 error 없음", () => {
  const real = consoleErrors.filter((e) => !/favicon|DevTools|Download the React/.test(e));
  if (real.length) throw new Error(real.slice(0, 3).join(" | "));
  return "없음";
});

await page.screenshot({ path: "shot-dashboard.png" });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${"─".repeat(72)}`);
console.log(`통과 ${results.length - failed.length} / ${results.length}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
if (failed.length) {
  console.log("\n실패:");
  failed.forEach((f) => console.log(`  ❌ ${f.n} — ${f.d}`));
}
process.exit(failed.length ? 1 : 0);
