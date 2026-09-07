#!/usr/bin/env node
/**
 * 웹 계기판 — 브라우저에 띄워두고 보는 실시간 사용량.
 *
 *   quota web              # 서버 띄우고 브라우저 열기
 *   quota web --port 5000
 *   quota web --no-open    # 브라우저는 안 열고 주소만
 *
 * ── 왜 터미널 말고 페이지인가 ─────────────────────────────────────────────
 * `quota meter --watch` 는 화면을 통째로 다시 그린다. 터미널에 따라 깜빡이거나
 * 스크롤이 밀려서 오래 띄워두기 불편하다. 페이지는 **바뀐 숫자만 갈아끼우므로**
 * 깜빡임이 없고, 창을 작게 줄여 구석에 두기도 낫다.
 *
 * ── 왜 Next.js 앱이 아닌가 ────────────────────────────────────────────────
 * `app/` 의 대시보드는 종량제(Admin API)를 그리는 물건이고 dev 서버가 필요하다.
 * 이건 구독 한도고 어디서나 한 줄로 떠야 한다. 그래서 `node:http` 만 쓴다 —
 * 의존성 0 이라는 이 CLI 의 성질을 깨지 않는다.
 *
 * ⚠️ **127.0.0.1 에만 바인딩한다.** 사용량·세션 제목·프로젝트 이름이 다 실려 있어서
 *    같은 네트워크에 열어 둘 물건이 아니다. `0.0.0.0` 으로 바꾸지 말 것.
 */

import http from "node:http";
import { spawn } from "node:child_process";

import { scanLocalUsage } from "../lib/local/scan.ts";
import { getQuota } from "../lib/quota.ts";
import { buildBoard, rangeStart, total, totalWithoutCache } from "../lib/quota-board.ts";
import { calibrate, machineName, readAccount, readSnapshots, segments } from "../lib/quota-calibration.ts";
import { windowView } from "../lib/quota-view.ts";

const args = process.argv.slice(2).filter((a) => a !== "web");
const portIndex = args.indexOf("--port");
const PORT = portIndex >= 0 ? Number(args[portIndex + 1]) : 4321;
const OPEN = !args.includes("--no-open");
const RANGE = args.find((a) => !a.startsWith("--") && a !== String(PORT)) ?? "today";

// ---------------------------------------------------------------- 데이터

async function state() {
  const since = rangeStart(RANGE);
  const [scan, quota, account] = await Promise.all([
    scanLocalUsage(since),
    getQuota().catch((e) => ({ windows: [], error: String(e) })),
    readAccount().catch(() => null),
  ]);

  const board = buildBoard(
    scan.rows,
    scan.tools,
    scan.titles,
    process.env.CLAUDE_CODE_SESSION_ID ?? null,
  );
  const calibrations = account ? calibrate(segments(await readSnapshots(account.uuid))) : [];

  return {
    at: new Date().toISOString(),
    range: RANGE,
    account: account ? { email: account.email, tier: account.tier } : null,
    machine: machineName(),
    error: quota.error ?? null,
    windows: (quota.windows ?? []).map((w) => windowView(w, calibrations)),
    totals: {
      withCacheRead: total(board.totals),
      withoutCacheRead: totalWithoutCache(board.totals),
      calls: board.totals.calls,
      sessions: board.sessions,
      cacheHitRate: board.cacheHitRate,
    },
    sessions: board.bySession.map((s) => ({
      id: s.key,
      label: s.label,
      isCurrent: s.isCurrent,
      lastTs: s.lastTs,
      withCacheRead: total(s),
      withoutCacheRead: totalWithoutCache(s),
      calls: s.calls,
    })),
    projects: board.byProject.slice(0, 8).map((b) => ({ key: b.key, tokens: total(b), calls: b.calls })),
    models: board.byModel.map((b) => ({ key: b.key, tokens: total(b), calls: b.calls })),
    tools: board.tools.slice(0, 8),
  };
}

// ---------------------------------------------------------------- 서버

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/api/state") {
      const body = JSON.stringify(await state());
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        // 브라우저가 옛 값을 보여주면 계기판이 아니다.
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE);
      return;
    }
    res.writeHead(404).end("not found");
  } catch (error) {
    // 한 번의 실패로 서버가 죽으면 띄워둔 의미가 없다.
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: String(error) }));
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`포트 ${PORT} 가 이미 쓰이고 있다.  quota web --port ${PORT + 1}`);
    process.exit(1);
  }
  throw error;
});

