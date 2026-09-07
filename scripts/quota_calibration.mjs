#!/usr/bin/env node
/**
 * 구독 한도 보정 — 스냅샷 찍고, 쌓인 것으로 "1% 가 몇 토큰인가" 를 본다.
 *
 *   npm run quota:snap      # 지금 퍼센트 + 직전 이후 토큰을 기록
 *   npm run quota:report    # 쌓인 스냅샷으로 보정값·남은 양 추정
 *
 * ── 쓰는 법 ───────────────────────────────────────────────────────────────
 * 하루를 시작할 때 `snap`, 끝낼 때 `snap`. 그 사이 Δ퍼센트와 Δ토큰이 한 쌍이 된다.
 * 며칠 쌓이면 1%당 토큰의 윤곽이 나온다. 중간에 더 자주 찍으면 더 촘촘해진다.
 *
 * ── 재는 동안 지킬 것 ─────────────────────────────────────────────────────
 * claude.ai 웹·데스크톱 앱과 다른 PC 의 Claude Code 는 **퍼센트는 올리는데 이 PC
 * 로그에는 안 남는다.** 그러면 1%당 토큰이 실제보다 작게 나온다. 재는 동안은 이 PC
 * 의 Claude Code 만 쓰는 것이 깨끗하다.
 *
 * 배경과 한계는 `docs/subscription-quota.md`.
 */

import {
  calibrate,
  readSnapshots,
  sameWindow,
  segments,
  machineName,
  storePath,
  takeSnapshot,
  totalWithCacheRead,
  totalWithoutCacheRead,
} from "../lib/quota-calibration.ts";
import { kstDayOf } from "../lib/kst.ts";

const command = process.argv[2] ?? "report";

if (command === "snap") await snap();
else if (command === "report") await report();
else {
  console.error(`알 수 없는 명령: ${command}\n  사용법: quota_calibration.mjs snap|report`);
  process.exit(1);
}

// ---------------------------------------------------------------- snap

async function snap() {
  const s = await takeSnapshot();

  console.log(`계정  ${s.account.email ?? s.account.uuid}  ${dim(s.account.tier ?? "")}`);
  console.log(`PC    ${s.machine}`);
  console.log(`시각  ${s.at}  (KST ${kstDayOf(s.at)})`);
  console.log("");
  for (const w of s.windows) {
    console.log(`  ${w.label.padEnd(16)} ${String(w.usedPercent).padStart(3)}% 사용   리셋 ${w.resetsAt ?? "-"}`);
  }

  if (!s.tokens) {
    console.log("\n첫 스냅샷이다. 토큰 구간은 다음 snap 부터 생긴다.");
  } else {
    console.log(`\n직전 스냅샷(${s.since}) 이후 이 PC 로그:`);
    console.log(`  호출      ${fmt(s.tokens.calls)}`);
    console.log(`  입력      ${fmt(s.tokens.input)}`);
    console.log(`  캐시생성  ${fmt(s.tokens.cacheWrite)}`);
    console.log(`  캐시읽기  ${fmt(s.tokens.cacheRead)}`);
    console.log(`  출력      ${fmt(s.tokens.output)}`);
  }
  console.log(dim(`\n기록: ${storePath(s.account.uuid)}`));
}

// ---------------------------------------------------------------- report

