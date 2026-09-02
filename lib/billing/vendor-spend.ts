/**
 * 벤더별 한 달 지출 — **"그 외 API" 표의 금액 열.**
 *
 * ── 이 표가 답하려는 질문 ──────────────────────────────────────────────────
 * `components/VendorList.tsx` 는 "어디서 모르게 돈이 새고 있나" 를 본다. 그러려면
 * 벤더마다 **"얼마 나갔나"** 나 **"아직 모른다"** 중 하나가 반드시 찍혀야 한다.
 * 지금까지는 배선만 있고(`spendByVendor`) 아무도 안 넘겨서 전부 "모름" 이었다.
 *
 * ── 금액의 출처가 둘이다 ───────────────────────────────────────────────────
 *   영수증  결제 메일에서 파싱된 **실제 청구액** (`data/billing/receipts.json`)
 *   수기    사용량 API 도 없고 메일 형식도 아직 못 읽는 벤더 (`config/vendor-costs.json`)
 *
 * 레지스트리 25곳 중 22곳이 `usageApi: "none"` 이라, 당분간은 수기 쪽이 더 많다.
 * 두 출처를 **더하지 않고 영수증을 우선한다.** 같은 달에 둘 다 있으면 사람이 이미
 * 적어 둔 값 위에 영수증이 들어온 것이므로, 더하면 두 배가 된다.
 * 무시된 수기 값은 `overridden` 에 담아 돌려준다 — 조용히 버리면 "내가 적은 게
 * 왜 안 보이지" 가 된다.
 *
 * ── 실패 결제는 합계에 넣지 않는다 ─────────────────────────────────────────
 * `kind: "failed"` 는 증빙이 아니라 경보다 (lib/billing/types.ts). 넣으면 나가지도
 * 않은 $500 이 지출로 잡힌다 — 실제로 이 데이터에 그런 건이 있다.
 *
 * 서버 전용 (fs). 클라이언트에서 import 금지.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import type { Receipt } from "@/lib/billing/types";
import type { Vendor } from "@/lib/vendors";

export const VENDOR_COSTS_FILE = path.join("config", "vendor-costs.json");

/** 합계에 넣는 종류. `failed` 와 `unknown` 은 뺀다 — 위 주석 참고. */
const COUNTED = new Set(["subscription", "api_usage", "prepaid_topup", "credit_note"]);

export type VendorSpend = {
  /** "YYYY-MM" */
  month: string;
  /** 벤더 id → USD. 화면이 그대로 쓰는 값. */
  byVendorId: Record<string, number>;
  /** 그중 수기로 적은 것의 id 집합. 화면에서 "수기" 표시를 붙이는 데 쓴다. */
  manualIds: string[];
  /** 영수증이 들어와서 무시된 수기 항목. 사람이 지워야 할 목록이다. */
  overridden: string[];
  /**
   * 영수증에는 있는데 레지스트리에 없는 벤더. **조용히 버리면 안 된다** —
   * 이게 바로 "모르게 새는 비용" 이라, 이 표가 찾으려던 대상이다.
   */
  unregistered: { name: string; amount: number }[];
};

/** 수기 장부. 없으면 빈 값 — 파일 하나 때문에 대시보드가 죽으면 안 된다. */
export async function loadVendorCosts(
  root = process.cwd(),
): Promise<Record<string, Record<string, number>>> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, VENDOR_COSTS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn(`[vendor-spend] ${VENDOR_COSTS_FILE} 를 읽지 못했습니다.`, error);
    }
    return {};
  }
  try {
    const parsed = JSON.parse(text) as { months?: unknown };
    return isMonths(parsed.months) ? parsed.months : {};
  } catch (error) {
    console.warn(`[vendor-spend] ${VENDOR_COSTS_FILE} 의 JSON 문법이 틀렸습니다.`, error);
    return {};
  }
}

function isMonths(v: unknown): v is Record<string, Record<string, number>> {
  if (!v || typeof v !== "object") return false;
  return Object.values(v as Record<string, unknown>).every(
    (m) =>
      !!m &&
      typeof m === "object" &&
      Object.values(m as Record<string, unknown>).every((n) => typeof n === "number"),
  );
}

/**
 * 영수증의 벤더 **이름**을 레지스트리의 **id** 로 잇는다.
 *
 * 영수증에는 "Anthropic", "Deep Infra Inc." 처럼 발신자가 쓴 이름이 그대로 들어
 * 있고, 레지스트리는 "claude", "gemini" 같은 우리 id 를 쓴다. 둘을 이을 열쇠가
 * 없어서, 이름을 눌러 쓴 뒤 라벨·도메인·id 순으로 맞춰 본다.
 */
export function matchVendorId(name: string, vendors: Vendor[]): string | null {
  const n = normalize(name);
  if (!n) return null;

  for (const v of vendors) {
    if (normalize(v.label) === n || normalize(v.id) === n) return v.id;
  }
  // 도메인 앞자리로 한 번 더 — "Anthropic" ↔ anthropic.com 을 잇는 자리다.
  for (const v of vendors) {
    const host = v.domain?.split(".")[0];
    if (host && normalize(host) === n) return v.id;
  }
  return null;
}

/** 법인 접미사와 공백·기호를 걷어낸다. "Deep Infra Inc." → "deepinfra" */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|co|corp|corporation|limited|gmbh)\b\.?/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** 결제일이 이 달에 속하는가. `paidOn` 은 ISO yyyy-mm-dd 다. */
const inMonth = (paidOn: string, month: string) => paidOn.slice(0, 7) === month;

export function buildVendorSpend(
  receipts: Receipt[],
  vendors: Vendor[],
  manualMonths: Record<string, Record<string, number>>,
  month: string,
): VendorSpend {
  const byVendorId: Record<string, number> = {};
  const unregistered = new Map<string, number>();

  for (const r of receipts) {
    if (!r || !COUNTED.has(r.kind)) continue;
    if (!inMonth(r.paidOn ?? "", month)) continue;
    const amount = Number(r.amount);
    if (!Number.isFinite(amount)) continue;

    const id = matchVendorId(r.vendor ?? "", vendors);
    if (id) byVendorId[id] = (byVendorId[id] ?? 0) + amount;
    else unregistered.set(r.vendor, (unregistered.get(r.vendor) ?? 0) + amount);
  }

  // 수기는 영수증이 없는 벤더에만 채운다 (위 주석 — 더하면 두 배).
  const manualIds: string[] = [];
  const overridden: string[] = [];
  for (const [id, amount] of Object.entries(manualMonths[month] ?? {})) {
    if (!Number.isFinite(amount)) continue;
    if (id in byVendorId) {
      overridden.push(id);
      continue;
    }
    byVendorId[id] = amount;
    manualIds.push(id);
  }

  return {
    month,
    byVendorId,
    manualIds,
    overridden,
    unregistered: [...unregistered.entries()]
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount),
  };
}

/** 표 아래 합계 줄. 등록·미등록을 **모두** 더한다 — 나간 돈은 나간 돈이다. */
export function totalSpend(spend: VendorSpend): number {
  const registered = Object.values(spend.byVendorId).reduce((s, n) => s + n, 0);
  const rest = spend.unregistered.reduce((s, u) => s + u.amount, 0);
  return registered + rest;
}