// 127.0.0.1 고정 — 위 주석 참고. 바꾸지 말 것.
server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`구독 사용량 계기판  ${url}`);
  console.log(`  구간 ${RANGE} · 5초마다 갱신 · Ctrl+C 로 종료`);
  if (OPEN) openBrowser(url);
});

/** WSL·mac·리눅스에서 브라우저 열기. 실패해도 서버는 계속 돈다 — 주소는 이미 찍었다. */
function openBrowser(url) {
  const candidates = process.env.WSL_DISTRO_NAME
    ? [["wslview", [url]], ["explorer.exe", [url]]]
    : process.platform === "darwin"
      ? [["open", [url]]]
      : [["xdg-open", [url]]];
  for (const [cmd, cmdArgs] of candidates) {
    try {
      const child = spawn(cmd, cmdArgs, { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
      return;
    } catch {
      // 다음 후보로.
    }
  }
}

// ---------------------------------------------------------------- 페이지

const PAGE = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>구독 사용량</title>
<style>
  /* 값을 흩뿌리지 않는다. 색·간격은 전부 여기서만 온다. */
  :root {
    --bg: #0b0d10;
    --panel: #12151a;
    --line: #1f242c;
    --ink: #e6e9ef;
    --ink-dim: #8b93a1;
    --ink-faint: #5a6270;
    --accent: #58b3c9;
    --ok: #63c08a;
    --warn: #e0a458;
    --danger: #d97070;
    --gap: 12px;
    --radius: 8px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: var(--gap);
    background: var(--bg); color: var(--ink);
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    word-break: keep-all;
  }
  .head { display: flex; justify-content: space-between; align-items: baseline;
          gap: var(--gap); flex-wrap: wrap; margin-bottom: var(--gap); }
  .who { color: var(--ink-dim); font-size: 12px; }
  .big { font-size: 20px; font-weight: 600; }
  .panel { background: var(--panel); border: 1px solid var(--line);
           border-radius: var(--radius); padding: var(--gap); margin-bottom: var(--gap); }
  .panel h2 { margin: 0 0 10px; font-size: 12px; font-weight: 600;
              color: var(--ink-dim); letter-spacing: .04em; text-transform: uppercase; }
  .row { display: grid; grid-template-columns: 130px 1fr auto; gap: 10px;
         align-items: center; padding: 5px 0; }
  .bar { height: 8px; background: #1a1f26; border-radius: 999px; overflow: hidden; }
  .bar > i { display: block; height: 100%; border-radius: 999px;
             transition: width .4s ease; background: var(--ok); }
  .bar.warn > i { background: var(--warn); }
  .bar.danger > i { background: var(--danger); }
  .pct { font-variant-numeric: tabular-nums; min-width: 44px; text-align: right; }
  .sub { grid-column: 2 / -1; color: var(--ink-faint); font-size: 11px; padding-bottom: 4px; }
  .sub .hot { color: var(--danger); }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 4px 0; vertical-align: middle; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; color: var(--ink-dim); }
  td.tok { text-align: right; font-variant-numeric: tabular-nums; color: var(--accent); }
  .dot { color: var(--accent); }
  .mini { height: 6px; background: #1a1f26; border-radius: 999px; overflow: hidden; width: 100%; }
  .mini > i { display: block; height: 100%; background: var(--accent);
              border-radius: 999px; transition: width .4s ease; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: var(--gap); }
  @media (max-width: 720px) { .cols { grid-template-columns: 1fr; } .row { grid-template-columns: 100px 1fr auto; } }
  .foot { color: var(--ink-faint); font-size: 11px; text-align: right; }
  .err { color: var(--danger); }
  .empty { color: var(--ink-faint); }
</style>
</head>
<body>
<div class="head">
  <div>
    <div class="big" id="total">—</div>
    <div class="who" id="meta">불러오는 중…</div>
  </div>
  <div class="who" id="who"></div>
</div>

<div class="panel"><h2>한도</h2><div id="windows" class="empty">불러오는 중…</div></div>
<div class="panel"><h2>세션</h2><div id="sessions" class="empty">—</div></div>
<div class="cols">
  <div class="panel"><h2>프로젝트</h2><div id="projects" class="empty">—</div></div>
  <div class="panel"><h2>모델 · 도구</h2><div id="models" class="empty">—</div></div>
</div>
<div class="foot" id="foot"></div>

<script>
const $ = (id) => document.getElementById(id);

function fmt(n) {
  if (!Number.isFinite(n)) return "-";
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}
function dur(ms) {
  if (!(ms > 0)) return "0m";
  const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), r = m % 60;
  if (d > 0) return d + "d " + h + "h";
  if (h > 0) return h + "h " + r + "m";
  return r + "m";
}
function clock(iso) {
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** 리셋 전에 바닥나면 경고. 퍼센트 자체가 아니라 버티는지로 가른다. */
function tone(w) {
  if (!w.burn || !w.burn.exhaustAt) return "";
  const left = new Date(w.burn.exhaustAt).getTime() - Date.now();
  return left < w.burn.remainingMs * 0.5 ? " danger" : " warn";
}

function renderWindows(windows, error) {
  if (error) return '<div class="err">한도 조회 불가 — ' + esc(error) + "</div>";
  if (!windows.length) return '<div class="empty">한도 정보 없음</div>';
  return windows.map((w) => {
    const speed = w.burn ? w.burn.percentPerHour.toFixed(1) + "%/h" : "속도 계산 불가";
    const when = w.burn
      ? (w.burn.exhaustAt
          ? '<span class="hot">' + clock(w.burn.exhaustAt) + " 소진 예상</span>"
          : dur(w.burn.remainingMs) + " 뒤 리셋")
      : "";
    const est = w.estimate
      ? " · 남은 " + w.remainingPercent + "% ≈ " + fmt(w.estimate.withCacheRead) + " ~ " + fmt(w.estimate.withoutCacheRead)
      : " · 보정 없음";
    return '<div class="row"><span>' + esc(w.label) + "</span>" +
      '<span class="bar' + tone(w) + '"><i style="width:' + w.usedPercent + '%"></i></span>' +
      '<span class="pct">' + w.usedPercent + "%</span>" +
      '<span class="sub">' + speed + " · " + when + esc(est) + "</span></div>";
  }).join("");
}

function renderSessions(sessions) {
  if (!sessions.length) return '<div class="empty">기록 없음</div>';
  const max = Math.max(...sessions.map((s) => s.withCacheRead), 1);
  return "<table>" + sessions.map((s) =>
    "<tr><td style='width:14px'>" + (s.isCurrent ? '<span class="dot">●</span>' : "") + "</td>" +
    "<td>" + esc(s.label) + "</td>" +
    "<td style='width:22%'><span class='mini'><i style='width:" + (s.withCacheRead / max * 100) + "%'></i></span></td>" +
    "<td class='tok'>" + fmt(s.withCacheRead) + "</td>" +
    "<td class='num'>" + fmt(s.withoutCacheRead) + "</td>" +
    "<td class='num'>" + s.calls + "회</td>" +
    "<td class='num'>" + (s.lastTs ? clock(s.lastTs) : "-") + "</td></tr>",
  ).join("") + "</table>";
}

function renderList(items, label) {
  if (!items.length) return '<div class="empty">없음</div>';
  const key = label === "calls" ? "calls" : "tokens";
  const max = Math.max(...items.map((i) => i[key] ?? 0), 1);
  return "<table>" + items.map((i) =>
    "<tr><td>" + esc(i.key) + "</td>" +
    "<td style='width:30%'><span class='mini'><i style='width:" + ((i[key] ?? 0) / max * 100) + "%'></i></span></td>" +
    "<td class='tok'>" + fmt(i[key] ?? 0) + (key === "calls" ? "회" : "") + "</td></tr>",
  ).join("") + "</table>";
}

async function tick() {
  try {
    const s = await (await fetch("/api/state", { cache: "no-store" })).json();
    $("total").textContent = fmt(s.totals.withCacheRead) + " 토큰";
    $("meta").textContent =
      fmt(s.totals.withoutCacheRead) + " 제외 · " + s.totals.calls + " 호출 · " +
      s.totals.sessions + " 세션 · 캐시히트 " + (s.totals.cacheHitRate * 100).toFixed(1) + "%";
    $("who").textContent = (s.account ? s.account.email + " · " : "") + s.machine + " · " + s.range;
    $("windows").innerHTML = renderWindows(s.windows, s.error);
    $("windows").className = "";
    $("sessions").innerHTML = renderSessions(s.sessions);
    $("sessions").className = "";
    $("projects").innerHTML = renderList(s.projects, "tokens");
    $("projects").className = "";
    $("models").innerHTML = renderList(s.models, "tokens") + renderList(s.tools, "calls");
    $("models").className = "";
    $("foot").textContent = "갱신 " + clock(s.at);
  } catch (error) {
    // 서버를 끄면 여기로 온다. 마지막 화면은 그대로 두고 꼬리말로만 알린다.
    $("foot").textContent = "연결 끊김 — " + error;
  }
}

tick();
setInterval(tick, 5000);
</script>
</body>
</html>`;
