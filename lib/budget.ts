/**
 * 예산·잔액·러너웨이 카드 — **기존 AI 집계 위에 얹는 추가 층이다.**
 *
 * 검증된 집계·KST 재구성·단가 역산(lib/services·adapters·kst-days·token-rates)은 건드리지
 * 않는다. 여기서는 그 결과(`getServiceSeries`)에서 오늘/이번 달 비용을 읽어, 예산 대비
 * 소비율과 러너웨이만 계산한다.
 *
 * ── 자동 vs 수기 ──────────────────────────────────────────────────────────
 *   자동  Solapi 실잔액(cash/v1/balance). API 가 실시간 확정값을 준다.
 *   수기  AI 선불 잔액. 벤더가 잔액을 API 로 안 줘서, 충전한 기준값을 env 에 적어 두고
 *         (`*_BALANCE_USD`·`*_BALANCE_AT`) 그 뒤로 쓴 만큼 뺀다. 그래서 "수기(마지막 갱신 …)" 뱃지를 단다.
 *   월예산 `*_MONTHLY_BUDGET` 가 있으면 이번 달 누적 대비 소비율·단계를 매긴다.
 *
 * env 가 없는 항목은 graceful — 카드가 "미설정" 으로 뜨고 크래시하지 않는다.
 *
 * 서버에서만 실행된다 (fs·API 키). 클라이언트 컴포넌트에서 import 금지
 * (lib/data-source.ts 와 같은 규칙 — server-only 패키지 대신 주석으로 둔다).
 */

import { getServiceSeries, getDataSourceMode } from "@/lib/data-source";
import { fetchSolapiBalance, hasSolapiCredentials } from "@/lib/vendors/solapi";
import {
  balanceLevel,
  budgetLevel,
  daysOfRunway,
  maxLevel,
  runwayLevel,
  type KeyLevel,
} from "@/lib/key-levels";
import { kstDay } from "@/lib/kst";
import type { ServiceId } from "@/lib/types";

export type BudgetUnit = "USD" | "KRW";

export type BudgetCard = {
  id: string;
  label: string;
  unit: BudgetUnit;
  /** 오늘(KST) 사용액. 모르면 null. */
  todaySpend: number | null;
  /** 이번 달 누적 사용액. 모르면 null. */
  monthSpend: number | null;
  /** 남은 예산 또는 잔액 어림. 모르면 null. */
  remaining: number | null;
  /** 월 예산. 없으면 null — 소비율을 못 매긴다. */
  monthlyBudget: number | null;
  /** 월 예산 대비 소비율(0~). 예산이 없으면 null. */
  budgetPct: number | null;
  /** 며칠 뒤 바닥. 모르면 null (무한이라 하지 않는다). */
  runwayDays: number | null;
  /** 0~3. 예산·러너웨이 중 나쁜 쪽. */
  level: KeyLevel;
  /** 자동 집계인지 수기 기준값인지. */
  mode: "auto" | "manual";
  /** 수기 기준값을 마지막으로 갱신한 날(YYYY-MM-DD). mode=manual 일 때만. */
  manualAt?: string;
  /** 설정이 없어 비어 있는 카드면 그 사유. */
  unconfigured?: string;
  /** 화면·알림에 띄울 한 줄. */
  note?: string;
};

