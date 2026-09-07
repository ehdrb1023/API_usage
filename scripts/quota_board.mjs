#!/usr/bin/env node
/**
 * 구독 사용량 보드 — codeburn 식 패널을 터미널에 그린다.
 *
 *   npm run quota:board            # 오늘 (KST)
 *   npm run quota:board -- 7d      # 최근 7일
 *   npm run quota:board -- 30d
 *   npm run quota:board -- 7d --watch    # 10초마다 다시 그린다
 *
 * ── 달러가 없는 이유 ──────────────────────────────────────────────────────
 * codeburn 은 토큰을 API 단가로 환산해 달러를 보여준다. 정액권에는 그 금액이
 * 존재하지 않는다 — 우리가 내는 돈이 아니다. 여기 축은 **퍼센트와 토큰**이다.
 * 달러가 필요하면 대시보드 본문(Admin API)이 이미 한다. 섞지 않는다.
 *
 * 배경은 `docs/subscription-quota.md`.
 */

import { buildBoard, rangeStart, total, totalWithoutCache, RANGES } from "../lib/quota-board.ts";
import { scanLocalUsage } from "../lib/local/scan.ts";
import { getQuota } from "../lib/quota.ts";
import { calibrate, machineName, readAccount, readSnapshots, segments } from "../lib/quota-calibration.ts";

const C = {
  off: "\x1b[0m",
  bold: "\x1b[1m",
  blue: "\x1b[38;5;75m",
  green: "\x1b[38;5;114m",
  yellow: "\x1b[38;5;179m",
  magenta: "\x1b[38;5;176m",
  cyan: "\x1b[38;5;80m",
  orange: "\x1b[38;5;215m",
  red: "\x1b[38;5;167m",
};

const CLEAR = "\x1b[2J\x1b[H";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";


const args = process.argv.slice(2);
const WATCH = args.includes("--watch");
const RANGE = args.find((a) => !a.startsWith("--")) ?? "today";

if (!(RANGE in RANGES)) {
  console.error(`알 수 없는 구간: ${RANGE}\n  쓸 수 있는 값: ${Object.keys(RANGES).join(" · ")}`);
  process.exit(1);
}

await draw();
if (WATCH) {
  process.on("SIGINT", () => {
    process.stdout.write(SHOW_CURSOR + "\n");
    process.exit(0);
  });
  process.stdout.write(HIDE_CURSOR);
  for (;;) {
    await sleep(10_000);
    await draw();
  }
}

// ---------------------------------------------------------------- 그리기

async function draw() {
  const since = rangeStart(RANGE);
  const [scan, quota, account] = await Promise.all([
    scanLocalUsage(since),
    getQuota().catch(() => ({ windows: [], error: "조회 실패" })),
    readAccount().catch(() => null),
  ]);

  const board = buildBoard(scan.rows, scan.tools, scan.titles, process.env.CLAUDE_CODE_SESSION_ID ?? null);
  const calibrations = account
    ? calibrate(segments(await readSnapshots(account.uuid)))
    : [];

  const width = Math.min(process.stdout.columns || 100, 120);
  const out = [];

  if (WATCH) out.push(CLEAR);
  out.push(tabs(width));
  out.push(header(board, account, since, width));
  out.push(quotaPanel(quota, calibrations, width));
  out.push(panel("Sessions", C.cyan, sessionRows(board, width - 4), width));

  const [left, right] = [Math.floor((width - 3) / 2), Math.ceil((width - 3) / 2)];
  out.push(sideBySide(
    panel("Daily Activity", C.blue, dailyRows(board, left - 4), left),
    panel("By Project", C.green, bucketRows(board.byProject, left - 4), right),
  ));
  out.push(sideBySide(
    panel("By Model", C.magenta, bucketRows(board.byModel, left - 4), left),
    panel("Core Tools", C.cyan, countRows(board.tools, left - 4), right),
  ));
  out.push(panel("Shell Commands", C.yellow, countRows(board.shell.slice(0, 10), width - 4), width));
  out.push(dim(`  로그 ${scan.opened}/${scan.total} 파일 · ${new Date().toLocaleTimeString("ko-KR")}${WATCH ? " · 10초마다 갱신 (Ctrl+C 종료)" : ""}`));

  process.stdout.write(out.join("\n") + "\n");
}

function tabs(width) {
  const parts = Object.keys(RANGES).map((r) =>
    r === RANGE ? `${C.orange}[ ${r} ]${C.off}` : dim(`  ${r}  `),
  );
  const right = dim("구독 한도 · 달러 아님");
  const left = "  " + parts.join(" ");
  const pad = Math.max(1, width - visible(left).length - visible(right).length);
  return left + " ".repeat(pad) + right;
}

