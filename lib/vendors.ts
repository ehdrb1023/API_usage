/**
 * `config/vendors.json` — **우리가 쓰는 API 벤더 전체 목록.**
 *
 * ── 왜 필요한가 ────────────────────────────────────────────────────────────
 * 대시보드가 실시간으로 보는 건 Claude·GPT 둘뿐이다. 그런데 실제로 돈이 나가는
 * 곳은 훨씬 많고, **안 보이는 게 문제다** — "어디선가 모르게 새는 비용" 을 찾으려면
 * 먼저 "무엇이 있는지" 가 있어야 한다.
 *
 * 이 파일은 그 목록이고, 비용이 잡히는지 여부까지 같이 들고 있다.
 * 결제 메일이 오면 `data/billing/` 에 금액이 쌓이고, 그때 이 목록에 붙는다.
 *
 * ── 배치 기준 ──────────────────────────────────────────────────────────────
 *   primary   : 키가 여럿이고 벤더가 키·모델별 사용량 API를 준다 → 독립 탭
 *   candidate : 키는 여럿인데 쪼개 볼 API가 없다 → 판단 보류
 *   grouped   : 키 하나거나 쪼갤 게 없다 → 한 덩어리로 묶어 월 단위만
 *
 * 서버 전용 (fs 접근). 클라이언트 컴포넌트에서 import 금지.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export const VENDORS_FILE = path.join("config", "vendors.json");

export type VendorTier = "primary" | "candidate" | "grouped";
/** ⚠️ `unknown` 은 "확인 안 함" 이지 "무료" 가 아니다. 섞으면 누수를 놓친다. */
export type PaidState = "yes" | "no" | "unknown";

export type Vendor = {
  id: string;
  label: string;
  /** 파비콘을 받아 오는 출처. `scripts/fetch_vendor_logos.mjs` 가 쓴다. */
  domain?: string;
  tier: VendorTier;
  paid: PaidState;
  /** "admin-api" 면 실시간 조회가 되고, 아니면 영수증으로만 알 수 있다. */
  usageApi: string;
  billing: string;
  keys: string[];
  note?: string;
};

/**
 * 목록을 읽는다. **실패하면 빈 배열이다** — 이 화면은 부가 정보라 파일 하나 때문에
 * 대시보드 전체가 죽으면 안 된다. 대신 원인을 서버 콘솔에 남긴다.
 * (돈 계산을 하는 `lib/billing/sources.ts` 는 반대로 던진다 — 거긴 조용한 0 이 위험하다.)
 */
export async function loadVendors(root = process.cwd()): Promise<Vendor[]> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, VENDORS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn(`[vendors] ${VENDORS_FILE} 를 읽지 못했습니다.`, error);
    }
    return [];
  }

  try {
    const parsed = JSON.parse(text) as { vendors?: unknown };
    if (!Array.isArray(parsed.vendors)) return [];
    return parsed.vendors.filter(isVendor);
  } catch (error) {
    console.warn(`[vendors] ${VENDORS_FILE} 의 JSON 문법이 틀렸습니다.`, error);
    return [];
  }
}

function isVendor(v: unknown): v is Vendor {
  const o = v as Record<string, unknown>;
  return (
    !!o &&
    typeof o.id === "string" &&
    typeof o.label === "string" &&
    (o.tier === "primary" || o.tier === "candidate" || o.tier === "grouped")
  );
}

/**
 * 키 하나 = 표의 한 줄.
 *
 * 벤더로 묶으면 "Supabase 유료" 한 줄로 끝나서 **키가 몇 개인지, 어느 게 위험한지**
 * 안 보인다. Supabase 만 해도 계정 전체 권한 PAT 이 2개다.
 */
export type VendorKeyRow = {
  vendor: Vendor;
  key: string;
};

export function toKeyRows(vendors: Vendor[]): VendorKeyRow[] {
  const rows: VendorKeyRow[] = [];
  for (const v of vendors) {
    // 키를 안 적어 둔 벤더도 한 줄은 나와야 한다 — 없다고 지우면 목록에서 사라진다.
    if (v.keys.length === 0) rows.push({ vendor: v, key: "" });
    else for (const key of v.keys) rows.push({ vendor: v, key });
  }
  return rows;
}

/** 실시간으로 비용이 보이는가. 아니면 영수증을 기다려야 한다. */
export function isTracked(v: Vendor): boolean {
  return v.usageApi === "admin-api";
}

export type VendorSummary = {
  /** 돈이 나갈 수 있는데 **아직 비용이 안 보이는** 벤더. 누수 후보다. */
  untracked: Vendor[];
  /** 유료 여부를 확인조차 안 한 벤더. `untracked` 와 겹칠 수 있다. */
  unknownPaid: Vendor[];
  /** 무료라 아무리 써도 안 새는 벤더. */
  free: Vendor[];
  tracked: Vendor[];
};

export function summarize(vendors: Vendor[]): VendorSummary {
  return {
    tracked: vendors.filter(isTracked),
    // ⚠️ `paid !== "no"` 다. `=== "yes"` 로 좁히면 미확인 벤더가 통째로 빠져
    //    "안 새는 것" 처럼 보인다 — 그게 정확히 찾으려는 대상이다.
    untracked: vendors.filter((v) => v.paid !== "no" && !isTracked(v)),
    unknownPaid: vendors.filter((v) => v.paid === "unknown"),
    free: vendors.filter((v) => v.paid === "no"),
  };
}
