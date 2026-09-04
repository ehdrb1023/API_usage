/**
 * 월 예산 — **종량제 사용량 막대의 분모.**
 *
 * ── 왜 사람이 정해야 하는가 ────────────────────────────────────────────────
 * Admin API 는 "얼마 썼나" 만 준다. "얼마까지 쓸 수 있나" 는 주지 않는다 —
 * 종량제라 상한이 없기 때문이다. 그래서 퍼센트를 만들려면 기준이 필요하고,
 * 그 기준은 `config/budgets.json` 에서 온다.
 *
 * 구독 한도(`lib/quota.ts`)와 혼동하지 말 것. 그쪽은 **벤더가 주는 퍼센트**고,
 * 여기는 **우리가 정한 예산 대비 퍼센트**다. 분모의 출처가 다르다.
 *
 * ── 미설정을 0 으로 만들지 않는다 ──────────────────────────────────────────
 * 예산이 없으면 `usedPercent: null` 이다. 0 으로 두면 화면이 "0% 사용 = 여유"
 * 로 그리는데, 실제로는 **기준을 모르는 상태**다. 둘은 다르다.
 *
 * 서버 전용 (fs). 클라이언트에서 import 금지 — 타입만 `import type` 으로.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { isServiceId, SERVICE_IDS, type ServiceId } from "@/lib/types";

export const BUDGETS_FILE = path.join("config", "budgets.json");

export type Budget = {
  service: ServiceId;
  /** 이번 달 누적 비용 (USD). Admin API 실측. */
  spentUsd: number;
  /** 월 예산 (USD). **null 이면 미설정** — 0 이 아니다. */
  budgetUsd: number | null;
  /** 예산 대비 사용률. 예산이 없으면 null. 100 을 넘을 수 있다 (초과). */
  usedPercent: number | null;
};

/**
 * 예산 표. 파일이 없거나 깨져도 빈 값 — 설정 파일 하나 때문에 대시보드가
 * 죽으면 안 된다 (`lib/vendors.ts` 와 같은 판단).
 */
export async function loadBudgets(
  root = process.cwd(),
): Promise<Partial<Record<ServiceId, number>>> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, BUDGETS_FILE), "utf8");
  } catch {
    return {};
  }

  try {
    return parseBudgets(JSON.parse(text));
  } catch (error) {
    console.warn(
      `[budget] ${BUDGETS_FILE} 을 읽지 못했습니다 —`,
      error instanceof Error ? error.message : String(error),
    );
    return {};
  }
}

/**
 * 설정 파싱. **양수만 통과시킨다.**
 *
 * `Number(null)` 은 0 이라 그냥 Number() 에 넘기면 "미설정" 이 "예산 0원" 이
 * 되고, 그러면 사용률이 무한대(또는 0 나누기)가 된다. 0 이나 음수 예산도
 * 의미가 없으므로 같이 뺀다 — 오타를 조용히 통과시키지 않는다.
 */
export function parseBudgets(raw: unknown): Partial<Record<ServiceId, number>> {
  const monthly = (raw as { monthlyUsd?: unknown } | null)?.monthlyUsd;
  if (!monthly || typeof monthly !== "object") return {};

  const out: Partial<Record<ServiceId, number>> = {};
  for (const [key, value] of Object.entries(monthly as Record<string, unknown>)) {
    // 알 수 없는 id 는 버린다. 계정을 늘렸는데 여기 목록을 안 고쳐 조용히
    // 무시되는 일이 없도록 `SERVICE_IDS` 한 곳만 본다.
    if (!isServiceId(key)) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    out[key] = value;
  }
  return out;
}

/**
 * 이번 달 지출 + 예산 → 막대에 그대로 쓰는 값.
 *
 * @param spentByService 서비스별 이번 달 누적 비용 (`computeKpis().mtdCostUsd`).
 */
export function buildBudgets(
  spentByService: Partial<Record<ServiceId, number>>,
  budgets: Partial<Record<ServiceId, number>>,
): Budget[] {
  return SERVICE_IDS
    .filter((s) => s in spentByService)
    .map((service) => {
      const spentUsd = spentByService[service] ?? 0;
      const budgetUsd = budgets[service] ?? null;

      return {
        service,
        spentUsd,
        budgetUsd,
        // 예산이 없으면 퍼센트도 없다. 0 으로 접지 않는다 — 위 주석 참고.
        usedPercent: budgetUsd === null ? null : (spentUsd / budgetUsd) * 100,
      };
    });
}