function header(board, account, since, width) {
  const t = board.totals;
  const who = account ? `${account.email ?? account.uuid}` : "계정 미상";
  const lines = [
    `${C.orange}구독 사용량${C.off}  ${dim(RANGE)}   ${dim(who)}   ${dim(machineName())}`,
    `${C.bold}${fmt(total(t))}${C.off} 토큰(캐시읽기 포함)   ${C.bold}${fmt(totalWithoutCache(t))}${C.off} 제외   ` +
      `${C.bold}${fmt(t.calls)}${C.off} 호출   ${C.bold}${board.sessions}${C.off} 세션   ` +
      `${C.bold}${(board.cacheHitRate * 100).toFixed(1)}%${C.off} 캐시히트`,
    dim(`${fmt(t.input)} in   ${fmt(t.output)} out   ${fmt(t.cacheRead)} cached   ${fmt(t.cacheWrite)} written   ·  ${since.slice(0, 16)}Z 이후`),
  ];
  return box(lines, width, C.orange);
}

function quotaPanel(quota, calibrations, width) {
  const lines = [];
  if (!quota.windows?.length) {
    lines.push(dim(`한도 조회 불가 — ${quota.error ?? "자격증명 없음"}`));
    return box(lines, width, C.red);
  }

  for (const w of quota.windows) {
    const filled = Math.round(w.usedPercent / 2.5);
    const bar = C.orange + "█".repeat(filled) + C.off + dim("·".repeat(40 - filled));
    const calibration = calibrations.find((c) => c.windowKey === w.key);
    let estimate = dim("  보정 없음 — quota:snap 을 더 찍어라");
    if (calibration?.perPercentWithCacheRead) {
      const left = 100 - w.usedPercent;
      estimate = `  남은 ${left}% ≈ ${C.bold}${fmt(left * calibration.perPercentWithCacheRead)}${C.off}${dim(` ~ ${fmt(left * calibration.perPercentWithoutCacheRead)} 토큰`)}`;
    }
    lines.push(`${w.label.padEnd(14)} ${bar} ${String(w.usedPercent).padStart(3)}%${estimate}`);
  }
  return box(lines, width, C.red);
}

// ---------------------------------------------------------------- 패널 내용

/**
 * 한 줄 = 스파크라인 + 이름 + 숫자들. 폭은 **표시폭**으로 잡는다 —
 * 한글은 두 칸을 먹고 ANSI 코드는 0 칸이라 `padEnd`·`slice` 로는 못 맞춘다.
 */
function row(spark, name, cols, nameWidth) {
  const numbers = cols.map(([text, color]) => lead(text, 8, color)).join("");
  return `${spark}  ${padVisible(cut(name, nameWidth), nameWidth)}${numbers}`;
}

function sparkline(value, max, color) {
  const filled = Math.max(0, Math.min(10, Math.round((value / (max || 1)) * 10)));
  return color + "▇".repeat(filled) + C.off + dim("▁".repeat(10 - filled));
}

function headerRow(name, labels, nameWidth) {
  return dim(
    " ".repeat(12) +
      padVisible(name, nameWidth) +
      labels.map((l) => padStartVisible(l, 8)).join(""),
  );
}

function dailyRows(board, width) {
  const max = Math.max(1, ...board.daily.map(total));
  const nameWidth = Math.max(11, width - 12 - 16);
  return [
    headerRow("날짜", ["토큰", "호출"], nameWidth),
    ...board.daily.slice(0, 14).map((b) =>
      row(sparkline(total(b), max, C.blue), b.key, [
        [fmt(total(b)), C.yellow],
        [String(b.calls), null],
      ], nameWidth),
    ),
  ];
}

/**
 * 세션별. 맨 위가 **가장 최근에 응답이 있었던 세션** = 지금 돌고 있는 세션이다.
 * 그래서 ● 를 붙인다 — "지금 이 세션 얼마 썼나" 가 이 패널을 보는 이유다.
 */
function sessionRows(board, width) {
  if (!board.bySession.length) return [dim("구간 안에 세션 없음")];
  const max = Math.max(1, ...board.bySession.map(total));
  // 스파크라인 10 + " ● " 3 + 숫자 8·8·8 + 시각 7 = 44. 나머지가 이름 자리다.
  const PREFIX = 13;
  const nameWidth = Math.max(12, width - PREFIX - 31);
  return [
    dim(
      " ".repeat(PREFIX) +
        padVisible("세션", nameWidth) +
        ["토큰", "제외", "호출"].map((l) => padStartVisible(l, 8)).join("") +
        padStartVisible("마지막", 7),
    ),
    ...board.bySession.slice(0, 10).map((b) => {
      // 맨 위 = 가장 최근에 응답이 있었던 세션 = 지금 돌고 있는 것.
      const mark = b.isCurrent ? `${C.orange}●${C.off}` : " ";
      return (
        sparkline(total(b), max, C.cyan) +
        ` ${mark} ` +
        padVisible(cut(b.label, nameWidth), nameWidth) +
        lead(fmt(total(b)), 8, C.yellow) +
        lead(fmt(totalWithoutCache(b)), 8, null) +
        lead(String(b.calls), 8, null) +
        dim(padStartVisible(hhmm(b.lastTs), 7))
      );
    }),
  ];
}