async function report() {
  const { readAccount } = await import("../lib/quota-calibration.ts");
  const account = await readAccount();
  const snapshots = await readSnapshots(account.uuid);

  console.log(`계정  ${account.email ?? account.uuid}  ${dim(account.tier ?? "")}`);
  console.log(`PC    ${machineName()}`);
  console.log(`스냅샷 ${snapshots.length}장  ${dim(storePath(account.uuid))}\n`);

  if (snapshots.length < 2) {
    console.log("스냅샷이 2장은 있어야 구간이 생긴다. `npm run quota:snap` 을 두 번 이상 돌려라.");
    return;
  }

  const latest = snapshots.at(-1);
  const segs = segments(snapshots);
  const calibrations = calibrate(segs);

  // ── 지금 상태 ──────────────────────────────────────────────
  console.log(`■ 지금  ${dim(latest.at)}`);
  for (const w of latest.windows) {
    const bar = "█".repeat(Math.round(w.usedPercent / 5)).padEnd(20, "·");
    console.log(`  ${w.label.padEnd(16)} ${bar} ${String(w.usedPercent).padStart(3)}%  남음 ${100 - w.usedPercent}%`);
  }

  // ── 오늘 얼마나 썼나 ───────────────────────────────────────
  const today = kstDayOf(latest.at);
  const todaySnapshots = snapshots.filter((s) => kstDayOf(s.at) === today);
  if (todaySnapshots.length >= 2) {
    const first = todaySnapshots[0];
    console.log(`\n■ 오늘 (KST ${today}, 스냅샷 ${todaySnapshots.length}장)`);
    for (const w of latest.windows) {
      const before = first.windows.find((x) => x.key === w.key);
      if (!before) continue;
      // 문자열 비교 금지 — resets_at 은 호출마다 흔들린다 (lib 의 sameWindow 주석).
      const reset = !sameWindow(before, w);
      const delta = w.usedPercent - before.usedPercent;
      const note = reset ? dim("  (중간에 리셋됨 — 합이 아니다)") : "";
      console.log(`  ${w.label.padEnd(16)} ${sign(delta)}%p${note}`);
    }
    const tokens = todaySnapshots.slice(1).reduce(
      (acc, s) => {
        if (!s.tokens) return acc;
        acc.calls += s.tokens.calls;
        acc.withCache += totalWithCacheRead(s.tokens);
        acc.withoutCache += totalWithoutCacheRead(s.tokens);
        return acc;
      },
      { calls: 0, withCache: 0, withoutCache: 0 },
    );
    console.log(`  ${"토큰".padEnd(16)} ${fmt(tokens.withCache)} (캐시읽기 포함) / ${fmt(tokens.withoutCache)} (제외)   호출 ${fmt(tokens.calls)}`);
  }

  // ── 보정값 ────────────────────────────────────────────────
  console.log(`\n■ 1%당 토큰 — 구간 ${segs.length}개에서`);
  for (const c of calibrations) {
    console.log(`\n  ${c.windowLabel}  (유효 구간 ${c.used}개)`);
    if (c.used === 0) {
      for (const [reason, n] of Object.entries(c.rejected)) {
        console.log(dim(`    버림: ${reason} × ${n}`));
      }
      continue;
    }
    console.log(`    캐시읽기 포함  ${fmt(c.perPercentWithCacheRead)} /1%`);
    console.log(`    캐시읽기 제외  ${fmt(c.perPercentWithoutCacheRead)} /1%`);
    if (c.spreadWithCacheRead) {
      const [lo, hi] = c.spreadWithCacheRead;
      console.log(dim(`    흔들림  ${fmt(lo)} ~ ${fmt(hi)}`));
    }

    const window = latest.windows.find((w) => w.key === c.windowKey);
    if (window) {
      const remaining = 100 - window.usedPercent;
      console.log(`    → 남은 ${remaining}% ≈ ${fmt(remaining * c.perPercentWithCacheRead)} ~ ${fmt(remaining * c.perPercentWithoutCacheRead)} 토큰`);
    }
    for (const [reason, n] of Object.entries(c.rejected)) {
      console.log(dim(`    버림: ${reason} × ${n}`));
    }
  }

  console.log(dim("\n두 숫자가 벌어지는 것은 오차가 아니다 — 한도가 캐시읽기를 어떻게 세는지"));
  console.log(dim("모르기 때문이고, 알아낼 방법이 없다. 좁은 쪽을 보수적으로 보면 된다."));
}

// ---------------------------------------------------------------- 표시

function fmt(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function sign(n) {
  return n > 0 ? `+${n}` : String(n);
}

function dim(s) {
  return s ? `\x1b[2m${s}\x1b[0m` : "";
}
