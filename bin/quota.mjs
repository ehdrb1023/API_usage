#!/usr/bin/env node
/**
 * 전역 진입점 — 어느 디렉토리에서든 `quota` 로 부를 수 있게 한다.
 *
 *   quota                  # 보드 (오늘)
 *   quota 7d               # 보드 (최근 7일)
 *   quota 7d --watch
 *   quota snap             # 한도 스냅샷 기록
 *   quota report           # 보정값·남은 양
 *
 * 설치:  npm link         (레포에서 한 번)
 * 해제:  npm unlink -g api-usage-dashboard
 *
 * ── 왜 그냥 실행하지 않고 다시 spawn 하나 ─────────────────────────────────
 * 대상 스크립트가 `.ts` 를 import 한다. 이 프로젝트에는 빌드 단계가 없고
 * `--import <로더>` 로 런타임에 해석한다 (`.claude/PROJECT.md`). 그 플래그는
 * **프로세스 시작 시점**에만 걸 수 있어서, 이미 뜬 프로세스에서는 못 붙인다.
 * 그래서 여기서 플래그를 달아 자식으로 다시 띄운다.
 *
 * 경로는 전부 **이 파일 기준**으로 잡는다. cwd 기준으로 잡으면 다른 프로젝트에서
 * 부를 때 스크립트를 못 찾는다 — 전역 CLI 로 만드는 이유가 사라진다.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const LOADER = path.join(root, "lib", "clients", "__tests__", "ts-resolve.mjs");
const TARGETS = {
  board: path.join(root, "scripts", "quota_board.mjs"),
  calibration: path.join(root, "scripts", "quota_calibration.mjs"),
  meter: path.join(root, "scripts", "quota_meter.mjs"),
};

const args = process.argv.slice(2);
const first = args[0];

// 첫 낱말로 대상을 고른다. 없으면 보드.
const target =
  first === "snap" || first === "report"
    ? TARGETS.calibration
    : first === "meter"
      ? TARGETS.meter
      : TARGETS.board;
const forwarded = args;

if (first === "--help" || first === "-h") {
  process.stdout.write(
    [
      "quota — Claude Code 구독 사용량",
      "",
      "  quota                오늘 보드",
      "  quota 7d | 30d       구간 보드",
      "  quota 7d --watch     10초마다 갱신",
      "  quota meter          계기판 (작은 창용)",
      "  quota meter --watch  5초마다 갱신",
      "  quota meter --line   한 줄만",
      "  quota meter --list   세션 목록",
      "  quota meter <검색어>  그 세션에 고정 (id앞자리·제목일부)",
      "  quota snap           한도 스냅샷 기록",
      "  quota report         보정값 · 남은 양 추정",
      "",
      `기록: ${process.env.QUOTA_STORE_DIR || "~/.claude-quota"}`,
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const child = spawn(
  process.execPath,
  ["--no-warnings", "--import", LOADER, target, ...forwarded],
  // 로더가 `@/` 를 풀 기준. cwd 로 두면 다른 디렉토리에서 부를 때 깨진다.
  { stdio: "inherit", env: { ...process.env, QUOTA_REPO_ROOT: root } },
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
