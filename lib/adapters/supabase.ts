import type { BreakdownItem, DailyPoint, MetricSpec } from "@/lib/types";

/**
 * Supabase Management API → 정규화 모델.
 *
 * ────────────────────────────────────────────────────────────────────────
 * ⚠️ 먼저 알아야 할 것 — 여기 "비용"은 **실제 청구액이 아니라 추정치**입니다.
 * ────────────────────────────────────────────────────────────────────────
 * Claude·Vercel 은 벤더가 금액을 그대로 주지만, Supabase 공개 API 에는 금액 엔드포인트가
 * 없습니다 (2026-08-25 OpenAPI 스펙 115개 경로 확인). 대시보드 Usage & Billing 화면은
 * 공개 API 가 아닌 내부 `platform/` API 를 씁니다.
 *
 * 그래서 비용은 **고정비만** 계산합니다:
 *
 *   ① 조직 플랜 요금   — `/v1/organizations/{slug}` 의 `plan` 이름 + 아래 공시 단가표
 *   ② 프로젝트 애드온  — `/v1/projects/{ref}/billing/addons` 의 `variant.price.amount`
 *                        (← 이건 API 가 준 실제 단가입니다. 하드코딩 아님)
 *
 * 월 정액을 그 달의 일수로 나눠 하루치로 폅니다. 즉 **매일 같은 금액**이 찍히고,
 * 사용량이 늘어도 비용 그래프는 움직이지 않습니다. 그게 정상입니다.
 *
 * 반영되지 **않는** 비용 — 실제 청구서와 차이가 나는 지점:
 *   · 무료 한도를 넘긴 종량 과금 (대역폭·저장용량·MAU·Edge Function 호출 초과분)
 *   · `price.type === "usage"` 인 애드온 (단가를 API 가 주지 않음)
 *   · 크레딧·할인·세금
 * 정확한 청구액은 대시보드에서 확인해야 합니다.
 */

/**
 * ⚠️ **이 표만 하드코딩입니다.** API 는 플랜 "이름"만 주고 금액은 주지 않습니다.
 *    2026-08-25 supabase.com/pricing 공시 기준 · 조직(organization) 단위 월정액.
 *    가격이 바뀌면 여기만 고치면 됩니다.
 *
 *    `enterprise` 는 협상 단가라 공시가가 없습니다 → 0 으로 두고 화면에 배지를 답니다.
 *    (모르는 값을 아무 숫자로 채우면 합계가 조용히 틀어집니다. 0 + 표시가 낫습니다.)
 */
export const SUPABASE_PLAN_MONTHLY_USD: Record<string, number> = {
  free: 0,
  pro: 25,
  team: 599,
  enterprise: 0,
  platform: 0,
};

/** 공시가를 모르는 플랜 — 화면에 "요금 미반영" 배지를 답니다. */
const PLAN_PRICE_UNKNOWN = new Set(["enterprise", "platform"]);

export const SUPABASE_METRICS: MetricSpec[] = [
  { key: "requests", label: "총 요청", format: "count", unit: "회" },
  { key: "restRequests", label: "REST", format: "count", unit: "회" },
  { key: "authRequests", label: "Auth", format: "count", unit: "회" },
  { key: "storageRequests", label: "Storage", format: "count", unit: "회" },
  { key: "realtimeRequests", label: "Realtime", format: "count", unit: "회" },
];

export const SUPABASE_PRIMARY_METRIC = "requests";

const EMPTY_METRICS = () => ({
  requests: 0,
  restRequests: 0,
  authRequests: 0,
  storageRequests: 0,
  realtimeRequests: 0,
});

type Metrics = ReturnType<typeof EMPTY_METRICS>;

// ---------------------------------------------------------------- 입력 타입

type UsageRow = {
  timestamp: string;
  total_auth_requests: number;
  total_realtime_requests: number;
  total_rest_requests: number;
  total_storage_requests: number;
};

type Addon = {
  type: string;
  variant: {
    id: string;
    name: string;
    price?: { type: "fixed" | "usage"; interval: "monthly" | "hourly"; amount: number };
  };
};

type ProjectSnapshot = {
  ref: string;
  name: string;
  organization_slug?: string;
  region?: string;
  status?: string;
  usage: UsageRow[];
  addons: Addon[];
  error?: string;
};

type OrganizationDetail = { id?: string; slug: string; name: string; plan?: string };

type AccountSnapshot = {
  label: string;
  organizations: OrganizationDetail[];
  projects: ProjectSnapshot[];
  error?: string;
};

export type SupabaseRaw = { accounts: AccountSnapshot[] };

// ---------------------------------------------------------------- 비용 계산