/** 로컬 시각 HH:MM. 초까지는 필요 없고 폭만 들쭉날쭉해진다. */
function hhmm(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function bucketRows(buckets, width) {
  const max = Math.max(1, ...buckets.map(total));
  const nameWidth = Math.max(8, width - 12 - 16);
  return [
    headerRow("이름", ["토큰", "호출"], nameWidth),
    ...buckets.slice(0, 12).map((b) =>
      row(sparkline(total(b), max, C.green), b.key, [
        [fmt(total(b)), C.yellow],
        [String(b.calls), null],
      ], nameWidth),
    ),
  ];
}

function countRows(items, width) {
  if (!items.length) return [dim("없음")];
  const max = Math.max(1, ...items.map((i) => i.calls));
  const nameWidth = Math.max(8, width - 12 - 8);
  return [
    headerRow("이름", ["호출"], nameWidth),
    ...items.slice(0, 12).map((i) =>
      row(sparkline(i.calls, max, C.cyan), i.key, [[String(i.calls), null]], nameWidth),
    ),
  ];
}

// ---------------------------------------------------------------- 상자

function box(lines, width, color) {
  const inner = width - 2;
  const top = `${color}┌${"─".repeat(inner)}┐${C.off}`;
  const bottom = `${color}└${"─".repeat(inner)}┘${C.off}`;
  const body = lines.map((l) => `${color}│${C.off} ${pad(l, inner - 2)} ${color}│${C.off}`);
  return [top, ...body, bottom].join("\n");
}

function panel(title, color, lines, width) {
  return box([`${color}${C.bold}${title}${C.off}`, ...lines], width, color);
}

/** 두 상자를 나란히. 줄 수가 다르면 짧은 쪽을 공백으로 채운다. */
function sideBySide(a, b) {
  const left = a.split("\n");
  const right = b.split("\n");
  const height = Math.max(left.length, right.length);
  const leftWidth = Math.max(...left.map((l) => visible(l).length));
  const out = [];
  for (let i = 0; i < height; i += 1) {
    const l = left[i] ?? "";
    out.push(pad(l, leftWidth) + " " + (right[i] ?? ""));
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- 표시

/**
 * ANSI 이스케이프를 뺀 길이. 한글은 터미널에서 두 칸을 먹으므로 그만큼 더 센다 —
 * 안 그러면 한글이 들어간 줄마다 상자 오른쪽 변이 밀린다.
 */
function visible(s) {
  const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
  let n = 0;
  for (const ch of plain) {
    n += /[\u1100-\u11ff\u3000-\u303f\uac00-\ud7af\uff00-\uffa0]/.test(ch) ? 2 : 1;
  }
  return { length: n, plain };
}

function pad(s, width) {
  const gap = width - visible(s).length;
  return gap > 0 ? s + " ".repeat(gap) : s;
}

/** 표시폭 기준 오른쪽 채우기. */
function padVisible(s, width) {
  const gap = width - visible(s).length;
  return gap > 0 ? s + " ".repeat(gap) : s;
}

/** 표시폭 기준 왼쪽 채우기(숫자 오른쪽 정렬). */
function padStartVisible(s, width) {
  const gap = width - visible(s).length;
  return gap > 0 ? " ".repeat(gap) + s : s;
}

/** 색을 입힌 오른쪽 정렬 숫자. 색 코드는 폭에 안 들어간다. */
function lead(text, width, color) {
  const padded = padStartVisible(text, width);
  return color ? color + padded + C.off : padded;
}

/** 표시폭 기준 자르기. ANSI 가 섞이지 않은 순수 라벨에만 쓴다. */
function cut(s, width) {
  let out = "";
  let used = 0;
  for (const ch of s) {
    const w = /[\u1100-\u11ff\u3000-\u303f\uac00-\ud7af\uff00-\uffa0]/.test(ch) ? 2 : 1;
    if (used + w > width) break;
    out += ch;
    used += w;
  }
  return out;
}

function fmt(n) {
  if (!Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function dim(s) {
  return `\x1b[2m${s}\x1b[0m`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
