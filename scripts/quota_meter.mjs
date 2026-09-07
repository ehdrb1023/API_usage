#!/usr/bin/env node
/**
 * 미터기 — 작은 창에 띄워두고 곁눈질하는 계기판.
 *
 *   quota meter            # 한 번 그리고 끝
 *   quota meter --watch    # 5초마다 갱신 (기본 용도)
 *   quota meter --line     # 한 줄만 (statusline·프롬프트용)
 *
 * 보드(`quota`)는 "오늘 무엇을 얼마나 썼나" 를 펼쳐 보는 것이고, 여기는
 * **"지금 이 세션이 얼마나 태우고 있고 언제 막히나"** 만 본다. 폭 40칸이면 된다.
 *
 * ── 작은 창으로 띄우기 ────────────────────────────────────────────────────
 * Windows Terminal:  wt -w new --size 44,14 wsl -e bash -lc "quota meter --watch"
 * 그냥 터미널:        창을 작게 줄이고 `quota meter --watch`
 */

import { scanLocalUsage } from "../lib/local/scan.ts";
import { getQuota } from "../lib/quota.ts";
import { buildBoard, rangeStart, total, totalWithoutCache } from "../lib/quota-board.ts";
import { burnRate, humanDuration, severity } from "../lib/quota-meter.ts";

const C = {
  off: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  ok: "\x1b[38;5;114m",
  warn: "\x1b[38;5;215m",
  danger: "\x1b[38;5;167m",
  accent: "\x1b[38;5;80m",
  label: "\x1b[38;5;245m",
};
const TONE = { ok: C.ok, warn: C.warn, danger: C.danger };

const args = process.argv.slice(2).filter((a) => a !== "meter");
const WATCH = args.includes("--watch");
const LINE = args.includes("--line");
const WIDTH = 40;

const top = () => `${C.dim}┌${"─".repeat(WIDTH)}┐${C.off}`;
const bottom = () => `${C.dim}└${"─".repeat(WIDTH)}┘${C.off}`;
const divider = () => `${C.dim}├${"─".repeat(WIDTH)}┤${C.off}`;

if (LINE) {
  process.stdout.write((await line()) + "\n");
} else {
  await paint();
  if (WATCH) {
    process.on("SIGINT", () => {
      process.stdout.write("\x1b[?25h\n");
      process.exit(0);
    });
    process.stdout.write("\x1b[?25l");
    for (;;) {
      await new Promise((r) => setTimeout(r, 5000));
      await paint();
    }
  }
}

// ---------------------------------------------------------------- 수집

async function read() {
  const since = rangeStart("today");
  const [scan, quota] = await Promise.all([
    scanLocalUsage(since),
    getQuota().catch(() => ({ windows: [], error: "조회 실패" })),
  ]);
  const board = buildBoard(
    scan.rows,
    scan.tools,
    scan.titles,
    process.env.CLAUDE_CODE_SESSION_ID ?? null,
  );
  return { board, quota };
}

// ---------------------------------------------------------------- 한 줄

/** statusline·프롬프트에 박아 넣는 형태. 색은 넣되 상자는 없다. */
async function line() {
  const { board, quota } = await read();
  if (quota.error) return `${C.dim}quota: ${quota.error}${C.off}`;

  const parts = [];
  for (const w of quota.windows) {
    if (w.key === "weekly_scoped") continue; // 한 줄에는 큰 창 둘만.
    const burn = burnRate(w.key, w.usedPercent, w.resetsAt);
    const tone = TONE[severity(burn)];
    const short = w.key === "session" ? "5h" : "주";
    const tail = burn?.exhaustAt
      ? ` ${C.danger}⚠${fmtClock(burn.exhaustAt)}${C.off}`
      : `${C.dim}/${humanDuration(burn?.remainingMs ?? 0)}${C.off}`;
    parts.push(`${C.label}${short}${C.off} ${tone}${w.usedPercent}%${C.off}${tail}`);
  }

  const me = board.bySession.find((s) => s.isCurrent);
  if (me) parts.push(`${C.label}이 세션${C.off} ${C.accent}${fmt(total(me))}${C.off}`);
  return parts.join(`${C.dim} · ${C.off}`);
}

// ---------------------------------------------------------------- 계기판

async function paint() {
  const { board, quota } = await read();
  const out = [];
  if (WATCH) out.push("\x1b[2J\x1b[H");

  const me = board.bySession.find((s) => s.isCurrent);
  out.push(top());

  if (me) {
    out.push(row(`${C.accent}●${C.off} ${C.bold}${cut(me.label, WIDTH - 6)}${C.off}`));
    out.push(
      row(
        `${C.dim}  ${fmt(total(me))} 토큰 · ${fmt(totalWithoutCache(me))} 제외 · ${me.calls}회${C.off}`,
      ),
    );
  } else {
    out.push(row(`${C.dim}이 세션 기록 없음${C.off}`));
  }
  out.push(divider());

  if (quota.error) {
    out.push(row(`${C.danger}한도 조회 불가${C.off}`));
    out.push(row(`${C.dim}${cut(quota.error, WIDTH - 4)}${C.off}`));
  } else {
    for (const w of quota.windows) {
      if (w.key === "weekly_scoped" && w.usedPercent === 0) continue;
      const burn = burnRate(w.key, w.usedPercent, w.resetsAt);
      const level = severity(burn);
      const tone = TONE[level];

      const filled = Math.round(w.usedPercent / 5);
      const bar = tone + "█".repeat(filled) + C.off + C.dim + "·".repeat(20 - filled) + C.off;
      out.push(row(`${pad(cut(w.label, 10), 10)} ${bar} ${tone}${String(w.usedPercent).padStart(3)}%${C.off}`));

      if (burn) {
        const speed = `${burn.percentPerHour.toFixed(1)}%/h`;
        const note = burn.exhaustAt
          ? `${C.danger}${fmtClock(burn.exhaustAt)} 소진 예상${C.off}`
          : `${C.dim}${humanDuration(burn.remainingMs)} 뒤 리셋${C.off}`;
        out.push(row(`${C.dim}${" ".repeat(11)}${speed}${C.off}  ${note}`));
      } else {
        out.push(row(`${C.dim}${" ".repeat(11)}속도 계산 불가${C.off}`));
      }
    }
  }

  out.push(bottom());
  out.push(`${C.dim} ${fmtClock(new Date())}${WATCH ? " · 5초" : ""}${C.off}`);
  process.stdout.write(out.join("\n") + "\n");
}

// ---------------------------------------------------------------- 상자


function row(content) {
  return `${C.dim}│${C.off} ${pad(content, WIDTH - 2)} ${C.dim}│${C.off}`;
}

// ---------------------------------------------------------------- 폭 계산

/** ANSI 는 0칸, 한글은 2칸. 이걸 안 세면 상자 오른쪽 변이 밀린다. */
function width(s) {
  let n = 0;
  for (const ch of s.replace(/\x1b\[[0-9;]*m/g, "")) {
    n += /[ᄀ-ᇿ　-〿가-힯＀-ﾠ]/.test(ch) ? 2 : 1;
  }
  return n;
}

function pad(s, w) {
  const gap = w - width(s);
  return gap > 0 ? s + " ".repeat(gap) : s;
}

function cut(s, w) {
  let out = "";
  let used = 0;
  for (const ch of s) {
    const c = /[ᄀ-ᇿ　-〿가-힯＀-ﾠ]/.test(ch) ? 2 : 1;
    if (used + c > w) break;
    out += ch;
    used += c;
  }
  return out;
}

function fmt(n) {
  if (!Number.isFinite(n)) return "-";
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtClock(d) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