const num = (v: string | undefined): number | null => {
  const n = Number((v ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
};

const dateEnv = (v: string | undefined): string | null => {
  const t = (v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
};

/**
 * AI 벤더(Claude·GPT) 한 곳의 예산 카드.
 *
 * 비용은 전부 `getServiceSeries` 가 이미 KST 로 접어 역산해 둔 추정치다. 여기서 다시
 * 계산하지 않는다 — 합만 낸다.
 */
async function aiCard(
  id: ServiceId,
  label: string,
  budgetEnv: string,
  balanceEnv: string,
  balanceAtEnv: string,
): Promise<BudgetCard> {
  const monthlyBudget = num(process.env[budgetEnv]);
  const baseline = num(process.env[balanceEnv]);
  const baselineAt = dateEnv(process.env[balanceAtEnv]);

  const base: BudgetCard = {
    id,
    label,
    unit: "USD",
    todaySpend: null,
    monthSpend: null,
    remaining: null,
    monthlyBudget,
    budgetPct: null,
    runwayDays: null,
    level: 0,
    mode: baseline != null ? "manual" : "auto",
    manualAt: baseline != null ? (baselineAt ?? undefined) : undefined,
  };

  let series;
  try {
    series = await getServiceSeries(id);
  } catch (e) {
    return {
      ...base,
      unconfigured: `사용액을 읽지 못했습니다 — ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const today = kstDay();
  const monthPrefix = today.slice(0, 7);
  const points = series.points;

  const todayPoint = points.find((p) => p.date === today);
  const todaySpend = todayPoint ? todayPoint.costUsd : 0;
  const monthSpend = points
    .filter((p) => p.date.startsWith(monthPrefix))
    .reduce((n, p) => n + p.costUsd, 0);

  // 최근 7일 하루 평균 — 러너웨이의 분모.
  const last7 = points.slice(-7);
  const perDay = last7.length ? last7.reduce((n, p) => n + p.costUsd, 0) / last7.length : 0;

  // 잔액 어림: 기준값에서 그 날 이후 쓴 만큼 뺀다 (balance.ts 의 openingUnknown 원칙과 같음).
  let remaining: number | null = null;
  if (baseline != null && baselineAt) {
    const usedSince = points
      .filter((p) => p.date >= baselineAt)
      .reduce((n, p) => n + p.costUsd, 0);
    remaining = Math.round((baseline - usedSince) * 1e4) / 1e4;
  }

  const budgetPct = monthlyBudget != null ? monthSpend / monthlyBudget : null;
  const runwayDays = remaining != null ? daysOfRunway(remaining, perDay) : null;

  const level = maxLevel(
    monthlyBudget != null ? budgetLevel(monthSpend, monthlyBudget) : 0,
    remaining != null ? balanceLevel(remaining, Math.max(5, (baseline ?? 0) * 0.3)) : 0,
    runwayLevel(runwayDays),
  );

  const notes: string[] = [];
  if (baseline != null && baselineAt)
    notes.push(`잔액은 적어 둔 $${baseline}(${baselineAt}) 에서 그 뒤 쓴 만큼 뺀 어림입니다.`);
  else if (baseline != null)
    notes.push(`${balanceAtEnv} 날짜가 없어 잔액을 어림하지 못했습니다.`);
  if (baseline == null && monthlyBudget == null)
    notes.push(`선불 잔액(${balanceEnv})·월 예산(${budgetEnv})을 넣으면 소비율·러너웨이가 뜹니다.`);

  return {
    ...base,
    todaySpend,
    monthSpend,
    remaining,
    budgetPct,
    runwayDays,
    level,
    note: notes.join(" ") || undefined,
  };
}

/** 솔라피 실잔액 카드 — 자동(실시간). */
async function solapiCard(): Promise<BudgetCard> {
  const warn = num(process.env.SOLAPI_BALANCE_WARN_KRW) ?? 10_000;
  const monthlyBudget = num(process.env.SOLAPI_MONTHLY_BUDGET_KRW);

  const base: BudgetCard = {
    id: "solapi",
    label: "Solapi 문자·알림톡",
    unit: "KRW",
    todaySpend: null,
    monthSpend: null,
    remaining: null,
    monthlyBudget,
    budgetPct: null,
    runwayDays: null,
    level: 0,
    mode: "auto",
  };

  if (!hasSolapiCredentials()) {
    return {
      ...base,
      unconfigured:
        "SOLAPI_API_KEY·SOLAPI_API_SECRET 를 넣으면 실잔액이 뜹니다.",
    };
  }

  const result = await fetchSolapiBalance();
  if (!result) return { ...base, unconfigured: "솔라피 키가 없습니다." };
  if (!result.ok) return { ...base, unconfigured: `잔액 조회 실패 — ${result.reason}` };

  const krw = result.krw;
  const level = balanceLevel(krw, warn);
  return {
    ...base,
    remaining: krw,
    level,
    note: `실시간 실잔액입니다 (알림 기준 ${warn.toLocaleString("ko-KR")}원).`,
  };
}

/**
 * 모든 예산 카드. 화면·크론이 함께 쓴다.
 *
 * 목업 모드에서도 돈다 — AI 카드는 목업 비용으로 채워지고(잔액 env 없으면 어림만 비고),
 * 솔라피는 키가 없으면 "미설정" 으로 뜬다. 어느 벤더가 죽어도 나머지는 살린다.
 */
export async function getBudgetCards(): Promise<BudgetCard[]> {
  void getDataSourceMode(); // 모드 분기는 getServiceSeries 안에서 처리된다.

  const specs: Promise<BudgetCard>[] = [
    aiCard("claude", "Claude (Anthropic)", "ANTHROPIC_MONTHLY_BUDGET", "ANTHROPIC_BALANCE_USD", "ANTHROPIC_BALANCE_AT"),
    aiCard("gpt", "GPT (OpenAI)", "OPENAI_MONTHLY_BUDGET", "OPENAI_BALANCE_USD", "OPENAI_BALANCE_AT"),
    solapiCard(),
  ];

  const settled = await Promise.allSettled(specs);
  return settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    const id = ["claude", "gpt", "solapi"][i] ?? "unknown";
    return {
      id,
      label: id,
      unit: "USD" as BudgetUnit,
      todaySpend: null,
      monthSpend: null,
      remaining: null,
      monthlyBudget: null,
      budgetPct: null,
      runwayDays: null,
      level: 0 as KeyLevel,
      mode: "auto" as const,
      unconfigured: `카드 계산 실패 — ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
    };
  });
}
