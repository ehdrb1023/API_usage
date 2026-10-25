/**
 * 예산·잔액 스냅샷과 알림 단계 기록 — Vercel Blob.
 *
 * 크론(`/api/cron/collect`)이 하루 한 번 돌며:
 *   1. 그날 카드 전체를 `budget/snapshots/YYYY-MM-DD.json` 으로 남긴다 (일별 추이용).
 *   2. 직전 알림 단계를 `budget/alert-state.json` 에서 읽어, 단계가 "오를 때만" 알린다.
 *
 * BLOB_READ_WRITE_TOKEN 이 없으면 전부 no-op — 로컬·토큰 미설정 환경에서 크래시하지 않는다.
 * 알림 단계 기록이 없으면 감쇠(중복 억제)만 못 하고, 그래도 크론 자체는 돈다.
 *
 * 서버 전용 (Blob 토큰). 클라이언트에서 import 금지.
 */

import { list, put } from "@vercel/blob";

import type { BudgetCard } from "@/lib/budget";
import type { KeyLevel } from "@/lib/key-levels";

const SNAPSHOT_PREFIX = "budget/snapshots/";
const ALERT_STATE_PATH = "budget/alert-state.json";

export function hasBlobToken(): boolean {
  return (process.env.BLOB_READ_WRITE_TOKEN ?? "").trim() !== "";
}

/** 알림 단계 기록: 카드 id → 마지막으로 알린 단계. */
export type AlertState = Record<string, KeyLevel>;

/** 그날 스냅샷을 Blob 에 남긴다. 토큰이 없으면 건너뛴다. */
export async function writeSnapshot(day: string, cards: BudgetCard[]): Promise<boolean> {
  if (!hasBlobToken()) return false;
  try {
    await put(
      `${SNAPSHOT_PREFIX}${day}.json`,
      JSON.stringify({ day, at: new Date().toISOString(), cards }, null, 2),
      {
        access: "public",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: true,
      },
    );
    return true;
  } catch (e) {
    console.warn("[budget-snapshot] 스냅샷 저장 실패", e instanceof Error ? e.message : e);
    return false;
  }
}

/** 직전 알림 단계. 없으면 빈 기록. */
export async function readAlertState(): Promise<AlertState> {
  if (!hasBlobToken()) return {};
  try {
    const { blobs } = await list({ prefix: ALERT_STATE_PATH });
    const found = blobs.find((b) => b.pathname === ALERT_STATE_PATH);
    if (!found) return {};
    const res = await fetch(found.url, { cache: "no-store" });
    if (!res.ok) return {};
    const json = (await res.json()) as AlertState | null;
    return json && typeof json === "object" ? json : {};
  } catch (e) {
    console.warn("[budget-snapshot] 알림 기록 조회 실패", e instanceof Error ? e.message : e);
    return {};
  }
}

/** 알림 단계 기록을 덮어쓴다. */
export async function writeAlertState(state: AlertState): Promise<boolean> {
  if (!hasBlobToken()) return false;
  try {
    await put(ALERT_STATE_PATH, JSON.stringify(state, null, 2), {
      access: "public",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return true;
  } catch (e) {
    console.warn("[budget-snapshot] 알림 기록 저장 실패", e instanceof Error ? e.message : e);
    return false;
  }
}