function daysInMonth(date: string): number {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * 프로젝트 애드온의 **하루치** 고정비.
 *
 * `interval` 이 두 가지로 옵니다. `monthly` 는 그 달의 일수로 나누고, `hourly` 는
 * 24를 곱합니다. `type: "usage"` 는 단가를 API 가 주지 않으므로 **더하지 않습니다**
 * (0 으로 빠지는 편이, 없는 숫자를 지어내는 것보다 낫습니다).
 */
function dailyAddonCost(addons: Addon[], date: string): number {
  const days = daysInMonth(date);
  let total = 0;

  for (const addon of addons) {
    const price = addon.variant?.price;
    if (!price || price.type !== "fixed") continue;
    total += price.interval === "hourly" ? price.amount * 24 : price.amount / days;
  }

  return total;
}

function planMonthlyUsd(plan: string | undefined): number {
  if (!plan) return 0;
  return SUPABASE_PLAN_MONTHLY_USD[plan] ?? 0;
}

// ---------------------------------------------------------------- 어댑터

/**
 * 날짜 축은 **usage 응답의 timestamp 합집합**으로 만듭니다.
 *
 * Supabase 사용량 API 는 from/to 를 받지 않아 조회 구간을 우리가 정할 수 없습니다
 * (lib/clients/supabase.ts 주석 참고). 그래서 "받은 날짜만" 그립니다 — 다른 두 서비스와
 * 축 길이가 다를 수 있고, 그건 버그가 아닙니다.
 *
 * 고정비는 이 날짜 축 위에 하루씩 균등하게 얹습니다. 사용량 데이터가 하나도 없으면
 * 그릴 날짜 자체가 없으므로 빈 배열이 나옵니다.
 */
export function adaptSupabase(raw: SupabaseRaw): DailyPoint[] {
  const dates = new Set<string>();
  for (const account of raw.accounts ?? []) {
    for (const project of account.projects ?? []) {
      for (const row of project.usage ?? []) dates.add(row.timestamp.slice(0, 10));
    }
  }

  const sortedDates = [...dates].sort();
  if (sortedDates.length === 0) return [];

  return sortedDates.map((date) => buildPoint(raw, date));
}

function buildPoint(raw: SupabaseRaw, date: string): DailyPoint {
  const items: BreakdownItem[] = [];
  /** 계정별 합계 — 같은 하루를 다른 축으로 쪼갠 것이라 items 합계와 반드시 같아야 한다. */
  const byAccount = new Map<string, BreakdownItem>();

  const bump = (label: string, costUsd: number, metrics: Metrics) => {
    let row = byAccount.get(label);
    if (!row) {
      row = { key: label, label, costUsd: 0, metrics: EMPTY_METRICS() };
      byAccount.set(label, row);
    }
    row.costUsd += costUsd;
    for (const k of Object.keys(metrics) as (keyof Metrics)[]) {
      (row.metrics as Metrics)[k] += metrics[k];
    }
  };

  for (const account of raw.accounts ?? []) {
    // 계정 하나가 통째로 실패했을 때. 행을 만들어 두어야 화면에서 "빠졌다" 는 걸 안다.
    if (account.error) {
      items.push({
        key: `account-error:${account.label}`,
        label: account.label,
        costUsd: 0,
        metrics: EMPTY_METRICS(),
        badge: "조회 실패",
        title: account.error,
      });
      bump(account.label, 0, EMPTY_METRICS());
      continue;
    }

    // ① 조직 플랜 요금 — 프로젝트가 아니라 조직에 붙는 비용이라 따로 한 줄로 세운다.
    for (const org of account.organizations ?? []) {
      const monthly = planMonthlyUsd(org.plan);
      const unknown = org.plan ? PLAN_PRICE_UNKNOWN.has(org.plan) : true;
      if (monthly === 0 && !unknown) continue; // Free 플랜은 줄을 만들지 않는다.

      const costUsd = monthly / daysInMonth(date);
      items.push({
        key: `plan:${account.label}:${org.slug}`,
        label: `${org.name} 플랜`,
        costUsd,
        metrics: EMPTY_METRICS(),
        hint: account.label,
        badge: unknown ? "요금 미반영" : (org.plan ?? "").toUpperCase(),
        title: `조직 ${org.slug} · plan=${org.plan ?? "unknown"}`,
      });
      bump(account.label, costUsd, EMPTY_METRICS());
    }

    // ② 프로젝트 — 사용량 + 애드온 고정비.
    for (const project of account.projects ?? []) {
      const row = (project.usage ?? []).find((u) => u.timestamp.slice(0, 10) === date);

      const metrics = EMPTY_METRICS();
      if (row) {
        metrics.authRequests = row.total_auth_requests ?? 0;
        metrics.realtimeRequests = row.total_realtime_requests ?? 0;
        metrics.restRequests = row.total_rest_requests ?? 0;
        metrics.storageRequests = row.total_storage_requests ?? 0;
        metrics.requests =
          metrics.authRequests +
          metrics.realtimeRequests +
          metrics.restRequests +
          metrics.storageRequests;
      }

      const costUsd = dailyAddonCost(project.addons ?? [], date);

      // 사용량도 비용도 없는 프로젝트는 표를 채우기만 하고 정보가 없다 — 다만 조회에
      // 실패한 경우는 그 사실 자체가 정보라 남긴다.
      if (!row && costUsd === 0 && !project.error) continue;

      items.push({
        key: `${account.label}/${project.ref}`,
        label: project.name,
        costUsd,
        metrics,
        hint: account.label,
        badge: badgeFor(project),
        title:
          `${project.ref}` +
          (project.organization_slug ? ` · 조직 ${project.organization_slug}` : "") +
          (project.region ? ` · ${project.region}` : "") +
          (project.error ? `\n${project.error}` : ""),
      });
      bump(account.label, costUsd, metrics);
    }
  }

  items.sort((a, b) => b.costUsd - a.costUsd || b.metrics.requests - a.metrics.requests);

  const metrics = EMPTY_METRICS();
  let costUsd = 0;
  for (const item of items) {
    costUsd += item.costUsd;
    for (const k of Object.keys(metrics) as (keyof Metrics)[]) {
      metrics[k] += item.metrics[k] ?? 0;
    }
  }

  const altItems = [...byAccount.values()].sort((a, b) => b.costUsd - a.costUsd);

  return { date, costUsd, metrics, items, altItems };
}

function badgeFor(project: ProjectSnapshot): string | undefined {
  if (project.error) return "조회 실패";
  if (project.status === "INACTIVE" || project.status === "PAUSING") return "일시정지";
  if (project.status && project.status !== "ACTIVE_HEALTHY") return project.status;
  return undefined;
}
